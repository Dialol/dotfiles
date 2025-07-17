/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ 8465:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {


module.exports = __webpack_require__(809);


/***/ }),

/***/ 809:
/***/ ((module) => {



var AsyncLock = function (opts) {
	opts = opts || {};

	this.Promise = opts.Promise || Promise;

	// format: {key : [fn, fn]}
	// queues[key] = null indicates no job running for key
	this.queues = Object.create(null);

	// lock is reentrant for same domain
	this.domainReentrant = opts.domainReentrant || false;
	if (this.domainReentrant) {
		if (typeof process === 'undefined' || typeof process.domain === 'undefined') {
			throw new Error(
				'Domain-reentrant locks require `process.domain` to exist. Please flip `opts.domainReentrant = false`, ' +
				'use a NodeJS version that still implements Domain, or install a browser polyfill.');
		}
		// domain of current running func {key : fn}
		this.domains = Object.create(null);
	}

	this.timeout = opts.timeout || AsyncLock.DEFAULT_TIMEOUT;
	this.maxOccupationTime = opts.maxOccupationTime || AsyncLock.DEFAULT_MAX_OCCUPATION_TIME;
	this.maxExecutionTime = opts.maxExecutionTime || AsyncLock.DEFAULT_MAX_EXECUTION_TIME;
	if (opts.maxPending === Infinity || (Number.isInteger(opts.maxPending) && opts.maxPending >= 0)) {
		this.maxPending = opts.maxPending;
	} else {
		this.maxPending = AsyncLock.DEFAULT_MAX_PENDING;
	}
};

AsyncLock.DEFAULT_TIMEOUT = 0; //Never
AsyncLock.DEFAULT_MAX_OCCUPATION_TIME = 0; //Never
AsyncLock.DEFAULT_MAX_EXECUTION_TIME = 0; //Never
AsyncLock.DEFAULT_MAX_PENDING = 1000;

/**
 * Acquire Locks
 *
 * @param {String|Array} key 	resource key or keys to lock
 * @param {function} fn 	async function
 * @param {function} cb 	callback function, otherwise will return a promise
 * @param {Object} opts 	options
 */
AsyncLock.prototype.acquire = function (key, fn, cb, opts) {
	if (Array.isArray(key)) {
		return this._acquireBatch(key, fn, cb, opts);
	}

	if (typeof (fn) !== 'function') {
		throw new Error('You must pass a function to execute');
	}

	// faux-deferred promise using new Promise() (as Promise.defer is deprecated)
	var deferredResolve = null;
	var deferredReject = null;
	var deferred = null;

	if (typeof (cb) !== 'function') {
		opts = cb;
		cb = null;

		// will return a promise
		deferred = new this.Promise(function(resolve, reject) {
			deferredResolve = resolve;
			deferredReject = reject;
		});
	}

	opts = opts || {};

	var resolved = false;
	var timer = null;
	var occupationTimer = null;
	var executionTimer = null;
	var self = this;

	var done = function (locked, err, ret) {

		if (occupationTimer) {
			clearTimeout(occupationTimer);
			occupationTimer = null;
		}

		if (executionTimer) {
			clearTimeout(executionTimer);
			executionTimer = null;
		}

		if (locked) {
			if (!!self.queues[key] && self.queues[key].length === 0) {
				delete self.queues[key];
			}
			if (self.domainReentrant) {
				delete self.domains[key];
			}
		}

		if (!resolved) {
			if (!deferred) {
				if (typeof (cb) === 'function') {
					cb(err, ret);
				}
			}
			else {
				//promise mode
				if (err) {
					deferredReject(err);
				}
				else {
					deferredResolve(ret);
				}
			}
			resolved = true;
		}

		if (locked) {
			//run next func
			if (!!self.queues[key] && self.queues[key].length > 0) {
				self.queues[key].shift()();
			}
		}
	};

	var exec = function (locked) {
		if (resolved) { // may due to timed out
			return done(locked);
		}

		if (timer) {
			clearTimeout(timer);
			timer = null;
		}

		if (self.domainReentrant && locked) {
			self.domains[key] = process.domain;
		}

		var maxExecutionTime = opts.maxExecutionTime || self.maxExecutionTime;
		if (maxExecutionTime) {
			executionTimer = setTimeout(function () {
				if (!!self.queues[key]) {
					done(locked, new Error('Maximum execution time is exceeded ' + key));
				}
			}, maxExecutionTime);
		}

		// Callback mode
		if (fn.length === 1) {
			var called = false;
			try {
				fn(function (err, ret) {
					if (!called) {
						called = true;
						done(locked, err, ret);
					}
				});
			} catch (err) {
				// catching error thrown in user function fn
				if (!called) {
					called = true;
					done(locked, err);
				}
			}
		}
		else {
			// Promise mode
			self._promiseTry(function () {
				return fn();
			})
			.then(function(ret){
				done(locked, undefined, ret);
			}, function(error){
				done(locked, error);
			});
		}
	};

	if (self.domainReentrant && !!process.domain) {
		exec = process.domain.bind(exec);
	}

	var maxPending = opts.maxPending || self.maxPending;

	if (!self.queues[key]) {
		self.queues[key] = [];
		exec(true);
	}
	else if (self.domainReentrant && !!process.domain && process.domain === self.domains[key]) {
		// If code is in the same domain of current running task, run it directly
		// Since lock is re-enterable
		exec(false);
	}
	else if (self.queues[key].length >= maxPending) {
		done(false, new Error('Too many pending tasks in queue ' + key));
	}
	else {
		var taskFn = function () {
			exec(true);
		};
		if (opts.skipQueue) {
			self.queues[key].unshift(taskFn);
		} else {
			self.queues[key].push(taskFn);
		}

		var timeout = opts.timeout || self.timeout;
		if (timeout) {
			timer = setTimeout(function () {
				timer = null;
				done(false, new Error('async-lock timed out in queue ' + key));
			}, timeout);
		}
	}

	var maxOccupationTime = opts.maxOccupationTime || self.maxOccupationTime;
		if (maxOccupationTime) {
			occupationTimer = setTimeout(function () {
				if (!!self.queues[key]) {
					done(false, new Error('Maximum occupation time is exceeded in queue ' + key));
				}
			}, maxOccupationTime);
		}

	if (deferred) {
		return deferred;
	}
};

/*
 * Below is how this function works:
 *
 * Equivalent code:
 * self.acquire(key1, function(cb){
 *     self.acquire(key2, function(cb){
 *         self.acquire(key3, fn, cb);
 *     }, cb);
 * }, cb);
 *
 * Equivalent code:
 * var fn3 = getFn(key3, fn);
 * var fn2 = getFn(key2, fn3);
 * var fn1 = getFn(key1, fn2);
 * fn1(cb);
 */
AsyncLock.prototype._acquireBatch = function (keys, fn, cb, opts) {
	if (typeof (cb) !== 'function') {
		opts = cb;
		cb = null;
	}

	var self = this;
	var getFn = function (key, fn) {
		return function (cb) {
			self.acquire(key, fn, cb, opts);
		};
	};

	var fnx = keys.reduceRight(function (prev, key) {
		return getFn(key, prev);
	}, fn);

	if (typeof (cb) === 'function') {
		fnx(cb);
	}
	else {
		return new this.Promise(function (resolve, reject) {
			// check for promise mode in case keys is empty array
			if (fnx.length === 1) {
				fnx(function (err, ret) {
					if (err) {
						reject(err);
					}
					else {
						resolve(ret);
					}
				});
			} else {
				resolve(fnx());
			}
		});
	}
};

/*
 *	Whether there is any running or pending asyncFunc
 *
 *	@param {String} key
 */
AsyncLock.prototype.isBusy = function (key) {
	if (!key) {
		return Object.keys(this.queues).length > 0;
	}
	else {
		return !!this.queues[key];
	}
};

/**
 * Promise.try() implementation to become independent of Q-specific methods
 */
AsyncLock.prototype._promiseTry = function(fn) {
	try {
		return this.Promise.resolve(fn());
	} catch (e) {
		return this.Promise.reject(e);
	}
};

module.exports = AsyncLock;


/***/ }),

/***/ 5287:
/***/ ((__unused_webpack_module, exports) => {

var __webpack_unused_export__;
/**
 * @license React
 * react.production.min.js
 *
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var l=Symbol.for("react.element"),n=Symbol.for("react.portal"),p=Symbol.for("react.fragment"),q=Symbol.for("react.strict_mode"),r=Symbol.for("react.profiler"),t=Symbol.for("react.provider"),u=Symbol.for("react.context"),v=Symbol.for("react.forward_ref"),w=Symbol.for("react.suspense"),x=Symbol.for("react.memo"),y=Symbol.for("react.lazy"),z=Symbol.iterator;function A(a){if(null===a||"object"!==typeof a)return null;a=z&&a[z]||a["@@iterator"];return"function"===typeof a?a:null}
var B={isMounted:function(){return!1},enqueueForceUpdate:function(){},enqueueReplaceState:function(){},enqueueSetState:function(){}},C=Object.assign,D={};function E(a,b,e){this.props=a;this.context=b;this.refs=D;this.updater=e||B}E.prototype.isReactComponent={};
E.prototype.setState=function(a,b){if("object"!==typeof a&&"function"!==typeof a&&null!=a)throw Error("setState(...): takes an object of state variables to update or a function which returns an object of state variables.");this.updater.enqueueSetState(this,a,b,"setState")};E.prototype.forceUpdate=function(a){this.updater.enqueueForceUpdate(this,a,"forceUpdate")};function F(){}F.prototype=E.prototype;function G(a,b,e){this.props=a;this.context=b;this.refs=D;this.updater=e||B}var H=G.prototype=new F;
H.constructor=G;C(H,E.prototype);H.isPureReactComponent=!0;var I=Array.isArray,J=Object.prototype.hasOwnProperty,K={current:null},L={key:!0,ref:!0,__self:!0,__source:!0};
function M(a,b,e){var d,c={},k=null,h=null;if(null!=b)for(d in void 0!==b.ref&&(h=b.ref),void 0!==b.key&&(k=""+b.key),b)J.call(b,d)&&!L.hasOwnProperty(d)&&(c[d]=b[d]);var g=arguments.length-2;if(1===g)c.children=e;else if(1<g){for(var f=Array(g),m=0;m<g;m++)f[m]=arguments[m+2];c.children=f}if(a&&a.defaultProps)for(d in g=a.defaultProps,g)void 0===c[d]&&(c[d]=g[d]);return{$$typeof:l,type:a,key:k,ref:h,props:c,_owner:K.current}}
function N(a,b){return{$$typeof:l,type:a.type,key:b,ref:a.ref,props:a.props,_owner:a._owner}}function O(a){return"object"===typeof a&&null!==a&&a.$$typeof===l}function escape(a){var b={"=":"=0",":":"=2"};return"$"+a.replace(/[=:]/g,function(a){return b[a]})}var P=/\/+/g;function Q(a,b){return"object"===typeof a&&null!==a&&null!=a.key?escape(""+a.key):b.toString(36)}
function R(a,b,e,d,c){var k=typeof a;if("undefined"===k||"boolean"===k)a=null;var h=!1;if(null===a)h=!0;else switch(k){case "string":case "number":h=!0;break;case "object":switch(a.$$typeof){case l:case n:h=!0}}if(h)return h=a,c=c(h),a=""===d?"."+Q(h,0):d,I(c)?(e="",null!=a&&(e=a.replace(P,"$&/")+"/"),R(c,b,e,"",function(a){return a})):null!=c&&(O(c)&&(c=N(c,e+(!c.key||h&&h.key===c.key?"":(""+c.key).replace(P,"$&/")+"/")+a)),b.push(c)),1;h=0;d=""===d?".":d+":";if(I(a))for(var g=0;g<a.length;g++){k=
a[g];var f=d+Q(k,g);h+=R(k,b,e,f,c)}else if(f=A(a),"function"===typeof f)for(a=f.call(a),g=0;!(k=a.next()).done;)k=k.value,f=d+Q(k,g++),h+=R(k,b,e,f,c);else if("object"===k)throw b=String(a),Error("Objects are not valid as a React child (found: "+("[object Object]"===b?"object with keys {"+Object.keys(a).join(", ")+"}":b)+"). If you meant to render a collection of children, use an array instead.");return h}
function S(a,b,e){if(null==a)return a;var d=[],c=0;R(a,d,"","",function(a){return b.call(e,a,c++)});return d}function T(a){if(-1===a._status){var b=a._result;b=b();b.then(function(b){if(0===a._status||-1===a._status)a._status=1,a._result=b},function(b){if(0===a._status||-1===a._status)a._status=2,a._result=b});-1===a._status&&(a._status=0,a._result=b)}if(1===a._status)return a._result.default;throw a._result;}
var U={current:null},V={transition:null},W={ReactCurrentDispatcher:U,ReactCurrentBatchConfig:V,ReactCurrentOwner:K};__webpack_unused_export__={map:S,forEach:function(a,b,e){S(a,function(){b.apply(this,arguments)},e)},count:function(a){var b=0;S(a,function(){b++});return b},toArray:function(a){return S(a,function(a){return a})||[]},only:function(a){if(!O(a))throw Error("React.Children.only expected to receive a single React element child.");return a}};__webpack_unused_export__=E;__webpack_unused_export__=p;
__webpack_unused_export__=r;__webpack_unused_export__=G;__webpack_unused_export__=q;__webpack_unused_export__=w;__webpack_unused_export__=W;
__webpack_unused_export__=function(a,b,e){if(null===a||void 0===a)throw Error("React.cloneElement(...): The argument must be a React element, but you passed "+a+".");var d=C({},a.props),c=a.key,k=a.ref,h=a._owner;if(null!=b){void 0!==b.ref&&(k=b.ref,h=K.current);void 0!==b.key&&(c=""+b.key);if(a.type&&a.type.defaultProps)var g=a.type.defaultProps;for(f in b)J.call(b,f)&&!L.hasOwnProperty(f)&&(d[f]=void 0===b[f]&&void 0!==g?g[f]:b[f])}var f=arguments.length-2;if(1===f)d.children=e;else if(1<f){g=Array(f);
for(var m=0;m<f;m++)g[m]=arguments[m+2];d.children=g}return{$$typeof:l,type:a.type,key:c,ref:k,props:d,_owner:h}};__webpack_unused_export__=function(a){a={$$typeof:u,_currentValue:a,_currentValue2:a,_threadCount:0,Provider:null,Consumer:null,_defaultValue:null,_globalName:null};a.Provider={$$typeof:t,_context:a};return a.Consumer=a};__webpack_unused_export__=M;__webpack_unused_export__=function(a){var b=M.bind(null,a);b.type=a;return b};__webpack_unused_export__=function(){return{current:null}};
__webpack_unused_export__=function(a){return{$$typeof:v,render:a}};__webpack_unused_export__=O;__webpack_unused_export__=function(a){return{$$typeof:y,_payload:{_status:-1,_result:a},_init:T}};__webpack_unused_export__=function(a,b){return{$$typeof:x,type:a,compare:void 0===b?null:b}};__webpack_unused_export__=function(a){var b=V.transition;V.transition={};try{a()}finally{V.transition=b}};__webpack_unused_export__=function(){throw Error("act(...) is not supported in production builds of React.");};
__webpack_unused_export__=function(a,b){return U.current.useCallback(a,b)};__webpack_unused_export__=function(a){return U.current.useContext(a)};__webpack_unused_export__=function(){};__webpack_unused_export__=function(a){return U.current.useDeferredValue(a)};__webpack_unused_export__=function(a,b){return U.current.useEffect(a,b)};__webpack_unused_export__=function(){return U.current.useId()};__webpack_unused_export__=function(a,b,e){return U.current.useImperativeHandle(a,b,e)};
__webpack_unused_export__=function(a,b){return U.current.useInsertionEffect(a,b)};__webpack_unused_export__=function(a,b){return U.current.useLayoutEffect(a,b)};__webpack_unused_export__=function(a,b){return U.current.useMemo(a,b)};__webpack_unused_export__=function(a,b,e){return U.current.useReducer(a,b,e)};__webpack_unused_export__=function(a){return U.current.useRef(a)};__webpack_unused_export__=function(a){return U.current.useState(a)};__webpack_unused_export__=function(a,b,e){return U.current.useSyncExternalStore(a,b,e)};
__webpack_unused_export__=function(){return U.current.useTransition()};__webpack_unused_export__="18.2.0";


/***/ }),

/***/ 6540:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



if (true) {
  /* unused reexport */ __webpack_require__(5287);
} else {}


/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/compat get default export */
/******/ 	(() => {
/******/ 		// getDefaultExport function for compatibility with non-harmony modules
/******/ 		__webpack_require__.n = (module) => {
/******/ 			var getter = module && module.__esModule ?
/******/ 				() => (module['default']) :
/******/ 				() => (module);
/******/ 			__webpack_require__.d(getter, { a: getter });
/******/ 			return getter;
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/define property getters */
/******/ 	(() => {
/******/ 		// define getter functions for harmony exports
/******/ 		__webpack_require__.d = (exports, definition) => {
/******/ 			for(var key in definition) {
/******/ 				if(__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
/******/ 					Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 				}
/******/ 			}
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	(() => {
/******/ 		__webpack_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
/******/ 	})();
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};

// EXTERNAL MODULE: ./node_modules/async-lock/index.js
var async_lock = __webpack_require__(8465);
var async_lock_default = /*#__PURE__*/__webpack_require__.n(async_lock);
;// CONCATENATED MODULE: ./app/js/queries.ts
const STORAGE_SYNC_PERSIST_DEFAULTS = {
    paused: false,
    theme: "system",
};
async function queries_getStorageSyncPersist() {
    const data = await chrome.storage.sync.get("persist:settings");
    return Object.assign({}, STORAGE_SYNC_PERSIST_DEFAULTS, data["persist:settings"]);
}
const STORAGE_LOCAL_PERSIST_DEFAULTS = {
    installDate: Date.now(),
    savedTabs: [],
    tabTimes: {},
    totalTabsRemoved: 0,
    totalTabsUnwrangled: 0,
    totalTabsWrangled: 0,
};
async function queries_getStorageLocalPersist() {
    const data = await chrome.storage.local.get("persist:localStorage");
    return Object.assign({}, STORAGE_LOCAL_PERSIST_DEFAULTS, data["persist:localStorage"]);
}

;// CONCATENATED MODULE: ./app/js/actions/localStorageActions.ts



function removeAllSavedTabs() {
    return storage_ASYNC_LOCK.acquire("persist:localStorage", async () => {
        const localStorage = await queries_getStorageLocalPersist();
        await chrome.storage.local.set({
            "persist:localStorage": Object.assign(Object.assign({}, localStorage), { savedTabs: [] }),
        });
    });
}
function removeSavedTabs(tabs) {
    return ASYNC_LOCK.acquire("persist:localStorage", async () => {
        const localStorage = await getStorageLocalPersist();
        const removedTabsSet = new Set(tabs.map(serializeTab));
        // * Remove any tabs that are not in the action's array of tabs.
        const nextSavedTabs = localStorage.savedTabs.filter((tab) => !removedTabsSet.has(serializeTab(tab)));
        await chrome.storage.local.set({
            "persist:localStorage": Object.assign(Object.assign({}, localStorage), { savedTabs: nextSavedTabs }),
        });
    });
}
function setSavedTabs(savedTabs) {
    return ASYNC_LOCK.acquire("persist:localStorage", async () => {
        const localStorage = await getStorageLocalPersist();
        await chrome.storage.local.set({
            "persist:localStorage": Object.assign(Object.assign({}, localStorage), { savedTabs }),
        });
    });
}
function localStorageActions_setTabTime(tabId, tabTime) {
    return storage_ASYNC_LOCK.acquire("local.tabTimes", async () => {
        const { tabTimes } = await chrome.storage.local.get({ tabTimes: {} });
        await chrome.storage.local.set({
            tabTimes: Object.assign(Object.assign({}, tabTimes), { [tabId]: tabTime }),
        });
    });
}
function setTabTimes(tabIds, tabTime) {
    return storage_ASYNC_LOCK.acquire("local.tabTimes", async () => {
        const { tabTimes } = await chrome.storage.local.get({ tabTimes: {} });
        tabIds.forEach((tabId) => {
            tabTimes[tabId] = tabTime;
        });
        await chrome.storage.local.set({
            tabTimes,
        });
    });
}
function incrementTotalTabsRemoved() {
    return storage_ASYNC_LOCK.acquire("persist:localStorage", async () => {
        const localStorage = await queries_getStorageLocalPersist();
        await chrome.storage.local.set({
            "persist:localStorage": Object.assign(Object.assign({}, localStorage), { totalTabsRemoved: localStorage.totalTabsRemoved + 1 }),
        });
    });
}
function removeTabTime(tabId) {
    return storage_ASYNC_LOCK.acquire("local.tabTimes", async () => {
        const { tabTimes } = await chrome.storage.local.get({ tabTimes: {} });
        delete tabTimes[tabId];
        await chrome.storage.local.set({
            tabTimes,
        });
    });
}
async function unwrangleTabs(sessionTabs) {
    await ASYNC_LOCK.acquire("persist:localStorage", async () => {
        const localStorage = await getStorageLocalPersist();
        const installDate = localStorage.installDate;
        let countableTabsUnwrangled = 0;
        sessionTabs.forEach((sessionTab) => {
            // Count only those tabs closed after install date because users who upgrade will not have
            // an accurate count of all tabs closed. The updaters' install dates will be the date of
            // the upgrade, after which point TW will keep an accurate count of closed tabs.
            // @ts-expect-error `closedAt` is a TW expando property on tabs
            if (sessionTab.tab.closedAt >= installDate)
                countableTabsUnwrangled++;
        });
        const removedTabsSet = new Set(sessionTabs.map((sessionTab) => serializeTab(sessionTab.tab)));
        // * Remove any tabs that are not in the action's array of tabs.
        const nextSavedTabs = localStorage.savedTabs.filter((tab) => !removedTabsSet.has(serializeTab(tab)));
        const totalTabsUnwrangled = localStorage.totalTabsUnwrangled;
        await chrome.storage.local.set({
            "persist:localStorage": Object.assign(Object.assign({}, localStorage), { savedTabs: nextSavedTabs, totalTabsUnwrangled: totalTabsUnwrangled + countableTabsUnwrangled }),
        });
    });
    await Promise.all(sessionTabs.map((sessionTab) => {
        if (sessionTab.session == null || sessionTab.session.tab == null) {
            return chrome.tabs.create({ active: false, url: sessionTab.tab.url });
        }
        else {
            return chrome.sessions.restore(sessionTab.session.tab.sessionId);
        }
    }));
}

;// CONCATENATED MODULE: ./app/js/tabUtil.ts



const AVERAGE_TAB_BYTES_SIZE = 600;
function findPositionByURL(savedTabs, url = "") {
    return savedTabs.findIndex((item) => item.url === url && url != null);
}
function findPositionByHostnameAndTitle(savedTabs, url = "", title = "") {
    const hostB = new URL(url).hostname;
    return savedTabs.findIndex((tab) => {
        const hostA = new URL(tab.url || "").hostname;
        return hostA === hostB && tab.title === title;
    });
}
function getURLPositionFilterByWrangleOption(savedTabs, option) {
    if (option === "hostnameAndTitleMatch") {
        return (tab) => findPositionByHostnameAndTitle(savedTabs, tab.url, tab.title);
    }
    else if (option === "exactURLMatch") {
        return (tab) => findPositionByURL(savedTabs, tab.url);
    }
    // `'withDupes'` && default
    return () => -1;
}
// Note: Mutates `storageLocalPersist`!
function wrangleTabs(storageLocalPersist, tabs) {
    // No tabs, nothing to do
    if (tabs.length === 0)
        return;
    const maxTabs = settings.get("maxTabs");
    const wrangleOption = settings.get("wrangleOption");
    const findURLPositionByWrangleOption = getURLPositionFilterByWrangleOption(storageLocalPersist.savedTabs, wrangleOption);
    const tabIdsToRemove = [];
    for (let i = 0; i < tabs.length; i++) {
        const existingTabPosition = findURLPositionByWrangleOption(tabs[i]);
        const closingDate = Date.now();
        if (existingTabPosition > -1) {
            storageLocalPersist.savedTabs.splice(existingTabPosition, 1);
        }
        // @ts-expect-error `closedAt` is a TW expando property on tabs
        tabs[i].closedAt = closingDate;
        storageLocalPersist.savedTabs.unshift(tabs[i]);
        storageLocalPersist.totalTabsWrangled += 1;
        const tabId = tabs[i].id;
        if (tabId != null) {
            tabIdsToRemove.push(tabId);
        }
    }
    // Note: intentionally not awaiting tab removal! If removal does need to be awaited then this
    // function must be rewritten to get store values before/after async operations.
    if (tabIdsToRemove.length > 0)
        chrome.tabs.remove(tabIdsToRemove);
    // Trim saved tabs to the max allocated by the setting. Browser extension storage is limited and
    // thus cannot allow saved tabs to grow indefinitely.
    if (storageLocalPersist.savedTabs.length - maxTabs > 0) {
        const tabsToTrim = storageLocalPersist.savedTabs.splice(maxTabs);
        console.log("Exceeded maxTabs (%d), trimming older tabs:", maxTabs);
        console.log(tabsToTrim.map((t) => t.url));
        storageLocalPersist.savedTabs = storageLocalPersist.savedTabs.splice(0, maxTabs);
    }
}
async function wrangleTabsAndPersist(tabs) {
    // No tabs, nothing to do
    if (tabs.length === 0)
        return;
    const storageLocalPersist = await queries_getStorageLocalPersist();
    wrangleTabs(storageLocalPersist, tabs);
    await chrome.storage.local.set({
        "persist:localStorage": storageLocalPersist,
    });
}
async function initTabs() {
    const tabs = await chrome.tabs.query({ windowType: "normal" });
    await setTabTimes(tabs.map((tab) => String(tab.id)), Date.now());
}
function onNewTab(tab) {
    console.debug("[onNewTab] updating new tab", tab);
    // Track new tab's time to close.
    if (tab.id != null)
        updateLastAccessed(tab.id);
}
async function removeTab(tabId) {
    await incrementTotalTabsRemoved();
    settings.unlockTab(tabId);
    await removeTabTime(String(tabId));
}
async function updateClosedCount(showBadgeCount = settings.get("showBadgeCount")) {
    let text;
    if (showBadgeCount) {
        const localStorage = await queries_getStorageLocalPersist();
        const savedTabsLength = localStorage.savedTabs.length;
        text = savedTabsLength === 0 ? "" : savedTabsLength.toString();
    }
    else {
        text = "";
    }
    chrome.action.setBadgeText({ text });
}
async function updateLastAccessed(tabOrTabId) {
    var _a;
    let tabId;
    if (typeof tabOrTabId !== "number" && typeof tabOrTabId.id !== "number") {
        console.log("Error: `tabOrTabId.id` is not an number", tabOrTabId.id);
        return;
    }
    else if (typeof tabOrTabId === "number") {
        tabId = tabOrTabId;
        await localStorageActions_setTabTime(String(tabId), Date.now());
    }
    else {
        tabId = tabOrTabId.id;
        await localStorageActions_setTabTime(String(tabId), (_a = tabOrTabId === null || tabOrTabId === void 0 ? void 0 : tabOrTabId.lastAccessed) !== null && _a !== void 0 ? _a : new Date().getTime());
    }
}
function getWhitelistMatch(url, { whitelist }) {
    if (url == null)
        return null;
    for (let i = 0; i < whitelist.length; i++) {
        if (url.indexOf(whitelist[i]) !== -1) {
            return whitelist[i];
        }
    }
    return null;
}
function isTabLocked(tab, { filterAudio, filterGroupedTabs, lockedIds, whitelist, }) {
    const tabWhitelistMatch = getWhitelistMatch(tab.url, { whitelist });
    return (tab.pinned ||
        !!tabWhitelistMatch ||
        (tab.id != null && lockedIds.indexOf(tab.id) !== -1) ||
        !!(filterGroupedTabs && "groupId" in tab && tab.groupId > 0) ||
        !!(tab.audible && filterAudio));
}

;// CONCATENATED MODULE: ./app/js/menus.ts


function getDomain(url) {
    const match = url.match(/[^:]+:\/\/([^/]+)\//);
    return match == null ? null : match[1];
}
class Menus {
    // Note: intended to be called only once, which is why this function is static. Context menus
    // should be once when the extension is installed.
    static async create() {
        // Failsafe: remove all context menus before creating new ones in case `install` gets called
        // twice. Why does it get called twice? Unknown but have seen it happen and don't want it to
        // break installation.
        await Menus.destroy();
        console.debug("[menus] Creating context menu");
        chrome.contextMenus.create({
            id: "corralTab",
            title: chrome.i18n.getMessage("contextMenu_corralTab"),
            type: "normal",
            contexts: ["page"],
        });
        chrome.contextMenus.create({ id: "separator", type: "separator" });
        chrome.contextMenus.create({
            id: "lockTab",
            title: chrome.i18n.getMessage("contextMenu_lockTab"),
            type: "checkbox",
            contexts: ["page"],
        });
        chrome.contextMenus.create({
            id: "lockDomain",
            title: chrome.i18n.getMessage("contextMenu_lockDomain"),
            type: "checkbox",
            contexts: ["page"],
        });
    }
    static destroy() {
        return new Promise((resolve) => {
            console.debug("[menus] Removing context menu");
            chrome.contextMenus.removeAll(resolve);
        });
    }
    constructor() {
        chrome.contextMenus.onClicked.addListener(this.onClicked.bind(this));
    }
    corralTab(_onClickData, tab) {
        if (tab == null)
            return;
        wrangleTabsAndPersist([tab]);
    }
    lockTab(_onClickData, tab) {
        if ((tab === null || tab === void 0 ? void 0 : tab.id) == null)
            return;
        settings.lockTab(tab.id);
    }
    lockDomain({ wasChecked }, tab) {
        // Tabs don't necessarily have URLs. In those cases there is no domain to lock.
        if ((tab === null || tab === void 0 ? void 0 : tab.url) == null)
            return;
        // If the URL doesn't match our regexp for discovering the domain, do nothing because we have no
        // domain to lock.
        const domain = getDomain(tab.url);
        if (domain == null)
            return;
        const whitelist = settings.get("whitelist");
        if (wasChecked) {
            settings.set("whitelist", whitelist.filter((d) => d !== domain));
        }
        else {
            settings.set("whitelist", [...whitelist, domain]);
        }
    }
    onClicked(info, tab) {
        switch (info.menuItemId) {
            case "corralTab":
                this.corralTab(info, tab);
                break;
            case "lockDomain":
                this.lockDomain(info, tab);
                break;
            case "lockTab":
                this.lockTab(info, tab);
                break;
            default:
                // No-op, no known item was clicked so there is nothing to do.
                break;
        }
    }
    updateContextMenus(tabId) {
        // Sets the title again for each page.
        chrome.tabs.get(tabId, (tab) => {
            if (tab == null || tab.url == null)
                return;
            const currentDomain = getDomain(tab.url);
            if (currentDomain == null)
                return;
            console.debug("[menus] Updating context menu for tab ID ", tabId);
            const whitelist = settings.get("whitelist");
            chrome.contextMenus.update("lockDomain", {
                checked: whitelist.includes(currentDomain),
                title: chrome.i18n.getMessage("contextMenu_lockSpecificDomain", currentDomain) || "",
            });
            chrome.contextMenus.update("lockTab", {
                checked: settings.isTabLocked(tab),
            });
        });
    }
}

;// CONCATENATED MODULE: ./app/js/settings.ts


const defaultCache = {};
const defaultLockedIds = [];
const settings_SETTINGS_DEFAULTS = {
    // Saved sort order for list of closed tabs. When null, default sort is used (resverse chrono.)
    corralTabSortOrder: null,
    // Create a context menu for accessing Tab Wrangler functionality on click
    createContextMenu: true,
    // wait 1 second before updating an active tab
    debounceOnActivated: true,
    // Don't close tabs that are playing audio.
    filterAudio: true,
    // Don't close tabs that are a member of a group.
    filterGroupedTabs: false,
    // An array of tabids which have been explicitly locked by the user.
    lockedIds: defaultLockedIds,
    // Saved sort order for list of open tabs. When null, default sort is used (tab order)
    lockTabSortOrder: null,
    // Max number of tabs stored before the list starts getting truncated.
    maxTabs: 1000,
    // Stop acting if there are only minTabs tabs open.
    minTabs: 20,
    // Strategy for counting minTabs
    // * "allWindows" - sum tabs across all open browser windows
    // * "givenWindow" (default) - count tabs within any given window
    minTabsStrategy: "givenWindow",
    // How many minutes (+ secondsInactive) before we consider a tab "stale" and ready to close.
    minutesInactive: 60,
    // Save closed tabs in between browser sessions.
    purgeClosedTabs: false,
    // How many seconds (+ minutesInactive) before a tab is "stale" and ready to close.
    secondsInactive: 0,
    // When true, shows the number of closed tabs in the list as a badge on the browser icon.
    showBadgeCount: false,
    // An array of patterns to check against. If a URL matches a pattern, it is never locked.
    whitelist: ["about:", "chrome://"],
    // Allow duplicate entries in the closed/wrangled tabs list
    wrangleOption: "withDupes",
};
// This is a SINGLETON! It is imported both by backgrounnd.ts and by popup.tsx and used in both
// environments.
const Settings = {
    _initPromise: undefined,
    cache: defaultCache,
    // Gets all settings from sync and stores them locally.
    init() {
        if (this._initPromise != null)
            return this._initPromise;
        const keys = [];
        for (const i in settings_SETTINGS_DEFAULTS) {
            if (Object.prototype.hasOwnProperty.call(settings_SETTINGS_DEFAULTS, i)) {
                this.cache[i] = settings_SETTINGS_DEFAULTS[i];
                keys.push(i);
            }
        }
        // Sync the cache with the browser's storage area. Changes in the background pages should sync
        // with those in the popup and vice versa.
        //
        // Note: this does NOT integrate with React, this is not a replacement for Redux. React
        // components will not be notified of the new values. For now this is okay because settings are
        // only updated via the popup and so React is already aware of the changes.
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== "sync")
                return;
            for (const [key, value] of Object.entries(changes))
                this.cache[key] = value.newValue;
        });
        this._initPromise = new Promise((resolve) => {
            chrome.storage.sync.get(keys, async (items) => {
                for (const i in items) {
                    if (Object.prototype.hasOwnProperty.call(items, i)) {
                        this.cache[i] = items[i];
                    }
                }
                await this._initLockedIds();
                resolve();
            });
        });
        return this._initPromise;
    },
    async _initLockedIds() {
        if (this.cache.lockedIds == null)
            return Promise.resolve();
        // Remove any tab IDs from the `lockedIds` list that no longer exist so the collection does not
        // grow unbounded. This also ensures tab IDs that are reused are not inadvertently locked.
        const tabs = await chrome.tabs.query({});
        const currTabIds = new Set(tabs.map((tab) => tab.id));
        const nextLockedIds = this.cache.lockedIds.filter((lockedId) => {
            const lockedIdExists = currTabIds.has(lockedId);
            if (!lockedIdExists)
                console.debug(`Locked tab ID ${lockedId} no longer exists; removing from 'lockedIds' list`);
            return lockedIdExists;
        });
        this.set("lockedIds", nextLockedIds);
        return void 0;
    },
    /**
     * Either calls a getter function or returns directly from storage.
     */
    get(key) {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore:next-line
        if (typeof this[key] == "function") {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore:next-line
            return this[key]();
        }
        return this.cache[key];
    },
    getWhitelistMatch(url) {
        return getWhitelistMatch(url, { whitelist: this.get("whitelist") });
    },
    isTabLocked(tab) {
        return isTabLocked(tab, {
            filterAudio: this.get("filterAudio"),
            filterGroupedTabs: this.get("filterGroupedTabs"),
            lockedIds: this.get("lockedIds"),
            whitelist: this.get("whitelist"),
        });
    },
    isTabManuallyLockable(tab) {
        const tabWhitelistMatch = this.getWhitelistMatch(tab.url);
        return (!tab.pinned &&
            !tabWhitelistMatch &&
            !(tab.audible && this.get("filterAudio")) &&
            !(this.get("filterGroupedTabs") && "groupId" in tab && tab.groupId > 0));
    },
    isWhitelisted(url) {
        return this.getWhitelistMatch(url) !== null;
    },
    lockTab(tabId) {
        const lockedIds = this.get("lockedIds");
        if (tabId > 0 && lockedIds.indexOf(tabId) === -1) {
            lockedIds.push(tabId);
        }
        return this.set("lockedIds", lockedIds);
    },
    /**
     * Sets a value in localStorage.  Can also call a setter.
     *
     * If the value is a struct (object or array) it is JSONified.
     */
    set(key, value) {
        // Magic setter functions are set{fieldname}
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore:next-line
        if (typeof this["set" + key] == "function") {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore:next-line
            return this["set" + key](value);
        }
        else {
            return Settings.setValue(key, value);
        }
    },
    setcreateContextMenu(nextCreateContextMenu) {
        if (nextCreateContextMenu)
            Menus.create();
        else
            Menus.destroy();
        return Settings.setValue("createContextMenu", nextCreateContextMenu);
    },
    _getStorageQuota() {
        const quota = chrome.storage.local.QUOTA_BYTES;
        if (quota === undefined) {
            // Firefox doesn't implement QUOTA_BYTES
            // According to https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/local
            // it'll use the "same storage limits as applied to IndexedDB databases"
            // According to https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria#how_much_data_can_be_stored
            // that should be "10% of the total disk size where the profile of the user is store"
            // But to be conservative, and since that's the documented limit for window.localStorage, we're going to limit it to 5MiB
            return 5 * 1024 * 1024;
        }
        else {
            return quota;
        }
    },
    setmaxTabs(maxTabs) {
        const storageQuota = this._getStorageQuota();
        const tabsUpperBound = Math.floor(storageQuota / AVERAGE_TAB_BYTES_SIZE);
        const parsedValue = parseInt(maxTabs, 10);
        if (isNaN(parsedValue) || parsedValue < 1) {
            throw Error(chrome.i18n.getMessage("settings_setmaxTabs_error_invalid") || "Error: settings.setmaxTabs");
        }
        else if (parsedValue > tabsUpperBound) {
            throw Error(chrome.i18n.getMessage("settings_setmaxTabs_error_too_big", [
                tabsUpperBound.toString(),
                storageQuota.toString(),
            ]) || "Error: settings.setmaxTabs");
        }
        return Settings.setValue("maxTabs", parsedValue);
    },
    setminTabs(minTabs) {
        const parsedValue = parseInt(minTabs, 10);
        if (isNaN(parsedValue) || parsedValue < 0) {
            throw Error(chrome.i18n.getMessage("settings_setminTabs_error") || "Error: settings.setminTabs");
        }
        return Settings.setValue("minTabs", parsedValue);
    },
    setminutesInactive(minutesInactive) {
        const minutes = parseInt(minutesInactive, 10);
        if (isNaN(minutes) || minutes < 0) {
            throw Error(chrome.i18n.getMessage("settings_setminutesInactive_error") ||
                "Error: settings.setminutesInactive");
        }
        return Settings.setValue("minutesInactive", minutesInactive);
    },
    setsecondsInactive(secondsInactive) {
        const seconds = parseInt(secondsInactive, 10);
        if (isNaN(seconds) || seconds < 0 || seconds > 59) {
            throw Error(chrome.i18n.getMessage("settings_setsecondsInactive_error") || "Error: setsecondsInactive");
        }
        return Settings.setValue("secondsInactive", secondsInactive);
    },
    setValue(key, value) {
        this.cache[key] = value;
        return chrome.storage.sync.set({ [key]: value });
    },
    /**
     * Returns the number of milliseconds that tabs should stay open for without being used.
     */
    stayOpen() {
        return (parseInt(this.get("minutesInactive"), 10) * 60000 + // minutes
            parseInt(this.get("secondsInactive"), 10) * 1000 // seconds
        );
    },
    toggleTabs(tabs) {
        return Promise.all(tabs.map((tab) => {
            if (tab.id == null)
                return Promise.resolve();
            else if (this.isTabLocked(tab))
                return this.unlockTab(tab.id);
            else
                return this.lockTab(tab.id);
        }));
    },
    unlockTab(tabId) {
        const lockedIds = this.get("lockedIds");
        if (lockedIds.indexOf(tabId) > -1) {
            lockedIds.splice(lockedIds.indexOf(tabId), 1);
        }
        return this.set("lockedIds", lockedIds);
    },
};
/* harmony default export */ const settings = (Settings);

// EXTERNAL MODULE: ./node_modules/react/index.js
var react = __webpack_require__(6540);
;// CONCATENATED MODULE: ./app/js/storage.ts






/* Give an (arbitrary) maxExecutionTime to ensure no dead locks occur. Throwing an error is better
 * than a permanent deadlock. */
const storage_ASYNC_LOCK = new (async_lock_default())({ maxExecutionTime: 5000 });
const STORAGE_LOCAL_VERSION = 1;
async function migrateLocal() {
    const { storageVersion } = await chrome.storage.local.get("storageVersion");
    // New installation or migrating from unversioned -> versioned
    if (storageVersion == null) {
        // Move `tabTimes` from legacy "redux-persist" object into a root key so it can be read/written
        // without having to read the entirety of stored tabs.
        await storage_ASYNC_LOCK.acquire(["local.tabTimes", "persist:localStorage"], async () => {
            let nextTabTimes;
            const data = await chrome.storage.local.get("persist:localStorage");
            const persistLocalStorage = data["persist:localStorage"];
            if (persistLocalStorage != null && "tabTimes" in persistLocalStorage) {
                nextTabTimes = persistLocalStorage.tabTimes;
                delete persistLocalStorage.tabTimes;
                await chrome.storage.local.set({ "persist:localStorage": persistLocalStorage });
            }
            else {
                nextTabTimes = {};
            }
            await chrome.storage.local.set({
                storageVersion: STORAGE_LOCAL_VERSION,
                tabTimes: nextTabTimes,
            });
        });
        console.debug("[migrateLocal]: Migrated to version 1");
    }
}
function mutateStorageSyncPersist({ key, value, }) {
    return storage_ASYNC_LOCK.acquire("persist:settings", async () => {
        const data = await chrome.storage.sync.get({ "persist:settings": {} });
        return chrome.storage.sync.set({
            "persist:settings": Object.assign(Object.assign({}, data["persist:settings"]), { [key]: value }),
        });
    });
}
function lockTabId(tabId) {
    return storage_ASYNC_LOCK.acquire("persist:settings", async () => {
        const { lockedIds } = await chrome.storage.sync.get({ lockedIds: [] });
        if (tabId > 0 && lockedIds.indexOf(tabId) === -1) {
            lockedIds.push(tabId);
            await chrome.storage.sync.set({ lockedIds });
        }
    });
}
async function unlockTabId(tabId) {
    await storage_ASYNC_LOCK.acquire("persist:settings", async () => {
        const { lockedIds } = await chrome.storage.sync.get({ lockedIds: [] });
        if (lockedIds.indexOf(tabId) !== -1) {
            lockedIds.splice(lockedIds.indexOf(tabId), 1);
            await chrome.storage.sync.set({ lockedIds });
        }
    });
    // Reset tab time so the freshly-unlocked tab is not immediately wrangled.
    await setTabTime(String(tabId), Date.now());
}
const STORAGE_LOCAL_PERSIST_QUERY_KEY = ["storageLocalQuery", { type: "persist" }];
function useStorageLocalPersistQuery() {
    const queryClient = useQueryClient();
    useEffect(() => {
        function handleChanged(changes, areaName) {
            if (areaName === "local" && "persist:localStorage" in changes) {
                queryClient.invalidateQueries(STORAGE_LOCAL_PERSIST_QUERY_KEY);
            }
        }
        chrome.storage.onChanged.addListener(handleChanged);
        return () => {
            chrome.storage.onChanged.removeListener(handleChanged);
        };
    }, [queryClient]);
    return useQuery({
        queryFn: async () => {
            const data = await chrome.storage.local.get({ "persist:localStorage": {} });
            return data["persist:localStorage"];
        },
        queryKey: STORAGE_LOCAL_PERSIST_QUERY_KEY,
    });
}
const STORAGE_SYNC_PERSIST_QUERY_KEY = ["storageSyncQuery", { type: "persist" }];
function useStorageSyncPersistQuery() {
    const queryClient = useQueryClient();
    useEffect(() => {
        function handleChanged(changes, areaName) {
            if (areaName === "sync" && "persist:settings" in changes)
                queryClient.invalidateQueries({ queryKey: STORAGE_SYNC_PERSIST_QUERY_KEY });
        }
        chrome.storage.onChanged.addListener(handleChanged);
        return () => chrome.storage.onChanged.removeListener(handleChanged);
    }, [queryClient]);
    return useQuery({
        queryFn: getStorageSyncPersist,
        queryKey: STORAGE_SYNC_PERSIST_QUERY_KEY,
    });
}
const STORAGE_SYNC_QUERY_KEY = (/* unused pure expression or super */ null && (["storageSyncQuery"]));
function useStorageSyncQuery() {
    const queryClient = useQueryClient();
    useEffect(() => {
        function handleChanged(_changes, areaName) {
            if (areaName === "sync")
                queryClient.invalidateQueries({ queryKey: STORAGE_SYNC_QUERY_KEY });
        }
        chrome.storage.onChanged.addListener(handleChanged);
        return () => chrome.storage.onChanged.removeListener(handleChanged);
    }, [queryClient]);
    return useQuery({
        queryFn: () => chrome.storage.sync.get(SETTINGS_DEFAULTS),
        queryKey: ["storageSyncQuery"],
    });
}

;// CONCATENATED MODULE: ./node_modules/lodash-es/isObject.js
/**
 * Checks if `value` is the
 * [language type](http://www.ecma-international.org/ecma-262/7.0/#sec-ecmascript-language-types)
 * of `Object`. (e.g. arrays, functions, objects, regexes, `new Number(0)`, and `new String('')`)
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is an object, else `false`.
 * @example
 *
 * _.isObject({});
 * // => true
 *
 * _.isObject([1, 2, 3]);
 * // => true
 *
 * _.isObject(_.noop);
 * // => true
 *
 * _.isObject(null);
 * // => false
 */
function isObject(value) {
  var type = typeof value;
  return value != null && (type == 'object' || type == 'function');
}

/* harmony default export */ const lodash_es_isObject = (isObject);

;// CONCATENATED MODULE: ./node_modules/lodash-es/_freeGlobal.js
/** Detect free variable `global` from Node.js. */
var freeGlobal = typeof global == 'object' && global && global.Object === Object && global;

/* harmony default export */ const _freeGlobal = (freeGlobal);

;// CONCATENATED MODULE: ./node_modules/lodash-es/_root.js


/** Detect free variable `self`. */
var freeSelf = typeof self == 'object' && self && self.Object === Object && self;

/** Used as a reference to the global object. */
var root = _freeGlobal || freeSelf || Function('return this')();

/* harmony default export */ const _root = (root);

;// CONCATENATED MODULE: ./node_modules/lodash-es/now.js


/**
 * Gets the timestamp of the number of milliseconds that have elapsed since
 * the Unix epoch (1 January 1970 00:00:00 UTC).
 *
 * @static
 * @memberOf _
 * @since 2.4.0
 * @category Date
 * @returns {number} Returns the timestamp.
 * @example
 *
 * _.defer(function(stamp) {
 *   console.log(_.now() - stamp);
 * }, _.now());
 * // => Logs the number of milliseconds it took for the deferred invocation.
 */
var now = function() {
  return _root.Date.now();
};

/* harmony default export */ const lodash_es_now = (now);

;// CONCATENATED MODULE: ./node_modules/lodash-es/_trimmedEndIndex.js
/** Used to match a single whitespace character. */
var reWhitespace = /\s/;

/**
 * Used by `_.trim` and `_.trimEnd` to get the index of the last non-whitespace
 * character of `string`.
 *
 * @private
 * @param {string} string The string to inspect.
 * @returns {number} Returns the index of the last non-whitespace character.
 */
function trimmedEndIndex(string) {
  var index = string.length;

  while (index-- && reWhitespace.test(string.charAt(index))) {}
  return index;
}

/* harmony default export */ const _trimmedEndIndex = (trimmedEndIndex);

;// CONCATENATED MODULE: ./node_modules/lodash-es/_baseTrim.js


/** Used to match leading whitespace. */
var reTrimStart = /^\s+/;

/**
 * The base implementation of `_.trim`.
 *
 * @private
 * @param {string} string The string to trim.
 * @returns {string} Returns the trimmed string.
 */
function baseTrim(string) {
  return string
    ? string.slice(0, _trimmedEndIndex(string) + 1).replace(reTrimStart, '')
    : string;
}

/* harmony default export */ const _baseTrim = (baseTrim);

;// CONCATENATED MODULE: ./node_modules/lodash-es/_Symbol.js


/** Built-in value references. */
var background_Symbol = _root.Symbol;

/* harmony default export */ const _Symbol = (background_Symbol);

;// CONCATENATED MODULE: ./node_modules/lodash-es/_getRawTag.js


/** Used for built-in method references. */
var objectProto = Object.prototype;

/** Used to check objects for own properties. */
var _getRawTag_hasOwnProperty = objectProto.hasOwnProperty;

/**
 * Used to resolve the
 * [`toStringTag`](http://ecma-international.org/ecma-262/7.0/#sec-object.prototype.tostring)
 * of values.
 */
var nativeObjectToString = objectProto.toString;

/** Built-in value references. */
var symToStringTag = _Symbol ? _Symbol.toStringTag : undefined;

/**
 * A specialized version of `baseGetTag` which ignores `Symbol.toStringTag` values.
 *
 * @private
 * @param {*} value The value to query.
 * @returns {string} Returns the raw `toStringTag`.
 */
function getRawTag(value) {
  var isOwn = _getRawTag_hasOwnProperty.call(value, symToStringTag),
      tag = value[symToStringTag];

  try {
    value[symToStringTag] = undefined;
    var unmasked = true;
  } catch (e) {}

  var result = nativeObjectToString.call(value);
  if (unmasked) {
    if (isOwn) {
      value[symToStringTag] = tag;
    } else {
      delete value[symToStringTag];
    }
  }
  return result;
}

/* harmony default export */ const _getRawTag = (getRawTag);

;// CONCATENATED MODULE: ./node_modules/lodash-es/_objectToString.js
/** Used for built-in method references. */
var _objectToString_objectProto = Object.prototype;

/**
 * Used to resolve the
 * [`toStringTag`](http://ecma-international.org/ecma-262/7.0/#sec-object.prototype.tostring)
 * of values.
 */
var _objectToString_nativeObjectToString = _objectToString_objectProto.toString;

/**
 * Converts `value` to a string using `Object.prototype.toString`.
 *
 * @private
 * @param {*} value The value to convert.
 * @returns {string} Returns the converted string.
 */
function objectToString(value) {
  return _objectToString_nativeObjectToString.call(value);
}

/* harmony default export */ const _objectToString = (objectToString);

;// CONCATENATED MODULE: ./node_modules/lodash-es/_baseGetTag.js




/** `Object#toString` result references. */
var nullTag = '[object Null]',
    undefinedTag = '[object Undefined]';

/** Built-in value references. */
var _baseGetTag_symToStringTag = _Symbol ? _Symbol.toStringTag : undefined;

/**
 * The base implementation of `getTag` without fallbacks for buggy environments.
 *
 * @private
 * @param {*} value The value to query.
 * @returns {string} Returns the `toStringTag`.
 */
function baseGetTag(value) {
  if (value == null) {
    return value === undefined ? undefinedTag : nullTag;
  }
  return (_baseGetTag_symToStringTag && _baseGetTag_symToStringTag in Object(value))
    ? _getRawTag(value)
    : _objectToString(value);
}

/* harmony default export */ const _baseGetTag = (baseGetTag);

;// CONCATENATED MODULE: ./node_modules/lodash-es/isObjectLike.js
/**
 * Checks if `value` is object-like. A value is object-like if it's not `null`
 * and has a `typeof` result of "object".
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is object-like, else `false`.
 * @example
 *
 * _.isObjectLike({});
 * // => true
 *
 * _.isObjectLike([1, 2, 3]);
 * // => true
 *
 * _.isObjectLike(_.noop);
 * // => false
 *
 * _.isObjectLike(null);
 * // => false
 */
function isObjectLike(value) {
  return value != null && typeof value == 'object';
}

/* harmony default export */ const lodash_es_isObjectLike = (isObjectLike);

;// CONCATENATED MODULE: ./node_modules/lodash-es/isSymbol.js



/** `Object#toString` result references. */
var symbolTag = '[object Symbol]';

/**
 * Checks if `value` is classified as a `Symbol` primitive or object.
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a symbol, else `false`.
 * @example
 *
 * _.isSymbol(Symbol.iterator);
 * // => true
 *
 * _.isSymbol('abc');
 * // => false
 */
function isSymbol(value) {
  return typeof value == 'symbol' ||
    (lodash_es_isObjectLike(value) && _baseGetTag(value) == symbolTag);
}

/* harmony default export */ const lodash_es_isSymbol = (isSymbol);

;// CONCATENATED MODULE: ./node_modules/lodash-es/toNumber.js




/** Used as references for various `Number` constants. */
var NAN = 0 / 0;

/** Used to detect bad signed hexadecimal string values. */
var reIsBadHex = /^[-+]0x[0-9a-f]+$/i;

/** Used to detect binary string values. */
var reIsBinary = /^0b[01]+$/i;

/** Used to detect octal string values. */
var reIsOctal = /^0o[0-7]+$/i;

/** Built-in method references without a dependency on `root`. */
var freeParseInt = parseInt;

/**
 * Converts `value` to a number.
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to process.
 * @returns {number} Returns the number.
 * @example
 *
 * _.toNumber(3.2);
 * // => 3.2
 *
 * _.toNumber(Number.MIN_VALUE);
 * // => 5e-324
 *
 * _.toNumber(Infinity);
 * // => Infinity
 *
 * _.toNumber('3.2');
 * // => 3.2
 */
function toNumber(value) {
  if (typeof value == 'number') {
    return value;
  }
  if (lodash_es_isSymbol(value)) {
    return NAN;
  }
  if (lodash_es_isObject(value)) {
    var other = typeof value.valueOf == 'function' ? value.valueOf() : value;
    value = lodash_es_isObject(other) ? (other + '') : other;
  }
  if (typeof value != 'string') {
    return value === 0 ? value : +value;
  }
  value = _baseTrim(value);
  var isBinary = reIsBinary.test(value);
  return (isBinary || reIsOctal.test(value))
    ? freeParseInt(value.slice(2), isBinary ? 2 : 8)
    : (reIsBadHex.test(value) ? NAN : +value);
}

/* harmony default export */ const lodash_es_toNumber = (toNumber);

;// CONCATENATED MODULE: ./node_modules/lodash-es/debounce.js




/** Error message constants. */
var FUNC_ERROR_TEXT = 'Expected a function';

/* Built-in method references for those with the same name as other `lodash` methods. */
var nativeMax = Math.max,
    nativeMin = Math.min;

/**
 * Creates a debounced function that delays invoking `func` until after `wait`
 * milliseconds have elapsed since the last time the debounced function was
 * invoked. The debounced function comes with a `cancel` method to cancel
 * delayed `func` invocations and a `flush` method to immediately invoke them.
 * Provide `options` to indicate whether `func` should be invoked on the
 * leading and/or trailing edge of the `wait` timeout. The `func` is invoked
 * with the last arguments provided to the debounced function. Subsequent
 * calls to the debounced function return the result of the last `func`
 * invocation.
 *
 * **Note:** If `leading` and `trailing` options are `true`, `func` is
 * invoked on the trailing edge of the timeout only if the debounced function
 * is invoked more than once during the `wait` timeout.
 *
 * If `wait` is `0` and `leading` is `false`, `func` invocation is deferred
 * until to the next tick, similar to `setTimeout` with a timeout of `0`.
 *
 * See [David Corbacho's article](https://css-tricks.com/debouncing-throttling-explained-examples/)
 * for details over the differences between `_.debounce` and `_.throttle`.
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Function
 * @param {Function} func The function to debounce.
 * @param {number} [wait=0] The number of milliseconds to delay.
 * @param {Object} [options={}] The options object.
 * @param {boolean} [options.leading=false]
 *  Specify invoking on the leading edge of the timeout.
 * @param {number} [options.maxWait]
 *  The maximum time `func` is allowed to be delayed before it's invoked.
 * @param {boolean} [options.trailing=true]
 *  Specify invoking on the trailing edge of the timeout.
 * @returns {Function} Returns the new debounced function.
 * @example
 *
 * // Avoid costly calculations while the window size is in flux.
 * jQuery(window).on('resize', _.debounce(calculateLayout, 150));
 *
 * // Invoke `sendMail` when clicked, debouncing subsequent calls.
 * jQuery(element).on('click', _.debounce(sendMail, 300, {
 *   'leading': true,
 *   'trailing': false
 * }));
 *
 * // Ensure `batchLog` is invoked once after 1 second of debounced calls.
 * var debounced = _.debounce(batchLog, 250, { 'maxWait': 1000 });
 * var source = new EventSource('/stream');
 * jQuery(source).on('message', debounced);
 *
 * // Cancel the trailing debounced invocation.
 * jQuery(window).on('popstate', debounced.cancel);
 */
function debounce(func, wait, options) {
  var lastArgs,
      lastThis,
      maxWait,
      result,
      timerId,
      lastCallTime,
      lastInvokeTime = 0,
      leading = false,
      maxing = false,
      trailing = true;

  if (typeof func != 'function') {
    throw new TypeError(FUNC_ERROR_TEXT);
  }
  wait = lodash_es_toNumber(wait) || 0;
  if (lodash_es_isObject(options)) {
    leading = !!options.leading;
    maxing = 'maxWait' in options;
    maxWait = maxing ? nativeMax(lodash_es_toNumber(options.maxWait) || 0, wait) : maxWait;
    trailing = 'trailing' in options ? !!options.trailing : trailing;
  }

  function invokeFunc(time) {
    var args = lastArgs,
        thisArg = lastThis;

    lastArgs = lastThis = undefined;
    lastInvokeTime = time;
    result = func.apply(thisArg, args);
    return result;
  }

  function leadingEdge(time) {
    // Reset any `maxWait` timer.
    lastInvokeTime = time;
    // Start the timer for the trailing edge.
    timerId = setTimeout(timerExpired, wait);
    // Invoke the leading edge.
    return leading ? invokeFunc(time) : result;
  }

  function remainingWait(time) {
    var timeSinceLastCall = time - lastCallTime,
        timeSinceLastInvoke = time - lastInvokeTime,
        timeWaiting = wait - timeSinceLastCall;

    return maxing
      ? nativeMin(timeWaiting, maxWait - timeSinceLastInvoke)
      : timeWaiting;
  }

  function shouldInvoke(time) {
    var timeSinceLastCall = time - lastCallTime,
        timeSinceLastInvoke = time - lastInvokeTime;

    // Either this is the first call, activity has stopped and we're at the
    // trailing edge, the system time has gone backwards and we're treating
    // it as the trailing edge, or we've hit the `maxWait` limit.
    return (lastCallTime === undefined || (timeSinceLastCall >= wait) ||
      (timeSinceLastCall < 0) || (maxing && timeSinceLastInvoke >= maxWait));
  }

  function timerExpired() {
    var time = lodash_es_now();
    if (shouldInvoke(time)) {
      return trailingEdge(time);
    }
    // Restart the timer.
    timerId = setTimeout(timerExpired, remainingWait(time));
  }

  function trailingEdge(time) {
    timerId = undefined;

    // Only invoke if we have `lastArgs` which means `func` has been
    // debounced at least once.
    if (trailing && lastArgs) {
      return invokeFunc(time);
    }
    lastArgs = lastThis = undefined;
    return result;
  }

  function cancel() {
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }
    lastInvokeTime = 0;
    lastArgs = lastCallTime = lastThis = timerId = undefined;
  }

  function flush() {
    return timerId === undefined ? result : trailingEdge(lodash_es_now());
  }

  function debounced() {
    var time = lodash_es_now(),
        isInvoking = shouldInvoke(time);

    lastArgs = arguments;
    lastThis = this;
    lastCallTime = time;

    if (isInvoking) {
      if (timerId === undefined) {
        return leadingEdge(lastCallTime);
      }
      if (maxing) {
        // Handle invocations in a tight loop.
        clearTimeout(timerId);
        timerId = setTimeout(timerExpired, wait);
        return invokeFunc(lastCallTime);
      }
    }
    if (timerId === undefined) {
      timerId = setTimeout(timerExpired, wait);
    }
    return result;
  }
  debounced.cancel = cancel;
  debounced.flush = flush;
  return debounced;
}

/* harmony default export */ const lodash_es_debounce = (debounce);

;// CONCATENATED MODULE: ./app/background.ts







const menus = new Menus();
function setPaused(paused) {
    if (paused) {
        return chrome.action.setIcon({ path: "img/icon-paused.png" });
    }
    else {
        return chrome.action.setIcon({ path: "img/icon.png" });
    }
}
const debouncedUpdateLastAccessed = lodash_es_debounce(updateLastAccessed, 1000);
chrome.runtime.onInstalled.addListener(async () => {
    await settings.init();
    if (settings.get("createContextMenu"))
        Menus.create();
    migrateLocal();
});
chrome.tabs.onActivated.addListener(async function onActivated(tabInfo) {
    await settings.init();
    if (settings.get("createContextMenu"))
        menus.updateContextMenus(tabInfo.tabId);
    if (settings.get("debounceOnActivated")) {
        debouncedUpdateLastAccessed(tabInfo.tabId);
    }
    else {
        updateLastAccessed(tabInfo.tabId);
    }
});
chrome.tabs.onCreated.addListener(onNewTab);
chrome.tabs.onRemoved.addListener(removeTab);
chrome.tabs.onReplaced.addListener(function replaceTab(addedTabId, removedTabId) {
    storage_ASYNC_LOCK.acquire(["local.tabTimes", "persist:settings"], async () => {
        // Replace tab ID in array of locked IDs if the removed tab was locked
        const { lockedIds } = await chrome.storage.sync.get({ lockedIds: [] });
        if (lockedIds.indexOf(removedTabId) !== -1) {
            lockedIds.splice(lockedIds.indexOf(removedTabId), 1, addedTabId);
            await chrome.storage.sync.set({ lockedIds });
            console.debug("[onReplaced] Re-locked tab: removedId, addedId", removedTabId, addedTabId);
        }
        // Replace tab ID in object of tab times keeping the same time remaining for the added tab ID
        const { tabTimes } = await chrome.storage.local.get({ tabTimes: {} });
        tabTimes[addedTabId] = tabTimes[removedTabId];
        delete tabTimes[removedTabId];
        await chrome.storage.local.set({
            tabTimes,
        });
        console.debug("[onReplaced] Replaced tab time: removedId, addedId", removedTabId, addedTabId);
    });
});
chrome.commands.onCommand.addListener((command) => {
    switch (command) {
        case "lock-unlock-active-tab":
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                settings.toggleTabs(tabs);
            });
            break;
        case "wrangle-current-tab":
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                wrangleTabsAndPersist(tabs);
            });
            break;
        default:
            break;
    }
});
chrome.storage.onChanged.addListener((changes, areaName) => {
    var _a, _b, _c;
    switch (areaName) {
        case "local": {
            updateClosedCount();
            break;
        }
        case "sync": {
            if (changes.minutesInactive || changes.secondsInactive) {
                // Reset stored `tabTimes` because setting was changed otherwise old times may exceed new
                // setting value.
                initTabs();
            }
            if (changes["persist:settings"]) {
                if (((_a = changes["persist:settings"]) === null || _a === void 0 ? void 0 : _a.newValue.paused) !==
                    ((_c = (_b = changes["persist:settings"]) === null || _b === void 0 ? void 0 : _b.oldValue) === null || _c === void 0 ? void 0 : _c.paused)) {
                    setPaused(changes["persist:settings"].newValue.paused);
                }
            }
            if (changes.showBadgeCount) {
                updateClosedCount(changes.showBadgeCount.newValue);
            }
            break;
        }
    }
});
function getTabsOlderThan(tabTimes, time) {
    const ret = [];
    for (const i in tabTimes) {
        if (Object.prototype.hasOwnProperty.call(tabTimes, i)) {
            if (!time || tabTimes[i] < time) {
                ret.push(parseInt(i, 10));
            }
        }
    }
    return ret;
}
let checkToCloseTimeout;
function scheduleCheckToClose() {
    if (checkToCloseTimeout != null)
        clearTimeout(checkToCloseTimeout);
    checkToCloseTimeout = setTimeout(checkToClose, 5000);
}
async function checkToClose() {
    const startTime = Date.now();
    try {
        const storageSyncPersist = await queries_getStorageSyncPersist();
        if (storageSyncPersist.paused)
            return; // Extension is paused, no work needs to be done.
        const cutOff = new Date().getTime() - settings.get("stayOpen");
        const minTabs = settings.get("minTabs");
        let tabsToCloseCandidates = [];
        await storage_ASYNC_LOCK.acquire("local.tabTimes", async () => {
            const { tabTimes } = await chrome.storage.local.get({ tabTimes: {} });
            // Tabs which have been locked via the checkbox.
            const lockedIds = settings.get("lockedIds");
            const toCut = getTabsOlderThan(tabTimes, cutOff);
            const updatedAt = Date.now();
            // Update selected tabs to make sure they don't get closed.
            const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            activeTabs.forEach((tab) => {
                tabTimes[String(tab.id)] = updatedAt;
            });
            // Update audible tabs if the setting is enabled to prevent them from being closed.
            if (settings.get("filterAudio") === true) {
                const audibleTabs = await chrome.tabs.query({ audible: true });
                audibleTabs.forEach((tab) => {
                    tabTimes[String(tab.id)] = updatedAt;
                });
            }
            function findTabsToCloseCandidates(tabs, { resetIfNoCandidates }) {
                // Filter out pinned tabs
                tabs = tabs.filter((tab) => tab.pinned === false);
                // Filter out audible tabs if the option to do so is checked
                tabs = settings.get("filterAudio") ? tabs.filter((tab) => !tab.audible) : tabs;
                // Filter out tabs that are in a group if the option to do so is checked
                tabs = settings.get("filterGroupedTabs")
                    ? tabs.filter((tab) => !("groupId" in tab) || tab.groupId <= 0)
                    : tabs;
                let tabsToCut = tabs.filter((tab) => tab.id == null || toCut.indexOf(tab.id) !== -1);
                if (tabs.length - minTabs <= 0) {
                    // * We have less than minTab tabs, abort.
                    // * Also, reset the last accessed time of our current tabs so they don't get closed
                    //   when we add a new one
                    for (let i = 0; i < tabs.length; i++) {
                        const tabId = tabs[i].id;
                        if (tabId != null && resetIfNoCandidates)
                            tabTimes[tabId] = updatedAt;
                    }
                    return [];
                }
                // If cutting will reduce us below `minTabs`, only remove the first N to get to `minTabs`.
                tabsToCut = tabsToCut.splice(0, tabs.length - minTabs);
                if (tabsToCut.length === 0) {
                    return [];
                }
                const candidates = [];
                for (let i = 0; i < tabsToCut.length; i++) {
                    const tabId = tabsToCut[i].id;
                    if (tabId == null)
                        continue;
                    if (lockedIds.indexOf(tabId) !== -1) {
                        // Update its time so it gets checked less frequently.
                        // Would also be smart to just never add it.
                        // @todo: fix that.
                        tabTimes[String(tabId)] = updatedAt;
                        continue;
                    }
                    candidates.push(tabsToCut[i]);
                }
                return candidates;
            }
            if (settings.get("minTabsStrategy") === "allWindows") {
                // * "allWindows" - sum tabs across all open browser windows
                const tabs = await chrome.tabs.query({});
                tabsToCloseCandidates = findTabsToCloseCandidates(tabs, {
                    resetIfNoCandidates: false,
                });
            }
            else {
                // * "givenWindow" (default) - count tabs within any given window
                const windows = await chrome.windows.getAll({ populate: true });
                tabsToCloseCandidates = windows
                    .map((win) => win.tabs == null
                    ? []
                    : findTabsToCloseCandidates(win.tabs, { resetIfNoCandidates: win.focused }))
                    .reduce((acc, candidates) => acc.concat(candidates), []);
            }
            // Populate and cull `tabTimes` before storing again.
            // * Tab was missing from the object? the `tabs.query` will return it and its time will be
            //   populated
            // * Tab no longer exists? reducing `tabs.query` will not yield that dead tab ID and it will
            //   not exist in resulting `nextTabTimes`
            const allTabs = await chrome.tabs.query({});
            const nextTabTimes = allTabs.reduce((acc, tab) => {
                if (tab.id != null)
                    acc[tab.id] = tabTimes[tab.id] || updatedAt;
                return acc;
            }, {});
            await chrome.storage.local.set({ tabTimes: nextTabTimes });
        });
        const tabsToClose = tabsToCloseCandidates.filter((tab) => !(true === tab.pinned ||
            (settings.get("filterAudio") && tab.audible) ||
            (tab.url != null && settings.isWhitelisted(tab.url))));
        if (tabsToClose.length > 0) {
            await storage_ASYNC_LOCK.acquire("persist:localStorage", async () => {
                const storageLocalPersist = await queries_getStorageLocalPersist();
                wrangleTabs(storageLocalPersist, tabsToClose);
                await chrome.storage.local.set({
                    "persist:localStorage": storageLocalPersist,
                });
            });
        }
    }
    catch (error) {
        console.error("[checkToClose]", error);
    }
    finally {
        const elapsedTime = Date.now() - startTime;
        if (elapsedTime > 5000)
            console.warn(`[checkToClose] Took longer than maxExecutionTime: ${elapsedTime}ms`);
        scheduleCheckToClose();
    }
}
async function startup() {
    // Load settings before proceeding; Settings reads from async browser storage.
    await settings.init();
    const storageSyncPersist = await queries_getStorageSyncPersist();
    setPaused(storageSyncPersist.paused);
    // Because the badge count is external state, this side effect must be run once the value
    // is read from storage.
    updateClosedCount();
    if (settings.get("purgeClosedTabs") !== false) {
        await removeAllSavedTabs();
    }
    // Kick off checking for tabs to close
    scheduleCheckToClose();
}
startup();
// Keep the [service worker (Chrome) / background script (Firefox)] alive so background can check
// for tabs to close frequently.
// Self-contained workaround for https://crbug.com/1316588 (Apache License)
// Source: https://bugs.chromium.org/p/chromium/issues/detail?id=1316588#c99
let lastAlarm = 0;
(async function lostEventsWatchdog() {
    let quietCount = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        await new Promise((resolve) => setTimeout(resolve, 65000));
        const now = Date.now();
        const age = now - lastAlarm;
        console.debug(lastAlarm === 0
            ? `[lostEventsWatchdog]: first alarm`
            : `[lostEventsWatchdog]: last alarm ${age / 1000}s ago`);
        if (age < 95000) {
            quietCount = 0; // alarm still works.
        }
        else if (++quietCount >= 3) {
            console.warn("[lostEventsWatchdog]: reloading!");
            return chrome.runtime.reload();
        }
        else {
            chrome.alarms.create(`lostEventsWatchdog/${now}`, { delayInMinutes: 0.5 });
        }
    }
})();
chrome.alarms.onAlarm.addListener(() => (lastAlarm = Date.now()));
chrome.runtime.onMessage.addListener((message) => {
    if (message === "reload") {
        console.warn("[runtime.onMessage]: Manual reload");
        chrome.runtime.reload();
        return true;
    }
    else
        return false;
});

/******/ })()
;