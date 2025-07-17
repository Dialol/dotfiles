/******/ (() => { // webpackBootstrap
/******/ 	var __webpack_modules__ = ({

/***/ 8465:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

"use strict";

module.exports = __webpack_require__(809);


/***/ }),

/***/ 809:
/***/ ((module) => {

"use strict";


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

/***/ 4213:
/***/ (function(module, exports, __webpack_require__) {

var __WEBPACK_AMD_DEFINE_FACTORY__, __WEBPACK_AMD_DEFINE_ARRAY__, __WEBPACK_AMD_DEFINE_RESULT__;(function(a,b){if(true)!(__WEBPACK_AMD_DEFINE_ARRAY__ = [], __WEBPACK_AMD_DEFINE_FACTORY__ = (b),
		__WEBPACK_AMD_DEFINE_RESULT__ = (typeof __WEBPACK_AMD_DEFINE_FACTORY__ === 'function' ?
		(__WEBPACK_AMD_DEFINE_FACTORY__.apply(exports, __WEBPACK_AMD_DEFINE_ARRAY__)) : __WEBPACK_AMD_DEFINE_FACTORY__),
		__WEBPACK_AMD_DEFINE_RESULT__ !== undefined && (module.exports = __WEBPACK_AMD_DEFINE_RESULT__));else {}})(this,function(){"use strict";function b(a,b){return"undefined"==typeof b?b={autoBom:!1}:"object"!=typeof b&&(console.warn("Deprecated: Expected third argument to be a object"),b={autoBom:!b}),b.autoBom&&/^\s*(?:text\/\S*|application\/xml|\S*\/\S*\+xml)\s*;.*charset\s*=\s*utf-8/i.test(a.type)?new Blob(["\uFEFF",a],{type:a.type}):a}function c(a,b,c){var d=new XMLHttpRequest;d.open("GET",a),d.responseType="blob",d.onload=function(){g(d.response,b,c)},d.onerror=function(){console.error("could not download file")},d.send()}function d(a){var b=new XMLHttpRequest;b.open("HEAD",a,!1);try{b.send()}catch(a){}return 200<=b.status&&299>=b.status}function e(a){try{a.dispatchEvent(new MouseEvent("click"))}catch(c){var b=document.createEvent("MouseEvents");b.initMouseEvent("click",!0,!0,window,0,0,0,80,20,!1,!1,!1,!1,0,null),a.dispatchEvent(b)}}var f="object"==typeof window&&window.window===window?window:"object"==typeof self&&self.self===self?self:"object"==typeof __webpack_require__.g&&__webpack_require__.g.global===__webpack_require__.g?__webpack_require__.g:void 0,a=f.navigator&&/Macintosh/.test(navigator.userAgent)&&/AppleWebKit/.test(navigator.userAgent)&&!/Safari/.test(navigator.userAgent),g=f.saveAs||("object"!=typeof window||window!==f?function(){}:"download"in HTMLAnchorElement.prototype&&!a?function(b,g,h){var i=f.URL||f.webkitURL,j=document.createElement("a");g=g||b.name||"download",j.download=g,j.rel="noopener","string"==typeof b?(j.href=b,j.origin===location.origin?e(j):d(j.href)?c(b,g,h):e(j,j.target="_blank")):(j.href=i.createObjectURL(b),setTimeout(function(){i.revokeObjectURL(j.href)},4E4),setTimeout(function(){e(j)},0))}:"msSaveOrOpenBlob"in navigator?function(f,g,h){if(g=g||f.name||"download","string"!=typeof f)navigator.msSaveOrOpenBlob(b(f,h),g);else if(d(f))c(f,g,h);else{var i=document.createElement("a");i.href=f,i.target="_blank",setTimeout(function(){e(i)})}}:function(b,d,e,g){if(g=g||open("","_blank"),g&&(g.document.title=g.document.body.innerText="downloading..."),"string"==typeof b)return c(b,d,e);var h="application/octet-stream"===b.type,i=/constructor/i.test(f.HTMLElement)||f.safari,j=/CriOS\/[\d]+/.test(navigator.userAgent);if((j||h&&i||a)&&"undefined"!=typeof FileReader){var k=new FileReader;k.onloadend=function(){var a=k.result;a=j?a:a.replace(/^data:[^;]*;/,"data:attachment/file;"),g?g.location.href=a:location=a,g=null},k.readAsDataURL(b)}else{var l=f.URL||f.webkitURL,m=l.createObjectURL(b);g?g.location=m:location.href=m,g=null,setTimeout(function(){l.revokeObjectURL(m)},4E4)}});f.saveAs=g.saveAs=g, true&&(module.exports=g)});

//# sourceMappingURL=FileSaver.min.js.map

/***/ }),

/***/ 311:
/***/ ((module) => {

"use strict";
/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */



/**
 * Use invariant() to assert state which your program assumes to be true.
 *
 * Provide sprintf-style format (only %s is supported) and arguments
 * to provide information about what broke and what you were
 * expecting.
 *
 * The invariant message will be stripped in production, but the invariant
 * will remain to ensure logic does not differ in production.
 */

var invariant = function(condition, format, a, b, c, d, e, f) {
  if (false) {}

  if (!condition) {
    var error;
    if (format === undefined) {
      error = new Error(
        'Minified exception occurred; use the non-minified dev environment ' +
        'for the full error message and additional helpful warnings.'
      );
    } else {
      var args = [a, b, c, d, e, f];
      var argIndex = 0;
      error = new Error(
        format.replace(/%s/g, function() { return args[argIndex++]; })
      );
      error.name = 'Invariant Violation';
    }

    error.framesToPop = 1; // we don't care about invariant's own frame
    throw error;
  }
};

module.exports = invariant;


/***/ }),

/***/ 2694:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

"use strict";
/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */



var ReactPropTypesSecret = __webpack_require__(6925);

function emptyFunction() {}
function emptyFunctionWithReset() {}
emptyFunctionWithReset.resetWarningCache = emptyFunction;

module.exports = function() {
  function shim(props, propName, componentName, location, propFullName, secret) {
    if (secret === ReactPropTypesSecret) {
      // It is still safe when called from React.
      return;
    }
    var err = new Error(
      'Calling PropTypes validators directly is not supported by the `prop-types` package. ' +
      'Use PropTypes.checkPropTypes() to call them. ' +
      'Read more at http://fb.me/use-check-prop-types'
    );
    err.name = 'Invariant Violation';
    throw err;
  };
  shim.isRequired = shim;
  function getShim() {
    return shim;
  };
  // Important!
  // Keep this list in sync with production version in `./factoryWithTypeCheckers.js`.
  var ReactPropTypes = {
    array: shim,
    bigint: shim,
    bool: shim,
    func: shim,
    number: shim,
    object: shim,
    string: shim,
    symbol: shim,

    any: shim,
    arrayOf: getShim,
    element: shim,
    elementType: shim,
    instanceOf: getShim,
    node: shim,
    objectOf: getShim,
    oneOf: getShim,
    oneOfType: getShim,
    shape: getShim,
    exact: getShim,

    checkPropTypes: emptyFunctionWithReset,
    resetWarningCache: emptyFunction
  };

  ReactPropTypes.PropTypes = ReactPropTypes;

  return ReactPropTypes;
};


/***/ }),

/***/ 5556:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

if (false) { var throwOnDirectAccess, ReactIs; } else {
  // By explicitly using `prop-types` you are opting into new production behavior.
  // http://fb.me/prop-types-in-prod
  module.exports = __webpack_require__(2694)();
}


/***/ }),

/***/ 6925:
/***/ ((module) => {

"use strict";
/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */



var ReactPropTypesSecret = 'SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED';

module.exports = ReactPropTypesSecret;


/***/ }),

/***/ 2551:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {

"use strict";
/**
 * @license React
 * react-dom.production.min.js
 *
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
/*
 Modernizr 3.0.0pre (Custom Build) | MIT
*/
var aa=__webpack_require__(6540),ca=__webpack_require__(9982);function p(a){for(var b="https://reactjs.org/docs/error-decoder.html?invariant="+a,c=1;c<arguments.length;c++)b+="&args[]="+encodeURIComponent(arguments[c]);return"Minified React error #"+a+"; visit "+b+" for the full message or use the non-minified dev environment for full errors and additional helpful warnings."}var da=new Set,ea={};function fa(a,b){ha(a,b);ha(a+"Capture",b)}
function ha(a,b){ea[a]=b;for(a=0;a<b.length;a++)da.add(b[a])}
var ia=!("undefined"===typeof window||"undefined"===typeof window.document||"undefined"===typeof window.document.createElement),ja=Object.prototype.hasOwnProperty,ka=/^[:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD][:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\-.0-9\u00B7\u0300-\u036F\u203F-\u2040]*$/,la=
{},ma={};function oa(a){if(ja.call(ma,a))return!0;if(ja.call(la,a))return!1;if(ka.test(a))return ma[a]=!0;la[a]=!0;return!1}function pa(a,b,c,d){if(null!==c&&0===c.type)return!1;switch(typeof b){case "function":case "symbol":return!0;case "boolean":if(d)return!1;if(null!==c)return!c.acceptsBooleans;a=a.toLowerCase().slice(0,5);return"data-"!==a&&"aria-"!==a;default:return!1}}
function qa(a,b,c,d){if(null===b||"undefined"===typeof b||pa(a,b,c,d))return!0;if(d)return!1;if(null!==c)switch(c.type){case 3:return!b;case 4:return!1===b;case 5:return isNaN(b);case 6:return isNaN(b)||1>b}return!1}function v(a,b,c,d,e,f,g){this.acceptsBooleans=2===b||3===b||4===b;this.attributeName=d;this.attributeNamespace=e;this.mustUseProperty=c;this.propertyName=a;this.type=b;this.sanitizeURL=f;this.removeEmptyString=g}var z={};
"children dangerouslySetInnerHTML defaultValue defaultChecked innerHTML suppressContentEditableWarning suppressHydrationWarning style".split(" ").forEach(function(a){z[a]=new v(a,0,!1,a,null,!1,!1)});[["acceptCharset","accept-charset"],["className","class"],["htmlFor","for"],["httpEquiv","http-equiv"]].forEach(function(a){var b=a[0];z[b]=new v(b,1,!1,a[1],null,!1,!1)});["contentEditable","draggable","spellCheck","value"].forEach(function(a){z[a]=new v(a,2,!1,a.toLowerCase(),null,!1,!1)});
["autoReverse","externalResourcesRequired","focusable","preserveAlpha"].forEach(function(a){z[a]=new v(a,2,!1,a,null,!1,!1)});"allowFullScreen async autoFocus autoPlay controls default defer disabled disablePictureInPicture disableRemotePlayback formNoValidate hidden loop noModule noValidate open playsInline readOnly required reversed scoped seamless itemScope".split(" ").forEach(function(a){z[a]=new v(a,3,!1,a.toLowerCase(),null,!1,!1)});
["checked","multiple","muted","selected"].forEach(function(a){z[a]=new v(a,3,!0,a,null,!1,!1)});["capture","download"].forEach(function(a){z[a]=new v(a,4,!1,a,null,!1,!1)});["cols","rows","size","span"].forEach(function(a){z[a]=new v(a,6,!1,a,null,!1,!1)});["rowSpan","start"].forEach(function(a){z[a]=new v(a,5,!1,a.toLowerCase(),null,!1,!1)});var ra=/[\-:]([a-z])/g;function sa(a){return a[1].toUpperCase()}
"accent-height alignment-baseline arabic-form baseline-shift cap-height clip-path clip-rule color-interpolation color-interpolation-filters color-profile color-rendering dominant-baseline enable-background fill-opacity fill-rule flood-color flood-opacity font-family font-size font-size-adjust font-stretch font-style font-variant font-weight glyph-name glyph-orientation-horizontal glyph-orientation-vertical horiz-adv-x horiz-origin-x image-rendering letter-spacing lighting-color marker-end marker-mid marker-start overline-position overline-thickness paint-order panose-1 pointer-events rendering-intent shape-rendering stop-color stop-opacity strikethrough-position strikethrough-thickness stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width text-anchor text-decoration text-rendering underline-position underline-thickness unicode-bidi unicode-range units-per-em v-alphabetic v-hanging v-ideographic v-mathematical vector-effect vert-adv-y vert-origin-x vert-origin-y word-spacing writing-mode xmlns:xlink x-height".split(" ").forEach(function(a){var b=a.replace(ra,
sa);z[b]=new v(b,1,!1,a,null,!1,!1)});"xlink:actuate xlink:arcrole xlink:role xlink:show xlink:title xlink:type".split(" ").forEach(function(a){var b=a.replace(ra,sa);z[b]=new v(b,1,!1,a,"http://www.w3.org/1999/xlink",!1,!1)});["xml:base","xml:lang","xml:space"].forEach(function(a){var b=a.replace(ra,sa);z[b]=new v(b,1,!1,a,"http://www.w3.org/XML/1998/namespace",!1,!1)});["tabIndex","crossOrigin"].forEach(function(a){z[a]=new v(a,1,!1,a.toLowerCase(),null,!1,!1)});
z.xlinkHref=new v("xlinkHref",1,!1,"xlink:href","http://www.w3.org/1999/xlink",!0,!1);["src","href","action","formAction"].forEach(function(a){z[a]=new v(a,1,!1,a.toLowerCase(),null,!0,!0)});
function ta(a,b,c,d){var e=z.hasOwnProperty(b)?z[b]:null;if(null!==e?0!==e.type:d||!(2<b.length)||"o"!==b[0]&&"O"!==b[0]||"n"!==b[1]&&"N"!==b[1])qa(b,c,e,d)&&(c=null),d||null===e?oa(b)&&(null===c?a.removeAttribute(b):a.setAttribute(b,""+c)):e.mustUseProperty?a[e.propertyName]=null===c?3===e.type?!1:"":c:(b=e.attributeName,d=e.attributeNamespace,null===c?a.removeAttribute(b):(e=e.type,c=3===e||4===e&&!0===c?"":""+c,d?a.setAttributeNS(d,b,c):a.setAttribute(b,c)))}
var ua=aa.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED,va=Symbol.for("react.element"),wa=Symbol.for("react.portal"),ya=Symbol.for("react.fragment"),za=Symbol.for("react.strict_mode"),Aa=Symbol.for("react.profiler"),Ba=Symbol.for("react.provider"),Ca=Symbol.for("react.context"),Da=Symbol.for("react.forward_ref"),Ea=Symbol.for("react.suspense"),Fa=Symbol.for("react.suspense_list"),Ga=Symbol.for("react.memo"),Ha=Symbol.for("react.lazy");Symbol.for("react.scope");Symbol.for("react.debug_trace_mode");
var Ia=Symbol.for("react.offscreen");Symbol.for("react.legacy_hidden");Symbol.for("react.cache");Symbol.for("react.tracing_marker");var Ja=Symbol.iterator;function Ka(a){if(null===a||"object"!==typeof a)return null;a=Ja&&a[Ja]||a["@@iterator"];return"function"===typeof a?a:null}var A=Object.assign,La;function Ma(a){if(void 0===La)try{throw Error();}catch(c){var b=c.stack.trim().match(/\n( *(at )?)/);La=b&&b[1]||""}return"\n"+La+a}var Na=!1;
function Oa(a,b){if(!a||Na)return"";Na=!0;var c=Error.prepareStackTrace;Error.prepareStackTrace=void 0;try{if(b)if(b=function(){throw Error();},Object.defineProperty(b.prototype,"props",{set:function(){throw Error();}}),"object"===typeof Reflect&&Reflect.construct){try{Reflect.construct(b,[])}catch(l){var d=l}Reflect.construct(a,[],b)}else{try{b.call()}catch(l){d=l}a.call(b.prototype)}else{try{throw Error();}catch(l){d=l}a()}}catch(l){if(l&&d&&"string"===typeof l.stack){for(var e=l.stack.split("\n"),
f=d.stack.split("\n"),g=e.length-1,h=f.length-1;1<=g&&0<=h&&e[g]!==f[h];)h--;for(;1<=g&&0<=h;g--,h--)if(e[g]!==f[h]){if(1!==g||1!==h){do if(g--,h--,0>h||e[g]!==f[h]){var k="\n"+e[g].replace(" at new "," at ");a.displayName&&k.includes("<anonymous>")&&(k=k.replace("<anonymous>",a.displayName));return k}while(1<=g&&0<=h)}break}}}finally{Na=!1,Error.prepareStackTrace=c}return(a=a?a.displayName||a.name:"")?Ma(a):""}
function Pa(a){switch(a.tag){case 5:return Ma(a.type);case 16:return Ma("Lazy");case 13:return Ma("Suspense");case 19:return Ma("SuspenseList");case 0:case 2:case 15:return a=Oa(a.type,!1),a;case 11:return a=Oa(a.type.render,!1),a;case 1:return a=Oa(a.type,!0),a;default:return""}}
function Qa(a){if(null==a)return null;if("function"===typeof a)return a.displayName||a.name||null;if("string"===typeof a)return a;switch(a){case ya:return"Fragment";case wa:return"Portal";case Aa:return"Profiler";case za:return"StrictMode";case Ea:return"Suspense";case Fa:return"SuspenseList"}if("object"===typeof a)switch(a.$$typeof){case Ca:return(a.displayName||"Context")+".Consumer";case Ba:return(a._context.displayName||"Context")+".Provider";case Da:var b=a.render;a=a.displayName;a||(a=b.displayName||
b.name||"",a=""!==a?"ForwardRef("+a+")":"ForwardRef");return a;case Ga:return b=a.displayName||null,null!==b?b:Qa(a.type)||"Memo";case Ha:b=a._payload;a=a._init;try{return Qa(a(b))}catch(c){}}return null}
function Ra(a){var b=a.type;switch(a.tag){case 24:return"Cache";case 9:return(b.displayName||"Context")+".Consumer";case 10:return(b._context.displayName||"Context")+".Provider";case 18:return"DehydratedFragment";case 11:return a=b.render,a=a.displayName||a.name||"",b.displayName||(""!==a?"ForwardRef("+a+")":"ForwardRef");case 7:return"Fragment";case 5:return b;case 4:return"Portal";case 3:return"Root";case 6:return"Text";case 16:return Qa(b);case 8:return b===za?"StrictMode":"Mode";case 22:return"Offscreen";
case 12:return"Profiler";case 21:return"Scope";case 13:return"Suspense";case 19:return"SuspenseList";case 25:return"TracingMarker";case 1:case 0:case 17:case 2:case 14:case 15:if("function"===typeof b)return b.displayName||b.name||null;if("string"===typeof b)return b}return null}function Sa(a){switch(typeof a){case "boolean":case "number":case "string":case "undefined":return a;case "object":return a;default:return""}}
function Ta(a){var b=a.type;return(a=a.nodeName)&&"input"===a.toLowerCase()&&("checkbox"===b||"radio"===b)}
function Ua(a){var b=Ta(a)?"checked":"value",c=Object.getOwnPropertyDescriptor(a.constructor.prototype,b),d=""+a[b];if(!a.hasOwnProperty(b)&&"undefined"!==typeof c&&"function"===typeof c.get&&"function"===typeof c.set){var e=c.get,f=c.set;Object.defineProperty(a,b,{configurable:!0,get:function(){return e.call(this)},set:function(a){d=""+a;f.call(this,a)}});Object.defineProperty(a,b,{enumerable:c.enumerable});return{getValue:function(){return d},setValue:function(a){d=""+a},stopTracking:function(){a._valueTracker=
null;delete a[b]}}}}function Va(a){a._valueTracker||(a._valueTracker=Ua(a))}function Wa(a){if(!a)return!1;var b=a._valueTracker;if(!b)return!0;var c=b.getValue();var d="";a&&(d=Ta(a)?a.checked?"true":"false":a.value);a=d;return a!==c?(b.setValue(a),!0):!1}function Xa(a){a=a||("undefined"!==typeof document?document:void 0);if("undefined"===typeof a)return null;try{return a.activeElement||a.body}catch(b){return a.body}}
function Ya(a,b){var c=b.checked;return A({},b,{defaultChecked:void 0,defaultValue:void 0,value:void 0,checked:null!=c?c:a._wrapperState.initialChecked})}function Za(a,b){var c=null==b.defaultValue?"":b.defaultValue,d=null!=b.checked?b.checked:b.defaultChecked;c=Sa(null!=b.value?b.value:c);a._wrapperState={initialChecked:d,initialValue:c,controlled:"checkbox"===b.type||"radio"===b.type?null!=b.checked:null!=b.value}}function ab(a,b){b=b.checked;null!=b&&ta(a,"checked",b,!1)}
function bb(a,b){ab(a,b);var c=Sa(b.value),d=b.type;if(null!=c)if("number"===d){if(0===c&&""===a.value||a.value!=c)a.value=""+c}else a.value!==""+c&&(a.value=""+c);else if("submit"===d||"reset"===d){a.removeAttribute("value");return}b.hasOwnProperty("value")?cb(a,b.type,c):b.hasOwnProperty("defaultValue")&&cb(a,b.type,Sa(b.defaultValue));null==b.checked&&null!=b.defaultChecked&&(a.defaultChecked=!!b.defaultChecked)}
function db(a,b,c){if(b.hasOwnProperty("value")||b.hasOwnProperty("defaultValue")){var d=b.type;if(!("submit"!==d&&"reset"!==d||void 0!==b.value&&null!==b.value))return;b=""+a._wrapperState.initialValue;c||b===a.value||(a.value=b);a.defaultValue=b}c=a.name;""!==c&&(a.name="");a.defaultChecked=!!a._wrapperState.initialChecked;""!==c&&(a.name=c)}
function cb(a,b,c){if("number"!==b||Xa(a.ownerDocument)!==a)null==c?a.defaultValue=""+a._wrapperState.initialValue:a.defaultValue!==""+c&&(a.defaultValue=""+c)}var eb=Array.isArray;
function fb(a,b,c,d){a=a.options;if(b){b={};for(var e=0;e<c.length;e++)b["$"+c[e]]=!0;for(c=0;c<a.length;c++)e=b.hasOwnProperty("$"+a[c].value),a[c].selected!==e&&(a[c].selected=e),e&&d&&(a[c].defaultSelected=!0)}else{c=""+Sa(c);b=null;for(e=0;e<a.length;e++){if(a[e].value===c){a[e].selected=!0;d&&(a[e].defaultSelected=!0);return}null!==b||a[e].disabled||(b=a[e])}null!==b&&(b.selected=!0)}}
function gb(a,b){if(null!=b.dangerouslySetInnerHTML)throw Error(p(91));return A({},b,{value:void 0,defaultValue:void 0,children:""+a._wrapperState.initialValue})}function hb(a,b){var c=b.value;if(null==c){c=b.children;b=b.defaultValue;if(null!=c){if(null!=b)throw Error(p(92));if(eb(c)){if(1<c.length)throw Error(p(93));c=c[0]}b=c}null==b&&(b="");c=b}a._wrapperState={initialValue:Sa(c)}}
function ib(a,b){var c=Sa(b.value),d=Sa(b.defaultValue);null!=c&&(c=""+c,c!==a.value&&(a.value=c),null==b.defaultValue&&a.defaultValue!==c&&(a.defaultValue=c));null!=d&&(a.defaultValue=""+d)}function jb(a){var b=a.textContent;b===a._wrapperState.initialValue&&""!==b&&null!==b&&(a.value=b)}function kb(a){switch(a){case "svg":return"http://www.w3.org/2000/svg";case "math":return"http://www.w3.org/1998/Math/MathML";default:return"http://www.w3.org/1999/xhtml"}}
function lb(a,b){return null==a||"http://www.w3.org/1999/xhtml"===a?kb(b):"http://www.w3.org/2000/svg"===a&&"foreignObject"===b?"http://www.w3.org/1999/xhtml":a}
var mb,nb=function(a){return"undefined"!==typeof MSApp&&MSApp.execUnsafeLocalFunction?function(b,c,d,e){MSApp.execUnsafeLocalFunction(function(){return a(b,c,d,e)})}:a}(function(a,b){if("http://www.w3.org/2000/svg"!==a.namespaceURI||"innerHTML"in a)a.innerHTML=b;else{mb=mb||document.createElement("div");mb.innerHTML="<svg>"+b.valueOf().toString()+"</svg>";for(b=mb.firstChild;a.firstChild;)a.removeChild(a.firstChild);for(;b.firstChild;)a.appendChild(b.firstChild)}});
function ob(a,b){if(b){var c=a.firstChild;if(c&&c===a.lastChild&&3===c.nodeType){c.nodeValue=b;return}}a.textContent=b}
var pb={animationIterationCount:!0,aspectRatio:!0,borderImageOutset:!0,borderImageSlice:!0,borderImageWidth:!0,boxFlex:!0,boxFlexGroup:!0,boxOrdinalGroup:!0,columnCount:!0,columns:!0,flex:!0,flexGrow:!0,flexPositive:!0,flexShrink:!0,flexNegative:!0,flexOrder:!0,gridArea:!0,gridRow:!0,gridRowEnd:!0,gridRowSpan:!0,gridRowStart:!0,gridColumn:!0,gridColumnEnd:!0,gridColumnSpan:!0,gridColumnStart:!0,fontWeight:!0,lineClamp:!0,lineHeight:!0,opacity:!0,order:!0,orphans:!0,tabSize:!0,widows:!0,zIndex:!0,
zoom:!0,fillOpacity:!0,floodOpacity:!0,stopOpacity:!0,strokeDasharray:!0,strokeDashoffset:!0,strokeMiterlimit:!0,strokeOpacity:!0,strokeWidth:!0},qb=["Webkit","ms","Moz","O"];Object.keys(pb).forEach(function(a){qb.forEach(function(b){b=b+a.charAt(0).toUpperCase()+a.substring(1);pb[b]=pb[a]})});function rb(a,b,c){return null==b||"boolean"===typeof b||""===b?"":c||"number"!==typeof b||0===b||pb.hasOwnProperty(a)&&pb[a]?(""+b).trim():b+"px"}
function sb(a,b){a=a.style;for(var c in b)if(b.hasOwnProperty(c)){var d=0===c.indexOf("--"),e=rb(c,b[c],d);"float"===c&&(c="cssFloat");d?a.setProperty(c,e):a[c]=e}}var tb=A({menuitem:!0},{area:!0,base:!0,br:!0,col:!0,embed:!0,hr:!0,img:!0,input:!0,keygen:!0,link:!0,meta:!0,param:!0,source:!0,track:!0,wbr:!0});
function ub(a,b){if(b){if(tb[a]&&(null!=b.children||null!=b.dangerouslySetInnerHTML))throw Error(p(137,a));if(null!=b.dangerouslySetInnerHTML){if(null!=b.children)throw Error(p(60));if("object"!==typeof b.dangerouslySetInnerHTML||!("__html"in b.dangerouslySetInnerHTML))throw Error(p(61));}if(null!=b.style&&"object"!==typeof b.style)throw Error(p(62));}}
function vb(a,b){if(-1===a.indexOf("-"))return"string"===typeof b.is;switch(a){case "annotation-xml":case "color-profile":case "font-face":case "font-face-src":case "font-face-uri":case "font-face-format":case "font-face-name":case "missing-glyph":return!1;default:return!0}}var wb=null;function xb(a){a=a.target||a.srcElement||window;a.correspondingUseElement&&(a=a.correspondingUseElement);return 3===a.nodeType?a.parentNode:a}var yb=null,zb=null,Ab=null;
function Bb(a){if(a=Cb(a)){if("function"!==typeof yb)throw Error(p(280));var b=a.stateNode;b&&(b=Db(b),yb(a.stateNode,a.type,b))}}function Eb(a){zb?Ab?Ab.push(a):Ab=[a]:zb=a}function Fb(){if(zb){var a=zb,b=Ab;Ab=zb=null;Bb(a);if(b)for(a=0;a<b.length;a++)Bb(b[a])}}function Gb(a,b){return a(b)}function Hb(){}var Ib=!1;function Jb(a,b,c){if(Ib)return a(b,c);Ib=!0;try{return Gb(a,b,c)}finally{if(Ib=!1,null!==zb||null!==Ab)Hb(),Fb()}}
function Kb(a,b){var c=a.stateNode;if(null===c)return null;var d=Db(c);if(null===d)return null;c=d[b];a:switch(b){case "onClick":case "onClickCapture":case "onDoubleClick":case "onDoubleClickCapture":case "onMouseDown":case "onMouseDownCapture":case "onMouseMove":case "onMouseMoveCapture":case "onMouseUp":case "onMouseUpCapture":case "onMouseEnter":(d=!d.disabled)||(a=a.type,d=!("button"===a||"input"===a||"select"===a||"textarea"===a));a=!d;break a;default:a=!1}if(a)return null;if(c&&"function"!==
typeof c)throw Error(p(231,b,typeof c));return c}var Lb=!1;if(ia)try{var Mb={};Object.defineProperty(Mb,"passive",{get:function(){Lb=!0}});window.addEventListener("test",Mb,Mb);window.removeEventListener("test",Mb,Mb)}catch(a){Lb=!1}function Nb(a,b,c,d,e,f,g,h,k){var l=Array.prototype.slice.call(arguments,3);try{b.apply(c,l)}catch(m){this.onError(m)}}var Ob=!1,Pb=null,Qb=!1,Rb=null,Sb={onError:function(a){Ob=!0;Pb=a}};function Tb(a,b,c,d,e,f,g,h,k){Ob=!1;Pb=null;Nb.apply(Sb,arguments)}
function Ub(a,b,c,d,e,f,g,h,k){Tb.apply(this,arguments);if(Ob){if(Ob){var l=Pb;Ob=!1;Pb=null}else throw Error(p(198));Qb||(Qb=!0,Rb=l)}}function Vb(a){var b=a,c=a;if(a.alternate)for(;b.return;)b=b.return;else{a=b;do b=a,0!==(b.flags&4098)&&(c=b.return),a=b.return;while(a)}return 3===b.tag?c:null}function Wb(a){if(13===a.tag){var b=a.memoizedState;null===b&&(a=a.alternate,null!==a&&(b=a.memoizedState));if(null!==b)return b.dehydrated}return null}function Xb(a){if(Vb(a)!==a)throw Error(p(188));}
function Yb(a){var b=a.alternate;if(!b){b=Vb(a);if(null===b)throw Error(p(188));return b!==a?null:a}for(var c=a,d=b;;){var e=c.return;if(null===e)break;var f=e.alternate;if(null===f){d=e.return;if(null!==d){c=d;continue}break}if(e.child===f.child){for(f=e.child;f;){if(f===c)return Xb(e),a;if(f===d)return Xb(e),b;f=f.sibling}throw Error(p(188));}if(c.return!==d.return)c=e,d=f;else{for(var g=!1,h=e.child;h;){if(h===c){g=!0;c=e;d=f;break}if(h===d){g=!0;d=e;c=f;break}h=h.sibling}if(!g){for(h=f.child;h;){if(h===
c){g=!0;c=f;d=e;break}if(h===d){g=!0;d=f;c=e;break}h=h.sibling}if(!g)throw Error(p(189));}}if(c.alternate!==d)throw Error(p(190));}if(3!==c.tag)throw Error(p(188));return c.stateNode.current===c?a:b}function Zb(a){a=Yb(a);return null!==a?$b(a):null}function $b(a){if(5===a.tag||6===a.tag)return a;for(a=a.child;null!==a;){var b=$b(a);if(null!==b)return b;a=a.sibling}return null}
var ac=ca.unstable_scheduleCallback,bc=ca.unstable_cancelCallback,cc=ca.unstable_shouldYield,dc=ca.unstable_requestPaint,B=ca.unstable_now,ec=ca.unstable_getCurrentPriorityLevel,fc=ca.unstable_ImmediatePriority,gc=ca.unstable_UserBlockingPriority,hc=ca.unstable_NormalPriority,ic=ca.unstable_LowPriority,jc=ca.unstable_IdlePriority,kc=null,lc=null;function mc(a){if(lc&&"function"===typeof lc.onCommitFiberRoot)try{lc.onCommitFiberRoot(kc,a,void 0,128===(a.current.flags&128))}catch(b){}}
var oc=Math.clz32?Math.clz32:nc,pc=Math.log,qc=Math.LN2;function nc(a){a>>>=0;return 0===a?32:31-(pc(a)/qc|0)|0}var rc=64,sc=4194304;
function tc(a){switch(a&-a){case 1:return 1;case 2:return 2;case 4:return 4;case 8:return 8;case 16:return 16;case 32:return 32;case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:return a&4194240;case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:return a&130023424;case 134217728:return 134217728;case 268435456:return 268435456;case 536870912:return 536870912;case 1073741824:return 1073741824;
default:return a}}function uc(a,b){var c=a.pendingLanes;if(0===c)return 0;var d=0,e=a.suspendedLanes,f=a.pingedLanes,g=c&268435455;if(0!==g){var h=g&~e;0!==h?d=tc(h):(f&=g,0!==f&&(d=tc(f)))}else g=c&~e,0!==g?d=tc(g):0!==f&&(d=tc(f));if(0===d)return 0;if(0!==b&&b!==d&&0===(b&e)&&(e=d&-d,f=b&-b,e>=f||16===e&&0!==(f&4194240)))return b;0!==(d&4)&&(d|=c&16);b=a.entangledLanes;if(0!==b)for(a=a.entanglements,b&=d;0<b;)c=31-oc(b),e=1<<c,d|=a[c],b&=~e;return d}
function vc(a,b){switch(a){case 1:case 2:case 4:return b+250;case 8:case 16:case 32:case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:return b+5E3;case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:return-1;case 134217728:case 268435456:case 536870912:case 1073741824:return-1;default:return-1}}
function wc(a,b){for(var c=a.suspendedLanes,d=a.pingedLanes,e=a.expirationTimes,f=a.pendingLanes;0<f;){var g=31-oc(f),h=1<<g,k=e[g];if(-1===k){if(0===(h&c)||0!==(h&d))e[g]=vc(h,b)}else k<=b&&(a.expiredLanes|=h);f&=~h}}function xc(a){a=a.pendingLanes&-1073741825;return 0!==a?a:a&1073741824?1073741824:0}function yc(){var a=rc;rc<<=1;0===(rc&4194240)&&(rc=64);return a}function zc(a){for(var b=[],c=0;31>c;c++)b.push(a);return b}
function Ac(a,b,c){a.pendingLanes|=b;536870912!==b&&(a.suspendedLanes=0,a.pingedLanes=0);a=a.eventTimes;b=31-oc(b);a[b]=c}function Bc(a,b){var c=a.pendingLanes&~b;a.pendingLanes=b;a.suspendedLanes=0;a.pingedLanes=0;a.expiredLanes&=b;a.mutableReadLanes&=b;a.entangledLanes&=b;b=a.entanglements;var d=a.eventTimes;for(a=a.expirationTimes;0<c;){var e=31-oc(c),f=1<<e;b[e]=0;d[e]=-1;a[e]=-1;c&=~f}}
function Cc(a,b){var c=a.entangledLanes|=b;for(a=a.entanglements;c;){var d=31-oc(c),e=1<<d;e&b|a[d]&b&&(a[d]|=b);c&=~e}}var C=0;function Dc(a){a&=-a;return 1<a?4<a?0!==(a&268435455)?16:536870912:4:1}var Ec,Fc,Gc,Hc,Ic,Jc=!1,Kc=[],Lc=null,Mc=null,Nc=null,Oc=new Map,Pc=new Map,Qc=[],Rc="mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset submit".split(" ");
function Sc(a,b){switch(a){case "focusin":case "focusout":Lc=null;break;case "dragenter":case "dragleave":Mc=null;break;case "mouseover":case "mouseout":Nc=null;break;case "pointerover":case "pointerout":Oc.delete(b.pointerId);break;case "gotpointercapture":case "lostpointercapture":Pc.delete(b.pointerId)}}
function Tc(a,b,c,d,e,f){if(null===a||a.nativeEvent!==f)return a={blockedOn:b,domEventName:c,eventSystemFlags:d,nativeEvent:f,targetContainers:[e]},null!==b&&(b=Cb(b),null!==b&&Fc(b)),a;a.eventSystemFlags|=d;b=a.targetContainers;null!==e&&-1===b.indexOf(e)&&b.push(e);return a}
function Uc(a,b,c,d,e){switch(b){case "focusin":return Lc=Tc(Lc,a,b,c,d,e),!0;case "dragenter":return Mc=Tc(Mc,a,b,c,d,e),!0;case "mouseover":return Nc=Tc(Nc,a,b,c,d,e),!0;case "pointerover":var f=e.pointerId;Oc.set(f,Tc(Oc.get(f)||null,a,b,c,d,e));return!0;case "gotpointercapture":return f=e.pointerId,Pc.set(f,Tc(Pc.get(f)||null,a,b,c,d,e)),!0}return!1}
function Vc(a){var b=Wc(a.target);if(null!==b){var c=Vb(b);if(null!==c)if(b=c.tag,13===b){if(b=Wb(c),null!==b){a.blockedOn=b;Ic(a.priority,function(){Gc(c)});return}}else if(3===b&&c.stateNode.current.memoizedState.isDehydrated){a.blockedOn=3===c.tag?c.stateNode.containerInfo:null;return}}a.blockedOn=null}
function Xc(a){if(null!==a.blockedOn)return!1;for(var b=a.targetContainers;0<b.length;){var c=Yc(a.domEventName,a.eventSystemFlags,b[0],a.nativeEvent);if(null===c){c=a.nativeEvent;var d=new c.constructor(c.type,c);wb=d;c.target.dispatchEvent(d);wb=null}else return b=Cb(c),null!==b&&Fc(b),a.blockedOn=c,!1;b.shift()}return!0}function Zc(a,b,c){Xc(a)&&c.delete(b)}function $c(){Jc=!1;null!==Lc&&Xc(Lc)&&(Lc=null);null!==Mc&&Xc(Mc)&&(Mc=null);null!==Nc&&Xc(Nc)&&(Nc=null);Oc.forEach(Zc);Pc.forEach(Zc)}
function ad(a,b){a.blockedOn===b&&(a.blockedOn=null,Jc||(Jc=!0,ca.unstable_scheduleCallback(ca.unstable_NormalPriority,$c)))}
function bd(a){function b(b){return ad(b,a)}if(0<Kc.length){ad(Kc[0],a);for(var c=1;c<Kc.length;c++){var d=Kc[c];d.blockedOn===a&&(d.blockedOn=null)}}null!==Lc&&ad(Lc,a);null!==Mc&&ad(Mc,a);null!==Nc&&ad(Nc,a);Oc.forEach(b);Pc.forEach(b);for(c=0;c<Qc.length;c++)d=Qc[c],d.blockedOn===a&&(d.blockedOn=null);for(;0<Qc.length&&(c=Qc[0],null===c.blockedOn);)Vc(c),null===c.blockedOn&&Qc.shift()}var cd=ua.ReactCurrentBatchConfig,dd=!0;
function ed(a,b,c,d){var e=C,f=cd.transition;cd.transition=null;try{C=1,fd(a,b,c,d)}finally{C=e,cd.transition=f}}function gd(a,b,c,d){var e=C,f=cd.transition;cd.transition=null;try{C=4,fd(a,b,c,d)}finally{C=e,cd.transition=f}}
function fd(a,b,c,d){if(dd){var e=Yc(a,b,c,d);if(null===e)hd(a,b,d,id,c),Sc(a,d);else if(Uc(e,a,b,c,d))d.stopPropagation();else if(Sc(a,d),b&4&&-1<Rc.indexOf(a)){for(;null!==e;){var f=Cb(e);null!==f&&Ec(f);f=Yc(a,b,c,d);null===f&&hd(a,b,d,id,c);if(f===e)break;e=f}null!==e&&d.stopPropagation()}else hd(a,b,d,null,c)}}var id=null;
function Yc(a,b,c,d){id=null;a=xb(d);a=Wc(a);if(null!==a)if(b=Vb(a),null===b)a=null;else if(c=b.tag,13===c){a=Wb(b);if(null!==a)return a;a=null}else if(3===c){if(b.stateNode.current.memoizedState.isDehydrated)return 3===b.tag?b.stateNode.containerInfo:null;a=null}else b!==a&&(a=null);id=a;return null}
function jd(a){switch(a){case "cancel":case "click":case "close":case "contextmenu":case "copy":case "cut":case "auxclick":case "dblclick":case "dragend":case "dragstart":case "drop":case "focusin":case "focusout":case "input":case "invalid":case "keydown":case "keypress":case "keyup":case "mousedown":case "mouseup":case "paste":case "pause":case "play":case "pointercancel":case "pointerdown":case "pointerup":case "ratechange":case "reset":case "resize":case "seeked":case "submit":case "touchcancel":case "touchend":case "touchstart":case "volumechange":case "change":case "selectionchange":case "textInput":case "compositionstart":case "compositionend":case "compositionupdate":case "beforeblur":case "afterblur":case "beforeinput":case "blur":case "fullscreenchange":case "focus":case "hashchange":case "popstate":case "select":case "selectstart":return 1;case "drag":case "dragenter":case "dragexit":case "dragleave":case "dragover":case "mousemove":case "mouseout":case "mouseover":case "pointermove":case "pointerout":case "pointerover":case "scroll":case "toggle":case "touchmove":case "wheel":case "mouseenter":case "mouseleave":case "pointerenter":case "pointerleave":return 4;
case "message":switch(ec()){case fc:return 1;case gc:return 4;case hc:case ic:return 16;case jc:return 536870912;default:return 16}default:return 16}}var kd=null,ld=null,md=null;function nd(){if(md)return md;var a,b=ld,c=b.length,d,e="value"in kd?kd.value:kd.textContent,f=e.length;for(a=0;a<c&&b[a]===e[a];a++);var g=c-a;for(d=1;d<=g&&b[c-d]===e[f-d];d++);return md=e.slice(a,1<d?1-d:void 0)}
function od(a){var b=a.keyCode;"charCode"in a?(a=a.charCode,0===a&&13===b&&(a=13)):a=b;10===a&&(a=13);return 32<=a||13===a?a:0}function pd(){return!0}function qd(){return!1}
function rd(a){function b(b,d,e,f,g){this._reactName=b;this._targetInst=e;this.type=d;this.nativeEvent=f;this.target=g;this.currentTarget=null;for(var c in a)a.hasOwnProperty(c)&&(b=a[c],this[c]=b?b(f):f[c]);this.isDefaultPrevented=(null!=f.defaultPrevented?f.defaultPrevented:!1===f.returnValue)?pd:qd;this.isPropagationStopped=qd;return this}A(b.prototype,{preventDefault:function(){this.defaultPrevented=!0;var a=this.nativeEvent;a&&(a.preventDefault?a.preventDefault():"unknown"!==typeof a.returnValue&&
(a.returnValue=!1),this.isDefaultPrevented=pd)},stopPropagation:function(){var a=this.nativeEvent;a&&(a.stopPropagation?a.stopPropagation():"unknown"!==typeof a.cancelBubble&&(a.cancelBubble=!0),this.isPropagationStopped=pd)},persist:function(){},isPersistent:pd});return b}
var sd={eventPhase:0,bubbles:0,cancelable:0,timeStamp:function(a){return a.timeStamp||Date.now()},defaultPrevented:0,isTrusted:0},td=rd(sd),ud=A({},sd,{view:0,detail:0}),vd=rd(ud),wd,xd,yd,Ad=A({},ud,{screenX:0,screenY:0,clientX:0,clientY:0,pageX:0,pageY:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,getModifierState:zd,button:0,buttons:0,relatedTarget:function(a){return void 0===a.relatedTarget?a.fromElement===a.srcElement?a.toElement:a.fromElement:a.relatedTarget},movementX:function(a){if("movementX"in
a)return a.movementX;a!==yd&&(yd&&"mousemove"===a.type?(wd=a.screenX-yd.screenX,xd=a.screenY-yd.screenY):xd=wd=0,yd=a);return wd},movementY:function(a){return"movementY"in a?a.movementY:xd}}),Bd=rd(Ad),Cd=A({},Ad,{dataTransfer:0}),Dd=rd(Cd),Ed=A({},ud,{relatedTarget:0}),Fd=rd(Ed),Gd=A({},sd,{animationName:0,elapsedTime:0,pseudoElement:0}),Hd=rd(Gd),Id=A({},sd,{clipboardData:function(a){return"clipboardData"in a?a.clipboardData:window.clipboardData}}),Jd=rd(Id),Kd=A({},sd,{data:0}),Ld=rd(Kd),Md={Esc:"Escape",
Spacebar:" ",Left:"ArrowLeft",Up:"ArrowUp",Right:"ArrowRight",Down:"ArrowDown",Del:"Delete",Win:"OS",Menu:"ContextMenu",Apps:"ContextMenu",Scroll:"ScrollLock",MozPrintableKey:"Unidentified"},Nd={8:"Backspace",9:"Tab",12:"Clear",13:"Enter",16:"Shift",17:"Control",18:"Alt",19:"Pause",20:"CapsLock",27:"Escape",32:" ",33:"PageUp",34:"PageDown",35:"End",36:"Home",37:"ArrowLeft",38:"ArrowUp",39:"ArrowRight",40:"ArrowDown",45:"Insert",46:"Delete",112:"F1",113:"F2",114:"F3",115:"F4",116:"F5",117:"F6",118:"F7",
119:"F8",120:"F9",121:"F10",122:"F11",123:"F12",144:"NumLock",145:"ScrollLock",224:"Meta"},Od={Alt:"altKey",Control:"ctrlKey",Meta:"metaKey",Shift:"shiftKey"};function Pd(a){var b=this.nativeEvent;return b.getModifierState?b.getModifierState(a):(a=Od[a])?!!b[a]:!1}function zd(){return Pd}
var Qd=A({},ud,{key:function(a){if(a.key){var b=Md[a.key]||a.key;if("Unidentified"!==b)return b}return"keypress"===a.type?(a=od(a),13===a?"Enter":String.fromCharCode(a)):"keydown"===a.type||"keyup"===a.type?Nd[a.keyCode]||"Unidentified":""},code:0,location:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,repeat:0,locale:0,getModifierState:zd,charCode:function(a){return"keypress"===a.type?od(a):0},keyCode:function(a){return"keydown"===a.type||"keyup"===a.type?a.keyCode:0},which:function(a){return"keypress"===
a.type?od(a):"keydown"===a.type||"keyup"===a.type?a.keyCode:0}}),Rd=rd(Qd),Sd=A({},Ad,{pointerId:0,width:0,height:0,pressure:0,tangentialPressure:0,tiltX:0,tiltY:0,twist:0,pointerType:0,isPrimary:0}),Td=rd(Sd),Ud=A({},ud,{touches:0,targetTouches:0,changedTouches:0,altKey:0,metaKey:0,ctrlKey:0,shiftKey:0,getModifierState:zd}),Vd=rd(Ud),Wd=A({},sd,{propertyName:0,elapsedTime:0,pseudoElement:0}),Xd=rd(Wd),Yd=A({},Ad,{deltaX:function(a){return"deltaX"in a?a.deltaX:"wheelDeltaX"in a?-a.wheelDeltaX:0},
deltaY:function(a){return"deltaY"in a?a.deltaY:"wheelDeltaY"in a?-a.wheelDeltaY:"wheelDelta"in a?-a.wheelDelta:0},deltaZ:0,deltaMode:0}),Zd=rd(Yd),$d=[9,13,27,32],ae=ia&&"CompositionEvent"in window,be=null;ia&&"documentMode"in document&&(be=document.documentMode);var ce=ia&&"TextEvent"in window&&!be,de=ia&&(!ae||be&&8<be&&11>=be),ee=String.fromCharCode(32),fe=!1;
function ge(a,b){switch(a){case "keyup":return-1!==$d.indexOf(b.keyCode);case "keydown":return 229!==b.keyCode;case "keypress":case "mousedown":case "focusout":return!0;default:return!1}}function he(a){a=a.detail;return"object"===typeof a&&"data"in a?a.data:null}var ie=!1;function je(a,b){switch(a){case "compositionend":return he(b);case "keypress":if(32!==b.which)return null;fe=!0;return ee;case "textInput":return a=b.data,a===ee&&fe?null:a;default:return null}}
function ke(a,b){if(ie)return"compositionend"===a||!ae&&ge(a,b)?(a=nd(),md=ld=kd=null,ie=!1,a):null;switch(a){case "paste":return null;case "keypress":if(!(b.ctrlKey||b.altKey||b.metaKey)||b.ctrlKey&&b.altKey){if(b.char&&1<b.char.length)return b.char;if(b.which)return String.fromCharCode(b.which)}return null;case "compositionend":return de&&"ko"!==b.locale?null:b.data;default:return null}}
var le={color:!0,date:!0,datetime:!0,"datetime-local":!0,email:!0,month:!0,number:!0,password:!0,range:!0,search:!0,tel:!0,text:!0,time:!0,url:!0,week:!0};function me(a){var b=a&&a.nodeName&&a.nodeName.toLowerCase();return"input"===b?!!le[a.type]:"textarea"===b?!0:!1}function ne(a,b,c,d){Eb(d);b=oe(b,"onChange");0<b.length&&(c=new td("onChange","change",null,c,d),a.push({event:c,listeners:b}))}var pe=null,qe=null;function re(a){se(a,0)}function te(a){var b=ue(a);if(Wa(b))return a}
function ve(a,b){if("change"===a)return b}var we=!1;if(ia){var xe;if(ia){var ye="oninput"in document;if(!ye){var ze=document.createElement("div");ze.setAttribute("oninput","return;");ye="function"===typeof ze.oninput}xe=ye}else xe=!1;we=xe&&(!document.documentMode||9<document.documentMode)}function Ae(){pe&&(pe.detachEvent("onpropertychange",Be),qe=pe=null)}function Be(a){if("value"===a.propertyName&&te(qe)){var b=[];ne(b,qe,a,xb(a));Jb(re,b)}}
function Ce(a,b,c){"focusin"===a?(Ae(),pe=b,qe=c,pe.attachEvent("onpropertychange",Be)):"focusout"===a&&Ae()}function De(a){if("selectionchange"===a||"keyup"===a||"keydown"===a)return te(qe)}function Ee(a,b){if("click"===a)return te(b)}function Fe(a,b){if("input"===a||"change"===a)return te(b)}function Ge(a,b){return a===b&&(0!==a||1/a===1/b)||a!==a&&b!==b}var He="function"===typeof Object.is?Object.is:Ge;
function Ie(a,b){if(He(a,b))return!0;if("object"!==typeof a||null===a||"object"!==typeof b||null===b)return!1;var c=Object.keys(a),d=Object.keys(b);if(c.length!==d.length)return!1;for(d=0;d<c.length;d++){var e=c[d];if(!ja.call(b,e)||!He(a[e],b[e]))return!1}return!0}function Je(a){for(;a&&a.firstChild;)a=a.firstChild;return a}
function Ke(a,b){var c=Je(a);a=0;for(var d;c;){if(3===c.nodeType){d=a+c.textContent.length;if(a<=b&&d>=b)return{node:c,offset:b-a};a=d}a:{for(;c;){if(c.nextSibling){c=c.nextSibling;break a}c=c.parentNode}c=void 0}c=Je(c)}}function Le(a,b){return a&&b?a===b?!0:a&&3===a.nodeType?!1:b&&3===b.nodeType?Le(a,b.parentNode):"contains"in a?a.contains(b):a.compareDocumentPosition?!!(a.compareDocumentPosition(b)&16):!1:!1}
function Me(){for(var a=window,b=Xa();b instanceof a.HTMLIFrameElement;){try{var c="string"===typeof b.contentWindow.location.href}catch(d){c=!1}if(c)a=b.contentWindow;else break;b=Xa(a.document)}return b}function Ne(a){var b=a&&a.nodeName&&a.nodeName.toLowerCase();return b&&("input"===b&&("text"===a.type||"search"===a.type||"tel"===a.type||"url"===a.type||"password"===a.type)||"textarea"===b||"true"===a.contentEditable)}
function Oe(a){var b=Me(),c=a.focusedElem,d=a.selectionRange;if(b!==c&&c&&c.ownerDocument&&Le(c.ownerDocument.documentElement,c)){if(null!==d&&Ne(c))if(b=d.start,a=d.end,void 0===a&&(a=b),"selectionStart"in c)c.selectionStart=b,c.selectionEnd=Math.min(a,c.value.length);else if(a=(b=c.ownerDocument||document)&&b.defaultView||window,a.getSelection){a=a.getSelection();var e=c.textContent.length,f=Math.min(d.start,e);d=void 0===d.end?f:Math.min(d.end,e);!a.extend&&f>d&&(e=d,d=f,f=e);e=Ke(c,f);var g=Ke(c,
d);e&&g&&(1!==a.rangeCount||a.anchorNode!==e.node||a.anchorOffset!==e.offset||a.focusNode!==g.node||a.focusOffset!==g.offset)&&(b=b.createRange(),b.setStart(e.node,e.offset),a.removeAllRanges(),f>d?(a.addRange(b),a.extend(g.node,g.offset)):(b.setEnd(g.node,g.offset),a.addRange(b)))}b=[];for(a=c;a=a.parentNode;)1===a.nodeType&&b.push({element:a,left:a.scrollLeft,top:a.scrollTop});"function"===typeof c.focus&&c.focus();for(c=0;c<b.length;c++)a=b[c],a.element.scrollLeft=a.left,a.element.scrollTop=a.top}}
var Pe=ia&&"documentMode"in document&&11>=document.documentMode,Qe=null,Re=null,Se=null,Te=!1;
function Ue(a,b,c){var d=c.window===c?c.document:9===c.nodeType?c:c.ownerDocument;Te||null==Qe||Qe!==Xa(d)||(d=Qe,"selectionStart"in d&&Ne(d)?d={start:d.selectionStart,end:d.selectionEnd}:(d=(d.ownerDocument&&d.ownerDocument.defaultView||window).getSelection(),d={anchorNode:d.anchorNode,anchorOffset:d.anchorOffset,focusNode:d.focusNode,focusOffset:d.focusOffset}),Se&&Ie(Se,d)||(Se=d,d=oe(Re,"onSelect"),0<d.length&&(b=new td("onSelect","select",null,b,c),a.push({event:b,listeners:d}),b.target=Qe)))}
function Ve(a,b){var c={};c[a.toLowerCase()]=b.toLowerCase();c["Webkit"+a]="webkit"+b;c["Moz"+a]="moz"+b;return c}var We={animationend:Ve("Animation","AnimationEnd"),animationiteration:Ve("Animation","AnimationIteration"),animationstart:Ve("Animation","AnimationStart"),transitionend:Ve("Transition","TransitionEnd")},Xe={},Ye={};
ia&&(Ye=document.createElement("div").style,"AnimationEvent"in window||(delete We.animationend.animation,delete We.animationiteration.animation,delete We.animationstart.animation),"TransitionEvent"in window||delete We.transitionend.transition);function Ze(a){if(Xe[a])return Xe[a];if(!We[a])return a;var b=We[a],c;for(c in b)if(b.hasOwnProperty(c)&&c in Ye)return Xe[a]=b[c];return a}var $e=Ze("animationend"),af=Ze("animationiteration"),bf=Ze("animationstart"),cf=Ze("transitionend"),df=new Map,ef="abort auxClick cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(" ");
function ff(a,b){df.set(a,b);fa(b,[a])}for(var gf=0;gf<ef.length;gf++){var hf=ef[gf],jf=hf.toLowerCase(),kf=hf[0].toUpperCase()+hf.slice(1);ff(jf,"on"+kf)}ff($e,"onAnimationEnd");ff(af,"onAnimationIteration");ff(bf,"onAnimationStart");ff("dblclick","onDoubleClick");ff("focusin","onFocus");ff("focusout","onBlur");ff(cf,"onTransitionEnd");ha("onMouseEnter",["mouseout","mouseover"]);ha("onMouseLeave",["mouseout","mouseover"]);ha("onPointerEnter",["pointerout","pointerover"]);
ha("onPointerLeave",["pointerout","pointerover"]);fa("onChange","change click focusin focusout input keydown keyup selectionchange".split(" "));fa("onSelect","focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(" "));fa("onBeforeInput",["compositionend","keypress","textInput","paste"]);fa("onCompositionEnd","compositionend focusout keydown keypress keyup mousedown".split(" "));fa("onCompositionStart","compositionstart focusout keydown keypress keyup mousedown".split(" "));
fa("onCompositionUpdate","compositionupdate focusout keydown keypress keyup mousedown".split(" "));var lf="abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(" "),mf=new Set("cancel close invalid load scroll toggle".split(" ").concat(lf));
function nf(a,b,c){var d=a.type||"unknown-event";a.currentTarget=c;Ub(d,b,void 0,a);a.currentTarget=null}
function se(a,b){b=0!==(b&4);for(var c=0;c<a.length;c++){var d=a[c],e=d.event;d=d.listeners;a:{var f=void 0;if(b)for(var g=d.length-1;0<=g;g--){var h=d[g],k=h.instance,l=h.currentTarget;h=h.listener;if(k!==f&&e.isPropagationStopped())break a;nf(e,h,l);f=k}else for(g=0;g<d.length;g++){h=d[g];k=h.instance;l=h.currentTarget;h=h.listener;if(k!==f&&e.isPropagationStopped())break a;nf(e,h,l);f=k}}}if(Qb)throw a=Rb,Qb=!1,Rb=null,a;}
function D(a,b){var c=b[of];void 0===c&&(c=b[of]=new Set);var d=a+"__bubble";c.has(d)||(pf(b,a,2,!1),c.add(d))}function qf(a,b,c){var d=0;b&&(d|=4);pf(c,a,d,b)}var rf="_reactListening"+Math.random().toString(36).slice(2);function sf(a){if(!a[rf]){a[rf]=!0;da.forEach(function(b){"selectionchange"!==b&&(mf.has(b)||qf(b,!1,a),qf(b,!0,a))});var b=9===a.nodeType?a:a.ownerDocument;null===b||b[rf]||(b[rf]=!0,qf("selectionchange",!1,b))}}
function pf(a,b,c,d){switch(jd(b)){case 1:var e=ed;break;case 4:e=gd;break;default:e=fd}c=e.bind(null,b,c,a);e=void 0;!Lb||"touchstart"!==b&&"touchmove"!==b&&"wheel"!==b||(e=!0);d?void 0!==e?a.addEventListener(b,c,{capture:!0,passive:e}):a.addEventListener(b,c,!0):void 0!==e?a.addEventListener(b,c,{passive:e}):a.addEventListener(b,c,!1)}
function hd(a,b,c,d,e){var f=d;if(0===(b&1)&&0===(b&2)&&null!==d)a:for(;;){if(null===d)return;var g=d.tag;if(3===g||4===g){var h=d.stateNode.containerInfo;if(h===e||8===h.nodeType&&h.parentNode===e)break;if(4===g)for(g=d.return;null!==g;){var k=g.tag;if(3===k||4===k)if(k=g.stateNode.containerInfo,k===e||8===k.nodeType&&k.parentNode===e)return;g=g.return}for(;null!==h;){g=Wc(h);if(null===g)return;k=g.tag;if(5===k||6===k){d=f=g;continue a}h=h.parentNode}}d=d.return}Jb(function(){var d=f,e=xb(c),g=[];
a:{var h=df.get(a);if(void 0!==h){var k=td,n=a;switch(a){case "keypress":if(0===od(c))break a;case "keydown":case "keyup":k=Rd;break;case "focusin":n="focus";k=Fd;break;case "focusout":n="blur";k=Fd;break;case "beforeblur":case "afterblur":k=Fd;break;case "click":if(2===c.button)break a;case "auxclick":case "dblclick":case "mousedown":case "mousemove":case "mouseup":case "mouseout":case "mouseover":case "contextmenu":k=Bd;break;case "drag":case "dragend":case "dragenter":case "dragexit":case "dragleave":case "dragover":case "dragstart":case "drop":k=
Dd;break;case "touchcancel":case "touchend":case "touchmove":case "touchstart":k=Vd;break;case $e:case af:case bf:k=Hd;break;case cf:k=Xd;break;case "scroll":k=vd;break;case "wheel":k=Zd;break;case "copy":case "cut":case "paste":k=Jd;break;case "gotpointercapture":case "lostpointercapture":case "pointercancel":case "pointerdown":case "pointermove":case "pointerout":case "pointerover":case "pointerup":k=Td}var t=0!==(b&4),J=!t&&"scroll"===a,x=t?null!==h?h+"Capture":null:h;t=[];for(var w=d,u;null!==
w;){u=w;var F=u.stateNode;5===u.tag&&null!==F&&(u=F,null!==x&&(F=Kb(w,x),null!=F&&t.push(tf(w,F,u))));if(J)break;w=w.return}0<t.length&&(h=new k(h,n,null,c,e),g.push({event:h,listeners:t}))}}if(0===(b&7)){a:{h="mouseover"===a||"pointerover"===a;k="mouseout"===a||"pointerout"===a;if(h&&c!==wb&&(n=c.relatedTarget||c.fromElement)&&(Wc(n)||n[uf]))break a;if(k||h){h=e.window===e?e:(h=e.ownerDocument)?h.defaultView||h.parentWindow:window;if(k){if(n=c.relatedTarget||c.toElement,k=d,n=n?Wc(n):null,null!==
n&&(J=Vb(n),n!==J||5!==n.tag&&6!==n.tag))n=null}else k=null,n=d;if(k!==n){t=Bd;F="onMouseLeave";x="onMouseEnter";w="mouse";if("pointerout"===a||"pointerover"===a)t=Td,F="onPointerLeave",x="onPointerEnter",w="pointer";J=null==k?h:ue(k);u=null==n?h:ue(n);h=new t(F,w+"leave",k,c,e);h.target=J;h.relatedTarget=u;F=null;Wc(e)===d&&(t=new t(x,w+"enter",n,c,e),t.target=u,t.relatedTarget=J,F=t);J=F;if(k&&n)b:{t=k;x=n;w=0;for(u=t;u;u=vf(u))w++;u=0;for(F=x;F;F=vf(F))u++;for(;0<w-u;)t=vf(t),w--;for(;0<u-w;)x=
vf(x),u--;for(;w--;){if(t===x||null!==x&&t===x.alternate)break b;t=vf(t);x=vf(x)}t=null}else t=null;null!==k&&wf(g,h,k,t,!1);null!==n&&null!==J&&wf(g,J,n,t,!0)}}}a:{h=d?ue(d):window;k=h.nodeName&&h.nodeName.toLowerCase();if("select"===k||"input"===k&&"file"===h.type)var na=ve;else if(me(h))if(we)na=Fe;else{na=De;var xa=Ce}else(k=h.nodeName)&&"input"===k.toLowerCase()&&("checkbox"===h.type||"radio"===h.type)&&(na=Ee);if(na&&(na=na(a,d))){ne(g,na,c,e);break a}xa&&xa(a,h,d);"focusout"===a&&(xa=h._wrapperState)&&
xa.controlled&&"number"===h.type&&cb(h,"number",h.value)}xa=d?ue(d):window;switch(a){case "focusin":if(me(xa)||"true"===xa.contentEditable)Qe=xa,Re=d,Se=null;break;case "focusout":Se=Re=Qe=null;break;case "mousedown":Te=!0;break;case "contextmenu":case "mouseup":case "dragend":Te=!1;Ue(g,c,e);break;case "selectionchange":if(Pe)break;case "keydown":case "keyup":Ue(g,c,e)}var $a;if(ae)b:{switch(a){case "compositionstart":var ba="onCompositionStart";break b;case "compositionend":ba="onCompositionEnd";
break b;case "compositionupdate":ba="onCompositionUpdate";break b}ba=void 0}else ie?ge(a,c)&&(ba="onCompositionEnd"):"keydown"===a&&229===c.keyCode&&(ba="onCompositionStart");ba&&(de&&"ko"!==c.locale&&(ie||"onCompositionStart"!==ba?"onCompositionEnd"===ba&&ie&&($a=nd()):(kd=e,ld="value"in kd?kd.value:kd.textContent,ie=!0)),xa=oe(d,ba),0<xa.length&&(ba=new Ld(ba,a,null,c,e),g.push({event:ba,listeners:xa}),$a?ba.data=$a:($a=he(c),null!==$a&&(ba.data=$a))));if($a=ce?je(a,c):ke(a,c))d=oe(d,"onBeforeInput"),
0<d.length&&(e=new Ld("onBeforeInput","beforeinput",null,c,e),g.push({event:e,listeners:d}),e.data=$a)}se(g,b)})}function tf(a,b,c){return{instance:a,listener:b,currentTarget:c}}function oe(a,b){for(var c=b+"Capture",d=[];null!==a;){var e=a,f=e.stateNode;5===e.tag&&null!==f&&(e=f,f=Kb(a,c),null!=f&&d.unshift(tf(a,f,e)),f=Kb(a,b),null!=f&&d.push(tf(a,f,e)));a=a.return}return d}function vf(a){if(null===a)return null;do a=a.return;while(a&&5!==a.tag);return a?a:null}
function wf(a,b,c,d,e){for(var f=b._reactName,g=[];null!==c&&c!==d;){var h=c,k=h.alternate,l=h.stateNode;if(null!==k&&k===d)break;5===h.tag&&null!==l&&(h=l,e?(k=Kb(c,f),null!=k&&g.unshift(tf(c,k,h))):e||(k=Kb(c,f),null!=k&&g.push(tf(c,k,h))));c=c.return}0!==g.length&&a.push({event:b,listeners:g})}var xf=/\r\n?/g,yf=/\u0000|\uFFFD/g;function zf(a){return("string"===typeof a?a:""+a).replace(xf,"\n").replace(yf,"")}function Af(a,b,c){b=zf(b);if(zf(a)!==b&&c)throw Error(p(425));}function Bf(){}
var Cf=null,Df=null;function Ef(a,b){return"textarea"===a||"noscript"===a||"string"===typeof b.children||"number"===typeof b.children||"object"===typeof b.dangerouslySetInnerHTML&&null!==b.dangerouslySetInnerHTML&&null!=b.dangerouslySetInnerHTML.__html}
var Ff="function"===typeof setTimeout?setTimeout:void 0,Gf="function"===typeof clearTimeout?clearTimeout:void 0,Hf="function"===typeof Promise?Promise:void 0,Jf="function"===typeof queueMicrotask?queueMicrotask:"undefined"!==typeof Hf?function(a){return Hf.resolve(null).then(a).catch(If)}:Ff;function If(a){setTimeout(function(){throw a;})}
function Kf(a,b){var c=b,d=0;do{var e=c.nextSibling;a.removeChild(c);if(e&&8===e.nodeType)if(c=e.data,"/$"===c){if(0===d){a.removeChild(e);bd(b);return}d--}else"$"!==c&&"$?"!==c&&"$!"!==c||d++;c=e}while(c);bd(b)}function Lf(a){for(;null!=a;a=a.nextSibling){var b=a.nodeType;if(1===b||3===b)break;if(8===b){b=a.data;if("$"===b||"$!"===b||"$?"===b)break;if("/$"===b)return null}}return a}
function Mf(a){a=a.previousSibling;for(var b=0;a;){if(8===a.nodeType){var c=a.data;if("$"===c||"$!"===c||"$?"===c){if(0===b)return a;b--}else"/$"===c&&b++}a=a.previousSibling}return null}var Nf=Math.random().toString(36).slice(2),Of="__reactFiber$"+Nf,Pf="__reactProps$"+Nf,uf="__reactContainer$"+Nf,of="__reactEvents$"+Nf,Qf="__reactListeners$"+Nf,Rf="__reactHandles$"+Nf;
function Wc(a){var b=a[Of];if(b)return b;for(var c=a.parentNode;c;){if(b=c[uf]||c[Of]){c=b.alternate;if(null!==b.child||null!==c&&null!==c.child)for(a=Mf(a);null!==a;){if(c=a[Of])return c;a=Mf(a)}return b}a=c;c=a.parentNode}return null}function Cb(a){a=a[Of]||a[uf];return!a||5!==a.tag&&6!==a.tag&&13!==a.tag&&3!==a.tag?null:a}function ue(a){if(5===a.tag||6===a.tag)return a.stateNode;throw Error(p(33));}function Db(a){return a[Pf]||null}var Sf=[],Tf=-1;function Uf(a){return{current:a}}
function E(a){0>Tf||(a.current=Sf[Tf],Sf[Tf]=null,Tf--)}function G(a,b){Tf++;Sf[Tf]=a.current;a.current=b}var Vf={},H=Uf(Vf),Wf=Uf(!1),Xf=Vf;function Yf(a,b){var c=a.type.contextTypes;if(!c)return Vf;var d=a.stateNode;if(d&&d.__reactInternalMemoizedUnmaskedChildContext===b)return d.__reactInternalMemoizedMaskedChildContext;var e={},f;for(f in c)e[f]=b[f];d&&(a=a.stateNode,a.__reactInternalMemoizedUnmaskedChildContext=b,a.__reactInternalMemoizedMaskedChildContext=e);return e}
function Zf(a){a=a.childContextTypes;return null!==a&&void 0!==a}function $f(){E(Wf);E(H)}function ag(a,b,c){if(H.current!==Vf)throw Error(p(168));G(H,b);G(Wf,c)}function bg(a,b,c){var d=a.stateNode;b=b.childContextTypes;if("function"!==typeof d.getChildContext)return c;d=d.getChildContext();for(var e in d)if(!(e in b))throw Error(p(108,Ra(a)||"Unknown",e));return A({},c,d)}
function cg(a){a=(a=a.stateNode)&&a.__reactInternalMemoizedMergedChildContext||Vf;Xf=H.current;G(H,a);G(Wf,Wf.current);return!0}function dg(a,b,c){var d=a.stateNode;if(!d)throw Error(p(169));c?(a=bg(a,b,Xf),d.__reactInternalMemoizedMergedChildContext=a,E(Wf),E(H),G(H,a)):E(Wf);G(Wf,c)}var eg=null,fg=!1,gg=!1;function hg(a){null===eg?eg=[a]:eg.push(a)}function ig(a){fg=!0;hg(a)}
function jg(){if(!gg&&null!==eg){gg=!0;var a=0,b=C;try{var c=eg;for(C=1;a<c.length;a++){var d=c[a];do d=d(!0);while(null!==d)}eg=null;fg=!1}catch(e){throw null!==eg&&(eg=eg.slice(a+1)),ac(fc,jg),e;}finally{C=b,gg=!1}}return null}var kg=[],lg=0,mg=null,ng=0,og=[],pg=0,qg=null,rg=1,sg="";function tg(a,b){kg[lg++]=ng;kg[lg++]=mg;mg=a;ng=b}
function ug(a,b,c){og[pg++]=rg;og[pg++]=sg;og[pg++]=qg;qg=a;var d=rg;a=sg;var e=32-oc(d)-1;d&=~(1<<e);c+=1;var f=32-oc(b)+e;if(30<f){var g=e-e%5;f=(d&(1<<g)-1).toString(32);d>>=g;e-=g;rg=1<<32-oc(b)+e|c<<e|d;sg=f+a}else rg=1<<f|c<<e|d,sg=a}function vg(a){null!==a.return&&(tg(a,1),ug(a,1,0))}function wg(a){for(;a===mg;)mg=kg[--lg],kg[lg]=null,ng=kg[--lg],kg[lg]=null;for(;a===qg;)qg=og[--pg],og[pg]=null,sg=og[--pg],og[pg]=null,rg=og[--pg],og[pg]=null}var xg=null,yg=null,I=!1,zg=null;
function Ag(a,b){var c=Bg(5,null,null,0);c.elementType="DELETED";c.stateNode=b;c.return=a;b=a.deletions;null===b?(a.deletions=[c],a.flags|=16):b.push(c)}
function Cg(a,b){switch(a.tag){case 5:var c=a.type;b=1!==b.nodeType||c.toLowerCase()!==b.nodeName.toLowerCase()?null:b;return null!==b?(a.stateNode=b,xg=a,yg=Lf(b.firstChild),!0):!1;case 6:return b=""===a.pendingProps||3!==b.nodeType?null:b,null!==b?(a.stateNode=b,xg=a,yg=null,!0):!1;case 13:return b=8!==b.nodeType?null:b,null!==b?(c=null!==qg?{id:rg,overflow:sg}:null,a.memoizedState={dehydrated:b,treeContext:c,retryLane:1073741824},c=Bg(18,null,null,0),c.stateNode=b,c.return=a,a.child=c,xg=a,yg=
null,!0):!1;default:return!1}}function Dg(a){return 0!==(a.mode&1)&&0===(a.flags&128)}function Eg(a){if(I){var b=yg;if(b){var c=b;if(!Cg(a,b)){if(Dg(a))throw Error(p(418));b=Lf(c.nextSibling);var d=xg;b&&Cg(a,b)?Ag(d,c):(a.flags=a.flags&-4097|2,I=!1,xg=a)}}else{if(Dg(a))throw Error(p(418));a.flags=a.flags&-4097|2;I=!1;xg=a}}}function Fg(a){for(a=a.return;null!==a&&5!==a.tag&&3!==a.tag&&13!==a.tag;)a=a.return;xg=a}
function Gg(a){if(a!==xg)return!1;if(!I)return Fg(a),I=!0,!1;var b;(b=3!==a.tag)&&!(b=5!==a.tag)&&(b=a.type,b="head"!==b&&"body"!==b&&!Ef(a.type,a.memoizedProps));if(b&&(b=yg)){if(Dg(a))throw Hg(),Error(p(418));for(;b;)Ag(a,b),b=Lf(b.nextSibling)}Fg(a);if(13===a.tag){a=a.memoizedState;a=null!==a?a.dehydrated:null;if(!a)throw Error(p(317));a:{a=a.nextSibling;for(b=0;a;){if(8===a.nodeType){var c=a.data;if("/$"===c){if(0===b){yg=Lf(a.nextSibling);break a}b--}else"$"!==c&&"$!"!==c&&"$?"!==c||b++}a=a.nextSibling}yg=
null}}else yg=xg?Lf(a.stateNode.nextSibling):null;return!0}function Hg(){for(var a=yg;a;)a=Lf(a.nextSibling)}function Ig(){yg=xg=null;I=!1}function Jg(a){null===zg?zg=[a]:zg.push(a)}var Kg=ua.ReactCurrentBatchConfig;function Lg(a,b){if(a&&a.defaultProps){b=A({},b);a=a.defaultProps;for(var c in a)void 0===b[c]&&(b[c]=a[c]);return b}return b}var Mg=Uf(null),Ng=null,Og=null,Pg=null;function Qg(){Pg=Og=Ng=null}function Rg(a){var b=Mg.current;E(Mg);a._currentValue=b}
function Sg(a,b,c){for(;null!==a;){var d=a.alternate;(a.childLanes&b)!==b?(a.childLanes|=b,null!==d&&(d.childLanes|=b)):null!==d&&(d.childLanes&b)!==b&&(d.childLanes|=b);if(a===c)break;a=a.return}}function Tg(a,b){Ng=a;Pg=Og=null;a=a.dependencies;null!==a&&null!==a.firstContext&&(0!==(a.lanes&b)&&(Ug=!0),a.firstContext=null)}
function Vg(a){var b=a._currentValue;if(Pg!==a)if(a={context:a,memoizedValue:b,next:null},null===Og){if(null===Ng)throw Error(p(308));Og=a;Ng.dependencies={lanes:0,firstContext:a}}else Og=Og.next=a;return b}var Wg=null;function Xg(a){null===Wg?Wg=[a]:Wg.push(a)}function Yg(a,b,c,d){var e=b.interleaved;null===e?(c.next=c,Xg(b)):(c.next=e.next,e.next=c);b.interleaved=c;return Zg(a,d)}
function Zg(a,b){a.lanes|=b;var c=a.alternate;null!==c&&(c.lanes|=b);c=a;for(a=a.return;null!==a;)a.childLanes|=b,c=a.alternate,null!==c&&(c.childLanes|=b),c=a,a=a.return;return 3===c.tag?c.stateNode:null}var $g=!1;function ah(a){a.updateQueue={baseState:a.memoizedState,firstBaseUpdate:null,lastBaseUpdate:null,shared:{pending:null,interleaved:null,lanes:0},effects:null}}
function bh(a,b){a=a.updateQueue;b.updateQueue===a&&(b.updateQueue={baseState:a.baseState,firstBaseUpdate:a.firstBaseUpdate,lastBaseUpdate:a.lastBaseUpdate,shared:a.shared,effects:a.effects})}function ch(a,b){return{eventTime:a,lane:b,tag:0,payload:null,callback:null,next:null}}
function dh(a,b,c){var d=a.updateQueue;if(null===d)return null;d=d.shared;if(0!==(K&2)){var e=d.pending;null===e?b.next=b:(b.next=e.next,e.next=b);d.pending=b;return Zg(a,c)}e=d.interleaved;null===e?(b.next=b,Xg(d)):(b.next=e.next,e.next=b);d.interleaved=b;return Zg(a,c)}function eh(a,b,c){b=b.updateQueue;if(null!==b&&(b=b.shared,0!==(c&4194240))){var d=b.lanes;d&=a.pendingLanes;c|=d;b.lanes=c;Cc(a,c)}}
function fh(a,b){var c=a.updateQueue,d=a.alternate;if(null!==d&&(d=d.updateQueue,c===d)){var e=null,f=null;c=c.firstBaseUpdate;if(null!==c){do{var g={eventTime:c.eventTime,lane:c.lane,tag:c.tag,payload:c.payload,callback:c.callback,next:null};null===f?e=f=g:f=f.next=g;c=c.next}while(null!==c);null===f?e=f=b:f=f.next=b}else e=f=b;c={baseState:d.baseState,firstBaseUpdate:e,lastBaseUpdate:f,shared:d.shared,effects:d.effects};a.updateQueue=c;return}a=c.lastBaseUpdate;null===a?c.firstBaseUpdate=b:a.next=
b;c.lastBaseUpdate=b}
function gh(a,b,c,d){var e=a.updateQueue;$g=!1;var f=e.firstBaseUpdate,g=e.lastBaseUpdate,h=e.shared.pending;if(null!==h){e.shared.pending=null;var k=h,l=k.next;k.next=null;null===g?f=l:g.next=l;g=k;var m=a.alternate;null!==m&&(m=m.updateQueue,h=m.lastBaseUpdate,h!==g&&(null===h?m.firstBaseUpdate=l:h.next=l,m.lastBaseUpdate=k))}if(null!==f){var q=e.baseState;g=0;m=l=k=null;h=f;do{var r=h.lane,y=h.eventTime;if((d&r)===r){null!==m&&(m=m.next={eventTime:y,lane:0,tag:h.tag,payload:h.payload,callback:h.callback,
next:null});a:{var n=a,t=h;r=b;y=c;switch(t.tag){case 1:n=t.payload;if("function"===typeof n){q=n.call(y,q,r);break a}q=n;break a;case 3:n.flags=n.flags&-65537|128;case 0:n=t.payload;r="function"===typeof n?n.call(y,q,r):n;if(null===r||void 0===r)break a;q=A({},q,r);break a;case 2:$g=!0}}null!==h.callback&&0!==h.lane&&(a.flags|=64,r=e.effects,null===r?e.effects=[h]:r.push(h))}else y={eventTime:y,lane:r,tag:h.tag,payload:h.payload,callback:h.callback,next:null},null===m?(l=m=y,k=q):m=m.next=y,g|=r;
h=h.next;if(null===h)if(h=e.shared.pending,null===h)break;else r=h,h=r.next,r.next=null,e.lastBaseUpdate=r,e.shared.pending=null}while(1);null===m&&(k=q);e.baseState=k;e.firstBaseUpdate=l;e.lastBaseUpdate=m;b=e.shared.interleaved;if(null!==b){e=b;do g|=e.lane,e=e.next;while(e!==b)}else null===f&&(e.shared.lanes=0);hh|=g;a.lanes=g;a.memoizedState=q}}
function ih(a,b,c){a=b.effects;b.effects=null;if(null!==a)for(b=0;b<a.length;b++){var d=a[b],e=d.callback;if(null!==e){d.callback=null;d=c;if("function"!==typeof e)throw Error(p(191,e));e.call(d)}}}var jh=(new aa.Component).refs;function kh(a,b,c,d){b=a.memoizedState;c=c(d,b);c=null===c||void 0===c?b:A({},b,c);a.memoizedState=c;0===a.lanes&&(a.updateQueue.baseState=c)}
var nh={isMounted:function(a){return(a=a._reactInternals)?Vb(a)===a:!1},enqueueSetState:function(a,b,c){a=a._reactInternals;var d=L(),e=lh(a),f=ch(d,e);f.payload=b;void 0!==c&&null!==c&&(f.callback=c);b=dh(a,f,e);null!==b&&(mh(b,a,e,d),eh(b,a,e))},enqueueReplaceState:function(a,b,c){a=a._reactInternals;var d=L(),e=lh(a),f=ch(d,e);f.tag=1;f.payload=b;void 0!==c&&null!==c&&(f.callback=c);b=dh(a,f,e);null!==b&&(mh(b,a,e,d),eh(b,a,e))},enqueueForceUpdate:function(a,b){a=a._reactInternals;var c=L(),d=
lh(a),e=ch(c,d);e.tag=2;void 0!==b&&null!==b&&(e.callback=b);b=dh(a,e,d);null!==b&&(mh(b,a,d,c),eh(b,a,d))}};function oh(a,b,c,d,e,f,g){a=a.stateNode;return"function"===typeof a.shouldComponentUpdate?a.shouldComponentUpdate(d,f,g):b.prototype&&b.prototype.isPureReactComponent?!Ie(c,d)||!Ie(e,f):!0}
function ph(a,b,c){var d=!1,e=Vf;var f=b.contextType;"object"===typeof f&&null!==f?f=Vg(f):(e=Zf(b)?Xf:H.current,d=b.contextTypes,f=(d=null!==d&&void 0!==d)?Yf(a,e):Vf);b=new b(c,f);a.memoizedState=null!==b.state&&void 0!==b.state?b.state:null;b.updater=nh;a.stateNode=b;b._reactInternals=a;d&&(a=a.stateNode,a.__reactInternalMemoizedUnmaskedChildContext=e,a.__reactInternalMemoizedMaskedChildContext=f);return b}
function qh(a,b,c,d){a=b.state;"function"===typeof b.componentWillReceiveProps&&b.componentWillReceiveProps(c,d);"function"===typeof b.UNSAFE_componentWillReceiveProps&&b.UNSAFE_componentWillReceiveProps(c,d);b.state!==a&&nh.enqueueReplaceState(b,b.state,null)}
function rh(a,b,c,d){var e=a.stateNode;e.props=c;e.state=a.memoizedState;e.refs=jh;ah(a);var f=b.contextType;"object"===typeof f&&null!==f?e.context=Vg(f):(f=Zf(b)?Xf:H.current,e.context=Yf(a,f));e.state=a.memoizedState;f=b.getDerivedStateFromProps;"function"===typeof f&&(kh(a,b,f,c),e.state=a.memoizedState);"function"===typeof b.getDerivedStateFromProps||"function"===typeof e.getSnapshotBeforeUpdate||"function"!==typeof e.UNSAFE_componentWillMount&&"function"!==typeof e.componentWillMount||(b=e.state,
"function"===typeof e.componentWillMount&&e.componentWillMount(),"function"===typeof e.UNSAFE_componentWillMount&&e.UNSAFE_componentWillMount(),b!==e.state&&nh.enqueueReplaceState(e,e.state,null),gh(a,c,e,d),e.state=a.memoizedState);"function"===typeof e.componentDidMount&&(a.flags|=4194308)}
function sh(a,b,c){a=c.ref;if(null!==a&&"function"!==typeof a&&"object"!==typeof a){if(c._owner){c=c._owner;if(c){if(1!==c.tag)throw Error(p(309));var d=c.stateNode}if(!d)throw Error(p(147,a));var e=d,f=""+a;if(null!==b&&null!==b.ref&&"function"===typeof b.ref&&b.ref._stringRef===f)return b.ref;b=function(a){var b=e.refs;b===jh&&(b=e.refs={});null===a?delete b[f]:b[f]=a};b._stringRef=f;return b}if("string"!==typeof a)throw Error(p(284));if(!c._owner)throw Error(p(290,a));}return a}
function th(a,b){a=Object.prototype.toString.call(b);throw Error(p(31,"[object Object]"===a?"object with keys {"+Object.keys(b).join(", ")+"}":a));}function uh(a){var b=a._init;return b(a._payload)}
function vh(a){function b(b,c){if(a){var d=b.deletions;null===d?(b.deletions=[c],b.flags|=16):d.push(c)}}function c(c,d){if(!a)return null;for(;null!==d;)b(c,d),d=d.sibling;return null}function d(a,b){for(a=new Map;null!==b;)null!==b.key?a.set(b.key,b):a.set(b.index,b),b=b.sibling;return a}function e(a,b){a=wh(a,b);a.index=0;a.sibling=null;return a}function f(b,c,d){b.index=d;if(!a)return b.flags|=1048576,c;d=b.alternate;if(null!==d)return d=d.index,d<c?(b.flags|=2,c):d;b.flags|=2;return c}function g(b){a&&
null===b.alternate&&(b.flags|=2);return b}function h(a,b,c,d){if(null===b||6!==b.tag)return b=xh(c,a.mode,d),b.return=a,b;b=e(b,c);b.return=a;return b}function k(a,b,c,d){var f=c.type;if(f===ya)return m(a,b,c.props.children,d,c.key);if(null!==b&&(b.elementType===f||"object"===typeof f&&null!==f&&f.$$typeof===Ha&&uh(f)===b.type))return d=e(b,c.props),d.ref=sh(a,b,c),d.return=a,d;d=yh(c.type,c.key,c.props,null,a.mode,d);d.ref=sh(a,b,c);d.return=a;return d}function l(a,b,c,d){if(null===b||4!==b.tag||
b.stateNode.containerInfo!==c.containerInfo||b.stateNode.implementation!==c.implementation)return b=zh(c,a.mode,d),b.return=a,b;b=e(b,c.children||[]);b.return=a;return b}function m(a,b,c,d,f){if(null===b||7!==b.tag)return b=Ah(c,a.mode,d,f),b.return=a,b;b=e(b,c);b.return=a;return b}function q(a,b,c){if("string"===typeof b&&""!==b||"number"===typeof b)return b=xh(""+b,a.mode,c),b.return=a,b;if("object"===typeof b&&null!==b){switch(b.$$typeof){case va:return c=yh(b.type,b.key,b.props,null,a.mode,c),
c.ref=sh(a,null,b),c.return=a,c;case wa:return b=zh(b,a.mode,c),b.return=a,b;case Ha:var d=b._init;return q(a,d(b._payload),c)}if(eb(b)||Ka(b))return b=Ah(b,a.mode,c,null),b.return=a,b;th(a,b)}return null}function r(a,b,c,d){var e=null!==b?b.key:null;if("string"===typeof c&&""!==c||"number"===typeof c)return null!==e?null:h(a,b,""+c,d);if("object"===typeof c&&null!==c){switch(c.$$typeof){case va:return c.key===e?k(a,b,c,d):null;case wa:return c.key===e?l(a,b,c,d):null;case Ha:return e=c._init,r(a,
b,e(c._payload),d)}if(eb(c)||Ka(c))return null!==e?null:m(a,b,c,d,null);th(a,c)}return null}function y(a,b,c,d,e){if("string"===typeof d&&""!==d||"number"===typeof d)return a=a.get(c)||null,h(b,a,""+d,e);if("object"===typeof d&&null!==d){switch(d.$$typeof){case va:return a=a.get(null===d.key?c:d.key)||null,k(b,a,d,e);case wa:return a=a.get(null===d.key?c:d.key)||null,l(b,a,d,e);case Ha:var f=d._init;return y(a,b,c,f(d._payload),e)}if(eb(d)||Ka(d))return a=a.get(c)||null,m(b,a,d,e,null);th(b,d)}return null}
function n(e,g,h,k){for(var l=null,m=null,u=g,w=g=0,x=null;null!==u&&w<h.length;w++){u.index>w?(x=u,u=null):x=u.sibling;var n=r(e,u,h[w],k);if(null===n){null===u&&(u=x);break}a&&u&&null===n.alternate&&b(e,u);g=f(n,g,w);null===m?l=n:m.sibling=n;m=n;u=x}if(w===h.length)return c(e,u),I&&tg(e,w),l;if(null===u){for(;w<h.length;w++)u=q(e,h[w],k),null!==u&&(g=f(u,g,w),null===m?l=u:m.sibling=u,m=u);I&&tg(e,w);return l}for(u=d(e,u);w<h.length;w++)x=y(u,e,w,h[w],k),null!==x&&(a&&null!==x.alternate&&u.delete(null===
x.key?w:x.key),g=f(x,g,w),null===m?l=x:m.sibling=x,m=x);a&&u.forEach(function(a){return b(e,a)});I&&tg(e,w);return l}function t(e,g,h,k){var l=Ka(h);if("function"!==typeof l)throw Error(p(150));h=l.call(h);if(null==h)throw Error(p(151));for(var u=l=null,m=g,w=g=0,x=null,n=h.next();null!==m&&!n.done;w++,n=h.next()){m.index>w?(x=m,m=null):x=m.sibling;var t=r(e,m,n.value,k);if(null===t){null===m&&(m=x);break}a&&m&&null===t.alternate&&b(e,m);g=f(t,g,w);null===u?l=t:u.sibling=t;u=t;m=x}if(n.done)return c(e,
m),I&&tg(e,w),l;if(null===m){for(;!n.done;w++,n=h.next())n=q(e,n.value,k),null!==n&&(g=f(n,g,w),null===u?l=n:u.sibling=n,u=n);I&&tg(e,w);return l}for(m=d(e,m);!n.done;w++,n=h.next())n=y(m,e,w,n.value,k),null!==n&&(a&&null!==n.alternate&&m.delete(null===n.key?w:n.key),g=f(n,g,w),null===u?l=n:u.sibling=n,u=n);a&&m.forEach(function(a){return b(e,a)});I&&tg(e,w);return l}function J(a,d,f,h){"object"===typeof f&&null!==f&&f.type===ya&&null===f.key&&(f=f.props.children);if("object"===typeof f&&null!==f){switch(f.$$typeof){case va:a:{for(var k=
f.key,l=d;null!==l;){if(l.key===k){k=f.type;if(k===ya){if(7===l.tag){c(a,l.sibling);d=e(l,f.props.children);d.return=a;a=d;break a}}else if(l.elementType===k||"object"===typeof k&&null!==k&&k.$$typeof===Ha&&uh(k)===l.type){c(a,l.sibling);d=e(l,f.props);d.ref=sh(a,l,f);d.return=a;a=d;break a}c(a,l);break}else b(a,l);l=l.sibling}f.type===ya?(d=Ah(f.props.children,a.mode,h,f.key),d.return=a,a=d):(h=yh(f.type,f.key,f.props,null,a.mode,h),h.ref=sh(a,d,f),h.return=a,a=h)}return g(a);case wa:a:{for(l=f.key;null!==
d;){if(d.key===l)if(4===d.tag&&d.stateNode.containerInfo===f.containerInfo&&d.stateNode.implementation===f.implementation){c(a,d.sibling);d=e(d,f.children||[]);d.return=a;a=d;break a}else{c(a,d);break}else b(a,d);d=d.sibling}d=zh(f,a.mode,h);d.return=a;a=d}return g(a);case Ha:return l=f._init,J(a,d,l(f._payload),h)}if(eb(f))return n(a,d,f,h);if(Ka(f))return t(a,d,f,h);th(a,f)}return"string"===typeof f&&""!==f||"number"===typeof f?(f=""+f,null!==d&&6===d.tag?(c(a,d.sibling),d=e(d,f),d.return=a,a=d):
(c(a,d),d=xh(f,a.mode,h),d.return=a,a=d),g(a)):c(a,d)}return J}var Bh=vh(!0),Ch=vh(!1),Dh={},Eh=Uf(Dh),Fh=Uf(Dh),Gh=Uf(Dh);function Hh(a){if(a===Dh)throw Error(p(174));return a}function Ih(a,b){G(Gh,b);G(Fh,a);G(Eh,Dh);a=b.nodeType;switch(a){case 9:case 11:b=(b=b.documentElement)?b.namespaceURI:lb(null,"");break;default:a=8===a?b.parentNode:b,b=a.namespaceURI||null,a=a.tagName,b=lb(b,a)}E(Eh);G(Eh,b)}function Jh(){E(Eh);E(Fh);E(Gh)}
function Kh(a){Hh(Gh.current);var b=Hh(Eh.current);var c=lb(b,a.type);b!==c&&(G(Fh,a),G(Eh,c))}function Lh(a){Fh.current===a&&(E(Eh),E(Fh))}var M=Uf(0);
function Mh(a){for(var b=a;null!==b;){if(13===b.tag){var c=b.memoizedState;if(null!==c&&(c=c.dehydrated,null===c||"$?"===c.data||"$!"===c.data))return b}else if(19===b.tag&&void 0!==b.memoizedProps.revealOrder){if(0!==(b.flags&128))return b}else if(null!==b.child){b.child.return=b;b=b.child;continue}if(b===a)break;for(;null===b.sibling;){if(null===b.return||b.return===a)return null;b=b.return}b.sibling.return=b.return;b=b.sibling}return null}var Nh=[];
function Oh(){for(var a=0;a<Nh.length;a++)Nh[a]._workInProgressVersionPrimary=null;Nh.length=0}var Ph=ua.ReactCurrentDispatcher,Qh=ua.ReactCurrentBatchConfig,Rh=0,N=null,O=null,P=null,Sh=!1,Th=!1,Uh=0,Vh=0;function Q(){throw Error(p(321));}function Wh(a,b){if(null===b)return!1;for(var c=0;c<b.length&&c<a.length;c++)if(!He(a[c],b[c]))return!1;return!0}
function Xh(a,b,c,d,e,f){Rh=f;N=b;b.memoizedState=null;b.updateQueue=null;b.lanes=0;Ph.current=null===a||null===a.memoizedState?Yh:Zh;a=c(d,e);if(Th){f=0;do{Th=!1;Uh=0;if(25<=f)throw Error(p(301));f+=1;P=O=null;b.updateQueue=null;Ph.current=$h;a=c(d,e)}while(Th)}Ph.current=ai;b=null!==O&&null!==O.next;Rh=0;P=O=N=null;Sh=!1;if(b)throw Error(p(300));return a}function bi(){var a=0!==Uh;Uh=0;return a}
function ci(){var a={memoizedState:null,baseState:null,baseQueue:null,queue:null,next:null};null===P?N.memoizedState=P=a:P=P.next=a;return P}function di(){if(null===O){var a=N.alternate;a=null!==a?a.memoizedState:null}else a=O.next;var b=null===P?N.memoizedState:P.next;if(null!==b)P=b,O=a;else{if(null===a)throw Error(p(310));O=a;a={memoizedState:O.memoizedState,baseState:O.baseState,baseQueue:O.baseQueue,queue:O.queue,next:null};null===P?N.memoizedState=P=a:P=P.next=a}return P}
function ei(a,b){return"function"===typeof b?b(a):b}
function fi(a){var b=di(),c=b.queue;if(null===c)throw Error(p(311));c.lastRenderedReducer=a;var d=O,e=d.baseQueue,f=c.pending;if(null!==f){if(null!==e){var g=e.next;e.next=f.next;f.next=g}d.baseQueue=e=f;c.pending=null}if(null!==e){f=e.next;d=d.baseState;var h=g=null,k=null,l=f;do{var m=l.lane;if((Rh&m)===m)null!==k&&(k=k.next={lane:0,action:l.action,hasEagerState:l.hasEagerState,eagerState:l.eagerState,next:null}),d=l.hasEagerState?l.eagerState:a(d,l.action);else{var q={lane:m,action:l.action,hasEagerState:l.hasEagerState,
eagerState:l.eagerState,next:null};null===k?(h=k=q,g=d):k=k.next=q;N.lanes|=m;hh|=m}l=l.next}while(null!==l&&l!==f);null===k?g=d:k.next=h;He(d,b.memoizedState)||(Ug=!0);b.memoizedState=d;b.baseState=g;b.baseQueue=k;c.lastRenderedState=d}a=c.interleaved;if(null!==a){e=a;do f=e.lane,N.lanes|=f,hh|=f,e=e.next;while(e!==a)}else null===e&&(c.lanes=0);return[b.memoizedState,c.dispatch]}
function gi(a){var b=di(),c=b.queue;if(null===c)throw Error(p(311));c.lastRenderedReducer=a;var d=c.dispatch,e=c.pending,f=b.memoizedState;if(null!==e){c.pending=null;var g=e=e.next;do f=a(f,g.action),g=g.next;while(g!==e);He(f,b.memoizedState)||(Ug=!0);b.memoizedState=f;null===b.baseQueue&&(b.baseState=f);c.lastRenderedState=f}return[f,d]}function hi(){}
function ii(a,b){var c=N,d=di(),e=b(),f=!He(d.memoizedState,e);f&&(d.memoizedState=e,Ug=!0);d=d.queue;ji(ki.bind(null,c,d,a),[a]);if(d.getSnapshot!==b||f||null!==P&&P.memoizedState.tag&1){c.flags|=2048;li(9,mi.bind(null,c,d,e,b),void 0,null);if(null===R)throw Error(p(349));0!==(Rh&30)||ni(c,b,e)}return e}function ni(a,b,c){a.flags|=16384;a={getSnapshot:b,value:c};b=N.updateQueue;null===b?(b={lastEffect:null,stores:null},N.updateQueue=b,b.stores=[a]):(c=b.stores,null===c?b.stores=[a]:c.push(a))}
function mi(a,b,c,d){b.value=c;b.getSnapshot=d;oi(b)&&pi(a)}function ki(a,b,c){return c(function(){oi(b)&&pi(a)})}function oi(a){var b=a.getSnapshot;a=a.value;try{var c=b();return!He(a,c)}catch(d){return!0}}function pi(a){var b=Zg(a,1);null!==b&&mh(b,a,1,-1)}
function qi(a){var b=ci();"function"===typeof a&&(a=a());b.memoizedState=b.baseState=a;a={pending:null,interleaved:null,lanes:0,dispatch:null,lastRenderedReducer:ei,lastRenderedState:a};b.queue=a;a=a.dispatch=ri.bind(null,N,a);return[b.memoizedState,a]}
function li(a,b,c,d){a={tag:a,create:b,destroy:c,deps:d,next:null};b=N.updateQueue;null===b?(b={lastEffect:null,stores:null},N.updateQueue=b,b.lastEffect=a.next=a):(c=b.lastEffect,null===c?b.lastEffect=a.next=a:(d=c.next,c.next=a,a.next=d,b.lastEffect=a));return a}function si(){return di().memoizedState}function ti(a,b,c,d){var e=ci();N.flags|=a;e.memoizedState=li(1|b,c,void 0,void 0===d?null:d)}
function ui(a,b,c,d){var e=di();d=void 0===d?null:d;var f=void 0;if(null!==O){var g=O.memoizedState;f=g.destroy;if(null!==d&&Wh(d,g.deps)){e.memoizedState=li(b,c,f,d);return}}N.flags|=a;e.memoizedState=li(1|b,c,f,d)}function vi(a,b){return ti(8390656,8,a,b)}function ji(a,b){return ui(2048,8,a,b)}function wi(a,b){return ui(4,2,a,b)}function xi(a,b){return ui(4,4,a,b)}
function yi(a,b){if("function"===typeof b)return a=a(),b(a),function(){b(null)};if(null!==b&&void 0!==b)return a=a(),b.current=a,function(){b.current=null}}function zi(a,b,c){c=null!==c&&void 0!==c?c.concat([a]):null;return ui(4,4,yi.bind(null,b,a),c)}function Ai(){}function Bi(a,b){var c=di();b=void 0===b?null:b;var d=c.memoizedState;if(null!==d&&null!==b&&Wh(b,d[1]))return d[0];c.memoizedState=[a,b];return a}
function Ci(a,b){var c=di();b=void 0===b?null:b;var d=c.memoizedState;if(null!==d&&null!==b&&Wh(b,d[1]))return d[0];a=a();c.memoizedState=[a,b];return a}function Di(a,b,c){if(0===(Rh&21))return a.baseState&&(a.baseState=!1,Ug=!0),a.memoizedState=c;He(c,b)||(c=yc(),N.lanes|=c,hh|=c,a.baseState=!0);return b}function Ei(a,b){var c=C;C=0!==c&&4>c?c:4;a(!0);var d=Qh.transition;Qh.transition={};try{a(!1),b()}finally{C=c,Qh.transition=d}}function Fi(){return di().memoizedState}
function Gi(a,b,c){var d=lh(a);c={lane:d,action:c,hasEagerState:!1,eagerState:null,next:null};if(Hi(a))Ii(b,c);else if(c=Yg(a,b,c,d),null!==c){var e=L();mh(c,a,d,e);Ji(c,b,d)}}
function ri(a,b,c){var d=lh(a),e={lane:d,action:c,hasEagerState:!1,eagerState:null,next:null};if(Hi(a))Ii(b,e);else{var f=a.alternate;if(0===a.lanes&&(null===f||0===f.lanes)&&(f=b.lastRenderedReducer,null!==f))try{var g=b.lastRenderedState,h=f(g,c);e.hasEagerState=!0;e.eagerState=h;if(He(h,g)){var k=b.interleaved;null===k?(e.next=e,Xg(b)):(e.next=k.next,k.next=e);b.interleaved=e;return}}catch(l){}finally{}c=Yg(a,b,e,d);null!==c&&(e=L(),mh(c,a,d,e),Ji(c,b,d))}}
function Hi(a){var b=a.alternate;return a===N||null!==b&&b===N}function Ii(a,b){Th=Sh=!0;var c=a.pending;null===c?b.next=b:(b.next=c.next,c.next=b);a.pending=b}function Ji(a,b,c){if(0!==(c&4194240)){var d=b.lanes;d&=a.pendingLanes;c|=d;b.lanes=c;Cc(a,c)}}
var ai={readContext:Vg,useCallback:Q,useContext:Q,useEffect:Q,useImperativeHandle:Q,useInsertionEffect:Q,useLayoutEffect:Q,useMemo:Q,useReducer:Q,useRef:Q,useState:Q,useDebugValue:Q,useDeferredValue:Q,useTransition:Q,useMutableSource:Q,useSyncExternalStore:Q,useId:Q,unstable_isNewReconciler:!1},Yh={readContext:Vg,useCallback:function(a,b){ci().memoizedState=[a,void 0===b?null:b];return a},useContext:Vg,useEffect:vi,useImperativeHandle:function(a,b,c){c=null!==c&&void 0!==c?c.concat([a]):null;return ti(4194308,
4,yi.bind(null,b,a),c)},useLayoutEffect:function(a,b){return ti(4194308,4,a,b)},useInsertionEffect:function(a,b){return ti(4,2,a,b)},useMemo:function(a,b){var c=ci();b=void 0===b?null:b;a=a();c.memoizedState=[a,b];return a},useReducer:function(a,b,c){var d=ci();b=void 0!==c?c(b):b;d.memoizedState=d.baseState=b;a={pending:null,interleaved:null,lanes:0,dispatch:null,lastRenderedReducer:a,lastRenderedState:b};d.queue=a;a=a.dispatch=Gi.bind(null,N,a);return[d.memoizedState,a]},useRef:function(a){var b=
ci();a={current:a};return b.memoizedState=a},useState:qi,useDebugValue:Ai,useDeferredValue:function(a){return ci().memoizedState=a},useTransition:function(){var a=qi(!1),b=a[0];a=Ei.bind(null,a[1]);ci().memoizedState=a;return[b,a]},useMutableSource:function(){},useSyncExternalStore:function(a,b,c){var d=N,e=ci();if(I){if(void 0===c)throw Error(p(407));c=c()}else{c=b();if(null===R)throw Error(p(349));0!==(Rh&30)||ni(d,b,c)}e.memoizedState=c;var f={value:c,getSnapshot:b};e.queue=f;vi(ki.bind(null,d,
f,a),[a]);d.flags|=2048;li(9,mi.bind(null,d,f,c,b),void 0,null);return c},useId:function(){var a=ci(),b=R.identifierPrefix;if(I){var c=sg;var d=rg;c=(d&~(1<<32-oc(d)-1)).toString(32)+c;b=":"+b+"R"+c;c=Uh++;0<c&&(b+="H"+c.toString(32));b+=":"}else c=Vh++,b=":"+b+"r"+c.toString(32)+":";return a.memoizedState=b},unstable_isNewReconciler:!1},Zh={readContext:Vg,useCallback:Bi,useContext:Vg,useEffect:ji,useImperativeHandle:zi,useInsertionEffect:wi,useLayoutEffect:xi,useMemo:Ci,useReducer:fi,useRef:si,useState:function(){return fi(ei)},
useDebugValue:Ai,useDeferredValue:function(a){var b=di();return Di(b,O.memoizedState,a)},useTransition:function(){var a=fi(ei)[0],b=di().memoizedState;return[a,b]},useMutableSource:hi,useSyncExternalStore:ii,useId:Fi,unstable_isNewReconciler:!1},$h={readContext:Vg,useCallback:Bi,useContext:Vg,useEffect:ji,useImperativeHandle:zi,useInsertionEffect:wi,useLayoutEffect:xi,useMemo:Ci,useReducer:gi,useRef:si,useState:function(){return gi(ei)},useDebugValue:Ai,useDeferredValue:function(a){var b=di();return null===
O?b.memoizedState=a:Di(b,O.memoizedState,a)},useTransition:function(){var a=gi(ei)[0],b=di().memoizedState;return[a,b]},useMutableSource:hi,useSyncExternalStore:ii,useId:Fi,unstable_isNewReconciler:!1};function Ki(a,b){try{var c="",d=b;do c+=Pa(d),d=d.return;while(d);var e=c}catch(f){e="\nError generating stack: "+f.message+"\n"+f.stack}return{value:a,source:b,stack:e,digest:null}}function Li(a,b,c){return{value:a,source:null,stack:null!=c?c:null,digest:null!=b?b:null}}
function Mi(a,b){try{console.error(b.value)}catch(c){setTimeout(function(){throw c;})}}var Ni="function"===typeof WeakMap?WeakMap:Map;function Oi(a,b,c){c=ch(-1,c);c.tag=3;c.payload={element:null};var d=b.value;c.callback=function(){Pi||(Pi=!0,Qi=d);Mi(a,b)};return c}
function Ri(a,b,c){c=ch(-1,c);c.tag=3;var d=a.type.getDerivedStateFromError;if("function"===typeof d){var e=b.value;c.payload=function(){return d(e)};c.callback=function(){Mi(a,b)}}var f=a.stateNode;null!==f&&"function"===typeof f.componentDidCatch&&(c.callback=function(){Mi(a,b);"function"!==typeof d&&(null===Si?Si=new Set([this]):Si.add(this));var c=b.stack;this.componentDidCatch(b.value,{componentStack:null!==c?c:""})});return c}
function Ti(a,b,c){var d=a.pingCache;if(null===d){d=a.pingCache=new Ni;var e=new Set;d.set(b,e)}else e=d.get(b),void 0===e&&(e=new Set,d.set(b,e));e.has(c)||(e.add(c),a=Ui.bind(null,a,b,c),b.then(a,a))}function Vi(a){do{var b;if(b=13===a.tag)b=a.memoizedState,b=null!==b?null!==b.dehydrated?!0:!1:!0;if(b)return a;a=a.return}while(null!==a);return null}
function Wi(a,b,c,d,e){if(0===(a.mode&1))return a===b?a.flags|=65536:(a.flags|=128,c.flags|=131072,c.flags&=-52805,1===c.tag&&(null===c.alternate?c.tag=17:(b=ch(-1,1),b.tag=2,dh(c,b,1))),c.lanes|=1),a;a.flags|=65536;a.lanes=e;return a}var Xi=ua.ReactCurrentOwner,Ug=!1;function Yi(a,b,c,d){b.child=null===a?Ch(b,null,c,d):Bh(b,a.child,c,d)}
function Zi(a,b,c,d,e){c=c.render;var f=b.ref;Tg(b,e);d=Xh(a,b,c,d,f,e);c=bi();if(null!==a&&!Ug)return b.updateQueue=a.updateQueue,b.flags&=-2053,a.lanes&=~e,$i(a,b,e);I&&c&&vg(b);b.flags|=1;Yi(a,b,d,e);return b.child}
function aj(a,b,c,d,e){if(null===a){var f=c.type;if("function"===typeof f&&!bj(f)&&void 0===f.defaultProps&&null===c.compare&&void 0===c.defaultProps)return b.tag=15,b.type=f,cj(a,b,f,d,e);a=yh(c.type,null,d,b,b.mode,e);a.ref=b.ref;a.return=b;return b.child=a}f=a.child;if(0===(a.lanes&e)){var g=f.memoizedProps;c=c.compare;c=null!==c?c:Ie;if(c(g,d)&&a.ref===b.ref)return $i(a,b,e)}b.flags|=1;a=wh(f,d);a.ref=b.ref;a.return=b;return b.child=a}
function cj(a,b,c,d,e){if(null!==a){var f=a.memoizedProps;if(Ie(f,d)&&a.ref===b.ref)if(Ug=!1,b.pendingProps=d=f,0!==(a.lanes&e))0!==(a.flags&131072)&&(Ug=!0);else return b.lanes=a.lanes,$i(a,b,e)}return dj(a,b,c,d,e)}
function ej(a,b,c){var d=b.pendingProps,e=d.children,f=null!==a?a.memoizedState:null;if("hidden"===d.mode)if(0===(b.mode&1))b.memoizedState={baseLanes:0,cachePool:null,transitions:null},G(fj,gj),gj|=c;else{if(0===(c&1073741824))return a=null!==f?f.baseLanes|c:c,b.lanes=b.childLanes=1073741824,b.memoizedState={baseLanes:a,cachePool:null,transitions:null},b.updateQueue=null,G(fj,gj),gj|=a,null;b.memoizedState={baseLanes:0,cachePool:null,transitions:null};d=null!==f?f.baseLanes:c;G(fj,gj);gj|=d}else null!==
f?(d=f.baseLanes|c,b.memoizedState=null):d=c,G(fj,gj),gj|=d;Yi(a,b,e,c);return b.child}function hj(a,b){var c=b.ref;if(null===a&&null!==c||null!==a&&a.ref!==c)b.flags|=512,b.flags|=2097152}function dj(a,b,c,d,e){var f=Zf(c)?Xf:H.current;f=Yf(b,f);Tg(b,e);c=Xh(a,b,c,d,f,e);d=bi();if(null!==a&&!Ug)return b.updateQueue=a.updateQueue,b.flags&=-2053,a.lanes&=~e,$i(a,b,e);I&&d&&vg(b);b.flags|=1;Yi(a,b,c,e);return b.child}
function ij(a,b,c,d,e){if(Zf(c)){var f=!0;cg(b)}else f=!1;Tg(b,e);if(null===b.stateNode)jj(a,b),ph(b,c,d),rh(b,c,d,e),d=!0;else if(null===a){var g=b.stateNode,h=b.memoizedProps;g.props=h;var k=g.context,l=c.contextType;"object"===typeof l&&null!==l?l=Vg(l):(l=Zf(c)?Xf:H.current,l=Yf(b,l));var m=c.getDerivedStateFromProps,q="function"===typeof m||"function"===typeof g.getSnapshotBeforeUpdate;q||"function"!==typeof g.UNSAFE_componentWillReceiveProps&&"function"!==typeof g.componentWillReceiveProps||
(h!==d||k!==l)&&qh(b,g,d,l);$g=!1;var r=b.memoizedState;g.state=r;gh(b,d,g,e);k=b.memoizedState;h!==d||r!==k||Wf.current||$g?("function"===typeof m&&(kh(b,c,m,d),k=b.memoizedState),(h=$g||oh(b,c,h,d,r,k,l))?(q||"function"!==typeof g.UNSAFE_componentWillMount&&"function"!==typeof g.componentWillMount||("function"===typeof g.componentWillMount&&g.componentWillMount(),"function"===typeof g.UNSAFE_componentWillMount&&g.UNSAFE_componentWillMount()),"function"===typeof g.componentDidMount&&(b.flags|=4194308)):
("function"===typeof g.componentDidMount&&(b.flags|=4194308),b.memoizedProps=d,b.memoizedState=k),g.props=d,g.state=k,g.context=l,d=h):("function"===typeof g.componentDidMount&&(b.flags|=4194308),d=!1)}else{g=b.stateNode;bh(a,b);h=b.memoizedProps;l=b.type===b.elementType?h:Lg(b.type,h);g.props=l;q=b.pendingProps;r=g.context;k=c.contextType;"object"===typeof k&&null!==k?k=Vg(k):(k=Zf(c)?Xf:H.current,k=Yf(b,k));var y=c.getDerivedStateFromProps;(m="function"===typeof y||"function"===typeof g.getSnapshotBeforeUpdate)||
"function"!==typeof g.UNSAFE_componentWillReceiveProps&&"function"!==typeof g.componentWillReceiveProps||(h!==q||r!==k)&&qh(b,g,d,k);$g=!1;r=b.memoizedState;g.state=r;gh(b,d,g,e);var n=b.memoizedState;h!==q||r!==n||Wf.current||$g?("function"===typeof y&&(kh(b,c,y,d),n=b.memoizedState),(l=$g||oh(b,c,l,d,r,n,k)||!1)?(m||"function"!==typeof g.UNSAFE_componentWillUpdate&&"function"!==typeof g.componentWillUpdate||("function"===typeof g.componentWillUpdate&&g.componentWillUpdate(d,n,k),"function"===typeof g.UNSAFE_componentWillUpdate&&
g.UNSAFE_componentWillUpdate(d,n,k)),"function"===typeof g.componentDidUpdate&&(b.flags|=4),"function"===typeof g.getSnapshotBeforeUpdate&&(b.flags|=1024)):("function"!==typeof g.componentDidUpdate||h===a.memoizedProps&&r===a.memoizedState||(b.flags|=4),"function"!==typeof g.getSnapshotBeforeUpdate||h===a.memoizedProps&&r===a.memoizedState||(b.flags|=1024),b.memoizedProps=d,b.memoizedState=n),g.props=d,g.state=n,g.context=k,d=l):("function"!==typeof g.componentDidUpdate||h===a.memoizedProps&&r===
a.memoizedState||(b.flags|=4),"function"!==typeof g.getSnapshotBeforeUpdate||h===a.memoizedProps&&r===a.memoizedState||(b.flags|=1024),d=!1)}return kj(a,b,c,d,f,e)}
function kj(a,b,c,d,e,f){hj(a,b);var g=0!==(b.flags&128);if(!d&&!g)return e&&dg(b,c,!1),$i(a,b,f);d=b.stateNode;Xi.current=b;var h=g&&"function"!==typeof c.getDerivedStateFromError?null:d.render();b.flags|=1;null!==a&&g?(b.child=Bh(b,a.child,null,f),b.child=Bh(b,null,h,f)):Yi(a,b,h,f);b.memoizedState=d.state;e&&dg(b,c,!0);return b.child}function lj(a){var b=a.stateNode;b.pendingContext?ag(a,b.pendingContext,b.pendingContext!==b.context):b.context&&ag(a,b.context,!1);Ih(a,b.containerInfo)}
function mj(a,b,c,d,e){Ig();Jg(e);b.flags|=256;Yi(a,b,c,d);return b.child}var nj={dehydrated:null,treeContext:null,retryLane:0};function oj(a){return{baseLanes:a,cachePool:null,transitions:null}}
function pj(a,b,c){var d=b.pendingProps,e=M.current,f=!1,g=0!==(b.flags&128),h;(h=g)||(h=null!==a&&null===a.memoizedState?!1:0!==(e&2));if(h)f=!0,b.flags&=-129;else if(null===a||null!==a.memoizedState)e|=1;G(M,e&1);if(null===a){Eg(b);a=b.memoizedState;if(null!==a&&(a=a.dehydrated,null!==a))return 0===(b.mode&1)?b.lanes=1:"$!"===a.data?b.lanes=8:b.lanes=1073741824,null;g=d.children;a=d.fallback;return f?(d=b.mode,f=b.child,g={mode:"hidden",children:g},0===(d&1)&&null!==f?(f.childLanes=0,f.pendingProps=
g):f=qj(g,d,0,null),a=Ah(a,d,c,null),f.return=b,a.return=b,f.sibling=a,b.child=f,b.child.memoizedState=oj(c),b.memoizedState=nj,a):rj(b,g)}e=a.memoizedState;if(null!==e&&(h=e.dehydrated,null!==h))return sj(a,b,g,d,h,e,c);if(f){f=d.fallback;g=b.mode;e=a.child;h=e.sibling;var k={mode:"hidden",children:d.children};0===(g&1)&&b.child!==e?(d=b.child,d.childLanes=0,d.pendingProps=k,b.deletions=null):(d=wh(e,k),d.subtreeFlags=e.subtreeFlags&14680064);null!==h?f=wh(h,f):(f=Ah(f,g,c,null),f.flags|=2);f.return=
b;d.return=b;d.sibling=f;b.child=d;d=f;f=b.child;g=a.child.memoizedState;g=null===g?oj(c):{baseLanes:g.baseLanes|c,cachePool:null,transitions:g.transitions};f.memoizedState=g;f.childLanes=a.childLanes&~c;b.memoizedState=nj;return d}f=a.child;a=f.sibling;d=wh(f,{mode:"visible",children:d.children});0===(b.mode&1)&&(d.lanes=c);d.return=b;d.sibling=null;null!==a&&(c=b.deletions,null===c?(b.deletions=[a],b.flags|=16):c.push(a));b.child=d;b.memoizedState=null;return d}
function rj(a,b){b=qj({mode:"visible",children:b},a.mode,0,null);b.return=a;return a.child=b}function tj(a,b,c,d){null!==d&&Jg(d);Bh(b,a.child,null,c);a=rj(b,b.pendingProps.children);a.flags|=2;b.memoizedState=null;return a}
function sj(a,b,c,d,e,f,g){if(c){if(b.flags&256)return b.flags&=-257,d=Li(Error(p(422))),tj(a,b,g,d);if(null!==b.memoizedState)return b.child=a.child,b.flags|=128,null;f=d.fallback;e=b.mode;d=qj({mode:"visible",children:d.children},e,0,null);f=Ah(f,e,g,null);f.flags|=2;d.return=b;f.return=b;d.sibling=f;b.child=d;0!==(b.mode&1)&&Bh(b,a.child,null,g);b.child.memoizedState=oj(g);b.memoizedState=nj;return f}if(0===(b.mode&1))return tj(a,b,g,null);if("$!"===e.data){d=e.nextSibling&&e.nextSibling.dataset;
if(d)var h=d.dgst;d=h;f=Error(p(419));d=Li(f,d,void 0);return tj(a,b,g,d)}h=0!==(g&a.childLanes);if(Ug||h){d=R;if(null!==d){switch(g&-g){case 4:e=2;break;case 16:e=8;break;case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:e=32;break;case 536870912:e=268435456;break;default:e=0}e=0!==(e&(d.suspendedLanes|g))?0:e;
0!==e&&e!==f.retryLane&&(f.retryLane=e,Zg(a,e),mh(d,a,e,-1))}uj();d=Li(Error(p(421)));return tj(a,b,g,d)}if("$?"===e.data)return b.flags|=128,b.child=a.child,b=vj.bind(null,a),e._reactRetry=b,null;a=f.treeContext;yg=Lf(e.nextSibling);xg=b;I=!0;zg=null;null!==a&&(og[pg++]=rg,og[pg++]=sg,og[pg++]=qg,rg=a.id,sg=a.overflow,qg=b);b=rj(b,d.children);b.flags|=4096;return b}function wj(a,b,c){a.lanes|=b;var d=a.alternate;null!==d&&(d.lanes|=b);Sg(a.return,b,c)}
function xj(a,b,c,d,e){var f=a.memoizedState;null===f?a.memoizedState={isBackwards:b,rendering:null,renderingStartTime:0,last:d,tail:c,tailMode:e}:(f.isBackwards=b,f.rendering=null,f.renderingStartTime=0,f.last=d,f.tail=c,f.tailMode=e)}
function yj(a,b,c){var d=b.pendingProps,e=d.revealOrder,f=d.tail;Yi(a,b,d.children,c);d=M.current;if(0!==(d&2))d=d&1|2,b.flags|=128;else{if(null!==a&&0!==(a.flags&128))a:for(a=b.child;null!==a;){if(13===a.tag)null!==a.memoizedState&&wj(a,c,b);else if(19===a.tag)wj(a,c,b);else if(null!==a.child){a.child.return=a;a=a.child;continue}if(a===b)break a;for(;null===a.sibling;){if(null===a.return||a.return===b)break a;a=a.return}a.sibling.return=a.return;a=a.sibling}d&=1}G(M,d);if(0===(b.mode&1))b.memoizedState=
null;else switch(e){case "forwards":c=b.child;for(e=null;null!==c;)a=c.alternate,null!==a&&null===Mh(a)&&(e=c),c=c.sibling;c=e;null===c?(e=b.child,b.child=null):(e=c.sibling,c.sibling=null);xj(b,!1,e,c,f);break;case "backwards":c=null;e=b.child;for(b.child=null;null!==e;){a=e.alternate;if(null!==a&&null===Mh(a)){b.child=e;break}a=e.sibling;e.sibling=c;c=e;e=a}xj(b,!0,c,null,f);break;case "together":xj(b,!1,null,null,void 0);break;default:b.memoizedState=null}return b.child}
function jj(a,b){0===(b.mode&1)&&null!==a&&(a.alternate=null,b.alternate=null,b.flags|=2)}function $i(a,b,c){null!==a&&(b.dependencies=a.dependencies);hh|=b.lanes;if(0===(c&b.childLanes))return null;if(null!==a&&b.child!==a.child)throw Error(p(153));if(null!==b.child){a=b.child;c=wh(a,a.pendingProps);b.child=c;for(c.return=b;null!==a.sibling;)a=a.sibling,c=c.sibling=wh(a,a.pendingProps),c.return=b;c.sibling=null}return b.child}
function zj(a,b,c){switch(b.tag){case 3:lj(b);Ig();break;case 5:Kh(b);break;case 1:Zf(b.type)&&cg(b);break;case 4:Ih(b,b.stateNode.containerInfo);break;case 10:var d=b.type._context,e=b.memoizedProps.value;G(Mg,d._currentValue);d._currentValue=e;break;case 13:d=b.memoizedState;if(null!==d){if(null!==d.dehydrated)return G(M,M.current&1),b.flags|=128,null;if(0!==(c&b.child.childLanes))return pj(a,b,c);G(M,M.current&1);a=$i(a,b,c);return null!==a?a.sibling:null}G(M,M.current&1);break;case 19:d=0!==(c&
b.childLanes);if(0!==(a.flags&128)){if(d)return yj(a,b,c);b.flags|=128}e=b.memoizedState;null!==e&&(e.rendering=null,e.tail=null,e.lastEffect=null);G(M,M.current);if(d)break;else return null;case 22:case 23:return b.lanes=0,ej(a,b,c)}return $i(a,b,c)}var Aj,Bj,Cj,Dj;
Aj=function(a,b){for(var c=b.child;null!==c;){if(5===c.tag||6===c.tag)a.appendChild(c.stateNode);else if(4!==c.tag&&null!==c.child){c.child.return=c;c=c.child;continue}if(c===b)break;for(;null===c.sibling;){if(null===c.return||c.return===b)return;c=c.return}c.sibling.return=c.return;c=c.sibling}};Bj=function(){};
Cj=function(a,b,c,d){var e=a.memoizedProps;if(e!==d){a=b.stateNode;Hh(Eh.current);var f=null;switch(c){case "input":e=Ya(a,e);d=Ya(a,d);f=[];break;case "select":e=A({},e,{value:void 0});d=A({},d,{value:void 0});f=[];break;case "textarea":e=gb(a,e);d=gb(a,d);f=[];break;default:"function"!==typeof e.onClick&&"function"===typeof d.onClick&&(a.onclick=Bf)}ub(c,d);var g;c=null;for(l in e)if(!d.hasOwnProperty(l)&&e.hasOwnProperty(l)&&null!=e[l])if("style"===l){var h=e[l];for(g in h)h.hasOwnProperty(g)&&
(c||(c={}),c[g]="")}else"dangerouslySetInnerHTML"!==l&&"children"!==l&&"suppressContentEditableWarning"!==l&&"suppressHydrationWarning"!==l&&"autoFocus"!==l&&(ea.hasOwnProperty(l)?f||(f=[]):(f=f||[]).push(l,null));for(l in d){var k=d[l];h=null!=e?e[l]:void 0;if(d.hasOwnProperty(l)&&k!==h&&(null!=k||null!=h))if("style"===l)if(h){for(g in h)!h.hasOwnProperty(g)||k&&k.hasOwnProperty(g)||(c||(c={}),c[g]="");for(g in k)k.hasOwnProperty(g)&&h[g]!==k[g]&&(c||(c={}),c[g]=k[g])}else c||(f||(f=[]),f.push(l,
c)),c=k;else"dangerouslySetInnerHTML"===l?(k=k?k.__html:void 0,h=h?h.__html:void 0,null!=k&&h!==k&&(f=f||[]).push(l,k)):"children"===l?"string"!==typeof k&&"number"!==typeof k||(f=f||[]).push(l,""+k):"suppressContentEditableWarning"!==l&&"suppressHydrationWarning"!==l&&(ea.hasOwnProperty(l)?(null!=k&&"onScroll"===l&&D("scroll",a),f||h===k||(f=[])):(f=f||[]).push(l,k))}c&&(f=f||[]).push("style",c);var l=f;if(b.updateQueue=l)b.flags|=4}};Dj=function(a,b,c,d){c!==d&&(b.flags|=4)};
function Ej(a,b){if(!I)switch(a.tailMode){case "hidden":b=a.tail;for(var c=null;null!==b;)null!==b.alternate&&(c=b),b=b.sibling;null===c?a.tail=null:c.sibling=null;break;case "collapsed":c=a.tail;for(var d=null;null!==c;)null!==c.alternate&&(d=c),c=c.sibling;null===d?b||null===a.tail?a.tail=null:a.tail.sibling=null:d.sibling=null}}
function S(a){var b=null!==a.alternate&&a.alternate.child===a.child,c=0,d=0;if(b)for(var e=a.child;null!==e;)c|=e.lanes|e.childLanes,d|=e.subtreeFlags&14680064,d|=e.flags&14680064,e.return=a,e=e.sibling;else for(e=a.child;null!==e;)c|=e.lanes|e.childLanes,d|=e.subtreeFlags,d|=e.flags,e.return=a,e=e.sibling;a.subtreeFlags|=d;a.childLanes=c;return b}
function Fj(a,b,c){var d=b.pendingProps;wg(b);switch(b.tag){case 2:case 16:case 15:case 0:case 11:case 7:case 8:case 12:case 9:case 14:return S(b),null;case 1:return Zf(b.type)&&$f(),S(b),null;case 3:d=b.stateNode;Jh();E(Wf);E(H);Oh();d.pendingContext&&(d.context=d.pendingContext,d.pendingContext=null);if(null===a||null===a.child)Gg(b)?b.flags|=4:null===a||a.memoizedState.isDehydrated&&0===(b.flags&256)||(b.flags|=1024,null!==zg&&(Gj(zg),zg=null));Bj(a,b);S(b);return null;case 5:Lh(b);var e=Hh(Gh.current);
c=b.type;if(null!==a&&null!=b.stateNode)Cj(a,b,c,d,e),a.ref!==b.ref&&(b.flags|=512,b.flags|=2097152);else{if(!d){if(null===b.stateNode)throw Error(p(166));S(b);return null}a=Hh(Eh.current);if(Gg(b)){d=b.stateNode;c=b.type;var f=b.memoizedProps;d[Of]=b;d[Pf]=f;a=0!==(b.mode&1);switch(c){case "dialog":D("cancel",d);D("close",d);break;case "iframe":case "object":case "embed":D("load",d);break;case "video":case "audio":for(e=0;e<lf.length;e++)D(lf[e],d);break;case "source":D("error",d);break;case "img":case "image":case "link":D("error",
d);D("load",d);break;case "details":D("toggle",d);break;case "input":Za(d,f);D("invalid",d);break;case "select":d._wrapperState={wasMultiple:!!f.multiple};D("invalid",d);break;case "textarea":hb(d,f),D("invalid",d)}ub(c,f);e=null;for(var g in f)if(f.hasOwnProperty(g)){var h=f[g];"children"===g?"string"===typeof h?d.textContent!==h&&(!0!==f.suppressHydrationWarning&&Af(d.textContent,h,a),e=["children",h]):"number"===typeof h&&d.textContent!==""+h&&(!0!==f.suppressHydrationWarning&&Af(d.textContent,
h,a),e=["children",""+h]):ea.hasOwnProperty(g)&&null!=h&&"onScroll"===g&&D("scroll",d)}switch(c){case "input":Va(d);db(d,f,!0);break;case "textarea":Va(d);jb(d);break;case "select":case "option":break;default:"function"===typeof f.onClick&&(d.onclick=Bf)}d=e;b.updateQueue=d;null!==d&&(b.flags|=4)}else{g=9===e.nodeType?e:e.ownerDocument;"http://www.w3.org/1999/xhtml"===a&&(a=kb(c));"http://www.w3.org/1999/xhtml"===a?"script"===c?(a=g.createElement("div"),a.innerHTML="<script>\x3c/script>",a=a.removeChild(a.firstChild)):
"string"===typeof d.is?a=g.createElement(c,{is:d.is}):(a=g.createElement(c),"select"===c&&(g=a,d.multiple?g.multiple=!0:d.size&&(g.size=d.size))):a=g.createElementNS(a,c);a[Of]=b;a[Pf]=d;Aj(a,b,!1,!1);b.stateNode=a;a:{g=vb(c,d);switch(c){case "dialog":D("cancel",a);D("close",a);e=d;break;case "iframe":case "object":case "embed":D("load",a);e=d;break;case "video":case "audio":for(e=0;e<lf.length;e++)D(lf[e],a);e=d;break;case "source":D("error",a);e=d;break;case "img":case "image":case "link":D("error",
a);D("load",a);e=d;break;case "details":D("toggle",a);e=d;break;case "input":Za(a,d);e=Ya(a,d);D("invalid",a);break;case "option":e=d;break;case "select":a._wrapperState={wasMultiple:!!d.multiple};e=A({},d,{value:void 0});D("invalid",a);break;case "textarea":hb(a,d);e=gb(a,d);D("invalid",a);break;default:e=d}ub(c,e);h=e;for(f in h)if(h.hasOwnProperty(f)){var k=h[f];"style"===f?sb(a,k):"dangerouslySetInnerHTML"===f?(k=k?k.__html:void 0,null!=k&&nb(a,k)):"children"===f?"string"===typeof k?("textarea"!==
c||""!==k)&&ob(a,k):"number"===typeof k&&ob(a,""+k):"suppressContentEditableWarning"!==f&&"suppressHydrationWarning"!==f&&"autoFocus"!==f&&(ea.hasOwnProperty(f)?null!=k&&"onScroll"===f&&D("scroll",a):null!=k&&ta(a,f,k,g))}switch(c){case "input":Va(a);db(a,d,!1);break;case "textarea":Va(a);jb(a);break;case "option":null!=d.value&&a.setAttribute("value",""+Sa(d.value));break;case "select":a.multiple=!!d.multiple;f=d.value;null!=f?fb(a,!!d.multiple,f,!1):null!=d.defaultValue&&fb(a,!!d.multiple,d.defaultValue,
!0);break;default:"function"===typeof e.onClick&&(a.onclick=Bf)}switch(c){case "button":case "input":case "select":case "textarea":d=!!d.autoFocus;break a;case "img":d=!0;break a;default:d=!1}}d&&(b.flags|=4)}null!==b.ref&&(b.flags|=512,b.flags|=2097152)}S(b);return null;case 6:if(a&&null!=b.stateNode)Dj(a,b,a.memoizedProps,d);else{if("string"!==typeof d&&null===b.stateNode)throw Error(p(166));c=Hh(Gh.current);Hh(Eh.current);if(Gg(b)){d=b.stateNode;c=b.memoizedProps;d[Of]=b;if(f=d.nodeValue!==c)if(a=
xg,null!==a)switch(a.tag){case 3:Af(d.nodeValue,c,0!==(a.mode&1));break;case 5:!0!==a.memoizedProps.suppressHydrationWarning&&Af(d.nodeValue,c,0!==(a.mode&1))}f&&(b.flags|=4)}else d=(9===c.nodeType?c:c.ownerDocument).createTextNode(d),d[Of]=b,b.stateNode=d}S(b);return null;case 13:E(M);d=b.memoizedState;if(null===a||null!==a.memoizedState&&null!==a.memoizedState.dehydrated){if(I&&null!==yg&&0!==(b.mode&1)&&0===(b.flags&128))Hg(),Ig(),b.flags|=98560,f=!1;else if(f=Gg(b),null!==d&&null!==d.dehydrated){if(null===
a){if(!f)throw Error(p(318));f=b.memoizedState;f=null!==f?f.dehydrated:null;if(!f)throw Error(p(317));f[Of]=b}else Ig(),0===(b.flags&128)&&(b.memoizedState=null),b.flags|=4;S(b);f=!1}else null!==zg&&(Gj(zg),zg=null),f=!0;if(!f)return b.flags&65536?b:null}if(0!==(b.flags&128))return b.lanes=c,b;d=null!==d;d!==(null!==a&&null!==a.memoizedState)&&d&&(b.child.flags|=8192,0!==(b.mode&1)&&(null===a||0!==(M.current&1)?0===T&&(T=3):uj()));null!==b.updateQueue&&(b.flags|=4);S(b);return null;case 4:return Jh(),
Bj(a,b),null===a&&sf(b.stateNode.containerInfo),S(b),null;case 10:return Rg(b.type._context),S(b),null;case 17:return Zf(b.type)&&$f(),S(b),null;case 19:E(M);f=b.memoizedState;if(null===f)return S(b),null;d=0!==(b.flags&128);g=f.rendering;if(null===g)if(d)Ej(f,!1);else{if(0!==T||null!==a&&0!==(a.flags&128))for(a=b.child;null!==a;){g=Mh(a);if(null!==g){b.flags|=128;Ej(f,!1);d=g.updateQueue;null!==d&&(b.updateQueue=d,b.flags|=4);b.subtreeFlags=0;d=c;for(c=b.child;null!==c;)f=c,a=d,f.flags&=14680066,
g=f.alternate,null===g?(f.childLanes=0,f.lanes=a,f.child=null,f.subtreeFlags=0,f.memoizedProps=null,f.memoizedState=null,f.updateQueue=null,f.dependencies=null,f.stateNode=null):(f.childLanes=g.childLanes,f.lanes=g.lanes,f.child=g.child,f.subtreeFlags=0,f.deletions=null,f.memoizedProps=g.memoizedProps,f.memoizedState=g.memoizedState,f.updateQueue=g.updateQueue,f.type=g.type,a=g.dependencies,f.dependencies=null===a?null:{lanes:a.lanes,firstContext:a.firstContext}),c=c.sibling;G(M,M.current&1|2);return b.child}a=
a.sibling}null!==f.tail&&B()>Hj&&(b.flags|=128,d=!0,Ej(f,!1),b.lanes=4194304)}else{if(!d)if(a=Mh(g),null!==a){if(b.flags|=128,d=!0,c=a.updateQueue,null!==c&&(b.updateQueue=c,b.flags|=4),Ej(f,!0),null===f.tail&&"hidden"===f.tailMode&&!g.alternate&&!I)return S(b),null}else 2*B()-f.renderingStartTime>Hj&&1073741824!==c&&(b.flags|=128,d=!0,Ej(f,!1),b.lanes=4194304);f.isBackwards?(g.sibling=b.child,b.child=g):(c=f.last,null!==c?c.sibling=g:b.child=g,f.last=g)}if(null!==f.tail)return b=f.tail,f.rendering=
b,f.tail=b.sibling,f.renderingStartTime=B(),b.sibling=null,c=M.current,G(M,d?c&1|2:c&1),b;S(b);return null;case 22:case 23:return Ij(),d=null!==b.memoizedState,null!==a&&null!==a.memoizedState!==d&&(b.flags|=8192),d&&0!==(b.mode&1)?0!==(gj&1073741824)&&(S(b),b.subtreeFlags&6&&(b.flags|=8192)):S(b),null;case 24:return null;case 25:return null}throw Error(p(156,b.tag));}
function Jj(a,b){wg(b);switch(b.tag){case 1:return Zf(b.type)&&$f(),a=b.flags,a&65536?(b.flags=a&-65537|128,b):null;case 3:return Jh(),E(Wf),E(H),Oh(),a=b.flags,0!==(a&65536)&&0===(a&128)?(b.flags=a&-65537|128,b):null;case 5:return Lh(b),null;case 13:E(M);a=b.memoizedState;if(null!==a&&null!==a.dehydrated){if(null===b.alternate)throw Error(p(340));Ig()}a=b.flags;return a&65536?(b.flags=a&-65537|128,b):null;case 19:return E(M),null;case 4:return Jh(),null;case 10:return Rg(b.type._context),null;case 22:case 23:return Ij(),
null;case 24:return null;default:return null}}var Kj=!1,U=!1,Lj="function"===typeof WeakSet?WeakSet:Set,V=null;function Mj(a,b){var c=a.ref;if(null!==c)if("function"===typeof c)try{c(null)}catch(d){W(a,b,d)}else c.current=null}function Nj(a,b,c){try{c()}catch(d){W(a,b,d)}}var Oj=!1;
function Pj(a,b){Cf=dd;a=Me();if(Ne(a)){if("selectionStart"in a)var c={start:a.selectionStart,end:a.selectionEnd};else a:{c=(c=a.ownerDocument)&&c.defaultView||window;var d=c.getSelection&&c.getSelection();if(d&&0!==d.rangeCount){c=d.anchorNode;var e=d.anchorOffset,f=d.focusNode;d=d.focusOffset;try{c.nodeType,f.nodeType}catch(F){c=null;break a}var g=0,h=-1,k=-1,l=0,m=0,q=a,r=null;b:for(;;){for(var y;;){q!==c||0!==e&&3!==q.nodeType||(h=g+e);q!==f||0!==d&&3!==q.nodeType||(k=g+d);3===q.nodeType&&(g+=
q.nodeValue.length);if(null===(y=q.firstChild))break;r=q;q=y}for(;;){if(q===a)break b;r===c&&++l===e&&(h=g);r===f&&++m===d&&(k=g);if(null!==(y=q.nextSibling))break;q=r;r=q.parentNode}q=y}c=-1===h||-1===k?null:{start:h,end:k}}else c=null}c=c||{start:0,end:0}}else c=null;Df={focusedElem:a,selectionRange:c};dd=!1;for(V=b;null!==V;)if(b=V,a=b.child,0!==(b.subtreeFlags&1028)&&null!==a)a.return=b,V=a;else for(;null!==V;){b=V;try{var n=b.alternate;if(0!==(b.flags&1024))switch(b.tag){case 0:case 11:case 15:break;
case 1:if(null!==n){var t=n.memoizedProps,J=n.memoizedState,x=b.stateNode,w=x.getSnapshotBeforeUpdate(b.elementType===b.type?t:Lg(b.type,t),J);x.__reactInternalSnapshotBeforeUpdate=w}break;case 3:var u=b.stateNode.containerInfo;1===u.nodeType?u.textContent="":9===u.nodeType&&u.documentElement&&u.removeChild(u.documentElement);break;case 5:case 6:case 4:case 17:break;default:throw Error(p(163));}}catch(F){W(b,b.return,F)}a=b.sibling;if(null!==a){a.return=b.return;V=a;break}V=b.return}n=Oj;Oj=!1;return n}
function Qj(a,b,c){var d=b.updateQueue;d=null!==d?d.lastEffect:null;if(null!==d){var e=d=d.next;do{if((e.tag&a)===a){var f=e.destroy;e.destroy=void 0;void 0!==f&&Nj(b,c,f)}e=e.next}while(e!==d)}}function Rj(a,b){b=b.updateQueue;b=null!==b?b.lastEffect:null;if(null!==b){var c=b=b.next;do{if((c.tag&a)===a){var d=c.create;c.destroy=d()}c=c.next}while(c!==b)}}function Sj(a){var b=a.ref;if(null!==b){var c=a.stateNode;switch(a.tag){case 5:a=c;break;default:a=c}"function"===typeof b?b(a):b.current=a}}
function Tj(a){var b=a.alternate;null!==b&&(a.alternate=null,Tj(b));a.child=null;a.deletions=null;a.sibling=null;5===a.tag&&(b=a.stateNode,null!==b&&(delete b[Of],delete b[Pf],delete b[of],delete b[Qf],delete b[Rf]));a.stateNode=null;a.return=null;a.dependencies=null;a.memoizedProps=null;a.memoizedState=null;a.pendingProps=null;a.stateNode=null;a.updateQueue=null}function Uj(a){return 5===a.tag||3===a.tag||4===a.tag}
function Vj(a){a:for(;;){for(;null===a.sibling;){if(null===a.return||Uj(a.return))return null;a=a.return}a.sibling.return=a.return;for(a=a.sibling;5!==a.tag&&6!==a.tag&&18!==a.tag;){if(a.flags&2)continue a;if(null===a.child||4===a.tag)continue a;else a.child.return=a,a=a.child}if(!(a.flags&2))return a.stateNode}}
function Wj(a,b,c){var d=a.tag;if(5===d||6===d)a=a.stateNode,b?8===c.nodeType?c.parentNode.insertBefore(a,b):c.insertBefore(a,b):(8===c.nodeType?(b=c.parentNode,b.insertBefore(a,c)):(b=c,b.appendChild(a)),c=c._reactRootContainer,null!==c&&void 0!==c||null!==b.onclick||(b.onclick=Bf));else if(4!==d&&(a=a.child,null!==a))for(Wj(a,b,c),a=a.sibling;null!==a;)Wj(a,b,c),a=a.sibling}
function Xj(a,b,c){var d=a.tag;if(5===d||6===d)a=a.stateNode,b?c.insertBefore(a,b):c.appendChild(a);else if(4!==d&&(a=a.child,null!==a))for(Xj(a,b,c),a=a.sibling;null!==a;)Xj(a,b,c),a=a.sibling}var X=null,Yj=!1;function Zj(a,b,c){for(c=c.child;null!==c;)ak(a,b,c),c=c.sibling}
function ak(a,b,c){if(lc&&"function"===typeof lc.onCommitFiberUnmount)try{lc.onCommitFiberUnmount(kc,c)}catch(h){}switch(c.tag){case 5:U||Mj(c,b);case 6:var d=X,e=Yj;X=null;Zj(a,b,c);X=d;Yj=e;null!==X&&(Yj?(a=X,c=c.stateNode,8===a.nodeType?a.parentNode.removeChild(c):a.removeChild(c)):X.removeChild(c.stateNode));break;case 18:null!==X&&(Yj?(a=X,c=c.stateNode,8===a.nodeType?Kf(a.parentNode,c):1===a.nodeType&&Kf(a,c),bd(a)):Kf(X,c.stateNode));break;case 4:d=X;e=Yj;X=c.stateNode.containerInfo;Yj=!0;
Zj(a,b,c);X=d;Yj=e;break;case 0:case 11:case 14:case 15:if(!U&&(d=c.updateQueue,null!==d&&(d=d.lastEffect,null!==d))){e=d=d.next;do{var f=e,g=f.destroy;f=f.tag;void 0!==g&&(0!==(f&2)?Nj(c,b,g):0!==(f&4)&&Nj(c,b,g));e=e.next}while(e!==d)}Zj(a,b,c);break;case 1:if(!U&&(Mj(c,b),d=c.stateNode,"function"===typeof d.componentWillUnmount))try{d.props=c.memoizedProps,d.state=c.memoizedState,d.componentWillUnmount()}catch(h){W(c,b,h)}Zj(a,b,c);break;case 21:Zj(a,b,c);break;case 22:c.mode&1?(U=(d=U)||null!==
c.memoizedState,Zj(a,b,c),U=d):Zj(a,b,c);break;default:Zj(a,b,c)}}function bk(a){var b=a.updateQueue;if(null!==b){a.updateQueue=null;var c=a.stateNode;null===c&&(c=a.stateNode=new Lj);b.forEach(function(b){var d=ck.bind(null,a,b);c.has(b)||(c.add(b),b.then(d,d))})}}
function dk(a,b){var c=b.deletions;if(null!==c)for(var d=0;d<c.length;d++){var e=c[d];try{var f=a,g=b,h=g;a:for(;null!==h;){switch(h.tag){case 5:X=h.stateNode;Yj=!1;break a;case 3:X=h.stateNode.containerInfo;Yj=!0;break a;case 4:X=h.stateNode.containerInfo;Yj=!0;break a}h=h.return}if(null===X)throw Error(p(160));ak(f,g,e);X=null;Yj=!1;var k=e.alternate;null!==k&&(k.return=null);e.return=null}catch(l){W(e,b,l)}}if(b.subtreeFlags&12854)for(b=b.child;null!==b;)ek(b,a),b=b.sibling}
function ek(a,b){var c=a.alternate,d=a.flags;switch(a.tag){case 0:case 11:case 14:case 15:dk(b,a);fk(a);if(d&4){try{Qj(3,a,a.return),Rj(3,a)}catch(t){W(a,a.return,t)}try{Qj(5,a,a.return)}catch(t){W(a,a.return,t)}}break;case 1:dk(b,a);fk(a);d&512&&null!==c&&Mj(c,c.return);break;case 5:dk(b,a);fk(a);d&512&&null!==c&&Mj(c,c.return);if(a.flags&32){var e=a.stateNode;try{ob(e,"")}catch(t){W(a,a.return,t)}}if(d&4&&(e=a.stateNode,null!=e)){var f=a.memoizedProps,g=null!==c?c.memoizedProps:f,h=a.type,k=a.updateQueue;
a.updateQueue=null;if(null!==k)try{"input"===h&&"radio"===f.type&&null!=f.name&&ab(e,f);vb(h,g);var l=vb(h,f);for(g=0;g<k.length;g+=2){var m=k[g],q=k[g+1];"style"===m?sb(e,q):"dangerouslySetInnerHTML"===m?nb(e,q):"children"===m?ob(e,q):ta(e,m,q,l)}switch(h){case "input":bb(e,f);break;case "textarea":ib(e,f);break;case "select":var r=e._wrapperState.wasMultiple;e._wrapperState.wasMultiple=!!f.multiple;var y=f.value;null!=y?fb(e,!!f.multiple,y,!1):r!==!!f.multiple&&(null!=f.defaultValue?fb(e,!!f.multiple,
f.defaultValue,!0):fb(e,!!f.multiple,f.multiple?[]:"",!1))}e[Pf]=f}catch(t){W(a,a.return,t)}}break;case 6:dk(b,a);fk(a);if(d&4){if(null===a.stateNode)throw Error(p(162));e=a.stateNode;f=a.memoizedProps;try{e.nodeValue=f}catch(t){W(a,a.return,t)}}break;case 3:dk(b,a);fk(a);if(d&4&&null!==c&&c.memoizedState.isDehydrated)try{bd(b.containerInfo)}catch(t){W(a,a.return,t)}break;case 4:dk(b,a);fk(a);break;case 13:dk(b,a);fk(a);e=a.child;e.flags&8192&&(f=null!==e.memoizedState,e.stateNode.isHidden=f,!f||
null!==e.alternate&&null!==e.alternate.memoizedState||(gk=B()));d&4&&bk(a);break;case 22:m=null!==c&&null!==c.memoizedState;a.mode&1?(U=(l=U)||m,dk(b,a),U=l):dk(b,a);fk(a);if(d&8192){l=null!==a.memoizedState;if((a.stateNode.isHidden=l)&&!m&&0!==(a.mode&1))for(V=a,m=a.child;null!==m;){for(q=V=m;null!==V;){r=V;y=r.child;switch(r.tag){case 0:case 11:case 14:case 15:Qj(4,r,r.return);break;case 1:Mj(r,r.return);var n=r.stateNode;if("function"===typeof n.componentWillUnmount){d=r;c=r.return;try{b=d,n.props=
b.memoizedProps,n.state=b.memoizedState,n.componentWillUnmount()}catch(t){W(d,c,t)}}break;case 5:Mj(r,r.return);break;case 22:if(null!==r.memoizedState){hk(q);continue}}null!==y?(y.return=r,V=y):hk(q)}m=m.sibling}a:for(m=null,q=a;;){if(5===q.tag){if(null===m){m=q;try{e=q.stateNode,l?(f=e.style,"function"===typeof f.setProperty?f.setProperty("display","none","important"):f.display="none"):(h=q.stateNode,k=q.memoizedProps.style,g=void 0!==k&&null!==k&&k.hasOwnProperty("display")?k.display:null,h.style.display=
rb("display",g))}catch(t){W(a,a.return,t)}}}else if(6===q.tag){if(null===m)try{q.stateNode.nodeValue=l?"":q.memoizedProps}catch(t){W(a,a.return,t)}}else if((22!==q.tag&&23!==q.tag||null===q.memoizedState||q===a)&&null!==q.child){q.child.return=q;q=q.child;continue}if(q===a)break a;for(;null===q.sibling;){if(null===q.return||q.return===a)break a;m===q&&(m=null);q=q.return}m===q&&(m=null);q.sibling.return=q.return;q=q.sibling}}break;case 19:dk(b,a);fk(a);d&4&&bk(a);break;case 21:break;default:dk(b,
a),fk(a)}}function fk(a){var b=a.flags;if(b&2){try{a:{for(var c=a.return;null!==c;){if(Uj(c)){var d=c;break a}c=c.return}throw Error(p(160));}switch(d.tag){case 5:var e=d.stateNode;d.flags&32&&(ob(e,""),d.flags&=-33);var f=Vj(a);Xj(a,f,e);break;case 3:case 4:var g=d.stateNode.containerInfo,h=Vj(a);Wj(a,h,g);break;default:throw Error(p(161));}}catch(k){W(a,a.return,k)}a.flags&=-3}b&4096&&(a.flags&=-4097)}function ik(a,b,c){V=a;jk(a,b,c)}
function jk(a,b,c){for(var d=0!==(a.mode&1);null!==V;){var e=V,f=e.child;if(22===e.tag&&d){var g=null!==e.memoizedState||Kj;if(!g){var h=e.alternate,k=null!==h&&null!==h.memoizedState||U;h=Kj;var l=U;Kj=g;if((U=k)&&!l)for(V=e;null!==V;)g=V,k=g.child,22===g.tag&&null!==g.memoizedState?kk(e):null!==k?(k.return=g,V=k):kk(e);for(;null!==f;)V=f,jk(f,b,c),f=f.sibling;V=e;Kj=h;U=l}lk(a,b,c)}else 0!==(e.subtreeFlags&8772)&&null!==f?(f.return=e,V=f):lk(a,b,c)}}
function lk(a){for(;null!==V;){var b=V;if(0!==(b.flags&8772)){var c=b.alternate;try{if(0!==(b.flags&8772))switch(b.tag){case 0:case 11:case 15:U||Rj(5,b);break;case 1:var d=b.stateNode;if(b.flags&4&&!U)if(null===c)d.componentDidMount();else{var e=b.elementType===b.type?c.memoizedProps:Lg(b.type,c.memoizedProps);d.componentDidUpdate(e,c.memoizedState,d.__reactInternalSnapshotBeforeUpdate)}var f=b.updateQueue;null!==f&&ih(b,f,d);break;case 3:var g=b.updateQueue;if(null!==g){c=null;if(null!==b.child)switch(b.child.tag){case 5:c=
b.child.stateNode;break;case 1:c=b.child.stateNode}ih(b,g,c)}break;case 5:var h=b.stateNode;if(null===c&&b.flags&4){c=h;var k=b.memoizedProps;switch(b.type){case "button":case "input":case "select":case "textarea":k.autoFocus&&c.focus();break;case "img":k.src&&(c.src=k.src)}}break;case 6:break;case 4:break;case 12:break;case 13:if(null===b.memoizedState){var l=b.alternate;if(null!==l){var m=l.memoizedState;if(null!==m){var q=m.dehydrated;null!==q&&bd(q)}}}break;case 19:case 17:case 21:case 22:case 23:case 25:break;
default:throw Error(p(163));}U||b.flags&512&&Sj(b)}catch(r){W(b,b.return,r)}}if(b===a){V=null;break}c=b.sibling;if(null!==c){c.return=b.return;V=c;break}V=b.return}}function hk(a){for(;null!==V;){var b=V;if(b===a){V=null;break}var c=b.sibling;if(null!==c){c.return=b.return;V=c;break}V=b.return}}
function kk(a){for(;null!==V;){var b=V;try{switch(b.tag){case 0:case 11:case 15:var c=b.return;try{Rj(4,b)}catch(k){W(b,c,k)}break;case 1:var d=b.stateNode;if("function"===typeof d.componentDidMount){var e=b.return;try{d.componentDidMount()}catch(k){W(b,e,k)}}var f=b.return;try{Sj(b)}catch(k){W(b,f,k)}break;case 5:var g=b.return;try{Sj(b)}catch(k){W(b,g,k)}}}catch(k){W(b,b.return,k)}if(b===a){V=null;break}var h=b.sibling;if(null!==h){h.return=b.return;V=h;break}V=b.return}}
var mk=Math.ceil,nk=ua.ReactCurrentDispatcher,ok=ua.ReactCurrentOwner,pk=ua.ReactCurrentBatchConfig,K=0,R=null,Y=null,Z=0,gj=0,fj=Uf(0),T=0,qk=null,hh=0,rk=0,sk=0,tk=null,uk=null,gk=0,Hj=Infinity,vk=null,Pi=!1,Qi=null,Si=null,wk=!1,xk=null,yk=0,zk=0,Ak=null,Bk=-1,Ck=0;function L(){return 0!==(K&6)?B():-1!==Bk?Bk:Bk=B()}
function lh(a){if(0===(a.mode&1))return 1;if(0!==(K&2)&&0!==Z)return Z&-Z;if(null!==Kg.transition)return 0===Ck&&(Ck=yc()),Ck;a=C;if(0!==a)return a;a=window.event;a=void 0===a?16:jd(a.type);return a}function mh(a,b,c,d){if(50<zk)throw zk=0,Ak=null,Error(p(185));Ac(a,c,d);if(0===(K&2)||a!==R)a===R&&(0===(K&2)&&(rk|=c),4===T&&Dk(a,Z)),Ek(a,d),1===c&&0===K&&0===(b.mode&1)&&(Hj=B()+500,fg&&jg())}
function Ek(a,b){var c=a.callbackNode;wc(a,b);var d=uc(a,a===R?Z:0);if(0===d)null!==c&&bc(c),a.callbackNode=null,a.callbackPriority=0;else if(b=d&-d,a.callbackPriority!==b){null!=c&&bc(c);if(1===b)0===a.tag?ig(Fk.bind(null,a)):hg(Fk.bind(null,a)),Jf(function(){0===(K&6)&&jg()}),c=null;else{switch(Dc(d)){case 1:c=fc;break;case 4:c=gc;break;case 16:c=hc;break;case 536870912:c=jc;break;default:c=hc}c=Gk(c,Hk.bind(null,a))}a.callbackPriority=b;a.callbackNode=c}}
function Hk(a,b){Bk=-1;Ck=0;if(0!==(K&6))throw Error(p(327));var c=a.callbackNode;if(Ik()&&a.callbackNode!==c)return null;var d=uc(a,a===R?Z:0);if(0===d)return null;if(0!==(d&30)||0!==(d&a.expiredLanes)||b)b=Jk(a,d);else{b=d;var e=K;K|=2;var f=Kk();if(R!==a||Z!==b)vk=null,Hj=B()+500,Lk(a,b);do try{Mk();break}catch(h){Nk(a,h)}while(1);Qg();nk.current=f;K=e;null!==Y?b=0:(R=null,Z=0,b=T)}if(0!==b){2===b&&(e=xc(a),0!==e&&(d=e,b=Ok(a,e)));if(1===b)throw c=qk,Lk(a,0),Dk(a,d),Ek(a,B()),c;if(6===b)Dk(a,d);
else{e=a.current.alternate;if(0===(d&30)&&!Pk(e)&&(b=Jk(a,d),2===b&&(f=xc(a),0!==f&&(d=f,b=Ok(a,f))),1===b))throw c=qk,Lk(a,0),Dk(a,d),Ek(a,B()),c;a.finishedWork=e;a.finishedLanes=d;switch(b){case 0:case 1:throw Error(p(345));case 2:Qk(a,uk,vk);break;case 3:Dk(a,d);if((d&130023424)===d&&(b=gk+500-B(),10<b)){if(0!==uc(a,0))break;e=a.suspendedLanes;if((e&d)!==d){L();a.pingedLanes|=a.suspendedLanes&e;break}a.timeoutHandle=Ff(Qk.bind(null,a,uk,vk),b);break}Qk(a,uk,vk);break;case 4:Dk(a,d);if((d&4194240)===
d)break;b=a.eventTimes;for(e=-1;0<d;){var g=31-oc(d);f=1<<g;g=b[g];g>e&&(e=g);d&=~f}d=e;d=B()-d;d=(120>d?120:480>d?480:1080>d?1080:1920>d?1920:3E3>d?3E3:4320>d?4320:1960*mk(d/1960))-d;if(10<d){a.timeoutHandle=Ff(Qk.bind(null,a,uk,vk),d);break}Qk(a,uk,vk);break;case 5:Qk(a,uk,vk);break;default:throw Error(p(329));}}}Ek(a,B());return a.callbackNode===c?Hk.bind(null,a):null}
function Ok(a,b){var c=tk;a.current.memoizedState.isDehydrated&&(Lk(a,b).flags|=256);a=Jk(a,b);2!==a&&(b=uk,uk=c,null!==b&&Gj(b));return a}function Gj(a){null===uk?uk=a:uk.push.apply(uk,a)}
function Pk(a){for(var b=a;;){if(b.flags&16384){var c=b.updateQueue;if(null!==c&&(c=c.stores,null!==c))for(var d=0;d<c.length;d++){var e=c[d],f=e.getSnapshot;e=e.value;try{if(!He(f(),e))return!1}catch(g){return!1}}}c=b.child;if(b.subtreeFlags&16384&&null!==c)c.return=b,b=c;else{if(b===a)break;for(;null===b.sibling;){if(null===b.return||b.return===a)return!0;b=b.return}b.sibling.return=b.return;b=b.sibling}}return!0}
function Dk(a,b){b&=~sk;b&=~rk;a.suspendedLanes|=b;a.pingedLanes&=~b;for(a=a.expirationTimes;0<b;){var c=31-oc(b),d=1<<c;a[c]=-1;b&=~d}}function Fk(a){if(0!==(K&6))throw Error(p(327));Ik();var b=uc(a,0);if(0===(b&1))return Ek(a,B()),null;var c=Jk(a,b);if(0!==a.tag&&2===c){var d=xc(a);0!==d&&(b=d,c=Ok(a,d))}if(1===c)throw c=qk,Lk(a,0),Dk(a,b),Ek(a,B()),c;if(6===c)throw Error(p(345));a.finishedWork=a.current.alternate;a.finishedLanes=b;Qk(a,uk,vk);Ek(a,B());return null}
function Rk(a,b){var c=K;K|=1;try{return a(b)}finally{K=c,0===K&&(Hj=B()+500,fg&&jg())}}function Sk(a){null!==xk&&0===xk.tag&&0===(K&6)&&Ik();var b=K;K|=1;var c=pk.transition,d=C;try{if(pk.transition=null,C=1,a)return a()}finally{C=d,pk.transition=c,K=b,0===(K&6)&&jg()}}function Ij(){gj=fj.current;E(fj)}
function Lk(a,b){a.finishedWork=null;a.finishedLanes=0;var c=a.timeoutHandle;-1!==c&&(a.timeoutHandle=-1,Gf(c));if(null!==Y)for(c=Y.return;null!==c;){var d=c;wg(d);switch(d.tag){case 1:d=d.type.childContextTypes;null!==d&&void 0!==d&&$f();break;case 3:Jh();E(Wf);E(H);Oh();break;case 5:Lh(d);break;case 4:Jh();break;case 13:E(M);break;case 19:E(M);break;case 10:Rg(d.type._context);break;case 22:case 23:Ij()}c=c.return}R=a;Y=a=wh(a.current,null);Z=gj=b;T=0;qk=null;sk=rk=hh=0;uk=tk=null;if(null!==Wg){for(b=
0;b<Wg.length;b++)if(c=Wg[b],d=c.interleaved,null!==d){c.interleaved=null;var e=d.next,f=c.pending;if(null!==f){var g=f.next;f.next=e;d.next=g}c.pending=d}Wg=null}return a}
function Nk(a,b){do{var c=Y;try{Qg();Ph.current=ai;if(Sh){for(var d=N.memoizedState;null!==d;){var e=d.queue;null!==e&&(e.pending=null);d=d.next}Sh=!1}Rh=0;P=O=N=null;Th=!1;Uh=0;ok.current=null;if(null===c||null===c.return){T=1;qk=b;Y=null;break}a:{var f=a,g=c.return,h=c,k=b;b=Z;h.flags|=32768;if(null!==k&&"object"===typeof k&&"function"===typeof k.then){var l=k,m=h,q=m.tag;if(0===(m.mode&1)&&(0===q||11===q||15===q)){var r=m.alternate;r?(m.updateQueue=r.updateQueue,m.memoizedState=r.memoizedState,
m.lanes=r.lanes):(m.updateQueue=null,m.memoizedState=null)}var y=Vi(g);if(null!==y){y.flags&=-257;Wi(y,g,h,f,b);y.mode&1&&Ti(f,l,b);b=y;k=l;var n=b.updateQueue;if(null===n){var t=new Set;t.add(k);b.updateQueue=t}else n.add(k);break a}else{if(0===(b&1)){Ti(f,l,b);uj();break a}k=Error(p(426))}}else if(I&&h.mode&1){var J=Vi(g);if(null!==J){0===(J.flags&65536)&&(J.flags|=256);Wi(J,g,h,f,b);Jg(Ki(k,h));break a}}f=k=Ki(k,h);4!==T&&(T=2);null===tk?tk=[f]:tk.push(f);f=g;do{switch(f.tag){case 3:f.flags|=65536;
b&=-b;f.lanes|=b;var x=Oi(f,k,b);fh(f,x);break a;case 1:h=k;var w=f.type,u=f.stateNode;if(0===(f.flags&128)&&("function"===typeof w.getDerivedStateFromError||null!==u&&"function"===typeof u.componentDidCatch&&(null===Si||!Si.has(u)))){f.flags|=65536;b&=-b;f.lanes|=b;var F=Ri(f,h,b);fh(f,F);break a}}f=f.return}while(null!==f)}Tk(c)}catch(na){b=na;Y===c&&null!==c&&(Y=c=c.return);continue}break}while(1)}function Kk(){var a=nk.current;nk.current=ai;return null===a?ai:a}
function uj(){if(0===T||3===T||2===T)T=4;null===R||0===(hh&268435455)&&0===(rk&268435455)||Dk(R,Z)}function Jk(a,b){var c=K;K|=2;var d=Kk();if(R!==a||Z!==b)vk=null,Lk(a,b);do try{Uk();break}catch(e){Nk(a,e)}while(1);Qg();K=c;nk.current=d;if(null!==Y)throw Error(p(261));R=null;Z=0;return T}function Uk(){for(;null!==Y;)Vk(Y)}function Mk(){for(;null!==Y&&!cc();)Vk(Y)}function Vk(a){var b=Wk(a.alternate,a,gj);a.memoizedProps=a.pendingProps;null===b?Tk(a):Y=b;ok.current=null}
function Tk(a){var b=a;do{var c=b.alternate;a=b.return;if(0===(b.flags&32768)){if(c=Fj(c,b,gj),null!==c){Y=c;return}}else{c=Jj(c,b);if(null!==c){c.flags&=32767;Y=c;return}if(null!==a)a.flags|=32768,a.subtreeFlags=0,a.deletions=null;else{T=6;Y=null;return}}b=b.sibling;if(null!==b){Y=b;return}Y=b=a}while(null!==b);0===T&&(T=5)}function Qk(a,b,c){var d=C,e=pk.transition;try{pk.transition=null,C=1,Xk(a,b,c,d)}finally{pk.transition=e,C=d}return null}
function Xk(a,b,c,d){do Ik();while(null!==xk);if(0!==(K&6))throw Error(p(327));c=a.finishedWork;var e=a.finishedLanes;if(null===c)return null;a.finishedWork=null;a.finishedLanes=0;if(c===a.current)throw Error(p(177));a.callbackNode=null;a.callbackPriority=0;var f=c.lanes|c.childLanes;Bc(a,f);a===R&&(Y=R=null,Z=0);0===(c.subtreeFlags&2064)&&0===(c.flags&2064)||wk||(wk=!0,Gk(hc,function(){Ik();return null}));f=0!==(c.flags&15990);if(0!==(c.subtreeFlags&15990)||f){f=pk.transition;pk.transition=null;
var g=C;C=1;var h=K;K|=4;ok.current=null;Pj(a,c);ek(c,a);Oe(Df);dd=!!Cf;Df=Cf=null;a.current=c;ik(c,a,e);dc();K=h;C=g;pk.transition=f}else a.current=c;wk&&(wk=!1,xk=a,yk=e);f=a.pendingLanes;0===f&&(Si=null);mc(c.stateNode,d);Ek(a,B());if(null!==b)for(d=a.onRecoverableError,c=0;c<b.length;c++)e=b[c],d(e.value,{componentStack:e.stack,digest:e.digest});if(Pi)throw Pi=!1,a=Qi,Qi=null,a;0!==(yk&1)&&0!==a.tag&&Ik();f=a.pendingLanes;0!==(f&1)?a===Ak?zk++:(zk=0,Ak=a):zk=0;jg();return null}
function Ik(){if(null!==xk){var a=Dc(yk),b=pk.transition,c=C;try{pk.transition=null;C=16>a?16:a;if(null===xk)var d=!1;else{a=xk;xk=null;yk=0;if(0!==(K&6))throw Error(p(331));var e=K;K|=4;for(V=a.current;null!==V;){var f=V,g=f.child;if(0!==(V.flags&16)){var h=f.deletions;if(null!==h){for(var k=0;k<h.length;k++){var l=h[k];for(V=l;null!==V;){var m=V;switch(m.tag){case 0:case 11:case 15:Qj(8,m,f)}var q=m.child;if(null!==q)q.return=m,V=q;else for(;null!==V;){m=V;var r=m.sibling,y=m.return;Tj(m);if(m===
l){V=null;break}if(null!==r){r.return=y;V=r;break}V=y}}}var n=f.alternate;if(null!==n){var t=n.child;if(null!==t){n.child=null;do{var J=t.sibling;t.sibling=null;t=J}while(null!==t)}}V=f}}if(0!==(f.subtreeFlags&2064)&&null!==g)g.return=f,V=g;else b:for(;null!==V;){f=V;if(0!==(f.flags&2048))switch(f.tag){case 0:case 11:case 15:Qj(9,f,f.return)}var x=f.sibling;if(null!==x){x.return=f.return;V=x;break b}V=f.return}}var w=a.current;for(V=w;null!==V;){g=V;var u=g.child;if(0!==(g.subtreeFlags&2064)&&null!==
u)u.return=g,V=u;else b:for(g=w;null!==V;){h=V;if(0!==(h.flags&2048))try{switch(h.tag){case 0:case 11:case 15:Rj(9,h)}}catch(na){W(h,h.return,na)}if(h===g){V=null;break b}var F=h.sibling;if(null!==F){F.return=h.return;V=F;break b}V=h.return}}K=e;jg();if(lc&&"function"===typeof lc.onPostCommitFiberRoot)try{lc.onPostCommitFiberRoot(kc,a)}catch(na){}d=!0}return d}finally{C=c,pk.transition=b}}return!1}function Yk(a,b,c){b=Ki(c,b);b=Oi(a,b,1);a=dh(a,b,1);b=L();null!==a&&(Ac(a,1,b),Ek(a,b))}
function W(a,b,c){if(3===a.tag)Yk(a,a,c);else for(;null!==b;){if(3===b.tag){Yk(b,a,c);break}else if(1===b.tag){var d=b.stateNode;if("function"===typeof b.type.getDerivedStateFromError||"function"===typeof d.componentDidCatch&&(null===Si||!Si.has(d))){a=Ki(c,a);a=Ri(b,a,1);b=dh(b,a,1);a=L();null!==b&&(Ac(b,1,a),Ek(b,a));break}}b=b.return}}
function Ui(a,b,c){var d=a.pingCache;null!==d&&d.delete(b);b=L();a.pingedLanes|=a.suspendedLanes&c;R===a&&(Z&c)===c&&(4===T||3===T&&(Z&130023424)===Z&&500>B()-gk?Lk(a,0):sk|=c);Ek(a,b)}function Zk(a,b){0===b&&(0===(a.mode&1)?b=1:(b=sc,sc<<=1,0===(sc&130023424)&&(sc=4194304)));var c=L();a=Zg(a,b);null!==a&&(Ac(a,b,c),Ek(a,c))}function vj(a){var b=a.memoizedState,c=0;null!==b&&(c=b.retryLane);Zk(a,c)}
function ck(a,b){var c=0;switch(a.tag){case 13:var d=a.stateNode;var e=a.memoizedState;null!==e&&(c=e.retryLane);break;case 19:d=a.stateNode;break;default:throw Error(p(314));}null!==d&&d.delete(b);Zk(a,c)}var Wk;
Wk=function(a,b,c){if(null!==a)if(a.memoizedProps!==b.pendingProps||Wf.current)Ug=!0;else{if(0===(a.lanes&c)&&0===(b.flags&128))return Ug=!1,zj(a,b,c);Ug=0!==(a.flags&131072)?!0:!1}else Ug=!1,I&&0!==(b.flags&1048576)&&ug(b,ng,b.index);b.lanes=0;switch(b.tag){case 2:var d=b.type;jj(a,b);a=b.pendingProps;var e=Yf(b,H.current);Tg(b,c);e=Xh(null,b,d,a,e,c);var f=bi();b.flags|=1;"object"===typeof e&&null!==e&&"function"===typeof e.render&&void 0===e.$$typeof?(b.tag=1,b.memoizedState=null,b.updateQueue=
null,Zf(d)?(f=!0,cg(b)):f=!1,b.memoizedState=null!==e.state&&void 0!==e.state?e.state:null,ah(b),e.updater=nh,b.stateNode=e,e._reactInternals=b,rh(b,d,a,c),b=kj(null,b,d,!0,f,c)):(b.tag=0,I&&f&&vg(b),Yi(null,b,e,c),b=b.child);return b;case 16:d=b.elementType;a:{jj(a,b);a=b.pendingProps;e=d._init;d=e(d._payload);b.type=d;e=b.tag=$k(d);a=Lg(d,a);switch(e){case 0:b=dj(null,b,d,a,c);break a;case 1:b=ij(null,b,d,a,c);break a;case 11:b=Zi(null,b,d,a,c);break a;case 14:b=aj(null,b,d,Lg(d.type,a),c);break a}throw Error(p(306,
d,""));}return b;case 0:return d=b.type,e=b.pendingProps,e=b.elementType===d?e:Lg(d,e),dj(a,b,d,e,c);case 1:return d=b.type,e=b.pendingProps,e=b.elementType===d?e:Lg(d,e),ij(a,b,d,e,c);case 3:a:{lj(b);if(null===a)throw Error(p(387));d=b.pendingProps;f=b.memoizedState;e=f.element;bh(a,b);gh(b,d,null,c);var g=b.memoizedState;d=g.element;if(f.isDehydrated)if(f={element:d,isDehydrated:!1,cache:g.cache,pendingSuspenseBoundaries:g.pendingSuspenseBoundaries,transitions:g.transitions},b.updateQueue.baseState=
f,b.memoizedState=f,b.flags&256){e=Ki(Error(p(423)),b);b=mj(a,b,d,c,e);break a}else if(d!==e){e=Ki(Error(p(424)),b);b=mj(a,b,d,c,e);break a}else for(yg=Lf(b.stateNode.containerInfo.firstChild),xg=b,I=!0,zg=null,c=Ch(b,null,d,c),b.child=c;c;)c.flags=c.flags&-3|4096,c=c.sibling;else{Ig();if(d===e){b=$i(a,b,c);break a}Yi(a,b,d,c)}b=b.child}return b;case 5:return Kh(b),null===a&&Eg(b),d=b.type,e=b.pendingProps,f=null!==a?a.memoizedProps:null,g=e.children,Ef(d,e)?g=null:null!==f&&Ef(d,f)&&(b.flags|=32),
hj(a,b),Yi(a,b,g,c),b.child;case 6:return null===a&&Eg(b),null;case 13:return pj(a,b,c);case 4:return Ih(b,b.stateNode.containerInfo),d=b.pendingProps,null===a?b.child=Bh(b,null,d,c):Yi(a,b,d,c),b.child;case 11:return d=b.type,e=b.pendingProps,e=b.elementType===d?e:Lg(d,e),Zi(a,b,d,e,c);case 7:return Yi(a,b,b.pendingProps,c),b.child;case 8:return Yi(a,b,b.pendingProps.children,c),b.child;case 12:return Yi(a,b,b.pendingProps.children,c),b.child;case 10:a:{d=b.type._context;e=b.pendingProps;f=b.memoizedProps;
g=e.value;G(Mg,d._currentValue);d._currentValue=g;if(null!==f)if(He(f.value,g)){if(f.children===e.children&&!Wf.current){b=$i(a,b,c);break a}}else for(f=b.child,null!==f&&(f.return=b);null!==f;){var h=f.dependencies;if(null!==h){g=f.child;for(var k=h.firstContext;null!==k;){if(k.context===d){if(1===f.tag){k=ch(-1,c&-c);k.tag=2;var l=f.updateQueue;if(null!==l){l=l.shared;var m=l.pending;null===m?k.next=k:(k.next=m.next,m.next=k);l.pending=k}}f.lanes|=c;k=f.alternate;null!==k&&(k.lanes|=c);Sg(f.return,
c,b);h.lanes|=c;break}k=k.next}}else if(10===f.tag)g=f.type===b.type?null:f.child;else if(18===f.tag){g=f.return;if(null===g)throw Error(p(341));g.lanes|=c;h=g.alternate;null!==h&&(h.lanes|=c);Sg(g,c,b);g=f.sibling}else g=f.child;if(null!==g)g.return=f;else for(g=f;null!==g;){if(g===b){g=null;break}f=g.sibling;if(null!==f){f.return=g.return;g=f;break}g=g.return}f=g}Yi(a,b,e.children,c);b=b.child}return b;case 9:return e=b.type,d=b.pendingProps.children,Tg(b,c),e=Vg(e),d=d(e),b.flags|=1,Yi(a,b,d,c),
b.child;case 14:return d=b.type,e=Lg(d,b.pendingProps),e=Lg(d.type,e),aj(a,b,d,e,c);case 15:return cj(a,b,b.type,b.pendingProps,c);case 17:return d=b.type,e=b.pendingProps,e=b.elementType===d?e:Lg(d,e),jj(a,b),b.tag=1,Zf(d)?(a=!0,cg(b)):a=!1,Tg(b,c),ph(b,d,e),rh(b,d,e,c),kj(null,b,d,!0,a,c);case 19:return yj(a,b,c);case 22:return ej(a,b,c)}throw Error(p(156,b.tag));};function Gk(a,b){return ac(a,b)}
function al(a,b,c,d){this.tag=a;this.key=c;this.sibling=this.child=this.return=this.stateNode=this.type=this.elementType=null;this.index=0;this.ref=null;this.pendingProps=b;this.dependencies=this.memoizedState=this.updateQueue=this.memoizedProps=null;this.mode=d;this.subtreeFlags=this.flags=0;this.deletions=null;this.childLanes=this.lanes=0;this.alternate=null}function Bg(a,b,c,d){return new al(a,b,c,d)}function bj(a){a=a.prototype;return!(!a||!a.isReactComponent)}
function $k(a){if("function"===typeof a)return bj(a)?1:0;if(void 0!==a&&null!==a){a=a.$$typeof;if(a===Da)return 11;if(a===Ga)return 14}return 2}
function wh(a,b){var c=a.alternate;null===c?(c=Bg(a.tag,b,a.key,a.mode),c.elementType=a.elementType,c.type=a.type,c.stateNode=a.stateNode,c.alternate=a,a.alternate=c):(c.pendingProps=b,c.type=a.type,c.flags=0,c.subtreeFlags=0,c.deletions=null);c.flags=a.flags&14680064;c.childLanes=a.childLanes;c.lanes=a.lanes;c.child=a.child;c.memoizedProps=a.memoizedProps;c.memoizedState=a.memoizedState;c.updateQueue=a.updateQueue;b=a.dependencies;c.dependencies=null===b?null:{lanes:b.lanes,firstContext:b.firstContext};
c.sibling=a.sibling;c.index=a.index;c.ref=a.ref;return c}
function yh(a,b,c,d,e,f){var g=2;d=a;if("function"===typeof a)bj(a)&&(g=1);else if("string"===typeof a)g=5;else a:switch(a){case ya:return Ah(c.children,e,f,b);case za:g=8;e|=8;break;case Aa:return a=Bg(12,c,b,e|2),a.elementType=Aa,a.lanes=f,a;case Ea:return a=Bg(13,c,b,e),a.elementType=Ea,a.lanes=f,a;case Fa:return a=Bg(19,c,b,e),a.elementType=Fa,a.lanes=f,a;case Ia:return qj(c,e,f,b);default:if("object"===typeof a&&null!==a)switch(a.$$typeof){case Ba:g=10;break a;case Ca:g=9;break a;case Da:g=11;
break a;case Ga:g=14;break a;case Ha:g=16;d=null;break a}throw Error(p(130,null==a?a:typeof a,""));}b=Bg(g,c,b,e);b.elementType=a;b.type=d;b.lanes=f;return b}function Ah(a,b,c,d){a=Bg(7,a,d,b);a.lanes=c;return a}function qj(a,b,c,d){a=Bg(22,a,d,b);a.elementType=Ia;a.lanes=c;a.stateNode={isHidden:!1};return a}function xh(a,b,c){a=Bg(6,a,null,b);a.lanes=c;return a}
function zh(a,b,c){b=Bg(4,null!==a.children?a.children:[],a.key,b);b.lanes=c;b.stateNode={containerInfo:a.containerInfo,pendingChildren:null,implementation:a.implementation};return b}
function bl(a,b,c,d,e){this.tag=b;this.containerInfo=a;this.finishedWork=this.pingCache=this.current=this.pendingChildren=null;this.timeoutHandle=-1;this.callbackNode=this.pendingContext=this.context=null;this.callbackPriority=0;this.eventTimes=zc(0);this.expirationTimes=zc(-1);this.entangledLanes=this.finishedLanes=this.mutableReadLanes=this.expiredLanes=this.pingedLanes=this.suspendedLanes=this.pendingLanes=0;this.entanglements=zc(0);this.identifierPrefix=d;this.onRecoverableError=e;this.mutableSourceEagerHydrationData=
null}function cl(a,b,c,d,e,f,g,h,k){a=new bl(a,b,c,h,k);1===b?(b=1,!0===f&&(b|=8)):b=0;f=Bg(3,null,null,b);a.current=f;f.stateNode=a;f.memoizedState={element:d,isDehydrated:c,cache:null,transitions:null,pendingSuspenseBoundaries:null};ah(f);return a}function dl(a,b,c){var d=3<arguments.length&&void 0!==arguments[3]?arguments[3]:null;return{$$typeof:wa,key:null==d?null:""+d,children:a,containerInfo:b,implementation:c}}
function el(a){if(!a)return Vf;a=a._reactInternals;a:{if(Vb(a)!==a||1!==a.tag)throw Error(p(170));var b=a;do{switch(b.tag){case 3:b=b.stateNode.context;break a;case 1:if(Zf(b.type)){b=b.stateNode.__reactInternalMemoizedMergedChildContext;break a}}b=b.return}while(null!==b);throw Error(p(171));}if(1===a.tag){var c=a.type;if(Zf(c))return bg(a,c,b)}return b}
function fl(a,b,c,d,e,f,g,h,k){a=cl(c,d,!0,a,e,f,g,h,k);a.context=el(null);c=a.current;d=L();e=lh(c);f=ch(d,e);f.callback=void 0!==b&&null!==b?b:null;dh(c,f,e);a.current.lanes=e;Ac(a,e,d);Ek(a,d);return a}function gl(a,b,c,d){var e=b.current,f=L(),g=lh(e);c=el(c);null===b.context?b.context=c:b.pendingContext=c;b=ch(f,g);b.payload={element:a};d=void 0===d?null:d;null!==d&&(b.callback=d);a=dh(e,b,g);null!==a&&(mh(a,e,g,f),eh(a,e,g));return g}
function hl(a){a=a.current;if(!a.child)return null;switch(a.child.tag){case 5:return a.child.stateNode;default:return a.child.stateNode}}function il(a,b){a=a.memoizedState;if(null!==a&&null!==a.dehydrated){var c=a.retryLane;a.retryLane=0!==c&&c<b?c:b}}function jl(a,b){il(a,b);(a=a.alternate)&&il(a,b)}function kl(){return null}var ll="function"===typeof reportError?reportError:function(a){console.error(a)};function ml(a){this._internalRoot=a}
nl.prototype.render=ml.prototype.render=function(a){var b=this._internalRoot;if(null===b)throw Error(p(409));gl(a,b,null,null)};nl.prototype.unmount=ml.prototype.unmount=function(){var a=this._internalRoot;if(null!==a){this._internalRoot=null;var b=a.containerInfo;Sk(function(){gl(null,a,null,null)});b[uf]=null}};function nl(a){this._internalRoot=a}
nl.prototype.unstable_scheduleHydration=function(a){if(a){var b=Hc();a={blockedOn:null,target:a,priority:b};for(var c=0;c<Qc.length&&0!==b&&b<Qc[c].priority;c++);Qc.splice(c,0,a);0===c&&Vc(a)}};function ol(a){return!(!a||1!==a.nodeType&&9!==a.nodeType&&11!==a.nodeType)}function pl(a){return!(!a||1!==a.nodeType&&9!==a.nodeType&&11!==a.nodeType&&(8!==a.nodeType||" react-mount-point-unstable "!==a.nodeValue))}function ql(){}
function rl(a,b,c,d,e){if(e){if("function"===typeof d){var f=d;d=function(){var a=hl(g);f.call(a)}}var g=fl(b,d,a,0,null,!1,!1,"",ql);a._reactRootContainer=g;a[uf]=g.current;sf(8===a.nodeType?a.parentNode:a);Sk();return g}for(;e=a.lastChild;)a.removeChild(e);if("function"===typeof d){var h=d;d=function(){var a=hl(k);h.call(a)}}var k=cl(a,0,!1,null,null,!1,!1,"",ql);a._reactRootContainer=k;a[uf]=k.current;sf(8===a.nodeType?a.parentNode:a);Sk(function(){gl(b,k,c,d)});return k}
function sl(a,b,c,d,e){var f=c._reactRootContainer;if(f){var g=f;if("function"===typeof e){var h=e;e=function(){var a=hl(g);h.call(a)}}gl(b,g,a,e)}else g=rl(c,b,a,e,d);return hl(g)}Ec=function(a){switch(a.tag){case 3:var b=a.stateNode;if(b.current.memoizedState.isDehydrated){var c=tc(b.pendingLanes);0!==c&&(Cc(b,c|1),Ek(b,B()),0===(K&6)&&(Hj=B()+500,jg()))}break;case 13:Sk(function(){var b=Zg(a,1);if(null!==b){var c=L();mh(b,a,1,c)}}),jl(a,1)}};
Fc=function(a){if(13===a.tag){var b=Zg(a,134217728);if(null!==b){var c=L();mh(b,a,134217728,c)}jl(a,134217728)}};Gc=function(a){if(13===a.tag){var b=lh(a),c=Zg(a,b);if(null!==c){var d=L();mh(c,a,b,d)}jl(a,b)}};Hc=function(){return C};Ic=function(a,b){var c=C;try{return C=a,b()}finally{C=c}};
yb=function(a,b,c){switch(b){case "input":bb(a,c);b=c.name;if("radio"===c.type&&null!=b){for(c=a;c.parentNode;)c=c.parentNode;c=c.querySelectorAll("input[name="+JSON.stringify(""+b)+'][type="radio"]');for(b=0;b<c.length;b++){var d=c[b];if(d!==a&&d.form===a.form){var e=Db(d);if(!e)throw Error(p(90));Wa(d);bb(d,e)}}}break;case "textarea":ib(a,c);break;case "select":b=c.value,null!=b&&fb(a,!!c.multiple,b,!1)}};Gb=Rk;Hb=Sk;
var tl={usingClientEntryPoint:!1,Events:[Cb,ue,Db,Eb,Fb,Rk]},ul={findFiberByHostInstance:Wc,bundleType:0,version:"18.2.0",rendererPackageName:"react-dom"};
var vl={bundleType:ul.bundleType,version:ul.version,rendererPackageName:ul.rendererPackageName,rendererConfig:ul.rendererConfig,overrideHookState:null,overrideHookStateDeletePath:null,overrideHookStateRenamePath:null,overrideProps:null,overridePropsDeletePath:null,overridePropsRenamePath:null,setErrorHandler:null,setSuspenseHandler:null,scheduleUpdate:null,currentDispatcherRef:ua.ReactCurrentDispatcher,findHostInstanceByFiber:function(a){a=Zb(a);return null===a?null:a.stateNode},findFiberByHostInstance:ul.findFiberByHostInstance||
kl,findHostInstancesForRefresh:null,scheduleRefresh:null,scheduleRoot:null,setRefreshHandler:null,getCurrentFiber:null,reconcilerVersion:"18.2.0-next-9e3b772b8-20220608"};if("undefined"!==typeof __REACT_DEVTOOLS_GLOBAL_HOOK__){var wl=__REACT_DEVTOOLS_GLOBAL_HOOK__;if(!wl.isDisabled&&wl.supportsFiber)try{kc=wl.inject(vl),lc=wl}catch(a){}}exports.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED=tl;
exports.createPortal=function(a,b){var c=2<arguments.length&&void 0!==arguments[2]?arguments[2]:null;if(!ol(b))throw Error(p(200));return dl(a,b,null,c)};exports.createRoot=function(a,b){if(!ol(a))throw Error(p(299));var c=!1,d="",e=ll;null!==b&&void 0!==b&&(!0===b.unstable_strictMode&&(c=!0),void 0!==b.identifierPrefix&&(d=b.identifierPrefix),void 0!==b.onRecoverableError&&(e=b.onRecoverableError));b=cl(a,1,!1,null,null,c,!1,d,e);a[uf]=b.current;sf(8===a.nodeType?a.parentNode:a);return new ml(b)};
exports.findDOMNode=function(a){if(null==a)return null;if(1===a.nodeType)return a;var b=a._reactInternals;if(void 0===b){if("function"===typeof a.render)throw Error(p(188));a=Object.keys(a).join(",");throw Error(p(268,a));}a=Zb(b);a=null===a?null:a.stateNode;return a};exports.flushSync=function(a){return Sk(a)};exports.hydrate=function(a,b,c){if(!pl(b))throw Error(p(200));return sl(null,a,b,!0,c)};
exports.hydrateRoot=function(a,b,c){if(!ol(a))throw Error(p(405));var d=null!=c&&c.hydratedSources||null,e=!1,f="",g=ll;null!==c&&void 0!==c&&(!0===c.unstable_strictMode&&(e=!0),void 0!==c.identifierPrefix&&(f=c.identifierPrefix),void 0!==c.onRecoverableError&&(g=c.onRecoverableError));b=fl(b,null,a,1,null!=c?c:null,e,!1,f,g);a[uf]=b.current;sf(a);if(d)for(a=0;a<d.length;a++)c=d[a],e=c._getVersion,e=e(c._source),null==b.mutableSourceEagerHydrationData?b.mutableSourceEagerHydrationData=[c,e]:b.mutableSourceEagerHydrationData.push(c,
e);return new nl(b)};exports.render=function(a,b,c){if(!pl(b))throw Error(p(200));return sl(null,a,b,!1,c)};exports.unmountComponentAtNode=function(a){if(!pl(a))throw Error(p(40));return a._reactRootContainer?(Sk(function(){sl(null,null,a,!1,function(){a._reactRootContainer=null;a[uf]=null})}),!0):!1};exports.unstable_batchedUpdates=Rk;
exports.unstable_renderSubtreeIntoContainer=function(a,b,c,d){if(!pl(c))throw Error(p(200));if(null==a||void 0===a._reactInternals)throw Error(p(38));return sl(a,b,c,!1,d)};exports.version="18.2.0-next-9e3b772b8-20220608";


/***/ }),

/***/ 5338:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {

"use strict";
var __webpack_unused_export__;


var m = __webpack_require__(961);
if (true) {
  exports.H = m.createRoot;
  __webpack_unused_export__ = m.hydrateRoot;
} else { var i; }


/***/ }),

/***/ 961:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

"use strict";


function checkDCE() {
  /* global __REACT_DEVTOOLS_GLOBAL_HOOK__ */
  if (
    typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ === 'undefined' ||
    typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE !== 'function'
  ) {
    return;
  }
  if (false) {}
  try {
    // Verify that the code above has been dead code eliminated (DCE'd).
    __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(checkDCE);
  } catch (err) {
    // DevTools shouldn't crash React, no matter what.
    // We should still report in case we break this code.
    console.error(err);
  }
}

if (true) {
  // DCE check should happen before ReactDOM bundle executes so that
  // DevTools can report bad minification during injection.
  checkDCE();
  module.exports = __webpack_require__(2551);
} else {}


/***/ }),

/***/ 1020:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {

"use strict";
/**
 * @license React
 * react-jsx-runtime.production.min.js
 *
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var f=__webpack_require__(6540),k=Symbol.for("react.element"),l=Symbol.for("react.fragment"),m=Object.prototype.hasOwnProperty,n=f.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentOwner,p={key:!0,ref:!0,__self:!0,__source:!0};
function q(c,a,g){var b,d={},e=null,h=null;void 0!==g&&(e=""+g);void 0!==a.key&&(e=""+a.key);void 0!==a.ref&&(h=a.ref);for(b in a)m.call(a,b)&&!p.hasOwnProperty(b)&&(d[b]=a[b]);if(c&&c.defaultProps)for(b in a=c.defaultProps,a)void 0===d[b]&&(d[b]=a[b]);return{$$typeof:k,type:c,key:e,ref:h,props:d,_owner:n.current}}exports.Fragment=l;exports.jsx=q;exports.jsxs=q;


/***/ }),

/***/ 5287:
/***/ ((__unused_webpack_module, exports) => {

"use strict";
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
var U={current:null},V={transition:null},W={ReactCurrentDispatcher:U,ReactCurrentBatchConfig:V,ReactCurrentOwner:K};exports.Children={map:S,forEach:function(a,b,e){S(a,function(){b.apply(this,arguments)},e)},count:function(a){var b=0;S(a,function(){b++});return b},toArray:function(a){return S(a,function(a){return a})||[]},only:function(a){if(!O(a))throw Error("React.Children.only expected to receive a single React element child.");return a}};exports.Component=E;exports.Fragment=p;
exports.Profiler=r;exports.PureComponent=G;exports.StrictMode=q;exports.Suspense=w;exports.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED=W;
exports.cloneElement=function(a,b,e){if(null===a||void 0===a)throw Error("React.cloneElement(...): The argument must be a React element, but you passed "+a+".");var d=C({},a.props),c=a.key,k=a.ref,h=a._owner;if(null!=b){void 0!==b.ref&&(k=b.ref,h=K.current);void 0!==b.key&&(c=""+b.key);if(a.type&&a.type.defaultProps)var g=a.type.defaultProps;for(f in b)J.call(b,f)&&!L.hasOwnProperty(f)&&(d[f]=void 0===b[f]&&void 0!==g?g[f]:b[f])}var f=arguments.length-2;if(1===f)d.children=e;else if(1<f){g=Array(f);
for(var m=0;m<f;m++)g[m]=arguments[m+2];d.children=g}return{$$typeof:l,type:a.type,key:c,ref:k,props:d,_owner:h}};exports.createContext=function(a){a={$$typeof:u,_currentValue:a,_currentValue2:a,_threadCount:0,Provider:null,Consumer:null,_defaultValue:null,_globalName:null};a.Provider={$$typeof:t,_context:a};return a.Consumer=a};exports.createElement=M;exports.createFactory=function(a){var b=M.bind(null,a);b.type=a;return b};exports.createRef=function(){return{current:null}};
exports.forwardRef=function(a){return{$$typeof:v,render:a}};exports.isValidElement=O;exports.lazy=function(a){return{$$typeof:y,_payload:{_status:-1,_result:a},_init:T}};exports.memo=function(a,b){return{$$typeof:x,type:a,compare:void 0===b?null:b}};exports.startTransition=function(a){var b=V.transition;V.transition={};try{a()}finally{V.transition=b}};exports.unstable_act=function(){throw Error("act(...) is not supported in production builds of React.");};
exports.useCallback=function(a,b){return U.current.useCallback(a,b)};exports.useContext=function(a){return U.current.useContext(a)};exports.useDebugValue=function(){};exports.useDeferredValue=function(a){return U.current.useDeferredValue(a)};exports.useEffect=function(a,b){return U.current.useEffect(a,b)};exports.useId=function(){return U.current.useId()};exports.useImperativeHandle=function(a,b,e){return U.current.useImperativeHandle(a,b,e)};
exports.useInsertionEffect=function(a,b){return U.current.useInsertionEffect(a,b)};exports.useLayoutEffect=function(a,b){return U.current.useLayoutEffect(a,b)};exports.useMemo=function(a,b){return U.current.useMemo(a,b)};exports.useReducer=function(a,b,e){return U.current.useReducer(a,b,e)};exports.useRef=function(a){return U.current.useRef(a)};exports.useState=function(a){return U.current.useState(a)};exports.useSyncExternalStore=function(a,b,e){return U.current.useSyncExternalStore(a,b,e)};
exports.useTransition=function(){return U.current.useTransition()};exports.version="18.2.0";


/***/ }),

/***/ 6540:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

"use strict";


if (true) {
  module.exports = __webpack_require__(5287);
} else {}


/***/ }),

/***/ 4848:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

"use strict";


if (true) {
  module.exports = __webpack_require__(1020);
} else {}


/***/ }),

/***/ 7463:
/***/ ((__unused_webpack_module, exports) => {

"use strict";
/**
 * @license React
 * scheduler.production.min.js
 *
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
function f(a,b){var c=a.length;a.push(b);a:for(;0<c;){var d=c-1>>>1,e=a[d];if(0<g(e,b))a[d]=b,a[c]=e,c=d;else break a}}function h(a){return 0===a.length?null:a[0]}function k(a){if(0===a.length)return null;var b=a[0],c=a.pop();if(c!==b){a[0]=c;a:for(var d=0,e=a.length,w=e>>>1;d<w;){var m=2*(d+1)-1,C=a[m],n=m+1,x=a[n];if(0>g(C,c))n<e&&0>g(x,C)?(a[d]=x,a[n]=c,d=n):(a[d]=C,a[m]=c,d=m);else if(n<e&&0>g(x,c))a[d]=x,a[n]=c,d=n;else break a}}return b}
function g(a,b){var c=a.sortIndex-b.sortIndex;return 0!==c?c:a.id-b.id}if("object"===typeof performance&&"function"===typeof performance.now){var l=performance;exports.unstable_now=function(){return l.now()}}else{var p=Date,q=p.now();exports.unstable_now=function(){return p.now()-q}}var r=[],t=[],u=1,v=null,y=3,z=!1,A=!1,B=!1,D="function"===typeof setTimeout?setTimeout:null,E="function"===typeof clearTimeout?clearTimeout:null,F="undefined"!==typeof setImmediate?setImmediate:null;
"undefined"!==typeof navigator&&void 0!==navigator.scheduling&&void 0!==navigator.scheduling.isInputPending&&navigator.scheduling.isInputPending.bind(navigator.scheduling);function G(a){for(var b=h(t);null!==b;){if(null===b.callback)k(t);else if(b.startTime<=a)k(t),b.sortIndex=b.expirationTime,f(r,b);else break;b=h(t)}}function H(a){B=!1;G(a);if(!A)if(null!==h(r))A=!0,I(J);else{var b=h(t);null!==b&&K(H,b.startTime-a)}}
function J(a,b){A=!1;B&&(B=!1,E(L),L=-1);z=!0;var c=y;try{G(b);for(v=h(r);null!==v&&(!(v.expirationTime>b)||a&&!M());){var d=v.callback;if("function"===typeof d){v.callback=null;y=v.priorityLevel;var e=d(v.expirationTime<=b);b=exports.unstable_now();"function"===typeof e?v.callback=e:v===h(r)&&k(r);G(b)}else k(r);v=h(r)}if(null!==v)var w=!0;else{var m=h(t);null!==m&&K(H,m.startTime-b);w=!1}return w}finally{v=null,y=c,z=!1}}var N=!1,O=null,L=-1,P=5,Q=-1;
function M(){return exports.unstable_now()-Q<P?!1:!0}function R(){if(null!==O){var a=exports.unstable_now();Q=a;var b=!0;try{b=O(!0,a)}finally{b?S():(N=!1,O=null)}}else N=!1}var S;if("function"===typeof F)S=function(){F(R)};else if("undefined"!==typeof MessageChannel){var T=new MessageChannel,U=T.port2;T.port1.onmessage=R;S=function(){U.postMessage(null)}}else S=function(){D(R,0)};function I(a){O=a;N||(N=!0,S())}function K(a,b){L=D(function(){a(exports.unstable_now())},b)}
exports.unstable_IdlePriority=5;exports.unstable_ImmediatePriority=1;exports.unstable_LowPriority=4;exports.unstable_NormalPriority=3;exports.unstable_Profiling=null;exports.unstable_UserBlockingPriority=2;exports.unstable_cancelCallback=function(a){a.callback=null};exports.unstable_continueExecution=function(){A||z||(A=!0,I(J))};
exports.unstable_forceFrameRate=function(a){0>a||125<a?console.error("forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported"):P=0<a?Math.floor(1E3/a):5};exports.unstable_getCurrentPriorityLevel=function(){return y};exports.unstable_getFirstCallbackNode=function(){return h(r)};exports.unstable_next=function(a){switch(y){case 1:case 2:case 3:var b=3;break;default:b=y}var c=y;y=b;try{return a()}finally{y=c}};exports.unstable_pauseExecution=function(){};
exports.unstable_requestPaint=function(){};exports.unstable_runWithPriority=function(a,b){switch(a){case 1:case 2:case 3:case 4:case 5:break;default:a=3}var c=y;y=a;try{return b()}finally{y=c}};
exports.unstable_scheduleCallback=function(a,b,c){var d=exports.unstable_now();"object"===typeof c&&null!==c?(c=c.delay,c="number"===typeof c&&0<c?d+c:d):c=d;switch(a){case 1:var e=-1;break;case 2:e=250;break;case 5:e=1073741823;break;case 4:e=1E4;break;default:e=5E3}e=c+e;a={id:u++,callback:b,priorityLevel:a,startTime:c,expirationTime:e,sortIndex:-1};c>d?(a.sortIndex=c,f(t,a),null===h(r)&&a===h(t)&&(B?(E(L),L=-1):B=!0,K(H,c-d))):(a.sortIndex=e,f(r,a),A||z||(A=!0,I(J)));return a};
exports.unstable_shouldYield=M;exports.unstable_wrapCallback=function(a){var b=y;return function(){var c=y;y=b;try{return a.apply(this,arguments)}finally{y=c}}};


/***/ }),

/***/ 9982:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

"use strict";


if (true) {
  module.exports = __webpack_require__(7463);
} else {}


/***/ }),

/***/ 5632:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
var timeTypes = [
    ['ثانية', 'ثانيتين', '%s ثوان', '%s ثانية'],
    ['دقيقة', 'دقيقتين', '%s دقائق', '%s دقيقة'],
    ['ساعة', 'ساعتين', '%s ساعات', '%s ساعة'],
    ['يوم', 'يومين', '%s أيام', '%s يوماً'],
    ['أسبوع', 'أسبوعين', '%s أسابيع', '%s أسبوعاً'],
    ['شهر', 'شهرين', '%s أشهر', '%s شهراً'],
    ['عام', 'عامين', '%s أعوام', '%s عاماً'],
];
function formatTime(type, n) {
    if (n < 3)
        return timeTypes[type][n - 1];
    if (n >= 3 && n <= 10)
        return timeTypes[type][2];
    return timeTypes[type][3];
}
function default_1(number, index) {
    if (index === 0) {
        return ['منذ لحظات', 'بعد لحظات'];
    }
    var timeStr = formatTime(Math.floor(index / 2), number);
    return ['منذ' + ' ' + timeStr, 'بعد' + ' ' + timeStr];
}
exports["default"] = default_1;
//# sourceMappingURL=ar.js.map

/***/ }),

/***/ 3570:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
/**
 *
 * @param f1 - 1
 * @param f - 21, 31, ...
 * @param s - 2-4, 22-24, 32-34 ...
 * @param t - 5-20, 25-30, ...
 * @param n
 * @returns
 */
function formatNum(f1, f, s, t, n) {
    var n10 = n % 10;
    var str = t;
    if (n === 1) {
        str = f1;
    }
    else if (n10 === 1 && n > 20) {
        str = f;
    }
    else if (n10 > 1 && n10 < 5 && (n > 20 || n < 10)) {
        str = s;
    }
    return str;
}
var seconds = formatNum.bind(null, 'секунду', '%s секунду', '%s секунды', '%s секунд'), minutes = formatNum.bind(null, 'хвіліну', '%s хвіліну', '%s хвіліны', '%s хвілін'), hours = formatNum.bind(null, 'гадзіну', '%s гадзіну', '%s гадзіны', '%s гадзін'), days = formatNum.bind(null, 'дзень', '%s дзень', '%s дні', '%s дзён'), weeks = formatNum.bind(null, 'тыдзень', '%s тыдзень', '%s тыдні', '%s тыдняў'), months = formatNum.bind(null, 'месяц', '%s месяц', '%s месяцы', '%s месяцаў'), years = formatNum.bind(null, 'год', '%s год', '%s гады', '%s гадоў');
function default_1(number, index) {
    switch (index) {
        case 0:
            return ['толькі што', 'праз некалькі секунд'];
        case 1:
            return [seconds(number) + ' таму', 'праз ' + seconds(number)];
        case 2:
        case 3:
            return [minutes(number) + ' таму', 'праз ' + minutes(number)];
        case 4:
        case 5:
            return [hours(number) + ' таму', 'праз ' + hours(number)];
        case 6:
        case 7:
            return [days(number) + ' таму', 'праз ' + days(number)];
        case 8:
        case 9:
            return [weeks(number) + ' таму', 'праз ' + weeks(number)];
        case 10:
        case 11:
            return [months(number) + ' таму', 'праз ' + months(number)];
        case 12:
        case 13:
            return [years(number) + ' таму', 'праз ' + years(number)];
        default:
            return ['', ''];
    }
}
exports["default"] = default_1;
//# sourceMappingURL=be.js.map

/***/ }),

/***/ 6808:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['току що', 'съвсем скоро'],
        ['преди %s секунди', 'след %s секунди'],
        ['преди 1 минута', 'след 1 минута'],
        ['преди %s минути', 'след %s минути'],
        ['преди 1 час', 'след 1 час'],
        ['преди %s часа', 'след %s часа'],
        ['преди 1 ден', 'след 1 ден'],
        ['преди %s дни', 'след %s дни'],
        ['преди 1 седмица', 'след 1 седмица'],
        ['преди %s седмици', 'след %s седмици'],
        ['преди 1 месец', 'след 1 месец'],
        ['преди %s месеца', 'след %s месеца'],
        ['преди 1 година', 'след 1 година'],
        ['преди %s години', 'след %s години'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=bg.js.map

/***/ }),

/***/ 6945:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
// Bangla (India)
function default_1(number, index) {
    return [
        ['এইমাত্র', 'একটা সময়'],
        ['%s সেকেন্ড আগে', '%s এর সেকেন্ডের মধ্যে'],
        ['1 মিনিট আগে', '1 মিনিটে'],
        ['%s এর মিনিট আগে', '%s এর মিনিটের মধ্যে'],
        ['1 ঘন্টা আগে', '1 ঘন্টা'],
        ['%s ঘণ্টা আগে', '%s এর ঘন্টার মধ্যে'],
        ['1 দিন আগে', '1 দিনের মধ্যে'],
        ['%s এর দিন আগে', '%s এর দিন'],
        ['1 সপ্তাহ আগে', '1 সপ্তাহের মধ্যে'],
        ['%s এর সপ্তাহ আগে', '%s সপ্তাহের মধ্যে'],
        ['1 মাস আগে', '1 মাসে'],
        ['%s মাস আগে', '%s মাসে'],
        ['1 বছর আগে', '1 বছরের মধ্যে'],
        ['%s বছর আগে', '%s বছরে'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=bn_IN.js.map

/***/ }),

/***/ 5039:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['fa un moment', "d'aquí un moment"],
        ['fa %s segons', "d'aquí %s segons"],
        ['fa 1 minut', "d'aquí 1 minut"],
        ['fa %s minuts', "d'aquí %s minuts"],
        ['fa 1 hora', "d'aquí 1 hora"],
        ['fa %s hores', "d'aquí %s hores"],
        ['fa 1 dia', "d'aquí 1 dia"],
        ['fa %s dies', "d'aquí %s dies"],
        ['fa 1 setmana', "d'aquí 1 setmana"],
        ['fa %s setmanes', "d'aquí %s setmanes"],
        ['fa 1 mes', "d'aquí 1 mes"],
        ['fa %s mesos', "d'aquí %s mesos"],
        ['fa 1 any', "d'aquí 1 any"],
        ['fa %s anys', "d'aquí %s anys"],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=ca.js.map

/***/ }),

/***/ 3944:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['gerade eben', 'vor einer Weile'],
        ['vor %s Sekunden', 'in %s Sekunden'],
        ['vor 1 Minute', 'in 1 Minute'],
        ['vor %s Minuten', 'in %s Minuten'],
        ['vor 1 Stunde', 'in 1 Stunde'],
        ['vor %s Stunden', 'in %s Stunden'],
        ['vor 1 Tag', 'in 1 Tag'],
        ['vor %s Tagen', 'in %s Tagen'],
        ['vor 1 Woche', 'in 1 Woche'],
        ['vor %s Wochen', 'in %s Wochen'],
        ['vor 1 Monat', 'in 1 Monat'],
        ['vor %s Monaten', 'in %s Monaten'],
        ['vor 1 Jahr', 'in 1 Jahr'],
        ['vor %s Jahren', 'in %s Jahren'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=de.js.map

/***/ }),

/***/ 3802:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['μόλις τώρα', 'σε λίγο'],
        ['%s δευτερόλεπτα πριν', 'σε %s δευτερόλεπτα'],
        ['1 λεπτό πριν', 'σε 1 λεπτό'],
        ['%s λεπτά πριν', 'σε %s λεπτά'],
        ['1 ώρα πριν', 'σε 1 ώρα'],
        ['%s ώρες πριν', 'σε %s ώρες'],
        ['1 μέρα πριν', 'σε 1 μέρα'],
        ['%s μέρες πριν', 'σε %s μέρες'],
        ['1 εβδομάδα πριν', 'σε 1 εβδομάδα'],
        ['%s εβδομάδες πριν', 'σε %s εβδομάδες'],
        ['1 μήνα πριν', 'σε 1 μήνα'],
        ['%s μήνες πριν', 'σε %s μήνες'],
        ['1 χρόνο πριν', 'σε 1 χρόνο'],
        ['%s χρόνια πριν', 'σε %s χρόνια'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=el.js.map

/***/ }),

/***/ 8383:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
var EN_US = ['second', 'minute', 'hour', 'day', 'week', 'month', 'year'];
function default_1(diff, idx) {
    if (idx === 0)
        return ['just now', 'right now'];
    var unit = EN_US[Math.floor(idx / 2)];
    if (diff > 1)
        unit += 's';
    return [diff + " " + unit + " ago", "in " + diff + " " + unit];
}
exports["default"] = default_1;
//# sourceMappingURL=en_US.js.map

/***/ }),

/***/ 2345:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['just now', 'right now'],
        ['%ss ago', 'in %ss'],
        ['1m ago', 'in 1m'],
        ['%sm ago', 'in %sm'],
        ['1h ago', 'in 1h'],
        ['%sh ago', 'in %sh'],
        ['1d ago', 'in 1d'],
        ['%sd ago', 'in %sd'],
        ['1w ago', 'in 1w'],
        ['%sw ago', 'in %sw'],
        ['1mo ago', 'in 1mo'],
        ['%smo ago', 'in %smo'],
        ['1yr ago', 'in 1yr'],
        ['%syr ago', 'in %syr'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=en_short.js.map

/***/ }),

/***/ 4155:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['justo ahora', 'en un rato'],
        ['hace %s segundos', 'en %s segundos'],
        ['hace 1 minuto', 'en 1 minuto'],
        ['hace %s minutos', 'en %s minutos'],
        ['hace 1 hora', 'en 1 hora'],
        ['hace %s horas', 'en %s horas'],
        ['hace 1 día', 'en 1 día'],
        ['hace %s días', 'en %s días'],
        ['hace 1 semana', 'en 1 semana'],
        ['hace %s semanas', 'en %s semanas'],
        ['hace 1 mes', 'en 1 mes'],
        ['hace %s meses', 'en %s meses'],
        ['hace 1 año', 'en 1 año'],
        ['hace %s años', 'en %s años'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=es.js.map

/***/ }),

/***/ 6081:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['orain', 'denbora bat barru'],
        ['duela %s segundu', '%s segundu barru'],
        ['duela minutu 1', 'minutu 1 barru'],
        ['duela %s minutu', '%s minutu barru'],
        ['duela ordu 1', 'ordu 1 barru'],
        ['duela %s ordu', '%s ordu barru'],
        ['duela egun 1', 'egun 1 barru'],
        ['duela %s egun', '%s egun barru'],
        ['duela aste 1', 'aste 1 barru'],
        ['duela %s aste', '%s aste barru'],
        ['duela hillabete 1', 'hillabete 1 barru'],
        ['duela %s hillabete', '%s hillabete barru'],
        ['duela urte 1', 'urte 1 barru'],
        ['duela %s urte', '%s urte barru'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=eu.js.map

/***/ }),

/***/ 1442:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
// As persian language has different number symbols we need to replace regular numbers
// to standard persian numbres.
function toPersianNumber(number) {
    // List of standard persian numbers from 0 to 9
    var persianDigits = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
    return number.toString().replace(/\d/g, function (x) { return persianDigits[x]; });
}
function default_1(number, index) {
    var formattedString = [
        ['لحظاتی پیش', 'همین حالا'],
        ['%s ثانیه پیش', '%s ثانیه دیگر'],
        ['۱ دقیقه پیش', '۱ دقیقه دیگر'],
        ['%s دقیقه پیش', '%s دقیقه دیگر'],
        ['۱ ساعت پیش', '۱ ساعت دیگر'],
        ['%s ساعت پیش', '%s ساعت دیگر'],
        ['۱ روز پیش', '۱ روز دیگر'],
        ['%s روز پیش', '%s روز دیگر'],
        ['۱ هفته پیش', '۱ هفته دیگر'],
        ['%s هفته پیش', '%s هفته دیگر'],
        ['۱ ماه پیش', '۱ ماه دیگر'],
        ['%s ماه پیش', '%s ماه دیگر'],
        ['۱ سال پیش', '۱ سال دیگر'],
        ['%s سال پیش', '%s سال دیگر'],
    ][index];
    // We convert regular numbers (%s) to standard persian numbers using toPersianNumber function
    return [
        formattedString[0].replace('%s', toPersianNumber(number)),
        formattedString[1].replace('%s', toPersianNumber(number)),
    ];
}
exports["default"] = default_1;
//# sourceMappingURL=fa.js.map

/***/ }),

/***/ 9690:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['juuri äsken', 'juuri nyt'],
        ['%s sekuntia sitten', '%s sekunnin päästä'],
        ['minuutti sitten', 'minuutin päästä'],
        ['%s minuuttia sitten', '%s minuutin päästä'],
        ['tunti sitten', 'tunnin päästä'],
        ['%s tuntia sitten', '%s tunnin päästä'],
        ['päivä sitten', 'päivän päästä'],
        ['%s päivää sitten', '%s päivän päästä'],
        ['viikko sitten', 'viikon päästä'],
        ['%s viikkoa sitten', '%s viikon päästä'],
        ['kuukausi sitten', 'kuukauden päästä'],
        ['%s kuukautta sitten', '%s kuukauden päästä'],
        ['vuosi sitten', 'vuoden päästä'],
        ['%s vuotta sitten', '%s vuoden päästä'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=fi.js.map

/***/ }),

/***/ 4719:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ["à l'instant", 'dans un instant'],
        ['il y a %s secondes', 'dans %s secondes'],
        ['il y a 1 minute', 'dans 1 minute'],
        ['il y a %s minutes', 'dans %s minutes'],
        ['il y a 1 heure', 'dans 1 heure'],
        ['il y a %s heures', 'dans %s heures'],
        ['il y a 1 jour', 'dans 1 jour'],
        ['il y a %s jours', 'dans %s jours'],
        ['il y a 1 semaine', 'dans 1 semaine'],
        ['il y a %s semaines', 'dans %s semaines'],
        ['il y a 1 mois', 'dans 1 mois'],
        ['il y a %s mois', 'dans %s mois'],
        ['il y a 1 an', 'dans 1 an'],
        ['il y a %s ans', 'dans %s ans'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=fr.js.map

/***/ }),

/***/ 7912:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['xusto agora', 'daquí a un pouco'],
        ['hai %s segundos', 'en %s segundos'],
        ['hai 1 minuto', 'nun minuto'],
        ['hai %s minutos', 'en %s minutos'],
        ['hai 1 hora', 'nunha hora'],
        ['hai %s horas', 'en %s horas'],
        ['hai 1 día', 'nun día'],
        ['hai %s días', 'en %s días'],
        ['hai 1 semana', 'nunha semana'],
        ['hai %s semanas', 'en %s semanas'],
        ['hai 1 mes', 'nun mes'],
        ['hai %s meses', 'en %s meses'],
        ['hai 1 ano', 'nun ano'],
        ['hai %s anos', 'en %s anos'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=gl.js.map

/***/ }),

/***/ 8372:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['זה עתה', 'עכשיו'],
        ['לפני %s שניות', 'בעוד %s שניות'],
        ['לפני דקה', 'בעוד דקה'],
        ['לפני %s דקות', 'בעוד %s דקות'],
        ['לפני שעה', 'בעוד שעה'],
        number === 2 ? ['לפני שעתיים', 'בעוד שעתיים'] : ['לפני %s שעות', 'בעוד %s שעות'],
        ['אתמול', 'מחר'],
        number === 2 ? ['לפני יומיים', 'בעוד יומיים'] : ['לפני %s ימים', 'בעוד %s ימים'],
        ['לפני שבוע', 'בעוד שבוע'],
        number === 2 ? ['לפני שבועיים', 'בעוד שבועיים'] : ['לפני %s שבועות', 'בעוד %s שבועות'],
        ['לפני חודש', 'בעוד חודש'],
        number === 2 ? ['לפני חודשיים', 'בעוד חודשיים'] : ['לפני %s חודשים', 'בעוד %s חודשים'],
        ['לפני שנה', 'בעוד שנה'],
        number === 2 ? ['לפני שנתיים', 'בעוד שנתיים'] : ['לפני %s שנים', 'בעוד %s שנים'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=he.js.map

/***/ }),

/***/ 8864:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
// Hindi (India)
function default_1(number, index) {
    return [
        ['अभी', 'कुछ समय'],
        ['%s सेकंड पहले', '%s सेकंड में'],
        ['1 मिनट पहले', '1 मिनट में'],
        ['%s मिनट पहले', '%s मिनट में'],
        ['1 घंटे पहले', '1 घंटे में'],
        ['%s घंटे पहले', '%s घंटे में'],
        ['1 दिन पहले', '1 दिन में'],
        ['%s दिन पहले', '%s दिनों में'],
        ['1 सप्ताह पहले', '1 सप्ताह में'],
        ['%s हफ्ते पहले', '%s हफ्तों में'],
        ['1 महीने पहले', '1 महीने में'],
        ['%s महीने पहले', '%s महीनों में'],
        ['1 साल पहले', '1 साल में'],
        ['%s साल पहले', '%s साल में'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=hi_IN.js.map

/***/ }),

/***/ 372:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['éppen most', 'éppen most'],
        ['%s másodperce', '%s másodpercen belül'],
        ['1 perce', '1 percen belül'],
        ['%s perce', '%s percen belül'],
        ['1 órája', '1 órán belül'],
        ['%s órája', '%s órán belül'],
        ['1 napja', '1 napon belül'],
        ['%s napja', '%s napon belül'],
        ['1 hete', '1 héten belül'],
        ['%s hete', '%s héten belül'],
        ['1 hónapja', '1 hónapon belül'],
        ['%s hónapja', '%s hónapon belül'],
        ['1 éve', '1 éven belül'],
        ['%s éve', '%s éven belül'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=hu.js.map

/***/ }),

/***/ 5192:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
// Indonesian (Indonesia)
function default_1(number, index) {
    return [
        ['baru saja', 'sebentar'],
        ['%s detik yang lalu', 'dalam %s detik'],
        ['1 menit yang lalu', 'dalam 1 menit'],
        ['%s menit yang lalu', 'dalam %s menit'],
        ['1 jam yang lalu', 'dalam 1 jam'],
        ['%s jam yang lalu', 'dalam %s jam'],
        ['1 hari yang lalu', 'dalam 1 hari'],
        ['%s hari yang lalu', 'dalam %s hari'],
        ['1 minggu yang lalu', 'dalam 1 minggu'],
        ['%s minggu yang lalu', 'dalam %s minggu'],
        ['1 bulan yang lalu', 'dalam 1 bulan'],
        ['%s bulan yang lalu', 'dalam %s bulan'],
        ['1 tahun yang lalu', 'dalam 1 tahun'],
        ['%s tahun yang lalu', 'dalam %s tahun'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=id_ID.js.map

/***/ }),

/***/ 6827:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {

"use strict";
var __webpack_unused_export__;

__webpack_unused_export__ = ({ value: true });
var ar_1 = __webpack_require__(5632);
exports.ar = ar_1.default;
var be_1 = __webpack_require__(3570);
exports.be = be_1.default;
var bg_1 = __webpack_require__(6808);
exports.bg = bg_1.default;
var bn_IN_1 = __webpack_require__(6945);
exports.Dd = bn_IN_1.default;
var ca_1 = __webpack_require__(5039);
exports.ca = ca_1.default;
var de_1 = __webpack_require__(3944);
exports.de = de_1.default;
var el_1 = __webpack_require__(3802);
exports.el = el_1.default;
var en_short_1 = __webpack_require__(2345);
exports.x9 = en_short_1.default;
var en_US_1 = __webpack_require__(8383);
exports.Bh = en_US_1.default;
var es_1 = __webpack_require__(4155);
exports.es = es_1.default;
var eu_1 = __webpack_require__(6081);
exports.eu = eu_1.default;
var fa_1 = __webpack_require__(1442);
exports.fa = fa_1.default;
var fi_1 = __webpack_require__(9690);
exports.fi = fi_1.default;
var fr_1 = __webpack_require__(4719);
exports.fr = fr_1.default;
var gl_1 = __webpack_require__(7912);
__webpack_unused_export__ = gl_1.default;
var he_1 = __webpack_require__(8372);
exports.he = he_1.default;
var hi_IN_1 = __webpack_require__(8864);
exports.Ih = hi_IN_1.default;
var hu_1 = __webpack_require__(372);
exports.hu = hu_1.default;
var id_ID_1 = __webpack_require__(5192);
exports.EN = id_ID_1.default;
var it_1 = __webpack_require__(7806);
exports.it = it_1.default;
var ja_1 = __webpack_require__(5622);
exports.ja = ja_1.default;
var ko_1 = __webpack_require__(541);
exports.ko = ko_1.default;
var ml_1 = __webpack_require__(8610);
exports.ml = ml_1.default;
var my_1 = __webpack_require__(6621);
exports.my = my_1.default;
var nb_NO_1 = __webpack_require__(6909);
exports.Fo = nb_NO_1.default;
var nl_1 = __webpack_require__(1645);
exports.nl = nl_1.default;
var nn_NO_1 = __webpack_require__(4033);
exports.$h = nn_NO_1.default;
var pl_1 = __webpack_require__(1211);
exports.pl = pl_1.default;
var pt_BR_1 = __webpack_require__(9202);
exports.iR = pt_BR_1.default;
var ro_1 = __webpack_require__(9088);
exports.ro = ro_1.default;
var ru_1 = __webpack_require__(3058);
exports.ru = ru_1.default;
var sq_1 = __webpack_require__(4959);
__webpack_unused_export__ = sq_1.default;
var sr_1 = __webpack_require__(9058);
__webpack_unused_export__ = sr_1.default;
var sv_1 = __webpack_require__(1278);
exports.sv = sv_1.default;
var ta_1 = __webpack_require__(1700);
exports.ta = ta_1.default;
var th_1 = __webpack_require__(8659);
exports.th = th_1.default;
var tr_1 = __webpack_require__(4285);
exports.tr = tr_1.default;
var uk_1 = __webpack_require__(4547);
exports.uk = uk_1.default;
var vi_1 = __webpack_require__(8554);
exports.vi = vi_1.default;
var zh_CN_1 = __webpack_require__(8065);
exports.xC = zh_CN_1.default;
var zh_TW_1 = __webpack_require__(1445);
exports.lm = zh_TW_1.default;
//# sourceMappingURL=index.js.map

/***/ }),

/***/ 7806:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['poco fa', 'fra poco'],
        ['%s secondi fa', 'fra %s secondi'],
        ['un minuto fa', 'fra un minuto'],
        ['%s minuti fa', 'fra %s minuti'],
        ["un'ora fa", "fra un'ora"],
        ['%s ore fa', 'fra %s ore'],
        ['un giorno fa', 'fra un giorno'],
        ['%s giorni fa', 'fra %s giorni'],
        ['una settimana fa', 'fra una settimana'],
        ['%s settimane fa', 'fra %s settimane'],
        ['un mese fa', 'fra un mese'],
        ['%s mesi fa', 'fra %s mesi'],
        ['un anno fa', 'fra un anno'],
        ['%s anni fa', 'fra %s anni'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=it.js.map

/***/ }),

/***/ 5622:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['すこし前', 'すぐに'],
        ['%s秒前', '%s秒以内'],
        ['1分前', '1分以内'],
        ['%s分前', '%s分以内'],
        ['1時間前', '1時間以内'],
        ['%s時間前', '%s時間以内'],
        ['1日前', '1日以内'],
        ['%s日前', '%s日以内'],
        ['1週間前', '1週間以内'],
        ['%s週間前', '%s週間以内'],
        ['1ヶ月前', '1ヶ月以内'],
        ['%sヶ月前', '%sヶ月以内'],
        ['1年前', '1年以内'],
        ['%s年前', '%s年以内'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=ja.js.map

/***/ }),

/***/ 541:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['방금', '곧'],
        ['%s초 전', '%s초 후'],
        ['1분 전', '1분 후'],
        ['%s분 전', '%s분 후'],
        ['1시간 전', '1시간 후'],
        ['%s시간 전', '%s시간 후'],
        ['1일 전', '1일 후'],
        ['%s일 전', '%s일 후'],
        ['1주일 전', '1주일 후'],
        ['%s주일 전', '%s주일 후'],
        ['1개월 전', '1개월 후'],
        ['%s개월 전', '%s개월 후'],
        ['1년 전', '1년 후'],
        ['%s년 전', '%s년 후'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=ko.js.map

/***/ }),

/***/ 8610:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['ഇപ്പോള്‍', 'കുറച്ചു മുന്‍പ്'],
        ['%s സെക്കന്റ്‌കള്‍ക്ക് മുന്‍പ്', '%s സെക്കന്റില്‍'],
        ['1 മിനിറ്റിനു മുന്‍പ്', '1 മിനിറ്റില്‍'],
        ['%s മിനിറ്റുകള്‍ക്ക് മുന്‍പ', '%s മിനിറ്റില്‍'],
        ['1 മണിക്കൂറിനു മുന്‍പ്', '1 മണിക്കൂറില്‍'],
        ['%s മണിക്കൂറുകള്‍ക്കു മുന്‍പ്', '%s മണിക്കൂറില്‍'],
        ['1 ഒരു ദിവസം മുന്‍പ്', '1 ദിവസത്തില്‍'],
        ['%s ദിവസങ്ങള്‍ക് മുന്‍പ്', '%s ദിവസങ്ങള്‍ക്കുള്ളില്‍'],
        ['1 ആഴ്ച മുന്‍പ്', '1 ആഴ്ചയില്‍'],
        ['%s ആഴ്ചകള്‍ക്ക് മുന്‍പ്', '%s ആഴ്ചകള്‍ക്കുള്ളില്‍'],
        ['1 മാസത്തിനു മുന്‍പ്', '1 മാസത്തിനുള്ളില്‍'],
        ['%s മാസങ്ങള്‍ക്ക് മുന്‍പ്', '%s മാസങ്ങള്‍ക്കുള്ളില്‍'],
        ['1 വര്‍ഷത്തിനു  മുന്‍പ്', '1 വര്‍ഷത്തിനുള്ളില്‍'],
        ['%s വര്‍ഷങ്ങള്‍ക്കു മുന്‍പ്', '%s വര്‍ഷങ്ങള്‍ക്കുല്ല്ളില്‍'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=ml.js.map

/***/ }),

/***/ 6621:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['ယခုအတွင်း', 'ယခု'],
        ['%s စက္ကန့် အကြာက', '%s စက္ကန့်အတွင်း'],
        ['1 မိနစ် အကြာက', '1 မိနစ်အတွင်း'],
        ['%s မိနစ် အကြာက', '%s မိနစ်အတွင်း'],
        ['1 နာရီ အကြာက', '1 နာရီအတွင်း'],
        ['%s နာရီ အကြာက', '%s နာရီအတွင်း'],
        ['1 ရက် အကြာက', '1 ရက်အတွင်း'],
        ['%s ရက် အကြာက', '%s ရက်အတွင်း'],
        ['1 ပတ် အကြာက', '1 ပတ်အတွင်း'],
        ['%s ပတ် အကြာက', '%s ပတ်အတွင်း'],
        ['1 လ အကြာက', '1 လအတွင်း'],
        ['%s လ အကြာက', '%s လအတွင်း'],
        ['1 နှစ် အကြာက', '1 နှစ်အတွင်း'],
        ['%s နှစ် အကြာက', '%s နှစ်အတွင်း'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=my.js.map

/***/ }),

/***/ 6909:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['akkurat nå', 'om litt'],
        ['%s sekunder siden', 'om %s sekunder'],
        ['1 minutt siden', 'om 1 minutt'],
        ['%s minutter siden', 'om %s minutter'],
        ['1 time siden', 'om 1 time'],
        ['%s timer siden', 'om %s timer'],
        ['1 dag siden', 'om 1 dag'],
        ['%s dager siden', 'om %s dager'],
        ['1 uke siden', 'om 1 uke'],
        ['%s uker siden', 'om %s uker'],
        ['1 måned siden', 'om 1 måned'],
        ['%s måneder siden', 'om %s måneder'],
        ['1 år siden', 'om 1 år'],
        ['%s år siden', 'om %s år'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=nb_NO.js.map

/***/ }),

/***/ 1645:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['recent', 'binnenkort'],
        ['%s seconden geleden', 'binnen %s seconden'],
        ['1 minuut geleden', 'binnen 1 minuut'],
        ['%s minuten geleden', 'binnen %s minuten'],
        ['1 uur geleden', 'binnen 1 uur'],
        ['%s uur geleden', 'binnen %s uur'],
        ['1 dag geleden', 'binnen 1 dag'],
        ['%s dagen geleden', 'binnen %s dagen'],
        ['1 week geleden', 'binnen 1 week'],
        ['%s weken geleden', 'binnen %s weken'],
        ['1 maand geleden', 'binnen 1 maand'],
        ['%s maanden geleden', 'binnen %s maanden'],
        ['1 jaar geleden', 'binnen 1 jaar'],
        ['%s jaar geleden', 'binnen %s jaar'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=nl.js.map

/***/ }),

/***/ 4033:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['nett no', 'om litt'],
        ['%s sekund sidan', 'om %s sekund'],
        ['1 minutt sidan', 'om 1 minutt'],
        ['%s minutt sidan', 'om %s minutt'],
        ['1 time sidan', 'om 1 time'],
        ['%s timar sidan', 'om %s timar'],
        ['1 dag sidan', 'om 1 dag'],
        ['%s dagar sidan', 'om %s dagar'],
        ['1 veke sidan', 'om 1 veke'],
        ['%s veker sidan', 'om %s veker'],
        ['1 månad sidan', 'om 1 månad'],
        ['%s månadar sidan', 'om %s månadar'],
        ['1 år sidan', 'om 1 år'],
        ['%s år sidan', 'om %s år'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=nn_NO.js.map

/***/ }),

/***/ 1211:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
// 0-13 alternately: single unit of time,
// genitive plural form for all other numbers excluding cases below:
// 14-20: nominative plural form for the numbers 2,3,4
// and all other numbers higher than 21 which end in 2,3,4
var l = [
    ['w tej chwili', 'za chwilę'],
    ['%s sekund temu', 'za %s sekund'],
    ['1 minutę temu', 'za 1 minutę'],
    ['%s minut temu', 'za %s minut'],
    ['1 godzinę temu', 'za 1 godzinę'],
    ['%s godzin temu', 'za %s godzin'],
    ['1 dzień temu', 'za 1 dzień'],
    ['%s dni temu', 'za %s dni'],
    ['1 tydzień temu', 'za 1 tydzień'],
    ['%s tygodni temu', 'za %s tygodni'],
    ['1 miesiąc temu', 'za 1 miesiąc'],
    ['%s miesięcy temu', 'za %s miesięcy'],
    ['1 rok temu', 'za 1 rok'],
    ['%s lat temu', 'za %s lat'],
    ['%s sekundy temu', 'za %s sekundy'],
    ['%s minuty temu', 'za %s minuty'],
    ['%s godziny temu', 'za %s godziny'],
    ['%s dni temu', 'za %s dni'],
    ['%s tygodnie temu', 'za %s tygodnie'],
    ['%s miesiące temu', 'za %s miesiące'],
    ['%s lata temu', 'za %s lata'],
];
function default_1(number, index) {
    // to determine which plural form must be used check the last 2 digits
    // and calculate new index value to get the nominative form (14-20)
    // for all other cases use index value as it is (0-13)
    return l[index & 1 ? (number % 10 > 4 || number % 10 < 2 || 1 === ~~(number / 10) % 10 ? index : ++index / 2 + 13) : index];
}
exports["default"] = default_1;
//# sourceMappingURL=pl.js.map

/***/ }),

/***/ 9202:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['agora mesmo', 'agora'],
        ['há %s segundos', 'em %s segundos'],
        ['há um minuto', 'em um minuto'],
        ['há %s minutos', 'em %s minutos'],
        ['há uma hora', 'em uma hora'],
        ['há %s horas', 'em %s horas'],
        ['há um dia', 'em um dia'],
        ['há %s dias', 'em %s dias'],
        ['há uma semana', 'em uma semana'],
        ['há %s semanas', 'em %s semanas'],
        ['há um mês', 'em um mês'],
        ['há %s meses', 'em %s meses'],
        ['há um ano', 'em um ano'],
        ['há %s anos', 'em %s anos'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=pt_BR.js.map

/***/ }),

/***/ 9088:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    var langTable = [
        ['chiar acum', 'chiar acum'],
        ['acum %s secunde', 'peste %s secunde'],
        ['acum un minut', 'peste un minut'],
        ['acum %s minute', 'peste %s minute'],
        ['acum o oră', 'peste o oră'],
        ['acum %s ore', 'peste %s ore'],
        ['acum o zi', 'peste o zi'],
        ['acum %s zile', 'peste %s zile'],
        ['acum o săptămână', 'peste o săptămână'],
        ['acum %s săptămâni', 'peste %s săptămâni'],
        ['acum o lună', 'peste o lună'],
        ['acum %s luni', 'peste %s luni'],
        ['acum un an', 'peste un an'],
        ['acum %s ani', 'peste %s ani'],
    ];
    if (number < 20) {
        return langTable[index];
    }
    // A `de` preposition must be added between the number and the adverb
    // if the number is greater than 20.
    return [langTable[index][0].replace('%s', '%s de'), langTable[index][1].replace('%s', '%s de')];
}
exports["default"] = default_1;
//# sourceMappingURL=ro.js.map

/***/ }),

/***/ 3058:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
/**
 *
 * @param f1 - 1
 * @param f - 21, 31, ...
 * @param s - 2-4, 22-24, 32-34 ...
 * @param t - 5-20, 25-30, ...
 * @param n
 * @returns
 */
function formatNum(f1, f, s, t, n) {
    var n10 = n % 10;
    var str = t;
    if (n === 1) {
        str = f1;
    }
    else if (n10 === 1 && n > 20) {
        str = f;
    }
    else if (n10 > 1 && n10 < 5 && (n > 20 || n < 10)) {
        str = s;
    }
    return str;
}
var seconds = formatNum.bind(null, 'секунду', '%s секунду', '%s секунды', '%s секунд'), minutes = formatNum.bind(null, 'минуту', '%s минуту', '%s минуты', '%s минут'), hours = formatNum.bind(null, 'час', '%s час', '%s часа', '%s часов'), days = formatNum.bind(null, 'день', '%s день', '%s дня', '%s дней'), weeks = formatNum.bind(null, 'неделю', '%s неделю', '%s недели', '%s недель'), months = formatNum.bind(null, 'месяц', '%s месяц', '%s месяца', '%s месяцев'), years = formatNum.bind(null, 'год', '%s год', '%s года', '%s лет');
function default_1(number, index) {
    switch (index) {
        case 0:
            return ['только что', 'через несколько секунд'];
        case 1:
            return [seconds(number) + ' назад', 'через ' + seconds(number)];
        case 2: // ['минуту назад', 'через минуту'];
        case 3:
            return [minutes(number) + ' назад', 'через ' + minutes(number)];
        case 4: // ['час назад', 'через час'];
        case 5:
            return [hours(number) + ' назад', 'через ' + hours(number)];
        case 6:
            return ['вчера', 'завтра'];
        case 7:
            return [days(number) + ' назад', 'через ' + days(number)];
        case 8: // ['неделю назад', 'через неделю'];
        case 9:
            return [weeks(number) + ' назад', 'через ' + weeks(number)];
        case 10: // ['месяц назад', 'через месяц'];
        case 11:
            return [months(number) + ' назад', 'через ' + months(number)];
        case 12: // ['год назад', 'через год'];
        case 13:
            return [years(number) + ' назад', 'через ' + years(number)];
        default:
            return ['', ''];
    }
}
exports["default"] = default_1;
//# sourceMappingURL=ru.js.map

/***/ }),

/***/ 4959:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['pak më parë', 'pas pak'],
        ['para %s sekondash', 'pas %s sekondash'],
        ['para një minute', 'pas një minute'],
        ['para %s minutash', 'pas %s minutash'],
        ['para një ore', 'pas një ore'],
        ['para %s orësh', 'pas %s orësh'],
        ['dje', 'nesër'],
        ['para %s ditësh', 'pas %s ditësh'],
        ['para një jave', 'pas një jave'],
        ['para %s javësh', 'pas %s javësh'],
        ['para një muaji', 'pas një muaji'],
        ['para %s muajsh', 'pas %s muajsh'],
        ['para një viti', 'pas një viti'],
        ['para %s vjetësh', 'pas %s vjetësh'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=sq.js.map

/***/ }),

/***/ 9058:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function formatNum(single, one, few, other, n) {
    var rem10 = n % 10;
    var rem100 = n % 100;
    if (n == 1) {
        return single;
    }
    else if (rem10 == 1 && rem100 != 11) {
        return one;
    }
    else if (rem10 >= 2 && rem10 <= 4 && !(rem100 >= 12 && rem100 <= 14)) {
        return few;
    }
    else {
        return other;
    }
}
var seconds = formatNum.bind(null, '1 секунд', '%s секунд', '%s секунде', '%s секунди'), minutes = formatNum.bind(null, '1 минут', '%s минут', '%s минуте', '%s минута'), hours = formatNum.bind(null, 'сат времена', '%s сат', '%s сата', '%s сати'), days = formatNum.bind(null, '1 дан', '%s дан', '%s дана', '%s дана'), weeks = formatNum.bind(null, 'недељу дана', '%s недељу', '%s недеље', '%s недеља'), months = formatNum.bind(null, 'месец дана', '%s месец', '%s месеца', '%s месеци'), years = formatNum.bind(null, 'годину дана', '%s годину', '%s године', '%s година');
function default_1(number, index) {
    switch (index) {
        case 0:
            return ['малопре', 'управо сад'];
        case 1:
            return ['пре ' + seconds(number), 'за ' + seconds(number)];
        case 2:
        case 3:
            return ['пре ' + minutes(number), 'за ' + minutes(number)];
        case 4:
        case 5:
            return ['пре ' + hours(number), 'за ' + hours(number)];
        case 6:
        case 7:
            return ['пре ' + days(number), 'за ' + days(number)];
        case 8:
        case 9:
            return ['пре ' + weeks(number), 'за ' + weeks(number)];
        case 10:
        case 11:
            return ['пре ' + months(number), 'за ' + months(number)];
        case 12:
        case 13:
            return ['пре ' + years(number), 'за ' + years(number)];
        default:
            return ['', ''];
    }
}
exports["default"] = default_1;
//# sourceMappingURL=sr.js.map

/***/ }),

/***/ 1278:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['just nu', 'om en stund'],
        ['%s sekunder sedan', 'om %s sekunder'],
        ['1 minut sedan', 'om 1 minut'],
        ['%s minuter sedan', 'om %s minuter'],
        ['1 timme sedan', 'om 1 timme'],
        ['%s timmar sedan', 'om %s timmar'],
        ['1 dag sedan', 'om 1 dag'],
        ['%s dagar sedan', 'om %s dagar'],
        ['1 vecka sedan', 'om 1 vecka'],
        ['%s veckor sedan', 'om %s veckor'],
        ['1 månad sedan', 'om 1 månad'],
        ['%s månader sedan', 'om %s månader'],
        ['1 år sedan', 'om 1 år'],
        ['%s år sedan', 'om %s år'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=sv.js.map

/***/ }),

/***/ 1700:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['இப்போது', 'சற்று நேரம் முன்பு'],
        ['%s நொடிக்கு முன்', '%s நொடிகளில்'],
        ['1 நிமிடத்திற்க்கு முன்', '1 நிமிடத்தில்'],
        ['%s நிமிடத்திற்க்கு முன்', '%s நிமிடங்களில்'],
        ['1 மணி நேரத்திற்கு முன்', '1 மணி நேரத்திற்குள்'],
        ['%s மணி நேரத்திற்கு முன்', '%s மணி நேரத்திற்குள்'],
        ['1 நாளுக்கு முன்', '1 நாளில்'],
        ['%s நாட்களுக்கு முன்', '%s நாட்களில்'],
        ['1 வாரத்திற்கு முன்', '1 வாரத்தில்'],
        ['%s வாரங்களுக்கு முன்', '%s வாரங்களில்'],
        ['1 மாதத்திற்கு முன்', '1 மாதத்தில்'],
        ['%s மாதங்களுக்கு முன்', '%s மாதங்களில்'],
        ['1 வருடத்திற்கு முன்', '1 வருடத்தில்'],
        ['%s வருடங்களுக்கு முன்', '%s வருடங்களில்'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=ta.js.map

/***/ }),

/***/ 8659:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['เมื่อสักครู่นี้', 'อีกสักครู่'],
        ['%s วินาทีที่แล้ว', 'ใน %s วินาที'],
        ['1 นาทีที่แล้ว', 'ใน 1 นาที'],
        ['%s นาทีที่แล้ว', 'ใน %s นาที'],
        ['1 ชั่วโมงที่แล้ว', 'ใน 1 ชั่วโมง'],
        ['%s ชั่วโมงที่แล้ว', 'ใน %s ชั่วโมง'],
        ['1 วันที่แล้ว', 'ใน 1 วัน'],
        ['%s วันที่แล้ว', 'ใน %s วัน'],
        ['1 อาทิตย์ที่แล้ว', 'ใน 1 อาทิตย์'],
        ['%s อาทิตย์ที่แล้ว', 'ใน %s อาทิตย์'],
        ['1 เดือนที่แล้ว', 'ใน 1 เดือน'],
        ['%s เดือนที่แล้ว', 'ใน %s เดือน'],
        ['1 ปีที่แล้ว', 'ใน 1 ปี'],
        ['%s ปีที่แล้ว', 'ใน %s ปี'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=th.js.map

/***/ }),

/***/ 4285:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['az önce', 'şimdi'],
        ['%s saniye önce', '%s saniye içinde'],
        ['1 dakika önce', '1 dakika içinde'],
        ['%s dakika önce', '%s dakika içinde'],
        ['1 saat önce', '1 saat içinde'],
        ['%s saat önce', '%s saat içinde'],
        ['1 gün önce', '1 gün içinde'],
        ['%s gün önce', '%s gün içinde'],
        ['1 hafta önce', '1 hafta içinde'],
        ['%s hafta önce', '%s hafta içinde'],
        ['1 ay önce', '1 ay içinde'],
        ['%s ay önce', '%s ay içinde'],
        ['1 yıl önce', '1 yıl içinde'],
        ['%s yıl önce', '%s yıl içinde'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=tr.js.map

/***/ }),

/***/ 4547:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function formatNum(f1, f, s, t, n) {
    var n10 = n % 10;
    var str = t;
    if (n === 1) {
        str = f1;
    }
    else if (n10 === 1 && n > 20) {
        str = f;
    }
    else if (n10 > 1 && n10 < 5 && (n > 20 || n < 10)) {
        str = s;
    }
    return str;
}
var seconds = formatNum.bind(null, 'секунду', '%s секунду', '%s секунди', '%s секунд'), minutes = formatNum.bind(null, 'хвилину', '%s хвилину', '%s хвилини', '%s хвилин'), hours = formatNum.bind(null, 'годину', '%s годину', '%s години', '%s годин'), days = formatNum.bind(null, 'день', '%s день', '%s дні', '%s днів'), weeks = formatNum.bind(null, 'тиждень', '%s тиждень', '%s тиждні', '%s тижднів'), months = formatNum.bind(null, 'місяць', '%s місяць', '%s місяці', '%s місяців'), years = formatNum.bind(null, 'рік', '%s рік', '%s роки', '%s років');
function default_1(number, index) {
    switch (index) {
        case 0:
            return ['щойно', 'через декілька секунд'];
        case 1:
            return [seconds(number) + ' тому', 'через ' + seconds(number)];
        case 2:
        case 3:
            return [minutes(number) + ' тому', 'через ' + minutes(number)];
        case 4:
        case 5:
            return [hours(number) + ' тому', 'через ' + hours(number)];
        case 6:
        case 7:
            return [days(number) + ' тому', 'через ' + days(number)];
        case 8:
        case 9:
            return [weeks(number) + ' тому', 'через ' + weeks(number)];
        case 10:
        case 11:
            return [months(number) + ' тому', 'через ' + months(number)];
        case 12:
        case 13:
            return [years(number) + ' тому', 'через ' + years(number)];
        default:
            return ['', ''];
    }
}
exports["default"] = default_1;
//# sourceMappingURL=uk.js.map

/***/ }),

/***/ 8554:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['vừa xong', 'một lúc'],
        ['%s giây trước', 'trong %s giây'],
        ['1 phút trước', 'trong 1 phút'],
        ['%s phút trước', 'trong %s phút'],
        ['1 giờ trước', 'trong 1 giờ'],
        ['%s giờ trước', 'trong %s giờ'],
        ['1 ngày trước', 'trong 1 ngày'],
        ['%s ngày trước', 'trong %s ngày'],
        ['1 tuần trước', 'trong 1 tuần'],
        ['%s tuần trước', 'trong %s tuần'],
        ['1 tháng trước', 'trong 1 tháng'],
        ['%s tháng trước', 'trong %s tháng'],
        ['1 năm trước', 'trong 1 năm'],
        ['%s năm trước', 'trong %s năm'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=vi.js.map

/***/ }),

/***/ 8065:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
var ZH_CN = ['秒', '分钟', '小时', '天', '周', '个月', '年'];
function default_1(diff, idx) {
    if (idx === 0)
        return ['刚刚', '片刻后'];
    var unit = ZH_CN[~~(idx / 2)];
    return [diff + " " + unit + "\u524D", diff + " " + unit + "\u540E"];
}
exports["default"] = default_1;
//# sourceMappingURL=zh_CN.js.map

/***/ }),

/***/ 1445:
/***/ ((__unused_webpack_module, exports) => {

"use strict";

Object.defineProperty(exports, "__esModule", ({ value: true }));
function default_1(number, index) {
    return [
        ['剛剛', '片刻後'],
        ['%s 秒前', '%s 秒後'],
        ['1 分鐘前', '1 分鐘後'],
        ['%s 分鐘前', '%s 分鐘後'],
        ['1 小時前', '1 小時後'],
        ['%s 小時前', '%s 小時後'],
        ['1 天前', '1 天後'],
        ['%s 天前', '%s 天後'],
        ['1 週前', '1 週後'],
        ['%s 週前', '%s 週後'],
        ['1 個月前', '1 個月後'],
        ['%s 個月前', '%s 個月後'],
        ['1 年前', '1 年後'],
        ['%s 年前', '%s 年後'],
    ][index];
}
exports["default"] = default_1;
//# sourceMappingURL=zh_TW.js.map

/***/ }),

/***/ 1063:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {

"use strict";
/**
 * @license React
 * use-sync-external-store-shim.production.min.js
 *
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var e=__webpack_require__(6540);function h(a,b){return a===b&&(0!==a||1/a===1/b)||a!==a&&b!==b}var k="function"===typeof Object.is?Object.is:h,l=e.useState,m=e.useEffect,n=e.useLayoutEffect,p=e.useDebugValue;function q(a,b){var d=b(),f=l({inst:{value:d,getSnapshot:b}}),c=f[0].inst,g=f[1];n(function(){c.value=d;c.getSnapshot=b;r(c)&&g({inst:c})},[a,d,b]);m(function(){r(c)&&g({inst:c});return a(function(){r(c)&&g({inst:c})})},[a]);p(d);return d}
function r(a){var b=a.getSnapshot;a=a.value;try{var d=b();return!k(a,d)}catch(f){return!0}}function t(a,b){return b()}var u="undefined"===typeof window||"undefined"===typeof window.document||"undefined"===typeof window.document.createElement?t:q;exports.useSyncExternalStore=void 0!==e.useSyncExternalStore?e.useSyncExternalStore:u;


/***/ }),

/***/ 9888:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

"use strict";


if (true) {
  module.exports = __webpack_require__(1063);
} else {}


/***/ }),

/***/ 9771:
/***/ ((module) => {

"use strict";
/**
 * Copyright (c) 2014-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */



/**
 * Similar to invariant but only logs a warning if the condition is not met.
 * This can be used to log issues in development environments in critical
 * paths. Removing the logging code for production environments will keep the
 * same logic and follow the same code paths.
 */

var __DEV__ = "production" !== 'production';

var warning = function() {};

if (__DEV__) {
  var printWarning = function printWarning(format, args) {
    var len = arguments.length;
    args = new Array(len > 1 ? len - 1 : 0);
    for (var key = 1; key < len; key++) {
      args[key - 1] = arguments[key];
    }
    var argIndex = 0;
    var message = 'Warning: ' +
      format.replace(/%s/g, function() {
        return args[argIndex++];
      });
    if (typeof console !== 'undefined') {
      console.error(message);
    }
    try {
      // --- Welcome to debugging React ---
      // This error was thrown as a convenience so that you can use this stack
      // to find the callsite that caused this warning to fire.
      throw new Error(message);
    } catch (x) {}
  }

  warning = function(condition, format, args) {
    var len = arguments.length;
    args = new Array(len > 2 ? len - 2 : 0);
    for (var key = 2; key < len; key++) {
      args[key - 2] = arguments[key];
    }
    if (format === undefined) {
      throw new Error(
          '`warning(condition, format, ...args)` requires a warning ' +
          'message argument'
      );
    }
    if (!condition) {
      printWarning.apply(null, [format].concat(args));
    }
  };
}

module.exports = warning;


/***/ }),

/***/ 6942:
/***/ ((module, exports) => {

var __WEBPACK_AMD_DEFINE_ARRAY__, __WEBPACK_AMD_DEFINE_RESULT__;/*!
	Copyright (c) 2018 Jed Watson.
	Licensed under the MIT License (MIT), see
	http://jedwatson.github.io/classnames
*/
/* global define */

(function () {
	'use strict';

	var hasOwn = {}.hasOwnProperty;

	function classNames () {
		var classes = '';

		for (var i = 0; i < arguments.length; i++) {
			var arg = arguments[i];
			if (arg) {
				classes = appendClass(classes, parseValue(arg));
			}
		}

		return classes;
	}

	function parseValue (arg) {
		if (typeof arg === 'string' || typeof arg === 'number') {
			return arg;
		}

		if (typeof arg !== 'object') {
			return '';
		}

		if (Array.isArray(arg)) {
			return classNames.apply(null, arg);
		}

		if (arg.toString !== Object.prototype.toString && !arg.toString.toString().includes('[native code]')) {
			return arg.toString();
		}

		var classes = '';

		for (var key in arg) {
			if (hasOwn.call(arg, key) && arg[key]) {
				classes = appendClass(classes, key);
			}
		}

		return classes;
	}

	function appendClass (value, newClass) {
		if (!newClass) {
			return value;
		}
	
		if (value) {
			return value + ' ' + newClass;
		}
	
		return value + newClass;
	}

	if ( true && module.exports) {
		classNames.default = classNames;
		module.exports = classNames;
	} else if (true) {
		// register as 'classnames', consistent with npm package name
		!(__WEBPACK_AMD_DEFINE_ARRAY__ = [], __WEBPACK_AMD_DEFINE_RESULT__ = (function () {
			return classNames;
		}).apply(exports, __WEBPACK_AMD_DEFINE_ARRAY__),
		__WEBPACK_AMD_DEFINE_RESULT__ !== undefined && (module.exports = __WEBPACK_AMD_DEFINE_RESULT__));
	} else {}
}());


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
/******/ 		__webpack_modules__[moduleId].call(module.exports, module, module.exports, __webpack_require__);
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
/******/ 	/* webpack/runtime/global */
/******/ 	(() => {
/******/ 		__webpack_require__.g = (function() {
/******/ 			if (typeof globalThis === 'object') return globalThis;
/******/ 			try {
/******/ 				return this || new Function('return this')();
/******/ 			} catch (e) {
/******/ 				if (typeof window === 'object') return window;
/******/ 			}
/******/ 		})();
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	(() => {
/******/ 		__webpack_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
/******/ 	})();
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
// This entry need to be wrapped in an IIFE because it need to be in strict mode.
(() => {
"use strict";

;// CONCATENATED MODULE: ./node_modules/@tanstack/query-core/build/lib/utils.mjs
// TYPES
// UTILS
const isServer = typeof window === 'undefined' || 'Deno' in window;
function noop() {
  return undefined;
}
function functionalUpdate(updater, input) {
  return typeof updater === 'function' ? updater(input) : updater;
}
function isValidTimeout(value) {
  return typeof value === 'number' && value >= 0 && value !== Infinity;
}
function difference(array1, array2) {
  return array1.filter(x => !array2.includes(x));
}
function replaceAt(array, index, value) {
  const copy = array.slice(0);
  copy[index] = value;
  return copy;
}
function timeUntilStale(updatedAt, staleTime) {
  return Math.max(updatedAt + (staleTime || 0) - Date.now(), 0);
}
function parseQueryArgs(arg1, arg2, arg3) {
  if (!isQueryKey(arg1)) {
    return arg1;
  }

  if (typeof arg2 === 'function') {
    return { ...arg3,
      queryKey: arg1,
      queryFn: arg2
    };
  }

  return { ...arg2,
    queryKey: arg1
  };
}
function parseMutationArgs(arg1, arg2, arg3) {
  if (isQueryKey(arg1)) {
    if (typeof arg2 === 'function') {
      return { ...arg3,
        mutationKey: arg1,
        mutationFn: arg2
      };
    }

    return { ...arg2,
      mutationKey: arg1
    };
  }

  if (typeof arg1 === 'function') {
    return { ...arg2,
      mutationFn: arg1
    };
  }

  return { ...arg1
  };
}
function parseFilterArgs(arg1, arg2, arg3) {
  return isQueryKey(arg1) ? [{ ...arg2,
    queryKey: arg1
  }, arg3] : [arg1 || {}, arg2];
}
function parseMutationFilterArgs(arg1, arg2, arg3) {
  return isQueryKey(arg1) ? [{ ...arg2,
    mutationKey: arg1
  }, arg3] : [arg1 || {}, arg2];
}
function matchQuery(filters, query) {
  const {
    type = 'all',
    exact,
    fetchStatus,
    predicate,
    queryKey,
    stale
  } = filters;

  if (isQueryKey(queryKey)) {
    if (exact) {
      if (query.queryHash !== hashQueryKeyByOptions(queryKey, query.options)) {
        return false;
      }
    } else if (!partialMatchKey(query.queryKey, queryKey)) {
      return false;
    }
  }

  if (type !== 'all') {
    const isActive = query.isActive();

    if (type === 'active' && !isActive) {
      return false;
    }

    if (type === 'inactive' && isActive) {
      return false;
    }
  }

  if (typeof stale === 'boolean' && query.isStale() !== stale) {
    return false;
  }

  if (typeof fetchStatus !== 'undefined' && fetchStatus !== query.state.fetchStatus) {
    return false;
  }

  if (predicate && !predicate(query)) {
    return false;
  }

  return true;
}
function matchMutation(filters, mutation) {
  const {
    exact,
    fetching,
    predicate,
    mutationKey
  } = filters;

  if (isQueryKey(mutationKey)) {
    if (!mutation.options.mutationKey) {
      return false;
    }

    if (exact) {
      if (hashQueryKey(mutation.options.mutationKey) !== hashQueryKey(mutationKey)) {
        return false;
      }
    } else if (!partialMatchKey(mutation.options.mutationKey, mutationKey)) {
      return false;
    }
  }

  if (typeof fetching === 'boolean' && mutation.state.status === 'loading' !== fetching) {
    return false;
  }

  if (predicate && !predicate(mutation)) {
    return false;
  }

  return true;
}
function hashQueryKeyByOptions(queryKey, options) {
  const hashFn = (options == null ? void 0 : options.queryKeyHashFn) || hashQueryKey;
  return hashFn(queryKey);
}
/**
 * Default query keys hash function.
 * Hashes the value into a stable hash.
 */

function hashQueryKey(queryKey) {
  return JSON.stringify(queryKey, (_, val) => isPlainObject(val) ? Object.keys(val).sort().reduce((result, key) => {
    result[key] = val[key];
    return result;
  }, {}) : val);
}
/**
 * Checks if key `b` partially matches with key `a`.
 */

function partialMatchKey(a, b) {
  return partialDeepEqual(a, b);
}
/**
 * Checks if `b` partially matches with `a`.
 */

function partialDeepEqual(a, b) {
  if (a === b) {
    return true;
  }

  if (typeof a !== typeof b) {
    return false;
  }

  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return !Object.keys(b).some(key => !partialDeepEqual(a[key], b[key]));
  }

  return false;
}
/**
 * This function returns `a` if `b` is deeply equal.
 * If not, it will replace any deeply equal children of `b` with those of `a`.
 * This can be used for structural sharing between JSON values for example.
 */

function replaceEqualDeep(a, b) {
  if (a === b) {
    return a;
  }

  const array = isPlainArray(a) && isPlainArray(b);

  if (array || isPlainObject(a) && isPlainObject(b)) {
    const aSize = array ? a.length : Object.keys(a).length;
    const bItems = array ? b : Object.keys(b);
    const bSize = bItems.length;
    const copy = array ? [] : {};
    let equalItems = 0;

    for (let i = 0; i < bSize; i++) {
      const key = array ? i : bItems[i];
      copy[key] = replaceEqualDeep(a[key], b[key]);

      if (copy[key] === a[key]) {
        equalItems++;
      }
    }

    return aSize === bSize && equalItems === aSize ? a : copy;
  }

  return b;
}
/**
 * Shallow compare objects. Only works with objects that always have the same properties.
 */

function shallowEqualObjects(a, b) {
  if (a && !b || b && !a) {
    return false;
  }

  for (const key in a) {
    if (a[key] !== b[key]) {
      return false;
    }
  }

  return true;
}
function isPlainArray(value) {
  return Array.isArray(value) && value.length === Object.keys(value).length;
} // Copied from: https://github.com/jonschlinkert/is-plain-object

function isPlainObject(o) {
  if (!hasObjectPrototype(o)) {
    return false;
  } // If has modified constructor


  const ctor = o.constructor;

  if (typeof ctor === 'undefined') {
    return true;
  } // If has modified prototype


  const prot = ctor.prototype;

  if (!hasObjectPrototype(prot)) {
    return false;
  } // If constructor does not have an Object-specific method


  if (!prot.hasOwnProperty('isPrototypeOf')) {
    return false;
  } // Most likely a plain Object


  return true;
}

function hasObjectPrototype(o) {
  return Object.prototype.toString.call(o) === '[object Object]';
}

function isQueryKey(value) {
  return Array.isArray(value);
}
function isError(value) {
  return value instanceof Error;
}
function sleep(timeout) {
  return new Promise(resolve => {
    setTimeout(resolve, timeout);
  });
}
/**
 * Schedules a microtask.
 * This can be useful to schedule state updates after rendering.
 */

function scheduleMicrotask(callback) {
  sleep(0).then(callback);
}
function getAbortController() {
  if (typeof AbortController === 'function') {
    return new AbortController();
  }

  return;
}
function replaceData(prevData, data, options) {
  // Use prev data if an isDataEqual function is defined and returns `true`
  if (options.isDataEqual != null && options.isDataEqual(prevData, data)) {
    return prevData;
  } else if (typeof options.structuralSharing === 'function') {
    return options.structuralSharing(prevData, data);
  } else if (options.structuralSharing !== false) {
    // Structurally share data between prev and new data if needed
    return replaceEqualDeep(prevData, data);
  }

  return data;
}


//# sourceMappingURL=utils.mjs.map

;// CONCATENATED MODULE: ./node_modules/@tanstack/query-core/build/lib/logger.mjs
const defaultLogger = console;


//# sourceMappingURL=logger.mjs.map

;// CONCATENATED MODULE: ./node_modules/@tanstack/query-core/build/lib/notifyManager.mjs


function createNotifyManager() {
  let queue = [];
  let transactions = 0;

  let notifyFn = callback => {
    callback();
  };

  let batchNotifyFn = callback => {
    callback();
  };

  const batch = callback => {
    let result;
    transactions++;

    try {
      result = callback();
    } finally {
      transactions--;

      if (!transactions) {
        flush();
      }
    }

    return result;
  };

  const schedule = callback => {
    if (transactions) {
      queue.push(callback);
    } else {
      scheduleMicrotask(() => {
        notifyFn(callback);
      });
    }
  };
  /**
   * All calls to the wrapped function will be batched.
   */


  const batchCalls = callback => {
    return (...args) => {
      schedule(() => {
        callback(...args);
      });
    };
  };

  const flush = () => {
    const originalQueue = queue;
    queue = [];

    if (originalQueue.length) {
      scheduleMicrotask(() => {
        batchNotifyFn(() => {
          originalQueue.forEach(callback => {
            notifyFn(callback);
          });
        });
      });
    }
  };
  /**
   * Use this method to set a custom notify function.
   * This can be used to for example wrap notifications with `React.act` while running tests.
   */


  const setNotifyFunction = fn => {
    notifyFn = fn;
  };
  /**
   * Use this method to set a custom function to batch notifications together into a single tick.
   * By default React Query will use the batch function provided by ReactDOM or React Native.
   */


  const setBatchNotifyFunction = fn => {
    batchNotifyFn = fn;
  };

  return {
    batch,
    batchCalls,
    schedule,
    setNotifyFunction,
    setBatchNotifyFunction
  };
} // SINGLETON

const notifyManager = createNotifyManager();


//# sourceMappingURL=notifyManager.mjs.map

;// CONCATENATED MODULE: ./node_modules/@tanstack/query-core/build/lib/subscribable.mjs
class Subscribable {
  constructor() {
    this.listeners = new Set();
    this.subscribe = this.subscribe.bind(this);
  }

  subscribe(listener) {
    const identity = {
      listener
    };
    this.listeners.add(identity);
    this.onSubscribe();
    return () => {
      this.listeners.delete(identity);
      this.onUnsubscribe();
    };
  }

  hasListeners() {
    return this.listeners.size > 0;
  }

  onSubscribe() {// Do nothing
  }

  onUnsubscribe() {// Do nothing
  }

}


//# sourceMappingURL=subscribable.mjs.map

;// CONCATENATED MODULE: ./node_modules/@tanstack/query-core/build/lib/focusManager.mjs



class FocusManager extends Subscribable {
  constructor() {
    super();

    this.setup = onFocus => {
      // addEventListener does not exist in React Native, but window does
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!isServer && window.addEventListener) {
        const listener = () => onFocus(); // Listen to visibillitychange and focus


        window.addEventListener('visibilitychange', listener, false);
        window.addEventListener('focus', listener, false);
        return () => {
          // Be sure to unsubscribe if a new handler is set
          window.removeEventListener('visibilitychange', listener);
          window.removeEventListener('focus', listener);
        };
      }

      return;
    };
  }

  onSubscribe() {
    if (!this.cleanup) {
      this.setEventListener(this.setup);
    }
  }

  onUnsubscribe() {
    if (!this.hasListeners()) {
      var _this$cleanup;

      (_this$cleanup = this.cleanup) == null ? void 0 : _this$cleanup.call(this);
      this.cleanup = undefined;
    }
  }

  setEventListener(setup) {
    var _this$cleanup2;

    this.setup = setup;
    (_this$cleanup2 = this.cleanup) == null ? void 0 : _this$cleanup2.call(this);
    this.cleanup = setup(focused => {
      if (typeof focused === 'boolean') {
        this.setFocused(focused);
      } else {
        this.onFocus();
      }
    });
  }

  setFocused(focused) {
    const changed = this.focused !== focused;

    if (changed) {
      this.focused = focused;
      this.onFocus();
    }
  }

  onFocus() {
    this.listeners.forEach(({
      listener
    }) => {
      listener();
    });
  }

  isFocused() {
    if (typeof this.focused === 'boolean') {
      return this.focused;
    } // document global can be unavailable in react native


    if (typeof document === 'undefined') {
      return true;
    }

    return [undefined, 'visible', 'prerender'].includes(document.visibilityState);
  }

}
const focusManager = new FocusManager();


//# sourceMappingURL=focusManager.mjs.map

;// CONCATENATED MODULE: ./node_modules/@tanstack/query-core/build/lib/onlineManager.mjs



const onlineEvents = ['online', 'offline'];
class OnlineManager extends Subscribable {
  constructor() {
    super();

    this.setup = onOnline => {
      // addEventListener does not exist in React Native, but window does
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!isServer && window.addEventListener) {
        const listener = () => onOnline(); // Listen to online


        onlineEvents.forEach(event => {
          window.addEventListener(event, listener, false);
        });
        return () => {
          // Be sure to unsubscribe if a new handler is set
          onlineEvents.forEach(event => {
            window.removeEventListener(event, listener);
          });
        };
      }

      return;
    };
  }

  onSubscribe() {
    if (!this.cleanup) {
      this.setEventListener(this.setup);
    }
  }

  onUnsubscribe() {
    if (!this.hasListeners()) {
      var _this$cleanup;

      (_this$cleanup = this.cleanup) == null ? void 0 : _this$cleanup.call(this);
      this.cleanup = undefined;
    }
  }

  setEventListener(setup) {
    var _this$cleanup2;

    this.setup = setup;
    (_this$cleanup2 = this.cleanup) == null ? void 0 : _this$cleanup2.call(this);
    this.cleanup = setup(online => {
      if (typeof online === 'boolean') {
        this.setOnline(online);
      } else {
        this.onOnline();
      }
    });
  }

  setOnline(online) {
    const changed = this.online !== online;

    if (changed) {
      this.online = online;
      this.onOnline();
    }
  }

  onOnline() {
    this.listeners.forEach(({
      listener
    }) => {
      listener();
    });
  }

  isOnline() {
    if (typeof this.online === 'boolean') {
      return this.online;
    }

    if (typeof navigator === 'undefined' || typeof navigator.onLine === 'undefined') {
      return true;
    }

    return navigator.onLine;
  }

}
const onlineManager = new OnlineManager();


//# sourceMappingURL=onlineManager.mjs.map

;// CONCATENATED MODULE: ./node_modules/@tanstack/query-core/build/lib/retryer.mjs




function defaultRetryDelay(failureCount) {
  return Math.min(1000 * 2 ** failureCount, 30000);
}

function canFetch(networkMode) {
  return (networkMode != null ? networkMode : 'online') === 'online' ? onlineManager.isOnline() : true;
}
class CancelledError {
  constructor(options) {
    this.revert = options == null ? void 0 : options.revert;
    this.silent = options == null ? void 0 : options.silent;
  }

}
function isCancelledError(value) {
  return value instanceof CancelledError;
}
function createRetryer(config) {
  let isRetryCancelled = false;
  let failureCount = 0;
  let isResolved = false;
  let continueFn;
  let promiseResolve;
  let promiseReject;
  const promise = new Promise((outerResolve, outerReject) => {
    promiseResolve = outerResolve;
    promiseReject = outerReject;
  });

  const cancel = cancelOptions => {
    if (!isResolved) {
      reject(new CancelledError(cancelOptions));
      config.abort == null ? void 0 : config.abort();
    }
  };

  const cancelRetry = () => {
    isRetryCancelled = true;
  };

  const continueRetry = () => {
    isRetryCancelled = false;
  };

  const shouldPause = () => !focusManager.isFocused() || config.networkMode !== 'always' && !onlineManager.isOnline();

  const resolve = value => {
    if (!isResolved) {
      isResolved = true;
      config.onSuccess == null ? void 0 : config.onSuccess(value);
      continueFn == null ? void 0 : continueFn();
      promiseResolve(value);
    }
  };

  const reject = value => {
    if (!isResolved) {
      isResolved = true;
      config.onError == null ? void 0 : config.onError(value);
      continueFn == null ? void 0 : continueFn();
      promiseReject(value);
    }
  };

  const pause = () => {
    return new Promise(continueResolve => {
      continueFn = value => {
        const canContinue = isResolved || !shouldPause();

        if (canContinue) {
          continueResolve(value);
        }

        return canContinue;
      };

      config.onPause == null ? void 0 : config.onPause();
    }).then(() => {
      continueFn = undefined;

      if (!isResolved) {
        config.onContinue == null ? void 0 : config.onContinue();
      }
    });
  }; // Create loop function


  const run = () => {
    // Do nothing if already resolved
    if (isResolved) {
      return;
    }

    let promiseOrValue; // Execute query

    try {
      promiseOrValue = config.fn();
    } catch (error) {
      promiseOrValue = Promise.reject(error);
    }

    Promise.resolve(promiseOrValue).then(resolve).catch(error => {
      var _config$retry, _config$retryDelay;

      // Stop if the fetch is already resolved
      if (isResolved) {
        return;
      } // Do we need to retry the request?


      const retry = (_config$retry = config.retry) != null ? _config$retry : 3;
      const retryDelay = (_config$retryDelay = config.retryDelay) != null ? _config$retryDelay : defaultRetryDelay;
      const delay = typeof retryDelay === 'function' ? retryDelay(failureCount, error) : retryDelay;
      const shouldRetry = retry === true || typeof retry === 'number' && failureCount < retry || typeof retry === 'function' && retry(failureCount, error);

      if (isRetryCancelled || !shouldRetry) {
        // We are done if the query does not need to be retried
        reject(error);
        return;
      }

      failureCount++; // Notify on fail

      config.onFail == null ? void 0 : config.onFail(failureCount, error); // Delay

      sleep(delay) // Pause if the document is not visible or when the device is offline
      .then(() => {
        if (shouldPause()) {
          return pause();
        }

        return;
      }).then(() => {
        if (isRetryCancelled) {
          reject(error);
        } else {
          run();
        }
      });
    });
  }; // Start loop


  if (canFetch(config.networkMode)) {
    run();
  } else {
    pause().then(run);
  }

  return {
    promise,
    cancel,
    continue: () => {
      const didContinue = continueFn == null ? void 0 : continueFn();
      return didContinue ? promise : Promise.resolve();
    },
    cancelRetry,
    continueRetry
  };
}


//# sourceMappingURL=retryer.mjs.map

;// CONCATENATED MODULE: ./node_modules/@tanstack/query-core/build/lib/removable.mjs


class Removable {
  destroy() {
    this.clearGcTimeout();
  }

  scheduleGc() {
    this.clearGcTimeout();

    if (isValidTimeout(this.cacheTime)) {
      this.gcTimeout = setTimeout(() => {
        this.optionalRemove();
      }, this.cacheTime);
    }
  }

  updateCacheTime(newCacheTime) {
    // Default to 5 minutes (Infinity for server-side) if no cache time is set
    this.cacheTime = Math.max(this.cacheTime || 0, newCacheTime != null ? newCacheTime : isServer ? Infinity : 5 * 60 * 1000);
  }

  clearGcTimeout() {
    if (this.gcTimeout) {
      clearTimeout(this.gcTimeout);
      this.gcTimeout = undefined;
    }
  }

}


//# sourceMappingURL=removable.mjs.map

;// CONCATENATED MODULE: ./node_modules/@tanstack/query-core/build/lib/query.mjs






// CLASS
class Query extends Removable {
  constructor(config) {
    super();
    this.abortSignalConsumed = false;
    this.defaultOptions = config.defaultOptions;
    this.setOptions(config.options);
    this.observers = [];
    this.cache = config.cache;
    this.logger = config.logger || defaultLogger;
    this.queryKey = config.queryKey;
    this.queryHash = config.queryHash;
    this.initialState = config.state || getDefaultState(this.options);
    this.state = this.initialState;
    this.scheduleGc();
  }

  get meta() {
    return this.options.meta;
  }

  setOptions(options) {
    this.options = { ...this.defaultOptions,
      ...options
    };
    this.updateCacheTime(this.options.cacheTime);
  }

  optionalRemove() {
    if (!this.observers.length && this.state.fetchStatus === 'idle') {
      this.cache.remove(this);
    }
  }

  setData(newData, options) {
    const data = replaceData(this.state.data, newData, this.options); // Set data and mark it as cached

    this.dispatch({
      data,
      type: 'success',
      dataUpdatedAt: options == null ? void 0 : options.updatedAt,
      manual: options == null ? void 0 : options.manual
    });
    return data;
  }

  setState(state, setStateOptions) {
    this.dispatch({
      type: 'setState',
      state,
      setStateOptions
    });
  }

  cancel(options) {
    var _this$retryer;

    const promise = this.promise;
    (_this$retryer = this.retryer) == null ? void 0 : _this$retryer.cancel(options);
    return promise ? promise.then(noop).catch(noop) : Promise.resolve();
  }

  destroy() {
    super.destroy();
    this.cancel({
      silent: true
    });
  }

  reset() {
    this.destroy();
    this.setState(this.initialState);
  }

  isActive() {
    return this.observers.some(observer => observer.options.enabled !== false);
  }

  isDisabled() {
    return this.getObserversCount() > 0 && !this.isActive();
  }

  isStale() {
    return this.state.isInvalidated || !this.state.dataUpdatedAt || this.observers.some(observer => observer.getCurrentResult().isStale);
  }

  isStaleByTime(staleTime = 0) {
    return this.state.isInvalidated || !this.state.dataUpdatedAt || !timeUntilStale(this.state.dataUpdatedAt, staleTime);
  }

  onFocus() {
    var _this$retryer2;

    const observer = this.observers.find(x => x.shouldFetchOnWindowFocus());

    if (observer) {
      observer.refetch({
        cancelRefetch: false
      });
    } // Continue fetch if currently paused


    (_this$retryer2 = this.retryer) == null ? void 0 : _this$retryer2.continue();
  }

  onOnline() {
    var _this$retryer3;

    const observer = this.observers.find(x => x.shouldFetchOnReconnect());

    if (observer) {
      observer.refetch({
        cancelRefetch: false
      });
    } // Continue fetch if currently paused


    (_this$retryer3 = this.retryer) == null ? void 0 : _this$retryer3.continue();
  }

  addObserver(observer) {
    if (!this.observers.includes(observer)) {
      this.observers.push(observer); // Stop the query from being garbage collected

      this.clearGcTimeout();
      this.cache.notify({
        type: 'observerAdded',
        query: this,
        observer
      });
    }
  }

  removeObserver(observer) {
    if (this.observers.includes(observer)) {
      this.observers = this.observers.filter(x => x !== observer);

      if (!this.observers.length) {
        // If the transport layer does not support cancellation
        // we'll let the query continue so the result can be cached
        if (this.retryer) {
          if (this.abortSignalConsumed) {
            this.retryer.cancel({
              revert: true
            });
          } else {
            this.retryer.cancelRetry();
          }
        }

        this.scheduleGc();
      }

      this.cache.notify({
        type: 'observerRemoved',
        query: this,
        observer
      });
    }
  }

  getObserversCount() {
    return this.observers.length;
  }

  invalidate() {
    if (!this.state.isInvalidated) {
      this.dispatch({
        type: 'invalidate'
      });
    }
  }

  fetch(options, fetchOptions) {
    var _this$options$behavio, _context$fetchOptions;

    if (this.state.fetchStatus !== 'idle') {
      if (this.state.dataUpdatedAt && fetchOptions != null && fetchOptions.cancelRefetch) {
        // Silently cancel current fetch if the user wants to cancel refetches
        this.cancel({
          silent: true
        });
      } else if (this.promise) {
        var _this$retryer4;

        // make sure that retries that were potentially cancelled due to unmounts can continue
        (_this$retryer4 = this.retryer) == null ? void 0 : _this$retryer4.continueRetry(); // Return current promise if we are already fetching

        return this.promise;
      }
    } // Update config if passed, otherwise the config from the last execution is used


    if (options) {
      this.setOptions(options);
    } // Use the options from the first observer with a query function if no function is found.
    // This can happen when the query is hydrated or created with setQueryData.


    if (!this.options.queryFn) {
      const observer = this.observers.find(x => x.options.queryFn);

      if (observer) {
        this.setOptions(observer.options);
      }
    }

    if (false) {}

    const abortController = getAbortController(); // Create query function context

    const queryFnContext = {
      queryKey: this.queryKey,
      pageParam: undefined,
      meta: this.meta
    }; // Adds an enumerable signal property to the object that
    // which sets abortSignalConsumed to true when the signal
    // is read.

    const addSignalProperty = object => {
      Object.defineProperty(object, 'signal', {
        enumerable: true,
        get: () => {
          if (abortController) {
            this.abortSignalConsumed = true;
            return abortController.signal;
          }

          return undefined;
        }
      });
    };

    addSignalProperty(queryFnContext); // Create fetch function

    const fetchFn = () => {
      if (!this.options.queryFn) {
        return Promise.reject("Missing queryFn for queryKey '" + this.options.queryHash + "'");
      }

      this.abortSignalConsumed = false;
      return this.options.queryFn(queryFnContext);
    }; // Trigger behavior hook


    const context = {
      fetchOptions,
      options: this.options,
      queryKey: this.queryKey,
      state: this.state,
      fetchFn
    };
    addSignalProperty(context);
    (_this$options$behavio = this.options.behavior) == null ? void 0 : _this$options$behavio.onFetch(context); // Store state in case the current fetch needs to be reverted

    this.revertState = this.state; // Set to fetching state if not already in it

    if (this.state.fetchStatus === 'idle' || this.state.fetchMeta !== ((_context$fetchOptions = context.fetchOptions) == null ? void 0 : _context$fetchOptions.meta)) {
      var _context$fetchOptions2;

      this.dispatch({
        type: 'fetch',
        meta: (_context$fetchOptions2 = context.fetchOptions) == null ? void 0 : _context$fetchOptions2.meta
      });
    }

    const onError = error => {
      // Optimistically update state if needed
      if (!(isCancelledError(error) && error.silent)) {
        this.dispatch({
          type: 'error',
          error: error
        });
      }

      if (!isCancelledError(error)) {
        var _this$cache$config$on, _this$cache$config, _this$cache$config$on2, _this$cache$config2;

        // Notify cache callback
        (_this$cache$config$on = (_this$cache$config = this.cache.config).onError) == null ? void 0 : _this$cache$config$on.call(_this$cache$config, error, this);
        (_this$cache$config$on2 = (_this$cache$config2 = this.cache.config).onSettled) == null ? void 0 : _this$cache$config$on2.call(_this$cache$config2, this.state.data, error, this);

        if (false) {}
      }

      if (!this.isFetchingOptimistic) {
        // Schedule query gc after fetching
        this.scheduleGc();
      }

      this.isFetchingOptimistic = false;
    }; // Try to fetch the data


    this.retryer = createRetryer({
      fn: context.fetchFn,
      abort: abortController == null ? void 0 : abortController.abort.bind(abortController),
      onSuccess: data => {
        var _this$cache$config$on3, _this$cache$config3, _this$cache$config$on4, _this$cache$config4;

        if (typeof data === 'undefined') {
          if (false) {}

          onError(new Error(this.queryHash + " data is undefined"));
          return;
        }

        this.setData(data); // Notify cache callback

        (_this$cache$config$on3 = (_this$cache$config3 = this.cache.config).onSuccess) == null ? void 0 : _this$cache$config$on3.call(_this$cache$config3, data, this);
        (_this$cache$config$on4 = (_this$cache$config4 = this.cache.config).onSettled) == null ? void 0 : _this$cache$config$on4.call(_this$cache$config4, data, this.state.error, this);

        if (!this.isFetchingOptimistic) {
          // Schedule query gc after fetching
          this.scheduleGc();
        }

        this.isFetchingOptimistic = false;
      },
      onError,
      onFail: (failureCount, error) => {
        this.dispatch({
          type: 'failed',
          failureCount,
          error
        });
      },
      onPause: () => {
        this.dispatch({
          type: 'pause'
        });
      },
      onContinue: () => {
        this.dispatch({
          type: 'continue'
        });
      },
      retry: context.options.retry,
      retryDelay: context.options.retryDelay,
      networkMode: context.options.networkMode
    });
    this.promise = this.retryer.promise;
    return this.promise;
  }

  dispatch(action) {
    const reducer = state => {
      var _action$meta, _action$dataUpdatedAt;

      switch (action.type) {
        case 'failed':
          return { ...state,
            fetchFailureCount: action.failureCount,
            fetchFailureReason: action.error
          };

        case 'pause':
          return { ...state,
            fetchStatus: 'paused'
          };

        case 'continue':
          return { ...state,
            fetchStatus: 'fetching'
          };

        case 'fetch':
          return { ...state,
            fetchFailureCount: 0,
            fetchFailureReason: null,
            fetchMeta: (_action$meta = action.meta) != null ? _action$meta : null,
            fetchStatus: canFetch(this.options.networkMode) ? 'fetching' : 'paused',
            ...(!state.dataUpdatedAt && {
              error: null,
              status: 'loading'
            })
          };

        case 'success':
          return { ...state,
            data: action.data,
            dataUpdateCount: state.dataUpdateCount + 1,
            dataUpdatedAt: (_action$dataUpdatedAt = action.dataUpdatedAt) != null ? _action$dataUpdatedAt : Date.now(),
            error: null,
            isInvalidated: false,
            status: 'success',
            ...(!action.manual && {
              fetchStatus: 'idle',
              fetchFailureCount: 0,
              fetchFailureReason: null
            })
          };

        case 'error':
          const error = action.error;

          if (isCancelledError(error) && error.revert && this.revertState) {
            return { ...this.revertState,
              fetchStatus: 'idle'
            };
          }

          return { ...state,
            error: error,
            errorUpdateCount: state.errorUpdateCount + 1,
            errorUpdatedAt: Date.now(),
            fetchFailureCount: state.fetchFailureCount + 1,
            fetchFailureReason: error,
            fetchStatus: 'idle',
            status: 'error'
          };

        case 'invalidate':
          return { ...state,
            isInvalidated: true
          };

        case 'setState':
          return { ...state,
            ...action.state
          };
      }
    };

    this.state = reducer(this.state);
    notifyManager.batch(() => {
      this.observers.forEach(observer => {
        observer.onQueryUpdate(action);
      });
      this.cache.notify({
        query: this,
        type: 'updated',
        action
      });
    });
  }

}

function getDefaultState(options) {
  const data = typeof options.initialData === 'function' ? options.initialData() : options.initialData;
  const hasData = typeof data !== 'undefined';
  const initialDataUpdatedAt = hasData ? typeof options.initialDataUpdatedAt === 'function' ? options.initialDataUpdatedAt() : options.initialDataUpdatedAt : 0;
  return {
    data,
    dataUpdateCount: 0,
    dataUpdatedAt: hasData ? initialDataUpdatedAt != null ? initialDataUpdatedAt : Date.now() : 0,
    error: null,
    errorUpdateCount: 0,
    errorUpdatedAt: 0,
    fetchFailureCount: 0,
    fetchFailureReason: null,
    fetchMeta: null,
    isInvalidated: false,
    status: hasData ? 'success' : 'loading',
    fetchStatus: 'idle'
  };
}


//# sourceMappingURL=query.mjs.map

;// CONCATENATED MODULE: ./node_modules/@tanstack/query-core/build/lib/queryCache.mjs





// CLASS
class QueryCache extends Subscribable {
  constructor(config) {
    super();
    this.config = config || {};
    this.queries = [];
    this.queriesMap = {};
  }

  build(client, options, state) {
    var _options$queryHash;

    const queryKey = options.queryKey;
    const queryHash = (_options$queryHash = options.queryHash) != null ? _options$queryHash : hashQueryKeyByOptions(queryKey, options);
    let query = this.get(queryHash);

    if (!query) {
      query = new Query({
        cache: this,
        logger: client.getLogger(),
        queryKey,
        queryHash,
        options: client.defaultQueryOptions(options),
        state,
        defaultOptions: client.getQueryDefaults(queryKey)
      });
      this.add(query);
    }

    return query;
  }

  add(query) {
    if (!this.queriesMap[query.queryHash]) {
      this.queriesMap[query.queryHash] = query;
      this.queries.push(query);
      this.notify({
        type: 'added',
        query
      });
    }
  }

  remove(query) {
    const queryInMap = this.queriesMap[query.queryHash];

    if (queryInMap) {
      query.destroy();
      this.queries = this.queries.filter(x => x !== query);

      if (queryInMap === query) {
        delete this.queriesMap[query.queryHash];
      }

      this.notify({
        type: 'removed',
        query
      });
    }
  }

  clear() {
    notifyManager.batch(() => {
      this.queries.forEach(query => {
        this.remove(query);
      });
    });
  }

  get(queryHash) {
    return this.queriesMap[queryHash];
  }

  getAll() {
    return this.queries;
  }

  find(arg1, arg2) {
    const [filters] = parseFilterArgs(arg1, arg2);

    if (typeof filters.exact === 'undefined') {
      filters.exact = true;
    }

    return this.queries.find(query => matchQuery(filters, query));
  }

  findAll(arg1, arg2) {
    const [filters] = parseFilterArgs(arg1, arg2);
    return Object.keys(filters).length > 0 ? this.queries.filter(query => matchQuery(filters, query)) : this.queries;
  }

  notify(event) {
    notifyManager.batch(() => {
      this.listeners.forEach(({
        listener
      }) => {
        listener(event);
      });
    });
  }

  onFocus() {
    notifyManager.batch(() => {
      this.queries.forEach(query => {
        query.onFocus();
      });
    });
  }

  onOnline() {
    notifyManager.batch(() => {
      this.queries.forEach(query => {
        query.onOnline();
      });
    });
  }

}


//# sourceMappingURL=queryCache.mjs.map

;// CONCATENATED MODULE: ./node_modules/@tanstack/query-core/build/lib/mutation.mjs





// CLASS
class Mutation extends Removable {
  constructor(config) {
    super();
    this.defaultOptions = config.defaultOptions;
    this.mutationId = config.mutationId;
    this.mutationCache = config.mutationCache;
    this.logger = config.logger || defaultLogger;
    this.observers = [];
    this.state = config.state || mutation_getDefaultState();
    this.setOptions(config.options);
    this.scheduleGc();
  }

  setOptions(options) {
    this.options = { ...this.defaultOptions,
      ...options
    };
    this.updateCacheTime(this.options.cacheTime);
  }

  get meta() {
    return this.options.meta;
  }

  setState(state) {
    this.dispatch({
      type: 'setState',
      state
    });
  }

  addObserver(observer) {
    if (!this.observers.includes(observer)) {
      this.observers.push(observer); // Stop the mutation from being garbage collected

      this.clearGcTimeout();
      this.mutationCache.notify({
        type: 'observerAdded',
        mutation: this,
        observer
      });
    }
  }

  removeObserver(observer) {
    this.observers = this.observers.filter(x => x !== observer);
    this.scheduleGc();
    this.mutationCache.notify({
      type: 'observerRemoved',
      mutation: this,
      observer
    });
  }

  optionalRemove() {
    if (!this.observers.length) {
      if (this.state.status === 'loading') {
        this.scheduleGc();
      } else {
        this.mutationCache.remove(this);
      }
    }
  }

  continue() {
    var _this$retryer$continu, _this$retryer;

    return (_this$retryer$continu = (_this$retryer = this.retryer) == null ? void 0 : _this$retryer.continue()) != null ? _this$retryer$continu : this.execute();
  }

  async execute() {
    const executeMutation = () => {
      var _this$options$retry;

      this.retryer = createRetryer({
        fn: () => {
          if (!this.options.mutationFn) {
            return Promise.reject('No mutationFn found');
          }

          return this.options.mutationFn(this.state.variables);
        },
        onFail: (failureCount, error) => {
          this.dispatch({
            type: 'failed',
            failureCount,
            error
          });
        },
        onPause: () => {
          this.dispatch({
            type: 'pause'
          });
        },
        onContinue: () => {
          this.dispatch({
            type: 'continue'
          });
        },
        retry: (_this$options$retry = this.options.retry) != null ? _this$options$retry : 0,
        retryDelay: this.options.retryDelay,
        networkMode: this.options.networkMode
      });
      return this.retryer.promise;
    };

    const restored = this.state.status === 'loading';

    try {
      var _this$mutationCache$c3, _this$mutationCache$c4, _this$options$onSucce, _this$options2, _this$mutationCache$c5, _this$mutationCache$c6, _this$options$onSettl, _this$options3;

      if (!restored) {
        var _this$mutationCache$c, _this$mutationCache$c2, _this$options$onMutat, _this$options;

        this.dispatch({
          type: 'loading',
          variables: this.options.variables
        }); // Notify cache callback

        await ((_this$mutationCache$c = (_this$mutationCache$c2 = this.mutationCache.config).onMutate) == null ? void 0 : _this$mutationCache$c.call(_this$mutationCache$c2, this.state.variables, this));
        const context = await ((_this$options$onMutat = (_this$options = this.options).onMutate) == null ? void 0 : _this$options$onMutat.call(_this$options, this.state.variables));

        if (context !== this.state.context) {
          this.dispatch({
            type: 'loading',
            context,
            variables: this.state.variables
          });
        }
      }

      const data = await executeMutation(); // Notify cache callback

      await ((_this$mutationCache$c3 = (_this$mutationCache$c4 = this.mutationCache.config).onSuccess) == null ? void 0 : _this$mutationCache$c3.call(_this$mutationCache$c4, data, this.state.variables, this.state.context, this));
      await ((_this$options$onSucce = (_this$options2 = this.options).onSuccess) == null ? void 0 : _this$options$onSucce.call(_this$options2, data, this.state.variables, this.state.context)); // Notify cache callback

      await ((_this$mutationCache$c5 = (_this$mutationCache$c6 = this.mutationCache.config).onSettled) == null ? void 0 : _this$mutationCache$c5.call(_this$mutationCache$c6, data, null, this.state.variables, this.state.context, this));
      await ((_this$options$onSettl = (_this$options3 = this.options).onSettled) == null ? void 0 : _this$options$onSettl.call(_this$options3, data, null, this.state.variables, this.state.context));
      this.dispatch({
        type: 'success',
        data
      });
      return data;
    } catch (error) {
      try {
        var _this$mutationCache$c7, _this$mutationCache$c8, _this$options$onError, _this$options4, _this$mutationCache$c9, _this$mutationCache$c10, _this$options$onSettl2, _this$options5;

        // Notify cache callback
        await ((_this$mutationCache$c7 = (_this$mutationCache$c8 = this.mutationCache.config).onError) == null ? void 0 : _this$mutationCache$c7.call(_this$mutationCache$c8, error, this.state.variables, this.state.context, this));

        if (false) {}

        await ((_this$options$onError = (_this$options4 = this.options).onError) == null ? void 0 : _this$options$onError.call(_this$options4, error, this.state.variables, this.state.context)); // Notify cache callback

        await ((_this$mutationCache$c9 = (_this$mutationCache$c10 = this.mutationCache.config).onSettled) == null ? void 0 : _this$mutationCache$c9.call(_this$mutationCache$c10, undefined, error, this.state.variables, this.state.context, this));
        await ((_this$options$onSettl2 = (_this$options5 = this.options).onSettled) == null ? void 0 : _this$options$onSettl2.call(_this$options5, undefined, error, this.state.variables, this.state.context));
        throw error;
      } finally {
        this.dispatch({
          type: 'error',
          error: error
        });
      }
    }
  }

  dispatch(action) {
    const reducer = state => {
      switch (action.type) {
        case 'failed':
          return { ...state,
            failureCount: action.failureCount,
            failureReason: action.error
          };

        case 'pause':
          return { ...state,
            isPaused: true
          };

        case 'continue':
          return { ...state,
            isPaused: false
          };

        case 'loading':
          return { ...state,
            context: action.context,
            data: undefined,
            failureCount: 0,
            failureReason: null,
            error: null,
            isPaused: !canFetch(this.options.networkMode),
            status: 'loading',
            variables: action.variables
          };

        case 'success':
          return { ...state,
            data: action.data,
            failureCount: 0,
            failureReason: null,
            error: null,
            status: 'success',
            isPaused: false
          };

        case 'error':
          return { ...state,
            data: undefined,
            error: action.error,
            failureCount: state.failureCount + 1,
            failureReason: action.error,
            isPaused: false,
            status: 'error'
          };

        case 'setState':
          return { ...state,
            ...action.state
          };
      }
    };

    this.state = reducer(this.state);
    notifyManager.batch(() => {
      this.observers.forEach(observer => {
        observer.onMutationUpdate(action);
      });
      this.mutationCache.notify({
        mutation: this,
        type: 'updated',
        action
      });
    });
  }

}
function mutation_getDefaultState() {
  return {
    context: undefined,
    data: undefined,
    error: null,
    failureCount: 0,
    failureReason: null,
    isPaused: false,
    status: 'idle',
    variables: undefined
  };
}


//# sourceMappingURL=mutation.mjs.map

;// CONCATENATED MODULE: ./node_modules/@tanstack/query-core/build/lib/mutationCache.mjs





// CLASS
class MutationCache extends Subscribable {
  constructor(config) {
    super();
    this.config = config || {};
    this.mutations = [];
    this.mutationId = 0;
  }

  build(client, options, state) {
    const mutation = new Mutation({
      mutationCache: this,
      logger: client.getLogger(),
      mutationId: ++this.mutationId,
      options: client.defaultMutationOptions(options),
      state,
      defaultOptions: options.mutationKey ? client.getMutationDefaults(options.mutationKey) : undefined
    });
    this.add(mutation);
    return mutation;
  }

  add(mutation) {
    this.mutations.push(mutation);
    this.notify({
      type: 'added',
      mutation
    });
  }

  remove(mutation) {
    this.mutations = this.mutations.filter(x => x !== mutation);
    this.notify({
      type: 'removed',
      mutation
    });
  }

  clear() {
    notifyManager.batch(() => {
      this.mutations.forEach(mutation => {
        this.remove(mutation);
      });
    });
  }

  getAll() {
    return this.mutations;
  }

  find(filters) {
    if (typeof filters.exact === 'undefined') {
      filters.exact = true;
    }

    return this.mutations.find(mutation => matchMutation(filters, mutation));
  }

  findAll(filters) {
    return this.mutations.filter(mutation => matchMutation(filters, mutation));
  }

  notify(event) {
    notifyManager.batch(() => {
      this.listeners.forEach(({
        listener
      }) => {
        listener(event);
      });
    });
  }

  resumePausedMutations() {
    var _this$resuming;

    this.resuming = ((_this$resuming = this.resuming) != null ? _this$resuming : Promise.resolve()).then(() => {
      const pausedMutations = this.mutations.filter(x => x.state.isPaused);
      return notifyManager.batch(() => pausedMutations.reduce((promise, mutation) => promise.then(() => mutation.continue().catch(noop)), Promise.resolve()));
    }).then(() => {
      this.resuming = undefined;
    });
    return this.resuming;
  }

}


//# sourceMappingURL=mutationCache.mjs.map

;// CONCATENATED MODULE: ./node_modules/@tanstack/query-core/build/lib/infiniteQueryBehavior.mjs
function infiniteQueryBehavior() {
  return {
    onFetch: context => {
      context.fetchFn = () => {
        var _context$fetchOptions, _context$fetchOptions2, _context$fetchOptions3, _context$fetchOptions4, _context$state$data, _context$state$data2;

        const refetchPage = (_context$fetchOptions = context.fetchOptions) == null ? void 0 : (_context$fetchOptions2 = _context$fetchOptions.meta) == null ? void 0 : _context$fetchOptions2.refetchPage;
        const fetchMore = (_context$fetchOptions3 = context.fetchOptions) == null ? void 0 : (_context$fetchOptions4 = _context$fetchOptions3.meta) == null ? void 0 : _context$fetchOptions4.fetchMore;
        const pageParam = fetchMore == null ? void 0 : fetchMore.pageParam;
        const isFetchingNextPage = (fetchMore == null ? void 0 : fetchMore.direction) === 'forward';
        const isFetchingPreviousPage = (fetchMore == null ? void 0 : fetchMore.direction) === 'backward';
        const oldPages = ((_context$state$data = context.state.data) == null ? void 0 : _context$state$data.pages) || [];
        const oldPageParams = ((_context$state$data2 = context.state.data) == null ? void 0 : _context$state$data2.pageParams) || [];
        let newPageParams = oldPageParams;
        let cancelled = false;

        const addSignalProperty = object => {
          Object.defineProperty(object, 'signal', {
            enumerable: true,
            get: () => {
              var _context$signal;

              if ((_context$signal = context.signal) != null && _context$signal.aborted) {
                cancelled = true;
              } else {
                var _context$signal2;

                (_context$signal2 = context.signal) == null ? void 0 : _context$signal2.addEventListener('abort', () => {
                  cancelled = true;
                });
              }

              return context.signal;
            }
          });
        }; // Get query function


        const queryFn = context.options.queryFn || (() => Promise.reject("Missing queryFn for queryKey '" + context.options.queryHash + "'"));

        const buildNewPages = (pages, param, page, previous) => {
          newPageParams = previous ? [param, ...newPageParams] : [...newPageParams, param];
          return previous ? [page, ...pages] : [...pages, page];
        }; // Create function to fetch a page


        const fetchPage = (pages, manual, param, previous) => {
          if (cancelled) {
            return Promise.reject('Cancelled');
          }

          if (typeof param === 'undefined' && !manual && pages.length) {
            return Promise.resolve(pages);
          }

          const queryFnContext = {
            queryKey: context.queryKey,
            pageParam: param,
            meta: context.options.meta
          };
          addSignalProperty(queryFnContext);
          const queryFnResult = queryFn(queryFnContext);
          const promise = Promise.resolve(queryFnResult).then(page => buildNewPages(pages, param, page, previous));
          return promise;
        };

        let promise; // Fetch first page?

        if (!oldPages.length) {
          promise = fetchPage([]);
        } // Fetch next page?
        else if (isFetchingNextPage) {
          const manual = typeof pageParam !== 'undefined';
          const param = manual ? pageParam : getNextPageParam(context.options, oldPages);
          promise = fetchPage(oldPages, manual, param);
        } // Fetch previous page?
        else if (isFetchingPreviousPage) {
          const manual = typeof pageParam !== 'undefined';
          const param = manual ? pageParam : getPreviousPageParam(context.options, oldPages);
          promise = fetchPage(oldPages, manual, param, true);
        } // Refetch pages
        else {
          newPageParams = [];
          const manual = typeof context.options.getNextPageParam === 'undefined';
          const shouldFetchFirstPage = refetchPage && oldPages[0] ? refetchPage(oldPages[0], 0, oldPages) : true; // Fetch first page

          promise = shouldFetchFirstPage ? fetchPage([], manual, oldPageParams[0]) : Promise.resolve(buildNewPages([], oldPageParams[0], oldPages[0])); // Fetch remaining pages

          for (let i = 1; i < oldPages.length; i++) {
            promise = promise.then(pages => {
              const shouldFetchNextPage = refetchPage && oldPages[i] ? refetchPage(oldPages[i], i, oldPages) : true;

              if (shouldFetchNextPage) {
                const param = manual ? oldPageParams[i] : getNextPageParam(context.options, pages);
                return fetchPage(pages, manual, param);
              }

              return Promise.resolve(buildNewPages(pages, oldPageParams[i], oldPages[i]));
            });
          }
        }

        const finalPromise = promise.then(pages => ({
          pages,
          pageParams: newPageParams
        }));
        return finalPromise;
      };
    }
  };
}
function getNextPageParam(options, pages) {
  return options.getNextPageParam == null ? void 0 : options.getNextPageParam(pages[pages.length - 1], pages);
}
function getPreviousPageParam(options, pages) {
  return options.getPreviousPageParam == null ? void 0 : options.getPreviousPageParam(pages[0], pages);
}
/**
 * Checks if there is a next page.
 * Returns `undefined` if it cannot be determined.
 */

function hasNextPage(options, pages) {
  if (options.getNextPageParam && Array.isArray(pages)) {
    const nextPageParam = getNextPageParam(options, pages);
    return typeof nextPageParam !== 'undefined' && nextPageParam !== null && nextPageParam !== false;
  }

  return;
}
/**
 * Checks if there is a previous page.
 * Returns `undefined` if it cannot be determined.
 */

function hasPreviousPage(options, pages) {
  if (options.getPreviousPageParam && Array.isArray(pages)) {
    const previousPageParam = getPreviousPageParam(options, pages);
    return typeof previousPageParam !== 'undefined' && previousPageParam !== null && previousPageParam !== false;
  }

  return;
}


//# sourceMappingURL=infiniteQueryBehavior.mjs.map

;// CONCATENATED MODULE: ./node_modules/@tanstack/query-core/build/lib/queryClient.mjs









// CLASS
class QueryClient {
  constructor(config = {}) {
    this.queryCache = config.queryCache || new QueryCache();
    this.mutationCache = config.mutationCache || new MutationCache();
    this.logger = config.logger || defaultLogger;
    this.defaultOptions = config.defaultOptions || {};
    this.queryDefaults = [];
    this.mutationDefaults = [];
    this.mountCount = 0;

    if (false) {}
  }

  mount() {
    this.mountCount++;
    if (this.mountCount !== 1) return;
    this.unsubscribeFocus = focusManager.subscribe(() => {
      if (focusManager.isFocused()) {
        this.resumePausedMutations();
        this.queryCache.onFocus();
      }
    });
    this.unsubscribeOnline = onlineManager.subscribe(() => {
      if (onlineManager.isOnline()) {
        this.resumePausedMutations();
        this.queryCache.onOnline();
      }
    });
  }

  unmount() {
    var _this$unsubscribeFocu, _this$unsubscribeOnli;

    this.mountCount--;
    if (this.mountCount !== 0) return;
    (_this$unsubscribeFocu = this.unsubscribeFocus) == null ? void 0 : _this$unsubscribeFocu.call(this);
    this.unsubscribeFocus = undefined;
    (_this$unsubscribeOnli = this.unsubscribeOnline) == null ? void 0 : _this$unsubscribeOnli.call(this);
    this.unsubscribeOnline = undefined;
  }

  isFetching(arg1, arg2) {
    const [filters] = parseFilterArgs(arg1, arg2);
    filters.fetchStatus = 'fetching';
    return this.queryCache.findAll(filters).length;
  }

  isMutating(filters) {
    return this.mutationCache.findAll({ ...filters,
      fetching: true
    }).length;
  }

  getQueryData(queryKey, filters) {
    var _this$queryCache$find;

    return (_this$queryCache$find = this.queryCache.find(queryKey, filters)) == null ? void 0 : _this$queryCache$find.state.data;
  }

  ensureQueryData(arg1, arg2, arg3) {
    const parsedOptions = parseQueryArgs(arg1, arg2, arg3);
    const cachedData = this.getQueryData(parsedOptions.queryKey);
    return cachedData ? Promise.resolve(cachedData) : this.fetchQuery(parsedOptions);
  }

  getQueriesData(queryKeyOrFilters) {
    return this.getQueryCache().findAll(queryKeyOrFilters).map(({
      queryKey,
      state
    }) => {
      const data = state.data;
      return [queryKey, data];
    });
  }

  setQueryData(queryKey, updater, options) {
    const query = this.queryCache.find(queryKey);
    const prevData = query == null ? void 0 : query.state.data;
    const data = functionalUpdate(updater, prevData);

    if (typeof data === 'undefined') {
      return undefined;
    }

    const parsedOptions = parseQueryArgs(queryKey);
    const defaultedOptions = this.defaultQueryOptions(parsedOptions);
    return this.queryCache.build(this, defaultedOptions).setData(data, { ...options,
      manual: true
    });
  }

  setQueriesData(queryKeyOrFilters, updater, options) {
    return notifyManager.batch(() => this.getQueryCache().findAll(queryKeyOrFilters).map(({
      queryKey
    }) => [queryKey, this.setQueryData(queryKey, updater, options)]));
  }

  getQueryState(queryKey, filters) {
    var _this$queryCache$find2;

    return (_this$queryCache$find2 = this.queryCache.find(queryKey, filters)) == null ? void 0 : _this$queryCache$find2.state;
  }

  removeQueries(arg1, arg2) {
    const [filters] = parseFilterArgs(arg1, arg2);
    const queryCache = this.queryCache;
    notifyManager.batch(() => {
      queryCache.findAll(filters).forEach(query => {
        queryCache.remove(query);
      });
    });
  }

  resetQueries(arg1, arg2, arg3) {
    const [filters, options] = parseFilterArgs(arg1, arg2, arg3);
    const queryCache = this.queryCache;
    const refetchFilters = {
      type: 'active',
      ...filters
    };
    return notifyManager.batch(() => {
      queryCache.findAll(filters).forEach(query => {
        query.reset();
      });
      return this.refetchQueries(refetchFilters, options);
    });
  }

  cancelQueries(arg1, arg2, arg3) {
    const [filters, cancelOptions = {}] = parseFilterArgs(arg1, arg2, arg3);

    if (typeof cancelOptions.revert === 'undefined') {
      cancelOptions.revert = true;
    }

    const promises = notifyManager.batch(() => this.queryCache.findAll(filters).map(query => query.cancel(cancelOptions)));
    return Promise.all(promises).then(noop).catch(noop);
  }

  invalidateQueries(arg1, arg2, arg3) {
    const [filters, options] = parseFilterArgs(arg1, arg2, arg3);
    return notifyManager.batch(() => {
      var _ref, _filters$refetchType;

      this.queryCache.findAll(filters).forEach(query => {
        query.invalidate();
      });

      if (filters.refetchType === 'none') {
        return Promise.resolve();
      }

      const refetchFilters = { ...filters,
        type: (_ref = (_filters$refetchType = filters.refetchType) != null ? _filters$refetchType : filters.type) != null ? _ref : 'active'
      };
      return this.refetchQueries(refetchFilters, options);
    });
  }

  refetchQueries(arg1, arg2, arg3) {
    const [filters, options] = parseFilterArgs(arg1, arg2, arg3);
    const promises = notifyManager.batch(() => this.queryCache.findAll(filters).filter(query => !query.isDisabled()).map(query => {
      var _options$cancelRefetc;

      return query.fetch(undefined, { ...options,
        cancelRefetch: (_options$cancelRefetc = options == null ? void 0 : options.cancelRefetch) != null ? _options$cancelRefetc : true,
        meta: {
          refetchPage: filters.refetchPage
        }
      });
    }));
    let promise = Promise.all(promises).then(noop);

    if (!(options != null && options.throwOnError)) {
      promise = promise.catch(noop);
    }

    return promise;
  }

  fetchQuery(arg1, arg2, arg3) {
    const parsedOptions = parseQueryArgs(arg1, arg2, arg3);
    const defaultedOptions = this.defaultQueryOptions(parsedOptions); // https://github.com/tannerlinsley/react-query/issues/652

    if (typeof defaultedOptions.retry === 'undefined') {
      defaultedOptions.retry = false;
    }

    const query = this.queryCache.build(this, defaultedOptions);
    return query.isStaleByTime(defaultedOptions.staleTime) ? query.fetch(defaultedOptions) : Promise.resolve(query.state.data);
  }

  prefetchQuery(arg1, arg2, arg3) {
    return this.fetchQuery(arg1, arg2, arg3).then(noop).catch(noop);
  }

  fetchInfiniteQuery(arg1, arg2, arg3) {
    const parsedOptions = parseQueryArgs(arg1, arg2, arg3);
    parsedOptions.behavior = infiniteQueryBehavior();
    return this.fetchQuery(parsedOptions);
  }

  prefetchInfiniteQuery(arg1, arg2, arg3) {
    return this.fetchInfiniteQuery(arg1, arg2, arg3).then(noop).catch(noop);
  }

  resumePausedMutations() {
    return this.mutationCache.resumePausedMutations();
  }

  getQueryCache() {
    return this.queryCache;
  }

  getMutationCache() {
    return this.mutationCache;
  }

  getLogger() {
    return this.logger;
  }

  getDefaultOptions() {
    return this.defaultOptions;
  }

  setDefaultOptions(options) {
    this.defaultOptions = options;
  }

  setQueryDefaults(queryKey, options) {
    const result = this.queryDefaults.find(x => hashQueryKey(queryKey) === hashQueryKey(x.queryKey));

    if (result) {
      result.defaultOptions = options;
    } else {
      this.queryDefaults.push({
        queryKey,
        defaultOptions: options
      });
    }
  }

  getQueryDefaults(queryKey) {
    if (!queryKey) {
      return undefined;
    } // Get the first matching defaults


    const firstMatchingDefaults = this.queryDefaults.find(x => partialMatchKey(queryKey, x.queryKey)); // Additional checks and error in dev mode

    if (false) {}

    return firstMatchingDefaults == null ? void 0 : firstMatchingDefaults.defaultOptions;
  }

  setMutationDefaults(mutationKey, options) {
    const result = this.mutationDefaults.find(x => hashQueryKey(mutationKey) === hashQueryKey(x.mutationKey));

    if (result) {
      result.defaultOptions = options;
    } else {
      this.mutationDefaults.push({
        mutationKey,
        defaultOptions: options
      });
    }
  }

  getMutationDefaults(mutationKey) {
    if (!mutationKey) {
      return undefined;
    } // Get the first matching defaults


    const firstMatchingDefaults = this.mutationDefaults.find(x => partialMatchKey(mutationKey, x.mutationKey)); // Additional checks and error in dev mode

    if (false) {}

    return firstMatchingDefaults == null ? void 0 : firstMatchingDefaults.defaultOptions;
  }

  defaultQueryOptions(options) {
    if (options != null && options._defaulted) {
      return options;
    }

    const defaultedOptions = { ...this.defaultOptions.queries,
      ...this.getQueryDefaults(options == null ? void 0 : options.queryKey),
      ...options,
      _defaulted: true
    };

    if (!defaultedOptions.queryHash && defaultedOptions.queryKey) {
      defaultedOptions.queryHash = hashQueryKeyByOptions(defaultedOptions.queryKey, defaultedOptions);
    } // dependent default values


    if (typeof defaultedOptions.refetchOnReconnect === 'undefined') {
      defaultedOptions.refetchOnReconnect = defaultedOptions.networkMode !== 'always';
    }

    if (typeof defaultedOptions.useErrorBoundary === 'undefined') {
      defaultedOptions.useErrorBoundary = !!defaultedOptions.suspense;
    }

    return defaultedOptions;
  }

  defaultMutationOptions(options) {
    if (options != null && options._defaulted) {
      return options;
    }

    return { ...this.defaultOptions.mutations,
      ...this.getMutationDefaults(options == null ? void 0 : options.mutationKey),
      ...options,
      _defaulted: true
    };
  }

  clear() {
    this.queryCache.clear();
    this.mutationCache.clear();
  }

}


//# sourceMappingURL=queryClient.mjs.map

// EXTERNAL MODULE: ./node_modules/react/index.js
var react = __webpack_require__(6540);
;// CONCATENATED MODULE: ./node_modules/@tanstack/react-query/build/lib/QueryClientProvider.mjs
'use client';


const defaultContext = /*#__PURE__*/react.createContext(undefined);
const QueryClientSharingContext = /*#__PURE__*/react.createContext(false); // If we are given a context, we will use it.
// Otherwise, if contextSharing is on, we share the first and at least one
// instance of the context across the window
// to ensure that if React Query is used across
// different bundles or microfrontends they will
// all use the same **instance** of context, regardless
// of module scoping.

function getQueryClientContext(context, contextSharing) {
  if (context) {
    return context;
  }

  if (contextSharing && typeof window !== 'undefined') {
    if (!window.ReactQueryClientContext) {
      window.ReactQueryClientContext = defaultContext;
    }

    return window.ReactQueryClientContext;
  }

  return defaultContext;
}

const useQueryClient = ({
  context
} = {}) => {
  const queryClient = react.useContext(getQueryClientContext(context, react.useContext(QueryClientSharingContext)));

  if (!queryClient) {
    throw new Error('No QueryClient set, use QueryClientProvider to set one');
  }

  return queryClient;
};
const QueryClientProvider = ({
  client,
  children,
  context,
  contextSharing = false
}) => {
  react.useEffect(() => {
    client.mount();
    return () => {
      client.unmount();
    };
  }, [client]);

  if (false) {}

  const Context = getQueryClientContext(context, contextSharing);
  return /*#__PURE__*/react.createElement(QueryClientSharingContext.Provider, {
    value: !context && contextSharing
  }, /*#__PURE__*/react.createElement(Context.Provider, {
    value: client
  }, children));
};


//# sourceMappingURL=QueryClientProvider.mjs.map

;// CONCATENATED MODULE: ./node_modules/@tanstack/query-core/build/lib/queryObserver.mjs






class QueryObserver extends Subscribable {
  constructor(client, options) {
    super();
    this.client = client;
    this.options = options;
    this.trackedProps = new Set();
    this.selectError = null;
    this.bindMethods();
    this.setOptions(options);
  }

  bindMethods() {
    this.remove = this.remove.bind(this);
    this.refetch = this.refetch.bind(this);
  }

  onSubscribe() {
    if (this.listeners.size === 1) {
      this.currentQuery.addObserver(this);

      if (shouldFetchOnMount(this.currentQuery, this.options)) {
        this.executeFetch();
      }

      this.updateTimers();
    }
  }

  onUnsubscribe() {
    if (!this.hasListeners()) {
      this.destroy();
    }
  }

  shouldFetchOnReconnect() {
    return shouldFetchOn(this.currentQuery, this.options, this.options.refetchOnReconnect);
  }

  shouldFetchOnWindowFocus() {
    return shouldFetchOn(this.currentQuery, this.options, this.options.refetchOnWindowFocus);
  }

  destroy() {
    this.listeners = new Set();
    this.clearStaleTimeout();
    this.clearRefetchInterval();
    this.currentQuery.removeObserver(this);
  }

  setOptions(options, notifyOptions) {
    const prevOptions = this.options;
    const prevQuery = this.currentQuery;
    this.options = this.client.defaultQueryOptions(options);

    if (false) {}

    if (!shallowEqualObjects(prevOptions, this.options)) {
      this.client.getQueryCache().notify({
        type: 'observerOptionsUpdated',
        query: this.currentQuery,
        observer: this
      });
    }

    if (typeof this.options.enabled !== 'undefined' && typeof this.options.enabled !== 'boolean') {
      throw new Error('Expected enabled to be a boolean');
    } // Keep previous query key if the user does not supply one


    if (!this.options.queryKey) {
      this.options.queryKey = prevOptions.queryKey;
    }

    this.updateQuery();
    const mounted = this.hasListeners(); // Fetch if there are subscribers

    if (mounted && shouldFetchOptionally(this.currentQuery, prevQuery, this.options, prevOptions)) {
      this.executeFetch();
    } // Update result


    this.updateResult(notifyOptions); // Update stale interval if needed

    if (mounted && (this.currentQuery !== prevQuery || this.options.enabled !== prevOptions.enabled || this.options.staleTime !== prevOptions.staleTime)) {
      this.updateStaleTimeout();
    }

    const nextRefetchInterval = this.computeRefetchInterval(); // Update refetch interval if needed

    if (mounted && (this.currentQuery !== prevQuery || this.options.enabled !== prevOptions.enabled || nextRefetchInterval !== this.currentRefetchInterval)) {
      this.updateRefetchInterval(nextRefetchInterval);
    }
  }

  getOptimisticResult(options) {
    const query = this.client.getQueryCache().build(this.client, options);
    const result = this.createResult(query, options);

    if (shouldAssignObserverCurrentProperties(this, result, options)) {
      // this assigns the optimistic result to the current Observer
      // because if the query function changes, useQuery will be performing
      // an effect where it would fetch again.
      // When the fetch finishes, we perform a deep data cloning in order
      // to reuse objects references. This deep data clone is performed against
      // the `observer.currentResult.data` property
      // When QueryKey changes, we refresh the query and get new `optimistic`
      // result, while we leave the `observer.currentResult`, so when new data
      // arrives, it finds the old `observer.currentResult` which is related
      // to the old QueryKey. Which means that currentResult and selectData are
      // out of sync already.
      // To solve this, we move the cursor of the currentResult everytime
      // an observer reads an optimistic value.
      // When keeping the previous data, the result doesn't change until new
      // data arrives.
      this.currentResult = result;
      this.currentResultOptions = this.options;
      this.currentResultState = this.currentQuery.state;
    }

    return result;
  }

  getCurrentResult() {
    return this.currentResult;
  }

  trackResult(result) {
    const trackedResult = {};
    Object.keys(result).forEach(key => {
      Object.defineProperty(trackedResult, key, {
        configurable: false,
        enumerable: true,
        get: () => {
          this.trackedProps.add(key);
          return result[key];
        }
      });
    });
    return trackedResult;
  }

  getCurrentQuery() {
    return this.currentQuery;
  }

  remove() {
    this.client.getQueryCache().remove(this.currentQuery);
  }

  refetch({
    refetchPage,
    ...options
  } = {}) {
    return this.fetch({ ...options,
      meta: {
        refetchPage
      }
    });
  }

  fetchOptimistic(options) {
    const defaultedOptions = this.client.defaultQueryOptions(options);
    const query = this.client.getQueryCache().build(this.client, defaultedOptions);
    query.isFetchingOptimistic = true;
    return query.fetch().then(() => this.createResult(query, defaultedOptions));
  }

  fetch(fetchOptions) {
    var _fetchOptions$cancelR;

    return this.executeFetch({ ...fetchOptions,
      cancelRefetch: (_fetchOptions$cancelR = fetchOptions.cancelRefetch) != null ? _fetchOptions$cancelR : true
    }).then(() => {
      this.updateResult();
      return this.currentResult;
    });
  }

  executeFetch(fetchOptions) {
    // Make sure we reference the latest query as the current one might have been removed
    this.updateQuery(); // Fetch

    let promise = this.currentQuery.fetch(this.options, fetchOptions);

    if (!(fetchOptions != null && fetchOptions.throwOnError)) {
      promise = promise.catch(noop);
    }

    return promise;
  }

  updateStaleTimeout() {
    this.clearStaleTimeout();

    if (isServer || this.currentResult.isStale || !isValidTimeout(this.options.staleTime)) {
      return;
    }

    const time = timeUntilStale(this.currentResult.dataUpdatedAt, this.options.staleTime); // The timeout is sometimes triggered 1 ms before the stale time expiration.
    // To mitigate this issue we always add 1 ms to the timeout.

    const timeout = time + 1;
    this.staleTimeoutId = setTimeout(() => {
      if (!this.currentResult.isStale) {
        this.updateResult();
      }
    }, timeout);
  }

  computeRefetchInterval() {
    var _this$options$refetch;

    return typeof this.options.refetchInterval === 'function' ? this.options.refetchInterval(this.currentResult.data, this.currentQuery) : (_this$options$refetch = this.options.refetchInterval) != null ? _this$options$refetch : false;
  }

  updateRefetchInterval(nextInterval) {
    this.clearRefetchInterval();
    this.currentRefetchInterval = nextInterval;

    if (isServer || this.options.enabled === false || !isValidTimeout(this.currentRefetchInterval) || this.currentRefetchInterval === 0) {
      return;
    }

    this.refetchIntervalId = setInterval(() => {
      if (this.options.refetchIntervalInBackground || focusManager.isFocused()) {
        this.executeFetch();
      }
    }, this.currentRefetchInterval);
  }

  updateTimers() {
    this.updateStaleTimeout();
    this.updateRefetchInterval(this.computeRefetchInterval());
  }

  clearStaleTimeout() {
    if (this.staleTimeoutId) {
      clearTimeout(this.staleTimeoutId);
      this.staleTimeoutId = undefined;
    }
  }

  clearRefetchInterval() {
    if (this.refetchIntervalId) {
      clearInterval(this.refetchIntervalId);
      this.refetchIntervalId = undefined;
    }
  }

  createResult(query, options) {
    const prevQuery = this.currentQuery;
    const prevOptions = this.options;
    const prevResult = this.currentResult;
    const prevResultState = this.currentResultState;
    const prevResultOptions = this.currentResultOptions;
    const queryChange = query !== prevQuery;
    const queryInitialState = queryChange ? query.state : this.currentQueryInitialState;
    const prevQueryResult = queryChange ? this.currentResult : this.previousQueryResult;
    const {
      state
    } = query;
    let {
      dataUpdatedAt,
      error,
      errorUpdatedAt,
      fetchStatus,
      status
    } = state;
    let isPreviousData = false;
    let isPlaceholderData = false;
    let data; // Optimistically set result in fetching state if needed

    if (options._optimisticResults) {
      const mounted = this.hasListeners();
      const fetchOnMount = !mounted && shouldFetchOnMount(query, options);
      const fetchOptionally = mounted && shouldFetchOptionally(query, prevQuery, options, prevOptions);

      if (fetchOnMount || fetchOptionally) {
        fetchStatus = canFetch(query.options.networkMode) ? 'fetching' : 'paused';

        if (!dataUpdatedAt) {
          status = 'loading';
        }
      }

      if (options._optimisticResults === 'isRestoring') {
        fetchStatus = 'idle';
      }
    } // Keep previous data if needed


    if (options.keepPreviousData && !state.dataUpdatedAt && prevQueryResult != null && prevQueryResult.isSuccess && status !== 'error') {
      data = prevQueryResult.data;
      dataUpdatedAt = prevQueryResult.dataUpdatedAt;
      status = prevQueryResult.status;
      isPreviousData = true;
    } // Select data if needed
    else if (options.select && typeof state.data !== 'undefined') {
      // Memoize select result
      if (prevResult && state.data === (prevResultState == null ? void 0 : prevResultState.data) && options.select === this.selectFn) {
        data = this.selectResult;
      } else {
        try {
          this.selectFn = options.select;
          data = options.select(state.data);
          data = replaceData(prevResult == null ? void 0 : prevResult.data, data, options);
          this.selectResult = data;
          this.selectError = null;
        } catch (selectError) {
          if (false) {}

          this.selectError = selectError;
        }
      }
    } // Use query data
    else {
      data = state.data;
    } // Show placeholder data if needed


    if (typeof options.placeholderData !== 'undefined' && typeof data === 'undefined' && status === 'loading') {
      let placeholderData; // Memoize placeholder data

      if (prevResult != null && prevResult.isPlaceholderData && options.placeholderData === (prevResultOptions == null ? void 0 : prevResultOptions.placeholderData)) {
        placeholderData = prevResult.data;
      } else {
        placeholderData = typeof options.placeholderData === 'function' ? options.placeholderData() : options.placeholderData;

        if (options.select && typeof placeholderData !== 'undefined') {
          try {
            placeholderData = options.select(placeholderData);
            this.selectError = null;
          } catch (selectError) {
            if (false) {}

            this.selectError = selectError;
          }
        }
      }

      if (typeof placeholderData !== 'undefined') {
        status = 'success';
        data = replaceData(prevResult == null ? void 0 : prevResult.data, placeholderData, options);
        isPlaceholderData = true;
      }
    }

    if (this.selectError) {
      error = this.selectError;
      data = this.selectResult;
      errorUpdatedAt = Date.now();
      status = 'error';
    }

    const isFetching = fetchStatus === 'fetching';
    const isLoading = status === 'loading';
    const isError = status === 'error';
    const result = {
      status,
      fetchStatus,
      isLoading,
      isSuccess: status === 'success',
      isError,
      isInitialLoading: isLoading && isFetching,
      data,
      dataUpdatedAt,
      error,
      errorUpdatedAt,
      failureCount: state.fetchFailureCount,
      failureReason: state.fetchFailureReason,
      errorUpdateCount: state.errorUpdateCount,
      isFetched: state.dataUpdateCount > 0 || state.errorUpdateCount > 0,
      isFetchedAfterMount: state.dataUpdateCount > queryInitialState.dataUpdateCount || state.errorUpdateCount > queryInitialState.errorUpdateCount,
      isFetching,
      isRefetching: isFetching && !isLoading,
      isLoadingError: isError && state.dataUpdatedAt === 0,
      isPaused: fetchStatus === 'paused',
      isPlaceholderData,
      isPreviousData,
      isRefetchError: isError && state.dataUpdatedAt !== 0,
      isStale: isStale(query, options),
      refetch: this.refetch,
      remove: this.remove
    };
    return result;
  }

  updateResult(notifyOptions) {
    const prevResult = this.currentResult;
    const nextResult = this.createResult(this.currentQuery, this.options);
    this.currentResultState = this.currentQuery.state;
    this.currentResultOptions = this.options; // Only notify and update result if something has changed

    if (shallowEqualObjects(nextResult, prevResult)) {
      return;
    }

    this.currentResult = nextResult; // Determine which callbacks to trigger

    const defaultNotifyOptions = {
      cache: true
    };

    const shouldNotifyListeners = () => {
      if (!prevResult) {
        return true;
      }

      const {
        notifyOnChangeProps
      } = this.options;
      const notifyOnChangePropsValue = typeof notifyOnChangeProps === 'function' ? notifyOnChangeProps() : notifyOnChangeProps;

      if (notifyOnChangePropsValue === 'all' || !notifyOnChangePropsValue && !this.trackedProps.size) {
        return true;
      }

      const includedProps = new Set(notifyOnChangePropsValue != null ? notifyOnChangePropsValue : this.trackedProps);

      if (this.options.useErrorBoundary) {
        includedProps.add('error');
      }

      return Object.keys(this.currentResult).some(key => {
        const typedKey = key;
        const changed = this.currentResult[typedKey] !== prevResult[typedKey];
        return changed && includedProps.has(typedKey);
      });
    };

    if ((notifyOptions == null ? void 0 : notifyOptions.listeners) !== false && shouldNotifyListeners()) {
      defaultNotifyOptions.listeners = true;
    }

    this.notify({ ...defaultNotifyOptions,
      ...notifyOptions
    });
  }

  updateQuery() {
    const query = this.client.getQueryCache().build(this.client, this.options);

    if (query === this.currentQuery) {
      return;
    }

    const prevQuery = this.currentQuery;
    this.currentQuery = query;
    this.currentQueryInitialState = query.state;
    this.previousQueryResult = this.currentResult;

    if (this.hasListeners()) {
      prevQuery == null ? void 0 : prevQuery.removeObserver(this);
      query.addObserver(this);
    }
  }

  onQueryUpdate(action) {
    const notifyOptions = {};

    if (action.type === 'success') {
      notifyOptions.onSuccess = !action.manual;
    } else if (action.type === 'error' && !isCancelledError(action.error)) {
      notifyOptions.onError = true;
    }

    this.updateResult(notifyOptions);

    if (this.hasListeners()) {
      this.updateTimers();
    }
  }

  notify(notifyOptions) {
    notifyManager.batch(() => {
      // First trigger the configuration callbacks
      if (notifyOptions.onSuccess) {
        var _this$options$onSucce, _this$options, _this$options$onSettl, _this$options2;

        (_this$options$onSucce = (_this$options = this.options).onSuccess) == null ? void 0 : _this$options$onSucce.call(_this$options, this.currentResult.data);
        (_this$options$onSettl = (_this$options2 = this.options).onSettled) == null ? void 0 : _this$options$onSettl.call(_this$options2, this.currentResult.data, null);
      } else if (notifyOptions.onError) {
        var _this$options$onError, _this$options3, _this$options$onSettl2, _this$options4;

        (_this$options$onError = (_this$options3 = this.options).onError) == null ? void 0 : _this$options$onError.call(_this$options3, this.currentResult.error);
        (_this$options$onSettl2 = (_this$options4 = this.options).onSettled) == null ? void 0 : _this$options$onSettl2.call(_this$options4, undefined, this.currentResult.error);
      } // Then trigger the listeners


      if (notifyOptions.listeners) {
        this.listeners.forEach(({
          listener
        }) => {
          listener(this.currentResult);
        });
      } // Then the cache listeners


      if (notifyOptions.cache) {
        this.client.getQueryCache().notify({
          query: this.currentQuery,
          type: 'observerResultsUpdated'
        });
      }
    });
  }

}

function shouldLoadOnMount(query, options) {
  return options.enabled !== false && !query.state.dataUpdatedAt && !(query.state.status === 'error' && options.retryOnMount === false);
}

function shouldFetchOnMount(query, options) {
  return shouldLoadOnMount(query, options) || query.state.dataUpdatedAt > 0 && shouldFetchOn(query, options, options.refetchOnMount);
}

function shouldFetchOn(query, options, field) {
  if (options.enabled !== false) {
    const value = typeof field === 'function' ? field(query) : field;
    return value === 'always' || value !== false && isStale(query, options);
  }

  return false;
}

function shouldFetchOptionally(query, prevQuery, options, prevOptions) {
  return options.enabled !== false && (query !== prevQuery || prevOptions.enabled === false) && (!options.suspense || query.state.status !== 'error') && isStale(query, options);
}

function isStale(query, options) {
  return query.isStaleByTime(options.staleTime);
} // this function would decide if we will update the observer's 'current'
// properties after an optimistic reading via getOptimisticResult


function shouldAssignObserverCurrentProperties(observer, optimisticResult, options) {
  // it is important to keep this condition like this for three reasons:
  // 1. It will get removed in the v5
  // 2. it reads: don't update the properties if we want to keep the previous
  // data.
  // 3. The opposite condition (!options.keepPreviousData) would fallthrough
  // and will result in a bad decision
  if (options.keepPreviousData) {
    return false;
  } // this means we want to put some placeholder data when pending and queryKey
  // changed.


  if (options.placeholderData !== undefined) {
    // re-assign properties only if current data is placeholder data
    // which means that data did not arrive yet, so, if there is some cached data
    // we need to "prepare" to receive it
    return optimisticResult.isPlaceholderData;
  } // if the newly created result isn't what the observer is holding as current,
  // then we'll need to update the properties as well


  if (!shallowEqualObjects(observer.getCurrentResult(), optimisticResult)) {
    return true;
  } // basically, just keep previous properties if nothing changed


  return false;
}


//# sourceMappingURL=queryObserver.mjs.map

// EXTERNAL MODULE: ./node_modules/use-sync-external-store/shim/index.js
var shim = __webpack_require__(9888);
;// CONCATENATED MODULE: ./node_modules/@tanstack/react-query/build/lib/useSyncExternalStore.mjs
'use client';


const useSyncExternalStore = shim.useSyncExternalStore;


//# sourceMappingURL=useSyncExternalStore.mjs.map

;// CONCATENATED MODULE: ./node_modules/@tanstack/react-query/build/lib/QueryErrorResetBoundary.mjs
'use client';


function createValue() {
  let isReset = false;
  return {
    clearReset: () => {
      isReset = false;
    },
    reset: () => {
      isReset = true;
    },
    isReset: () => {
      return isReset;
    }
  };
}

const QueryErrorResetBoundaryContext = /*#__PURE__*/react.createContext(createValue()); // HOOK

const useQueryErrorResetBoundary = () => react.useContext(QueryErrorResetBoundaryContext); // COMPONENT

const QueryErrorResetBoundary = ({
  children
}) => {
  const [value] = React.useState(() => createValue());
  return /*#__PURE__*/React.createElement(QueryErrorResetBoundaryContext.Provider, {
    value: value
  }, typeof children === 'function' ? children(value) : children);
};


//# sourceMappingURL=QueryErrorResetBoundary.mjs.map

;// CONCATENATED MODULE: ./node_modules/@tanstack/react-query/build/lib/isRestoring.mjs
'use client';


const IsRestoringContext = /*#__PURE__*/react.createContext(false);
const useIsRestoring = () => react.useContext(IsRestoringContext);
const IsRestoringProvider = IsRestoringContext.Provider;


//# sourceMappingURL=isRestoring.mjs.map

;// CONCATENATED MODULE: ./node_modules/@tanstack/react-query/build/lib/utils.mjs
function shouldThrowError(_useErrorBoundary, params) {
  // Allow useErrorBoundary function to override throwing behavior on a per-error basis
  if (typeof _useErrorBoundary === 'function') {
    return _useErrorBoundary(...params);
  }

  return !!_useErrorBoundary;
}


//# sourceMappingURL=utils.mjs.map

;// CONCATENATED MODULE: ./node_modules/@tanstack/react-query/build/lib/errorBoundaryUtils.mjs
'use client';



const ensurePreventErrorBoundaryRetry = (options, errorResetBoundary) => {
  if (options.suspense || options.useErrorBoundary) {
    // Prevent retrying failed query if the error boundary has not been reset yet
    if (!errorResetBoundary.isReset()) {
      options.retryOnMount = false;
    }
  }
};
const useClearResetErrorBoundary = errorResetBoundary => {
  react.useEffect(() => {
    errorResetBoundary.clearReset();
  }, [errorResetBoundary]);
};
const getHasError = ({
  result,
  errorResetBoundary,
  useErrorBoundary,
  query
}) => {
  return result.isError && !errorResetBoundary.isReset() && !result.isFetching && shouldThrowError(useErrorBoundary, [result.error, query]);
};


//# sourceMappingURL=errorBoundaryUtils.mjs.map

;// CONCATENATED MODULE: ./node_modules/@tanstack/react-query/build/lib/suspense.mjs
const ensureStaleTime = defaultedOptions => {
  if (defaultedOptions.suspense) {
    // Always set stale time when using suspense to prevent
    // fetching again when directly mounting after suspending
    if (typeof defaultedOptions.staleTime !== 'number') {
      defaultedOptions.staleTime = 1000;
    }
  }
};
const willFetch = (result, isRestoring) => result.isLoading && result.isFetching && !isRestoring;
const shouldSuspend = (defaultedOptions, result, isRestoring) => (defaultedOptions == null ? void 0 : defaultedOptions.suspense) && willFetch(result, isRestoring);
const fetchOptimistic = (defaultedOptions, observer, errorResetBoundary) => observer.fetchOptimistic(defaultedOptions).then(({
  data
}) => {
  defaultedOptions.onSuccess == null ? void 0 : defaultedOptions.onSuccess(data);
  defaultedOptions.onSettled == null ? void 0 : defaultedOptions.onSettled(data, null);
}).catch(error => {
  errorResetBoundary.clearReset();
  defaultedOptions.onError == null ? void 0 : defaultedOptions.onError(error);
  defaultedOptions.onSettled == null ? void 0 : defaultedOptions.onSettled(undefined, error);
});


//# sourceMappingURL=suspense.mjs.map

;// CONCATENATED MODULE: ./node_modules/@tanstack/react-query/build/lib/useBaseQuery.mjs
'use client';









function useBaseQuery(options, Observer) {
  const queryClient = useQueryClient({
    context: options.context
  });
  const isRestoring = useIsRestoring();
  const errorResetBoundary = useQueryErrorResetBoundary();
  const defaultedOptions = queryClient.defaultQueryOptions(options); // Make sure results are optimistically set in fetching state before subscribing or updating options

  defaultedOptions._optimisticResults = isRestoring ? 'isRestoring' : 'optimistic'; // Include callbacks in batch renders

  if (defaultedOptions.onError) {
    defaultedOptions.onError = notifyManager.batchCalls(defaultedOptions.onError);
  }

  if (defaultedOptions.onSuccess) {
    defaultedOptions.onSuccess = notifyManager.batchCalls(defaultedOptions.onSuccess);
  }

  if (defaultedOptions.onSettled) {
    defaultedOptions.onSettled = notifyManager.batchCalls(defaultedOptions.onSettled);
  }

  ensureStaleTime(defaultedOptions);
  ensurePreventErrorBoundaryRetry(defaultedOptions, errorResetBoundary);
  useClearResetErrorBoundary(errorResetBoundary);
  const [observer] = react.useState(() => new Observer(queryClient, defaultedOptions));
  const result = observer.getOptimisticResult(defaultedOptions);
  useSyncExternalStore(react.useCallback(onStoreChange => {
    const unsubscribe = isRestoring ? () => undefined : observer.subscribe(notifyManager.batchCalls(onStoreChange)); // Update result to make sure we did not miss any query updates
    // between creating the observer and subscribing to it.

    observer.updateResult();
    return unsubscribe;
  }, [observer, isRestoring]), () => observer.getCurrentResult(), () => observer.getCurrentResult());
  react.useEffect(() => {
    // Do not notify on updates because of changes in the options because
    // these changes should already be reflected in the optimistic result.
    observer.setOptions(defaultedOptions, {
      listeners: false
    });
  }, [defaultedOptions, observer]); // Handle suspense

  if (shouldSuspend(defaultedOptions, result, isRestoring)) {
    throw fetchOptimistic(defaultedOptions, observer, errorResetBoundary);
  } // Handle error boundary


  if (getHasError({
    result,
    errorResetBoundary,
    useErrorBoundary: defaultedOptions.useErrorBoundary,
    query: observer.getCurrentQuery()
  })) {
    throw result.error;
  } // Handle result property usage tracking


  return !defaultedOptions.notifyOnChangeProps ? observer.trackResult(result) : result;
}


//# sourceMappingURL=useBaseQuery.mjs.map

;// CONCATENATED MODULE: ./node_modules/@tanstack/react-query/build/lib/useQuery.mjs
'use client';



function useQuery(arg1, arg2, arg3) {
  const parsedOptions = parseQueryArgs(arg1, arg2, arg3);
  return useBaseQuery(parsedOptions, QueryObserver);
}


//# sourceMappingURL=useQuery.mjs.map

// EXTERNAL MODULE: ./node_modules/async-lock/index.js
var async_lock = __webpack_require__(8465);
var async_lock_default = /*#__PURE__*/__webpack_require__.n(async_lock);
;// CONCATENATED MODULE: ./app/js/queries.ts
const STORAGE_SYNC_PERSIST_DEFAULTS = {
    paused: false,
    theme: "system",
};
async function getStorageSyncPersist() {
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

;// CONCATENATED MODULE: ./app/js/util.ts
function extractHostname(url) {
    let hostname;
    // find & remove protocol (http, ftp, etc.) and get hostname
    if (url.indexOf("://") > -1) {
        hostname = url.split("/")[2];
    }
    else {
        hostname = url.split("/")[0];
    }
    // find & remove port number
    hostname = hostname.split(":")[0];
    // find & remove "?"
    hostname = hostname.split("?")[0];
    return hostname;
}
// Original code from https://stackoverflow.com/a/23945027/368697.
function extractRootDomain(url) {
    let domain = extractHostname(url);
    const splitArr = domain.split(".");
    const arrLen = splitArr.length;
    // extracting the root domain here if there is a subdomain
    if (arrLen > 2) {
        domain = splitArr[arrLen - 2] + "." + splitArr[arrLen - 1];
        // check to see if it's using a Country Code Top Level Domain (ccTLD) (i.e. ".me.uk")
        if (splitArr[arrLen - 1].length === 2 && splitArr[arrLen - 2].length === 2) {
            // this is using a ccTLD
            domain = splitArr[arrLen - 3] + "." + domain;
        }
    }
    return domain;
}
// Serializes closed tabs for comparison. Because the "REMOVED_SAVED_TABS" action comes from the
// popup, the tabs to remove are serialized as strings to pass from popup -> serviceWorker and so
// object comparison is not possible.
function serializeTab(tab) {
    // @ts-expect-error `closedAt` is a TW expando property
    return `${tab.id}:${tab.windowId}:${tab.closedAt}`;
}

;// CONCATENATED MODULE: ./app/js/actions/localStorageActions.ts



function removeAllSavedTabs() {
    return ASYNC_LOCK.acquire("persist:localStorage", async () => {
        const localStorage = await getStorageLocalPersist();
        await chrome.storage.local.set({
            "persist:localStorage": Object.assign(Object.assign({}, localStorage), { savedTabs: [] }),
        });
    });
}
function removeSavedTabs(tabs) {
    return storage_ASYNC_LOCK.acquire("persist:localStorage", async () => {
        const localStorage = await queries_getStorageLocalPersist();
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
function localStorageActions_setTabTimes(tabIds, tabTime) {
    return ASYNC_LOCK.acquire("local.tabTimes", async () => {
        const { tabTimes } = await chrome.storage.local.get({ tabTimes: {} });
        tabIds.forEach((tabId) => {
            tabTimes[tabId] = tabTime;
        });
        await chrome.storage.local.set({
            tabTimes,
        });
    });
}
function localStorageActions_incrementTotalTabsRemoved() {
    return ASYNC_LOCK.acquire("persist:localStorage", async () => {
        const localStorage = await getStorageLocalPersist();
        await chrome.storage.local.set({
            "persist:localStorage": Object.assign(Object.assign({}, localStorage), { totalTabsRemoved: localStorage.totalTabsRemoved + 1 }),
        });
    });
}
function localStorageActions_removeTabTime(tabId) {
    return ASYNC_LOCK.acquire("local.tabTimes", async () => {
        const { tabTimes } = await chrome.storage.local.get({ tabTimes: {} });
        delete tabTimes[tabId];
        await chrome.storage.local.set({
            tabTimes,
        });
    });
}
async function unwrangleTabs(sessionTabs) {
    await storage_ASYNC_LOCK.acquire("persist:localStorage", async () => {
        const localStorage = await queries_getStorageLocalPersist();
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
    const maxTabs = js_settings.get("maxTabs");
    const wrangleOption = js_settings.get("wrangleOption");
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
        const localStorage = await getStorageLocalPersist();
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
        await setTabTime(String(tabId), Date.now());
    }
    else {
        tabId = tabOrTabId.id;
        await setTabTime(String(tabId), (_a = tabOrTabId === null || tabOrTabId === void 0 ? void 0 : tabOrTabId.lastAccessed) !== null && _a !== void 0 ? _a : new Date().getTime());
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
        js_settings.lockTab(tab.id);
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
        const whitelist = js_settings.get("whitelist");
        if (wasChecked) {
            js_settings.set("whitelist", whitelist.filter((d) => d !== domain));
        }
        else {
            js_settings.set("whitelist", [...whitelist, domain]);
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
            const whitelist = js_settings.get("whitelist");
            chrome.contextMenus.update("lockDomain", {
                checked: whitelist.includes(currentDomain),
                title: chrome.i18n.getMessage("contextMenu_lockSpecificDomain", currentDomain) || "",
            });
            chrome.contextMenus.update("lockTab", {
                checked: js_settings.isTabLocked(tab),
            });
        });
    }
}

;// CONCATENATED MODULE: ./app/js/settings.ts


const defaultCache = {};
const defaultLockedIds = [];
const SETTINGS_DEFAULTS = {
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
        for (const i in SETTINGS_DEFAULTS) {
            if (Object.prototype.hasOwnProperty.call(SETTINGS_DEFAULTS, i)) {
                this.cache[i] = SETTINGS_DEFAULTS[i];
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
/* harmony default export */ const js_settings = (Settings);

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
    await localStorageActions_setTabTime(String(tabId), Date.now());
}
const STORAGE_LOCAL_PERSIST_QUERY_KEY = ["storageLocalQuery", { type: "persist" }];
function useStorageLocalPersistQuery() {
    const queryClient = useQueryClient();
    (0,react.useEffect)(() => {
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
    (0,react.useEffect)(() => {
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
const STORAGE_SYNC_QUERY_KEY = ["storageSyncQuery"];
function useStorageSyncQuery() {
    const queryClient = useQueryClient();
    (0,react.useEffect)(() => {
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

;// CONCATENATED MODULE: ./node_modules/@tanstack/query-core/build/lib/mutationObserver.mjs





// CLASS
class MutationObserver extends Subscribable {
  constructor(client, options) {
    super();
    this.client = client;
    this.setOptions(options);
    this.bindMethods();
    this.updateResult();
  }

  bindMethods() {
    this.mutate = this.mutate.bind(this);
    this.reset = this.reset.bind(this);
  }

  setOptions(options) {
    var _this$currentMutation;

    const prevOptions = this.options;
    this.options = this.client.defaultMutationOptions(options);

    if (!shallowEqualObjects(prevOptions, this.options)) {
      this.client.getMutationCache().notify({
        type: 'observerOptionsUpdated',
        mutation: this.currentMutation,
        observer: this
      });
    }

    (_this$currentMutation = this.currentMutation) == null ? void 0 : _this$currentMutation.setOptions(this.options);
  }

  onUnsubscribe() {
    if (!this.hasListeners()) {
      var _this$currentMutation2;

      (_this$currentMutation2 = this.currentMutation) == null ? void 0 : _this$currentMutation2.removeObserver(this);
    }
  }

  onMutationUpdate(action) {
    this.updateResult(); // Determine which callbacks to trigger

    const notifyOptions = {
      listeners: true
    };

    if (action.type === 'success') {
      notifyOptions.onSuccess = true;
    } else if (action.type === 'error') {
      notifyOptions.onError = true;
    }

    this.notify(notifyOptions);
  }

  getCurrentResult() {
    return this.currentResult;
  }

  reset() {
    this.currentMutation = undefined;
    this.updateResult();
    this.notify({
      listeners: true
    });
  }

  mutate(variables, options) {
    this.mutateOptions = options;

    if (this.currentMutation) {
      this.currentMutation.removeObserver(this);
    }

    this.currentMutation = this.client.getMutationCache().build(this.client, { ...this.options,
      variables: typeof variables !== 'undefined' ? variables : this.options.variables
    });
    this.currentMutation.addObserver(this);
    return this.currentMutation.execute();
  }

  updateResult() {
    const state = this.currentMutation ? this.currentMutation.state : mutation_getDefaultState();
    const result = { ...state,
      isLoading: state.status === 'loading',
      isSuccess: state.status === 'success',
      isError: state.status === 'error',
      isIdle: state.status === 'idle',
      mutate: this.mutate,
      reset: this.reset
    };
    this.currentResult = result;
  }

  notify(options) {
    notifyManager.batch(() => {
      // First trigger the mutate callbacks
      if (this.mutateOptions && this.hasListeners()) {
        if (options.onSuccess) {
          var _this$mutateOptions$o, _this$mutateOptions, _this$mutateOptions$o2, _this$mutateOptions2;

          (_this$mutateOptions$o = (_this$mutateOptions = this.mutateOptions).onSuccess) == null ? void 0 : _this$mutateOptions$o.call(_this$mutateOptions, this.currentResult.data, this.currentResult.variables, this.currentResult.context);
          (_this$mutateOptions$o2 = (_this$mutateOptions2 = this.mutateOptions).onSettled) == null ? void 0 : _this$mutateOptions$o2.call(_this$mutateOptions2, this.currentResult.data, null, this.currentResult.variables, this.currentResult.context);
        } else if (options.onError) {
          var _this$mutateOptions$o3, _this$mutateOptions3, _this$mutateOptions$o4, _this$mutateOptions4;

          (_this$mutateOptions$o3 = (_this$mutateOptions3 = this.mutateOptions).onError) == null ? void 0 : _this$mutateOptions$o3.call(_this$mutateOptions3, this.currentResult.error, this.currentResult.variables, this.currentResult.context);
          (_this$mutateOptions$o4 = (_this$mutateOptions4 = this.mutateOptions).onSettled) == null ? void 0 : _this$mutateOptions$o4.call(_this$mutateOptions4, undefined, this.currentResult.error, this.currentResult.variables, this.currentResult.context);
        }
      } // Then trigger the listeners


      if (options.listeners) {
        this.listeners.forEach(({
          listener
        }) => {
          listener(this.currentResult);
        });
      }
    });
  }

}


//# sourceMappingURL=mutationObserver.mjs.map

;// CONCATENATED MODULE: ./node_modules/@tanstack/react-query/build/lib/useMutation.mjs
'use client';






function useMutation(arg1, arg2, arg3) {
  const options = parseMutationArgs(arg1, arg2, arg3);
  const queryClient = useQueryClient({
    context: options.context
  });
  const [observer] = react.useState(() => new MutationObserver(queryClient, options));
  react.useEffect(() => {
    observer.setOptions(options);
  }, [observer, options]);
  const result = useSyncExternalStore(react.useCallback(onStoreChange => observer.subscribe(notifyManager.batchCalls(onStoreChange)), [observer]), () => observer.getCurrentResult(), () => observer.getCurrentResult());
  const mutate = react.useCallback((variables, mutateOptions) => {
    observer.mutate(variables, mutateOptions).catch(useMutation_noop);
  }, [observer]);

  if (result.error && shouldThrowError(observer.options.useErrorBoundary, [result.error])) {
    throw result.error;
  }

  return { ...result,
    mutate,
    mutateAsync: result.mutate
  };
} // eslint-disable-next-line @typescript-eslint/no-empty-function

function useMutation_noop() {}


//# sourceMappingURL=useMutation.mjs.map

;// CONCATENATED MODULE: ./app/js/PauseButton.tsx




function PauseButton() {
    const { data: storageSyncPersistData } = useStorageSyncPersistQuery();
    const pausedMutation = useMutation({
        mutationFn: (nextPaused) => mutateStorageSyncPersist({ key: "paused", value: nextPaused }),
    });
    function pause() {
        pausedMutation.mutate(true);
    }
    function play() {
        pausedMutation.mutate(false);
    }
    return (react.createElement("button", { className: "btn btn-secondary btn-sm", disabled: storageSyncPersistData == null, onClick: storageSyncPersistData == null || !storageSyncPersistData.paused ? pause : play, type: "button" }, storageSyncPersistData == null || !storageSyncPersistData.paused ? (react.createElement(react.Fragment, null,
        react.createElement("i", { className: "fas fa-pause" }),
        " ",
        chrome.i18n.getMessage("extension_pause"))) : (react.createElement(react.Fragment, null,
        react.createElement("i", { className: "fas fa-play" }),
        " ",
        chrome.i18n.getMessage("extension_resume")))));
}

// EXTERNAL MODULE: ./node_modules/classnames/index.js
var classnames = __webpack_require__(6942);
var classnames_default = /*#__PURE__*/__webpack_require__.n(classnames);
;// CONCATENATED MODULE: ./app/js/NavBar.tsx




function NavBar({ activeTabId, onClickTab }) {
    return (react.createElement(react.Fragment, null,
        react.createElement("div", { className: "nav-bar--buttons" },
            react.createElement(PauseButton, null)),
        react.createElement("ul", { className: "nav nav-tabs" },
            react.createElement("li", { className: "nav-item" },
                react.createElement("a", { className: classnames_default()("nav-link", { active: activeTabId === "corral" }), href: "#corral", onClick: (event) => {
                        event.preventDefault();
                        onClickTab("corral");
                    } }, chrome.i18n.getMessage("tabCorral_name"))),
            react.createElement("li", { className: "nav-item" },
                react.createElement("a", { className: classnames_default()("nav-link", { active: activeTabId === "lock" }), href: "#lock", onClick: (event) => {
                        event.preventDefault();
                        onClickTab("lock");
                    } }, chrome.i18n.getMessage("tabLock_name"))),
            react.createElement("li", { className: "nav-item" },
                react.createElement("a", { className: classnames_default()("nav-link", { active: activeTabId === "options" }), href: "#options", onClick: (event) => {
                        event.preventDefault();
                        onClickTab("options");
                    } }, chrome.i18n.getMessage("options_name"))),
            react.createElement("li", { className: "nav-item" },
                react.createElement("a", { className: classnames_default()("nav-link", { active: activeTabId === "about" }), href: "#about", onClick: (event) => {
                        event.preventDefault();
                        onClickTab("about");
                    } }, chrome.i18n.getMessage("about_name"))))));
}

;// CONCATENATED MODULE: ./app/js/AboutTab.tsx

function AboutTab() {
    return (react.createElement("div", { className: "tab-pane active" },
        react.createElement("p", null,
            react.createElement("a", { href: "https://chrome.google.com/webstore/detail/egnjhciaieeiiohknchakcodbpgjnchh/", rel: "noopener noreferrer", target: "_blank" }, chrome.i18n.getMessage("extName")),
            " ",
            "v",
            chrome.runtime.getManifest().version),
        react.createElement("ul", null,
            react.createElement("li", null,
                react.createElement("a", { href: "https://github.com/tabwrangler/tabwrangler/releases", rel: "noopener noreferrer", target: "_blank" }, chrome.i18n.getMessage("about_changeLog"))),
            react.createElement("li", null,
                react.createElement("a", { href: "https://github.com/tabwrangler/tabwrangler/issues", rel: "noopener noreferrer", target: "_blank" }, chrome.i18n.getMessage("about_support"))),
            react.createElement("li", null,
                react.createElement("a", { href: "https://github.com/tabwrangler/tabwrangler", rel: "noopener noreferrer", target: "_blank" }, chrome.i18n.getMessage("about_sourceCode"))))));
}

;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/classCallCheck.js
function classCallCheck_classCallCheck(a, n) {
  if (!(a instanceof n)) throw new TypeError("Cannot call a class as a function");
}

;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/typeof.js
function _typeof(o) {
  "@babel/helpers - typeof";

  return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (o) {
    return typeof o;
  } : function (o) {
    return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o;
  }, _typeof(o);
}

;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/toPrimitive.js

function toPrimitive(t, r) {
  if ("object" != _typeof(t) || !t) return t;
  var e = t[Symbol.toPrimitive];
  if (void 0 !== e) {
    var i = e.call(t, r || "default");
    if ("object" != _typeof(i)) return i;
    throw new TypeError("@@toPrimitive must return a primitive value.");
  }
  return ("string" === r ? String : Number)(t);
}

;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/toPropertyKey.js


function toPropertyKey(t) {
  var i = toPrimitive(t, "string");
  return "symbol" == _typeof(i) ? i : i + "";
}

;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/createClass.js

function _defineProperties(e, r) {
  for (var t = 0; t < r.length; t++) {
    var o = r[t];
    o.enumerable = o.enumerable || !1, o.configurable = !0, "value" in o && (o.writable = !0), Object.defineProperty(e, toPropertyKey(o.key), o);
  }
}
function createClass_createClass(e, r, t) {
  return r && _defineProperties(e.prototype, r), t && _defineProperties(e, t), Object.defineProperty(e, "prototype", {
    writable: !1
  }), e;
}

;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/assertThisInitialized.js
function _assertThisInitialized(e) {
  if (void 0 === e) throw new ReferenceError("this hasn't been initialised - super() hasn't been called");
  return e;
}

;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/possibleConstructorReturn.js


function _possibleConstructorReturn(t, e) {
  if (e && ("object" == _typeof(e) || "function" == typeof e)) return e;
  if (void 0 !== e) throw new TypeError("Derived constructors may only return object or undefined");
  return _assertThisInitialized(t);
}

;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/getPrototypeOf.js
function _getPrototypeOf(t) {
  return _getPrototypeOf = Object.setPrototypeOf ? Object.getPrototypeOf.bind() : function (t) {
    return t.__proto__ || Object.getPrototypeOf(t);
  }, _getPrototypeOf(t);
}

;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/setPrototypeOf.js
function _setPrototypeOf(t, e) {
  return _setPrototypeOf = Object.setPrototypeOf ? Object.setPrototypeOf.bind() : function (t, e) {
    return t.__proto__ = e, t;
  }, _setPrototypeOf(t, e);
}

;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/inherits.js

function _inherits(t, e) {
  if ("function" != typeof e && null !== e) throw new TypeError("Super expression must either be null or a function");
  t.prototype = Object.create(e && e.prototype, {
    constructor: {
      value: t,
      writable: !0,
      configurable: !0
    }
  }), Object.defineProperty(t, "prototype", {
    writable: !1
  }), e && _setPrototypeOf(t, e);
}

;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/defineProperty.js

function defineProperty_defineProperty(e, r, t) {
  return (r = toPropertyKey(r)) in e ? Object.defineProperty(e, r, {
    value: t,
    enumerable: !0,
    configurable: !0,
    writable: !0
  }) : e[r] = t, e;
}

;// CONCATENATED MODULE: ./node_modules/react-lifecycles-compat/react-lifecycles-compat.es.js
/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

function componentWillMount() {
  // Call this.constructor.gDSFP to support sub-classes.
  var state = this.constructor.getDerivedStateFromProps(this.props, this.state);
  if (state !== null && state !== undefined) {
    this.setState(state);
  }
}

function componentWillReceiveProps(nextProps) {
  // Call this.constructor.gDSFP to support sub-classes.
  // Use the setState() updater to ensure state isn't stale in certain edge cases.
  function updater(prevState) {
    var state = this.constructor.getDerivedStateFromProps(nextProps, prevState);
    return state !== null && state !== undefined ? state : null;
  }
  // Binding "this" is important for shallow renderer support.
  this.setState(updater.bind(this));
}

function componentWillUpdate(nextProps, nextState) {
  try {
    var prevProps = this.props;
    var prevState = this.state;
    this.props = nextProps;
    this.state = nextState;
    this.__reactInternalSnapshotFlag = true;
    this.__reactInternalSnapshot = this.getSnapshotBeforeUpdate(
      prevProps,
      prevState
    );
  } finally {
    this.props = prevProps;
    this.state = prevState;
  }
}

// React may warn about cWM/cWRP/cWU methods being deprecated.
// Add a flag to suppress these warnings for this special case.
componentWillMount.__suppressDeprecationWarning = true;
componentWillReceiveProps.__suppressDeprecationWarning = true;
componentWillUpdate.__suppressDeprecationWarning = true;

function react_lifecycles_compat_es_polyfill(Component) {
  var prototype = Component.prototype;

  if (!prototype || !prototype.isReactComponent) {
    throw new Error('Can only polyfill class components');
  }

  if (
    typeof Component.getDerivedStateFromProps !== 'function' &&
    typeof prototype.getSnapshotBeforeUpdate !== 'function'
  ) {
    return Component;
  }

  // If new component APIs are defined, "unsafe" lifecycles won't be called.
  // Error if any of these lifecycles are present,
  // Because they would work differently between older and newer (16.3+) versions of React.
  var foundWillMountName = null;
  var foundWillReceivePropsName = null;
  var foundWillUpdateName = null;
  if (typeof prototype.componentWillMount === 'function') {
    foundWillMountName = 'componentWillMount';
  } else if (typeof prototype.UNSAFE_componentWillMount === 'function') {
    foundWillMountName = 'UNSAFE_componentWillMount';
  }
  if (typeof prototype.componentWillReceiveProps === 'function') {
    foundWillReceivePropsName = 'componentWillReceiveProps';
  } else if (typeof prototype.UNSAFE_componentWillReceiveProps === 'function') {
    foundWillReceivePropsName = 'UNSAFE_componentWillReceiveProps';
  }
  if (typeof prototype.componentWillUpdate === 'function') {
    foundWillUpdateName = 'componentWillUpdate';
  } else if (typeof prototype.UNSAFE_componentWillUpdate === 'function') {
    foundWillUpdateName = 'UNSAFE_componentWillUpdate';
  }
  if (
    foundWillMountName !== null ||
    foundWillReceivePropsName !== null ||
    foundWillUpdateName !== null
  ) {
    var componentName = Component.displayName || Component.name;
    var newApiName =
      typeof Component.getDerivedStateFromProps === 'function'
        ? 'getDerivedStateFromProps()'
        : 'getSnapshotBeforeUpdate()';

    throw Error(
      'Unsafe legacy lifecycles will not be called for components using new component APIs.\n\n' +
        componentName +
        ' uses ' +
        newApiName +
        ' but also contains the following legacy lifecycles:' +
        (foundWillMountName !== null ? '\n  ' + foundWillMountName : '') +
        (foundWillReceivePropsName !== null
          ? '\n  ' + foundWillReceivePropsName
          : '') +
        (foundWillUpdateName !== null ? '\n  ' + foundWillUpdateName : '') +
        '\n\nThe above lifecycles should be removed. Learn more about this warning here:\n' +
        'https://fb.me/react-async-component-lifecycle-hooks'
    );
  }

  // React <= 16.2 does not support static getDerivedStateFromProps.
  // As a workaround, use cWM and cWRP to invoke the new static lifecycle.
  // Newer versions of React will ignore these lifecycles if gDSFP exists.
  if (typeof Component.getDerivedStateFromProps === 'function') {
    prototype.componentWillMount = componentWillMount;
    prototype.componentWillReceiveProps = componentWillReceiveProps;
  }

  // React <= 16.2 does not support getSnapshotBeforeUpdate.
  // As a workaround, use cWU to invoke the new lifecycle.
  // Newer versions of React will ignore that lifecycle if gSBU exists.
  if (typeof prototype.getSnapshotBeforeUpdate === 'function') {
    if (typeof prototype.componentDidUpdate !== 'function') {
      throw new Error(
        'Cannot polyfill getSnapshotBeforeUpdate() for components that do not define componentDidUpdate() on the prototype'
      );
    }

    prototype.componentWillUpdate = componentWillUpdate;

    var componentDidUpdate = prototype.componentDidUpdate;

    prototype.componentDidUpdate = function componentDidUpdatePolyfill(
      prevProps,
      prevState,
      maybeSnapshot
    ) {
      // 16.3+ will not execute our will-update method;
      // It will pass a snapshot value to did-update though.
      // Older versions will require our polyfilled will-update value.
      // We need to handle both cases, but can't just check for the presence of "maybeSnapshot",
      // Because for <= 15.x versions this might be a "prevContext" object.
      // We also can't just check "__reactInternalSnapshot",
      // Because get-snapshot might return a falsy value.
      // So check for the explicit __reactInternalSnapshotFlag flag to determine behavior.
      var snapshot = this.__reactInternalSnapshotFlag
        ? this.__reactInternalSnapshot
        : maybeSnapshot;

      componentDidUpdate.call(this, prevProps, prevState, snapshot);
    };
  }

  return Component;
}



;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/extends.js
function extends_extends() {
  return extends_extends = Object.assign ? Object.assign.bind() : function (n) {
    for (var e = 1; e < arguments.length; e++) {
      var t = arguments[e];
      for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]);
    }
    return n;
  }, extends_extends.apply(null, arguments);
}

;// CONCATENATED MODULE: ./node_modules/clsx/dist/clsx.m.js
function r(e){var t,f,n="";if("string"==typeof e||"number"==typeof e)n+=e;else if("object"==typeof e)if(Array.isArray(e))for(t=0;t<e.length;t++)e[t]&&(f=r(e[t]))&&(n&&(n+=" "),n+=f);else for(t in e)e[t]&&(n&&(n+=" "),n+=t);return n}function clsx(){for(var e,t,f=0,n="";f<arguments.length;)(e=arguments[f++])&&(t=r(e))&&(n&&(n+=" "),n+=t);return n}/* harmony default export */ const clsx_m = (clsx);
;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Grid/utils/calculateSizeAndPositionDataAndUpdateScrollOffset.js
/**
 * Helper method that determines when to recalculate row or column metadata.
 */
function calculateSizeAndPositionDataAndUpdateScrollOffset(_ref) {
  var cellCount = _ref.cellCount,
      cellSize = _ref.cellSize,
      computeMetadataCallback = _ref.computeMetadataCallback,
      computeMetadataCallbackProps = _ref.computeMetadataCallbackProps,
      nextCellsCount = _ref.nextCellsCount,
      nextCellSize = _ref.nextCellSize,
      nextScrollToIndex = _ref.nextScrollToIndex,
      scrollToIndex = _ref.scrollToIndex,
      updateScrollOffsetForScrollToIndex = _ref.updateScrollOffsetForScrollToIndex;

  // Don't compare cell sizes if they are functions because inline functions would cause infinite loops.
  // In that event users should use the manual recompute methods to inform of changes.
  if (cellCount !== nextCellsCount || (typeof cellSize === 'number' || typeof nextCellSize === 'number') && cellSize !== nextCellSize) {
    computeMetadataCallback(computeMetadataCallbackProps); // Updated cell metadata may have hidden the previous scrolled-to item.
    // In this case we should also update the scrollTop to ensure it stays visible.

    if (scrollToIndex >= 0 && scrollToIndex === nextScrollToIndex) {
      updateScrollOffsetForScrollToIndex();
    }
  }
}
;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/objectWithoutPropertiesLoose.js
function objectWithoutPropertiesLoose_objectWithoutPropertiesLoose(r, e) {
  if (null == r) return {};
  var t = {};
  for (var n in r) if ({}.hasOwnProperty.call(r, n)) {
    if (e.includes(n)) continue;
    t[n] = r[n];
  }
  return t;
}

;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/objectWithoutProperties.js

function _objectWithoutProperties(e, t) {
  if (null == e) return {};
  var o,
    r,
    i = objectWithoutPropertiesLoose_objectWithoutPropertiesLoose(e, t);
  if (Object.getOwnPropertySymbols) {
    var s = Object.getOwnPropertySymbols(e);
    for (r = 0; r < s.length; r++) o = s[r], t.includes(o) || {}.propertyIsEnumerable.call(e, o) && (i[o] = e[o]);
  }
  return i;
}

;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Grid/types.js


var bpfrpt_proptype_CellPosition =  true ? null : 0;
var bpfrpt_proptype_CellRendererParams =  true ? null : 0;
var bpfrpt_proptype_CellRenderer =  true ? null : 0;
var bpfrpt_proptype_CellCache =  true ? null : 0;
var bpfrpt_proptype_StyleCache =  true ? null : 0;
var bpfrpt_proptype_CellRangeRendererParams =  true ? null : 0;
var bpfrpt_proptype_CellRangeRenderer =  true ? null : 0;
var bpfrpt_proptype_CellSizeGetter =  true ? null : 0;
var bpfrpt_proptype_CellSize =  true ? null : 0;
var bpfrpt_proptype_NoContentRenderer =  true ? null : 0;
var bpfrpt_proptype_Scroll =  true ? null : 0;
var bpfrpt_proptype_ScrollbarPresenceChange =  true ? null : 0;
var bpfrpt_proptype_RenderedSection =  true ? null : 0;
var bpfrpt_proptype_OverscanIndicesGetterParams =  true ? null : 0;
var bpfrpt_proptype_OverscanIndices =  true ? null : 0;
var bpfrpt_proptype_OverscanIndicesGetter =  true ? null : 0;
var bpfrpt_proptype_Alignment =  true ? null : 0;
var bpfrpt_proptype_VisibleCellRange =  true ? null : 0;



















;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Grid/utils/CellSizeAndPositionManager.js




/**
 * Just-in-time calculates and caches size and position information for a collection of cells.
 */
var CellSizeAndPositionManager =
/*#__PURE__*/
function () {
  // Cache of size and position data for cells, mapped by cell index.
  // Note that invalid values may exist in this map so only rely on cells up to this._lastMeasuredIndex
  // Measurements for cells up to this index can be trusted; cells afterward should be estimated.
  // Used in deferred mode to track which cells have been queued for measurement.
  function CellSizeAndPositionManager(_ref) {
    var cellCount = _ref.cellCount,
        cellSizeGetter = _ref.cellSizeGetter,
        estimatedCellSize = _ref.estimatedCellSize;

    classCallCheck_classCallCheck(this, CellSizeAndPositionManager);

    defineProperty_defineProperty(this, "_cellSizeAndPositionData", {});

    defineProperty_defineProperty(this, "_lastMeasuredIndex", -1);

    defineProperty_defineProperty(this, "_lastBatchedIndex", -1);

    defineProperty_defineProperty(this, "_cellCount", void 0);

    defineProperty_defineProperty(this, "_cellSizeGetter", void 0);

    defineProperty_defineProperty(this, "_estimatedCellSize", void 0);

    this._cellSizeGetter = cellSizeGetter;
    this._cellCount = cellCount;
    this._estimatedCellSize = estimatedCellSize;
  }

  createClass_createClass(CellSizeAndPositionManager, [{
    key: "areOffsetsAdjusted",
    value: function areOffsetsAdjusted() {
      return false;
    }
  }, {
    key: "configure",
    value: function configure(_ref2) {
      var cellCount = _ref2.cellCount,
          estimatedCellSize = _ref2.estimatedCellSize,
          cellSizeGetter = _ref2.cellSizeGetter;
      this._cellCount = cellCount;
      this._estimatedCellSize = estimatedCellSize;
      this._cellSizeGetter = cellSizeGetter;
    }
  }, {
    key: "getCellCount",
    value: function getCellCount() {
      return this._cellCount;
    }
  }, {
    key: "getEstimatedCellSize",
    value: function getEstimatedCellSize() {
      return this._estimatedCellSize;
    }
  }, {
    key: "getLastMeasuredIndex",
    value: function getLastMeasuredIndex() {
      return this._lastMeasuredIndex;
    }
  }, {
    key: "getOffsetAdjustment",
    value: function getOffsetAdjustment() {
      return 0;
    }
    /**
     * This method returns the size and position for the cell at the specified index.
     * It just-in-time calculates (or used cached values) for cells leading up to the index.
     */

  }, {
    key: "getSizeAndPositionOfCell",
    value: function getSizeAndPositionOfCell(index) {
      if (index < 0 || index >= this._cellCount) {
        throw Error("Requested index ".concat(index, " is outside of range 0..").concat(this._cellCount));
      }

      if (index > this._lastMeasuredIndex) {
        var lastMeasuredCellSizeAndPosition = this.getSizeAndPositionOfLastMeasuredCell();
        var offset = lastMeasuredCellSizeAndPosition.offset + lastMeasuredCellSizeAndPosition.size;

        for (var i = this._lastMeasuredIndex + 1; i <= index; i++) {
          var size = this._cellSizeGetter({
            index: i
          }); // undefined or NaN probably means a logic error in the size getter.
          // null means we're using CellMeasurer and haven't yet measured a given index.


          if (size === undefined || isNaN(size)) {
            throw Error("Invalid size returned for cell ".concat(i, " of value ").concat(size));
          } else if (size === null) {
            this._cellSizeAndPositionData[i] = {
              offset: offset,
              size: 0
            };
            this._lastBatchedIndex = index;
          } else {
            this._cellSizeAndPositionData[i] = {
              offset: offset,
              size: size
            };
            offset += size;
            this._lastMeasuredIndex = index;
          }
        }
      }

      return this._cellSizeAndPositionData[index];
    }
  }, {
    key: "getSizeAndPositionOfLastMeasuredCell",
    value: function getSizeAndPositionOfLastMeasuredCell() {
      return this._lastMeasuredIndex >= 0 ? this._cellSizeAndPositionData[this._lastMeasuredIndex] : {
        offset: 0,
        size: 0
      };
    }
    /**
     * Total size of all cells being measured.
     * This value will be completely estimated initially.
     * As cells are measured, the estimate will be updated.
     */

  }, {
    key: "getTotalSize",
    value: function getTotalSize() {
      var lastMeasuredCellSizeAndPosition = this.getSizeAndPositionOfLastMeasuredCell();
      var totalSizeOfMeasuredCells = lastMeasuredCellSizeAndPosition.offset + lastMeasuredCellSizeAndPosition.size;
      var numUnmeasuredCells = this._cellCount - this._lastMeasuredIndex - 1;
      var totalSizeOfUnmeasuredCells = numUnmeasuredCells * this._estimatedCellSize;
      return totalSizeOfMeasuredCells + totalSizeOfUnmeasuredCells;
    }
    /**
     * Determines a new offset that ensures a certain cell is visible, given the current offset.
     * If the cell is already visible then the current offset will be returned.
     * If the current offset is too great or small, it will be adjusted just enough to ensure the specified index is visible.
     *
     * @param align Desired alignment within container; one of "auto" (default), "start", or "end"
     * @param containerSize Size (width or height) of the container viewport
     * @param currentOffset Container's current (x or y) offset
     * @param totalSize Total size (width or height) of all cells
     * @return Offset to use to ensure the specified cell is visible
     */

  }, {
    key: "getUpdatedOffsetForIndex",
    value: function getUpdatedOffsetForIndex(_ref3) {
      var _ref3$align = _ref3.align,
          align = _ref3$align === void 0 ? 'auto' : _ref3$align,
          containerSize = _ref3.containerSize,
          currentOffset = _ref3.currentOffset,
          targetIndex = _ref3.targetIndex;

      if (containerSize <= 0) {
        return 0;
      }

      var datum = this.getSizeAndPositionOfCell(targetIndex);
      var maxOffset = datum.offset;
      var minOffset = maxOffset - containerSize + datum.size;
      var idealOffset;

      switch (align) {
        case 'start':
          idealOffset = maxOffset;
          break;

        case 'end':
          idealOffset = minOffset;
          break;

        case 'center':
          idealOffset = maxOffset - (containerSize - datum.size) / 2;
          break;

        default:
          idealOffset = Math.max(minOffset, Math.min(maxOffset, currentOffset));
          break;
      }

      var totalSize = this.getTotalSize();
      return Math.max(0, Math.min(totalSize - containerSize, idealOffset));
    }
  }, {
    key: "getVisibleCellRange",
    value: function getVisibleCellRange(params) {
      var containerSize = params.containerSize,
          offset = params.offset;
      var totalSize = this.getTotalSize();

      if (totalSize === 0) {
        return {};
      }

      var maxOffset = offset + containerSize;

      var start = this._findNearestCell(offset);

      var datum = this.getSizeAndPositionOfCell(start);
      offset = datum.offset + datum.size;
      var stop = start;

      while (offset < maxOffset && stop < this._cellCount - 1) {
        stop++;
        offset += this.getSizeAndPositionOfCell(stop).size;
      }

      return {
        start: start,
        stop: stop
      };
    }
    /**
     * Clear all cached values for cells after the specified index.
     * This method should be called for any cell that has changed its size.
     * It will not immediately perform any calculations; they'll be performed the next time getSizeAndPositionOfCell() is called.
     */

  }, {
    key: "resetCell",
    value: function resetCell(index) {
      this._lastMeasuredIndex = Math.min(this._lastMeasuredIndex, index - 1);
    }
  }, {
    key: "_binarySearch",
    value: function _binarySearch(high, low, offset) {
      while (low <= high) {
        var middle = low + Math.floor((high - low) / 2);
        var currentOffset = this.getSizeAndPositionOfCell(middle).offset;

        if (currentOffset === offset) {
          return middle;
        } else if (currentOffset < offset) {
          low = middle + 1;
        } else if (currentOffset > offset) {
          high = middle - 1;
        }
      }

      if (low > 0) {
        return low - 1;
      } else {
        return 0;
      }
    }
  }, {
    key: "_exponentialSearch",
    value: function _exponentialSearch(index, offset) {
      var interval = 1;

      while (index < this._cellCount && this.getSizeAndPositionOfCell(index).offset < offset) {
        index += interval;
        interval *= 2;
      }

      return this._binarySearch(Math.min(index, this._cellCount - 1), Math.floor(index / 2), offset);
    }
    /**
     * Searches for the cell (index) nearest the specified offset.
     *
     * If no exact match is found the next lowest cell index will be returned.
     * This allows partially visible cells (with offsets just before/above the fold) to be visible.
     */

  }, {
    key: "_findNearestCell",
    value: function _findNearestCell(offset) {
      if (isNaN(offset)) {
        throw Error("Invalid offset ".concat(offset, " specified"));
      } // Our search algorithms find the nearest match at or below the specified offset.
      // So make sure the offset is at least 0 or no match will be found.


      offset = Math.max(0, offset);
      var lastMeasuredCellSizeAndPosition = this.getSizeAndPositionOfLastMeasuredCell();
      var lastMeasuredIndex = Math.max(0, this._lastMeasuredIndex);

      if (lastMeasuredCellSizeAndPosition.offset >= offset) {
        // If we've already measured cells within this range just use a binary search as it's faster.
        return this._binarySearch(lastMeasuredIndex, 0, offset);
      } else {
        // If we haven't yet measured this high, fallback to an exponential search with an inner binary search.
        // The exponential search avoids pre-computing sizes for the full set of cells as a binary search would.
        // The overall complexity for this approach is O(log n).
        return this._exponentialSearch(lastMeasuredIndex, offset);
      }
    }
  }]);

  return CellSizeAndPositionManager;
}();





;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Grid/utils/maxElementSize.js
var DEFAULT_MAX_ELEMENT_SIZE = 1500000;
var CHROME_MAX_ELEMENT_SIZE = 1.67771e7;

var isBrowser = function isBrowser() {
  return typeof window !== 'undefined';
};

var isChrome = function isChrome() {
  return !!window.chrome;
};

var getMaxElementSize = function getMaxElementSize() {
  if (isBrowser()) {
    if (isChrome()) {
      return CHROME_MAX_ELEMENT_SIZE;
    }
  }

  return DEFAULT_MAX_ELEMENT_SIZE;
};
;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Grid/utils/ScalingCellSizeAndPositionManager.js







/**
 * Extends CellSizeAndPositionManager and adds scaling behavior for lists that are too large to fit within a browser's native limits.
 */
var ScalingCellSizeAndPositionManager =
/*#__PURE__*/
function () {
  function ScalingCellSizeAndPositionManager(_ref) {
    var _ref$maxScrollSize = _ref.maxScrollSize,
        maxScrollSize = _ref$maxScrollSize === void 0 ? getMaxElementSize() : _ref$maxScrollSize,
        params = _objectWithoutProperties(_ref, ["maxScrollSize"]);

    classCallCheck_classCallCheck(this, ScalingCellSizeAndPositionManager);

    defineProperty_defineProperty(this, "_cellSizeAndPositionManager", void 0);

    defineProperty_defineProperty(this, "_maxScrollSize", void 0);

    // Favor composition over inheritance to simplify IE10 support
    this._cellSizeAndPositionManager = new CellSizeAndPositionManager(params);
    this._maxScrollSize = maxScrollSize;
  }

  createClass_createClass(ScalingCellSizeAndPositionManager, [{
    key: "areOffsetsAdjusted",
    value: function areOffsetsAdjusted() {
      return this._cellSizeAndPositionManager.getTotalSize() > this._maxScrollSize;
    }
  }, {
    key: "configure",
    value: function configure(params) {
      this._cellSizeAndPositionManager.configure(params);
    }
  }, {
    key: "getCellCount",
    value: function getCellCount() {
      return this._cellSizeAndPositionManager.getCellCount();
    }
  }, {
    key: "getEstimatedCellSize",
    value: function getEstimatedCellSize() {
      return this._cellSizeAndPositionManager.getEstimatedCellSize();
    }
  }, {
    key: "getLastMeasuredIndex",
    value: function getLastMeasuredIndex() {
      return this._cellSizeAndPositionManager.getLastMeasuredIndex();
    }
    /**
     * Number of pixels a cell at the given position (offset) should be shifted in order to fit within the scaled container.
     * The offset passed to this function is scaled (safe) as well.
     */

  }, {
    key: "getOffsetAdjustment",
    value: function getOffsetAdjustment(_ref2) {
      var containerSize = _ref2.containerSize,
          offset = _ref2.offset;

      var totalSize = this._cellSizeAndPositionManager.getTotalSize();

      var safeTotalSize = this.getTotalSize();

      var offsetPercentage = this._getOffsetPercentage({
        containerSize: containerSize,
        offset: offset,
        totalSize: safeTotalSize
      });

      return Math.round(offsetPercentage * (safeTotalSize - totalSize));
    }
  }, {
    key: "getSizeAndPositionOfCell",
    value: function getSizeAndPositionOfCell(index) {
      return this._cellSizeAndPositionManager.getSizeAndPositionOfCell(index);
    }
  }, {
    key: "getSizeAndPositionOfLastMeasuredCell",
    value: function getSizeAndPositionOfLastMeasuredCell() {
      return this._cellSizeAndPositionManager.getSizeAndPositionOfLastMeasuredCell();
    }
    /** See CellSizeAndPositionManager#getTotalSize */

  }, {
    key: "getTotalSize",
    value: function getTotalSize() {
      return Math.min(this._maxScrollSize, this._cellSizeAndPositionManager.getTotalSize());
    }
    /** See CellSizeAndPositionManager#getUpdatedOffsetForIndex */

  }, {
    key: "getUpdatedOffsetForIndex",
    value: function getUpdatedOffsetForIndex(_ref3) {
      var _ref3$align = _ref3.align,
          align = _ref3$align === void 0 ? 'auto' : _ref3$align,
          containerSize = _ref3.containerSize,
          currentOffset = _ref3.currentOffset,
          targetIndex = _ref3.targetIndex;
      currentOffset = this._safeOffsetToOffset({
        containerSize: containerSize,
        offset: currentOffset
      });

      var offset = this._cellSizeAndPositionManager.getUpdatedOffsetForIndex({
        align: align,
        containerSize: containerSize,
        currentOffset: currentOffset,
        targetIndex: targetIndex
      });

      return this._offsetToSafeOffset({
        containerSize: containerSize,
        offset: offset
      });
    }
    /** See CellSizeAndPositionManager#getVisibleCellRange */

  }, {
    key: "getVisibleCellRange",
    value: function getVisibleCellRange(_ref4) {
      var containerSize = _ref4.containerSize,
          offset = _ref4.offset;
      offset = this._safeOffsetToOffset({
        containerSize: containerSize,
        offset: offset
      });
      return this._cellSizeAndPositionManager.getVisibleCellRange({
        containerSize: containerSize,
        offset: offset
      });
    }
  }, {
    key: "resetCell",
    value: function resetCell(index) {
      this._cellSizeAndPositionManager.resetCell(index);
    }
  }, {
    key: "_getOffsetPercentage",
    value: function _getOffsetPercentage(_ref5) {
      var containerSize = _ref5.containerSize,
          offset = _ref5.offset,
          totalSize = _ref5.totalSize;
      return totalSize <= containerSize ? 0 : offset / (totalSize - containerSize);
    }
  }, {
    key: "_offsetToSafeOffset",
    value: function _offsetToSafeOffset(_ref6) {
      var containerSize = _ref6.containerSize,
          offset = _ref6.offset;

      var totalSize = this._cellSizeAndPositionManager.getTotalSize();

      var safeTotalSize = this.getTotalSize();

      if (totalSize === safeTotalSize) {
        return offset;
      } else {
        var offsetPercentage = this._getOffsetPercentage({
          containerSize: containerSize,
          offset: offset,
          totalSize: totalSize
        });

        return Math.round(offsetPercentage * (safeTotalSize - containerSize));
      }
    }
  }, {
    key: "_safeOffsetToOffset",
    value: function _safeOffsetToOffset(_ref7) {
      var containerSize = _ref7.containerSize,
          offset = _ref7.offset;

      var totalSize = this._cellSizeAndPositionManager.getTotalSize();

      var safeTotalSize = this.getTotalSize();

      if (totalSize === safeTotalSize) {
        return offset;
      } else {
        var offsetPercentage = this._getOffsetPercentage({
          containerSize: containerSize,
          offset: offset,
          totalSize: safeTotalSize
        });

        return Math.round(offsetPercentage * (totalSize - containerSize));
      }
    }
  }]);

  return ScalingCellSizeAndPositionManager;
}();





;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/utils/createCallbackMemoizer.js
/**
 * Helper utility that updates the specified callback whenever any of the specified indices have changed.
 */
function createCallbackMemoizer() {
  var requireAllKeys = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : true;
  var cachedIndices = {};
  return function (_ref) {
    var callback = _ref.callback,
        indices = _ref.indices;
    var keys = Object.keys(indices);
    var allInitialized = !requireAllKeys || keys.every(function (key) {
      var value = indices[key];
      return Array.isArray(value) ? value.length > 0 : value >= 0;
    });
    var indexChanged = keys.length !== Object.keys(cachedIndices).length || keys.some(function (key) {
      var cachedValue = cachedIndices[key];
      var value = indices[key];
      return Array.isArray(value) ? cachedValue.join(',') !== value.join(',') : cachedValue !== value;
    });
    cachedIndices = indices;

    if (allInitialized && indexChanged) {
      callback(indices);
    }
  };
}
;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Grid/defaultOverscanIndicesGetter.js
var SCROLL_DIRECTION_BACKWARD = -1;
var SCROLL_DIRECTION_FORWARD = 1;
var SCROLL_DIRECTION_HORIZONTAL = 'horizontal';
var SCROLL_DIRECTION_VERTICAL = 'vertical';
/**
 * Calculates the number of cells to overscan before and after a specified range.
 * This function ensures that overscanning doesn't exceed the available cells.
 */

function defaultOverscanIndicesGetter(_ref) {
  var cellCount = _ref.cellCount,
      overscanCellsCount = _ref.overscanCellsCount,
      scrollDirection = _ref.scrollDirection,
      startIndex = _ref.startIndex,
      stopIndex = _ref.stopIndex;

  if (scrollDirection === SCROLL_DIRECTION_FORWARD) {
    return {
      overscanStartIndex: Math.max(0, startIndex),
      overscanStopIndex: Math.min(cellCount - 1, stopIndex + overscanCellsCount)
    };
  } else {
    return {
      overscanStartIndex: Math.max(0, startIndex - overscanCellsCount),
      overscanStopIndex: Math.min(cellCount - 1, stopIndex)
    };
  }
}


;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Grid/utils/updateScrollIndexHelper.js

/**
 * Helper function that determines when to update scroll offsets to ensure that a scroll-to-index remains visible.
 * This function also ensures that the scroll ofset isn't past the last column/row of cells.
 */

function updateScrollIndexHelper(_ref) {
  var cellSize = _ref.cellSize,
      cellSizeAndPositionManager = _ref.cellSizeAndPositionManager,
      previousCellsCount = _ref.previousCellsCount,
      previousCellSize = _ref.previousCellSize,
      previousScrollToAlignment = _ref.previousScrollToAlignment,
      previousScrollToIndex = _ref.previousScrollToIndex,
      previousSize = _ref.previousSize,
      scrollOffset = _ref.scrollOffset,
      scrollToAlignment = _ref.scrollToAlignment,
      scrollToIndex = _ref.scrollToIndex,
      size = _ref.size,
      sizeJustIncreasedFromZero = _ref.sizeJustIncreasedFromZero,
      updateScrollIndexCallback = _ref.updateScrollIndexCallback;
  var cellCount = cellSizeAndPositionManager.getCellCount();
  var hasScrollToIndex = scrollToIndex >= 0 && scrollToIndex < cellCount;
  var sizeHasChanged = size !== previousSize || sizeJustIncreasedFromZero || !previousCellSize || typeof cellSize === 'number' && cellSize !== previousCellSize; // If we have a new scroll target OR if height/row-height has changed,
  // We should ensure that the scroll target is visible.

  if (hasScrollToIndex && (sizeHasChanged || scrollToAlignment !== previousScrollToAlignment || scrollToIndex !== previousScrollToIndex)) {
    updateScrollIndexCallback(scrollToIndex); // If we don't have a selected item but list size or number of children have decreased,
    // Make sure we aren't scrolled too far past the current content.
  } else if (!hasScrollToIndex && cellCount > 0 && (size < previousSize || cellCount < previousCellsCount)) {
    // We need to ensure that the current scroll offset is still within the collection's range.
    // To do this, we don't need to measure everything; CellMeasurer would perform poorly.
    // Just check to make sure we're still okay.
    // Only adjust the scroll position if we've scrolled below the last set of rows.
    if (scrollOffset > cellSizeAndPositionManager.getTotalSize() - size) {
      updateScrollIndexCallback(cellCount - 1);
    }
  }
}


;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Grid/defaultCellRangeRenderer.js
/**
 * Default implementation of cellRangeRenderer used by Grid.
 * This renderer supports cell-caching while the user is scrolling.
 */
function defaultCellRangeRenderer(_ref) {
  var cellCache = _ref.cellCache,
      cellRenderer = _ref.cellRenderer,
      columnSizeAndPositionManager = _ref.columnSizeAndPositionManager,
      columnStartIndex = _ref.columnStartIndex,
      columnStopIndex = _ref.columnStopIndex,
      deferredMeasurementCache = _ref.deferredMeasurementCache,
      horizontalOffsetAdjustment = _ref.horizontalOffsetAdjustment,
      isScrolling = _ref.isScrolling,
      isScrollingOptOut = _ref.isScrollingOptOut,
      parent = _ref.parent,
      rowSizeAndPositionManager = _ref.rowSizeAndPositionManager,
      rowStartIndex = _ref.rowStartIndex,
      rowStopIndex = _ref.rowStopIndex,
      styleCache = _ref.styleCache,
      verticalOffsetAdjustment = _ref.verticalOffsetAdjustment,
      visibleColumnIndices = _ref.visibleColumnIndices,
      visibleRowIndices = _ref.visibleRowIndices;
  var renderedCells = []; // Browsers have native size limits for elements (eg Chrome 33M pixels, IE 1.5M pixes).
  // User cannot scroll beyond these size limitations.
  // In order to work around this, ScalingCellSizeAndPositionManager compresses offsets.
  // We should never cache styles for compressed offsets though as this can lead to bugs.
  // See issue #576 for more.

  var areOffsetsAdjusted = columnSizeAndPositionManager.areOffsetsAdjusted() || rowSizeAndPositionManager.areOffsetsAdjusted();
  var canCacheStyle = !isScrolling && !areOffsetsAdjusted;

  for (var rowIndex = rowStartIndex; rowIndex <= rowStopIndex; rowIndex++) {
    var rowDatum = rowSizeAndPositionManager.getSizeAndPositionOfCell(rowIndex);

    for (var columnIndex = columnStartIndex; columnIndex <= columnStopIndex; columnIndex++) {
      var columnDatum = columnSizeAndPositionManager.getSizeAndPositionOfCell(columnIndex);
      var isVisible = columnIndex >= visibleColumnIndices.start && columnIndex <= visibleColumnIndices.stop && rowIndex >= visibleRowIndices.start && rowIndex <= visibleRowIndices.stop;
      var key = "".concat(rowIndex, "-").concat(columnIndex);
      var style = void 0; // Cache style objects so shallow-compare doesn't re-render unnecessarily.

      if (canCacheStyle && styleCache[key]) {
        style = styleCache[key];
      } else {
        // In deferred mode, cells will be initially rendered before we know their size.
        // Don't interfere with CellMeasurer's measurements by setting an invalid size.
        if (deferredMeasurementCache && !deferredMeasurementCache.has(rowIndex, columnIndex)) {
          // Position not-yet-measured cells at top/left 0,0,
          // And give them width/height of 'auto' so they can grow larger than the parent Grid if necessary.
          // Positioning them further to the right/bottom influences their measured size.
          style = {
            height: 'auto',
            left: 0,
            position: 'absolute',
            top: 0,
            width: 'auto'
          };
        } else {
          style = {
            height: rowDatum.size,
            left: columnDatum.offset + horizontalOffsetAdjustment,
            position: 'absolute',
            top: rowDatum.offset + verticalOffsetAdjustment,
            width: columnDatum.size
          };
          styleCache[key] = style;
        }
      }

      var cellRendererParams = {
        columnIndex: columnIndex,
        isScrolling: isScrolling,
        isVisible: isVisible,
        key: key,
        parent: parent,
        rowIndex: rowIndex,
        style: style
      };
      var renderedCell = void 0; // Avoid re-creating cells while scrolling.
      // This can lead to the same cell being created many times and can cause performance issues for "heavy" cells.
      // If a scroll is in progress- cache and reuse cells.
      // This cache will be thrown away once scrolling completes.
      // However if we are scaling scroll positions and sizes, we should also avoid caching.
      // This is because the offset changes slightly as scroll position changes and caching leads to stale values.
      // For more info refer to issue #395
      //
      // If isScrollingOptOut is specified, we always cache cells.
      // For more info refer to issue #1028

      if ((isScrollingOptOut || isScrolling) && !horizontalOffsetAdjustment && !verticalOffsetAdjustment) {
        if (!cellCache[key]) {
          cellCache[key] = cellRenderer(cellRendererParams);
        }

        renderedCell = cellCache[key]; // If the user is no longer scrolling, don't cache cells.
        // This makes dynamic cell content difficult for users and would also lead to a heavier memory footprint.
      } else {
        renderedCell = cellRenderer(cellRendererParams);
      }

      if (renderedCell == null || renderedCell === false) {
        continue;
      }

      if (false) {}

      renderedCells.push(renderedCell);
    }
  }

  return renderedCells;
}

function warnAboutMissingStyle(parent, renderedCell) {
  if (false) {}
}


;// CONCATENATED MODULE: ./node_modules/dom-helpers/esm/canUseDOM.js
/* harmony default export */ const canUseDOM = (!!(typeof window !== 'undefined' && window.document && window.document.createElement));
;// CONCATENATED MODULE: ./node_modules/dom-helpers/esm/scrollbarSize.js

var size;
function scrollbarSize(recalc) {
  if (!size && size !== 0 || recalc) {
    if (canUseDOM) {
      var scrollDiv = document.createElement('div');
      scrollDiv.style.position = 'absolute';
      scrollDiv.style.top = '-9999px';
      scrollDiv.style.width = '50px';
      scrollDiv.style.height = '50px';
      scrollDiv.style.overflow = 'scroll';
      document.body.appendChild(scrollDiv);
      size = scrollDiv.offsetWidth - scrollDiv.clientWidth;
      document.body.removeChild(scrollDiv);
    }
  }

  return size;
}
;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/utils/animationFrame.js
// Properly handle server-side rendering.
var win;

if (typeof window !== 'undefined') {
  win = window;
} else if (typeof self !== 'undefined') {
  win = self;
} else {
  win = {};
} // requestAnimationFrame() shim by Paul Irish
// http://paulirish.com/2011/requestanimationframe-for-smart-animating/


var request = win.requestAnimationFrame || win.webkitRequestAnimationFrame || win.mozRequestAnimationFrame || win.oRequestAnimationFrame || win.msRequestAnimationFrame || function (callback) {
  return win.setTimeout(callback, 1000 / 60);
};

var cancel = win.cancelAnimationFrame || win.webkitCancelAnimationFrame || win.mozCancelAnimationFrame || win.oCancelAnimationFrame || win.msCancelAnimationFrame || function (id) {
  win.clearTimeout(id);
};

var raf = request;
var caf = cancel;
;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/utils/requestAnimationTimeout.js

var bpfrpt_proptype_AnimationTimeoutId =  true ? null : 0;
var cancelAnimationTimeout = function cancelAnimationTimeout(frame) {
  return caf(frame.id);
};
/**
 * Recursively calls requestAnimationFrame until a specified delay has been met or exceeded.
 * When the delay time has been reached the function you're timing out will be called.
 *
 * Credit: Joe Lambert (https://gist.github.com/joelambert/1002116#file-requesttimeout-js)
 */

var requestAnimationTimeout = function requestAnimationTimeout(callback, delay) {
  var start; // wait for end of processing current event handler, because event handler may be long

  Promise.resolve().then(function () {
    start = Date.now();
  });

  var timeout = function timeout() {
    if (Date.now() - start >= delay) {
      callback.call();
    } else {
      frame.id = raf(timeout);
    }
  };

  var frame = {
    id: raf(timeout)
  };
  return frame;
};


;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Grid/Grid.js









var _class, _temp;

function ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); keys.push.apply(keys, symbols); } return keys; }

function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { ownKeys(source, true).forEach(function (key) { defineProperty_defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { ownKeys(source).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }












/**
 * Specifies the number of milliseconds during which to disable pointer events while a scroll is in progress.
 * This improves performance and makes scrolling smoother.
 */

var DEFAULT_SCROLLING_RESET_TIME_INTERVAL = 150;
/**
 * Controls whether the Grid updates the DOM element's scrollLeft/scrollTop based on the current state or just observes it.
 * This prevents Grid from interrupting mouse-wheel animations (see issue #2).
 */

var SCROLL_POSITION_CHANGE_REASONS = {
  OBSERVED: 'observed',
  REQUESTED: 'requested'
};

var renderNull = function renderNull() {
  return null;
};

/**
 * Renders tabular data with virtualization along the vertical and horizontal axes.
 * Row heights and column widths must be known ahead of time and specified as properties.
 */
var Grid = (_temp = _class =
/*#__PURE__*/
function (_React$PureComponent) {
  _inherits(Grid, _React$PureComponent);

  // Invokes onSectionRendered callback only when start/stop row or column indices change
  function Grid(props) {
    var _this;

    classCallCheck_classCallCheck(this, Grid);

    _this = _possibleConstructorReturn(this, _getPrototypeOf(Grid).call(this, props));

    defineProperty_defineProperty(_assertThisInitialized(_this), "_onGridRenderedMemoizer", createCallbackMemoizer());

    defineProperty_defineProperty(_assertThisInitialized(_this), "_onScrollMemoizer", createCallbackMemoizer(false));

    defineProperty_defineProperty(_assertThisInitialized(_this), "_deferredInvalidateColumnIndex", null);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_deferredInvalidateRowIndex", null);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_recomputeScrollLeftFlag", false);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_recomputeScrollTopFlag", false);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_horizontalScrollBarSize", 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_verticalScrollBarSize", 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_scrollbarPresenceChanged", false);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_scrollingContainer", void 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_childrenToDisplay", void 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_columnStartIndex", void 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_columnStopIndex", void 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_rowStartIndex", void 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_rowStopIndex", void 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_renderedColumnStartIndex", 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_renderedColumnStopIndex", 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_renderedRowStartIndex", 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_renderedRowStopIndex", 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_initialScrollTop", void 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_initialScrollLeft", void 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_disablePointerEventsTimeoutId", void 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_styleCache", {});

    defineProperty_defineProperty(_assertThisInitialized(_this), "_cellCache", {});

    defineProperty_defineProperty(_assertThisInitialized(_this), "_debounceScrollEndedCallback", function () {
      _this._disablePointerEventsTimeoutId = null; // isScrolling is used to determine if we reset styleCache

      _this.setState({
        isScrolling: false,
        needToResetStyleCache: false
      });
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_invokeOnGridRenderedHelper", function () {
      var onSectionRendered = _this.props.onSectionRendered;

      _this._onGridRenderedMemoizer({
        callback: onSectionRendered,
        indices: {
          columnOverscanStartIndex: _this._columnStartIndex,
          columnOverscanStopIndex: _this._columnStopIndex,
          columnStartIndex: _this._renderedColumnStartIndex,
          columnStopIndex: _this._renderedColumnStopIndex,
          rowOverscanStartIndex: _this._rowStartIndex,
          rowOverscanStopIndex: _this._rowStopIndex,
          rowStartIndex: _this._renderedRowStartIndex,
          rowStopIndex: _this._renderedRowStopIndex
        }
      });
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_setScrollingContainerRef", function (ref) {
      _this._scrollingContainer = ref;
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_onScroll", function (event) {
      // In certain edge-cases React dispatches an onScroll event with an invalid target.scrollLeft / target.scrollTop.
      // This invalid event can be detected by comparing event.target to this component's scrollable DOM element.
      // See issue #404 for more information.
      if (event.target === _this._scrollingContainer) {
        _this.handleScrollEvent(event.target);
      }
    });

    var columnSizeAndPositionManager = new ScalingCellSizeAndPositionManager({
      cellCount: props.columnCount,
      cellSizeGetter: function cellSizeGetter(params) {
        return Grid._wrapSizeGetter(props.columnWidth)(params);
      },
      estimatedCellSize: Grid._getEstimatedColumnSize(props)
    });
    var rowSizeAndPositionManager = new ScalingCellSizeAndPositionManager({
      cellCount: props.rowCount,
      cellSizeGetter: function cellSizeGetter(params) {
        return Grid._wrapSizeGetter(props.rowHeight)(params);
      },
      estimatedCellSize: Grid._getEstimatedRowSize(props)
    });
    _this.state = {
      instanceProps: {
        columnSizeAndPositionManager: columnSizeAndPositionManager,
        rowSizeAndPositionManager: rowSizeAndPositionManager,
        prevColumnWidth: props.columnWidth,
        prevRowHeight: props.rowHeight,
        prevColumnCount: props.columnCount,
        prevRowCount: props.rowCount,
        prevIsScrolling: props.isScrolling === true,
        prevScrollToColumn: props.scrollToColumn,
        prevScrollToRow: props.scrollToRow,
        scrollbarSize: 0,
        scrollbarSizeMeasured: false
      },
      isScrolling: false,
      scrollDirectionHorizontal: SCROLL_DIRECTION_FORWARD,
      scrollDirectionVertical: SCROLL_DIRECTION_FORWARD,
      scrollLeft: 0,
      scrollTop: 0,
      scrollPositionChangeReason: null,
      needToResetStyleCache: false
    };

    if (props.scrollToRow > 0) {
      _this._initialScrollTop = _this._getCalculatedScrollTop(props, _this.state);
    }

    if (props.scrollToColumn > 0) {
      _this._initialScrollLeft = _this._getCalculatedScrollLeft(props, _this.state);
    }

    return _this;
  }
  /**
   * Gets offsets for a given cell and alignment.
   */


  createClass_createClass(Grid, [{
    key: "getOffsetForCell",
    value: function getOffsetForCell() {
      var _ref = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {},
          _ref$alignment = _ref.alignment,
          alignment = _ref$alignment === void 0 ? this.props.scrollToAlignment : _ref$alignment,
          _ref$columnIndex = _ref.columnIndex,
          columnIndex = _ref$columnIndex === void 0 ? this.props.scrollToColumn : _ref$columnIndex,
          _ref$rowIndex = _ref.rowIndex,
          rowIndex = _ref$rowIndex === void 0 ? this.props.scrollToRow : _ref$rowIndex;

      var offsetProps = _objectSpread({}, this.props, {
        scrollToAlignment: alignment,
        scrollToColumn: columnIndex,
        scrollToRow: rowIndex
      });

      return {
        scrollLeft: this._getCalculatedScrollLeft(offsetProps),
        scrollTop: this._getCalculatedScrollTop(offsetProps)
      };
    }
    /**
     * Gets estimated total rows' height.
     */

  }, {
    key: "getTotalRowsHeight",
    value: function getTotalRowsHeight() {
      return this.state.instanceProps.rowSizeAndPositionManager.getTotalSize();
    }
    /**
     * Gets estimated total columns' width.
     */

  }, {
    key: "getTotalColumnsWidth",
    value: function getTotalColumnsWidth() {
      return this.state.instanceProps.columnSizeAndPositionManager.getTotalSize();
    }
    /**
     * This method handles a scroll event originating from an external scroll control.
     * It's an advanced method and should probably not be used unless you're implementing a custom scroll-bar solution.
     */

  }, {
    key: "handleScrollEvent",
    value: function handleScrollEvent(_ref2) {
      var _ref2$scrollLeft = _ref2.scrollLeft,
          scrollLeftParam = _ref2$scrollLeft === void 0 ? 0 : _ref2$scrollLeft,
          _ref2$scrollTop = _ref2.scrollTop,
          scrollTopParam = _ref2$scrollTop === void 0 ? 0 : _ref2$scrollTop;

      // On iOS, we can arrive at negative offsets by swiping past the start.
      // To prevent flicker here, we make playing in the negative offset zone cause nothing to happen.
      if (scrollTopParam < 0) {
        return;
      } // Prevent pointer events from interrupting a smooth scroll


      this._debounceScrollEnded();

      var _this$props = this.props,
          autoHeight = _this$props.autoHeight,
          autoWidth = _this$props.autoWidth,
          height = _this$props.height,
          width = _this$props.width;
      var instanceProps = this.state.instanceProps; // When this component is shrunk drastically, React dispatches a series of back-to-back scroll events,
      // Gradually converging on a scrollTop that is within the bounds of the new, smaller height.
      // This causes a series of rapid renders that is slow for long lists.
      // We can avoid that by doing some simple bounds checking to ensure that scroll offsets never exceed their bounds.

      var scrollbarSize = instanceProps.scrollbarSize;
      var totalRowsHeight = instanceProps.rowSizeAndPositionManager.getTotalSize();
      var totalColumnsWidth = instanceProps.columnSizeAndPositionManager.getTotalSize();
      var scrollLeft = Math.min(Math.max(0, totalColumnsWidth - width + scrollbarSize), scrollLeftParam);
      var scrollTop = Math.min(Math.max(0, totalRowsHeight - height + scrollbarSize), scrollTopParam); // Certain devices (like Apple touchpad) rapid-fire duplicate events.
      // Don't force a re-render if this is the case.
      // The mouse may move faster then the animation frame does.
      // Use requestAnimationFrame to avoid over-updating.

      if (this.state.scrollLeft !== scrollLeft || this.state.scrollTop !== scrollTop) {
        // Track scrolling direction so we can more efficiently overscan rows to reduce empty space around the edges while scrolling.
        // Don't change direction for an axis unless scroll offset has changed.
        var scrollDirectionHorizontal = scrollLeft !== this.state.scrollLeft ? scrollLeft > this.state.scrollLeft ? SCROLL_DIRECTION_FORWARD : SCROLL_DIRECTION_BACKWARD : this.state.scrollDirectionHorizontal;
        var scrollDirectionVertical = scrollTop !== this.state.scrollTop ? scrollTop > this.state.scrollTop ? SCROLL_DIRECTION_FORWARD : SCROLL_DIRECTION_BACKWARD : this.state.scrollDirectionVertical;
        var newState = {
          isScrolling: true,
          scrollDirectionHorizontal: scrollDirectionHorizontal,
          scrollDirectionVertical: scrollDirectionVertical,
          scrollPositionChangeReason: SCROLL_POSITION_CHANGE_REASONS.OBSERVED
        };

        if (!autoHeight) {
          newState.scrollTop = scrollTop;
        }

        if (!autoWidth) {
          newState.scrollLeft = scrollLeft;
        }

        newState.needToResetStyleCache = false;
        this.setState(newState);
      }

      this._invokeOnScrollMemoizer({
        scrollLeft: scrollLeft,
        scrollTop: scrollTop,
        totalColumnsWidth: totalColumnsWidth,
        totalRowsHeight: totalRowsHeight
      });
    }
    /**
     * Invalidate Grid size and recompute visible cells.
     * This is a deferred wrapper for recomputeGridSize().
     * It sets a flag to be evaluated on cDM/cDU to avoid unnecessary renders.
     * This method is intended for advanced use-cases like CellMeasurer.
     */
    // @TODO (bvaughn) Add automated test coverage for this.

  }, {
    key: "invalidateCellSizeAfterRender",
    value: function invalidateCellSizeAfterRender(_ref3) {
      var columnIndex = _ref3.columnIndex,
          rowIndex = _ref3.rowIndex;
      this._deferredInvalidateColumnIndex = typeof this._deferredInvalidateColumnIndex === 'number' ? Math.min(this._deferredInvalidateColumnIndex, columnIndex) : columnIndex;
      this._deferredInvalidateRowIndex = typeof this._deferredInvalidateRowIndex === 'number' ? Math.min(this._deferredInvalidateRowIndex, rowIndex) : rowIndex;
    }
    /**
     * Pre-measure all columns and rows in a Grid.
     * Typically cells are only measured as needed and estimated sizes are used for cells that have not yet been measured.
     * This method ensures that the next call to getTotalSize() returns an exact size (as opposed to just an estimated one).
     */

  }, {
    key: "measureAllCells",
    value: function measureAllCells() {
      var _this$props2 = this.props,
          columnCount = _this$props2.columnCount,
          rowCount = _this$props2.rowCount;
      var instanceProps = this.state.instanceProps;
      instanceProps.columnSizeAndPositionManager.getSizeAndPositionOfCell(columnCount - 1);
      instanceProps.rowSizeAndPositionManager.getSizeAndPositionOfCell(rowCount - 1);
    }
    /**
     * Forced recompute of row heights and column widths.
     * This function should be called if dynamic column or row sizes have changed but nothing else has.
     * Since Grid only receives :columnCount and :rowCount it has no way of detecting when the underlying data changes.
     */

  }, {
    key: "recomputeGridSize",
    value: function recomputeGridSize() {
      var _ref4 = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {},
          _ref4$columnIndex = _ref4.columnIndex,
          columnIndex = _ref4$columnIndex === void 0 ? 0 : _ref4$columnIndex,
          _ref4$rowIndex = _ref4.rowIndex,
          rowIndex = _ref4$rowIndex === void 0 ? 0 : _ref4$rowIndex;

      var _this$props3 = this.props,
          scrollToColumn = _this$props3.scrollToColumn,
          scrollToRow = _this$props3.scrollToRow;
      var instanceProps = this.state.instanceProps;
      instanceProps.columnSizeAndPositionManager.resetCell(columnIndex);
      instanceProps.rowSizeAndPositionManager.resetCell(rowIndex); // Cell sizes may be determined by a function property.
      // In this case the cDU handler can't know if they changed.
      // Store this flag to let the next cDU pass know it needs to recompute the scroll offset.

      this._recomputeScrollLeftFlag = scrollToColumn >= 0 && (this.state.scrollDirectionHorizontal === SCROLL_DIRECTION_FORWARD ? columnIndex <= scrollToColumn : columnIndex >= scrollToColumn);
      this._recomputeScrollTopFlag = scrollToRow >= 0 && (this.state.scrollDirectionVertical === SCROLL_DIRECTION_FORWARD ? rowIndex <= scrollToRow : rowIndex >= scrollToRow); // Clear cell cache in case we are scrolling;
      // Invalid row heights likely mean invalid cached content as well.

      this._styleCache = {};
      this._cellCache = {};
      this.forceUpdate();
    }
    /**
     * Ensure column and row are visible.
     */

  }, {
    key: "scrollToCell",
    value: function scrollToCell(_ref5) {
      var columnIndex = _ref5.columnIndex,
          rowIndex = _ref5.rowIndex;
      var columnCount = this.props.columnCount;
      var props = this.props; // Don't adjust scroll offset for single-column grids (eg List, Table).
      // This can cause a funky scroll offset because of the vertical scrollbar width.

      if (columnCount > 1 && columnIndex !== undefined) {
        this._updateScrollLeftForScrollToColumn(_objectSpread({}, props, {
          scrollToColumn: columnIndex
        }));
      }

      if (rowIndex !== undefined) {
        this._updateScrollTopForScrollToRow(_objectSpread({}, props, {
          scrollToRow: rowIndex
        }));
      }
    }
  }, {
    key: "componentDidMount",
    value: function componentDidMount() {
      var _this$props4 = this.props,
          getScrollbarSize = _this$props4.getScrollbarSize,
          height = _this$props4.height,
          scrollLeft = _this$props4.scrollLeft,
          scrollToColumn = _this$props4.scrollToColumn,
          scrollTop = _this$props4.scrollTop,
          scrollToRow = _this$props4.scrollToRow,
          width = _this$props4.width;
      var instanceProps = this.state.instanceProps; // Reset initial offsets to be ignored in browser

      this._initialScrollTop = 0;
      this._initialScrollLeft = 0; // If cell sizes have been invalidated (eg we are using CellMeasurer) then reset cached positions.
      // We must do this at the start of the method as we may calculate and update scroll position below.

      this._handleInvalidatedGridSize(); // If this component was first rendered server-side, scrollbar size will be undefined.
      // In that event we need to remeasure.


      if (!instanceProps.scrollbarSizeMeasured) {
        this.setState(function (prevState) {
          var stateUpdate = _objectSpread({}, prevState, {
            needToResetStyleCache: false
          });

          stateUpdate.instanceProps.scrollbarSize = getScrollbarSize();
          stateUpdate.instanceProps.scrollbarSizeMeasured = true;
          return stateUpdate;
        });
      }

      if (typeof scrollLeft === 'number' && scrollLeft >= 0 || typeof scrollTop === 'number' && scrollTop >= 0) {
        var stateUpdate = Grid._getScrollToPositionStateUpdate({
          prevState: this.state,
          scrollLeft: scrollLeft,
          scrollTop: scrollTop
        });

        if (stateUpdate) {
          stateUpdate.needToResetStyleCache = false;
          this.setState(stateUpdate);
        }
      } // refs don't work in `react-test-renderer`


      if (this._scrollingContainer) {
        // setting the ref's scrollLeft and scrollTop.
        // Somehow in MultiGrid the main grid doesn't trigger a update on mount.
        if (this._scrollingContainer.scrollLeft !== this.state.scrollLeft) {
          this._scrollingContainer.scrollLeft = this.state.scrollLeft;
        }

        if (this._scrollingContainer.scrollTop !== this.state.scrollTop) {
          this._scrollingContainer.scrollTop = this.state.scrollTop;
        }
      } // Don't update scroll offset if the size is 0; we don't render any cells in this case.
      // Setting a state may cause us to later thing we've updated the offce when we haven't.


      var sizeIsBiggerThanZero = height > 0 && width > 0;

      if (scrollToColumn >= 0 && sizeIsBiggerThanZero) {
        this._updateScrollLeftForScrollToColumn();
      }

      if (scrollToRow >= 0 && sizeIsBiggerThanZero) {
        this._updateScrollTopForScrollToRow();
      } // Update onRowsRendered callback


      this._invokeOnGridRenderedHelper(); // Initialize onScroll callback


      this._invokeOnScrollMemoizer({
        scrollLeft: scrollLeft || 0,
        scrollTop: scrollTop || 0,
        totalColumnsWidth: instanceProps.columnSizeAndPositionManager.getTotalSize(),
        totalRowsHeight: instanceProps.rowSizeAndPositionManager.getTotalSize()
      });

      this._maybeCallOnScrollbarPresenceChange();
    }
    /**
     * @private
     * This method updates scrollLeft/scrollTop in state for the following conditions:
     * 1) New scroll-to-cell props have been set
     */

  }, {
    key: "componentDidUpdate",
    value: function componentDidUpdate(prevProps, prevState) {
      var _this2 = this;

      var _this$props5 = this.props,
          autoHeight = _this$props5.autoHeight,
          autoWidth = _this$props5.autoWidth,
          columnCount = _this$props5.columnCount,
          height = _this$props5.height,
          rowCount = _this$props5.rowCount,
          scrollToAlignment = _this$props5.scrollToAlignment,
          scrollToColumn = _this$props5.scrollToColumn,
          scrollToRow = _this$props5.scrollToRow,
          width = _this$props5.width;
      var _this$state = this.state,
          scrollLeft = _this$state.scrollLeft,
          scrollPositionChangeReason = _this$state.scrollPositionChangeReason,
          scrollTop = _this$state.scrollTop,
          instanceProps = _this$state.instanceProps; // If cell sizes have been invalidated (eg we are using CellMeasurer) then reset cached positions.
      // We must do this at the start of the method as we may calculate and update scroll position below.

      this._handleInvalidatedGridSize(); // Handle edge case where column or row count has only just increased over 0.
      // In this case we may have to restore a previously-specified scroll offset.
      // For more info see bvaughn/react-virtualized/issues/218


      var columnOrRowCountJustIncreasedFromZero = columnCount > 0 && prevProps.columnCount === 0 || rowCount > 0 && prevProps.rowCount === 0; // Make sure requested changes to :scrollLeft or :scrollTop get applied.
      // Assigning to scrollLeft/scrollTop tells the browser to interrupt any running scroll animations,
      // And to discard any pending async changes to the scroll position that may have happened in the meantime (e.g. on a separate scrolling thread).
      // So we only set these when we require an adjustment of the scroll position.
      // See issue #2 for more information.

      if (scrollPositionChangeReason === SCROLL_POSITION_CHANGE_REASONS.REQUESTED) {
        // @TRICKY :autoHeight and :autoWidth properties instructs Grid to leave :scrollTop and :scrollLeft management to an external HOC (eg WindowScroller).
        // In this case we should avoid checking scrollingContainer.scrollTop and scrollingContainer.scrollLeft since it forces layout/flow.
        if (!autoWidth && scrollLeft >= 0 && (scrollLeft !== this._scrollingContainer.scrollLeft || columnOrRowCountJustIncreasedFromZero)) {
          this._scrollingContainer.scrollLeft = scrollLeft;
        }

        if (!autoHeight && scrollTop >= 0 && (scrollTop !== this._scrollingContainer.scrollTop || columnOrRowCountJustIncreasedFromZero)) {
          this._scrollingContainer.scrollTop = scrollTop;
        }
      } // Special case where the previous size was 0:
      // In this case we don't show any windowed cells at all.
      // So we should always recalculate offset afterwards.


      var sizeJustIncreasedFromZero = (prevProps.width === 0 || prevProps.height === 0) && height > 0 && width > 0; // Update scroll offsets if the current :scrollToColumn or :scrollToRow values requires it
      // @TODO Do we also need this check or can the one in componentWillUpdate() suffice?

      if (this._recomputeScrollLeftFlag) {
        this._recomputeScrollLeftFlag = false;

        this._updateScrollLeftForScrollToColumn(this.props);
      } else {
        updateScrollIndexHelper({
          cellSizeAndPositionManager: instanceProps.columnSizeAndPositionManager,
          previousCellsCount: prevProps.columnCount,
          previousCellSize: prevProps.columnWidth,
          previousScrollToAlignment: prevProps.scrollToAlignment,
          previousScrollToIndex: prevProps.scrollToColumn,
          previousSize: prevProps.width,
          scrollOffset: scrollLeft,
          scrollToAlignment: scrollToAlignment,
          scrollToIndex: scrollToColumn,
          size: width,
          sizeJustIncreasedFromZero: sizeJustIncreasedFromZero,
          updateScrollIndexCallback: function updateScrollIndexCallback() {
            return _this2._updateScrollLeftForScrollToColumn(_this2.props);
          }
        });
      }

      if (this._recomputeScrollTopFlag) {
        this._recomputeScrollTopFlag = false;

        this._updateScrollTopForScrollToRow(this.props);
      } else {
        updateScrollIndexHelper({
          cellSizeAndPositionManager: instanceProps.rowSizeAndPositionManager,
          previousCellsCount: prevProps.rowCount,
          previousCellSize: prevProps.rowHeight,
          previousScrollToAlignment: prevProps.scrollToAlignment,
          previousScrollToIndex: prevProps.scrollToRow,
          previousSize: prevProps.height,
          scrollOffset: scrollTop,
          scrollToAlignment: scrollToAlignment,
          scrollToIndex: scrollToRow,
          size: height,
          sizeJustIncreasedFromZero: sizeJustIncreasedFromZero,
          updateScrollIndexCallback: function updateScrollIndexCallback() {
            return _this2._updateScrollTopForScrollToRow(_this2.props);
          }
        });
      } // Update onRowsRendered callback if start/stop indices have changed


      this._invokeOnGridRenderedHelper(); // Changes to :scrollLeft or :scrollTop should also notify :onScroll listeners


      if (scrollLeft !== prevState.scrollLeft || scrollTop !== prevState.scrollTop) {
        var totalRowsHeight = instanceProps.rowSizeAndPositionManager.getTotalSize();
        var totalColumnsWidth = instanceProps.columnSizeAndPositionManager.getTotalSize();

        this._invokeOnScrollMemoizer({
          scrollLeft: scrollLeft,
          scrollTop: scrollTop,
          totalColumnsWidth: totalColumnsWidth,
          totalRowsHeight: totalRowsHeight
        });
      }

      this._maybeCallOnScrollbarPresenceChange();
    }
  }, {
    key: "componentWillUnmount",
    value: function componentWillUnmount() {
      if (this._disablePointerEventsTimeoutId) {
        cancelAnimationTimeout(this._disablePointerEventsTimeoutId);
      }
    }
    /**
     * This method updates scrollLeft/scrollTop in state for the following conditions:
     * 1) Empty content (0 rows or columns)
     * 2) New scroll props overriding the current state
     * 3) Cells-count or cells-size has changed, making previous scroll offsets invalid
     */

  }, {
    key: "render",
    value: function render() {
      var _this$props6 = this.props,
          autoContainerWidth = _this$props6.autoContainerWidth,
          autoHeight = _this$props6.autoHeight,
          autoWidth = _this$props6.autoWidth,
          className = _this$props6.className,
          containerProps = _this$props6.containerProps,
          containerRole = _this$props6.containerRole,
          containerStyle = _this$props6.containerStyle,
          height = _this$props6.height,
          id = _this$props6.id,
          noContentRenderer = _this$props6.noContentRenderer,
          role = _this$props6.role,
          style = _this$props6.style,
          tabIndex = _this$props6.tabIndex,
          width = _this$props6.width;
      var _this$state2 = this.state,
          instanceProps = _this$state2.instanceProps,
          needToResetStyleCache = _this$state2.needToResetStyleCache;

      var isScrolling = this._isScrolling();

      var gridStyle = {
        boxSizing: 'border-box',
        direction: 'ltr',
        height: autoHeight ? 'auto' : height,
        position: 'relative',
        width: autoWidth ? 'auto' : width,
        WebkitOverflowScrolling: 'touch',
        willChange: 'transform'
      };

      if (needToResetStyleCache) {
        this._styleCache = {};
      } // calculate _styleCache here
      // if state.isScrolling (not from _isScrolling) then reset


      if (!this.state.isScrolling) {
        this._resetStyleCache();
      } // calculate children to render here


      this._calculateChildrenToRender(this.props, this.state);

      var totalColumnsWidth = instanceProps.columnSizeAndPositionManager.getTotalSize();
      var totalRowsHeight = instanceProps.rowSizeAndPositionManager.getTotalSize(); // Force browser to hide scrollbars when we know they aren't necessary.
      // Otherwise once scrollbars appear they may not disappear again.
      // For more info see issue #116

      var verticalScrollBarSize = totalRowsHeight > height ? instanceProps.scrollbarSize : 0;
      var horizontalScrollBarSize = totalColumnsWidth > width ? instanceProps.scrollbarSize : 0;

      if (horizontalScrollBarSize !== this._horizontalScrollBarSize || verticalScrollBarSize !== this._verticalScrollBarSize) {
        this._horizontalScrollBarSize = horizontalScrollBarSize;
        this._verticalScrollBarSize = verticalScrollBarSize;
        this._scrollbarPresenceChanged = true;
      } // Also explicitly init styles to 'auto' if scrollbars are required.
      // This works around an obscure edge case where external CSS styles have not yet been loaded,
      // But an initial scroll index of offset is set as an external prop.
      // Without this style, Grid would render the correct range of cells but would NOT update its internal offset.
      // This was originally reported via clauderic/react-infinite-calendar/issues/23


      gridStyle.overflowX = totalColumnsWidth + verticalScrollBarSize <= width ? 'hidden' : 'auto';
      gridStyle.overflowY = totalRowsHeight + horizontalScrollBarSize <= height ? 'hidden' : 'auto';
      var childrenToDisplay = this._childrenToDisplay;
      var showNoContentRenderer = childrenToDisplay.length === 0 && height > 0 && width > 0;
      return react.createElement("div", extends_extends({
        ref: this._setScrollingContainerRef
      }, containerProps, {
        "aria-label": this.props['aria-label'],
        "aria-readonly": this.props['aria-readonly'],
        className: clsx_m('ReactVirtualized__Grid', className),
        id: id,
        onScroll: this._onScroll,
        role: role,
        style: _objectSpread({}, gridStyle, {}, style),
        tabIndex: tabIndex
      }), childrenToDisplay.length > 0 && react.createElement("div", {
        className: "ReactVirtualized__Grid__innerScrollContainer",
        role: containerRole,
        style: _objectSpread({
          width: autoContainerWidth ? 'auto' : totalColumnsWidth,
          height: totalRowsHeight,
          maxWidth: totalColumnsWidth,
          maxHeight: totalRowsHeight,
          overflow: 'hidden',
          pointerEvents: isScrolling ? 'none' : '',
          position: 'relative'
        }, containerStyle)
      }, childrenToDisplay), showNoContentRenderer && noContentRenderer());
    }
    /* ---------------------------- Helper methods ---------------------------- */

  }, {
    key: "_calculateChildrenToRender",
    value: function _calculateChildrenToRender() {
      var props = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : this.props;
      var state = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : this.state;
      var cellRenderer = props.cellRenderer,
          cellRangeRenderer = props.cellRangeRenderer,
          columnCount = props.columnCount,
          deferredMeasurementCache = props.deferredMeasurementCache,
          height = props.height,
          overscanColumnCount = props.overscanColumnCount,
          overscanIndicesGetter = props.overscanIndicesGetter,
          overscanRowCount = props.overscanRowCount,
          rowCount = props.rowCount,
          width = props.width,
          isScrollingOptOut = props.isScrollingOptOut;
      var scrollDirectionHorizontal = state.scrollDirectionHorizontal,
          scrollDirectionVertical = state.scrollDirectionVertical,
          instanceProps = state.instanceProps;
      var scrollTop = this._initialScrollTop > 0 ? this._initialScrollTop : state.scrollTop;
      var scrollLeft = this._initialScrollLeft > 0 ? this._initialScrollLeft : state.scrollLeft;

      var isScrolling = this._isScrolling(props, state);

      this._childrenToDisplay = []; // Render only enough columns and rows to cover the visible area of the grid.

      if (height > 0 && width > 0) {
        var visibleColumnIndices = instanceProps.columnSizeAndPositionManager.getVisibleCellRange({
          containerSize: width,
          offset: scrollLeft
        });
        var visibleRowIndices = instanceProps.rowSizeAndPositionManager.getVisibleCellRange({
          containerSize: height,
          offset: scrollTop
        });
        var horizontalOffsetAdjustment = instanceProps.columnSizeAndPositionManager.getOffsetAdjustment({
          containerSize: width,
          offset: scrollLeft
        });
        var verticalOffsetAdjustment = instanceProps.rowSizeAndPositionManager.getOffsetAdjustment({
          containerSize: height,
          offset: scrollTop
        }); // Store for _invokeOnGridRenderedHelper()

        this._renderedColumnStartIndex = visibleColumnIndices.start;
        this._renderedColumnStopIndex = visibleColumnIndices.stop;
        this._renderedRowStartIndex = visibleRowIndices.start;
        this._renderedRowStopIndex = visibleRowIndices.stop;
        var overscanColumnIndices = overscanIndicesGetter({
          direction: 'horizontal',
          cellCount: columnCount,
          overscanCellsCount: overscanColumnCount,
          scrollDirection: scrollDirectionHorizontal,
          startIndex: typeof visibleColumnIndices.start === 'number' ? visibleColumnIndices.start : 0,
          stopIndex: typeof visibleColumnIndices.stop === 'number' ? visibleColumnIndices.stop : -1
        });
        var overscanRowIndices = overscanIndicesGetter({
          direction: 'vertical',
          cellCount: rowCount,
          overscanCellsCount: overscanRowCount,
          scrollDirection: scrollDirectionVertical,
          startIndex: typeof visibleRowIndices.start === 'number' ? visibleRowIndices.start : 0,
          stopIndex: typeof visibleRowIndices.stop === 'number' ? visibleRowIndices.stop : -1
        }); // Store for _invokeOnGridRenderedHelper()

        var columnStartIndex = overscanColumnIndices.overscanStartIndex;
        var columnStopIndex = overscanColumnIndices.overscanStopIndex;
        var rowStartIndex = overscanRowIndices.overscanStartIndex;
        var rowStopIndex = overscanRowIndices.overscanStopIndex; // Advanced use-cases (eg CellMeasurer) require batched measurements to determine accurate sizes.

        if (deferredMeasurementCache) {
          // If rows have a dynamic height, scan the rows we are about to render.
          // If any have not yet been measured, then we need to render all columns initially,
          // Because the height of the row is equal to the tallest cell within that row,
          // (And so we can't know the height without measuring all column-cells first).
          if (!deferredMeasurementCache.hasFixedHeight()) {
            for (var rowIndex = rowStartIndex; rowIndex <= rowStopIndex; rowIndex++) {
              if (!deferredMeasurementCache.has(rowIndex, 0)) {
                columnStartIndex = 0;
                columnStopIndex = columnCount - 1;
                break;
              }
            }
          } // If columns have a dynamic width, scan the columns we are about to render.
          // If any have not yet been measured, then we need to render all rows initially,
          // Because the width of the column is equal to the widest cell within that column,
          // (And so we can't know the width without measuring all row-cells first).


          if (!deferredMeasurementCache.hasFixedWidth()) {
            for (var columnIndex = columnStartIndex; columnIndex <= columnStopIndex; columnIndex++) {
              if (!deferredMeasurementCache.has(0, columnIndex)) {
                rowStartIndex = 0;
                rowStopIndex = rowCount - 1;
                break;
              }
            }
          }
        }

        this._childrenToDisplay = cellRangeRenderer({
          cellCache: this._cellCache,
          cellRenderer: cellRenderer,
          columnSizeAndPositionManager: instanceProps.columnSizeAndPositionManager,
          columnStartIndex: columnStartIndex,
          columnStopIndex: columnStopIndex,
          deferredMeasurementCache: deferredMeasurementCache,
          horizontalOffsetAdjustment: horizontalOffsetAdjustment,
          isScrolling: isScrolling,
          isScrollingOptOut: isScrollingOptOut,
          parent: this,
          rowSizeAndPositionManager: instanceProps.rowSizeAndPositionManager,
          rowStartIndex: rowStartIndex,
          rowStopIndex: rowStopIndex,
          scrollLeft: scrollLeft,
          scrollTop: scrollTop,
          styleCache: this._styleCache,
          verticalOffsetAdjustment: verticalOffsetAdjustment,
          visibleColumnIndices: visibleColumnIndices,
          visibleRowIndices: visibleRowIndices
        }); // update the indices

        this._columnStartIndex = columnStartIndex;
        this._columnStopIndex = columnStopIndex;
        this._rowStartIndex = rowStartIndex;
        this._rowStopIndex = rowStopIndex;
      }
    }
    /**
     * Sets an :isScrolling flag for a small window of time.
     * This flag is used to disable pointer events on the scrollable portion of the Grid.
     * This prevents jerky/stuttery mouse-wheel scrolling.
     */

  }, {
    key: "_debounceScrollEnded",
    value: function _debounceScrollEnded() {
      var scrollingResetTimeInterval = this.props.scrollingResetTimeInterval;

      if (this._disablePointerEventsTimeoutId) {
        cancelAnimationTimeout(this._disablePointerEventsTimeoutId);
      }

      this._disablePointerEventsTimeoutId = requestAnimationTimeout(this._debounceScrollEndedCallback, scrollingResetTimeInterval);
    }
  }, {
    key: "_handleInvalidatedGridSize",

    /**
     * Check for batched CellMeasurer size invalidations.
     * This will occur the first time one or more previously unmeasured cells are rendered.
     */
    value: function _handleInvalidatedGridSize() {
      if (typeof this._deferredInvalidateColumnIndex === 'number' && typeof this._deferredInvalidateRowIndex === 'number') {
        var columnIndex = this._deferredInvalidateColumnIndex;
        var rowIndex = this._deferredInvalidateRowIndex;
        this._deferredInvalidateColumnIndex = null;
        this._deferredInvalidateRowIndex = null;
        this.recomputeGridSize({
          columnIndex: columnIndex,
          rowIndex: rowIndex
        });
      }
    }
  }, {
    key: "_invokeOnScrollMemoizer",
    value: function _invokeOnScrollMemoizer(_ref6) {
      var _this3 = this;

      var scrollLeft = _ref6.scrollLeft,
          scrollTop = _ref6.scrollTop,
          totalColumnsWidth = _ref6.totalColumnsWidth,
          totalRowsHeight = _ref6.totalRowsHeight;

      this._onScrollMemoizer({
        callback: function callback(_ref7) {
          var scrollLeft = _ref7.scrollLeft,
              scrollTop = _ref7.scrollTop;
          var _this3$props = _this3.props,
              height = _this3$props.height,
              onScroll = _this3$props.onScroll,
              width = _this3$props.width;
          onScroll({
            clientHeight: height,
            clientWidth: width,
            scrollHeight: totalRowsHeight,
            scrollLeft: scrollLeft,
            scrollTop: scrollTop,
            scrollWidth: totalColumnsWidth
          });
        },
        indices: {
          scrollLeft: scrollLeft,
          scrollTop: scrollTop
        }
      });
    }
  }, {
    key: "_isScrolling",
    value: function _isScrolling() {
      var props = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : this.props;
      var state = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : this.state;
      // If isScrolling is defined in props, use it to override the value in state
      // This is a performance optimization for WindowScroller + Grid
      return Object.hasOwnProperty.call(props, 'isScrolling') ? Boolean(props.isScrolling) : Boolean(state.isScrolling);
    }
  }, {
    key: "_maybeCallOnScrollbarPresenceChange",
    value: function _maybeCallOnScrollbarPresenceChange() {
      if (this._scrollbarPresenceChanged) {
        var onScrollbarPresenceChange = this.props.onScrollbarPresenceChange;
        this._scrollbarPresenceChanged = false;
        onScrollbarPresenceChange({
          horizontal: this._horizontalScrollBarSize > 0,
          size: this.state.instanceProps.scrollbarSize,
          vertical: this._verticalScrollBarSize > 0
        });
      }
    }
  }, {
    key: "scrollToPosition",

    /**
     * Scroll to the specified offset(s).
     * Useful for animating position changes.
     */
    value: function scrollToPosition(_ref8) {
      var scrollLeft = _ref8.scrollLeft,
          scrollTop = _ref8.scrollTop;

      var stateUpdate = Grid._getScrollToPositionStateUpdate({
        prevState: this.state,
        scrollLeft: scrollLeft,
        scrollTop: scrollTop
      });

      if (stateUpdate) {
        stateUpdate.needToResetStyleCache = false;
        this.setState(stateUpdate);
      }
    }
  }, {
    key: "_getCalculatedScrollLeft",
    value: function _getCalculatedScrollLeft() {
      var props = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : this.props;
      var state = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : this.state;
      return Grid._getCalculatedScrollLeft(props, state);
    }
  }, {
    key: "_updateScrollLeftForScrollToColumn",
    value: function _updateScrollLeftForScrollToColumn() {
      var props = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : this.props;
      var state = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : this.state;

      var stateUpdate = Grid._getScrollLeftForScrollToColumnStateUpdate(props, state);

      if (stateUpdate) {
        stateUpdate.needToResetStyleCache = false;
        this.setState(stateUpdate);
      }
    }
  }, {
    key: "_getCalculatedScrollTop",
    value: function _getCalculatedScrollTop() {
      var props = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : this.props;
      var state = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : this.state;
      return Grid._getCalculatedScrollTop(props, state);
    }
  }, {
    key: "_resetStyleCache",
    value: function _resetStyleCache() {
      var styleCache = this._styleCache;
      var cellCache = this._cellCache;
      var isScrollingOptOut = this.props.isScrollingOptOut; // Reset cell and style caches once scrolling stops.
      // This makes Grid simpler to use (since cells commonly change).
      // And it keeps the caches from growing too large.
      // Performance is most sensitive when a user is scrolling.
      // Don't clear visible cells from cellCache if isScrollingOptOut is specified.
      // This keeps the cellCache to a resonable size.

      this._cellCache = {};
      this._styleCache = {}; // Copy over the visible cell styles so avoid unnecessary re-render.

      for (var rowIndex = this._rowStartIndex; rowIndex <= this._rowStopIndex; rowIndex++) {
        for (var columnIndex = this._columnStartIndex; columnIndex <= this._columnStopIndex; columnIndex++) {
          var key = "".concat(rowIndex, "-").concat(columnIndex);
          this._styleCache[key] = styleCache[key];

          if (isScrollingOptOut) {
            this._cellCache[key] = cellCache[key];
          }
        }
      }
    }
  }, {
    key: "_updateScrollTopForScrollToRow",
    value: function _updateScrollTopForScrollToRow() {
      var props = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : this.props;
      var state = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : this.state;

      var stateUpdate = Grid._getScrollTopForScrollToRowStateUpdate(props, state);

      if (stateUpdate) {
        stateUpdate.needToResetStyleCache = false;
        this.setState(stateUpdate);
      }
    }
  }], [{
    key: "getDerivedStateFromProps",
    value: function getDerivedStateFromProps(nextProps, prevState) {
      var newState = {};

      if (nextProps.columnCount === 0 && prevState.scrollLeft !== 0 || nextProps.rowCount === 0 && prevState.scrollTop !== 0) {
        newState.scrollLeft = 0;
        newState.scrollTop = 0; // only use scroll{Left,Top} from props if scrollTo{Column,Row} isn't specified
        // scrollTo{Column,Row} should override scroll{Left,Top}
      } else if (nextProps.scrollLeft !== prevState.scrollLeft && nextProps.scrollToColumn < 0 || nextProps.scrollTop !== prevState.scrollTop && nextProps.scrollToRow < 0) {
        Object.assign(newState, Grid._getScrollToPositionStateUpdate({
          prevState: prevState,
          scrollLeft: nextProps.scrollLeft,
          scrollTop: nextProps.scrollTop
        }));
      }

      var instanceProps = prevState.instanceProps; // Initially we should not clearStyleCache

      newState.needToResetStyleCache = false;

      if (nextProps.columnWidth !== instanceProps.prevColumnWidth || nextProps.rowHeight !== instanceProps.prevRowHeight) {
        // Reset cache. set it to {} in render
        newState.needToResetStyleCache = true;
      }

      instanceProps.columnSizeAndPositionManager.configure({
        cellCount: nextProps.columnCount,
        estimatedCellSize: Grid._getEstimatedColumnSize(nextProps),
        cellSizeGetter: Grid._wrapSizeGetter(nextProps.columnWidth)
      });
      instanceProps.rowSizeAndPositionManager.configure({
        cellCount: nextProps.rowCount,
        estimatedCellSize: Grid._getEstimatedRowSize(nextProps),
        cellSizeGetter: Grid._wrapSizeGetter(nextProps.rowHeight)
      });

      if (instanceProps.prevColumnCount === 0 || instanceProps.prevRowCount === 0) {
        instanceProps.prevColumnCount = 0;
        instanceProps.prevRowCount = 0;
      } // If scrolling is controlled outside this component, clear cache when scrolling stops


      if (nextProps.autoHeight && nextProps.isScrolling === false && instanceProps.prevIsScrolling === true) {
        Object.assign(newState, {
          isScrolling: false
        });
      }

      var maybeStateA;
      var maybeStateB;
      calculateSizeAndPositionDataAndUpdateScrollOffset({
        cellCount: instanceProps.prevColumnCount,
        cellSize: typeof instanceProps.prevColumnWidth === 'number' ? instanceProps.prevColumnWidth : null,
        computeMetadataCallback: function computeMetadataCallback() {
          return instanceProps.columnSizeAndPositionManager.resetCell(0);
        },
        computeMetadataCallbackProps: nextProps,
        nextCellsCount: nextProps.columnCount,
        nextCellSize: typeof nextProps.columnWidth === 'number' ? nextProps.columnWidth : null,
        nextScrollToIndex: nextProps.scrollToColumn,
        scrollToIndex: instanceProps.prevScrollToColumn,
        updateScrollOffsetForScrollToIndex: function updateScrollOffsetForScrollToIndex() {
          maybeStateA = Grid._getScrollLeftForScrollToColumnStateUpdate(nextProps, prevState);
        }
      });
      calculateSizeAndPositionDataAndUpdateScrollOffset({
        cellCount: instanceProps.prevRowCount,
        cellSize: typeof instanceProps.prevRowHeight === 'number' ? instanceProps.prevRowHeight : null,
        computeMetadataCallback: function computeMetadataCallback() {
          return instanceProps.rowSizeAndPositionManager.resetCell(0);
        },
        computeMetadataCallbackProps: nextProps,
        nextCellsCount: nextProps.rowCount,
        nextCellSize: typeof nextProps.rowHeight === 'number' ? nextProps.rowHeight : null,
        nextScrollToIndex: nextProps.scrollToRow,
        scrollToIndex: instanceProps.prevScrollToRow,
        updateScrollOffsetForScrollToIndex: function updateScrollOffsetForScrollToIndex() {
          maybeStateB = Grid._getScrollTopForScrollToRowStateUpdate(nextProps, prevState);
        }
      });
      instanceProps.prevColumnCount = nextProps.columnCount;
      instanceProps.prevColumnWidth = nextProps.columnWidth;
      instanceProps.prevIsScrolling = nextProps.isScrolling === true;
      instanceProps.prevRowCount = nextProps.rowCount;
      instanceProps.prevRowHeight = nextProps.rowHeight;
      instanceProps.prevScrollToColumn = nextProps.scrollToColumn;
      instanceProps.prevScrollToRow = nextProps.scrollToRow; // getting scrollBarSize (moved from componentWillMount)

      instanceProps.scrollbarSize = nextProps.getScrollbarSize();

      if (instanceProps.scrollbarSize === undefined) {
        instanceProps.scrollbarSizeMeasured = false;
        instanceProps.scrollbarSize = 0;
      } else {
        instanceProps.scrollbarSizeMeasured = true;
      }

      newState.instanceProps = instanceProps;
      return _objectSpread({}, newState, {}, maybeStateA, {}, maybeStateB);
    }
  }, {
    key: "_getEstimatedColumnSize",
    value: function _getEstimatedColumnSize(props) {
      return typeof props.columnWidth === 'number' ? props.columnWidth : props.estimatedColumnSize;
    }
  }, {
    key: "_getEstimatedRowSize",
    value: function _getEstimatedRowSize(props) {
      return typeof props.rowHeight === 'number' ? props.rowHeight : props.estimatedRowSize;
    }
  }, {
    key: "_getScrollToPositionStateUpdate",

    /**
     * Get the updated state after scrolling to
     * scrollLeft and scrollTop
     */
    value: function _getScrollToPositionStateUpdate(_ref9) {
      var prevState = _ref9.prevState,
          scrollLeft = _ref9.scrollLeft,
          scrollTop = _ref9.scrollTop;
      var newState = {
        scrollPositionChangeReason: SCROLL_POSITION_CHANGE_REASONS.REQUESTED
      };

      if (typeof scrollLeft === 'number' && scrollLeft >= 0) {
        newState.scrollDirectionHorizontal = scrollLeft > prevState.scrollLeft ? SCROLL_DIRECTION_FORWARD : SCROLL_DIRECTION_BACKWARD;
        newState.scrollLeft = scrollLeft;
      }

      if (typeof scrollTop === 'number' && scrollTop >= 0) {
        newState.scrollDirectionVertical = scrollTop > prevState.scrollTop ? SCROLL_DIRECTION_FORWARD : SCROLL_DIRECTION_BACKWARD;
        newState.scrollTop = scrollTop;
      }

      if (typeof scrollLeft === 'number' && scrollLeft >= 0 && scrollLeft !== prevState.scrollLeft || typeof scrollTop === 'number' && scrollTop >= 0 && scrollTop !== prevState.scrollTop) {
        return newState;
      }

      return {};
    }
  }, {
    key: "_wrapSizeGetter",
    value: function _wrapSizeGetter(value) {
      return typeof value === 'function' ? value : function () {
        return value;
      };
    }
  }, {
    key: "_getCalculatedScrollLeft",
    value: function _getCalculatedScrollLeft(nextProps, prevState) {
      var columnCount = nextProps.columnCount,
          height = nextProps.height,
          scrollToAlignment = nextProps.scrollToAlignment,
          scrollToColumn = nextProps.scrollToColumn,
          width = nextProps.width;
      var scrollLeft = prevState.scrollLeft,
          instanceProps = prevState.instanceProps;

      if (columnCount > 0) {
        var finalColumn = columnCount - 1;
        var targetIndex = scrollToColumn < 0 ? finalColumn : Math.min(finalColumn, scrollToColumn);
        var totalRowsHeight = instanceProps.rowSizeAndPositionManager.getTotalSize();
        var scrollBarSize = instanceProps.scrollbarSizeMeasured && totalRowsHeight > height ? instanceProps.scrollbarSize : 0;
        return instanceProps.columnSizeAndPositionManager.getUpdatedOffsetForIndex({
          align: scrollToAlignment,
          containerSize: width - scrollBarSize,
          currentOffset: scrollLeft,
          targetIndex: targetIndex
        });
      }

      return 0;
    }
  }, {
    key: "_getScrollLeftForScrollToColumnStateUpdate",
    value: function _getScrollLeftForScrollToColumnStateUpdate(nextProps, prevState) {
      var scrollLeft = prevState.scrollLeft;

      var calculatedScrollLeft = Grid._getCalculatedScrollLeft(nextProps, prevState);

      if (typeof calculatedScrollLeft === 'number' && calculatedScrollLeft >= 0 && scrollLeft !== calculatedScrollLeft) {
        return Grid._getScrollToPositionStateUpdate({
          prevState: prevState,
          scrollLeft: calculatedScrollLeft,
          scrollTop: -1
        });
      }

      return {};
    }
  }, {
    key: "_getCalculatedScrollTop",
    value: function _getCalculatedScrollTop(nextProps, prevState) {
      var height = nextProps.height,
          rowCount = nextProps.rowCount,
          scrollToAlignment = nextProps.scrollToAlignment,
          scrollToRow = nextProps.scrollToRow,
          width = nextProps.width;
      var scrollTop = prevState.scrollTop,
          instanceProps = prevState.instanceProps;

      if (rowCount > 0) {
        var finalRow = rowCount - 1;
        var targetIndex = scrollToRow < 0 ? finalRow : Math.min(finalRow, scrollToRow);
        var totalColumnsWidth = instanceProps.columnSizeAndPositionManager.getTotalSize();
        var scrollBarSize = instanceProps.scrollbarSizeMeasured && totalColumnsWidth > width ? instanceProps.scrollbarSize : 0;
        return instanceProps.rowSizeAndPositionManager.getUpdatedOffsetForIndex({
          align: scrollToAlignment,
          containerSize: height - scrollBarSize,
          currentOffset: scrollTop,
          targetIndex: targetIndex
        });
      }

      return 0;
    }
  }, {
    key: "_getScrollTopForScrollToRowStateUpdate",
    value: function _getScrollTopForScrollToRowStateUpdate(nextProps, prevState) {
      var scrollTop = prevState.scrollTop;

      var calculatedScrollTop = Grid._getCalculatedScrollTop(nextProps, prevState);

      if (typeof calculatedScrollTop === 'number' && calculatedScrollTop >= 0 && scrollTop !== calculatedScrollTop) {
        return Grid._getScrollToPositionStateUpdate({
          prevState: prevState,
          scrollLeft: -1,
          scrollTop: calculatedScrollTop
        });
      }

      return {};
    }
  }]);

  return Grid;
}(react.PureComponent), defineProperty_defineProperty(_class, "propTypes",  true ? null : 0), _temp);

defineProperty_defineProperty(Grid, "defaultProps", {
  'aria-label': 'grid',
  'aria-readonly': true,
  autoContainerWidth: false,
  autoHeight: false,
  autoWidth: false,
  cellRangeRenderer: defaultCellRangeRenderer,
  containerRole: 'rowgroup',
  containerStyle: {},
  estimatedColumnSize: 100,
  estimatedRowSize: 30,
  getScrollbarSize: scrollbarSize,
  noContentRenderer: renderNull,
  onScroll: function onScroll() {},
  onScrollbarPresenceChange: function onScrollbarPresenceChange() {},
  onSectionRendered: function onSectionRendered() {},
  overscanColumnCount: 0,
  overscanIndicesGetter: defaultOverscanIndicesGetter,
  overscanRowCount: 10,
  role: 'grid',
  scrollingResetTimeInterval: DEFAULT_SCROLLING_RESET_TIME_INTERVAL,
  scrollToAlignment: 'auto',
  scrollToColumn: -1,
  scrollToRow: -1,
  style: {},
  tabIndex: 0,
  isScrollingOptOut: false
});

react_lifecycles_compat_es_polyfill(Grid);
/* harmony default export */ const Grid_Grid = (Grid);















;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Grid/accessibilityOverscanIndicesGetter.js
var accessibilityOverscanIndicesGetter_SCROLL_DIRECTION_BACKWARD = (/* unused pure expression or super */ null && (-1));
var accessibilityOverscanIndicesGetter_SCROLL_DIRECTION_FORWARD = 1;
var accessibilityOverscanIndicesGetter_SCROLL_DIRECTION_HORIZONTAL = 'horizontal';
var accessibilityOverscanIndicesGetter_SCROLL_DIRECTION_VERTICAL = 'vertical';
/**
 * Calculates the number of cells to overscan before and after a specified range.
 * This function ensures that overscanning doesn't exceed the available cells.
 */

function accessibilityOverscanIndicesGetter_defaultOverscanIndicesGetter(_ref) {
  var cellCount = _ref.cellCount,
      overscanCellsCount = _ref.overscanCellsCount,
      scrollDirection = _ref.scrollDirection,
      startIndex = _ref.startIndex,
      stopIndex = _ref.stopIndex;
  // Make sure we render at least 1 cell extra before and after (except near boundaries)
  // This is necessary in order to support keyboard navigation (TAB/SHIFT+TAB) in some cases
  // For more info see issues #625
  overscanCellsCount = Math.max(1, overscanCellsCount);

  if (scrollDirection === accessibilityOverscanIndicesGetter_SCROLL_DIRECTION_FORWARD) {
    return {
      overscanStartIndex: Math.max(0, startIndex - 1),
      overscanStopIndex: Math.min(cellCount - 1, stopIndex + overscanCellsCount)
    };
  } else {
    return {
      overscanStartIndex: Math.max(0, startIndex - overscanCellsCount),
      overscanStopIndex: Math.min(cellCount - 1, stopIndex + 1)
    };
  }
}


;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Grid/index.js





















;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/ArrowKeyStepper/types.js
var bpfrpt_proptype_ScrollIndices =  true ? null : 0;


;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/ArrowKeyStepper/ArrowKeyStepper.js








var ArrowKeyStepper_class, ArrowKeyStepper_temp;

function ArrowKeyStepper_ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); keys.push.apply(keys, symbols); } return keys; }

function ArrowKeyStepper_objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { ArrowKeyStepper_ownKeys(source, true).forEach(function (key) { defineProperty_defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { ArrowKeyStepper_ownKeys(source).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }



/**
 * This HOC decorates a virtualized component and responds to arrow-key events by scrolling one row or column at a time.
 */

var ArrowKeyStepper = (ArrowKeyStepper_temp = ArrowKeyStepper_class =
/*#__PURE__*/
function (_React$PureComponent) {
  _inherits(ArrowKeyStepper, _React$PureComponent);

  function ArrowKeyStepper() {
    var _getPrototypeOf2;

    var _this;

    classCallCheck_classCallCheck(this, ArrowKeyStepper);

    for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
      args[_key] = arguments[_key];
    }

    _this = _possibleConstructorReturn(this, (_getPrototypeOf2 = _getPrototypeOf(ArrowKeyStepper)).call.apply(_getPrototypeOf2, [this].concat(args)));

    defineProperty_defineProperty(_assertThisInitialized(_this), "state", {
      scrollToColumn: 0,
      scrollToRow: 0,
      instanceProps: {
        prevScrollToColumn: 0,
        prevScrollToRow: 0
      }
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_columnStartIndex", 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_columnStopIndex", 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_rowStartIndex", 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_rowStopIndex", 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_onKeyDown", function (event) {
      var _this$props = _this.props,
          columnCount = _this$props.columnCount,
          disabled = _this$props.disabled,
          mode = _this$props.mode,
          rowCount = _this$props.rowCount;

      if (disabled) {
        return;
      }

      var _this$_getScrollState = _this._getScrollState(),
          scrollToColumnPrevious = _this$_getScrollState.scrollToColumn,
          scrollToRowPrevious = _this$_getScrollState.scrollToRow;

      var _this$_getScrollState2 = _this._getScrollState(),
          scrollToColumn = _this$_getScrollState2.scrollToColumn,
          scrollToRow = _this$_getScrollState2.scrollToRow; // The above cases all prevent default event event behavior.
      // This is to keep the grid from scrolling after the snap-to update.


      switch (event.key) {
        case 'ArrowDown':
          scrollToRow = mode === 'cells' ? Math.min(scrollToRow + 1, rowCount - 1) : Math.min(_this._rowStopIndex + 1, rowCount - 1);
          break;

        case 'ArrowLeft':
          scrollToColumn = mode === 'cells' ? Math.max(scrollToColumn - 1, 0) : Math.max(_this._columnStartIndex - 1, 0);
          break;

        case 'ArrowRight':
          scrollToColumn = mode === 'cells' ? Math.min(scrollToColumn + 1, columnCount - 1) : Math.min(_this._columnStopIndex + 1, columnCount - 1);
          break;

        case 'ArrowUp':
          scrollToRow = mode === 'cells' ? Math.max(scrollToRow - 1, 0) : Math.max(_this._rowStartIndex - 1, 0);
          break;
      }

      if (scrollToColumn !== scrollToColumnPrevious || scrollToRow !== scrollToRowPrevious) {
        event.preventDefault();

        _this._updateScrollState({
          scrollToColumn: scrollToColumn,
          scrollToRow: scrollToRow
        });
      }
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_onSectionRendered", function (_ref) {
      var columnStartIndex = _ref.columnStartIndex,
          columnStopIndex = _ref.columnStopIndex,
          rowStartIndex = _ref.rowStartIndex,
          rowStopIndex = _ref.rowStopIndex;
      _this._columnStartIndex = columnStartIndex;
      _this._columnStopIndex = columnStopIndex;
      _this._rowStartIndex = rowStartIndex;
      _this._rowStopIndex = rowStopIndex;
    });

    return _this;
  }

  createClass_createClass(ArrowKeyStepper, [{
    key: "setScrollIndexes",
    value: function setScrollIndexes(_ref2) {
      var scrollToColumn = _ref2.scrollToColumn,
          scrollToRow = _ref2.scrollToRow;
      this.setState({
        scrollToRow: scrollToRow,
        scrollToColumn: scrollToColumn
      });
    }
  }, {
    key: "render",
    value: function render() {
      var _this$props2 = this.props,
          className = _this$props2.className,
          children = _this$props2.children;

      var _this$_getScrollState3 = this._getScrollState(),
          scrollToColumn = _this$_getScrollState3.scrollToColumn,
          scrollToRow = _this$_getScrollState3.scrollToRow;

      return react.createElement("div", {
        className: className,
        onKeyDown: this._onKeyDown
      }, children({
        onSectionRendered: this._onSectionRendered,
        scrollToColumn: scrollToColumn,
        scrollToRow: scrollToRow
      }));
    }
  }, {
    key: "_getScrollState",
    value: function _getScrollState() {
      return this.props.isControlled ? this.props : this.state;
    }
  }, {
    key: "_updateScrollState",
    value: function _updateScrollState(_ref3) {
      var scrollToColumn = _ref3.scrollToColumn,
          scrollToRow = _ref3.scrollToRow;
      var _this$props3 = this.props,
          isControlled = _this$props3.isControlled,
          onScrollToChange = _this$props3.onScrollToChange;

      if (typeof onScrollToChange === 'function') {
        onScrollToChange({
          scrollToColumn: scrollToColumn,
          scrollToRow: scrollToRow
        });
      }

      if (!isControlled) {
        this.setState({
          scrollToColumn: scrollToColumn,
          scrollToRow: scrollToRow
        });
      }
    }
  }], [{
    key: "getDerivedStateFromProps",
    value: function getDerivedStateFromProps(nextProps, prevState) {
      if (nextProps.isControlled) {
        return {};
      }

      if (nextProps.scrollToColumn !== prevState.instanceProps.prevScrollToColumn || nextProps.scrollToRow !== prevState.instanceProps.prevScrollToRow) {
        return ArrowKeyStepper_objectSpread({}, prevState, {
          scrollToColumn: nextProps.scrollToColumn,
          scrollToRow: nextProps.scrollToRow,
          instanceProps: {
            prevScrollToColumn: nextProps.scrollToColumn,
            prevScrollToRow: nextProps.scrollToRow
          }
        });
      }

      return {};
    }
  }]);

  return ArrowKeyStepper;
}(react.PureComponent), defineProperty_defineProperty(ArrowKeyStepper_class, "propTypes",  true ? null : 0), ArrowKeyStepper_temp);

defineProperty_defineProperty(ArrowKeyStepper, "defaultProps", {
  disabled: false,
  isControlled: false,
  mode: 'edges',
  scrollToColumn: 0,
  scrollToRow: 0
});

react_lifecycles_compat_es_polyfill(ArrowKeyStepper);
/* harmony default export */ const ArrowKeyStepper_ArrowKeyStepper = ((/* unused pure expression or super */ null && (ArrowKeyStepper)));



;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/ArrowKeyStepper/index.js




;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/vendor/detectElementResize.js
/**
 * Detect Element Resize.
 * https://github.com/sdecima/javascript-detect-element-resize
 * Sebastian Decima
 *
 * Forked from version 0.5.3; includes the following modifications:
 * 1) Guard against unsafe 'window' and 'document' references (to support SSR).
 * 2) Defer initialization code via a top-level function wrapper (to support SSR).
 * 3) Avoid unnecessary reflows by not measuring size for scroll events bubbling from children.
 * 4) Add nonce for style element.
 * 5) Added support for injecting custom window object
 **/
function createDetectElementResize(nonce, hostWindow) {
  // Check `document` and `window` in case of server-side rendering
  var _window;

  if (typeof hostWindow !== 'undefined') {
    _window = hostWindow;
  } else if (typeof window !== 'undefined') {
    _window = window;
  } else if (typeof self !== 'undefined') {
    _window = self;
  } else {
    _window = __webpack_require__.g;
  }

  var attachEvent = typeof _window.document !== 'undefined' && _window.document.attachEvent;

  if (!attachEvent) {
    var requestFrame = function () {
      var raf = _window.requestAnimationFrame || _window.mozRequestAnimationFrame || _window.webkitRequestAnimationFrame || function (fn) {
        return _window.setTimeout(fn, 20);
      };

      return function (fn) {
        return raf(fn);
      };
    }();

    var cancelFrame = function () {
      var cancel = _window.cancelAnimationFrame || _window.mozCancelAnimationFrame || _window.webkitCancelAnimationFrame || _window.clearTimeout;
      return function (id) {
        return cancel(id);
      };
    }();

    var resetTriggers = function resetTriggers(element) {
      var triggers = element.__resizeTriggers__,
          expand = triggers.firstElementChild,
          contract = triggers.lastElementChild,
          expandChild = expand.firstElementChild;
      contract.scrollLeft = contract.scrollWidth;
      contract.scrollTop = contract.scrollHeight;
      expandChild.style.width = expand.offsetWidth + 1 + 'px';
      expandChild.style.height = expand.offsetHeight + 1 + 'px';
      expand.scrollLeft = expand.scrollWidth;
      expand.scrollTop = expand.scrollHeight;
    };

    var checkTriggers = function checkTriggers(element) {
      return element.offsetWidth != element.__resizeLast__.width || element.offsetHeight != element.__resizeLast__.height;
    };

    var scrollListener = function scrollListener(e) {
      // Don't measure (which forces) reflow for scrolls that happen inside of children!
      if (e.target.className && typeof e.target.className.indexOf === 'function' && e.target.className.indexOf('contract-trigger') < 0 && e.target.className.indexOf('expand-trigger') < 0) {
        return;
      }

      var element = this;
      resetTriggers(this);

      if (this.__resizeRAF__) {
        cancelFrame(this.__resizeRAF__);
      }

      this.__resizeRAF__ = requestFrame(function () {
        if (checkTriggers(element)) {
          element.__resizeLast__.width = element.offsetWidth;
          element.__resizeLast__.height = element.offsetHeight;

          element.__resizeListeners__.forEach(function (fn) {
            fn.call(element, e);
          });
        }
      });
    };
    /* Detect CSS Animations support to detect element display/re-attach */


    var animation = false,
        keyframeprefix = '',
        animationstartevent = 'animationstart',
        domPrefixes = 'Webkit Moz O ms'.split(' '),
        startEvents = 'webkitAnimationStart animationstart oAnimationStart MSAnimationStart'.split(' '),
        pfx = '';
    {
      var elm = _window.document.createElement('fakeelement');

      if (elm.style.animationName !== undefined) {
        animation = true;
      }

      if (animation === false) {
        for (var i = 0; i < domPrefixes.length; i++) {
          if (elm.style[domPrefixes[i] + 'AnimationName'] !== undefined) {
            pfx = domPrefixes[i];
            keyframeprefix = '-' + pfx.toLowerCase() + '-';
            animationstartevent = startEvents[i];
            animation = true;
            break;
          }
        }
      }
    }
    var animationName = 'resizeanim';
    var animationKeyframes = '@' + keyframeprefix + 'keyframes ' + animationName + ' { from { opacity: 0; } to { opacity: 0; } } ';
    var animationStyle = keyframeprefix + 'animation: 1ms ' + animationName + '; ';
  }

  var createStyles = function createStyles(doc) {
    if (!doc.getElementById('detectElementResize')) {
      //opacity:0 works around a chrome bug https://code.google.com/p/chromium/issues/detail?id=286360
      var css = (animationKeyframes ? animationKeyframes : '') + '.resize-triggers { ' + (animationStyle ? animationStyle : '') + 'visibility: hidden; opacity: 0; } ' + '.resize-triggers, .resize-triggers > div, .contract-trigger:before { content: " "; display: block; position: absolute; top: 0; left: 0; height: 100%; width: 100%; overflow: hidden; z-index: -1; } .resize-triggers > div { background: #eee; overflow: auto; } .contract-trigger:before { width: 200%; height: 200%; }',
          head = doc.head || doc.getElementsByTagName('head')[0],
          style = doc.createElement('style');
      style.id = 'detectElementResize';
      style.type = 'text/css';

      if (nonce != null) {
        style.setAttribute('nonce', nonce);
      }

      if (style.styleSheet) {
        style.styleSheet.cssText = css;
      } else {
        style.appendChild(doc.createTextNode(css));
      }

      head.appendChild(style);
    }
  };

  var addResizeListener = function addResizeListener(element, fn) {
    if (attachEvent) {
      element.attachEvent('onresize', fn);
    } else {
      if (!element.__resizeTriggers__) {
        var doc = element.ownerDocument;

        var elementStyle = _window.getComputedStyle(element);

        if (elementStyle && elementStyle.position == 'static') {
          element.style.position = 'relative';
        }

        createStyles(doc);
        element.__resizeLast__ = {};
        element.__resizeListeners__ = [];
        (element.__resizeTriggers__ = doc.createElement('div')).className = 'resize-triggers';
        var resizeTriggersHtml = '<div class="expand-trigger"><div></div></div>' + '<div class="contract-trigger"></div>';

        if (window.trustedTypes) {
          var staticPolicy = trustedTypes.createPolicy('react-virtualized-auto-sizer', {
            createHTML: function createHTML() {
              return resizeTriggersHtml;
            }
          });
          element.__resizeTriggers__.innerHTML = staticPolicy.createHTML('');
        } else {
          element.__resizeTriggers__.innerHTML = resizeTriggersHtml;
        }

        element.appendChild(element.__resizeTriggers__);
        resetTriggers(element);
        element.addEventListener('scroll', scrollListener, true);
        /* Listen for a css animation to detect element display/re-attach */

        if (animationstartevent) {
          element.__resizeTriggers__.__animationListener__ = function animationListener(e) {
            if (e.animationName == animationName) {
              resetTriggers(element);
            }
          };

          element.__resizeTriggers__.addEventListener(animationstartevent, element.__resizeTriggers__.__animationListener__);
        }
      }

      element.__resizeListeners__.push(fn);
    }
  };

  var removeResizeListener = function removeResizeListener(element, fn) {
    if (attachEvent) {
      element.detachEvent('onresize', fn);
    } else {
      element.__resizeListeners__.splice(element.__resizeListeners__.indexOf(fn), 1);

      if (!element.__resizeListeners__.length) {
        element.removeEventListener('scroll', scrollListener, true);

        if (element.__resizeTriggers__.__animationListener__) {
          element.__resizeTriggers__.removeEventListener(animationstartevent, element.__resizeTriggers__.__animationListener__);

          element.__resizeTriggers__.__animationListener__ = null;
        }

        try {
          element.__resizeTriggers__ = !element.removeChild(element.__resizeTriggers__);
        } catch (e) {// Preact compat; see developit/preact-compat/issues/228
        }
      }
    }
  };

  return {
    addResizeListener: addResizeListener,
    removeResizeListener: removeResizeListener
  };
}
;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/AutoSizer/AutoSizer.js








var AutoSizer_class, AutoSizer_temp;

function AutoSizer_ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); keys.push.apply(keys, symbols); } return keys; }

function AutoSizer_objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { AutoSizer_ownKeys(source, true).forEach(function (key) { defineProperty_defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { AutoSizer_ownKeys(source).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }



var AutoSizer = (AutoSizer_temp = AutoSizer_class =
/*#__PURE__*/
function (_React$Component) {
  _inherits(AutoSizer, _React$Component);

  function AutoSizer() {
    var _getPrototypeOf2;

    var _this;

    classCallCheck_classCallCheck(this, AutoSizer);

    for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
      args[_key] = arguments[_key];
    }

    _this = _possibleConstructorReturn(this, (_getPrototypeOf2 = _getPrototypeOf(AutoSizer)).call.apply(_getPrototypeOf2, [this].concat(args)));

    defineProperty_defineProperty(_assertThisInitialized(_this), "state", {
      height: _this.props.defaultHeight || 0,
      width: _this.props.defaultWidth || 0
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_parentNode", void 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_autoSizer", void 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_window", void 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_detectElementResize", void 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_onResize", function () {
      var _this$props = _this.props,
          disableHeight = _this$props.disableHeight,
          disableWidth = _this$props.disableWidth,
          onResize = _this$props.onResize;

      if (_this._parentNode) {
        // Guard against AutoSizer component being removed from the DOM immediately after being added.
        // This can result in invalid style values which can result in NaN values if we don't handle them.
        // See issue #150 for more context.
        var height = _this._parentNode.offsetHeight || 0;
        var width = _this._parentNode.offsetWidth || 0;
        var win = _this._window || window;
        var style = win.getComputedStyle(_this._parentNode) || {};
        var paddingLeft = parseInt(style.paddingLeft, 10) || 0;
        var paddingRight = parseInt(style.paddingRight, 10) || 0;
        var paddingTop = parseInt(style.paddingTop, 10) || 0;
        var paddingBottom = parseInt(style.paddingBottom, 10) || 0;
        var newHeight = height - paddingTop - paddingBottom;
        var newWidth = width - paddingLeft - paddingRight;

        if (!disableHeight && _this.state.height !== newHeight || !disableWidth && _this.state.width !== newWidth) {
          _this.setState({
            height: height - paddingTop - paddingBottom,
            width: width - paddingLeft - paddingRight
          });

          onResize({
            height: height,
            width: width
          });
        }
      }
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_setRef", function (autoSizer) {
      _this._autoSizer = autoSizer;
    });

    return _this;
  }

  createClass_createClass(AutoSizer, [{
    key: "componentDidMount",
    value: function componentDidMount() {
      var nonce = this.props.nonce;

      if (this._autoSizer && this._autoSizer.parentNode && this._autoSizer.parentNode.ownerDocument && this._autoSizer.parentNode.ownerDocument.defaultView && this._autoSizer.parentNode instanceof this._autoSizer.parentNode.ownerDocument.defaultView.HTMLElement) {
        // Delay access of parentNode until mount.
        // This handles edge-cases where the component has already been unmounted before its ref has been set,
        // As well as libraries like react-lite which have a slightly different lifecycle.
        this._parentNode = this._autoSizer.parentNode;
        this._window = this._autoSizer.parentNode.ownerDocument.defaultView; // Defer requiring resize handler in order to support server-side rendering.
        // See issue #41

        this._detectElementResize = createDetectElementResize(nonce, this._window);

        this._detectElementResize.addResizeListener(this._parentNode, this._onResize);

        this._onResize();
      }
    }
  }, {
    key: "componentWillUnmount",
    value: function componentWillUnmount() {
      if (this._detectElementResize && this._parentNode) {
        this._detectElementResize.removeResizeListener(this._parentNode, this._onResize);
      }
    }
  }, {
    key: "render",
    value: function render() {
      var _this$props2 = this.props,
          children = _this$props2.children,
          className = _this$props2.className,
          disableHeight = _this$props2.disableHeight,
          disableWidth = _this$props2.disableWidth,
          style = _this$props2.style;
      var _this$state = this.state,
          height = _this$state.height,
          width = _this$state.width; // Outer div should not force width/height since that may prevent containers from shrinking.
      // Inner component should overflow and use calculated width/height.
      // See issue #68 for more information.

      var outerStyle = {
        overflow: 'visible'
      };
      var childParams = {};

      if (!disableHeight) {
        outerStyle.height = 0;
        childParams.height = height;
      }

      if (!disableWidth) {
        outerStyle.width = 0;
        childParams.width = width;
      }
      /**
       * TODO: Avoid rendering children before the initial measurements have been collected.
       * At best this would just be wasting cycles.
       * Add this check into version 10 though as it could break too many ref callbacks in version 9.
       * Note that if default width/height props were provided this would still work with SSR.
      if (
        height !== 0 &&
        width !== 0
      ) {
        child = children({ height, width })
      }
      */


      return react.createElement("div", {
        className: className,
        ref: this._setRef,
        style: AutoSizer_objectSpread({}, outerStyle, {}, style)
      }, children(childParams));
    }
  }]);

  return AutoSizer;
}(react.Component), defineProperty_defineProperty(AutoSizer_class, "propTypes",  true ? null : 0), AutoSizer_temp);

defineProperty_defineProperty(AutoSizer, "defaultProps", {
  onResize: function onResize() {},
  disableHeight: false,
  disableWidth: false,
  style: {}
});



;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/AutoSizer/index.js


// EXTERNAL MODULE: ./node_modules/react-dom/index.js
var react_dom = __webpack_require__(961);
;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/CellMeasurer/types.js
var bpfrpt_proptype_CellMeasureCache =  true ? null : 0;


;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/CellMeasurer/CellMeasurer.js








var CellMeasurer_class, CellMeasurer_temp;




/**
 * Wraps a cell and measures its rendered content.
 * Measurements are stored in a per-cell cache.
 * Cached-content is not be re-measured.
 */
var CellMeasurer_CellMeasurer = (CellMeasurer_temp = CellMeasurer_class =
/*#__PURE__*/
function (_React$PureComponent) {
  _inherits(CellMeasurer, _React$PureComponent);

  function CellMeasurer() {
    var _getPrototypeOf2;

    var _this;

    classCallCheck_classCallCheck(this, CellMeasurer);

    for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
      args[_key] = arguments[_key];
    }

    _this = _possibleConstructorReturn(this, (_getPrototypeOf2 = _getPrototypeOf(CellMeasurer)).call.apply(_getPrototypeOf2, [this].concat(args)));

    defineProperty_defineProperty(_assertThisInitialized(_this), "_child", void 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_measure", function () {
      var _this$props = _this.props,
          cache = _this$props.cache,
          _this$props$columnInd = _this$props.columnIndex,
          columnIndex = _this$props$columnInd === void 0 ? 0 : _this$props$columnInd,
          parent = _this$props.parent,
          _this$props$rowIndex = _this$props.rowIndex,
          rowIndex = _this$props$rowIndex === void 0 ? _this.props.index || 0 : _this$props$rowIndex;

      var _this$_getCellMeasure = _this._getCellMeasurements(),
          height = _this$_getCellMeasure.height,
          width = _this$_getCellMeasure.width;

      if (height !== cache.getHeight(rowIndex, columnIndex) || width !== cache.getWidth(rowIndex, columnIndex)) {
        cache.set(rowIndex, columnIndex, width, height);

        if (parent && typeof parent.recomputeGridSize === 'function') {
          parent.recomputeGridSize({
            columnIndex: columnIndex,
            rowIndex: rowIndex
          });
        }
      }
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_registerChild", function (element) {
      if (element && !(element instanceof Element)) {
        console.warn('CellMeasurer registerChild expects to be passed Element or null');
      }

      _this._child = element;

      if (element) {
        _this._maybeMeasureCell();
      }
    });

    return _this;
  }

  createClass_createClass(CellMeasurer, [{
    key: "componentDidMount",
    value: function componentDidMount() {
      this._maybeMeasureCell();
    }
  }, {
    key: "componentDidUpdate",
    value: function componentDidUpdate() {
      this._maybeMeasureCell();
    }
  }, {
    key: "render",
    value: function render() {
      var children = this.props.children;
      return typeof children === 'function' ? children({
        measure: this._measure,
        registerChild: this._registerChild
      }) : children;
    }
  }, {
    key: "_getCellMeasurements",
    value: function _getCellMeasurements() {
      var cache = this.props.cache;
      var node = this._child || (0,react_dom.findDOMNode)(this); // TODO Check for a bad combination of fixedWidth and missing numeric width or vice versa with height

      if (node && node.ownerDocument && node.ownerDocument.defaultView && node instanceof node.ownerDocument.defaultView.HTMLElement) {
        var styleWidth = node.style.width;
        var styleHeight = node.style.height; // If we are re-measuring a cell that has already been measured,
        // It will have a hard-coded width/height from the previous measurement.
        // The fact that we are measuring indicates this measurement is probably stale,
        // So explicitly clear it out (eg set to "auto") so we can recalculate.
        // See issue #593 for more info.
        // Even if we are measuring initially- if we're inside of a MultiGrid component,
        // Explicitly clear width/height before measuring to avoid being tainted by another Grid.
        // eg top/left Grid renders before bottom/right Grid
        // Since the CellMeasurerCache is shared between them this taints derived cell size values.

        if (!cache.hasFixedWidth()) {
          node.style.width = 'auto';
        }

        if (!cache.hasFixedHeight()) {
          node.style.height = 'auto';
        }

        var height = Math.ceil(node.offsetHeight);
        var width = Math.ceil(node.offsetWidth); // Reset after measuring to avoid breaking styles; see #660

        if (styleWidth) {
          node.style.width = styleWidth;
        }

        if (styleHeight) {
          node.style.height = styleHeight;
        }

        return {
          height: height,
          width: width
        };
      } else {
        return {
          height: 0,
          width: 0
        };
      }
    }
  }, {
    key: "_maybeMeasureCell",
    value: function _maybeMeasureCell() {
      var _this$props2 = this.props,
          cache = _this$props2.cache,
          _this$props2$columnIn = _this$props2.columnIndex,
          columnIndex = _this$props2$columnIn === void 0 ? 0 : _this$props2$columnIn,
          parent = _this$props2.parent,
          _this$props2$rowIndex = _this$props2.rowIndex,
          rowIndex = _this$props2$rowIndex === void 0 ? this.props.index || 0 : _this$props2$rowIndex;

      if (!cache.has(rowIndex, columnIndex)) {
        var _this$_getCellMeasure2 = this._getCellMeasurements(),
            height = _this$_getCellMeasure2.height,
            width = _this$_getCellMeasure2.width;

        cache.set(rowIndex, columnIndex, width, height); // If size has changed, let Grid know to re-render.

        if (parent && typeof parent.invalidateCellSizeAfterRender === 'function') {
          parent.invalidateCellSizeAfterRender({
            columnIndex: columnIndex,
            rowIndex: rowIndex
          });
        }
      }
    }
  }]);

  return CellMeasurer;
}(react.PureComponent), defineProperty_defineProperty(CellMeasurer_class, "propTypes",  true ? null : 0), CellMeasurer_temp); // Used for DEV mode warning check

defineProperty_defineProperty(CellMeasurer_CellMeasurer, "__internalCellMeasurerFlag", false);



if (false) {}



;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/CellMeasurer/CellMeasurerCache.js



var DEFAULT_HEIGHT = 30;
var DEFAULT_WIDTH = 100; // Enables more intelligent mapping of a given column and row index to an item ID.
// This prevents a cell cache from being invalidated when its parent collection is modified.

/**
 * Caches measurements for a given cell.
 */
var CellMeasurerCache =
/*#__PURE__*/
(/* unused pure expression or super */ null && (function () {
  function CellMeasurerCache() {
    var _this = this;

    var params = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

    _classCallCheck(this, CellMeasurerCache);

    _defineProperty(this, "_cellHeightCache", {});

    _defineProperty(this, "_cellWidthCache", {});

    _defineProperty(this, "_columnWidthCache", {});

    _defineProperty(this, "_rowHeightCache", {});

    _defineProperty(this, "_defaultHeight", void 0);

    _defineProperty(this, "_defaultWidth", void 0);

    _defineProperty(this, "_minHeight", void 0);

    _defineProperty(this, "_minWidth", void 0);

    _defineProperty(this, "_keyMapper", void 0);

    _defineProperty(this, "_hasFixedHeight", void 0);

    _defineProperty(this, "_hasFixedWidth", void 0);

    _defineProperty(this, "_columnCount", 0);

    _defineProperty(this, "_rowCount", 0);

    _defineProperty(this, "columnWidth", function (_ref) {
      var index = _ref.index;

      var key = _this._keyMapper(0, index);

      return _this._columnWidthCache[key] !== undefined ? _this._columnWidthCache[key] : _this._defaultWidth;
    });

    _defineProperty(this, "rowHeight", function (_ref2) {
      var index = _ref2.index;

      var key = _this._keyMapper(index, 0);

      return _this._rowHeightCache[key] !== undefined ? _this._rowHeightCache[key] : _this._defaultHeight;
    });

    var defaultHeight = params.defaultHeight,
        defaultWidth = params.defaultWidth,
        fixedHeight = params.fixedHeight,
        fixedWidth = params.fixedWidth,
        keyMapper = params.keyMapper,
        minHeight = params.minHeight,
        minWidth = params.minWidth;
    this._hasFixedHeight = fixedHeight === true;
    this._hasFixedWidth = fixedWidth === true;
    this._minHeight = minHeight || 0;
    this._minWidth = minWidth || 0;
    this._keyMapper = keyMapper || defaultKeyMapper;
    this._defaultHeight = Math.max(this._minHeight, typeof defaultHeight === 'number' ? defaultHeight : DEFAULT_HEIGHT);
    this._defaultWidth = Math.max(this._minWidth, typeof defaultWidth === 'number' ? defaultWidth : DEFAULT_WIDTH);

    if (false) {}
  }

  _createClass(CellMeasurerCache, [{
    key: "clear",
    value: function clear(rowIndex) {
      var columnIndex = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 0;

      var key = this._keyMapper(rowIndex, columnIndex);

      delete this._cellHeightCache[key];
      delete this._cellWidthCache[key];

      this._updateCachedColumnAndRowSizes(rowIndex, columnIndex);
    }
  }, {
    key: "clearAll",
    value: function clearAll() {
      this._cellHeightCache = {};
      this._cellWidthCache = {};
      this._columnWidthCache = {};
      this._rowHeightCache = {};
      this._rowCount = 0;
      this._columnCount = 0;
    }
  }, {
    key: "hasFixedHeight",
    value: function hasFixedHeight() {
      return this._hasFixedHeight;
    }
  }, {
    key: "hasFixedWidth",
    value: function hasFixedWidth() {
      return this._hasFixedWidth;
    }
  }, {
    key: "getHeight",
    value: function getHeight(rowIndex) {
      var columnIndex = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 0;

      if (this._hasFixedHeight) {
        return this._defaultHeight;
      } else {
        var _key = this._keyMapper(rowIndex, columnIndex);

        return this._cellHeightCache[_key] !== undefined ? Math.max(this._minHeight, this._cellHeightCache[_key]) : this._defaultHeight;
      }
    }
  }, {
    key: "getWidth",
    value: function getWidth(rowIndex) {
      var columnIndex = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 0;

      if (this._hasFixedWidth) {
        return this._defaultWidth;
      } else {
        var _key2 = this._keyMapper(rowIndex, columnIndex);

        return this._cellWidthCache[_key2] !== undefined ? Math.max(this._minWidth, this._cellWidthCache[_key2]) : this._defaultWidth;
      }
    }
  }, {
    key: "has",
    value: function has(rowIndex) {
      var columnIndex = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 0;

      var key = this._keyMapper(rowIndex, columnIndex);

      return this._cellHeightCache[key] !== undefined;
    }
  }, {
    key: "set",
    value: function set(rowIndex, columnIndex, width, height) {
      var key = this._keyMapper(rowIndex, columnIndex);

      if (columnIndex >= this._columnCount) {
        this._columnCount = columnIndex + 1;
      }

      if (rowIndex >= this._rowCount) {
        this._rowCount = rowIndex + 1;
      } // Size is cached per cell so we don't have to re-measure if cells are re-ordered.


      this._cellHeightCache[key] = height;
      this._cellWidthCache[key] = width;

      this._updateCachedColumnAndRowSizes(rowIndex, columnIndex);
    }
  }, {
    key: "_updateCachedColumnAndRowSizes",
    value: function _updateCachedColumnAndRowSizes(rowIndex, columnIndex) {
      // :columnWidth and :rowHeight are derived based on all cells in a column/row.
      // Pre-cache these derived values for faster lookup later.
      // Reads are expected to occur more frequently than writes in this case.
      // Only update non-fixed dimensions though to avoid doing unnecessary work.
      if (!this._hasFixedWidth) {
        var columnWidth = 0;

        for (var i = 0; i < this._rowCount; i++) {
          columnWidth = Math.max(columnWidth, this.getWidth(i, columnIndex));
        }

        var columnKey = this._keyMapper(0, columnIndex);

        this._columnWidthCache[columnKey] = columnWidth;
      }

      if (!this._hasFixedHeight) {
        var rowHeight = 0;

        for (var _i = 0; _i < this._columnCount; _i++) {
          rowHeight = Math.max(rowHeight, this.getHeight(rowIndex, _i));
        }

        var rowKey = this._keyMapper(rowIndex, 0);

        this._rowHeightCache[rowKey] = rowHeight;
      }
    }
  }, {
    key: "defaultHeight",
    get: function get() {
      return this._defaultHeight;
    }
  }, {
    key: "defaultWidth",
    get: function get() {
      return this._defaultWidth;
    }
  }]);

  return CellMeasurerCache;
}()));



function defaultKeyMapper(rowIndex, columnIndex) {
  return "".concat(rowIndex, "-").concat(columnIndex);
}


;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/CellMeasurer/index.js


/* harmony default export */ const es_CellMeasurer = ((/* unused pure expression or super */ null && (CellMeasurer)));

;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Collection/CollectionView.js








function CollectionView_ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); keys.push.apply(keys, symbols); } return keys; }

function CollectionView_objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { CollectionView_ownKeys(source, true).forEach(function (key) { defineProperty_defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { CollectionView_ownKeys(source).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }






 // @TODO Merge Collection and CollectionView

/**
 * Specifies the number of milliseconds during which to disable pointer events while a scroll is in progress.
 * This improves performance and makes scrolling smoother.
 */

var IS_SCROLLING_TIMEOUT = 150;
/**
 * Controls whether the Grid updates the DOM element's scrollLeft/scrollTop based on the current state or just observes it.
 * This prevents Grid from interrupting mouse-wheel animations (see issue #2).
 */

var CollectionView_SCROLL_POSITION_CHANGE_REASONS = {
  OBSERVED: 'observed',
  REQUESTED: 'requested'
};
/**
 * Monitors changes in properties (eg. cellCount) and state (eg. scroll offsets) to determine when rendering needs to occur.
 * This component does not render any visible content itself; it defers to the specified :cellLayoutManager.
 */

var CollectionView =
/*#__PURE__*/
function (_React$PureComponent) {
  _inherits(CollectionView, _React$PureComponent);

  // Invokes callbacks only when their values have changed.
  function CollectionView() {
    var _getPrototypeOf2;

    var _this;

    classCallCheck_classCallCheck(this, CollectionView);

    for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
      args[_key] = arguments[_key];
    }

    _this = _possibleConstructorReturn(this, (_getPrototypeOf2 = _getPrototypeOf(CollectionView)).call.apply(_getPrototypeOf2, [this].concat(args))); // If this component is being rendered server-side, getScrollbarSize() will return undefined.
    // We handle this case in componentDidMount()

    defineProperty_defineProperty(_assertThisInitialized(_this), "state", {
      isScrolling: false,
      scrollLeft: 0,
      scrollTop: 0
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_calculateSizeAndPositionDataOnNextUpdate", false);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_onSectionRenderedMemoizer", createCallbackMemoizer());

    defineProperty_defineProperty(_assertThisInitialized(_this), "_onScrollMemoizer", createCallbackMemoizer(false));

    defineProperty_defineProperty(_assertThisInitialized(_this), "_invokeOnSectionRenderedHelper", function () {
      var _this$props = _this.props,
          cellLayoutManager = _this$props.cellLayoutManager,
          onSectionRendered = _this$props.onSectionRendered;

      _this._onSectionRenderedMemoizer({
        callback: onSectionRendered,
        indices: {
          indices: cellLayoutManager.getLastRenderedIndices()
        }
      });
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_setScrollingContainerRef", function (ref) {
      _this._scrollingContainer = ref;
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_updateScrollPositionForScrollToCell", function () {
      var _this$props2 = _this.props,
          cellLayoutManager = _this$props2.cellLayoutManager,
          height = _this$props2.height,
          scrollToAlignment = _this$props2.scrollToAlignment,
          scrollToCell = _this$props2.scrollToCell,
          width = _this$props2.width;
      var _this$state = _this.state,
          scrollLeft = _this$state.scrollLeft,
          scrollTop = _this$state.scrollTop;

      if (scrollToCell >= 0) {
        var scrollPosition = cellLayoutManager.getScrollPositionForCell({
          align: scrollToAlignment,
          cellIndex: scrollToCell,
          height: height,
          scrollLeft: scrollLeft,
          scrollTop: scrollTop,
          width: width
        });

        if (scrollPosition.scrollLeft !== scrollLeft || scrollPosition.scrollTop !== scrollTop) {
          _this._setScrollPosition(scrollPosition);
        }
      }
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_onScroll", function (event) {
      // In certain edge-cases React dispatches an onScroll event with an invalid target.scrollLeft / target.scrollTop.
      // This invalid event can be detected by comparing event.target to this component's scrollable DOM element.
      // See issue #404 for more information.
      if (event.target !== _this._scrollingContainer) {
        return;
      } // Prevent pointer events from interrupting a smooth scroll


      _this._enablePointerEventsAfterDelay(); // When this component is shrunk drastically, React dispatches a series of back-to-back scroll events,
      // Gradually converging on a scrollTop that is within the bounds of the new, smaller height.
      // This causes a series of rapid renders that is slow for long lists.
      // We can avoid that by doing some simple bounds checking to ensure that scrollTop never exceeds the total height.


      var _this$props3 = _this.props,
          cellLayoutManager = _this$props3.cellLayoutManager,
          height = _this$props3.height,
          isScrollingChange = _this$props3.isScrollingChange,
          width = _this$props3.width;
      var scrollbarSize = _this._scrollbarSize;

      var _cellLayoutManager$ge = cellLayoutManager.getTotalSize(),
          totalHeight = _cellLayoutManager$ge.height,
          totalWidth = _cellLayoutManager$ge.width;

      var scrollLeft = Math.max(0, Math.min(totalWidth - width + scrollbarSize, event.target.scrollLeft));
      var scrollTop = Math.max(0, Math.min(totalHeight - height + scrollbarSize, event.target.scrollTop)); // Certain devices (like Apple touchpad) rapid-fire duplicate events.
      // Don't force a re-render if this is the case.
      // The mouse may move faster then the animation frame does.
      // Use requestAnimationFrame to avoid over-updating.

      if (_this.state.scrollLeft !== scrollLeft || _this.state.scrollTop !== scrollTop) {
        // Browsers with cancelable scroll events (eg. Firefox) interrupt scrolling animations if scrollTop/scrollLeft is set.
        // Other browsers (eg. Safari) don't scroll as well without the help under certain conditions (DOM or style changes during scrolling).
        // All things considered, this seems to be the best current work around that I'm aware of.
        // For more information see https://github.com/bvaughn/react-virtualized/pull/124
        var scrollPositionChangeReason = event.cancelable ? CollectionView_SCROLL_POSITION_CHANGE_REASONS.OBSERVED : CollectionView_SCROLL_POSITION_CHANGE_REASONS.REQUESTED; // Synchronously set :isScrolling the first time (since _setNextState will reschedule its animation frame each time it's called)

        if (!_this.state.isScrolling) {
          isScrollingChange(true);
        }

        _this.setState({
          isScrolling: true,
          scrollLeft: scrollLeft,
          scrollPositionChangeReason: scrollPositionChangeReason,
          scrollTop: scrollTop
        });
      }

      _this._invokeOnScrollMemoizer({
        scrollLeft: scrollLeft,
        scrollTop: scrollTop,
        totalWidth: totalWidth,
        totalHeight: totalHeight
      });
    });

    _this._scrollbarSize = scrollbarSize();

    if (_this._scrollbarSize === undefined) {
      _this._scrollbarSizeMeasured = false;
      _this._scrollbarSize = 0;
    } else {
      _this._scrollbarSizeMeasured = true;
    }

    return _this;
  }
  /**
   * Forced recompute of cell sizes and positions.
   * This function should be called if cell sizes have changed but nothing else has.
   * Since cell positions are calculated by callbacks, the collection view has no way of detecting when the underlying data has changed.
   */


  createClass_createClass(CollectionView, [{
    key: "recomputeCellSizesAndPositions",
    value: function recomputeCellSizesAndPositions() {
      this._calculateSizeAndPositionDataOnNextUpdate = true;
      this.forceUpdate();
    }
    /* ---------------------------- Component lifecycle methods ---------------------------- */

    /**
     * @private
     * This method updates scrollLeft/scrollTop in state for the following conditions:
     * 1) Empty content (0 rows or columns)
     * 2) New scroll props overriding the current state
     * 3) Cells-count or cells-size has changed, making previous scroll offsets invalid
     */

  }, {
    key: "componentDidMount",
    value: function componentDidMount() {
      var _this$props4 = this.props,
          cellLayoutManager = _this$props4.cellLayoutManager,
          scrollLeft = _this$props4.scrollLeft,
          scrollToCell = _this$props4.scrollToCell,
          scrollTop = _this$props4.scrollTop; // If this component was first rendered server-side, scrollbar size will be undefined.
      // In that event we need to remeasure.

      if (!this._scrollbarSizeMeasured) {
        this._scrollbarSize = scrollbarSize();
        this._scrollbarSizeMeasured = true;
        this.setState({});
      }

      if (scrollToCell >= 0) {
        this._updateScrollPositionForScrollToCell();
      } else if (scrollLeft >= 0 || scrollTop >= 0) {
        this._setScrollPosition({
          scrollLeft: scrollLeft,
          scrollTop: scrollTop
        });
      } // Update onSectionRendered callback.


      this._invokeOnSectionRenderedHelper();

      var _cellLayoutManager$ge2 = cellLayoutManager.getTotalSize(),
          totalHeight = _cellLayoutManager$ge2.height,
          totalWidth = _cellLayoutManager$ge2.width; // Initialize onScroll callback.


      this._invokeOnScrollMemoizer({
        scrollLeft: scrollLeft || 0,
        scrollTop: scrollTop || 0,
        totalHeight: totalHeight,
        totalWidth: totalWidth
      });
    }
  }, {
    key: "componentDidUpdate",
    value: function componentDidUpdate(prevProps, prevState) {
      var _this$props5 = this.props,
          height = _this$props5.height,
          scrollToAlignment = _this$props5.scrollToAlignment,
          scrollToCell = _this$props5.scrollToCell,
          width = _this$props5.width;
      var _this$state2 = this.state,
          scrollLeft = _this$state2.scrollLeft,
          scrollPositionChangeReason = _this$state2.scrollPositionChangeReason,
          scrollTop = _this$state2.scrollTop; // Make sure requested changes to :scrollLeft or :scrollTop get applied.
      // Assigning to scrollLeft/scrollTop tells the browser to interrupt any running scroll animations,
      // And to discard any pending async changes to the scroll position that may have happened in the meantime (e.g. on a separate scrolling thread).
      // So we only set these when we require an adjustment of the scroll position.
      // See issue #2 for more information.

      if (scrollPositionChangeReason === CollectionView_SCROLL_POSITION_CHANGE_REASONS.REQUESTED) {
        if (scrollLeft >= 0 && scrollLeft !== prevState.scrollLeft && scrollLeft !== this._scrollingContainer.scrollLeft) {
          this._scrollingContainer.scrollLeft = scrollLeft;
        }

        if (scrollTop >= 0 && scrollTop !== prevState.scrollTop && scrollTop !== this._scrollingContainer.scrollTop) {
          this._scrollingContainer.scrollTop = scrollTop;
        }
      } // Update scroll offsets if the current :scrollToCell values requires it


      if (height !== prevProps.height || scrollToAlignment !== prevProps.scrollToAlignment || scrollToCell !== prevProps.scrollToCell || width !== prevProps.width) {
        this._updateScrollPositionForScrollToCell();
      } // Update onRowsRendered callback if start/stop indices have changed


      this._invokeOnSectionRenderedHelper();
    }
  }, {
    key: "componentWillUnmount",
    value: function componentWillUnmount() {
      if (this._disablePointerEventsTimeoutId) {
        clearTimeout(this._disablePointerEventsTimeoutId);
      }
    }
  }, {
    key: "render",
    value: function render() {
      var _this$props6 = this.props,
          autoHeight = _this$props6.autoHeight,
          cellCount = _this$props6.cellCount,
          cellLayoutManager = _this$props6.cellLayoutManager,
          className = _this$props6.className,
          height = _this$props6.height,
          horizontalOverscanSize = _this$props6.horizontalOverscanSize,
          id = _this$props6.id,
          noContentRenderer = _this$props6.noContentRenderer,
          style = _this$props6.style,
          verticalOverscanSize = _this$props6.verticalOverscanSize,
          width = _this$props6.width;
      var _this$state3 = this.state,
          isScrolling = _this$state3.isScrolling,
          scrollLeft = _this$state3.scrollLeft,
          scrollTop = _this$state3.scrollTop; // Memoization reset

      if (this._lastRenderedCellCount !== cellCount || this._lastRenderedCellLayoutManager !== cellLayoutManager || this._calculateSizeAndPositionDataOnNextUpdate) {
        this._lastRenderedCellCount = cellCount;
        this._lastRenderedCellLayoutManager = cellLayoutManager;
        this._calculateSizeAndPositionDataOnNextUpdate = false;
        cellLayoutManager.calculateSizeAndPositionData();
      }

      var _cellLayoutManager$ge3 = cellLayoutManager.getTotalSize(),
          totalHeight = _cellLayoutManager$ge3.height,
          totalWidth = _cellLayoutManager$ge3.width; // Safely expand the rendered area by the specified overscan amount


      var left = Math.max(0, scrollLeft - horizontalOverscanSize);
      var top = Math.max(0, scrollTop - verticalOverscanSize);
      var right = Math.min(totalWidth, scrollLeft + width + horizontalOverscanSize);
      var bottom = Math.min(totalHeight, scrollTop + height + verticalOverscanSize);
      var childrenToDisplay = height > 0 && width > 0 ? cellLayoutManager.cellRenderers({
        height: bottom - top,
        isScrolling: isScrolling,
        width: right - left,
        x: left,
        y: top
      }) : [];
      var collectionStyle = {
        boxSizing: 'border-box',
        direction: 'ltr',
        height: autoHeight ? 'auto' : height,
        position: 'relative',
        WebkitOverflowScrolling: 'touch',
        width: width,
        willChange: 'transform'
      }; // Force browser to hide scrollbars when we know they aren't necessary.
      // Otherwise once scrollbars appear they may not disappear again.
      // For more info see issue #116

      var verticalScrollBarSize = totalHeight > height ? this._scrollbarSize : 0;
      var horizontalScrollBarSize = totalWidth > width ? this._scrollbarSize : 0; // Also explicitly init styles to 'auto' if scrollbars are required.
      // This works around an obscure edge case where external CSS styles have not yet been loaded,
      // But an initial scroll index of offset is set as an external prop.
      // Without this style, Grid would render the correct range of cells but would NOT update its internal offset.
      // This was originally reported via clauderic/react-infinite-calendar/issues/23

      collectionStyle.overflowX = totalWidth + verticalScrollBarSize <= width ? 'hidden' : 'auto';
      collectionStyle.overflowY = totalHeight + horizontalScrollBarSize <= height ? 'hidden' : 'auto';
      return react.createElement("div", {
        ref: this._setScrollingContainerRef,
        "aria-label": this.props['aria-label'],
        className: clsx_m('ReactVirtualized__Collection', className),
        id: id,
        onScroll: this._onScroll,
        role: "grid",
        style: CollectionView_objectSpread({}, collectionStyle, {}, style),
        tabIndex: 0
      }, cellCount > 0 && react.createElement("div", {
        className: "ReactVirtualized__Collection__innerScrollContainer",
        style: {
          height: totalHeight,
          maxHeight: totalHeight,
          maxWidth: totalWidth,
          overflow: 'hidden',
          pointerEvents: isScrolling ? 'none' : '',
          width: totalWidth
        }
      }, childrenToDisplay), cellCount === 0 && noContentRenderer());
    }
    /* ---------------------------- Helper methods ---------------------------- */

    /**
     * Sets an :isScrolling flag for a small window of time.
     * This flag is used to disable pointer events on the scrollable portion of the Collection.
     * This prevents jerky/stuttery mouse-wheel scrolling.
     */

  }, {
    key: "_enablePointerEventsAfterDelay",
    value: function _enablePointerEventsAfterDelay() {
      var _this2 = this;

      if (this._disablePointerEventsTimeoutId) {
        clearTimeout(this._disablePointerEventsTimeoutId);
      }

      this._disablePointerEventsTimeoutId = setTimeout(function () {
        var isScrollingChange = _this2.props.isScrollingChange;
        isScrollingChange(false);
        _this2._disablePointerEventsTimeoutId = null;

        _this2.setState({
          isScrolling: false
        });
      }, IS_SCROLLING_TIMEOUT);
    }
  }, {
    key: "_invokeOnScrollMemoizer",
    value: function _invokeOnScrollMemoizer(_ref) {
      var _this3 = this;

      var scrollLeft = _ref.scrollLeft,
          scrollTop = _ref.scrollTop,
          totalHeight = _ref.totalHeight,
          totalWidth = _ref.totalWidth;

      this._onScrollMemoizer({
        callback: function callback(_ref2) {
          var scrollLeft = _ref2.scrollLeft,
              scrollTop = _ref2.scrollTop;
          var _this3$props = _this3.props,
              height = _this3$props.height,
              onScroll = _this3$props.onScroll,
              width = _this3$props.width;
          onScroll({
            clientHeight: height,
            clientWidth: width,
            scrollHeight: totalHeight,
            scrollLeft: scrollLeft,
            scrollTop: scrollTop,
            scrollWidth: totalWidth
          });
        },
        indices: {
          scrollLeft: scrollLeft,
          scrollTop: scrollTop
        }
      });
    }
  }, {
    key: "_setScrollPosition",
    value: function _setScrollPosition(_ref3) {
      var scrollLeft = _ref3.scrollLeft,
          scrollTop = _ref3.scrollTop;
      var newState = {
        scrollPositionChangeReason: CollectionView_SCROLL_POSITION_CHANGE_REASONS.REQUESTED
      };

      if (scrollLeft >= 0) {
        newState.scrollLeft = scrollLeft;
      }

      if (scrollTop >= 0) {
        newState.scrollTop = scrollTop;
      }

      if (scrollLeft >= 0 && scrollLeft !== this.state.scrollLeft || scrollTop >= 0 && scrollTop !== this.state.scrollTop) {
        this.setState(newState);
      }
    }
  }], [{
    key: "getDerivedStateFromProps",
    value: function getDerivedStateFromProps(nextProps, prevState) {
      if (nextProps.cellCount === 0 && (prevState.scrollLeft !== 0 || prevState.scrollTop !== 0)) {
        return {
          scrollLeft: 0,
          scrollTop: 0,
          scrollPositionChangeReason: CollectionView_SCROLL_POSITION_CHANGE_REASONS.REQUESTED
        };
      } else if (nextProps.scrollLeft !== prevState.scrollLeft || nextProps.scrollTop !== prevState.scrollTop) {
        return {
          scrollLeft: nextProps.scrollLeft != null ? nextProps.scrollLeft : prevState.scrollLeft,
          scrollTop: nextProps.scrollTop != null ? nextProps.scrollTop : prevState.scrollTop,
          scrollPositionChangeReason: CollectionView_SCROLL_POSITION_CHANGE_REASONS.REQUESTED
        };
      }

      return null;
    }
  }]);

  return CollectionView;
}(react.PureComponent);

defineProperty_defineProperty(CollectionView, "defaultProps", {
  'aria-label': 'grid',
  horizontalOverscanSize: 0,
  noContentRenderer: function noContentRenderer() {
    return null;
  },
  onScroll: function onScroll() {
    return null;
  },
  onSectionRendered: function onSectionRendered() {
    return null;
  },
  scrollToAlignment: 'auto',
  scrollToCell: -1,
  style: {},
  verticalOverscanSize: 0
});

CollectionView.propTypes =  false ? 0 : {};
react_lifecycles_compat_es_polyfill(CollectionView);
/* harmony default export */ const Collection_CollectionView = (CollectionView);
;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Collection/types.js
var bpfrpt_proptype_Index =  true ? null : 0;
var bpfrpt_proptype_PositionInfo =  true ? null : 0;
var bpfrpt_proptype_ScrollPosition =  true ? null : 0;
var bpfrpt_proptype_SizeAndPositionInfo =  true ? null : 0;
var bpfrpt_proptype_SizeInfo =  true ? null : 0;






;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Collection/Section.js



/**
 * A section of the Window.
 * Window Sections are used to group nearby cells.
 * This enables us to more quickly determine which cells to display in a given region of the Window.
 * Sections have a fixed size and contain 0 to many cells (tracked by their indices).
 */
var Section =
/*#__PURE__*/
function () {
  function Section(_ref) {
    var height = _ref.height,
        width = _ref.width,
        x = _ref.x,
        y = _ref.y;

    classCallCheck_classCallCheck(this, Section);

    this.height = height;
    this.width = width;
    this.x = x;
    this.y = y;
    this._indexMap = {};
    this._indices = [];
  }
  /** Add a cell to this section. */


  createClass_createClass(Section, [{
    key: "addCellIndex",
    value: function addCellIndex(_ref2) {
      var index = _ref2.index;

      if (!this._indexMap[index]) {
        this._indexMap[index] = true;

        this._indices.push(index);
      }
    }
    /** Get all cell indices that have been added to this section. */

  }, {
    key: "getCellIndices",
    value: function getCellIndices() {
      return this._indices;
    }
    /** Intended for debugger/test purposes only */

  }, {
    key: "toString",
    value: function toString() {
      return "".concat(this.x, ",").concat(this.y, " ").concat(this.width, "x").concat(this.height);
    }
  }]);

  return Section;
}();




;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Collection/SectionManager.js



/**
 * Window Sections are used to group nearby cells.
 * This enables us to more quickly determine which cells to display in a given region of the Window.
 * 
 */

var SECTION_SIZE = 100;

/**
 * Contains 0 to many Sections.
 * Grows (and adds Sections) dynamically as cells are registered.
 * Automatically adds cells to the appropriate Section(s).
 */
var SectionManager =
/*#__PURE__*/
function () {
  function SectionManager() {
    var sectionSize = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : SECTION_SIZE;

    classCallCheck_classCallCheck(this, SectionManager);

    this._sectionSize = sectionSize;
    this._cellMetadata = [];
    this._sections = {};
  }
  /**
   * Gets all cell indices contained in the specified region.
   * A region may encompass 1 or more Sections.
   */


  createClass_createClass(SectionManager, [{
    key: "getCellIndices",
    value: function getCellIndices(_ref) {
      var height = _ref.height,
          width = _ref.width,
          x = _ref.x,
          y = _ref.y;
      var indices = {};
      this.getSections({
        height: height,
        width: width,
        x: x,
        y: y
      }).forEach(function (section) {
        return section.getCellIndices().forEach(function (index) {
          indices[index] = index;
        });
      }); // Object keys are strings; this function returns numbers

      return Object.keys(indices).map(function (index) {
        return indices[index];
      });
    }
    /** Get size and position information for the cell specified. */

  }, {
    key: "getCellMetadata",
    value: function getCellMetadata(_ref2) {
      var index = _ref2.index;
      return this._cellMetadata[index];
    }
    /** Get all Sections overlapping the specified region. */

  }, {
    key: "getSections",
    value: function getSections(_ref3) {
      var height = _ref3.height,
          width = _ref3.width,
          x = _ref3.x,
          y = _ref3.y;
      var sectionXStart = Math.floor(x / this._sectionSize);
      var sectionXStop = Math.floor((x + width - 1) / this._sectionSize);
      var sectionYStart = Math.floor(y / this._sectionSize);
      var sectionYStop = Math.floor((y + height - 1) / this._sectionSize);
      var sections = [];

      for (var sectionX = sectionXStart; sectionX <= sectionXStop; sectionX++) {
        for (var sectionY = sectionYStart; sectionY <= sectionYStop; sectionY++) {
          var key = "".concat(sectionX, ".").concat(sectionY);

          if (!this._sections[key]) {
            this._sections[key] = new Section({
              height: this._sectionSize,
              width: this._sectionSize,
              x: sectionX * this._sectionSize,
              y: sectionY * this._sectionSize
            });
          }

          sections.push(this._sections[key]);
        }
      }

      return sections;
    }
    /** Total number of Sections based on the currently registered cells. */

  }, {
    key: "getTotalSectionCount",
    value: function getTotalSectionCount() {
      return Object.keys(this._sections).length;
    }
    /** Intended for debugger/test purposes only */

  }, {
    key: "toString",
    value: function toString() {
      var _this = this;

      return Object.keys(this._sections).map(function (index) {
        return _this._sections[index].toString();
      });
    }
    /** Adds a cell to the appropriate Sections and registers it metadata for later retrievable. */

  }, {
    key: "registerCell",
    value: function registerCell(_ref4) {
      var cellMetadatum = _ref4.cellMetadatum,
          index = _ref4.index;
      this._cellMetadata[index] = cellMetadatum;
      this.getSections(cellMetadatum).forEach(function (section) {
        return section.addCellIndex({
          index: index
        });
      });
    }
  }]);

  return SectionManager;
}();




;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Collection/utils/calculateSizeAndPositionData.js

function calculateSizeAndPositionData_calculateSizeAndPositionData(_ref) {
  var cellCount = _ref.cellCount,
      cellSizeAndPositionGetter = _ref.cellSizeAndPositionGetter,
      sectionSize = _ref.sectionSize;
  var cellMetadata = [];
  var sectionManager = new SectionManager(sectionSize);
  var height = 0;
  var width = 0;

  for (var index = 0; index < cellCount; index++) {
    var cellMetadatum = cellSizeAndPositionGetter({
      index: index
    });

    if (cellMetadatum.height == null || isNaN(cellMetadatum.height) || cellMetadatum.width == null || isNaN(cellMetadatum.width) || cellMetadatum.x == null || isNaN(cellMetadatum.x) || cellMetadatum.y == null || isNaN(cellMetadatum.y)) {
      throw Error("Invalid metadata returned for cell ".concat(index, ":\n        x:").concat(cellMetadatum.x, ", y:").concat(cellMetadatum.y, ", width:").concat(cellMetadatum.width, ", height:").concat(cellMetadatum.height));
    }

    height = Math.max(height, cellMetadatum.y + cellMetadatum.height);
    width = Math.max(width, cellMetadatum.x + cellMetadatum.width);
    cellMetadata[index] = cellMetadatum;
    sectionManager.registerCell({
      cellMetadatum: cellMetadatum,
      index: index
    });
  }

  return {
    cellMetadata: cellMetadata,
    height: height,
    sectionManager: sectionManager,
    width: width
  };
}
;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/utils/getUpdatedOffsetForIndex.js
/**
 * Determines a new offset that ensures a certain cell is visible, given the current offset.
 * If the cell is already visible then the current offset will be returned.
 * If the current offset is too great or small, it will be adjusted just enough to ensure the specified index is visible.
 *
 * @param align Desired alignment within container; one of "auto" (default), "start", or "end"
 * @param cellOffset Offset (x or y) position for cell
 * @param cellSize Size (width or height) of cell
 * @param containerSize Total size (width or height) of the container
 * @param currentOffset Container's current (x or y) offset
 * @return Offset to use to ensure the specified cell is visible
 */
function getUpdatedOffsetForIndex(_ref) {
  var _ref$align = _ref.align,
      align = _ref$align === void 0 ? 'auto' : _ref$align,
      cellOffset = _ref.cellOffset,
      cellSize = _ref.cellSize,
      containerSize = _ref.containerSize,
      currentOffset = _ref.currentOffset;
  var maxOffset = cellOffset;
  var minOffset = maxOffset - containerSize + cellSize;

  switch (align) {
    case 'start':
      return maxOffset;

    case 'end':
      return minOffset;

    case 'center':
      return maxOffset - (containerSize - cellSize) / 2;

    default:
      return Math.max(minOffset, Math.min(maxOffset, currentOffset));
  }
}
;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Collection/Collection.js














/**
 * Renders scattered or non-linear data.
 * Unlike Grid, which renders checkerboard data, Collection can render arbitrarily positioned- even overlapping- data.
 */
var Collection_Collection =
/*#__PURE__*/
function (_React$PureComponent) {
  _inherits(Collection, _React$PureComponent);

  function Collection(props, context) {
    var _this;

    classCallCheck_classCallCheck(this, Collection);

    _this = _possibleConstructorReturn(this, _getPrototypeOf(Collection).call(this, props, context));
    _this._cellMetadata = [];
    _this._lastRenderedCellIndices = []; // Cell cache during scroll (for performance)

    _this._cellCache = [];
    _this._isScrollingChange = _this._isScrollingChange.bind(_assertThisInitialized(_this));
    _this._setCollectionViewRef = _this._setCollectionViewRef.bind(_assertThisInitialized(_this));
    return _this;
  }

  createClass_createClass(Collection, [{
    key: "forceUpdate",
    value: function forceUpdate() {
      if (this._collectionView !== undefined) {
        this._collectionView.forceUpdate();
      }
    }
    /** See Collection#recomputeCellSizesAndPositions */

  }, {
    key: "recomputeCellSizesAndPositions",
    value: function recomputeCellSizesAndPositions() {
      this._cellCache = [];

      this._collectionView.recomputeCellSizesAndPositions();
    }
    /** React lifecycle methods */

  }, {
    key: "render",
    value: function render() {
      var props = extends_extends({}, this.props);

      return react.createElement(Collection_CollectionView, extends_extends({
        cellLayoutManager: this,
        isScrollingChange: this._isScrollingChange,
        ref: this._setCollectionViewRef
      }, props));
    }
    /** CellLayoutManager interface */

  }, {
    key: "calculateSizeAndPositionData",
    value: function calculateSizeAndPositionData() {
      var _this$props = this.props,
          cellCount = _this$props.cellCount,
          cellSizeAndPositionGetter = _this$props.cellSizeAndPositionGetter,
          sectionSize = _this$props.sectionSize;

      var data = calculateSizeAndPositionData_calculateSizeAndPositionData({
        cellCount: cellCount,
        cellSizeAndPositionGetter: cellSizeAndPositionGetter,
        sectionSize: sectionSize
      });

      this._cellMetadata = data.cellMetadata;
      this._sectionManager = data.sectionManager;
      this._height = data.height;
      this._width = data.width;
    }
    /**
     * Returns the most recently rendered set of cell indices.
     */

  }, {
    key: "getLastRenderedIndices",
    value: function getLastRenderedIndices() {
      return this._lastRenderedCellIndices;
    }
    /**
     * Calculates the minimum amount of change from the current scroll position to ensure the specified cell is (fully) visible.
     */

  }, {
    key: "getScrollPositionForCell",
    value: function getScrollPositionForCell(_ref) {
      var align = _ref.align,
          cellIndex = _ref.cellIndex,
          height = _ref.height,
          scrollLeft = _ref.scrollLeft,
          scrollTop = _ref.scrollTop,
          width = _ref.width;
      var cellCount = this.props.cellCount;

      if (cellIndex >= 0 && cellIndex < cellCount) {
        var cellMetadata = this._cellMetadata[cellIndex];
        scrollLeft = getUpdatedOffsetForIndex({
          align: align,
          cellOffset: cellMetadata.x,
          cellSize: cellMetadata.width,
          containerSize: width,
          currentOffset: scrollLeft,
          targetIndex: cellIndex
        });
        scrollTop = getUpdatedOffsetForIndex({
          align: align,
          cellOffset: cellMetadata.y,
          cellSize: cellMetadata.height,
          containerSize: height,
          currentOffset: scrollTop,
          targetIndex: cellIndex
        });
      }

      return {
        scrollLeft: scrollLeft,
        scrollTop: scrollTop
      };
    }
  }, {
    key: "getTotalSize",
    value: function getTotalSize() {
      return {
        height: this._height,
        width: this._width
      };
    }
  }, {
    key: "cellRenderers",
    value: function cellRenderers(_ref2) {
      var _this2 = this;

      var height = _ref2.height,
          isScrolling = _ref2.isScrolling,
          width = _ref2.width,
          x = _ref2.x,
          y = _ref2.y;
      var _this$props2 = this.props,
          cellGroupRenderer = _this$props2.cellGroupRenderer,
          cellRenderer = _this$props2.cellRenderer; // Store for later calls to getLastRenderedIndices()

      this._lastRenderedCellIndices = this._sectionManager.getCellIndices({
        height: height,
        width: width,
        x: x,
        y: y
      });
      return cellGroupRenderer({
        cellCache: this._cellCache,
        cellRenderer: cellRenderer,
        cellSizeAndPositionGetter: function cellSizeAndPositionGetter(_ref3) {
          var index = _ref3.index;
          return _this2._sectionManager.getCellMetadata({
            index: index
          });
        },
        indices: this._lastRenderedCellIndices,
        isScrolling: isScrolling
      });
    }
  }, {
    key: "_isScrollingChange",
    value: function _isScrollingChange(isScrolling) {
      if (!isScrolling) {
        this._cellCache = [];
      }
    }
  }, {
    key: "_setCollectionViewRef",
    value: function _setCollectionViewRef(ref) {
      this._collectionView = ref;
    }
  }]);

  return Collection;
}(react.PureComponent);

defineProperty_defineProperty(Collection_Collection, "defaultProps", {
  'aria-label': 'grid',
  cellGroupRenderer: defaultCellGroupRenderer
});


Collection_Collection.propTypes =  false ? 0 : {};

function defaultCellGroupRenderer(_ref4) {
  var cellCache = _ref4.cellCache,
      cellRenderer = _ref4.cellRenderer,
      cellSizeAndPositionGetter = _ref4.cellSizeAndPositionGetter,
      indices = _ref4.indices,
      isScrolling = _ref4.isScrolling;
  return indices.map(function (index) {
    var cellMetadata = cellSizeAndPositionGetter({
      index: index
    });
    var cellRendererProps = {
      index: index,
      isScrolling: isScrolling,
      key: index,
      style: {
        height: cellMetadata.height,
        left: cellMetadata.x,
        position: 'absolute',
        top: cellMetadata.y,
        width: cellMetadata.width
      }
    }; // Avoid re-creating cells while scrolling.
    // This can lead to the same cell being created many times and can cause performance issues for "heavy" cells.
    // If a scroll is in progress- cache and reuse cells.
    // This cache will be thrown away once scrolling complets.

    if (isScrolling) {
      if (!(index in cellCache)) {
        cellCache[index] = cellRenderer(cellRendererProps);
      }

      return cellCache[index];
    } else {
      return cellRenderer(cellRendererProps);
    }
  }).filter(function (renderedCell) {
    return !!renderedCell;
  });
}



;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Collection/index.js

/* harmony default export */ const es_Collection = ((/* unused pure expression or super */ null && (Collection)));

;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/ColumnSizer/ColumnSizer.js








/**
 * High-order component that auto-calculates column-widths for `Grid` cells.
 */

var ColumnSizer_ColumnSizer =
/*#__PURE__*/
function (_React$PureComponent) {
  _inherits(ColumnSizer, _React$PureComponent);

  function ColumnSizer(props, context) {
    var _this;

    classCallCheck_classCallCheck(this, ColumnSizer);

    _this = _possibleConstructorReturn(this, _getPrototypeOf(ColumnSizer).call(this, props, context));
    _this._registerChild = _this._registerChild.bind(_assertThisInitialized(_this));
    return _this;
  }

  createClass_createClass(ColumnSizer, [{
    key: "componentDidUpdate",
    value: function componentDidUpdate(prevProps) {
      var _this$props = this.props,
          columnMaxWidth = _this$props.columnMaxWidth,
          columnMinWidth = _this$props.columnMinWidth,
          columnCount = _this$props.columnCount,
          width = _this$props.width;

      if (columnMaxWidth !== prevProps.columnMaxWidth || columnMinWidth !== prevProps.columnMinWidth || columnCount !== prevProps.columnCount || width !== prevProps.width) {
        if (this._registeredChild) {
          this._registeredChild.recomputeGridSize();
        }
      }
    }
  }, {
    key: "render",
    value: function render() {
      var _this$props2 = this.props,
          children = _this$props2.children,
          columnMaxWidth = _this$props2.columnMaxWidth,
          columnMinWidth = _this$props2.columnMinWidth,
          columnCount = _this$props2.columnCount,
          width = _this$props2.width;
      var safeColumnMinWidth = columnMinWidth || 1;
      var safeColumnMaxWidth = columnMaxWidth ? Math.min(columnMaxWidth, width) : width;
      var columnWidth = width / columnCount;
      columnWidth = Math.max(safeColumnMinWidth, columnWidth);
      columnWidth = Math.min(safeColumnMaxWidth, columnWidth);
      columnWidth = Math.floor(columnWidth);
      var adjustedWidth = Math.min(width, columnWidth * columnCount);
      return children({
        adjustedWidth: adjustedWidth,
        columnWidth: columnWidth,
        getColumnWidth: function getColumnWidth() {
          return columnWidth;
        },
        registerChild: this._registerChild
      });
    }
  }, {
    key: "_registerChild",
    value: function _registerChild(child) {
      if (child && typeof child.recomputeGridSize !== 'function') {
        throw Error('Unexpected child type registered; only Grid/MultiGrid children are supported.');
      }

      this._registeredChild = child;

      if (this._registeredChild) {
        this._registeredChild.recomputeGridSize();
      }
    }
  }]);

  return ColumnSizer;
}(react.PureComponent);


ColumnSizer_ColumnSizer.propTypes =  false ? 0 : {};
;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/ColumnSizer/index.js

/* harmony default export */ const es_ColumnSizer = ((/* unused pure expression or super */ null && (ColumnSizer)));

;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/arrayLikeToArray.js
function _arrayLikeToArray(r, a) {
  (null == a || a > r.length) && (a = r.length);
  for (var e = 0, n = Array(a); e < a; e++) n[e] = r[e];
  return n;
}

;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/arrayWithoutHoles.js

function _arrayWithoutHoles(r) {
  if (Array.isArray(r)) return _arrayLikeToArray(r);
}

;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/iterableToArray.js
function _iterableToArray(r) {
  if ("undefined" != typeof Symbol && null != r[Symbol.iterator] || null != r["@@iterator"]) return Array.from(r);
}

;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/unsupportedIterableToArray.js

function _unsupportedIterableToArray(r, a) {
  if (r) {
    if ("string" == typeof r) return _arrayLikeToArray(r, a);
    var t = {}.toString.call(r).slice(8, -1);
    return "Object" === t && r.constructor && (t = r.constructor.name), "Map" === t || "Set" === t ? Array.from(r) : "Arguments" === t || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t) ? _arrayLikeToArray(r, a) : void 0;
  }
}

;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/nonIterableSpread.js
function _nonIterableSpread() {
  throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
}

;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/toConsumableArray.js




function _toConsumableArray(r) {
  return _arrayWithoutHoles(r) || _iterableToArray(r) || _unsupportedIterableToArray(r) || _nonIterableSpread();
}

;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/InfiniteLoader/InfiniteLoader.js











/**
 * Higher-order component that manages lazy-loading for "infinite" data.
 * This component decorates a virtual component and just-in-time prefetches rows as a user scrolls.
 * It is intended as a convenience component; fork it if you'd like finer-grained control over data-loading.
 */

var InfiniteLoader_InfiniteLoader =
/*#__PURE__*/
function (_React$PureComponent) {
  _inherits(InfiniteLoader, _React$PureComponent);

  function InfiniteLoader(props, context) {
    var _this;

    classCallCheck_classCallCheck(this, InfiniteLoader);

    _this = _possibleConstructorReturn(this, _getPrototypeOf(InfiniteLoader).call(this, props, context));
    _this._loadMoreRowsMemoizer = createCallbackMemoizer();
    _this._onRowsRendered = _this._onRowsRendered.bind(_assertThisInitialized(_this));
    _this._registerChild = _this._registerChild.bind(_assertThisInitialized(_this));
    return _this;
  }

  createClass_createClass(InfiniteLoader, [{
    key: "resetLoadMoreRowsCache",
    value: function resetLoadMoreRowsCache(autoReload) {
      this._loadMoreRowsMemoizer = createCallbackMemoizer();

      if (autoReload) {
        this._doStuff(this._lastRenderedStartIndex, this._lastRenderedStopIndex);
      }
    }
  }, {
    key: "render",
    value: function render() {
      var children = this.props.children;
      return children({
        onRowsRendered: this._onRowsRendered,
        registerChild: this._registerChild
      });
    }
  }, {
    key: "_loadUnloadedRanges",
    value: function _loadUnloadedRanges(unloadedRanges) {
      var _this2 = this;

      var loadMoreRows = this.props.loadMoreRows;
      unloadedRanges.forEach(function (unloadedRange) {
        var promise = loadMoreRows(unloadedRange);

        if (promise) {
          promise.then(function () {
            // Refresh the visible rows if any of them have just been loaded.
            // Otherwise they will remain in their unloaded visual state.
            if (isRangeVisible({
              lastRenderedStartIndex: _this2._lastRenderedStartIndex,
              lastRenderedStopIndex: _this2._lastRenderedStopIndex,
              startIndex: unloadedRange.startIndex,
              stopIndex: unloadedRange.stopIndex
            })) {
              if (_this2._registeredChild) {
                forceUpdateReactVirtualizedComponent(_this2._registeredChild, _this2._lastRenderedStartIndex);
              }
            }
          });
        }
      });
    }
  }, {
    key: "_onRowsRendered",
    value: function _onRowsRendered(_ref) {
      var startIndex = _ref.startIndex,
          stopIndex = _ref.stopIndex;
      this._lastRenderedStartIndex = startIndex;
      this._lastRenderedStopIndex = stopIndex;

      this._doStuff(startIndex, stopIndex);
    }
  }, {
    key: "_doStuff",
    value: function _doStuff(startIndex, stopIndex) {
      var _ref2,
          _this3 = this;

      var _this$props = this.props,
          isRowLoaded = _this$props.isRowLoaded,
          minimumBatchSize = _this$props.minimumBatchSize,
          rowCount = _this$props.rowCount,
          threshold = _this$props.threshold;
      var unloadedRanges = scanForUnloadedRanges({
        isRowLoaded: isRowLoaded,
        minimumBatchSize: minimumBatchSize,
        rowCount: rowCount,
        startIndex: Math.max(0, startIndex - threshold),
        stopIndex: Math.min(rowCount - 1, stopIndex + threshold)
      }); // For memoize comparison

      var squashedUnloadedRanges = (_ref2 = []).concat.apply(_ref2, _toConsumableArray(unloadedRanges.map(function (_ref3) {
        var startIndex = _ref3.startIndex,
            stopIndex = _ref3.stopIndex;
        return [startIndex, stopIndex];
      })));

      this._loadMoreRowsMemoizer({
        callback: function callback() {
          _this3._loadUnloadedRanges(unloadedRanges);
        },
        indices: {
          squashedUnloadedRanges: squashedUnloadedRanges
        }
      });
    }
  }, {
    key: "_registerChild",
    value: function _registerChild(registeredChild) {
      this._registeredChild = registeredChild;
    }
  }]);

  return InfiniteLoader;
}(react.PureComponent);
/**
 * Determines if the specified start/stop range is visible based on the most recently rendered range.
 */


defineProperty_defineProperty(InfiniteLoader_InfiniteLoader, "defaultProps", {
  minimumBatchSize: 10,
  rowCount: 0,
  threshold: 15
});


InfiniteLoader_InfiniteLoader.propTypes =  false ? 0 : {};
function isRangeVisible(_ref4) {
  var lastRenderedStartIndex = _ref4.lastRenderedStartIndex,
      lastRenderedStopIndex = _ref4.lastRenderedStopIndex,
      startIndex = _ref4.startIndex,
      stopIndex = _ref4.stopIndex;
  return !(startIndex > lastRenderedStopIndex || stopIndex < lastRenderedStartIndex);
}
/**
 * Returns all of the ranges within a larger range that contain unloaded rows.
 */

function scanForUnloadedRanges(_ref5) {
  var isRowLoaded = _ref5.isRowLoaded,
      minimumBatchSize = _ref5.minimumBatchSize,
      rowCount = _ref5.rowCount,
      startIndex = _ref5.startIndex,
      stopIndex = _ref5.stopIndex;
  var unloadedRanges = [];
  var rangeStartIndex = null;
  var rangeStopIndex = null;

  for (var index = startIndex; index <= stopIndex; index++) {
    var loaded = isRowLoaded({
      index: index
    });

    if (!loaded) {
      rangeStopIndex = index;

      if (rangeStartIndex === null) {
        rangeStartIndex = index;
      }
    } else if (rangeStopIndex !== null) {
      unloadedRanges.push({
        startIndex: rangeStartIndex,
        stopIndex: rangeStopIndex
      });
      rangeStartIndex = rangeStopIndex = null;
    }
  } // If :rangeStopIndex is not null it means we haven't ran out of unloaded rows.
  // Scan forward to try filling our :minimumBatchSize.


  if (rangeStopIndex !== null) {
    var potentialStopIndex = Math.min(Math.max(rangeStopIndex, rangeStartIndex + minimumBatchSize - 1), rowCount - 1);

    for (var _index = rangeStopIndex + 1; _index <= potentialStopIndex; _index++) {
      if (!isRowLoaded({
        index: _index
      })) {
        rangeStopIndex = _index;
      } else {
        break;
      }
    }

    unloadedRanges.push({
      startIndex: rangeStartIndex,
      stopIndex: rangeStopIndex
    });
  } // Check to see if our first range ended prematurely.
  // In this case we should scan backwards to try filling our :minimumBatchSize.


  if (unloadedRanges.length) {
    var firstUnloadedRange = unloadedRanges[0];

    while (firstUnloadedRange.stopIndex - firstUnloadedRange.startIndex + 1 < minimumBatchSize && firstUnloadedRange.startIndex > 0) {
      var _index2 = firstUnloadedRange.startIndex - 1;

      if (!isRowLoaded({
        index: _index2
      })) {
        firstUnloadedRange.startIndex = _index2;
      } else {
        break;
      }
    }
  }

  return unloadedRanges;
}
/**
 * Since RV components use shallowCompare we need to force a render (even though props haven't changed).
 * However InfiniteLoader may wrap a Grid or it may wrap a Table or List.
 * In the first case the built-in React forceUpdate() method is sufficient to force a re-render,
 * But in the latter cases we need to use the RV-specific forceUpdateGrid() method.
 * Else the inner Grid will not be re-rendered and visuals may be stale.
 *
 * Additionally, while a Grid is scrolling the cells can be cached,
 * So it's important to invalidate that cache by recalculating sizes
 * before forcing a rerender.
 */

function forceUpdateReactVirtualizedComponent(component) {
  var currentIndex = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 0;
  var recomputeSize = typeof component.recomputeGridSize === 'function' ? component.recomputeGridSize : component.recomputeRowHeights;

  if (recomputeSize) {
    recomputeSize.call(component, currentIndex);
  } else {
    component.forceUpdate();
  }
}
;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/InfiniteLoader/index.js

/* harmony default export */ const es_InfiniteLoader = ((/* unused pure expression or super */ null && (InfiniteLoader)));

;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/List/types.js

var bpfrpt_proptype_RowRendererParams =  true ? null : 0;
var bpfrpt_proptype_RowRenderer =  true ? null : 0;
var bpfrpt_proptype_RenderedRows =  true ? null : 0;
var types_bpfrpt_proptype_Scroll =  true ? null : 0;





;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/List/List.js









var List_class, List_temp;




/**
 * It is inefficient to create and manage a large list of DOM elements within a scrolling container
 * if only a few of those elements are visible. The primary purpose of this component is to improve
 * performance by only rendering the DOM nodes that a user is able to see based on their current
 * scroll position.
 *
 * This component renders a virtualized list of elements with either fixed or dynamic heights.
 */

var List = (List_temp = List_class =
/*#__PURE__*/
function (_React$PureComponent) {
  _inherits(List, _React$PureComponent);

  function List() {
    var _getPrototypeOf2;

    var _this;

    classCallCheck_classCallCheck(this, List);

    for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
      args[_key] = arguments[_key];
    }

    _this = _possibleConstructorReturn(this, (_getPrototypeOf2 = _getPrototypeOf(List)).call.apply(_getPrototypeOf2, [this].concat(args)));

    defineProperty_defineProperty(_assertThisInitialized(_this), "Grid", void 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_cellRenderer", function (_ref) {
      var parent = _ref.parent,
          rowIndex = _ref.rowIndex,
          style = _ref.style,
          isScrolling = _ref.isScrolling,
          isVisible = _ref.isVisible,
          key = _ref.key;
      var rowRenderer = _this.props.rowRenderer; // TRICKY The style object is sometimes cached by Grid.
      // This prevents new style objects from bypassing shallowCompare().
      // However as of React 16, style props are auto-frozen (at least in dev mode)
      // Check to make sure we can still modify the style before proceeding.
      // https://github.com/facebook/react/commit/977357765b44af8ff0cfea327866861073095c12#commitcomment-20648713

      var widthDescriptor = Object.getOwnPropertyDescriptor(style, 'width');

      if (widthDescriptor && widthDescriptor.writable) {
        // By default, List cells should be 100% width.
        // This prevents them from flowing under a scrollbar (if present).
        style.width = '100%';
      }

      return rowRenderer({
        index: rowIndex,
        style: style,
        isScrolling: isScrolling,
        isVisible: isVisible,
        key: key,
        parent: parent
      });
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_setRef", function (ref) {
      _this.Grid = ref;
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_onScroll", function (_ref2) {
      var clientHeight = _ref2.clientHeight,
          scrollHeight = _ref2.scrollHeight,
          scrollTop = _ref2.scrollTop;
      var onScroll = _this.props.onScroll;
      onScroll({
        clientHeight: clientHeight,
        scrollHeight: scrollHeight,
        scrollTop: scrollTop
      });
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_onSectionRendered", function (_ref3) {
      var rowOverscanStartIndex = _ref3.rowOverscanStartIndex,
          rowOverscanStopIndex = _ref3.rowOverscanStopIndex,
          rowStartIndex = _ref3.rowStartIndex,
          rowStopIndex = _ref3.rowStopIndex;
      var onRowsRendered = _this.props.onRowsRendered;
      onRowsRendered({
        overscanStartIndex: rowOverscanStartIndex,
        overscanStopIndex: rowOverscanStopIndex,
        startIndex: rowStartIndex,
        stopIndex: rowStopIndex
      });
    });

    return _this;
  }

  createClass_createClass(List, [{
    key: "forceUpdateGrid",
    value: function forceUpdateGrid() {
      if (this.Grid) {
        this.Grid.forceUpdate();
      }
    }
    /** See Grid#getOffsetForCell */

  }, {
    key: "getOffsetForRow",
    value: function getOffsetForRow(_ref4) {
      var alignment = _ref4.alignment,
          index = _ref4.index;

      if (this.Grid) {
        var _this$Grid$getOffsetF = this.Grid.getOffsetForCell({
          alignment: alignment,
          rowIndex: index,
          columnIndex: 0
        }),
            scrollTop = _this$Grid$getOffsetF.scrollTop;

        return scrollTop;
      }

      return 0;
    }
    /** CellMeasurer compatibility */

  }, {
    key: "invalidateCellSizeAfterRender",
    value: function invalidateCellSizeAfterRender(_ref5) {
      var columnIndex = _ref5.columnIndex,
          rowIndex = _ref5.rowIndex;

      if (this.Grid) {
        this.Grid.invalidateCellSizeAfterRender({
          rowIndex: rowIndex,
          columnIndex: columnIndex
        });
      }
    }
    /** See Grid#measureAllCells */

  }, {
    key: "measureAllRows",
    value: function measureAllRows() {
      if (this.Grid) {
        this.Grid.measureAllCells();
      }
    }
    /** CellMeasurer compatibility */

  }, {
    key: "recomputeGridSize",
    value: function recomputeGridSize() {
      var _ref6 = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {},
          _ref6$columnIndex = _ref6.columnIndex,
          columnIndex = _ref6$columnIndex === void 0 ? 0 : _ref6$columnIndex,
          _ref6$rowIndex = _ref6.rowIndex,
          rowIndex = _ref6$rowIndex === void 0 ? 0 : _ref6$rowIndex;

      if (this.Grid) {
        this.Grid.recomputeGridSize({
          rowIndex: rowIndex,
          columnIndex: columnIndex
        });
      }
    }
    /** See Grid#recomputeGridSize */

  }, {
    key: "recomputeRowHeights",
    value: function recomputeRowHeights() {
      var index = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : 0;

      if (this.Grid) {
        this.Grid.recomputeGridSize({
          rowIndex: index,
          columnIndex: 0
        });
      }
    }
    /** See Grid#scrollToPosition */

  }, {
    key: "scrollToPosition",
    value: function scrollToPosition() {
      var scrollTop = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : 0;

      if (this.Grid) {
        this.Grid.scrollToPosition({
          scrollTop: scrollTop
        });
      }
    }
    /** See Grid#scrollToCell */

  }, {
    key: "scrollToRow",
    value: function scrollToRow() {
      var index = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : 0;

      if (this.Grid) {
        this.Grid.scrollToCell({
          columnIndex: 0,
          rowIndex: index
        });
      }
    }
  }, {
    key: "render",
    value: function render() {
      var _this$props = this.props,
          className = _this$props.className,
          noRowsRenderer = _this$props.noRowsRenderer,
          scrollToIndex = _this$props.scrollToIndex,
          width = _this$props.width;
      var classNames = clsx_m('ReactVirtualized__List', className);
      return react.createElement(Grid_Grid, extends_extends({}, this.props, {
        autoContainerWidth: true,
        cellRenderer: this._cellRenderer,
        className: classNames,
        columnWidth: width,
        columnCount: 1,
        noContentRenderer: noRowsRenderer,
        onScroll: this._onScroll,
        onSectionRendered: this._onSectionRendered,
        ref: this._setRef,
        scrollToRow: scrollToIndex
      }));
    }
  }]);

  return List;
}(react.PureComponent), defineProperty_defineProperty(List_class, "propTypes",  true ? null : 0), List_temp);

defineProperty_defineProperty(List, "defaultProps", {
  autoHeight: false,
  estimatedRowSize: 30,
  onScroll: function onScroll() {},
  noRowsRenderer: function noRowsRenderer() {
    return null;
  },
  onRowsRendered: function onRowsRendered() {},
  overscanIndicesGetter: accessibilityOverscanIndicesGetter_defaultOverscanIndicesGetter,
  overscanRowCount: 10,
  scrollToAlignment: 'auto',
  scrollToIndex: -1,
  style: {}
});














;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/List/index.js




;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/arrayWithHoles.js
function _arrayWithHoles(r) {
  if (Array.isArray(r)) return r;
}

;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/iterableToArrayLimit.js
function _iterableToArrayLimit(r, l) {
  var t = null == r ? null : "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"];
  if (null != t) {
    var e,
      n,
      i,
      u,
      a = [],
      f = !0,
      o = !1;
    try {
      if (i = (t = t.call(r)).next, 0 === l) {
        if (Object(t) !== t) return;
        f = !1;
      } else for (; !(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l); f = !0);
    } catch (r) {
      o = !0, n = r;
    } finally {
      try {
        if (!f && null != t["return"] && (u = t["return"](), Object(u) !== u)) return;
      } finally {
        if (o) throw n;
      }
    }
    return a;
  }
}

;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/nonIterableRest.js
function _nonIterableRest() {
  throw new TypeError("Invalid attempt to destructure non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
}

;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/slicedToArray.js




function _slicedToArray(r, e) {
  return _arrayWithHoles(r) || _iterableToArrayLimit(r, e) || _unsupportedIterableToArray(r, e) || _nonIterableRest();
}

;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/vendor/binarySearchBounds.js
/**
 * Binary Search Bounds
 * https://github.com/mikolalysenko/binary-search-bounds
 * Mikola Lysenko
 *
 * Inlined because of Content Security Policy issue caused by the use of `new Function(...)` syntax.
 * Issue reported here: https://github.com/mikolalysenko/binary-search-bounds/issues/5
 **/
function _GEA(a, l, h, y) {
  var i = h + 1;

  while (l <= h) {
    var m = l + h >>> 1,
        x = a[m];

    if (x >= y) {
      i = m;
      h = m - 1;
    } else {
      l = m + 1;
    }
  }

  return i;
}

function _GEP(a, l, h, y, c) {
  var i = h + 1;

  while (l <= h) {
    var m = l + h >>> 1,
        x = a[m];

    if (c(x, y) >= 0) {
      i = m;
      h = m - 1;
    } else {
      l = m + 1;
    }
  }

  return i;
}

function dispatchBsearchGE(a, y, c, l, h) {
  if (typeof c === 'function') {
    return _GEP(a, l === void 0 ? 0 : l | 0, h === void 0 ? a.length - 1 : h | 0, y, c);
  } else {
    return _GEA(a, c === void 0 ? 0 : c | 0, l === void 0 ? a.length - 1 : l | 0, y);
  }
}

function _GTA(a, l, h, y) {
  var i = h + 1;

  while (l <= h) {
    var m = l + h >>> 1,
        x = a[m];

    if (x > y) {
      i = m;
      h = m - 1;
    } else {
      l = m + 1;
    }
  }

  return i;
}

function _GTP(a, l, h, y, c) {
  var i = h + 1;

  while (l <= h) {
    var m = l + h >>> 1,
        x = a[m];

    if (c(x, y) > 0) {
      i = m;
      h = m - 1;
    } else {
      l = m + 1;
    }
  }

  return i;
}

function dispatchBsearchGT(a, y, c, l, h) {
  if (typeof c === 'function') {
    return _GTP(a, l === void 0 ? 0 : l | 0, h === void 0 ? a.length - 1 : h | 0, y, c);
  } else {
    return _GTA(a, c === void 0 ? 0 : c | 0, l === void 0 ? a.length - 1 : l | 0, y);
  }
}

function _LTA(a, l, h, y) {
  var i = l - 1;

  while (l <= h) {
    var m = l + h >>> 1,
        x = a[m];

    if (x < y) {
      i = m;
      l = m + 1;
    } else {
      h = m - 1;
    }
  }

  return i;
}

function _LTP(a, l, h, y, c) {
  var i = l - 1;

  while (l <= h) {
    var m = l + h >>> 1,
        x = a[m];

    if (c(x, y) < 0) {
      i = m;
      l = m + 1;
    } else {
      h = m - 1;
    }
  }

  return i;
}

function dispatchBsearchLT(a, y, c, l, h) {
  if (typeof c === 'function') {
    return _LTP(a, l === void 0 ? 0 : l | 0, h === void 0 ? a.length - 1 : h | 0, y, c);
  } else {
    return _LTA(a, c === void 0 ? 0 : c | 0, l === void 0 ? a.length - 1 : l | 0, y);
  }
}

function _LEA(a, l, h, y) {
  var i = l - 1;

  while (l <= h) {
    var m = l + h >>> 1,
        x = a[m];

    if (x <= y) {
      i = m;
      l = m + 1;
    } else {
      h = m - 1;
    }
  }

  return i;
}

function _LEP(a, l, h, y, c) {
  var i = l - 1;

  while (l <= h) {
    var m = l + h >>> 1,
        x = a[m];

    if (c(x, y) <= 0) {
      i = m;
      l = m + 1;
    } else {
      h = m - 1;
    }
  }

  return i;
}

function dispatchBsearchLE(a, y, c, l, h) {
  if (typeof c === 'function') {
    return _LEP(a, l === void 0 ? 0 : l | 0, h === void 0 ? a.length - 1 : h | 0, y, c);
  } else {
    return _LEA(a, c === void 0 ? 0 : c | 0, l === void 0 ? a.length - 1 : l | 0, y);
  }
}

function _EQA(a, l, h, y) {
  l - 1;

  while (l <= h) {
    var m = l + h >>> 1,
        x = a[m];

    if (x === y) {
      return m;
    } else if (x <= y) {
      l = m + 1;
    } else {
      h = m - 1;
    }
  }

  return -1;
}

function _EQP(a, l, h, y, c) {
  l - 1;

  while (l <= h) {
    var m = l + h >>> 1,
        x = a[m];
    var p = c(x, y);

    if (p === 0) {
      return m;
    } else if (p <= 0) {
      l = m + 1;
    } else {
      h = m - 1;
    }
  }

  return -1;
}

function dispatchBsearchEQ(a, y, c, l, h) {
  if (typeof c === 'function') {
    return _EQP(a, l === void 0 ? 0 : l | 0, h === void 0 ? a.length - 1 : h | 0, y, c);
  } else {
    return _EQA(a, c === void 0 ? 0 : c | 0, l === void 0 ? a.length - 1 : l | 0, y);
  }
}

/* harmony default export */ const binarySearchBounds = ({
  ge: dispatchBsearchGE,
  gt: dispatchBsearchGT,
  lt: dispatchBsearchLT,
  le: dispatchBsearchLE,
  eq: dispatchBsearchEQ
});
;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/vendor/intervalTree.js
/**
 * Binary Search Bounds
 * https://github.com/mikolalysenko/interval-tree-1d
 * Mikola Lysenko
 *
 * Inlined because of Content Security Policy issue caused by the use of `new Function(...)` syntax in an upstream dependency.
 * Issue reported here: https://github.com/mikolalysenko/binary-search-bounds/issues/5
 **/

var NOT_FOUND = 0;
var SUCCESS = 1;
var EMPTY = 2;

function IntervalTreeNode(mid, left, right, leftPoints, rightPoints) {
  this.mid = mid;
  this.left = left;
  this.right = right;
  this.leftPoints = leftPoints;
  this.rightPoints = rightPoints;
  this.count = (left ? left.count : 0) + (right ? right.count : 0) + leftPoints.length;
}

var proto = IntervalTreeNode.prototype;

function copy(a, b) {
  a.mid = b.mid;
  a.left = b.left;
  a.right = b.right;
  a.leftPoints = b.leftPoints;
  a.rightPoints = b.rightPoints;
  a.count = b.count;
}

function rebuild(node, intervals) {
  var ntree = createIntervalTree(intervals);
  node.mid = ntree.mid;
  node.left = ntree.left;
  node.right = ntree.right;
  node.leftPoints = ntree.leftPoints;
  node.rightPoints = ntree.rightPoints;
  node.count = ntree.count;
}

function rebuildWithInterval(node, interval) {
  var intervals = node.intervals([]);
  intervals.push(interval);
  rebuild(node, intervals);
}

function rebuildWithoutInterval(node, interval) {
  var intervals = node.intervals([]);
  var idx = intervals.indexOf(interval);

  if (idx < 0) {
    return NOT_FOUND;
  }

  intervals.splice(idx, 1);
  rebuild(node, intervals);
  return SUCCESS;
}

proto.intervals = function (result) {
  result.push.apply(result, this.leftPoints);

  if (this.left) {
    this.left.intervals(result);
  }

  if (this.right) {
    this.right.intervals(result);
  }

  return result;
};

proto.insert = function (interval) {
  var weight = this.count - this.leftPoints.length;
  this.count += 1;

  if (interval[1] < this.mid) {
    if (this.left) {
      if (4 * (this.left.count + 1) > 3 * (weight + 1)) {
        rebuildWithInterval(this, interval);
      } else {
        this.left.insert(interval);
      }
    } else {
      this.left = createIntervalTree([interval]);
    }
  } else if (interval[0] > this.mid) {
    if (this.right) {
      if (4 * (this.right.count + 1) > 3 * (weight + 1)) {
        rebuildWithInterval(this, interval);
      } else {
        this.right.insert(interval);
      }
    } else {
      this.right = createIntervalTree([interval]);
    }
  } else {
    var l = binarySearchBounds.ge(this.leftPoints, interval, compareBegin);
    var r = binarySearchBounds.ge(this.rightPoints, interval, compareEnd);
    this.leftPoints.splice(l, 0, interval);
    this.rightPoints.splice(r, 0, interval);
  }
};

proto.remove = function (interval) {
  var weight = this.count - this.leftPoints;

  if (interval[1] < this.mid) {
    if (!this.left) {
      return NOT_FOUND;
    }

    var rw = this.right ? this.right.count : 0;

    if (4 * rw > 3 * (weight - 1)) {
      return rebuildWithoutInterval(this, interval);
    }

    var r = this.left.remove(interval);

    if (r === EMPTY) {
      this.left = null;
      this.count -= 1;
      return SUCCESS;
    } else if (r === SUCCESS) {
      this.count -= 1;
    }

    return r;
  } else if (interval[0] > this.mid) {
    if (!this.right) {
      return NOT_FOUND;
    }

    var lw = this.left ? this.left.count : 0;

    if (4 * lw > 3 * (weight - 1)) {
      return rebuildWithoutInterval(this, interval);
    }

    var r = this.right.remove(interval);

    if (r === EMPTY) {
      this.right = null;
      this.count -= 1;
      return SUCCESS;
    } else if (r === SUCCESS) {
      this.count -= 1;
    }

    return r;
  } else {
    if (this.count === 1) {
      if (this.leftPoints[0] === interval) {
        return EMPTY;
      } else {
        return NOT_FOUND;
      }
    }

    if (this.leftPoints.length === 1 && this.leftPoints[0] === interval) {
      if (this.left && this.right) {
        var p = this;
        var n = this.left;

        while (n.right) {
          p = n;
          n = n.right;
        }

        if (p === this) {
          n.right = this.right;
        } else {
          var l = this.left;
          var r = this.right;
          p.count -= n.count;
          p.right = n.left;
          n.left = l;
          n.right = r;
        }

        copy(this, n);
        this.count = (this.left ? this.left.count : 0) + (this.right ? this.right.count : 0) + this.leftPoints.length;
      } else if (this.left) {
        copy(this, this.left);
      } else {
        copy(this, this.right);
      }

      return SUCCESS;
    }

    for (var l = binarySearchBounds.ge(this.leftPoints, interval, compareBegin); l < this.leftPoints.length; ++l) {
      if (this.leftPoints[l][0] !== interval[0]) {
        break;
      }

      if (this.leftPoints[l] === interval) {
        this.count -= 1;
        this.leftPoints.splice(l, 1);

        for (var r = binarySearchBounds.ge(this.rightPoints, interval, compareEnd); r < this.rightPoints.length; ++r) {
          if (this.rightPoints[r][1] !== interval[1]) {
            break;
          } else if (this.rightPoints[r] === interval) {
            this.rightPoints.splice(r, 1);
            return SUCCESS;
          }
        }
      }
    }

    return NOT_FOUND;
  }
};

function reportLeftRange(arr, hi, cb) {
  for (var i = 0; i < arr.length && arr[i][0] <= hi; ++i) {
    var r = cb(arr[i]);

    if (r) {
      return r;
    }
  }
}

function reportRightRange(arr, lo, cb) {
  for (var i = arr.length - 1; i >= 0 && arr[i][1] >= lo; --i) {
    var r = cb(arr[i]);

    if (r) {
      return r;
    }
  }
}

function reportRange(arr, cb) {
  for (var i = 0; i < arr.length; ++i) {
    var r = cb(arr[i]);

    if (r) {
      return r;
    }
  }
}

proto.queryPoint = function (x, cb) {
  if (x < this.mid) {
    if (this.left) {
      var r = this.left.queryPoint(x, cb);

      if (r) {
        return r;
      }
    }

    return reportLeftRange(this.leftPoints, x, cb);
  } else if (x > this.mid) {
    if (this.right) {
      var r = this.right.queryPoint(x, cb);

      if (r) {
        return r;
      }
    }

    return reportRightRange(this.rightPoints, x, cb);
  } else {
    return reportRange(this.leftPoints, cb);
  }
};

proto.queryInterval = function (lo, hi, cb) {
  if (lo < this.mid && this.left) {
    var r = this.left.queryInterval(lo, hi, cb);

    if (r) {
      return r;
    }
  }

  if (hi > this.mid && this.right) {
    var r = this.right.queryInterval(lo, hi, cb);

    if (r) {
      return r;
    }
  }

  if (hi < this.mid) {
    return reportLeftRange(this.leftPoints, hi, cb);
  } else if (lo > this.mid) {
    return reportRightRange(this.rightPoints, lo, cb);
  } else {
    return reportRange(this.leftPoints, cb);
  }
};

function compareNumbers(a, b) {
  return a - b;
}

function compareBegin(a, b) {
  var d = a[0] - b[0];

  if (d) {
    return d;
  }

  return a[1] - b[1];
}

function compareEnd(a, b) {
  var d = a[1] - b[1];

  if (d) {
    return d;
  }

  return a[0] - b[0];
}

function createIntervalTree(intervals) {
  if (intervals.length === 0) {
    return null;
  }

  var pts = [];

  for (var i = 0; i < intervals.length; ++i) {
    pts.push(intervals[i][0], intervals[i][1]);
  }

  pts.sort(compareNumbers);
  var mid = pts[pts.length >> 1];
  var leftIntervals = [];
  var rightIntervals = [];
  var centerIntervals = [];

  for (var i = 0; i < intervals.length; ++i) {
    var s = intervals[i];

    if (s[1] < mid) {
      leftIntervals.push(s);
    } else if (mid < s[0]) {
      rightIntervals.push(s);
    } else {
      centerIntervals.push(s);
    }
  } //Split center intervals


  var leftPoints = centerIntervals;
  var rightPoints = centerIntervals.slice();
  leftPoints.sort(compareBegin);
  rightPoints.sort(compareEnd);
  return new IntervalTreeNode(mid, createIntervalTree(leftIntervals), createIntervalTree(rightIntervals), leftPoints, rightPoints);
} //User friendly wrapper that makes it possible to support empty trees


function IntervalTree(root) {
  this.root = root;
}

var tproto = IntervalTree.prototype;

tproto.insert = function (interval) {
  if (this.root) {
    this.root.insert(interval);
  } else {
    this.root = new IntervalTreeNode(interval[0], null, null, [interval], [interval]);
  }
};

tproto.remove = function (interval) {
  if (this.root) {
    var r = this.root.remove(interval);

    if (r === EMPTY) {
      this.root = null;
    }

    return r !== NOT_FOUND;
  }

  return false;
};

tproto.queryPoint = function (p, cb) {
  if (this.root) {
    return this.root.queryPoint(p, cb);
  }
};

tproto.queryInterval = function (lo, hi, cb) {
  if (lo <= hi && this.root) {
    return this.root.queryInterval(lo, hi, cb);
  }
};

Object.defineProperty(tproto, 'count', {
  get: function get() {
    if (this.root) {
      return this.root.count;
    }

    return 0;
  }
});
Object.defineProperty(tproto, 'intervals', {
  get: function get() {
    if (this.root) {
      return this.root.intervals([]);
    }

    return [];
  }
});
function createWrapper(intervals) {
  if (!intervals || intervals.length === 0) {
    return new IntervalTree(null);
  }

  return new IntervalTree(createIntervalTree(intervals));
}
;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Masonry/PositionCache.js






// Position cache requirements:
//   O(log(n)) lookup of cells to render for a given viewport size
//   O(1) lookup of shortest measured column (so we know when to enter phase 1)
var PositionCache =
/*#__PURE__*/
function () {
  function PositionCache() {
    classCallCheck_classCallCheck(this, PositionCache);

    defineProperty_defineProperty(this, "_columnSizeMap", {});

    defineProperty_defineProperty(this, "_intervalTree", createWrapper());

    defineProperty_defineProperty(this, "_leftMap", {});
  }

  createClass_createClass(PositionCache, [{
    key: "estimateTotalHeight",
    value: function estimateTotalHeight(cellCount, columnCount, defaultCellHeight) {
      var unmeasuredCellCount = cellCount - this.count;
      return this.tallestColumnSize + Math.ceil(unmeasuredCellCount / columnCount) * defaultCellHeight;
    } // Render all cells visible within the viewport range defined.

  }, {
    key: "range",
    value: function range(scrollTop, clientHeight, renderCallback) {
      var _this = this;

      this._intervalTree.queryInterval(scrollTop, scrollTop + clientHeight, function (_ref) {
        var _ref2 = _slicedToArray(_ref, 3),
            top = _ref2[0],
            _ = _ref2[1],
            index = _ref2[2];

        return renderCallback(index, _this._leftMap[index], top);
      });
    }
  }, {
    key: "setPosition",
    value: function setPosition(index, left, top, height) {
      this._intervalTree.insert([top, top + height, index]);

      this._leftMap[index] = left;
      var columnSizeMap = this._columnSizeMap;
      var columnHeight = columnSizeMap[left];

      if (columnHeight === undefined) {
        columnSizeMap[left] = top + height;
      } else {
        columnSizeMap[left] = Math.max(columnHeight, top + height);
      }
    }
  }, {
    key: "count",
    get: function get() {
      return this._intervalTree.count;
    }
  }, {
    key: "shortestColumnSize",
    get: function get() {
      var columnSizeMap = this._columnSizeMap;
      var size = 0;

      for (var i in columnSizeMap) {
        var height = columnSizeMap[i];
        size = size === 0 ? height : Math.min(size, height);
      }

      return size;
    }
  }, {
    key: "tallestColumnSize",
    get: function get() {
      var columnSizeMap = this._columnSizeMap;
      var size = 0;

      for (var i in columnSizeMap) {
        var height = columnSizeMap[i];
        size = Math.max(size, height);
      }

      return size;
    }
  }]);

  return PositionCache;
}();


;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Masonry/Masonry.js








var Masonry_class, Masonry_temp;

function Masonry_ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); keys.push.apply(keys, symbols); } return keys; }

function Masonry_objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { Masonry_ownKeys(source, true).forEach(function (key) { defineProperty_defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { Masonry_ownKeys(source).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }






var emptyObject = {};
/**
 * Specifies the number of miliseconds during which to disable pointer events while a scroll is in progress.
 * This improves performance and makes scrolling smoother.
 */

var Masonry_DEFAULT_SCROLLING_RESET_TIME_INTERVAL = 150;
/**
 * This component efficiently displays arbitrarily positioned cells using windowing techniques.
 * Cell position is determined by an injected `cellPositioner` property.
 * Windowing is vertical; this component does not support horizontal scrolling.
 *
 * Rendering occurs in two phases:
 * 1) First pass uses estimated cell sizes (provided by the cache) to determine how many cells to measure in a batch.
 *    Batch size is chosen using a fast, naive layout algorithm that stacks images in order until the viewport has been filled.
 *    After measurement is complete (componentDidMount or componentDidUpdate) this component evaluates positioned cells
 *    in order to determine if another measurement pass is required (eg if actual cell sizes were less than estimated sizes).
 *    All measurements are permanently cached (keyed by `keyMapper`) for performance purposes.
 * 2) Second pass uses the external `cellPositioner` to layout cells.
 *    At this time the positioner has access to cached size measurements for all cells.
 *    The positions it returns are cached by Masonry for fast access later.
 *    Phase one is repeated if the user scrolls beyond the current layout's bounds.
 *    If the layout is invalidated due to eg a resize, cached positions can be cleared using `recomputeCellPositions()`.
 *
 * Animation constraints:
 *   Simple animations are supported (eg translate/slide into place on initial reveal).
 *   More complex animations are not (eg flying from one position to another on resize).
 *
 * Layout constraints:
 *   This component supports multi-column layout.
 *   The height of each item may vary.
 *   The width of each item must not exceed the width of the column it is "in".
 *   The left position of all items within a column must align.
 *   (Items may not span multiple columns.)
 */

var Masonry_Masonry = (Masonry_temp = Masonry_class =
/*#__PURE__*/
function (_React$PureComponent) {
  _inherits(Masonry, _React$PureComponent);

  function Masonry() {
    var _getPrototypeOf2;

    var _this;

    classCallCheck_classCallCheck(this, Masonry);

    for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
      args[_key] = arguments[_key];
    }

    _this = _possibleConstructorReturn(this, (_getPrototypeOf2 = _getPrototypeOf(Masonry)).call.apply(_getPrototypeOf2, [this].concat(args)));

    defineProperty_defineProperty(_assertThisInitialized(_this), "state", {
      isScrolling: false,
      scrollTop: 0
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_debounceResetIsScrollingId", void 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_invalidateOnUpdateStartIndex", null);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_invalidateOnUpdateStopIndex", null);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_positionCache", new PositionCache());

    defineProperty_defineProperty(_assertThisInitialized(_this), "_startIndex", null);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_startIndexMemoized", null);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_stopIndex", null);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_stopIndexMemoized", null);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_debounceResetIsScrollingCallback", function () {
      _this.setState({
        isScrolling: false
      });
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_setScrollingContainerRef", function (ref) {
      _this._scrollingContainer = ref;
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_onScroll", function (event) {
      var height = _this.props.height;
      var eventScrollTop = event.currentTarget.scrollTop; // When this component is shrunk drastically, React dispatches a series of back-to-back scroll events,
      // Gradually converging on a scrollTop that is within the bounds of the new, smaller height.
      // This causes a series of rapid renders that is slow for long lists.
      // We can avoid that by doing some simple bounds checking to ensure that scroll offsets never exceed their bounds.

      var scrollTop = Math.min(Math.max(0, _this._getEstimatedTotalHeight() - height), eventScrollTop); // On iOS, we can arrive at negative offsets by swiping past the start or end.
      // Avoid re-rendering in this case as it can cause problems; see #532 for more.

      if (eventScrollTop !== scrollTop) {
        return;
      } // Prevent pointer events from interrupting a smooth scroll


      _this._debounceResetIsScrolling(); // Certain devices (like Apple touchpad) rapid-fire duplicate events.
      // Don't force a re-render if this is the case.
      // The mouse may move faster then the animation frame does.
      // Use requestAnimationFrame to avoid over-updating.


      if (_this.state.scrollTop !== scrollTop) {
        _this.setState({
          isScrolling: true,
          scrollTop: scrollTop
        });
      }
    });

    return _this;
  }

  createClass_createClass(Masonry, [{
    key: "clearCellPositions",
    value: function clearCellPositions() {
      this._positionCache = new PositionCache();
      this.forceUpdate();
    } // HACK This method signature was intended for Grid

  }, {
    key: "invalidateCellSizeAfterRender",
    value: function invalidateCellSizeAfterRender(_ref) {
      var index = _ref.rowIndex;

      if (this._invalidateOnUpdateStartIndex === null) {
        this._invalidateOnUpdateStartIndex = index;
        this._invalidateOnUpdateStopIndex = index;
      } else {
        this._invalidateOnUpdateStartIndex = Math.min(this._invalidateOnUpdateStartIndex, index);
        this._invalidateOnUpdateStopIndex = Math.max(this._invalidateOnUpdateStopIndex, index);
      }
    }
  }, {
    key: "recomputeCellPositions",
    value: function recomputeCellPositions() {
      var stopIndex = this._positionCache.count - 1;
      this._positionCache = new PositionCache();

      this._populatePositionCache(0, stopIndex);

      this.forceUpdate();
    }
  }, {
    key: "componentDidMount",
    value: function componentDidMount() {
      this._checkInvalidateOnUpdate();

      this._invokeOnScrollCallback();

      this._invokeOnCellsRenderedCallback();
    }
  }, {
    key: "componentDidUpdate",
    value: function componentDidUpdate(prevProps, prevState) {
      this._checkInvalidateOnUpdate();

      this._invokeOnScrollCallback();

      this._invokeOnCellsRenderedCallback();

      if (this.props.scrollTop !== prevProps.scrollTop) {
        this._debounceResetIsScrolling();
      }
    }
  }, {
    key: "componentWillUnmount",
    value: function componentWillUnmount() {
      if (this._debounceResetIsScrollingId) {
        cancelAnimationTimeout(this._debounceResetIsScrollingId);
      }
    }
  }, {
    key: "render",
    value: function render() {
      var _this2 = this;

      var _this$props = this.props,
          autoHeight = _this$props.autoHeight,
          cellCount = _this$props.cellCount,
          cellMeasurerCache = _this$props.cellMeasurerCache,
          cellRenderer = _this$props.cellRenderer,
          className = _this$props.className,
          height = _this$props.height,
          id = _this$props.id,
          keyMapper = _this$props.keyMapper,
          overscanByPixels = _this$props.overscanByPixels,
          role = _this$props.role,
          style = _this$props.style,
          tabIndex = _this$props.tabIndex,
          width = _this$props.width,
          rowDirection = _this$props.rowDirection;
      var _this$state = this.state,
          isScrolling = _this$state.isScrolling,
          scrollTop = _this$state.scrollTop;
      var children = [];

      var estimateTotalHeight = this._getEstimatedTotalHeight();

      var shortestColumnSize = this._positionCache.shortestColumnSize;
      var measuredCellCount = this._positionCache.count;
      var startIndex = 0;
      var stopIndex;

      this._positionCache.range(Math.max(0, scrollTop - overscanByPixels), height + overscanByPixels * 2, function (index, left, top) {
        var _style;

        if (typeof stopIndex === 'undefined') {
          startIndex = index;
          stopIndex = index;
        } else {
          startIndex = Math.min(startIndex, index);
          stopIndex = Math.max(stopIndex, index);
        }

        children.push(cellRenderer({
          index: index,
          isScrolling: isScrolling,
          key: keyMapper(index),
          parent: _this2,
          style: (_style = {
            height: cellMeasurerCache.getHeight(index)
          }, defineProperty_defineProperty(_style, rowDirection === 'ltr' ? 'left' : 'right', left), defineProperty_defineProperty(_style, "position", 'absolute'), defineProperty_defineProperty(_style, "top", top), defineProperty_defineProperty(_style, "width", cellMeasurerCache.getWidth(index)), _style)
        }));
      }); // We need to measure additional cells for this layout


      if (shortestColumnSize < scrollTop + height + overscanByPixels && measuredCellCount < cellCount) {
        var batchSize = Math.min(cellCount - measuredCellCount, Math.ceil((scrollTop + height + overscanByPixels - shortestColumnSize) / cellMeasurerCache.defaultHeight * width / cellMeasurerCache.defaultWidth));

        for (var _index = measuredCellCount; _index < measuredCellCount + batchSize; _index++) {
          stopIndex = _index;
          children.push(cellRenderer({
            index: _index,
            isScrolling: isScrolling,
            key: keyMapper(_index),
            parent: this,
            style: {
              width: cellMeasurerCache.getWidth(_index)
            }
          }));
        }
      }

      this._startIndex = startIndex;
      this._stopIndex = stopIndex;
      return react.createElement("div", {
        ref: this._setScrollingContainerRef,
        "aria-label": this.props['aria-label'],
        className: clsx_m('ReactVirtualized__Masonry', className),
        id: id,
        onScroll: this._onScroll,
        role: role,
        style: Masonry_objectSpread({
          boxSizing: 'border-box',
          direction: 'ltr',
          height: autoHeight ? 'auto' : height,
          overflowX: 'hidden',
          overflowY: estimateTotalHeight < height ? 'hidden' : 'auto',
          position: 'relative',
          width: width,
          WebkitOverflowScrolling: 'touch',
          willChange: 'transform'
        }, style),
        tabIndex: tabIndex
      }, react.createElement("div", {
        className: "ReactVirtualized__Masonry__innerScrollContainer",
        style: {
          width: '100%',
          height: estimateTotalHeight,
          maxWidth: '100%',
          maxHeight: estimateTotalHeight,
          overflow: 'hidden',
          pointerEvents: isScrolling ? 'none' : '',
          position: 'relative'
        }
      }, children));
    }
  }, {
    key: "_checkInvalidateOnUpdate",
    value: function _checkInvalidateOnUpdate() {
      if (typeof this._invalidateOnUpdateStartIndex === 'number') {
        var startIndex = this._invalidateOnUpdateStartIndex;
        var stopIndex = this._invalidateOnUpdateStopIndex;
        this._invalidateOnUpdateStartIndex = null;
        this._invalidateOnUpdateStopIndex = null; // Query external layout logic for position of newly-measured cells

        this._populatePositionCache(startIndex, stopIndex);

        this.forceUpdate();
      }
    }
  }, {
    key: "_debounceResetIsScrolling",
    value: function _debounceResetIsScrolling() {
      var scrollingResetTimeInterval = this.props.scrollingResetTimeInterval;

      if (this._debounceResetIsScrollingId) {
        cancelAnimationTimeout(this._debounceResetIsScrollingId);
      }

      this._debounceResetIsScrollingId = requestAnimationTimeout(this._debounceResetIsScrollingCallback, scrollingResetTimeInterval);
    }
  }, {
    key: "_getEstimatedTotalHeight",
    value: function _getEstimatedTotalHeight() {
      var _this$props2 = this.props,
          cellCount = _this$props2.cellCount,
          cellMeasurerCache = _this$props2.cellMeasurerCache,
          width = _this$props2.width;
      var estimatedColumnCount = Math.max(1, Math.floor(width / cellMeasurerCache.defaultWidth));
      return this._positionCache.estimateTotalHeight(cellCount, estimatedColumnCount, cellMeasurerCache.defaultHeight);
    }
  }, {
    key: "_invokeOnScrollCallback",
    value: function _invokeOnScrollCallback() {
      var _this$props3 = this.props,
          height = _this$props3.height,
          onScroll = _this$props3.onScroll;
      var scrollTop = this.state.scrollTop;

      if (this._onScrollMemoized !== scrollTop) {
        onScroll({
          clientHeight: height,
          scrollHeight: this._getEstimatedTotalHeight(),
          scrollTop: scrollTop
        });
        this._onScrollMemoized = scrollTop;
      }
    }
  }, {
    key: "_invokeOnCellsRenderedCallback",
    value: function _invokeOnCellsRenderedCallback() {
      if (this._startIndexMemoized !== this._startIndex || this._stopIndexMemoized !== this._stopIndex) {
        var onCellsRendered = this.props.onCellsRendered;
        onCellsRendered({
          startIndex: this._startIndex,
          stopIndex: this._stopIndex
        });
        this._startIndexMemoized = this._startIndex;
        this._stopIndexMemoized = this._stopIndex;
      }
    }
  }, {
    key: "_populatePositionCache",
    value: function _populatePositionCache(startIndex, stopIndex) {
      var _this$props4 = this.props,
          cellMeasurerCache = _this$props4.cellMeasurerCache,
          cellPositioner = _this$props4.cellPositioner;

      for (var _index2 = startIndex; _index2 <= stopIndex; _index2++) {
        var _cellPositioner = cellPositioner(_index2),
            left = _cellPositioner.left,
            top = _cellPositioner.top;

        this._positionCache.setPosition(_index2, left, top, cellMeasurerCache.getHeight(_index2));
      }
    }
  }], [{
    key: "getDerivedStateFromProps",
    value: function getDerivedStateFromProps(nextProps, prevState) {
      if (nextProps.scrollTop !== undefined && prevState.scrollTop !== nextProps.scrollTop) {
        return {
          isScrolling: true,
          scrollTop: nextProps.scrollTop
        };
      }

      return null;
    }
  }]);

  return Masonry;
}(react.PureComponent), defineProperty_defineProperty(Masonry_class, "propTypes",  true ? null : 0), Masonry_temp);

defineProperty_defineProperty(Masonry_Masonry, "defaultProps", {
  autoHeight: false,
  keyMapper: identity,
  onCellsRendered: Masonry_noop,
  onScroll: Masonry_noop,
  overscanByPixels: 20,
  role: 'grid',
  scrollingResetTimeInterval: Masonry_DEFAULT_SCROLLING_RESET_TIME_INTERVAL,
  style: emptyObject,
  tabIndex: 0,
  rowDirection: 'ltr'
});

function identity(value) {
  return value;
}

function Masonry_noop() {}

var bpfrpt_proptype_CellMeasurerCache =  true ? null : 0;
react_lifecycles_compat_es_polyfill(Masonry_Masonry);
/* harmony default export */ const es_Masonry_Masonry = ((/* unused pure expression or super */ null && (Masonry_Masonry)));
var bpfrpt_proptype_Positioner =  true ? null : 0;




;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Masonry/createCellPositioner.js
function createCellPositioner(_ref) {
  var cellMeasurerCache = _ref.cellMeasurerCache,
      columnCount = _ref.columnCount,
      columnWidth = _ref.columnWidth,
      _ref$spacer = _ref.spacer,
      spacer = _ref$spacer === void 0 ? 0 : _ref$spacer;
  var columnHeights;
  initOrResetDerivedValues();

  function cellPositioner(index) {
    // Find the shortest column and use it.
    var columnIndex = 0;

    for (var i = 1; i < columnHeights.length; i++) {
      if (columnHeights[i] < columnHeights[columnIndex]) {
        columnIndex = i;
      }
    }

    var left = columnIndex * (columnWidth + spacer);
    var top = columnHeights[columnIndex] || 0;
    columnHeights[columnIndex] = top + cellMeasurerCache.getHeight(index) + spacer;
    return {
      left: left,
      top: top
    };
  }

  function initOrResetDerivedValues() {
    // Track the height of each column.
    // Layout algorithm below always inserts into the shortest column.
    columnHeights = [];

    for (var i = 0; i < columnCount; i++) {
      columnHeights[i] = 0;
    }
  }

  function reset(params) {
    columnCount = params.columnCount;
    columnWidth = params.columnWidth;
    spacer = params.spacer;
    initOrResetDerivedValues();
  }

  cellPositioner.reset = reset;
  return cellPositioner;
}


;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Masonry/index.js


/* harmony default export */ const es_Masonry = ((/* unused pure expression or super */ null && (Masonry)));

;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/MultiGrid/CellMeasurerCacheDecorator.js





/**
 * Caches measurements for a given cell.
 */
var CellMeasurerCacheDecorator =
/*#__PURE__*/
function () {
  function CellMeasurerCacheDecorator() {
    var _this = this;

    var params = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

    classCallCheck_classCallCheck(this, CellMeasurerCacheDecorator);

    defineProperty_defineProperty(this, "_cellMeasurerCache", void 0);

    defineProperty_defineProperty(this, "_columnIndexOffset", void 0);

    defineProperty_defineProperty(this, "_rowIndexOffset", void 0);

    defineProperty_defineProperty(this, "columnWidth", function (_ref) {
      var index = _ref.index;

      _this._cellMeasurerCache.columnWidth({
        index: index + _this._columnIndexOffset
      });
    });

    defineProperty_defineProperty(this, "rowHeight", function (_ref2) {
      var index = _ref2.index;

      _this._cellMeasurerCache.rowHeight({
        index: index + _this._rowIndexOffset
      });
    });

    var cellMeasurerCache = params.cellMeasurerCache,
        _params$columnIndexOf = params.columnIndexOffset,
        columnIndexOffset = _params$columnIndexOf === void 0 ? 0 : _params$columnIndexOf,
        _params$rowIndexOffse = params.rowIndexOffset,
        rowIndexOffset = _params$rowIndexOffse === void 0 ? 0 : _params$rowIndexOffse;
    this._cellMeasurerCache = cellMeasurerCache;
    this._columnIndexOffset = columnIndexOffset;
    this._rowIndexOffset = rowIndexOffset;
  }

  createClass_createClass(CellMeasurerCacheDecorator, [{
    key: "clear",
    value: function clear(rowIndex, columnIndex) {
      this._cellMeasurerCache.clear(rowIndex + this._rowIndexOffset, columnIndex + this._columnIndexOffset);
    }
  }, {
    key: "clearAll",
    value: function clearAll() {
      this._cellMeasurerCache.clearAll();
    }
  }, {
    key: "hasFixedHeight",
    value: function hasFixedHeight() {
      return this._cellMeasurerCache.hasFixedHeight();
    }
  }, {
    key: "hasFixedWidth",
    value: function hasFixedWidth() {
      return this._cellMeasurerCache.hasFixedWidth();
    }
  }, {
    key: "getHeight",
    value: function getHeight(rowIndex) {
      var columnIndex = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 0;
      return this._cellMeasurerCache.getHeight(rowIndex + this._rowIndexOffset, columnIndex + this._columnIndexOffset);
    }
  }, {
    key: "getWidth",
    value: function getWidth(rowIndex) {
      var columnIndex = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 0;
      return this._cellMeasurerCache.getWidth(rowIndex + this._rowIndexOffset, columnIndex + this._columnIndexOffset);
    }
  }, {
    key: "has",
    value: function has(rowIndex) {
      var columnIndex = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 0;
      return this._cellMeasurerCache.has(rowIndex + this._rowIndexOffset, columnIndex + this._columnIndexOffset);
    }
  }, {
    key: "set",
    value: function set(rowIndex, columnIndex, width, height) {
      this._cellMeasurerCache.set(rowIndex + this._rowIndexOffset, columnIndex + this._columnIndexOffset, width, height);
    }
  }, {
    key: "defaultHeight",
    get: function get() {
      return this._cellMeasurerCache.defaultHeight;
    }
  }, {
    key: "defaultWidth",
    get: function get() {
      return this._cellMeasurerCache.defaultWidth;
    }
  }]);

  return CellMeasurerCacheDecorator;
}();


;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/MultiGrid/MultiGrid.js










function MultiGrid_ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); keys.push.apply(keys, symbols); } return keys; }

function MultiGrid_objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { MultiGrid_ownKeys(source, true).forEach(function (key) { defineProperty_defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { MultiGrid_ownKeys(source).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }






var SCROLLBAR_SIZE_BUFFER = 20;
/**
 * Renders 1, 2, or 4 Grids depending on configuration.
 * A main (body) Grid will always be rendered.
 * Optionally, 1-2 Grids for sticky header rows will also be rendered.
 * If no sticky columns, only 1 sticky header Grid will be rendered.
 * If sticky columns, 2 sticky header Grids will be rendered.
 */

var MultiGrid_MultiGrid =
/*#__PURE__*/
function (_React$PureComponent) {
  _inherits(MultiGrid, _React$PureComponent);

  function MultiGrid(props, context) {
    var _this;

    classCallCheck_classCallCheck(this, MultiGrid);

    _this = _possibleConstructorReturn(this, _getPrototypeOf(MultiGrid).call(this, props, context));

    defineProperty_defineProperty(_assertThisInitialized(_this), "state", {
      scrollLeft: 0,
      scrollTop: 0,
      scrollbarSize: 0,
      showHorizontalScrollbar: false,
      showVerticalScrollbar: false
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_deferredInvalidateColumnIndex", null);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_deferredInvalidateRowIndex", null);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_bottomLeftGridRef", function (ref) {
      _this._bottomLeftGrid = ref;
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_bottomRightGridRef", function (ref) {
      _this._bottomRightGrid = ref;
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_cellRendererBottomLeftGrid", function (_ref) {
      var rowIndex = _ref.rowIndex,
          rest = _objectWithoutProperties(_ref, ["rowIndex"]);

      var _this$props = _this.props,
          cellRenderer = _this$props.cellRenderer,
          fixedRowCount = _this$props.fixedRowCount,
          rowCount = _this$props.rowCount;

      if (rowIndex === rowCount - fixedRowCount) {
        return react.createElement("div", {
          key: rest.key,
          style: MultiGrid_objectSpread({}, rest.style, {
            height: SCROLLBAR_SIZE_BUFFER
          })
        });
      } else {
        return cellRenderer(MultiGrid_objectSpread({}, rest, {
          parent: _assertThisInitialized(_this),
          rowIndex: rowIndex + fixedRowCount
        }));
      }
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_cellRendererBottomRightGrid", function (_ref2) {
      var columnIndex = _ref2.columnIndex,
          rowIndex = _ref2.rowIndex,
          rest = _objectWithoutProperties(_ref2, ["columnIndex", "rowIndex"]);

      var _this$props2 = _this.props,
          cellRenderer = _this$props2.cellRenderer,
          fixedColumnCount = _this$props2.fixedColumnCount,
          fixedRowCount = _this$props2.fixedRowCount;
      return cellRenderer(MultiGrid_objectSpread({}, rest, {
        columnIndex: columnIndex + fixedColumnCount,
        parent: _assertThisInitialized(_this),
        rowIndex: rowIndex + fixedRowCount
      }));
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_cellRendererTopRightGrid", function (_ref3) {
      var columnIndex = _ref3.columnIndex,
          rest = _objectWithoutProperties(_ref3, ["columnIndex"]);

      var _this$props3 = _this.props,
          cellRenderer = _this$props3.cellRenderer,
          columnCount = _this$props3.columnCount,
          fixedColumnCount = _this$props3.fixedColumnCount;

      if (columnIndex === columnCount - fixedColumnCount) {
        return react.createElement("div", {
          key: rest.key,
          style: MultiGrid_objectSpread({}, rest.style, {
            width: SCROLLBAR_SIZE_BUFFER
          })
        });
      } else {
        return cellRenderer(MultiGrid_objectSpread({}, rest, {
          columnIndex: columnIndex + fixedColumnCount,
          parent: _assertThisInitialized(_this)
        }));
      }
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_columnWidthRightGrid", function (_ref4) {
      var index = _ref4.index;
      var _this$props4 = _this.props,
          columnCount = _this$props4.columnCount,
          fixedColumnCount = _this$props4.fixedColumnCount,
          columnWidth = _this$props4.columnWidth;
      var _this$state = _this.state,
          scrollbarSize = _this$state.scrollbarSize,
          showHorizontalScrollbar = _this$state.showHorizontalScrollbar; // An extra cell is added to the count
      // This gives the smaller Grid extra room for offset,
      // In case the main (bottom right) Grid has a scrollbar
      // If no scrollbar, the extra space is overflow:hidden anyway

      if (showHorizontalScrollbar && index === columnCount - fixedColumnCount) {
        return scrollbarSize;
      }

      return typeof columnWidth === 'function' ? columnWidth({
        index: index + fixedColumnCount
      }) : columnWidth;
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_onScroll", function (scrollInfo) {
      var scrollLeft = scrollInfo.scrollLeft,
          scrollTop = scrollInfo.scrollTop;

      _this.setState({
        scrollLeft: scrollLeft,
        scrollTop: scrollTop
      });

      var onScroll = _this.props.onScroll;

      if (onScroll) {
        onScroll(scrollInfo);
      }
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_onScrollbarPresenceChange", function (_ref5) {
      var horizontal = _ref5.horizontal,
          size = _ref5.size,
          vertical = _ref5.vertical;
      var _this$state2 = _this.state,
          showHorizontalScrollbar = _this$state2.showHorizontalScrollbar,
          showVerticalScrollbar = _this$state2.showVerticalScrollbar;

      if (horizontal !== showHorizontalScrollbar || vertical !== showVerticalScrollbar) {
        _this.setState({
          scrollbarSize: size,
          showHorizontalScrollbar: horizontal,
          showVerticalScrollbar: vertical
        });

        var onScrollbarPresenceChange = _this.props.onScrollbarPresenceChange;

        if (typeof onScrollbarPresenceChange === 'function') {
          onScrollbarPresenceChange({
            horizontal: horizontal,
            size: size,
            vertical: vertical
          });
        }
      }
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_onScrollLeft", function (scrollInfo) {
      var scrollLeft = scrollInfo.scrollLeft;

      _this._onScroll({
        scrollLeft: scrollLeft,
        scrollTop: _this.state.scrollTop
      });
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_onScrollTop", function (scrollInfo) {
      var scrollTop = scrollInfo.scrollTop;

      _this._onScroll({
        scrollTop: scrollTop,
        scrollLeft: _this.state.scrollLeft
      });
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_rowHeightBottomGrid", function (_ref6) {
      var index = _ref6.index;
      var _this$props5 = _this.props,
          fixedRowCount = _this$props5.fixedRowCount,
          rowCount = _this$props5.rowCount,
          rowHeight = _this$props5.rowHeight;
      var _this$state3 = _this.state,
          scrollbarSize = _this$state3.scrollbarSize,
          showVerticalScrollbar = _this$state3.showVerticalScrollbar; // An extra cell is added to the count
      // This gives the smaller Grid extra room for offset,
      // In case the main (bottom right) Grid has a scrollbar
      // If no scrollbar, the extra space is overflow:hidden anyway

      if (showVerticalScrollbar && index === rowCount - fixedRowCount) {
        return scrollbarSize;
      }

      return typeof rowHeight === 'function' ? rowHeight({
        index: index + fixedRowCount
      }) : rowHeight;
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_topLeftGridRef", function (ref) {
      _this._topLeftGrid = ref;
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_topRightGridRef", function (ref) {
      _this._topRightGrid = ref;
    });

    var deferredMeasurementCache = props.deferredMeasurementCache,
        _fixedColumnCount = props.fixedColumnCount,
        _fixedRowCount = props.fixedRowCount;

    _this._maybeCalculateCachedStyles(true);

    if (deferredMeasurementCache) {
      _this._deferredMeasurementCacheBottomLeftGrid = _fixedRowCount > 0 ? new CellMeasurerCacheDecorator({
        cellMeasurerCache: deferredMeasurementCache,
        columnIndexOffset: 0,
        rowIndexOffset: _fixedRowCount
      }) : deferredMeasurementCache;
      _this._deferredMeasurementCacheBottomRightGrid = _fixedColumnCount > 0 || _fixedRowCount > 0 ? new CellMeasurerCacheDecorator({
        cellMeasurerCache: deferredMeasurementCache,
        columnIndexOffset: _fixedColumnCount,
        rowIndexOffset: _fixedRowCount
      }) : deferredMeasurementCache;
      _this._deferredMeasurementCacheTopRightGrid = _fixedColumnCount > 0 ? new CellMeasurerCacheDecorator({
        cellMeasurerCache: deferredMeasurementCache,
        columnIndexOffset: _fixedColumnCount,
        rowIndexOffset: 0
      }) : deferredMeasurementCache;
    }

    return _this;
  }

  createClass_createClass(MultiGrid, [{
    key: "forceUpdateGrids",
    value: function forceUpdateGrids() {
      this._bottomLeftGrid && this._bottomLeftGrid.forceUpdate();
      this._bottomRightGrid && this._bottomRightGrid.forceUpdate();
      this._topLeftGrid && this._topLeftGrid.forceUpdate();
      this._topRightGrid && this._topRightGrid.forceUpdate();
    }
    /** See Grid#invalidateCellSizeAfterRender */

  }, {
    key: "invalidateCellSizeAfterRender",
    value: function invalidateCellSizeAfterRender() {
      var _ref7 = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {},
          _ref7$columnIndex = _ref7.columnIndex,
          columnIndex = _ref7$columnIndex === void 0 ? 0 : _ref7$columnIndex,
          _ref7$rowIndex = _ref7.rowIndex,
          rowIndex = _ref7$rowIndex === void 0 ? 0 : _ref7$rowIndex;

      this._deferredInvalidateColumnIndex = typeof this._deferredInvalidateColumnIndex === 'number' ? Math.min(this._deferredInvalidateColumnIndex, columnIndex) : columnIndex;
      this._deferredInvalidateRowIndex = typeof this._deferredInvalidateRowIndex === 'number' ? Math.min(this._deferredInvalidateRowIndex, rowIndex) : rowIndex;
    }
    /** See Grid#measureAllCells */

  }, {
    key: "measureAllCells",
    value: function measureAllCells() {
      this._bottomLeftGrid && this._bottomLeftGrid.measureAllCells();
      this._bottomRightGrid && this._bottomRightGrid.measureAllCells();
      this._topLeftGrid && this._topLeftGrid.measureAllCells();
      this._topRightGrid && this._topRightGrid.measureAllCells();
    }
    /** See Grid#recomputeGridSize */

  }, {
    key: "recomputeGridSize",
    value: function recomputeGridSize() {
      var _ref8 = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {},
          _ref8$columnIndex = _ref8.columnIndex,
          columnIndex = _ref8$columnIndex === void 0 ? 0 : _ref8$columnIndex,
          _ref8$rowIndex = _ref8.rowIndex,
          rowIndex = _ref8$rowIndex === void 0 ? 0 : _ref8$rowIndex;

      var _this$props6 = this.props,
          fixedColumnCount = _this$props6.fixedColumnCount,
          fixedRowCount = _this$props6.fixedRowCount;
      var adjustedColumnIndex = Math.max(0, columnIndex - fixedColumnCount);
      var adjustedRowIndex = Math.max(0, rowIndex - fixedRowCount);
      this._bottomLeftGrid && this._bottomLeftGrid.recomputeGridSize({
        columnIndex: columnIndex,
        rowIndex: adjustedRowIndex
      });
      this._bottomRightGrid && this._bottomRightGrid.recomputeGridSize({
        columnIndex: adjustedColumnIndex,
        rowIndex: adjustedRowIndex
      });
      this._topLeftGrid && this._topLeftGrid.recomputeGridSize({
        columnIndex: columnIndex,
        rowIndex: rowIndex
      });
      this._topRightGrid && this._topRightGrid.recomputeGridSize({
        columnIndex: adjustedColumnIndex,
        rowIndex: rowIndex
      });
      this._leftGridWidth = null;
      this._topGridHeight = null;

      this._maybeCalculateCachedStyles(true);
    }
  }, {
    key: "componentDidMount",
    value: function componentDidMount() {
      var _this$props7 = this.props,
          scrollLeft = _this$props7.scrollLeft,
          scrollTop = _this$props7.scrollTop;

      if (scrollLeft > 0 || scrollTop > 0) {
        var newState = {};

        if (scrollLeft > 0) {
          newState.scrollLeft = scrollLeft;
        }

        if (scrollTop > 0) {
          newState.scrollTop = scrollTop;
        }

        this.setState(newState);
      }

      this._handleInvalidatedGridSize();
    }
  }, {
    key: "componentDidUpdate",
    value: function componentDidUpdate() {
      this._handleInvalidatedGridSize();
    }
  }, {
    key: "render",
    value: function render() {
      var _this$props8 = this.props,
          onScroll = _this$props8.onScroll,
          onSectionRendered = _this$props8.onSectionRendered,
          onScrollbarPresenceChange = _this$props8.onScrollbarPresenceChange,
          scrollLeftProp = _this$props8.scrollLeft,
          scrollToColumn = _this$props8.scrollToColumn,
          scrollTopProp = _this$props8.scrollTop,
          scrollToRow = _this$props8.scrollToRow,
          rest = _objectWithoutProperties(_this$props8, ["onScroll", "onSectionRendered", "onScrollbarPresenceChange", "scrollLeft", "scrollToColumn", "scrollTop", "scrollToRow"]);

      this._prepareForRender(); // Don't render any of our Grids if there are no cells.
      // This mirrors what Grid does,
      // And prevents us from recording inaccurage measurements when used with CellMeasurer.


      if (this.props.width === 0 || this.props.height === 0) {
        return null;
      } // scrollTop and scrollLeft props are explicitly filtered out and ignored


      var _this$state4 = this.state,
          scrollLeft = _this$state4.scrollLeft,
          scrollTop = _this$state4.scrollTop;
      return react.createElement("div", {
        style: this._containerOuterStyle
      }, react.createElement("div", {
        style: this._containerTopStyle
      }, this._renderTopLeftGrid(rest), this._renderTopRightGrid(MultiGrid_objectSpread({}, rest, {
        onScroll: onScroll,
        scrollLeft: scrollLeft
      }))), react.createElement("div", {
        style: this._containerBottomStyle
      }, this._renderBottomLeftGrid(MultiGrid_objectSpread({}, rest, {
        onScroll: onScroll,
        scrollTop: scrollTop
      })), this._renderBottomRightGrid(MultiGrid_objectSpread({}, rest, {
        onScroll: onScroll,
        onSectionRendered: onSectionRendered,
        scrollLeft: scrollLeft,
        scrollToColumn: scrollToColumn,
        scrollToRow: scrollToRow,
        scrollTop: scrollTop
      }))));
    }
  }, {
    key: "_getBottomGridHeight",
    value: function _getBottomGridHeight(props) {
      var height = props.height;

      var topGridHeight = this._getTopGridHeight(props);

      return height - topGridHeight;
    }
  }, {
    key: "_getLeftGridWidth",
    value: function _getLeftGridWidth(props) {
      var fixedColumnCount = props.fixedColumnCount,
          columnWidth = props.columnWidth;

      if (this._leftGridWidth == null) {
        if (typeof columnWidth === 'function') {
          var leftGridWidth = 0;

          for (var index = 0; index < fixedColumnCount; index++) {
            leftGridWidth += columnWidth({
              index: index
            });
          }

          this._leftGridWidth = leftGridWidth;
        } else {
          this._leftGridWidth = columnWidth * fixedColumnCount;
        }
      }

      return this._leftGridWidth;
    }
  }, {
    key: "_getRightGridWidth",
    value: function _getRightGridWidth(props) {
      var width = props.width;

      var leftGridWidth = this._getLeftGridWidth(props);

      return width - leftGridWidth;
    }
  }, {
    key: "_getTopGridHeight",
    value: function _getTopGridHeight(props) {
      var fixedRowCount = props.fixedRowCount,
          rowHeight = props.rowHeight;

      if (this._topGridHeight == null) {
        if (typeof rowHeight === 'function') {
          var topGridHeight = 0;

          for (var index = 0; index < fixedRowCount; index++) {
            topGridHeight += rowHeight({
              index: index
            });
          }

          this._topGridHeight = topGridHeight;
        } else {
          this._topGridHeight = rowHeight * fixedRowCount;
        }
      }

      return this._topGridHeight;
    }
  }, {
    key: "_handleInvalidatedGridSize",
    value: function _handleInvalidatedGridSize() {
      if (typeof this._deferredInvalidateColumnIndex === 'number') {
        var columnIndex = this._deferredInvalidateColumnIndex;
        var rowIndex = this._deferredInvalidateRowIndex;
        this._deferredInvalidateColumnIndex = null;
        this._deferredInvalidateRowIndex = null;
        this.recomputeGridSize({
          columnIndex: columnIndex,
          rowIndex: rowIndex
        });
        this.forceUpdate();
      }
    }
    /**
     * Avoid recreating inline styles each render; this bypasses Grid's shallowCompare.
     * This method recalculates styles only when specific props change.
     */

  }, {
    key: "_maybeCalculateCachedStyles",
    value: function _maybeCalculateCachedStyles(resetAll) {
      var _this$props9 = this.props,
          columnWidth = _this$props9.columnWidth,
          enableFixedColumnScroll = _this$props9.enableFixedColumnScroll,
          enableFixedRowScroll = _this$props9.enableFixedRowScroll,
          height = _this$props9.height,
          fixedColumnCount = _this$props9.fixedColumnCount,
          fixedRowCount = _this$props9.fixedRowCount,
          rowHeight = _this$props9.rowHeight,
          style = _this$props9.style,
          styleBottomLeftGrid = _this$props9.styleBottomLeftGrid,
          styleBottomRightGrid = _this$props9.styleBottomRightGrid,
          styleTopLeftGrid = _this$props9.styleTopLeftGrid,
          styleTopRightGrid = _this$props9.styleTopRightGrid,
          width = _this$props9.width;
      var sizeChange = resetAll || height !== this._lastRenderedHeight || width !== this._lastRenderedWidth;
      var leftSizeChange = resetAll || columnWidth !== this._lastRenderedColumnWidth || fixedColumnCount !== this._lastRenderedFixedColumnCount;
      var topSizeChange = resetAll || fixedRowCount !== this._lastRenderedFixedRowCount || rowHeight !== this._lastRenderedRowHeight;

      if (resetAll || sizeChange || style !== this._lastRenderedStyle) {
        this._containerOuterStyle = MultiGrid_objectSpread({
          height: height,
          overflow: 'visible',
          // Let :focus outline show through
          width: width
        }, style);
      }

      if (resetAll || sizeChange || topSizeChange) {
        this._containerTopStyle = {
          height: this._getTopGridHeight(this.props),
          position: 'relative',
          width: width
        };
        this._containerBottomStyle = {
          height: height - this._getTopGridHeight(this.props),
          overflow: 'visible',
          // Let :focus outline show through
          position: 'relative',
          width: width
        };
      }

      if (resetAll || styleBottomLeftGrid !== this._lastRenderedStyleBottomLeftGrid) {
        this._bottomLeftGridStyle = MultiGrid_objectSpread({
          left: 0,
          overflowX: 'hidden',
          overflowY: enableFixedColumnScroll ? 'auto' : 'hidden',
          position: 'absolute'
        }, styleBottomLeftGrid);
      }

      if (resetAll || leftSizeChange || styleBottomRightGrid !== this._lastRenderedStyleBottomRightGrid) {
        this._bottomRightGridStyle = MultiGrid_objectSpread({
          left: this._getLeftGridWidth(this.props),
          position: 'absolute'
        }, styleBottomRightGrid);
      }

      if (resetAll || styleTopLeftGrid !== this._lastRenderedStyleTopLeftGrid) {
        this._topLeftGridStyle = MultiGrid_objectSpread({
          left: 0,
          overflowX: 'hidden',
          overflowY: 'hidden',
          position: 'absolute',
          top: 0
        }, styleTopLeftGrid);
      }

      if (resetAll || leftSizeChange || styleTopRightGrid !== this._lastRenderedStyleTopRightGrid) {
        this._topRightGridStyle = MultiGrid_objectSpread({
          left: this._getLeftGridWidth(this.props),
          overflowX: enableFixedRowScroll ? 'auto' : 'hidden',
          overflowY: 'hidden',
          position: 'absolute',
          top: 0
        }, styleTopRightGrid);
      }

      this._lastRenderedColumnWidth = columnWidth;
      this._lastRenderedFixedColumnCount = fixedColumnCount;
      this._lastRenderedFixedRowCount = fixedRowCount;
      this._lastRenderedHeight = height;
      this._lastRenderedRowHeight = rowHeight;
      this._lastRenderedStyle = style;
      this._lastRenderedStyleBottomLeftGrid = styleBottomLeftGrid;
      this._lastRenderedStyleBottomRightGrid = styleBottomRightGrid;
      this._lastRenderedStyleTopLeftGrid = styleTopLeftGrid;
      this._lastRenderedStyleTopRightGrid = styleTopRightGrid;
      this._lastRenderedWidth = width;
    }
  }, {
    key: "_prepareForRender",
    value: function _prepareForRender() {
      if (this._lastRenderedColumnWidth !== this.props.columnWidth || this._lastRenderedFixedColumnCount !== this.props.fixedColumnCount) {
        this._leftGridWidth = null;
      }

      if (this._lastRenderedFixedRowCount !== this.props.fixedRowCount || this._lastRenderedRowHeight !== this.props.rowHeight) {
        this._topGridHeight = null;
      }

      this._maybeCalculateCachedStyles();

      this._lastRenderedColumnWidth = this.props.columnWidth;
      this._lastRenderedFixedColumnCount = this.props.fixedColumnCount;
      this._lastRenderedFixedRowCount = this.props.fixedRowCount;
      this._lastRenderedRowHeight = this.props.rowHeight;
    }
  }, {
    key: "_renderBottomLeftGrid",
    value: function _renderBottomLeftGrid(props) {
      var enableFixedColumnScroll = props.enableFixedColumnScroll,
          fixedColumnCount = props.fixedColumnCount,
          fixedRowCount = props.fixedRowCount,
          rowCount = props.rowCount,
          hideBottomLeftGridScrollbar = props.hideBottomLeftGridScrollbar;
      var showVerticalScrollbar = this.state.showVerticalScrollbar;

      if (!fixedColumnCount) {
        return null;
      }

      var additionalRowCount = showVerticalScrollbar ? 1 : 0,
          height = this._getBottomGridHeight(props),
          width = this._getLeftGridWidth(props),
          scrollbarSize = this.state.showVerticalScrollbar ? this.state.scrollbarSize : 0,
          gridWidth = hideBottomLeftGridScrollbar ? width + scrollbarSize : width;

      var bottomLeftGrid = react.createElement(Grid_Grid, extends_extends({}, props, {
        cellRenderer: this._cellRendererBottomLeftGrid,
        className: this.props.classNameBottomLeftGrid,
        columnCount: fixedColumnCount,
        deferredMeasurementCache: this._deferredMeasurementCacheBottomLeftGrid,
        height: height,
        onScroll: enableFixedColumnScroll ? this._onScrollTop : undefined,
        ref: this._bottomLeftGridRef,
        rowCount: Math.max(0, rowCount - fixedRowCount) + additionalRowCount,
        rowHeight: this._rowHeightBottomGrid,
        style: this._bottomLeftGridStyle,
        tabIndex: null,
        width: gridWidth
      }));

      if (hideBottomLeftGridScrollbar) {
        return react.createElement("div", {
          className: "BottomLeftGrid_ScrollWrapper",
          style: MultiGrid_objectSpread({}, this._bottomLeftGridStyle, {
            height: height,
            width: width,
            overflowY: 'hidden'
          })
        }, bottomLeftGrid);
      }

      return bottomLeftGrid;
    }
  }, {
    key: "_renderBottomRightGrid",
    value: function _renderBottomRightGrid(props) {
      var columnCount = props.columnCount,
          fixedColumnCount = props.fixedColumnCount,
          fixedRowCount = props.fixedRowCount,
          rowCount = props.rowCount,
          scrollToColumn = props.scrollToColumn,
          scrollToRow = props.scrollToRow;
      return react.createElement(Grid_Grid, extends_extends({}, props, {
        cellRenderer: this._cellRendererBottomRightGrid,
        className: this.props.classNameBottomRightGrid,
        columnCount: Math.max(0, columnCount - fixedColumnCount),
        columnWidth: this._columnWidthRightGrid,
        deferredMeasurementCache: this._deferredMeasurementCacheBottomRightGrid,
        height: this._getBottomGridHeight(props),
        onScroll: this._onScroll,
        onScrollbarPresenceChange: this._onScrollbarPresenceChange,
        ref: this._bottomRightGridRef,
        rowCount: Math.max(0, rowCount - fixedRowCount),
        rowHeight: this._rowHeightBottomGrid,
        scrollToColumn: scrollToColumn - fixedColumnCount,
        scrollToRow: scrollToRow - fixedRowCount,
        style: this._bottomRightGridStyle,
        width: this._getRightGridWidth(props)
      }));
    }
  }, {
    key: "_renderTopLeftGrid",
    value: function _renderTopLeftGrid(props) {
      var fixedColumnCount = props.fixedColumnCount,
          fixedRowCount = props.fixedRowCount;

      if (!fixedColumnCount || !fixedRowCount) {
        return null;
      }

      return react.createElement(Grid_Grid, extends_extends({}, props, {
        className: this.props.classNameTopLeftGrid,
        columnCount: fixedColumnCount,
        height: this._getTopGridHeight(props),
        ref: this._topLeftGridRef,
        rowCount: fixedRowCount,
        style: this._topLeftGridStyle,
        tabIndex: null,
        width: this._getLeftGridWidth(props)
      }));
    }
  }, {
    key: "_renderTopRightGrid",
    value: function _renderTopRightGrid(props) {
      var columnCount = props.columnCount,
          enableFixedRowScroll = props.enableFixedRowScroll,
          fixedColumnCount = props.fixedColumnCount,
          fixedRowCount = props.fixedRowCount,
          scrollLeft = props.scrollLeft,
          hideTopRightGridScrollbar = props.hideTopRightGridScrollbar;
      var _this$state5 = this.state,
          showHorizontalScrollbar = _this$state5.showHorizontalScrollbar,
          scrollbarSize = _this$state5.scrollbarSize;

      if (!fixedRowCount) {
        return null;
      }

      var additionalColumnCount = showHorizontalScrollbar ? 1 : 0,
          height = this._getTopGridHeight(props),
          width = this._getRightGridWidth(props),
          additionalHeight = showHorizontalScrollbar ? scrollbarSize : 0;

      var gridHeight = height,
          style = this._topRightGridStyle;

      if (hideTopRightGridScrollbar) {
        gridHeight = height + additionalHeight;
        style = MultiGrid_objectSpread({}, this._topRightGridStyle, {
          left: 0
        });
      }

      var topRightGrid = react.createElement(Grid_Grid, extends_extends({}, props, {
        cellRenderer: this._cellRendererTopRightGrid,
        className: this.props.classNameTopRightGrid,
        columnCount: Math.max(0, columnCount - fixedColumnCount) + additionalColumnCount,
        columnWidth: this._columnWidthRightGrid,
        deferredMeasurementCache: this._deferredMeasurementCacheTopRightGrid,
        height: gridHeight,
        onScroll: enableFixedRowScroll ? this._onScrollLeft : undefined,
        ref: this._topRightGridRef,
        rowCount: fixedRowCount,
        scrollLeft: scrollLeft,
        style: style,
        tabIndex: null,
        width: width
      }));

      if (hideTopRightGridScrollbar) {
        return react.createElement("div", {
          className: "TopRightGrid_ScrollWrapper",
          style: MultiGrid_objectSpread({}, this._topRightGridStyle, {
            height: height,
            width: width,
            overflowX: 'hidden'
          })
        }, topRightGrid);
      }

      return topRightGrid;
    }
  }], [{
    key: "getDerivedStateFromProps",
    value: function getDerivedStateFromProps(nextProps, prevState) {
      if (nextProps.scrollLeft !== prevState.scrollLeft || nextProps.scrollTop !== prevState.scrollTop) {
        return {
          scrollLeft: nextProps.scrollLeft != null && nextProps.scrollLeft >= 0 ? nextProps.scrollLeft : prevState.scrollLeft,
          scrollTop: nextProps.scrollTop != null && nextProps.scrollTop >= 0 ? nextProps.scrollTop : prevState.scrollTop
        };
      }

      return null;
    }
  }]);

  return MultiGrid;
}(react.PureComponent);

defineProperty_defineProperty(MultiGrid_MultiGrid, "defaultProps", {
  classNameBottomLeftGrid: '',
  classNameBottomRightGrid: '',
  classNameTopLeftGrid: '',
  classNameTopRightGrid: '',
  enableFixedColumnScroll: false,
  enableFixedRowScroll: false,
  fixedColumnCount: 0,
  fixedRowCount: 0,
  scrollToColumn: -1,
  scrollToRow: -1,
  style: {},
  styleBottomLeftGrid: {},
  styleBottomRightGrid: {},
  styleTopLeftGrid: {},
  styleTopRightGrid: {},
  hideTopRightGridScrollbar: false,
  hideBottomLeftGridScrollbar: false
});

MultiGrid_MultiGrid.propTypes =  false ? 0 : {};
react_lifecycles_compat_es_polyfill(MultiGrid_MultiGrid);
/* harmony default export */ const es_MultiGrid_MultiGrid = ((/* unused pure expression or super */ null && (MultiGrid_MultiGrid)));
;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/MultiGrid/index.js

/* harmony default export */ const es_MultiGrid = ((/* unused pure expression or super */ null && (MultiGrid)));

;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/ScrollSync/ScrollSync.js








/**
 * HOC that simplifies the process of synchronizing scrolling between two or more virtualized components.
 */

var ScrollSync_ScrollSync =
/*#__PURE__*/
function (_React$PureComponent) {
  _inherits(ScrollSync, _React$PureComponent);

  function ScrollSync(props, context) {
    var _this;

    classCallCheck_classCallCheck(this, ScrollSync);

    _this = _possibleConstructorReturn(this, _getPrototypeOf(ScrollSync).call(this, props, context));
    _this.state = {
      clientHeight: 0,
      clientWidth: 0,
      scrollHeight: 0,
      scrollLeft: 0,
      scrollTop: 0,
      scrollWidth: 0
    };
    _this._onScroll = _this._onScroll.bind(_assertThisInitialized(_this));
    return _this;
  }

  createClass_createClass(ScrollSync, [{
    key: "render",
    value: function render() {
      var children = this.props.children;
      var _this$state = this.state,
          clientHeight = _this$state.clientHeight,
          clientWidth = _this$state.clientWidth,
          scrollHeight = _this$state.scrollHeight,
          scrollLeft = _this$state.scrollLeft,
          scrollTop = _this$state.scrollTop,
          scrollWidth = _this$state.scrollWidth;
      return children({
        clientHeight: clientHeight,
        clientWidth: clientWidth,
        onScroll: this._onScroll,
        scrollHeight: scrollHeight,
        scrollLeft: scrollLeft,
        scrollTop: scrollTop,
        scrollWidth: scrollWidth
      });
    }
  }, {
    key: "_onScroll",
    value: function _onScroll(_ref) {
      var clientHeight = _ref.clientHeight,
          clientWidth = _ref.clientWidth,
          scrollHeight = _ref.scrollHeight,
          scrollLeft = _ref.scrollLeft,
          scrollTop = _ref.scrollTop,
          scrollWidth = _ref.scrollWidth;
      this.setState({
        clientHeight: clientHeight,
        clientWidth: clientWidth,
        scrollHeight: scrollHeight,
        scrollLeft: scrollLeft,
        scrollTop: scrollTop,
        scrollWidth: scrollWidth
      });
    }
  }]);

  return ScrollSync;
}(react.PureComponent);


ScrollSync_ScrollSync.propTypes =  false ? 0 : {};
;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/ScrollSync/index.js

/* harmony default export */ const es_ScrollSync = ((/* unused pure expression or super */ null && (ScrollSync)));

;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Table/types.js
var bpfrpt_proptype_CellDataGetterParams =  true ? null : 0;
var types_bpfrpt_proptype_CellRendererParams =  true ? null : 0;
var bpfrpt_proptype_HeaderRowRendererParams =  true ? null : 0;
var bpfrpt_proptype_HeaderRendererParams =  true ? null : 0;
var types_bpfrpt_proptype_RowRendererParams =  true ? null : 0;






;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Table/defaultCellDataGetter.js
/**
 * Default accessor for returning a cell value for a given attribute.
 * This function expects to operate on either a vanilla Object or an Immutable Map.
 * You should override the column's cellDataGetter if your data is some other type of object.
 */
function defaultCellDataGetter(_ref) {
  var dataKey = _ref.dataKey,
      rowData = _ref.rowData;

  if (typeof rowData.get === 'function') {
    return rowData.get(dataKey);
  } else {
    return rowData[dataKey];
  }
}

;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Table/defaultCellRenderer.js
/**
 * Default cell renderer that displays an attribute as a simple string
 * You should override the column's cellRenderer if your data is some other type of object.
 */
function defaultCellRenderer(_ref) {
  var cellData = _ref.cellData;

  if (cellData == null) {
    return '';
  } else {
    return String(cellData);
  }
}

;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Table/defaultHeaderRowRenderer.js

function defaultHeaderRowRenderer(_ref) {
  var className = _ref.className,
      columns = _ref.columns,
      style = _ref.style;
  return react.createElement("div", {
    className: className,
    role: "row",
    style: style
  }, columns);
}
defaultHeaderRowRenderer.propTypes =  true ? null : 0;


;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Table/SortDirection.js
var SortDirection = {
  /**
   * Sort items in ascending order.
   * This means arranging from the lowest value to the highest (e.g. a-z, 0-9).
   */
  ASC: 'ASC',

  /**
   * Sort items in descending order.
   * This means arranging from the highest value to the lowest (e.g. z-a, 9-0).
   */
  DESC: 'DESC'
};
/* harmony default export */ const Table_SortDirection = (SortDirection);
;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Table/SortIndicator.js




/**
 * Displayed beside a header to indicate that a Table is currently sorted by this column.
 */

function SortIndicator(_ref) {
  var sortDirection = _ref.sortDirection;
  var classNames = clsx_m('ReactVirtualized__Table__sortableHeaderIcon', {
    'ReactVirtualized__Table__sortableHeaderIcon--ASC': sortDirection === Table_SortDirection.ASC,
    'ReactVirtualized__Table__sortableHeaderIcon--DESC': sortDirection === Table_SortDirection.DESC
  });
  return react.createElement("svg", {
    className: classNames,
    width: 18,
    height: 18,
    viewBox: "0 0 24 24"
  }, sortDirection === Table_SortDirection.ASC ? react.createElement("path", {
    d: "M7 14l5-5 5 5z"
  }) : react.createElement("path", {
    d: "M7 10l5 5 5-5z"
  }), react.createElement("path", {
    d: "M0 0h24v24H0z",
    fill: "none"
  }));
}
SortIndicator.propTypes =  false ? 0 : {};
;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Table/defaultHeaderRenderer.js



/**
 * Default table header renderer.
 */
function defaultHeaderRenderer(_ref) {
  var dataKey = _ref.dataKey,
      label = _ref.label,
      sortBy = _ref.sortBy,
      sortDirection = _ref.sortDirection;
  var showSortIndicator = sortBy === dataKey;
  var children = [react.createElement("span", {
    className: "ReactVirtualized__Table__headerTruncatedText",
    key: "label",
    title: typeof label === 'string' ? label : null
  }, label)];

  if (showSortIndicator) {
    children.push(react.createElement(SortIndicator, {
      key: "SortIndicator",
      sortDirection: sortDirection
    }));
  }

  return children;
}
defaultHeaderRenderer.propTypes =  true ? null : 0;


;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Table/defaultRowRenderer.js



/**
 * Default row renderer for Table.
 */
function defaultRowRenderer(_ref) {
  var className = _ref.className,
      columns = _ref.columns,
      index = _ref.index,
      key = _ref.key,
      onRowClick = _ref.onRowClick,
      onRowDoubleClick = _ref.onRowDoubleClick,
      onRowMouseOut = _ref.onRowMouseOut,
      onRowMouseOver = _ref.onRowMouseOver,
      onRowRightClick = _ref.onRowRightClick,
      rowData = _ref.rowData,
      style = _ref.style;
  var a11yProps = {
    'aria-rowindex': index + 1
  };

  if (onRowClick || onRowDoubleClick || onRowMouseOut || onRowMouseOver || onRowRightClick) {
    a11yProps['aria-label'] = 'row';
    a11yProps.tabIndex = 0;

    if (onRowClick) {
      a11yProps.onClick = function (event) {
        return onRowClick({
          event: event,
          index: index,
          rowData: rowData
        });
      };
    }

    if (onRowDoubleClick) {
      a11yProps.onDoubleClick = function (event) {
        return onRowDoubleClick({
          event: event,
          index: index,
          rowData: rowData
        });
      };
    }

    if (onRowMouseOut) {
      a11yProps.onMouseOut = function (event) {
        return onRowMouseOut({
          event: event,
          index: index,
          rowData: rowData
        });
      };
    }

    if (onRowMouseOver) {
      a11yProps.onMouseOver = function (event) {
        return onRowMouseOver({
          event: event,
          index: index,
          rowData: rowData
        });
      };
    }

    if (onRowRightClick) {
      a11yProps.onContextMenu = function (event) {
        return onRowRightClick({
          event: event,
          index: index,
          rowData: rowData
        });
      };
    }
  }

  return react.createElement("div", extends_extends({}, a11yProps, {
    className: className,
    key: key,
    role: "row",
    style: style
  }), columns);
}
defaultRowRenderer.propTypes =  true ? null : 0;


;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Table/Column.js











/**
 * Describes the header and cell contents of a table column.
 */

var Column =
/*#__PURE__*/
function (_React$Component) {
  _inherits(Column, _React$Component);

  function Column() {
    classCallCheck_classCallCheck(this, Column);

    return _possibleConstructorReturn(this, _getPrototypeOf(Column).apply(this, arguments));
  }

  return Column;
}(react.Component);

defineProperty_defineProperty(Column, "defaultProps", {
  cellDataGetter: defaultCellDataGetter,
  cellRenderer: defaultCellRenderer,
  defaultSortDirection: Table_SortDirection.ASC,
  flexGrow: 0,
  flexShrink: 1,
  headerRenderer: defaultHeaderRenderer,
  style: {}
});


Column.propTypes =  false ? 0 : {};
;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Table/Table.js









function Table_ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); keys.push.apply(keys, symbols); } return keys; }

function Table_objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { Table_ownKeys(source, true).forEach(function (key) { defineProperty_defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { Table_ownKeys(source).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }










/**
 * Table component with fixed headers and virtualized rows for improved performance with large data sets.
 * This component expects explicit width, height, and padding parameters.
 */

var Table_Table =
/*#__PURE__*/
function (_React$PureComponent) {
  _inherits(Table, _React$PureComponent);

  function Table(props) {
    var _this;

    classCallCheck_classCallCheck(this, Table);

    _this = _possibleConstructorReturn(this, _getPrototypeOf(Table).call(this, props));
    _this.state = {
      scrollbarWidth: 0
    };
    _this._createColumn = _this._createColumn.bind(_assertThisInitialized(_this));
    _this._createRow = _this._createRow.bind(_assertThisInitialized(_this));
    _this._onScroll = _this._onScroll.bind(_assertThisInitialized(_this));
    _this._onSectionRendered = _this._onSectionRendered.bind(_assertThisInitialized(_this));
    _this._setRef = _this._setRef.bind(_assertThisInitialized(_this));
    return _this;
  }

  createClass_createClass(Table, [{
    key: "forceUpdateGrid",
    value: function forceUpdateGrid() {
      if (this.Grid) {
        this.Grid.forceUpdate();
      }
    }
    /** See Grid#getOffsetForCell */

  }, {
    key: "getOffsetForRow",
    value: function getOffsetForRow(_ref) {
      var alignment = _ref.alignment,
          index = _ref.index;

      if (this.Grid) {
        var _this$Grid$getOffsetF = this.Grid.getOffsetForCell({
          alignment: alignment,
          rowIndex: index
        }),
            scrollTop = _this$Grid$getOffsetF.scrollTop;

        return scrollTop;
      }

      return 0;
    }
    /** CellMeasurer compatibility */

  }, {
    key: "invalidateCellSizeAfterRender",
    value: function invalidateCellSizeAfterRender(_ref2) {
      var columnIndex = _ref2.columnIndex,
          rowIndex = _ref2.rowIndex;

      if (this.Grid) {
        this.Grid.invalidateCellSizeAfterRender({
          rowIndex: rowIndex,
          columnIndex: columnIndex
        });
      }
    }
    /** See Grid#measureAllCells */

  }, {
    key: "measureAllRows",
    value: function measureAllRows() {
      if (this.Grid) {
        this.Grid.measureAllCells();
      }
    }
    /** CellMeasurer compatibility */

  }, {
    key: "recomputeGridSize",
    value: function recomputeGridSize() {
      var _ref3 = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {},
          _ref3$columnIndex = _ref3.columnIndex,
          columnIndex = _ref3$columnIndex === void 0 ? 0 : _ref3$columnIndex,
          _ref3$rowIndex = _ref3.rowIndex,
          rowIndex = _ref3$rowIndex === void 0 ? 0 : _ref3$rowIndex;

      if (this.Grid) {
        this.Grid.recomputeGridSize({
          rowIndex: rowIndex,
          columnIndex: columnIndex
        });
      }
    }
    /** See Grid#recomputeGridSize */

  }, {
    key: "recomputeRowHeights",
    value: function recomputeRowHeights() {
      var index = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : 0;

      if (this.Grid) {
        this.Grid.recomputeGridSize({
          rowIndex: index
        });
      }
    }
    /** See Grid#scrollToPosition */

  }, {
    key: "scrollToPosition",
    value: function scrollToPosition() {
      var scrollTop = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : 0;

      if (this.Grid) {
        this.Grid.scrollToPosition({
          scrollTop: scrollTop
        });
      }
    }
    /** See Grid#scrollToCell */

  }, {
    key: "scrollToRow",
    value: function scrollToRow() {
      var index = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : 0;

      if (this.Grid) {
        this.Grid.scrollToCell({
          columnIndex: 0,
          rowIndex: index
        });
      }
    }
  }, {
    key: "getScrollbarWidth",
    value: function getScrollbarWidth() {
      if (this.Grid) {
        var _Grid = (0,react_dom.findDOMNode)(this.Grid);

        var clientWidth = _Grid.clientWidth || 0;
        var offsetWidth = _Grid.offsetWidth || 0;
        return offsetWidth - clientWidth;
      }

      return 0;
    }
  }, {
    key: "componentDidMount",
    value: function componentDidMount() {
      this._setScrollbarWidth();
    }
  }, {
    key: "componentDidUpdate",
    value: function componentDidUpdate() {
      this._setScrollbarWidth();
    }
  }, {
    key: "render",
    value: function render() {
      var _this2 = this;

      var _this$props = this.props,
          children = _this$props.children,
          className = _this$props.className,
          disableHeader = _this$props.disableHeader,
          gridClassName = _this$props.gridClassName,
          gridStyle = _this$props.gridStyle,
          headerHeight = _this$props.headerHeight,
          headerRowRenderer = _this$props.headerRowRenderer,
          height = _this$props.height,
          id = _this$props.id,
          noRowsRenderer = _this$props.noRowsRenderer,
          rowClassName = _this$props.rowClassName,
          rowStyle = _this$props.rowStyle,
          scrollToIndex = _this$props.scrollToIndex,
          style = _this$props.style,
          width = _this$props.width;
      var scrollbarWidth = this.state.scrollbarWidth;
      var availableRowsHeight = disableHeader ? height : height - headerHeight;
      var rowClass = typeof rowClassName === 'function' ? rowClassName({
        index: -1
      }) : rowClassName;
      var rowStyleObject = typeof rowStyle === 'function' ? rowStyle({
        index: -1
      }) : rowStyle; // Precompute and cache column styles before rendering rows and columns to speed things up

      this._cachedColumnStyles = [];
      react.Children.toArray(children).forEach(function (column, index) {
        var flexStyles = _this2._getFlexStyleForColumn(column, column.props.style);

        _this2._cachedColumnStyles[index] = Table_objectSpread({
          overflow: 'hidden'
        }, flexStyles);
      }); // Note that we specify :rowCount, :scrollbarWidth, :sortBy, and :sortDirection as properties on Grid even though these have nothing to do with Grid.
      // This is done because Grid is a pure component and won't update unless its properties or state has changed.
      // Any property that should trigger a re-render of Grid then is specified here to avoid a stale display.

      return react.createElement("div", {
        "aria-label": this.props['aria-label'],
        "aria-labelledby": this.props['aria-labelledby'],
        "aria-colcount": react.Children.toArray(children).length,
        "aria-rowcount": this.props.rowCount,
        className: clsx_m('ReactVirtualized__Table', className),
        id: id,
        role: "grid",
        style: style
      }, !disableHeader && headerRowRenderer({
        className: clsx_m('ReactVirtualized__Table__headerRow', rowClass),
        columns: this._getHeaderColumns(),
        style: Table_objectSpread({
          height: headerHeight,
          overflow: 'hidden',
          paddingRight: scrollbarWidth,
          width: width
        }, rowStyleObject)
      }), react.createElement(Grid_Grid, extends_extends({}, this.props, {
        "aria-readonly": null,
        autoContainerWidth: true,
        className: clsx_m('ReactVirtualized__Table__Grid', gridClassName),
        cellRenderer: this._createRow,
        columnWidth: width,
        columnCount: 1,
        height: availableRowsHeight,
        id: undefined,
        noContentRenderer: noRowsRenderer,
        onScroll: this._onScroll,
        onSectionRendered: this._onSectionRendered,
        ref: this._setRef,
        role: "rowgroup",
        scrollbarWidth: scrollbarWidth,
        scrollToRow: scrollToIndex,
        style: Table_objectSpread({}, gridStyle, {
          overflowX: 'hidden'
        })
      })));
    }
  }, {
    key: "_createColumn",
    value: function _createColumn(_ref4) {
      var column = _ref4.column,
          columnIndex = _ref4.columnIndex,
          isScrolling = _ref4.isScrolling,
          parent = _ref4.parent,
          rowData = _ref4.rowData,
          rowIndex = _ref4.rowIndex;
      var onColumnClick = this.props.onColumnClick;
      var _column$props = column.props,
          cellDataGetter = _column$props.cellDataGetter,
          cellRenderer = _column$props.cellRenderer,
          className = _column$props.className,
          columnData = _column$props.columnData,
          dataKey = _column$props.dataKey,
          id = _column$props.id;
      var cellData = cellDataGetter({
        columnData: columnData,
        dataKey: dataKey,
        rowData: rowData
      });
      var renderedCell = cellRenderer({
        cellData: cellData,
        columnData: columnData,
        columnIndex: columnIndex,
        dataKey: dataKey,
        isScrolling: isScrolling,
        parent: parent,
        rowData: rowData,
        rowIndex: rowIndex
      });

      var onClick = function onClick(event) {
        onColumnClick && onColumnClick({
          columnData: columnData,
          dataKey: dataKey,
          event: event
        });
      };

      var style = this._cachedColumnStyles[columnIndex];
      var title = typeof renderedCell === 'string' ? renderedCell : null; // Avoid using object-spread syntax with multiple objects here,
      // Since it results in an extra method call to 'babel-runtime/helpers/extends'
      // See PR https://github.com/bvaughn/react-virtualized/pull/942

      return react.createElement("div", {
        "aria-colindex": columnIndex + 1,
        "aria-describedby": id,
        className: clsx_m('ReactVirtualized__Table__rowColumn', className),
        key: 'Row' + rowIndex + '-' + 'Col' + columnIndex,
        onClick: onClick,
        role: "gridcell",
        style: style,
        title: title
      }, renderedCell);
    }
  }, {
    key: "_createHeader",
    value: function _createHeader(_ref5) {
      var column = _ref5.column,
          index = _ref5.index;
      var _this$props2 = this.props,
          headerClassName = _this$props2.headerClassName,
          headerStyle = _this$props2.headerStyle,
          onHeaderClick = _this$props2.onHeaderClick,
          sort = _this$props2.sort,
          sortBy = _this$props2.sortBy,
          sortDirection = _this$props2.sortDirection;
      var _column$props2 = column.props,
          columnData = _column$props2.columnData,
          dataKey = _column$props2.dataKey,
          defaultSortDirection = _column$props2.defaultSortDirection,
          disableSort = _column$props2.disableSort,
          headerRenderer = _column$props2.headerRenderer,
          id = _column$props2.id,
          label = _column$props2.label;
      var sortEnabled = !disableSort && sort;
      var classNames = clsx_m('ReactVirtualized__Table__headerColumn', headerClassName, column.props.headerClassName, {
        ReactVirtualized__Table__sortableHeaderColumn: sortEnabled
      });

      var style = this._getFlexStyleForColumn(column, Table_objectSpread({}, headerStyle, {}, column.props.headerStyle));

      var renderedHeader = headerRenderer({
        columnData: columnData,
        dataKey: dataKey,
        disableSort: disableSort,
        label: label,
        sortBy: sortBy,
        sortDirection: sortDirection
      });
      var headerOnClick, headerOnKeyDown, headerTabIndex, headerAriaSort, headerAriaLabel;

      if (sortEnabled || onHeaderClick) {
        // If this is a sortable header, clicking it should update the table data's sorting.
        var isFirstTimeSort = sortBy !== dataKey; // If this is the firstTime sort of this column, use the column default sort order.
        // Otherwise, invert the direction of the sort.

        var newSortDirection = isFirstTimeSort ? defaultSortDirection : sortDirection === Table_SortDirection.DESC ? Table_SortDirection.ASC : Table_SortDirection.DESC;

        var onClick = function onClick(event) {
          sortEnabled && sort({
            defaultSortDirection: defaultSortDirection,
            event: event,
            sortBy: dataKey,
            sortDirection: newSortDirection
          });
          onHeaderClick && onHeaderClick({
            columnData: columnData,
            dataKey: dataKey,
            event: event
          });
        };

        var onKeyDown = function onKeyDown(event) {
          if (event.key === 'Enter' || event.key === ' ') {
            onClick(event);
          }
        };

        headerAriaLabel = column.props['aria-label'] || label || dataKey;
        headerAriaSort = 'none';
        headerTabIndex = 0;
        headerOnClick = onClick;
        headerOnKeyDown = onKeyDown;
      }

      if (sortBy === dataKey) {
        headerAriaSort = sortDirection === Table_SortDirection.ASC ? 'ascending' : 'descending';
      } // Avoid using object-spread syntax with multiple objects here,
      // Since it results in an extra method call to 'babel-runtime/helpers/extends'
      // See PR https://github.com/bvaughn/react-virtualized/pull/942


      return react.createElement("div", {
        "aria-label": headerAriaLabel,
        "aria-sort": headerAriaSort,
        className: classNames,
        id: id,
        key: 'Header-Col' + index,
        onClick: headerOnClick,
        onKeyDown: headerOnKeyDown,
        role: "columnheader",
        style: style,
        tabIndex: headerTabIndex
      }, renderedHeader);
    }
  }, {
    key: "_createRow",
    value: function _createRow(_ref6) {
      var _this3 = this;

      var index = _ref6.rowIndex,
          isScrolling = _ref6.isScrolling,
          key = _ref6.key,
          parent = _ref6.parent,
          style = _ref6.style;
      var _this$props3 = this.props,
          children = _this$props3.children,
          onRowClick = _this$props3.onRowClick,
          onRowDoubleClick = _this$props3.onRowDoubleClick,
          onRowRightClick = _this$props3.onRowRightClick,
          onRowMouseOver = _this$props3.onRowMouseOver,
          onRowMouseOut = _this$props3.onRowMouseOut,
          rowClassName = _this$props3.rowClassName,
          rowGetter = _this$props3.rowGetter,
          rowRenderer = _this$props3.rowRenderer,
          rowStyle = _this$props3.rowStyle;
      var scrollbarWidth = this.state.scrollbarWidth;
      var rowClass = typeof rowClassName === 'function' ? rowClassName({
        index: index
      }) : rowClassName;
      var rowStyleObject = typeof rowStyle === 'function' ? rowStyle({
        index: index
      }) : rowStyle;
      var rowData = rowGetter({
        index: index
      });
      var columns = react.Children.toArray(children).map(function (column, columnIndex) {
        return _this3._createColumn({
          column: column,
          columnIndex: columnIndex,
          isScrolling: isScrolling,
          parent: parent,
          rowData: rowData,
          rowIndex: index,
          scrollbarWidth: scrollbarWidth
        });
      });
      var className = clsx_m('ReactVirtualized__Table__row', rowClass);

      var flattenedStyle = Table_objectSpread({}, style, {
        height: this._getRowHeight(index),
        overflow: 'hidden',
        paddingRight: scrollbarWidth
      }, rowStyleObject);

      return rowRenderer({
        className: className,
        columns: columns,
        index: index,
        isScrolling: isScrolling,
        key: key,
        onRowClick: onRowClick,
        onRowDoubleClick: onRowDoubleClick,
        onRowRightClick: onRowRightClick,
        onRowMouseOver: onRowMouseOver,
        onRowMouseOut: onRowMouseOut,
        rowData: rowData,
        style: flattenedStyle
      });
    }
    /**
     * Determines the flex-shrink, flex-grow, and width values for a cell (header or column).
     */

  }, {
    key: "_getFlexStyleForColumn",
    value: function _getFlexStyleForColumn(column) {
      var customStyle = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
      var flexValue = "".concat(column.props.flexGrow, " ").concat(column.props.flexShrink, " ").concat(column.props.width, "px");

      var style = Table_objectSpread({}, customStyle, {
        flex: flexValue,
        msFlex: flexValue,
        WebkitFlex: flexValue
      });

      if (column.props.maxWidth) {
        style.maxWidth = column.props.maxWidth;
      }

      if (column.props.minWidth) {
        style.minWidth = column.props.minWidth;
      }

      return style;
    }
  }, {
    key: "_getHeaderColumns",
    value: function _getHeaderColumns() {
      var _this4 = this;

      var _this$props4 = this.props,
          children = _this$props4.children,
          disableHeader = _this$props4.disableHeader;
      var items = disableHeader ? [] : react.Children.toArray(children);
      return items.map(function (column, index) {
        return _this4._createHeader({
          column: column,
          index: index
        });
      });
    }
  }, {
    key: "_getRowHeight",
    value: function _getRowHeight(rowIndex) {
      var rowHeight = this.props.rowHeight;
      return typeof rowHeight === 'function' ? rowHeight({
        index: rowIndex
      }) : rowHeight;
    }
  }, {
    key: "_onScroll",
    value: function _onScroll(_ref7) {
      var clientHeight = _ref7.clientHeight,
          scrollHeight = _ref7.scrollHeight,
          scrollTop = _ref7.scrollTop;
      var onScroll = this.props.onScroll;
      onScroll({
        clientHeight: clientHeight,
        scrollHeight: scrollHeight,
        scrollTop: scrollTop
      });
    }
  }, {
    key: "_onSectionRendered",
    value: function _onSectionRendered(_ref8) {
      var rowOverscanStartIndex = _ref8.rowOverscanStartIndex,
          rowOverscanStopIndex = _ref8.rowOverscanStopIndex,
          rowStartIndex = _ref8.rowStartIndex,
          rowStopIndex = _ref8.rowStopIndex;
      var onRowsRendered = this.props.onRowsRendered;
      onRowsRendered({
        overscanStartIndex: rowOverscanStartIndex,
        overscanStopIndex: rowOverscanStopIndex,
        startIndex: rowStartIndex,
        stopIndex: rowStopIndex
      });
    }
  }, {
    key: "_setRef",
    value: function _setRef(ref) {
      this.Grid = ref;
    }
  }, {
    key: "_setScrollbarWidth",
    value: function _setScrollbarWidth() {
      var scrollbarWidth = this.getScrollbarWidth();
      this.setState({
        scrollbarWidth: scrollbarWidth
      });
    }
  }]);

  return Table;
}(react.PureComponent);

defineProperty_defineProperty(Table_Table, "defaultProps", {
  disableHeader: false,
  estimatedRowSize: 30,
  headerHeight: 0,
  headerStyle: {},
  noRowsRenderer: function noRowsRenderer() {
    return null;
  },
  onRowsRendered: function onRowsRendered() {
    return null;
  },
  onScroll: function onScroll() {
    return null;
  },
  overscanIndicesGetter: accessibilityOverscanIndicesGetter_defaultOverscanIndicesGetter,
  overscanRowCount: 10,
  rowRenderer: defaultRowRenderer,
  headerRowRenderer: defaultHeaderRowRenderer,
  rowStyle: {},
  scrollToAlignment: 'auto',
  scrollToIndex: -1,
  style: {}
});


Table_Table.propTypes =  false ? 0 : {};

;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/Table/index.js










/* harmony default export */ const es_Table = ((/* unused pure expression or super */ null && (Table)));

;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/WindowScroller/utils/onScroll.js

var mountedInstances = [];
var originalBodyPointerEvents = null;
var disablePointerEventsTimeoutId = null;

function enablePointerEventsIfDisabled() {
  if (disablePointerEventsTimeoutId) {
    disablePointerEventsTimeoutId = null;

    if (document.body && originalBodyPointerEvents != null) {
      document.body.style.pointerEvents = originalBodyPointerEvents;
    }

    originalBodyPointerEvents = null;
  }
}

function enablePointerEventsAfterDelayCallback() {
  enablePointerEventsIfDisabled();
  mountedInstances.forEach(function (instance) {
    return instance.__resetIsScrolling();
  });
}

function enablePointerEventsAfterDelay() {
  if (disablePointerEventsTimeoutId) {
    cancelAnimationTimeout(disablePointerEventsTimeoutId);
  }

  var maximumTimeout = 0;
  mountedInstances.forEach(function (instance) {
    maximumTimeout = Math.max(maximumTimeout, instance.props.scrollingResetTimeInterval);
  });
  disablePointerEventsTimeoutId = requestAnimationTimeout(enablePointerEventsAfterDelayCallback, maximumTimeout);
}

function onScrollWindow(event) {
  if (event.currentTarget === window && originalBodyPointerEvents == null && document.body) {
    originalBodyPointerEvents = document.body.style.pointerEvents;
    document.body.style.pointerEvents = 'none';
  }

  enablePointerEventsAfterDelay();
  mountedInstances.forEach(function (instance) {
    if (instance.props.scrollElement === event.currentTarget) {
      instance.__handleWindowScrollEvent();
    }
  });
}

function registerScrollListener(component, element) {
  if (!mountedInstances.some(function (instance) {
    return instance.props.scrollElement === element;
  })) {
    element.addEventListener('scroll', onScrollWindow);
  }

  mountedInstances.push(component);
}
function unregisterScrollListener(component, element) {
  mountedInstances = mountedInstances.filter(function (instance) {
    return instance !== component;
  });

  if (!mountedInstances.length) {
    element.removeEventListener('scroll', onScrollWindow);

    if (disablePointerEventsTimeoutId) {
      cancelAnimationTimeout(disablePointerEventsTimeoutId);
      enablePointerEventsIfDisabled();
    }
  }
}

;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/WindowScroller/utils/dimensions.js
/**
 * Gets the dimensions of the element, accounting for API differences between
 * `window` and other DOM elements.
 */
// TODO Move this into WindowScroller and import from there
var isWindow = function isWindow(element) {
  return element === window;
};

var getBoundingBox = function getBoundingBox(element) {
  return element.getBoundingClientRect();
};

function getDimensions(scrollElement, props) {
  if (!scrollElement) {
    return {
      height: props.serverHeight,
      width: props.serverWidth
    };
  } else if (isWindow(scrollElement)) {
    var _window = window,
        innerHeight = _window.innerHeight,
        innerWidth = _window.innerWidth;
    return {
      height: typeof innerHeight === 'number' ? innerHeight : 0,
      width: typeof innerWidth === 'number' ? innerWidth : 0
    };
  } else {
    return getBoundingBox(scrollElement);
  }
}
/**
 * Gets the vertical and horizontal position of an element within its scroll container.
 * Elements that have been “scrolled past” return negative values.
 * Handles edge-case where a user is navigating back (history) from an already-scrolled page.
 * In this case the body’s top or left position will be a negative number and this element’s top or left will be increased (by that amount).
 */

function getPositionOffset(element, container) {
  if (isWindow(container) && document.documentElement) {
    var containerElement = document.documentElement;
    var elementRect = getBoundingBox(element);
    var containerRect = getBoundingBox(containerElement);
    return {
      top: elementRect.top - containerRect.top,
      left: elementRect.left - containerRect.left
    };
  } else {
    var scrollOffset = getScrollOffset(container);

    var _elementRect = getBoundingBox(element);

    var _containerRect = getBoundingBox(container);

    return {
      top: _elementRect.top + scrollOffset.top - _containerRect.top,
      left: _elementRect.left + scrollOffset.left - _containerRect.left
    };
  }
}
/**
 * Gets the vertical and horizontal scroll amount of the element, accounting for IE compatibility
 * and API differences between `window` and other DOM elements.
 */

function getScrollOffset(element) {
  if (isWindow(element) && document.documentElement) {
    return {
      top: 'scrollY' in window ? window.scrollY : document.documentElement.scrollTop,
      left: 'scrollX' in window ? window.scrollX : document.documentElement.scrollLeft
    };
  } else {
    return {
      top: element.scrollTop,
      left: element.scrollLeft
    };
  }
}
;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/WindowScroller/WindowScroller.js








var WindowScroller_class, WindowScroller_temp;

function WindowScroller_ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); keys.push.apply(keys, symbols); } return keys; }

function WindowScroller_objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { WindowScroller_ownKeys(source, true).forEach(function (key) { defineProperty_defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { WindowScroller_ownKeys(source).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }







/**
 * Specifies the number of miliseconds during which to disable pointer events while a scroll is in progress.
 * This improves performance and makes scrolling smoother.
 */
var WindowScroller_IS_SCROLLING_TIMEOUT = 150;

var getWindow = function getWindow() {
  return typeof window !== 'undefined' ? window : undefined;
};

var WindowScroller_WindowScroller = (WindowScroller_temp = WindowScroller_class =
/*#__PURE__*/
function (_React$PureComponent) {
  _inherits(WindowScroller, _React$PureComponent);

  function WindowScroller() {
    var _getPrototypeOf2;

    var _this;

    classCallCheck_classCallCheck(this, WindowScroller);

    for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
      args[_key] = arguments[_key];
    }

    _this = _possibleConstructorReturn(this, (_getPrototypeOf2 = _getPrototypeOf(WindowScroller)).call.apply(_getPrototypeOf2, [this].concat(args)));

    defineProperty_defineProperty(_assertThisInitialized(_this), "_window", getWindow());

    defineProperty_defineProperty(_assertThisInitialized(_this), "_isMounted", false);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_positionFromTop", 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_positionFromLeft", 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_detectElementResize", void 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "_child", void 0);

    defineProperty_defineProperty(_assertThisInitialized(_this), "state", WindowScroller_objectSpread({}, getDimensions(_this.props.scrollElement, _this.props), {
      isScrolling: false,
      scrollLeft: 0,
      scrollTop: 0
    }));

    defineProperty_defineProperty(_assertThisInitialized(_this), "_registerChild", function (element) {
      if (element && !(element instanceof Element)) {
        console.warn('WindowScroller registerChild expects to be passed Element or null');
      }

      _this._child = element;

      _this.updatePosition();
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_onChildScroll", function (_ref) {
      var scrollTop = _ref.scrollTop;

      if (_this.state.scrollTop === scrollTop) {
        return;
      }

      var scrollElement = _this.props.scrollElement;

      if (scrollElement) {
        if (typeof scrollElement.scrollTo === 'function') {
          scrollElement.scrollTo(0, scrollTop + _this._positionFromTop);
        } else {
          scrollElement.scrollTop = scrollTop + _this._positionFromTop;
        }
      }
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_registerResizeListener", function (element) {
      if (element === window) {
        window.addEventListener('resize', _this._onResize, false);
      } else {
        _this._detectElementResize.addResizeListener(element, _this._onResize);
      }
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_unregisterResizeListener", function (element) {
      if (element === window) {
        window.removeEventListener('resize', _this._onResize, false);
      } else if (element) {
        _this._detectElementResize.removeResizeListener(element, _this._onResize);
      }
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "_onResize", function () {
      _this.updatePosition();
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "__handleWindowScrollEvent", function () {
      if (!_this._isMounted) {
        return;
      }

      var onScroll = _this.props.onScroll;
      var scrollElement = _this.props.scrollElement;

      if (scrollElement) {
        var scrollOffset = getScrollOffset(scrollElement);
        var scrollLeft = Math.max(0, scrollOffset.left - _this._positionFromLeft);
        var scrollTop = Math.max(0, scrollOffset.top - _this._positionFromTop);

        _this.setState({
          isScrolling: true,
          scrollLeft: scrollLeft,
          scrollTop: scrollTop
        });

        onScroll({
          scrollLeft: scrollLeft,
          scrollTop: scrollTop
        });
      }
    });

    defineProperty_defineProperty(_assertThisInitialized(_this), "__resetIsScrolling", function () {
      _this.setState({
        isScrolling: false
      });
    });

    return _this;
  }

  createClass_createClass(WindowScroller, [{
    key: "updatePosition",
    value: function updatePosition() {
      var scrollElement = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : this.props.scrollElement;
      var onResize = this.props.onResize;
      var _this$state = this.state,
          height = _this$state.height,
          width = _this$state.width;
      var thisNode = this._child || react_dom.findDOMNode(this);

      if (thisNode instanceof Element && scrollElement) {
        var offset = getPositionOffset(thisNode, scrollElement);
        this._positionFromTop = offset.top;
        this._positionFromLeft = offset.left;
      }

      var dimensions = getDimensions(scrollElement, this.props);

      if (height !== dimensions.height || width !== dimensions.width) {
        this.setState({
          height: dimensions.height,
          width: dimensions.width
        });
        onResize({
          height: dimensions.height,
          width: dimensions.width
        });
      }
    }
  }, {
    key: "componentDidMount",
    value: function componentDidMount() {
      var scrollElement = this.props.scrollElement;
      this._detectElementResize = createDetectElementResize();
      this.updatePosition(scrollElement);

      if (scrollElement) {
        registerScrollListener(this, scrollElement);

        this._registerResizeListener(scrollElement);
      }

      this._isMounted = true;
    }
  }, {
    key: "componentDidUpdate",
    value: function componentDidUpdate(prevProps, prevState) {
      var scrollElement = this.props.scrollElement;
      var prevScrollElement = prevProps.scrollElement;

      if (prevScrollElement !== scrollElement && prevScrollElement != null && scrollElement != null) {
        this.updatePosition(scrollElement);
        unregisterScrollListener(this, prevScrollElement);
        registerScrollListener(this, scrollElement);

        this._unregisterResizeListener(prevScrollElement);

        this._registerResizeListener(scrollElement);
      }
    }
  }, {
    key: "componentWillUnmount",
    value: function componentWillUnmount() {
      var scrollElement = this.props.scrollElement;

      if (scrollElement) {
        unregisterScrollListener(this, scrollElement);

        this._unregisterResizeListener(scrollElement);
      }

      this._isMounted = false;
    }
  }, {
    key: "render",
    value: function render() {
      var children = this.props.children;
      var _this$state2 = this.state,
          isScrolling = _this$state2.isScrolling,
          scrollTop = _this$state2.scrollTop,
          scrollLeft = _this$state2.scrollLeft,
          height = _this$state2.height,
          width = _this$state2.width;
      return children({
        onChildScroll: this._onChildScroll,
        registerChild: this._registerChild,
        height: height,
        isScrolling: isScrolling,
        scrollLeft: scrollLeft,
        scrollTop: scrollTop,
        width: width
      });
    }
  }]);

  return WindowScroller;
}(react.PureComponent), defineProperty_defineProperty(WindowScroller_class, "propTypes",  true ? null : 0), WindowScroller_temp);

defineProperty_defineProperty(WindowScroller_WindowScroller, "defaultProps", {
  onResize: function onResize() {},
  onScroll: function onScroll() {},
  scrollingResetTimeInterval: WindowScroller_IS_SCROLLING_TIMEOUT,
  scrollElement: getWindow(),
  serverHeight: 0,
  serverWidth: 0
});



;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/WindowScroller/index.js

/* harmony default export */ const es_WindowScroller = ((/* unused pure expression or super */ null && (WindowScroller)));

;// CONCATENATED MODULE: ./node_modules/react-virtualized/dist/es/index.js













;// CONCATENATED MODULE: ./node_modules/@babel/runtime/helpers/esm/inheritsLoose.js

function inheritsLoose_inheritsLoose(t, o) {
  t.prototype = Object.create(o.prototype), t.prototype.constructor = t, _setPrototypeOf(t, o);
}

;// CONCATENATED MODULE: ./node_modules/react-transition-group/esm/TransitionGroupContext.js

/* harmony default export */ const TransitionGroupContext = (react.createContext(null));
;// CONCATENATED MODULE: ./node_modules/react-transition-group/esm/utils/ChildMapping.js

/**
 * Given `this.props.children`, return an object mapping key to child.
 *
 * @param {*} children `this.props.children`
 * @return {object} Mapping of key to child
 */

function getChildMapping(children, mapFn) {
  var mapper = function mapper(child) {
    return mapFn && (0,react.isValidElement)(child) ? mapFn(child) : child;
  };

  var result = Object.create(null);
  if (children) react.Children.map(children, function (c) {
    return c;
  }).forEach(function (child) {
    // run the map function here instead so that the key is the computed one
    result[child.key] = mapper(child);
  });
  return result;
}
/**
 * When you're adding or removing children some may be added or removed in the
 * same render pass. We want to show *both* since we want to simultaneously
 * animate elements in and out. This function takes a previous set of keys
 * and a new set of keys and merges them with its best guess of the correct
 * ordering. In the future we may expose some of the utilities in
 * ReactMultiChild to make this easy, but for now React itself does not
 * directly have this concept of the union of prevChildren and nextChildren
 * so we implement it here.
 *
 * @param {object} prev prev children as returned from
 * `ReactTransitionChildMapping.getChildMapping()`.
 * @param {object} next next children as returned from
 * `ReactTransitionChildMapping.getChildMapping()`.
 * @return {object} a key set that contains all keys in `prev` and all keys
 * in `next` in a reasonable order.
 */

function mergeChildMappings(prev, next) {
  prev = prev || {};
  next = next || {};

  function getValueForKey(key) {
    return key in next ? next[key] : prev[key];
  } // For each key of `next`, the list of keys to insert before that key in
  // the combined list


  var nextKeysPending = Object.create(null);
  var pendingKeys = [];

  for (var prevKey in prev) {
    if (prevKey in next) {
      if (pendingKeys.length) {
        nextKeysPending[prevKey] = pendingKeys;
        pendingKeys = [];
      }
    } else {
      pendingKeys.push(prevKey);
    }
  }

  var i;
  var childMapping = {};

  for (var nextKey in next) {
    if (nextKeysPending[nextKey]) {
      for (i = 0; i < nextKeysPending[nextKey].length; i++) {
        var pendingNextKey = nextKeysPending[nextKey][i];
        childMapping[nextKeysPending[nextKey][i]] = getValueForKey(pendingNextKey);
      }
    }

    childMapping[nextKey] = getValueForKey(nextKey);
  } // Finally, add the keys which didn't appear before any key in `next`


  for (i = 0; i < pendingKeys.length; i++) {
    childMapping[pendingKeys[i]] = getValueForKey(pendingKeys[i]);
  }

  return childMapping;
}

function getProp(child, prop, props) {
  return props[prop] != null ? props[prop] : child.props[prop];
}

function getInitialChildMapping(props, onExited) {
  return getChildMapping(props.children, function (child) {
    return (0,react.cloneElement)(child, {
      onExited: onExited.bind(null, child),
      in: true,
      appear: getProp(child, 'appear', props),
      enter: getProp(child, 'enter', props),
      exit: getProp(child, 'exit', props)
    });
  });
}
function getNextChildMapping(nextProps, prevChildMapping, onExited) {
  var nextChildMapping = getChildMapping(nextProps.children);
  var children = mergeChildMappings(prevChildMapping, nextChildMapping);
  Object.keys(children).forEach(function (key) {
    var child = children[key];
    if (!(0,react.isValidElement)(child)) return;
    var hasPrev = (key in prevChildMapping);
    var hasNext = (key in nextChildMapping);
    var prevChild = prevChildMapping[key];
    var isLeaving = (0,react.isValidElement)(prevChild) && !prevChild.props.in; // item is new (entering)

    if (hasNext && (!hasPrev || isLeaving)) {
      // console.log('entering', key)
      children[key] = (0,react.cloneElement)(child, {
        onExited: onExited.bind(null, child),
        in: true,
        exit: getProp(child, 'exit', nextProps),
        enter: getProp(child, 'enter', nextProps)
      });
    } else if (!hasNext && hasPrev && !isLeaving) {
      // item is old (exiting)
      // console.log('leaving', key)
      children[key] = (0,react.cloneElement)(child, {
        in: false
      });
    } else if (hasNext && hasPrev && (0,react.isValidElement)(prevChild)) {
      // item hasn't changed transition states
      // copy over the last transition props;
      // console.log('unchanged', key)
      children[key] = (0,react.cloneElement)(child, {
        onExited: onExited.bind(null, child),
        in: prevChild.props.in,
        exit: getProp(child, 'exit', nextProps),
        enter: getProp(child, 'enter', nextProps)
      });
    }
  });
  return children;
}
;// CONCATENATED MODULE: ./node_modules/react-transition-group/esm/TransitionGroup.js









var values = Object.values || function (obj) {
  return Object.keys(obj).map(function (k) {
    return obj[k];
  });
};

var defaultProps = {
  component: 'div',
  childFactory: function childFactory(child) {
    return child;
  }
};
/**
 * The `<TransitionGroup>` component manages a set of transition components
 * (`<Transition>` and `<CSSTransition>`) in a list. Like with the transition
 * components, `<TransitionGroup>` is a state machine for managing the mounting
 * and unmounting of components over time.
 *
 * Consider the example below. As items are removed or added to the TodoList the
 * `in` prop is toggled automatically by the `<TransitionGroup>`.
 *
 * Note that `<TransitionGroup>`  does not define any animation behavior!
 * Exactly _how_ a list item animates is up to the individual transition
 * component. This means you can mix and match animations across different list
 * items.
 */

var TransitionGroup = /*#__PURE__*/function (_React$Component) {
  inheritsLoose_inheritsLoose(TransitionGroup, _React$Component);

  function TransitionGroup(props, context) {
    var _this;

    _this = _React$Component.call(this, props, context) || this;

    var handleExited = _this.handleExited.bind(_assertThisInitialized(_this)); // Initial children should all be entering, dependent on appear


    _this.state = {
      contextValue: {
        isMounting: true
      },
      handleExited: handleExited,
      firstRender: true
    };
    return _this;
  }

  var _proto = TransitionGroup.prototype;

  _proto.componentDidMount = function componentDidMount() {
    this.mounted = true;
    this.setState({
      contextValue: {
        isMounting: false
      }
    });
  };

  _proto.componentWillUnmount = function componentWillUnmount() {
    this.mounted = false;
  };

  TransitionGroup.getDerivedStateFromProps = function getDerivedStateFromProps(nextProps, _ref) {
    var prevChildMapping = _ref.children,
        handleExited = _ref.handleExited,
        firstRender = _ref.firstRender;
    return {
      children: firstRender ? getInitialChildMapping(nextProps, handleExited) : getNextChildMapping(nextProps, prevChildMapping, handleExited),
      firstRender: false
    };
  } // node is `undefined` when user provided `nodeRef` prop
  ;

  _proto.handleExited = function handleExited(child, node) {
    var currentChildMapping = getChildMapping(this.props.children);
    if (child.key in currentChildMapping) return;

    if (child.props.onExited) {
      child.props.onExited(node);
    }

    if (this.mounted) {
      this.setState(function (state) {
        var children = extends_extends({}, state.children);

        delete children[child.key];
        return {
          children: children
        };
      });
    }
  };

  _proto.render = function render() {
    var _this$props = this.props,
        Component = _this$props.component,
        childFactory = _this$props.childFactory,
        props = objectWithoutPropertiesLoose_objectWithoutPropertiesLoose(_this$props, ["component", "childFactory"]);

    var contextValue = this.state.contextValue;
    var children = values(this.state.children).map(childFactory);
    delete props.appear;
    delete props.enter;
    delete props.exit;

    if (Component === null) {
      return /*#__PURE__*/react.createElement(TransitionGroupContext.Provider, {
        value: contextValue
      }, children);
    }

    return /*#__PURE__*/react.createElement(TransitionGroupContext.Provider, {
      value: contextValue
    }, /*#__PURE__*/react.createElement(Component, props, children));
  };

  return TransitionGroup;
}(react.Component);

TransitionGroup.propTypes =  false ? 0 : {};
TransitionGroup.defaultProps = defaultProps;
/* harmony default export */ const esm_TransitionGroup = (TransitionGroup);
;// CONCATENATED MODULE: ./node_modules/dom-helpers/esm/hasClass.js
/**
 * Checks if a given element has a CSS class.
 * 
 * @param element the element
 * @param className the CSS class name
 */
function hasClass(element, className) {
  if (element.classList) return !!className && element.classList.contains(className);
  return (" " + (element.className.baseVal || element.className) + " ").indexOf(" " + className + " ") !== -1;
}
;// CONCATENATED MODULE: ./node_modules/dom-helpers/esm/addClass.js

/**
 * Adds a CSS class to a given element.
 * 
 * @param element the element
 * @param className the CSS class name
 */

function addClass_addClass(element, className) {
  if (element.classList) element.classList.add(className);else if (!hasClass(element, className)) if (typeof element.className === 'string') element.className = element.className + " " + className;else element.setAttribute('class', (element.className && element.className.baseVal || '') + " " + className);
}
;// CONCATENATED MODULE: ./node_modules/dom-helpers/esm/removeClass.js
function replaceClassName(origClass, classToRemove) {
  return origClass.replace(new RegExp("(^|\\s)" + classToRemove + "(?:\\s|$)", 'g'), '$1').replace(/\s+/g, ' ').replace(/^\s*|\s*$/g, '');
}
/**
 * Removes a CSS class from a given element.
 * 
 * @param element the element
 * @param className the CSS class name
 */


function removeClass_removeClass(element, className) {
  if (element.classList) {
    element.classList.remove(className);
  } else if (typeof element.className === 'string') {
    element.className = replaceClassName(element.className, className);
  } else {
    element.setAttribute('class', replaceClassName(element.className && element.className.baseVal || '', className));
  }
}
;// CONCATENATED MODULE: ./node_modules/react-transition-group/esm/config.js
/* harmony default export */ const config = ({
  disabled: false
});
;// CONCATENATED MODULE: ./node_modules/react-transition-group/esm/utils/reflow.js
var forceReflow = function forceReflow(node) {
  return node.scrollTop;
};
;// CONCATENATED MODULE: ./node_modules/react-transition-group/esm/Transition.js









var UNMOUNTED = 'unmounted';
var EXITED = 'exited';
var ENTERING = 'entering';
var ENTERED = 'entered';
var EXITING = 'exiting';
/**
 * The Transition component lets you describe a transition from one component
 * state to another _over time_ with a simple declarative API. Most commonly
 * it's used to animate the mounting and unmounting of a component, but can also
 * be used to describe in-place transition states as well.
 *
 * ---
 *
 * **Note**: `Transition` is a platform-agnostic base component. If you're using
 * transitions in CSS, you'll probably want to use
 * [`CSSTransition`](https://reactcommunity.org/react-transition-group/css-transition)
 * instead. It inherits all the features of `Transition`, but contains
 * additional features necessary to play nice with CSS transitions (hence the
 * name of the component).
 *
 * ---
 *
 * By default the `Transition` component does not alter the behavior of the
 * component it renders, it only tracks "enter" and "exit" states for the
 * components. It's up to you to give meaning and effect to those states. For
 * example we can add styles to a component when it enters or exits:
 *
 * ```jsx
 * import { Transition } from 'react-transition-group';
 *
 * const duration = 300;
 *
 * const defaultStyle = {
 *   transition: `opacity ${duration}ms ease-in-out`,
 *   opacity: 0,
 * }
 *
 * const transitionStyles = {
 *   entering: { opacity: 1 },
 *   entered:  { opacity: 1 },
 *   exiting:  { opacity: 0 },
 *   exited:  { opacity: 0 },
 * };
 *
 * const Fade = ({ in: inProp }) => (
 *   <Transition in={inProp} timeout={duration}>
 *     {state => (
 *       <div style={{
 *         ...defaultStyle,
 *         ...transitionStyles[state]
 *       }}>
 *         I'm a fade Transition!
 *       </div>
 *     )}
 *   </Transition>
 * );
 * ```
 *
 * There are 4 main states a Transition can be in:
 *  - `'entering'`
 *  - `'entered'`
 *  - `'exiting'`
 *  - `'exited'`
 *
 * Transition state is toggled via the `in` prop. When `true` the component
 * begins the "Enter" stage. During this stage, the component will shift from
 * its current transition state, to `'entering'` for the duration of the
 * transition and then to the `'entered'` stage once it's complete. Let's take
 * the following example (we'll use the
 * [useState](https://reactjs.org/docs/hooks-reference.html#usestate) hook):
 *
 * ```jsx
 * function App() {
 *   const [inProp, setInProp] = useState(false);
 *   return (
 *     <div>
 *       <Transition in={inProp} timeout={500}>
 *         {state => (
 *           // ...
 *         )}
 *       </Transition>
 *       <button onClick={() => setInProp(true)}>
 *         Click to Enter
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 *
 * When the button is clicked the component will shift to the `'entering'` state
 * and stay there for 500ms (the value of `timeout`) before it finally switches
 * to `'entered'`.
 *
 * When `in` is `false` the same thing happens except the state moves from
 * `'exiting'` to `'exited'`.
 */

var Transition = /*#__PURE__*/function (_React$Component) {
  inheritsLoose_inheritsLoose(Transition, _React$Component);

  function Transition(props, context) {
    var _this;

    _this = _React$Component.call(this, props, context) || this;
    var parentGroup = context; // In the context of a TransitionGroup all enters are really appears

    var appear = parentGroup && !parentGroup.isMounting ? props.enter : props.appear;
    var initialStatus;
    _this.appearStatus = null;

    if (props.in) {
      if (appear) {
        initialStatus = EXITED;
        _this.appearStatus = ENTERING;
      } else {
        initialStatus = ENTERED;
      }
    } else {
      if (props.unmountOnExit || props.mountOnEnter) {
        initialStatus = UNMOUNTED;
      } else {
        initialStatus = EXITED;
      }
    }

    _this.state = {
      status: initialStatus
    };
    _this.nextCallback = null;
    return _this;
  }

  Transition.getDerivedStateFromProps = function getDerivedStateFromProps(_ref, prevState) {
    var nextIn = _ref.in;

    if (nextIn && prevState.status === UNMOUNTED) {
      return {
        status: EXITED
      };
    }

    return null;
  } // getSnapshotBeforeUpdate(prevProps) {
  //   let nextStatus = null
  //   if (prevProps !== this.props) {
  //     const { status } = this.state
  //     if (this.props.in) {
  //       if (status !== ENTERING && status !== ENTERED) {
  //         nextStatus = ENTERING
  //       }
  //     } else {
  //       if (status === ENTERING || status === ENTERED) {
  //         nextStatus = EXITING
  //       }
  //     }
  //   }
  //   return { nextStatus }
  // }
  ;

  var _proto = Transition.prototype;

  _proto.componentDidMount = function componentDidMount() {
    this.updateStatus(true, this.appearStatus);
  };

  _proto.componentDidUpdate = function componentDidUpdate(prevProps) {
    var nextStatus = null;

    if (prevProps !== this.props) {
      var status = this.state.status;

      if (this.props.in) {
        if (status !== ENTERING && status !== ENTERED) {
          nextStatus = ENTERING;
        }
      } else {
        if (status === ENTERING || status === ENTERED) {
          nextStatus = EXITING;
        }
      }
    }

    this.updateStatus(false, nextStatus);
  };

  _proto.componentWillUnmount = function componentWillUnmount() {
    this.cancelNextCallback();
  };

  _proto.getTimeouts = function getTimeouts() {
    var timeout = this.props.timeout;
    var exit, enter, appear;
    exit = enter = appear = timeout;

    if (timeout != null && typeof timeout !== 'number') {
      exit = timeout.exit;
      enter = timeout.enter; // TODO: remove fallback for next major

      appear = timeout.appear !== undefined ? timeout.appear : enter;
    }

    return {
      exit: exit,
      enter: enter,
      appear: appear
    };
  };

  _proto.updateStatus = function updateStatus(mounting, nextStatus) {
    if (mounting === void 0) {
      mounting = false;
    }

    if (nextStatus !== null) {
      // nextStatus will always be ENTERING or EXITING.
      this.cancelNextCallback();

      if (nextStatus === ENTERING) {
        if (this.props.unmountOnExit || this.props.mountOnEnter) {
          var node = this.props.nodeRef ? this.props.nodeRef.current : react_dom.findDOMNode(this); // https://github.com/reactjs/react-transition-group/pull/749
          // With unmountOnExit or mountOnEnter, the enter animation should happen at the transition between `exited` and `entering`.
          // To make the animation happen,  we have to separate each rendering and avoid being processed as batched.

          if (node) forceReflow(node);
        }

        this.performEnter(mounting);
      } else {
        this.performExit();
      }
    } else if (this.props.unmountOnExit && this.state.status === EXITED) {
      this.setState({
        status: UNMOUNTED
      });
    }
  };

  _proto.performEnter = function performEnter(mounting) {
    var _this2 = this;

    var enter = this.props.enter;
    var appearing = this.context ? this.context.isMounting : mounting;

    var _ref2 = this.props.nodeRef ? [appearing] : [react_dom.findDOMNode(this), appearing],
        maybeNode = _ref2[0],
        maybeAppearing = _ref2[1];

    var timeouts = this.getTimeouts();
    var enterTimeout = appearing ? timeouts.appear : timeouts.enter; // no enter animation skip right to ENTERED
    // if we are mounting and running this it means appear _must_ be set

    if (!mounting && !enter || config.disabled) {
      this.safeSetState({
        status: ENTERED
      }, function () {
        _this2.props.onEntered(maybeNode);
      });
      return;
    }

    this.props.onEnter(maybeNode, maybeAppearing);
    this.safeSetState({
      status: ENTERING
    }, function () {
      _this2.props.onEntering(maybeNode, maybeAppearing);

      _this2.onTransitionEnd(enterTimeout, function () {
        _this2.safeSetState({
          status: ENTERED
        }, function () {
          _this2.props.onEntered(maybeNode, maybeAppearing);
        });
      });
    });
  };

  _proto.performExit = function performExit() {
    var _this3 = this;

    var exit = this.props.exit;
    var timeouts = this.getTimeouts();
    var maybeNode = this.props.nodeRef ? undefined : react_dom.findDOMNode(this); // no exit animation skip right to EXITED

    if (!exit || config.disabled) {
      this.safeSetState({
        status: EXITED
      }, function () {
        _this3.props.onExited(maybeNode);
      });
      return;
    }

    this.props.onExit(maybeNode);
    this.safeSetState({
      status: EXITING
    }, function () {
      _this3.props.onExiting(maybeNode);

      _this3.onTransitionEnd(timeouts.exit, function () {
        _this3.safeSetState({
          status: EXITED
        }, function () {
          _this3.props.onExited(maybeNode);
        });
      });
    });
  };

  _proto.cancelNextCallback = function cancelNextCallback() {
    if (this.nextCallback !== null) {
      this.nextCallback.cancel();
      this.nextCallback = null;
    }
  };

  _proto.safeSetState = function safeSetState(nextState, callback) {
    // This shouldn't be necessary, but there are weird race conditions with
    // setState callbacks and unmounting in testing, so always make sure that
    // we can cancel any pending setState callbacks after we unmount.
    callback = this.setNextCallback(callback);
    this.setState(nextState, callback);
  };

  _proto.setNextCallback = function setNextCallback(callback) {
    var _this4 = this;

    var active = true;

    this.nextCallback = function (event) {
      if (active) {
        active = false;
        _this4.nextCallback = null;
        callback(event);
      }
    };

    this.nextCallback.cancel = function () {
      active = false;
    };

    return this.nextCallback;
  };

  _proto.onTransitionEnd = function onTransitionEnd(timeout, handler) {
    this.setNextCallback(handler);
    var node = this.props.nodeRef ? this.props.nodeRef.current : react_dom.findDOMNode(this);
    var doesNotHaveTimeoutOrListener = timeout == null && !this.props.addEndListener;

    if (!node || doesNotHaveTimeoutOrListener) {
      setTimeout(this.nextCallback, 0);
      return;
    }

    if (this.props.addEndListener) {
      var _ref3 = this.props.nodeRef ? [this.nextCallback] : [node, this.nextCallback],
          maybeNode = _ref3[0],
          maybeNextCallback = _ref3[1];

      this.props.addEndListener(maybeNode, maybeNextCallback);
    }

    if (timeout != null) {
      setTimeout(this.nextCallback, timeout);
    }
  };

  _proto.render = function render() {
    var status = this.state.status;

    if (status === UNMOUNTED) {
      return null;
    }

    var _this$props = this.props,
        children = _this$props.children,
        _in = _this$props.in,
        _mountOnEnter = _this$props.mountOnEnter,
        _unmountOnExit = _this$props.unmountOnExit,
        _appear = _this$props.appear,
        _enter = _this$props.enter,
        _exit = _this$props.exit,
        _timeout = _this$props.timeout,
        _addEndListener = _this$props.addEndListener,
        _onEnter = _this$props.onEnter,
        _onEntering = _this$props.onEntering,
        _onEntered = _this$props.onEntered,
        _onExit = _this$props.onExit,
        _onExiting = _this$props.onExiting,
        _onExited = _this$props.onExited,
        _nodeRef = _this$props.nodeRef,
        childProps = objectWithoutPropertiesLoose_objectWithoutPropertiesLoose(_this$props, ["children", "in", "mountOnEnter", "unmountOnExit", "appear", "enter", "exit", "timeout", "addEndListener", "onEnter", "onEntering", "onEntered", "onExit", "onExiting", "onExited", "nodeRef"]);

    return (
      /*#__PURE__*/
      // allows for nested Transitions
      react.createElement(TransitionGroupContext.Provider, {
        value: null
      }, typeof children === 'function' ? children(status, childProps) : react.cloneElement(react.Children.only(children), childProps))
    );
  };

  return Transition;
}(react.Component);

Transition.contextType = TransitionGroupContext;
Transition.propTypes =  false ? 0 : {}; // Name the function so it is clearer in the documentation

function Transition_noop() {}

Transition.defaultProps = {
  in: false,
  mountOnEnter: false,
  unmountOnExit: false,
  appear: false,
  enter: true,
  exit: true,
  onEnter: Transition_noop,
  onEntering: Transition_noop,
  onEntered: Transition_noop,
  onExit: Transition_noop,
  onExiting: Transition_noop,
  onExited: Transition_noop
};
Transition.UNMOUNTED = UNMOUNTED;
Transition.EXITED = EXITED;
Transition.ENTERING = ENTERING;
Transition.ENTERED = ENTERED;
Transition.EXITING = EXITING;
/* harmony default export */ const esm_Transition = (Transition);
;// CONCATENATED MODULE: ./node_modules/react-transition-group/esm/CSSTransition.js











var _addClass = function addClass(node, classes) {
  return node && classes && classes.split(' ').forEach(function (c) {
    return addClass_addClass(node, c);
  });
};

var removeClass = function removeClass(node, classes) {
  return node && classes && classes.split(' ').forEach(function (c) {
    return removeClass_removeClass(node, c);
  });
};
/**
 * A transition component inspired by the excellent
 * [ng-animate](https://docs.angularjs.org/api/ngAnimate) library, you should
 * use it if you're using CSS transitions or animations. It's built upon the
 * [`Transition`](https://reactcommunity.org/react-transition-group/transition)
 * component, so it inherits all of its props.
 *
 * `CSSTransition` applies a pair of class names during the `appear`, `enter`,
 * and `exit` states of the transition. The first class is applied and then a
 * second `*-active` class in order to activate the CSS transition. After the
 * transition, matching `*-done` class names are applied to persist the
 * transition state.
 *
 * ```jsx
 * function App() {
 *   const [inProp, setInProp] = useState(false);
 *   return (
 *     <div>
 *       <CSSTransition in={inProp} timeout={200} classNames="my-node">
 *         <div>
 *           {"I'll receive my-node-* classes"}
 *         </div>
 *       </CSSTransition>
 *       <button type="button" onClick={() => setInProp(true)}>
 *         Click to Enter
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 *
 * When the `in` prop is set to `true`, the child component will first receive
 * the class `example-enter`, then the `example-enter-active` will be added in
 * the next tick. `CSSTransition` [forces a
 * reflow](https://github.com/reactjs/react-transition-group/blob/5007303e729a74be66a21c3e2205e4916821524b/src/CSSTransition.js#L208-L215)
 * between before adding the `example-enter-active`. This is an important trick
 * because it allows us to transition between `example-enter` and
 * `example-enter-active` even though they were added immediately one after
 * another. Most notably, this is what makes it possible for us to animate
 * _appearance_.
 *
 * ```css
 * .my-node-enter {
 *   opacity: 0;
 * }
 * .my-node-enter-active {
 *   opacity: 1;
 *   transition: opacity 200ms;
 * }
 * .my-node-exit {
 *   opacity: 1;
 * }
 * .my-node-exit-active {
 *   opacity: 0;
 *   transition: opacity 200ms;
 * }
 * ```
 *
 * `*-active` classes represent which styles you want to animate **to**, so it's
 * important to add `transition` declaration only to them, otherwise transitions
 * might not behave as intended! This might not be obvious when the transitions
 * are symmetrical, i.e. when `*-enter-active` is the same as `*-exit`, like in
 * the example above (minus `transition`), but it becomes apparent in more
 * complex transitions.
 *
 * **Note**: If you're using the
 * [`appear`](http://reactcommunity.org/react-transition-group/transition#Transition-prop-appear)
 * prop, make sure to define styles for `.appear-*` classes as well.
 */


var CSSTransition = /*#__PURE__*/function (_React$Component) {
  inheritsLoose_inheritsLoose(CSSTransition, _React$Component);

  function CSSTransition() {
    var _this;

    for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
      args[_key] = arguments[_key];
    }

    _this = _React$Component.call.apply(_React$Component, [this].concat(args)) || this;
    _this.appliedClasses = {
      appear: {},
      enter: {},
      exit: {}
    };

    _this.onEnter = function (maybeNode, maybeAppearing) {
      var _this$resolveArgument = _this.resolveArguments(maybeNode, maybeAppearing),
          node = _this$resolveArgument[0],
          appearing = _this$resolveArgument[1];

      _this.removeClasses(node, 'exit');

      _this.addClass(node, appearing ? 'appear' : 'enter', 'base');

      if (_this.props.onEnter) {
        _this.props.onEnter(maybeNode, maybeAppearing);
      }
    };

    _this.onEntering = function (maybeNode, maybeAppearing) {
      var _this$resolveArgument2 = _this.resolveArguments(maybeNode, maybeAppearing),
          node = _this$resolveArgument2[0],
          appearing = _this$resolveArgument2[1];

      var type = appearing ? 'appear' : 'enter';

      _this.addClass(node, type, 'active');

      if (_this.props.onEntering) {
        _this.props.onEntering(maybeNode, maybeAppearing);
      }
    };

    _this.onEntered = function (maybeNode, maybeAppearing) {
      var _this$resolveArgument3 = _this.resolveArguments(maybeNode, maybeAppearing),
          node = _this$resolveArgument3[0],
          appearing = _this$resolveArgument3[1];

      var type = appearing ? 'appear' : 'enter';

      _this.removeClasses(node, type);

      _this.addClass(node, type, 'done');

      if (_this.props.onEntered) {
        _this.props.onEntered(maybeNode, maybeAppearing);
      }
    };

    _this.onExit = function (maybeNode) {
      var _this$resolveArgument4 = _this.resolveArguments(maybeNode),
          node = _this$resolveArgument4[0];

      _this.removeClasses(node, 'appear');

      _this.removeClasses(node, 'enter');

      _this.addClass(node, 'exit', 'base');

      if (_this.props.onExit) {
        _this.props.onExit(maybeNode);
      }
    };

    _this.onExiting = function (maybeNode) {
      var _this$resolveArgument5 = _this.resolveArguments(maybeNode),
          node = _this$resolveArgument5[0];

      _this.addClass(node, 'exit', 'active');

      if (_this.props.onExiting) {
        _this.props.onExiting(maybeNode);
      }
    };

    _this.onExited = function (maybeNode) {
      var _this$resolveArgument6 = _this.resolveArguments(maybeNode),
          node = _this$resolveArgument6[0];

      _this.removeClasses(node, 'exit');

      _this.addClass(node, 'exit', 'done');

      if (_this.props.onExited) {
        _this.props.onExited(maybeNode);
      }
    };

    _this.resolveArguments = function (maybeNode, maybeAppearing) {
      return _this.props.nodeRef ? [_this.props.nodeRef.current, maybeNode] // here `maybeNode` is actually `appearing`
      : [maybeNode, maybeAppearing];
    };

    _this.getClassNames = function (type) {
      var classNames = _this.props.classNames;
      var isStringClassNames = typeof classNames === 'string';
      var prefix = isStringClassNames && classNames ? classNames + "-" : '';
      var baseClassName = isStringClassNames ? "" + prefix + type : classNames[type];
      var activeClassName = isStringClassNames ? baseClassName + "-active" : classNames[type + "Active"];
      var doneClassName = isStringClassNames ? baseClassName + "-done" : classNames[type + "Done"];
      return {
        baseClassName: baseClassName,
        activeClassName: activeClassName,
        doneClassName: doneClassName
      };
    };

    return _this;
  }

  var _proto = CSSTransition.prototype;

  _proto.addClass = function addClass(node, type, phase) {
    var className = this.getClassNames(type)[phase + "ClassName"];

    var _this$getClassNames = this.getClassNames('enter'),
        doneClassName = _this$getClassNames.doneClassName;

    if (type === 'appear' && phase === 'done' && doneClassName) {
      className += " " + doneClassName;
    } // This is to force a repaint,
    // which is necessary in order to transition styles when adding a class name.


    if (phase === 'active') {
      if (node) forceReflow(node);
    }

    if (className) {
      this.appliedClasses[type][phase] = className;

      _addClass(node, className);
    }
  };

  _proto.removeClasses = function removeClasses(node, type) {
    var _this$appliedClasses$ = this.appliedClasses[type],
        baseClassName = _this$appliedClasses$.base,
        activeClassName = _this$appliedClasses$.active,
        doneClassName = _this$appliedClasses$.done;
    this.appliedClasses[type] = {};

    if (baseClassName) {
      removeClass(node, baseClassName);
    }

    if (activeClassName) {
      removeClass(node, activeClassName);
    }

    if (doneClassName) {
      removeClass(node, doneClassName);
    }
  };

  _proto.render = function render() {
    var _this$props = this.props,
        _ = _this$props.classNames,
        props = objectWithoutPropertiesLoose_objectWithoutPropertiesLoose(_this$props, ["classNames"]);

    return /*#__PURE__*/react.createElement(esm_Transition, extends_extends({}, props, {
      onEnter: this.onEnter,
      onEntered: this.onEntered,
      onEntering: this.onEntering,
      onExit: this.onExit,
      onExiting: this.onExiting,
      onExited: this.onExited
    }));
  };

  return CSSTransition;
}(react.Component);

CSSTransition.defaultProps = {
  classNames: ''
};
CSSTransition.propTypes =  false ? 0 : {};
/* harmony default export */ const esm_CSSTransition = (CSSTransition);
;// CONCATENATED MODULE: ./node_modules/color-hash/dist/esm.js
// deno-fmt-ignore-file
// deno-lint-ignore-file
// This code was bundled using `deno bundle` and it's not recommended to edit it manually
var __classPrivateFieldSet = (undefined && undefined.__classPrivateFieldSet) || function (receiver, privateMap, value) {
    if (!privateMap.has(receiver)) {
        throw new TypeError("attempted to set private field on non-instance");
    }
    privateMap.set(receiver, value);
    return value;
};
var __classPrivateFieldGet = (undefined && undefined.__classPrivateFieldGet) || function (receiver, privateMap) {
    if (!privateMap.has(receiver)) {
        throw new TypeError("attempted to get private field on non-instance");
    }
    return privateMap.get(receiver);
};
var _block, _blocks, _bytes, _finalized, _first, _h0, _h1, _h2, _h3, _h4, _h5, _h6, _h7, _hashed, _hBytes, _is224, _lastByteIndex, _start;
const BKDRHash = function (str) {
    var seed = 131;
    var seed2 = 137;
    var hash = 0;
    str += 'x';
    var MAX_SAFE_INTEGER = Math.floor(9007199254740991 / seed2);
    for (let i = 0; i < str.length; i++) {
        if (hash > MAX_SAFE_INTEGER) {
            hash = Math.floor(hash / seed2);
        }
        hash = hash * seed + str.charCodeAt(i);
    }
    return hash;
};
const HEX_CHARS = "0123456789abcdef".split("");
const EXTRA = [
    -2147483648,
    8388608,
    32768,
    128
];
const SHIFT = [
    24,
    16,
    8,
    0
];
const K = [
    0x428a2f98,
    0x71374491,
    0xb5c0fbcf,
    0xe9b5dba5,
    0x3956c25b,
    0x59f111f1,
    0x923f82a4,
    0xab1c5ed5,
    0xd807aa98,
    0x12835b01,
    0x243185be,
    0x550c7dc3,
    0x72be5d74,
    0x80deb1fe,
    0x9bdc06a7,
    0xc19bf174,
    0xe49b69c1,
    0xefbe4786,
    0x0fc19dc6,
    0x240ca1cc,
    0x2de92c6f,
    0x4a7484aa,
    0x5cb0a9dc,
    0x76f988da,
    0x983e5152,
    0xa831c66d,
    0xb00327c8,
    0xbf597fc7,
    0xc6e00bf3,
    0xd5a79147,
    0x06ca6351,
    0x14292967,
    0x27b70a85,
    0x2e1b2138,
    0x4d2c6dfc,
    0x53380d13,
    0x650a7354,
    0x766a0abb,
    0x81c2c92e,
    0x92722c85,
    0xa2bfe8a1,
    0xa81a664b,
    0xc24b8b70,
    0xc76c51a3,
    0xd192e819,
    0xd6990624,
    0xf40e3585,
    0x106aa070,
    0x19a4c116,
    0x1e376c08,
    0x2748774c,
    0x34b0bcb5,
    0x391c0cb3,
    0x4ed8aa4a,
    0x5b9cca4f,
    0x682e6ff3,
    0x748f82ee,
    0x78a5636f,
    0x84c87814,
    0x8cc70208,
    0x90befffa,
    0xa4506ceb,
    0xbef9a3f7,
    0xc67178f2
];
const blocks = [];
class Sha256 {
    constructor(is224 = false, sharedMemory = false) {
        _block.set(this, void 0);
        _blocks.set(this, void 0);
        _bytes.set(this, void 0);
        _finalized.set(this, void 0);
        _first.set(this, void 0);
        _h0.set(this, void 0);
        _h1.set(this, void 0);
        _h2.set(this, void 0);
        _h3.set(this, void 0);
        _h4.set(this, void 0);
        _h5.set(this, void 0);
        _h6.set(this, void 0);
        _h7.set(this, void 0);
        _hashed.set(this, void 0);
        _hBytes.set(this, void 0);
        _is224.set(this, void 0);
        _lastByteIndex.set(this, 0);
        _start.set(this, void 0);
        this.init(is224, sharedMemory);
    }
    init(is224, sharedMemory) {
        if (sharedMemory) {
            blocks[0] = blocks[16] = blocks[1] = blocks[2] = blocks[3] = blocks[4] = blocks[5] = blocks[6] = blocks[7] = blocks[8] = blocks[9] = blocks[10] = blocks[11] = blocks[12] = blocks[13] = blocks[14] = blocks[15] = 0;
            __classPrivateFieldSet(this, _blocks, blocks);
        }
        else {
            __classPrivateFieldSet(this, _blocks, [
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0
            ]);
        }
        if (is224) {
            __classPrivateFieldSet(this, _h0, 0xc1059ed8);
            __classPrivateFieldSet(this, _h1, 0x367cd507);
            __classPrivateFieldSet(this, _h2, 0x3070dd17);
            __classPrivateFieldSet(this, _h3, 0xf70e5939);
            __classPrivateFieldSet(this, _h4, 0xffc00b31);
            __classPrivateFieldSet(this, _h5, 0x68581511);
            __classPrivateFieldSet(this, _h6, 0x64f98fa7);
            __classPrivateFieldSet(this, _h7, 0xbefa4fa4);
        }
        else {
            __classPrivateFieldSet(this, _h0, 0x6a09e667);
            __classPrivateFieldSet(this, _h1, 0xbb67ae85);
            __classPrivateFieldSet(this, _h2, 0x3c6ef372);
            __classPrivateFieldSet(this, _h3, 0xa54ff53a);
            __classPrivateFieldSet(this, _h4, 0x510e527f);
            __classPrivateFieldSet(this, _h5, 0x9b05688c);
            __classPrivateFieldSet(this, _h6, 0x1f83d9ab);
            __classPrivateFieldSet(this, _h7, 0x5be0cd19);
        }
        __classPrivateFieldSet(this, _block, __classPrivateFieldSet(this, _start, __classPrivateFieldSet(this, _bytes, __classPrivateFieldSet(this, _hBytes, 0))));
        __classPrivateFieldSet(this, _finalized, __classPrivateFieldSet(this, _hashed, false));
        __classPrivateFieldSet(this, _first, true);
        __classPrivateFieldSet(this, _is224, is224);
    }
    update(message) {
        if (__classPrivateFieldGet(this, _finalized)) {
            return this;
        }
        let msg;
        if (message instanceof ArrayBuffer) {
            msg = new Uint8Array(message);
        }
        else {
            msg = message;
        }
        let index = 0;
        const length = msg.length;
        const blocks = __classPrivateFieldGet(this, _blocks);
        while (index < length) {
            let i;
            if (__classPrivateFieldGet(this, _hashed)) {
                __classPrivateFieldSet(this, _hashed, false);
                blocks[0] = __classPrivateFieldGet(this, _block);
                blocks[16] = blocks[1] = blocks[2] = blocks[3] = blocks[4] = blocks[5] = blocks[6] = blocks[7] = blocks[8] = blocks[9] = blocks[10] = blocks[11] = blocks[12] = blocks[13] = blocks[14] = blocks[15] = 0;
            }
            if (typeof msg !== "string") {
                for (i = __classPrivateFieldGet(this, _start); index < length && i < 64; ++index) {
                    blocks[i >> 2] |= msg[index] << SHIFT[i++ & 3];
                }
            }
            else {
                for (i = __classPrivateFieldGet(this, _start); index < length && i < 64; ++index) {
                    let code = msg.charCodeAt(index);
                    if (code < 0x80) {
                        blocks[i >> 2] |= code << SHIFT[i++ & 3];
                    }
                    else if (code < 0x800) {
                        blocks[i >> 2] |= (0xc0 | code >> 6) << SHIFT[i++ & 3];
                        blocks[i >> 2] |= (0x80 | code & 0x3f) << SHIFT[i++ & 3];
                    }
                    else if (code < 0xd800 || code >= 0xe000) {
                        blocks[i >> 2] |= (0xe0 | code >> 12) << SHIFT[i++ & 3];
                        blocks[i >> 2] |= (0x80 | code >> 6 & 0x3f) << SHIFT[i++ & 3];
                        blocks[i >> 2] |= (0x80 | code & 0x3f) << SHIFT[i++ & 3];
                    }
                    else {
                        code = 0x10000 + ((code & 0x3ff) << 10 | msg.charCodeAt(++index) & 0x3ff);
                        blocks[i >> 2] |= (0xf0 | code >> 18) << SHIFT[i++ & 3];
                        blocks[i >> 2] |= (0x80 | code >> 12 & 0x3f) << SHIFT[i++ & 3];
                        blocks[i >> 2] |= (0x80 | code >> 6 & 0x3f) << SHIFT[i++ & 3];
                        blocks[i >> 2] |= (0x80 | code & 0x3f) << SHIFT[i++ & 3];
                    }
                }
            }
            __classPrivateFieldSet(this, _lastByteIndex, i);
            __classPrivateFieldSet(this, _bytes, __classPrivateFieldGet(this, _bytes) + (i - __classPrivateFieldGet(this, _start)));
            if (i >= 64) {
                __classPrivateFieldSet(this, _block, blocks[16]);
                __classPrivateFieldSet(this, _start, i - 64);
                this.hash();
                __classPrivateFieldSet(this, _hashed, true);
            }
            else {
                __classPrivateFieldSet(this, _start, i);
            }
        }
        if (__classPrivateFieldGet(this, _bytes) > 4294967295) {
            __classPrivateFieldSet(this, _hBytes, __classPrivateFieldGet(this, _hBytes) + (__classPrivateFieldGet(this, _bytes) / 4294967296 << 0));
            __classPrivateFieldSet(this, _bytes, __classPrivateFieldGet(this, _bytes) % 4294967296);
        }
        return this;
    }
    finalize() {
        if (__classPrivateFieldGet(this, _finalized)) {
            return;
        }
        __classPrivateFieldSet(this, _finalized, true);
        const blocks = __classPrivateFieldGet(this, _blocks);
        const i = __classPrivateFieldGet(this, _lastByteIndex);
        blocks[16] = __classPrivateFieldGet(this, _block);
        blocks[i >> 2] |= EXTRA[i & 3];
        __classPrivateFieldSet(this, _block, blocks[16]);
        if (i >= 56) {
            if (!__classPrivateFieldGet(this, _hashed)) {
                this.hash();
            }
            blocks[0] = __classPrivateFieldGet(this, _block);
            blocks[16] = blocks[1] = blocks[2] = blocks[3] = blocks[4] = blocks[5] = blocks[6] = blocks[7] = blocks[8] = blocks[9] = blocks[10] = blocks[11] = blocks[12] = blocks[13] = blocks[14] = blocks[15] = 0;
        }
        blocks[14] = __classPrivateFieldGet(this, _hBytes) << 3 | __classPrivateFieldGet(this, _bytes) >>> 29;
        blocks[15] = __classPrivateFieldGet(this, _bytes) << 3;
        this.hash();
    }
    hash() {
        let a = __classPrivateFieldGet(this, _h0);
        let b = __classPrivateFieldGet(this, _h1);
        let c = __classPrivateFieldGet(this, _h2);
        let d = __classPrivateFieldGet(this, _h3);
        let e = __classPrivateFieldGet(this, _h4);
        let f = __classPrivateFieldGet(this, _h5);
        let g = __classPrivateFieldGet(this, _h6);
        let h = __classPrivateFieldGet(this, _h7);
        const blocks = __classPrivateFieldGet(this, _blocks);
        let s0;
        let s1;
        let maj;
        let t1;
        let t2;
        let ch;
        let ab;
        let da;
        let cd;
        let bc;
        for (let j = 16; j < 64; ++j) {
            t1 = blocks[j - 15];
            s0 = (t1 >>> 7 | t1 << 25) ^ (t1 >>> 18 | t1 << 14) ^ t1 >>> 3;
            t1 = blocks[j - 2];
            s1 = (t1 >>> 17 | t1 << 15) ^ (t1 >>> 19 | t1 << 13) ^ t1 >>> 10;
            blocks[j] = blocks[j - 16] + s0 + blocks[j - 7] + s1 << 0;
        }
        bc = b & c;
        for (let j1 = 0; j1 < 64; j1 += 4) {
            if (__classPrivateFieldGet(this, _first)) {
                if (__classPrivateFieldGet(this, _is224)) {
                    ab = 300032;
                    t1 = blocks[0] - 1413257819;
                    h = t1 - 150054599 << 0;
                    d = t1 + 24177077 << 0;
                }
                else {
                    ab = 704751109;
                    t1 = blocks[0] - 210244248;
                    h = t1 - 1521486534 << 0;
                    d = t1 + 143694565 << 0;
                }
                __classPrivateFieldSet(this, _first, false);
            }
            else {
                s0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
                s1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
                ab = a & b;
                maj = ab ^ a & c ^ bc;
                ch = e & f ^ ~e & g;
                t1 = h + s1 + ch + K[j1] + blocks[j1];
                t2 = s0 + maj;
                h = d + t1 << 0;
                d = t1 + t2 << 0;
            }
            s0 = (d >>> 2 | d << 30) ^ (d >>> 13 | d << 19) ^ (d >>> 22 | d << 10);
            s1 = (h >>> 6 | h << 26) ^ (h >>> 11 | h << 21) ^ (h >>> 25 | h << 7);
            da = d & a;
            maj = da ^ d & b ^ ab;
            ch = h & e ^ ~h & f;
            t1 = g + s1 + ch + K[j1 + 1] + blocks[j1 + 1];
            t2 = s0 + maj;
            g = c + t1 << 0;
            c = t1 + t2 << 0;
            s0 = (c >>> 2 | c << 30) ^ (c >>> 13 | c << 19) ^ (c >>> 22 | c << 10);
            s1 = (g >>> 6 | g << 26) ^ (g >>> 11 | g << 21) ^ (g >>> 25 | g << 7);
            cd = c & d;
            maj = cd ^ c & a ^ da;
            ch = g & h ^ ~g & e;
            t1 = f + s1 + ch + K[j1 + 2] + blocks[j1 + 2];
            t2 = s0 + maj;
            f = b + t1 << 0;
            b = t1 + t2 << 0;
            s0 = (b >>> 2 | b << 30) ^ (b >>> 13 | b << 19) ^ (b >>> 22 | b << 10);
            s1 = (f >>> 6 | f << 26) ^ (f >>> 11 | f << 21) ^ (f >>> 25 | f << 7);
            bc = b & c;
            maj = bc ^ b & d ^ cd;
            ch = f & g ^ ~f & h;
            t1 = e + s1 + ch + K[j1 + 3] + blocks[j1 + 3];
            t2 = s0 + maj;
            e = a + t1 << 0;
            a = t1 + t2 << 0;
        }
        __classPrivateFieldSet(this, _h0, __classPrivateFieldGet(this, _h0) + a << 0);
        __classPrivateFieldSet(this, _h1, __classPrivateFieldGet(this, _h1) + b << 0);
        __classPrivateFieldSet(this, _h2, __classPrivateFieldGet(this, _h2) + c << 0);
        __classPrivateFieldSet(this, _h3, __classPrivateFieldGet(this, _h3) + d << 0);
        __classPrivateFieldSet(this, _h4, __classPrivateFieldGet(this, _h4) + e << 0);
        __classPrivateFieldSet(this, _h5, __classPrivateFieldGet(this, _h5) + f << 0);
        __classPrivateFieldSet(this, _h6, __classPrivateFieldGet(this, _h6) + g << 0);
        __classPrivateFieldSet(this, _h7, __classPrivateFieldGet(this, _h7) + h << 0);
    }
    hex() {
        this.finalize();
        const h0 = __classPrivateFieldGet(this, _h0);
        const h1 = __classPrivateFieldGet(this, _h1);
        const h2 = __classPrivateFieldGet(this, _h2);
        const h3 = __classPrivateFieldGet(this, _h3);
        const h4 = __classPrivateFieldGet(this, _h4);
        const h5 = __classPrivateFieldGet(this, _h5);
        const h6 = __classPrivateFieldGet(this, _h6);
        const h7 = __classPrivateFieldGet(this, _h7);
        let hex = HEX_CHARS[h0 >> 28 & 0x0f] + HEX_CHARS[h0 >> 24 & 0x0f] + HEX_CHARS[h0 >> 20 & 0x0f] + HEX_CHARS[h0 >> 16 & 0x0f] + HEX_CHARS[h0 >> 12 & 0x0f] + HEX_CHARS[h0 >> 8 & 0x0f] + HEX_CHARS[h0 >> 4 & 0x0f] + HEX_CHARS[h0 & 0x0f] + HEX_CHARS[h1 >> 28 & 0x0f] + HEX_CHARS[h1 >> 24 & 0x0f] + HEX_CHARS[h1 >> 20 & 0x0f] + HEX_CHARS[h1 >> 16 & 0x0f] + HEX_CHARS[h1 >> 12 & 0x0f] + HEX_CHARS[h1 >> 8 & 0x0f] + HEX_CHARS[h1 >> 4 & 0x0f] + HEX_CHARS[h1 & 0x0f] + HEX_CHARS[h2 >> 28 & 0x0f] + HEX_CHARS[h2 >> 24 & 0x0f] + HEX_CHARS[h2 >> 20 & 0x0f] + HEX_CHARS[h2 >> 16 & 0x0f] + HEX_CHARS[h2 >> 12 & 0x0f] + HEX_CHARS[h2 >> 8 & 0x0f] + HEX_CHARS[h2 >> 4 & 0x0f] + HEX_CHARS[h2 & 0x0f] + HEX_CHARS[h3 >> 28 & 0x0f] + HEX_CHARS[h3 >> 24 & 0x0f] + HEX_CHARS[h3 >> 20 & 0x0f] + HEX_CHARS[h3 >> 16 & 0x0f] + HEX_CHARS[h3 >> 12 & 0x0f] + HEX_CHARS[h3 >> 8 & 0x0f] + HEX_CHARS[h3 >> 4 & 0x0f] + HEX_CHARS[h3 & 0x0f] + HEX_CHARS[h4 >> 28 & 0x0f] + HEX_CHARS[h4 >> 24 & 0x0f] + HEX_CHARS[h4 >> 20 & 0x0f] + HEX_CHARS[h4 >> 16 & 0x0f] + HEX_CHARS[h4 >> 12 & 0x0f] + HEX_CHARS[h4 >> 8 & 0x0f] + HEX_CHARS[h4 >> 4 & 0x0f] + HEX_CHARS[h4 & 0x0f] + HEX_CHARS[h5 >> 28 & 0x0f] + HEX_CHARS[h5 >> 24 & 0x0f] + HEX_CHARS[h5 >> 20 & 0x0f] + HEX_CHARS[h5 >> 16 & 0x0f] + HEX_CHARS[h5 >> 12 & 0x0f] + HEX_CHARS[h5 >> 8 & 0x0f] + HEX_CHARS[h5 >> 4 & 0x0f] + HEX_CHARS[h5 & 0x0f] + HEX_CHARS[h6 >> 28 & 0x0f] + HEX_CHARS[h6 >> 24 & 0x0f] + HEX_CHARS[h6 >> 20 & 0x0f] + HEX_CHARS[h6 >> 16 & 0x0f] + HEX_CHARS[h6 >> 12 & 0x0f] + HEX_CHARS[h6 >> 8 & 0x0f] + HEX_CHARS[h6 >> 4 & 0x0f] + HEX_CHARS[h6 & 0x0f];
        if (!__classPrivateFieldGet(this, _is224)) {
            hex += HEX_CHARS[h7 >> 28 & 0x0f] + HEX_CHARS[h7 >> 24 & 0x0f] + HEX_CHARS[h7 >> 20 & 0x0f] + HEX_CHARS[h7 >> 16 & 0x0f] + HEX_CHARS[h7 >> 12 & 0x0f] + HEX_CHARS[h7 >> 8 & 0x0f] + HEX_CHARS[h7 >> 4 & 0x0f] + HEX_CHARS[h7 & 0x0f];
        }
        return hex;
    }
    toString() {
        return this.hex();
    }
    digest() {
        this.finalize();
        const h0 = __classPrivateFieldGet(this, _h0);
        const h1 = __classPrivateFieldGet(this, _h1);
        const h2 = __classPrivateFieldGet(this, _h2);
        const h3 = __classPrivateFieldGet(this, _h3);
        const h4 = __classPrivateFieldGet(this, _h4);
        const h5 = __classPrivateFieldGet(this, _h5);
        const h6 = __classPrivateFieldGet(this, _h6);
        const h7 = __classPrivateFieldGet(this, _h7);
        const arr = [
            h0 >> 24 & 0xff,
            h0 >> 16 & 0xff,
            h0 >> 8 & 0xff,
            h0 & 0xff,
            h1 >> 24 & 0xff,
            h1 >> 16 & 0xff,
            h1 >> 8 & 0xff,
            h1 & 0xff,
            h2 >> 24 & 0xff,
            h2 >> 16 & 0xff,
            h2 >> 8 & 0xff,
            h2 & 0xff,
            h3 >> 24 & 0xff,
            h3 >> 16 & 0xff,
            h3 >> 8 & 0xff,
            h3 & 0xff,
            h4 >> 24 & 0xff,
            h4 >> 16 & 0xff,
            h4 >> 8 & 0xff,
            h4 & 0xff,
            h5 >> 24 & 0xff,
            h5 >> 16 & 0xff,
            h5 >> 8 & 0xff,
            h5 & 0xff,
            h6 >> 24 & 0xff,
            h6 >> 16 & 0xff,
            h6 >> 8 & 0xff,
            h6 & 0xff
        ];
        if (!__classPrivateFieldGet(this, _is224)) {
            arr.push(h7 >> 24 & 0xff, h7 >> 16 & 0xff, h7 >> 8 & 0xff, h7 & 0xff);
        }
        return arr;
    }
    array() {
        return this.digest();
    }
    arrayBuffer() {
        this.finalize();
        const buffer = new ArrayBuffer(__classPrivateFieldGet(this, _is224) ? 28 : 32);
        const dataView = new DataView(buffer);
        dataView.setUint32(0, __classPrivateFieldGet(this, _h0));
        dataView.setUint32(4, __classPrivateFieldGet(this, _h1));
        dataView.setUint32(8, __classPrivateFieldGet(this, _h2));
        dataView.setUint32(12, __classPrivateFieldGet(this, _h3));
        dataView.setUint32(16, __classPrivateFieldGet(this, _h4));
        dataView.setUint32(20, __classPrivateFieldGet(this, _h5));
        dataView.setUint32(24, __classPrivateFieldGet(this, _h6));
        if (!__classPrivateFieldGet(this, _is224)) {
            dataView.setUint32(28, __classPrivateFieldGet(this, _h7));
        }
        return buffer;
    }
}
_block = new WeakMap(), _blocks = new WeakMap(), _bytes = new WeakMap(), _finalized = new WeakMap(), _first = new WeakMap(), _h0 = new WeakMap(), _h1 = new WeakMap(), _h2 = new WeakMap(), _h3 = new WeakMap(), _h4 = new WeakMap(), _h5 = new WeakMap(), _h6 = new WeakMap(), _h7 = new WeakMap(), _hashed = new WeakMap(), _hBytes = new WeakMap(), _is224 = new WeakMap(), _lastByteIndex = new WeakMap(), _start = new WeakMap();
function Sha256ToInt(s) {
    const sha256 = new Sha256();
    sha256.update(s);
    return parseInt(sha256.hex().substring(0, 8), 16);
}
const RGB2HEX = function (RGBArray) {
    var hex = '#';
    RGBArray.forEach(function (value) {
        if (value < 16) {
            hex += 0;
        }
        hex += value.toString(16);
    });
    return hex;
};
const HSL2RGB = function (H, S, L) {
    H /= 360;
    var q = L < 0.5 ? L * (1 + S) : L + S - L * S;
    var p = 2 * L - q;
    return [
        H + 1 / 3,
        H,
        H - 1 / 3
    ].map(function (color) {
        if (color < 0) {
            color++;
        }
        if (color > 1) {
            color--;
        }
        if (color < 1 / 6) {
            color = p + (q - p) * 6 * color;
        }
        else if (color < 0.5) {
            color = q;
        }
        else if (color < 2 / 3) {
            color = p + (q - p) * 6 * (2 / 3 - color);
        }
        else {
            color = p;
        }
        return Math.round(color * 255);
    });
};
class ColorHash {
    constructor(options = {}) {
        const [L, S] = [
            options.lightness,
            options.saturation
        ].map(function (param) {
            param = param !== undefined ? param : [
                0.35,
                0.5,
                0.65
            ];
            return Array.isArray(param) ? param.concat() : [
                param
            ];
        });
        this.L = L;
        this.S = S;
        if (typeof options.hue === 'number') {
            options.hue = {
                min: options.hue,
                max: options.hue
            };
        }
        if (typeof options.hue === 'object' && !Array.isArray(options.hue)) {
            options.hue = [
                options.hue
            ];
        }
        if (typeof options.hue === 'undefined') {
            options.hue = [];
        }
        this.hueRanges = options.hue.map(function (range) {
            return {
                min: typeof range.min === 'undefined' ? 0 : range.min,
                max: typeof range.max === 'undefined' ? 360 : range.max
            };
        });
        this.hash = Sha256ToInt;
        if (typeof options.hash === 'function') {
            this.hash = options.hash;
        }
        if (options.hash === 'bkdr') {
            this.hash = BKDRHash;
        }
    }
    hsl(str) {
        var H, S, L;
        var hash = this.hash(str);
        var hueResolution = 727;
        if (this.hueRanges.length) {
            const range = this.hueRanges[hash % this.hueRanges.length];
            H = hash / this.hueRanges.length % hueResolution * (range.max - range.min) / hueResolution + range.min;
        }
        else {
            H = hash % 359;
        }
        hash = Math.ceil(hash / 360);
        S = this.S[hash % this.S.length];
        hash = Math.ceil(hash / this.S.length);
        L = this.L[hash % this.L.length];
        return [
            H,
            S,
            L
        ];
    }
    rgb(str) {
        var hsl = this.hsl(str);
        return HSL2RGB.apply(this, hsl);
    }
    hex(str) {
        var rgb = this.rgb(str);
        return RGB2HEX(rgb);
    }
}


;// CONCATENATED MODULE: ./app/js/LazyImage.tsx





const loadedSrcs = new Set();
const pendingLazyImages = new Set();
function checkShouldLoadLazyImages() {
    for (const lazyImage of pendingLazyImages) {
        lazyImage.checkShouldLoad();
    }
}
// Begin the loading process a full second after initial execution to allow the popup to open
// before loading images. If images begin to load too soon after the popup opens, Chrome waits
// for them to fully load before showing the popup.
let shouldCheck = false;
setTimeout(() => {
    shouldCheck = true;
    checkShouldLoadLazyImages();
}, 1000);
const colorHash = new ColorHash();
class LazyImage extends react.PureComponent {
    constructor(props) {
        super(props);
        this._img = undefined;
        this._placeholder = undefined;
        this.setLoaded = () => {
            this._img = null;
            loadedSrcs.add(this.props.src);
            this.setState({ loaded: true });
        };
        this.state = {
            loaded: this.props.src == null || loadedSrcs.has(this.props.src),
        };
    }
    componentDidMount() {
        if (!this.state.loaded) {
            pendingLazyImages.add(this);
            if (shouldCheck)
                this.checkShouldLoad();
        }
    }
    componentWillUnmount() {
        if (pendingLazyImages.has(this)) {
            pendingLazyImages.delete(this);
        }
        // Ensure the loading image does not try to call this soon-to-be-unmounted component.
        if (this._img != null) {
            this._img.onload = null;
            this._img = null;
        }
    }
    checkShouldLoad() {
        if (!shouldCheck)
            return;
        const { src } = this.props;
        if (src == null || !this._placeholder)
            return;
        this._img = new Image();
        this._img.onload = this.setLoaded;
        this._img.src = src;
        pendingLazyImages.delete(this);
    }
    render() {
        return (react.createElement(esm_TransitionGroup, { className: "lazy-image-container" }, this.props.src != null && this.state.loaded ? (react.createElement(esm_CSSTransition, { classNames: "lazy-image", key: "img", timeout: 250 },
            react.createElement("img", { alt: this.props.alt, className: classnames_default()("lazy-image-img", this.props.className), height: this.props.height, src: this.props.src, style: this.props.style, width: this.props.width }))) : (react.createElement(esm_CSSTransition, { classNames: "lazy-image", key: "placeholder", timeout: 250 },
            react.createElement("div", { className: this.props.className, ref: (placeholder) => {
                    this._placeholder = placeholder;
                }, style: Object.assign({}, this.props.style, {
                    background: colorHash.hex(this.props.src),
                    borderRadius: `${this.props.height / 2}px`,
                    height: `${this.props.height}px`,
                    width: `${this.props.width}px`,
                }) })))));
    }
}

;// CONCATENATED MODULE: ./node_modules/timeago.js/esm/lang/en_US.js
var EN_US = ['second', 'minute', 'hour', 'day', 'week', 'month', 'year'];
/* harmony default export */ function en_US(diff, idx) {
    if (idx === 0)
        return ['just now', 'right now'];
    var unit = EN_US[Math.floor(idx / 2)];
    if (diff > 1)
        unit += 's';
    return [diff + " " + unit + " ago", "in " + diff + " " + unit];
}
//# sourceMappingURL=en_US.js.map
;// CONCATENATED MODULE: ./node_modules/timeago.js/esm/lang/zh_CN.js
var ZH_CN = ['秒', '分钟', '小时', '天', '周', '个月', '年'];
/* harmony default export */ function zh_CN(diff, idx) {
    if (idx === 0)
        return ['刚刚', '片刻后'];
    var unit = ZH_CN[~~(idx / 2)];
    return [diff + " " + unit + "\u524D", diff + " " + unit + "\u540E"];
}
//# sourceMappingURL=zh_CN.js.map
;// CONCATENATED MODULE: ./node_modules/timeago.js/esm/register.js
/**
 * Created by hustcc on 18/5/20.
 * Contract: i@hust.cc
 */
/**
 * All supported locales
 */
var Locales = {};
/**
 * register a locale
 * @param locale
 * @param func
 */
var register = function (locale, func) {
    Locales[locale] = func;
};
/**
 * get a locale, default is en_US
 * @param locale
 * @returns {*}
 */
var getLocale = function (locale) {
    return Locales[locale] || Locales['en_US'];
};
//# sourceMappingURL=register.js.map
;// CONCATENATED MODULE: ./node_modules/timeago.js/esm/utils/date.js
/**
 * Created by hustcc on 18/5/20.
 * Contract: i@hust.cc
 */
var SEC_ARRAY = [
    60,
    60,
    24,
    7,
    365 / 7 / 12,
    12,
];
/**
 * format Date / string / timestamp to timestamp
 * @param input
 * @returns {*}
 */
function toDate(input) {
    if (input instanceof Date)
        return input;
    // @ts-ignore
    if (!isNaN(input) || /^\d+$/.test(input))
        return new Date(parseInt(input));
    input = (input || '')
        // @ts-ignore
        .trim()
        .replace(/\.\d+/, '') // remove milliseconds
        .replace(/-/, '/')
        .replace(/-/, '/')
        .replace(/(\d)T(\d)/, '$1 $2')
        .replace(/Z/, ' UTC') // 2017-2-5T3:57:52Z -> 2017-2-5 3:57:52UTC
        .replace(/([+-]\d\d):?(\d\d)/, ' $1$2'); // -04:00 -> -0400
    return new Date(input);
}
/**
 * format the diff second to *** time ago, with setting locale
 * @param diff
 * @param localeFunc
 * @returns
 */
function formatDiff(diff, localeFunc) {
    /**
     * if locale is not exist, use defaultLocale.
     * if defaultLocale is not exist, use build-in `en`.
     * be sure of no error when locale is not exist.
     *
     * If `time in`, then 1
     * If `time ago`, then 0
     */
    var agoIn = diff < 0 ? 1 : 0;
    /**
     * Get absolute value of number (|diff| is non-negative) value of x
     * |diff| = diff if diff is positive
     * |diff| = -diff if diff is negative
     * |0| = 0
     */
    diff = Math.abs(diff);
    /**
     * Time in seconds
     */
    var totalSec = diff;
    /**
     * Unit of time
     */
    var idx = 0;
    for (; diff >= SEC_ARRAY[idx] && idx < SEC_ARRAY.length; idx++) {
        diff /= SEC_ARRAY[idx];
    }
    /**
     * Math.floor() is alternative of ~~
     *
     * The differences and bugs:
     * Math.floor(3.7) -> 4 but ~~3.7 -> 3
     * Math.floor(1559125440000.6) -> 1559125440000 but ~~1559125440000.6 -> 52311552
     *
     * More information about the performance of algebraic:
     * https://www.youtube.com/watch?v=65-RbBwZQdU
     */
    diff = Math.floor(diff);
    idx *= 2;
    if (diff > (idx === 0 ? 9 : 1))
        idx += 1;
    return localeFunc(diff, idx, totalSec)[agoIn].replace('%s', diff.toString());
}
/**
 * calculate the diff second between date to be formatted an now date.
 * @param date
 * @param relativeDate
 * @returns {number}
 */
function diffSec(date, relativeDate) {
    var relDate = relativeDate ? toDate(relativeDate) : new Date();
    return (+relDate - +toDate(date)) / 1000;
}
/**
 * nextInterval: calculate the next interval time.
 * - diff: the diff sec between now and date to be formatted.
 *
 * What's the meaning?
 * diff = 61 then return 59
 * diff = 3601 (an hour + 1 second), then return 3599
 * make the interval with high performance.
 **/
function nextInterval(diff) {
    var rst = 1, i = 0, d = Math.abs(diff);
    for (; diff >= SEC_ARRAY[i] && i < SEC_ARRAY.length; i++) {
        diff /= SEC_ARRAY[i];
        rst *= SEC_ARRAY[i];
    }
    d = d % rst;
    d = d ? rst - d : rst;
    return Math.ceil(d);
}
//# sourceMappingURL=date.js.map
;// CONCATENATED MODULE: ./node_modules/timeago.js/esm/format.js


/**
 * format a TDate into string
 * @param date
 * @param locale
 * @param opts
 */
var format = function (date, locale, opts) {
    // diff seconds
    var sec = diffSec(date, opts && opts.relativeDate);
    // format it with locale
    return formatDiff(sec, getLocale(locale));
};
//# sourceMappingURL=format.js.map
;// CONCATENATED MODULE: ./node_modules/timeago.js/esm/utils/dom.js
var ATTR_TIMEAGO_TID = 'timeago-id';
/**
 * get the datetime attribute, `datetime` are supported.
 * @param node
 * @returns {*}
 */
function getDateAttribute(node) {
    return node.getAttribute('datetime');
}
/**
 * set the node attribute, native DOM
 * @param node
 * @param timerId
 * @returns {*}
 */
function setTimerId(node, timerId) {
    // @ts-ignore
    node.setAttribute(ATTR_TIMEAGO_TID, timerId);
}
/**
 * get the timer id
 * @param node
 */
function getTimerId(node) {
    return parseInt(node.getAttribute(ATTR_TIMEAGO_TID));
}
//# sourceMappingURL=dom.js.map
;// CONCATENATED MODULE: ./node_modules/timeago.js/esm/realtime.js



// all realtime timer
var TIMER_POOL = {};
/**
 * clear a timer from pool
 * @param tid
 */
var clear = function (tid) {
    clearTimeout(tid);
    delete TIMER_POOL[tid];
};
// run with timer(setTimeout)
function run(node, date, localeFunc, opts) {
    // clear the node's exist timer
    clear(getTimerId(node));
    var relativeDate = opts.relativeDate, minInterval = opts.minInterval;
    // get diff seconds
    var diff = diffSec(date, relativeDate);
    // render
    node.innerText = formatDiff(diff, localeFunc);
    var tid = setTimeout(function () {
        run(node, date, localeFunc, opts);
    }, Math.min(Math.max(nextInterval(diff), minInterval || 1) * 1000, 0x7fffffff));
    // there is no need to save node in object. Just save the key
    TIMER_POOL[tid] = 0;
    setTimerId(node, tid);
}
/**
 * cancel a timer or all timers
 * @param node - node hosting the time string
 */
function realtime_cancel(node) {
    // cancel one
    if (node)
        clear(getTimerId(node));
    // cancel all
    // @ts-ignore
    else
        Object.keys(TIMER_POOL).forEach(clear);
}
/**
 * render a dom realtime
 * @param nodes
 * @param locale
 * @param opts
 */
function render(nodes, locale, opts) {
    // by .length
    // @ts-ignore
    var nodeList = nodes.length ? nodes : [nodes];
    nodeList.forEach(function (node) {
        run(node, getDateAttribute(node), getLocale(locale), opts || {});
    });
    return nodeList;
}
//# sourceMappingURL=realtime.js.map
;// CONCATENATED MODULE: ./node_modules/timeago.js/esm/index.js
/**
 * Created by hustcc on 18/5/20.
 * Contract: i@hust.cc
 */



register('en_US', en_US);
register('zh_CN', zh_CN);



//# sourceMappingURL=index.js.map
;// CONCATENATED MODULE: ./node_modules/timeago-react/esm/timeago-react.js
var __extends = (undefined && undefined.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __assign = (undefined && undefined.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __rest = (undefined && undefined.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};


/**
 * Convert input to a valid datetime string of <time> tag
 * https://developer.mozilla.org/en-US/docs/Web/HTML/Element/time
 * @param input
 * @returns datetime string
 */
var toDateTime = function (input) {
    // let date: Date = new Date();
    // if (input instanceof Date) {
    //   date = input;
    //   //@ts-ignore
    // } else if (!isNaN(input) || /^\d+$/.test(input)) {
    //   //@ts-ignore
    //   date = new Date(parseInt(input));
    // } else {
    //   date = new Date(input);
    // }
    // try {
    //   return date.toISOString();
    // } catch (e) {
    //   console.error('invalid datetime');
    //   return '';
    // }
    return '' + (input instanceof Date ? input.getTime() : input);
};
var TimeAgo = /** @class */ (function (_super) {
    __extends(TimeAgo, _super);
    function TimeAgo() {
        var _this = _super !== null && _super.apply(this, arguments) || this;
        _this.dom = null;
        return _this;
    }
    TimeAgo.prototype.componentDidMount = function () {
        // fixed #6 https://github.com/hustcc/timeago-react/issues/6
        // to reduce the file size.
        // const { locale } = this.props;
        // if (locale !== 'en' && locale !== 'zh_CN') {
        //   timeago.register(locale, require('timeago.js/locales/' + locale));
        // }
        // render it.
        this.renderTimeAgo();
    };
    TimeAgo.prototype.componentDidUpdate = function () {
        this.renderTimeAgo();
    };
    TimeAgo.prototype.renderTimeAgo = function () {
        var _a = this.props, live = _a.live, datetime = _a.datetime, locale = _a.locale, opts = _a.opts;
        // cancel all the interval
        realtime_cancel(this.dom);
        // if is live
        if (live !== false) {
            // live render
            this.dom.setAttribute('datetime', toDateTime(datetime));
            render(this.dom, locale, opts);
        }
    };
    // remove
    TimeAgo.prototype.componentWillUnmount = function () {
        realtime_cancel(this.dom);
    };
    // for render
    TimeAgo.prototype.render = function () {
        var _this = this;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        var _a = this.props, datetime = _a.datetime, live = _a.live, locale = _a.locale, opts = _a.opts, others = __rest(_a, ["datetime", "live", "locale", "opts"]);
        return (react.createElement("time", __assign({ ref: function (c) {
                _this.dom = c;
            } }, others), format(datetime, locale, opts)));
    };
    TimeAgo.defaultProps = {
        live: true,
        className: '',
    };
    return TimeAgo;
}(react.PureComponent));
/* harmony default export */ const timeago_react = (TimeAgo);
//# sourceMappingURL=timeago-react.js.map
;// CONCATENATED MODULE: ./app/js/ClosedTabRow.tsx






function ClosedTabRow({ isSelected, onOpenTab, onRemoveTab, onToggleTab, session, style, tab, }) {
    var _a;
    return (react.createElement("div", { "aria-label": "row", className: classnames_default()("ReactVirtualized__Table__row", { "table-warning": isSelected }), role: "row", style: style },
        react.createElement("div", { className: "ReactVirtualized__Table__rowColumn", style: { verticalAlign: "middle" } },
            react.createElement("input", { checked: isSelected, className: "checkbox--td", onClick: (event) => {
                    // Dynamic type check to ensure target is an input element.
                    if (!(event.target instanceof HTMLInputElement))
                        return;
                    onToggleTab(tab, event.target.checked, event.shiftKey);
                }, type: "checkbox", readOnly: true })),
        react.createElement("div", { className: "faviconCol ReactVirtualized__Table__rowColumn", style: { verticalAlign: "middle" } },
            react.createElement(LazyImage, { alt: "", className: "faviconCol--hover-hidden favicon", height: 16, src: (_a = tab.favIconUrl) !== null && _a !== void 0 ? _a : "", width: 16 }),
            react.createElement("span", { className: "faviconCol--hover-shown", onClick: () => {
                    onRemoveTab(tab);
                }, role: "button", style: { cursor: "pointer", height: 16, width: 16 }, tabIndex: 0, title: "Remove this tab" },
                react.createElement("i", { className: "fas fa-trash-alt" }))),
        react.createElement("div", { className: "ReactVirtualized__Table__rowColumn py-1", style: { flex: 1 } },
            react.createElement("div", { style: { display: "flex" } },
                react.createElement("div", { className: "CorralTabRow-content" },
                    react.createElement("a", { href: tab.url, onClick: (event) => {
                            event.preventDefault();
                            onOpenTab(tab, session);
                        }, rel: "noopener noreferrer", style: { flex: 1 }, target: "_blank", title: tab.url }, tab.title),
                    react.createElement("br", null),
                    react.createElement("small", { className: classnames_default()({ "text-muted": !isSelected }) },
                        "(",
                        tab.url == null ? "???" : extractHostname(tab.url),
                        ")")))),
        react.createElement("div", { className: "ReactVirtualized__Table__rowColumn text-right", style: { verticalAlign: "middle" }, title: 
            // @ts-expect-error `closedAt` is a TW expando property on tabs
            new Date(tab.closedAt).toLocaleString() },
            react.createElement(timeago_react, { datetime: tab.closedAt, locale: chrome.i18n.getUILanguage() })),
        react.createElement("div", { className: "ReactVirtualized__Table__rowColumn", style: { width: "11px" } }, session == null ? null : (react.createElement("abbr", { title: chrome.i18n.getMessage("corral_tabSessionFresh") },
            react.createElement("i", { className: "fas fa-leaf text-success" }))))));
}

;// CONCATENATED MODULE: ./node_modules/dom-helpers/esm/querySelectorAll.js
var toArray = Function.prototype.bind.call(Function.prototype.call, [].slice);
/**
 * Runs `querySelectorAll` on a given element.
 * 
 * @param element the element
 * @param selector the selector
 */

function qsa(element, selector) {
  return toArray(element.querySelectorAll(selector));
}
;// CONCATENATED MODULE: ./node_modules/dom-helpers/esm/addEventListener.js
/* eslint-disable no-return-assign */

var optionsSupported = false;
var onceSupported = false;

try {
  var options = {
    get passive() {
      return optionsSupported = true;
    },

    get once() {
      // eslint-disable-next-line no-multi-assign
      return onceSupported = optionsSupported = true;
    }

  };

  if (canUseDOM) {
    window.addEventListener('test', options, options);
    window.removeEventListener('test', options, true);
  }
} catch (e) {
  /* */
}

/**
 * An `addEventListener` ponyfill, supports the `once` option
 * 
 * @param node the element
 * @param eventName the event name
 * @param handle the handler
 * @param options event options
 */
function addEventListener(node, eventName, handler, options) {
  if (options && typeof options !== 'boolean' && !onceSupported) {
    var once = options.once,
        capture = options.capture;
    var wrappedHandler = handler;

    if (!onceSupported && once) {
      wrappedHandler = handler.__once || function onceHandler(event) {
        this.removeEventListener(eventName, onceHandler, capture);
        handler.call(this, event);
      };

      handler.__once = wrappedHandler;
    }

    node.addEventListener(eventName, wrappedHandler, optionsSupported ? options : capture);
  }

  node.addEventListener(eventName, handler, options);
}

/* harmony default export */ const esm_addEventListener = (addEventListener);
;// CONCATENATED MODULE: ./node_modules/@restart/ui/node_modules/uncontrollable/lib/esm/index.js
function esm_objectWithoutPropertiesLoose(source, excluded) { if (source == null) return {}; var target = {}; var sourceKeys = Object.keys(source); var key, i; for (i = 0; i < sourceKeys.length; i++) { key = sourceKeys[i]; if (excluded.indexOf(key) >= 0) continue; target[key] = source[key]; } return target; }
function _toPropertyKey(arg) { var key = _toPrimitive(arg, "string"); return typeof key === "symbol" ? key : String(key); }
function _toPrimitive(input, hint) { if (typeof input !== "object" || input === null) return input; var prim = input[Symbol.toPrimitive]; if (prim !== undefined) { var res = prim.call(input, hint || "default"); if (typeof res !== "object") return res; throw new TypeError("@@toPrimitive must return a primitive value."); } return (hint === "string" ? String : Number)(input); }

function defaultKey(key) {
  return 'default' + key.charAt(0).toUpperCase() + key.substr(1);
}
function useUncontrolledProp(propValue, defaultValue, handler) {
  const wasPropRef = (0,react.useRef)(propValue !== undefined);
  const [stateValue, setState] = (0,react.useState)(defaultValue);
  const isProp = propValue !== undefined;
  const wasProp = wasPropRef.current;
  wasPropRef.current = isProp;

  /**
   * If a prop switches from controlled to Uncontrolled
   * reset its value to the defaultValue
   */
  if (!isProp && wasProp && stateValue !== defaultValue) {
    setState(defaultValue);
  }
  return [isProp ? propValue : stateValue, (0,react.useCallback)((...args) => {
    const [value, ...rest] = args;
    let returnValue = handler == null ? void 0 : handler(value, ...rest);
    setState(value);
    return returnValue;
  }, [handler])];
}

function useUncontrolled(props, config) {
  return Object.keys(config).reduce((result, fieldName) => {
    const _ref = result,
      _defaultKey = defaultKey(fieldName),
      {
        [_defaultKey]: defaultValue,
        [fieldName]: propsValue
      } = _ref,
      rest = esm_objectWithoutPropertiesLoose(_ref, [_defaultKey, fieldName].map(_toPropertyKey));
    const handlerName = config[fieldName];
    const [value, handler] = useUncontrolledProp(propsValue, defaultValue, props[handlerName]);
    return Object.assign({}, rest, {
      [fieldName]: value,
      [handlerName]: handler
    });
  }, props);
}
;// CONCATENATED MODULE: ./node_modules/@restart/ui/node_modules/@restart/hooks/esm/usePrevious.js


/**
 * Store the last of some value. Tracked via a `Ref` only updating it
 * after the component renders.
 *
 * Helpful if you need to compare a prop value to it's previous value during render.
 *
 * ```ts
 * function Component(props) {
 *   const lastProps = usePrevious(props)
 *
 *   if (lastProps.foo !== props.foo)
 *     resetValueFromProps(props.foo)
 * }
 * ```
 *
 * @param value the value to track
 */
function usePrevious(value) {
  const ref = (0,react.useRef)(null);
  (0,react.useEffect)(() => {
    ref.current = value;
  });
  return ref.current;
}
;// CONCATENATED MODULE: ./node_modules/@restart/ui/node_modules/@restart/hooks/esm/useForceUpdate.js


/**
 * Returns a function that triggers a component update. the hook equivalent to
 * `this.forceUpdate()` in a class component. In most cases using a state value directly
 * is preferable but may be required in some advanced usages of refs for interop or
 * when direct DOM manipulation is required.
 *
 * ```ts
 * const forceUpdate = useForceUpdate();
 *
 * const updateOnClick = useCallback(() => {
 *  forceUpdate()
 * }, [forceUpdate])
 *
 * return <button type="button" onClick={updateOnClick}>Hi there</button>
 * ```
 */
function useForceUpdate() {
  // The toggling state value is designed to defeat React optimizations for skipping
  // updates when they are strictly equal to the last state value
  const [, dispatch] = (0,react.useReducer)(revision => revision + 1, 0);
  return dispatch;
}
;// CONCATENATED MODULE: ./node_modules/@restart/ui/node_modules/@restart/hooks/esm/useCommittedRef.js


/**
 * Creates a `Ref` whose value is updated in an effect, ensuring the most recent
 * value is the one rendered with. Generally only required for Concurrent mode usage
 * where previous work in `render()` may be discarded before being used.
 *
 * This is safe to access in an event handler.
 *
 * @param value The `Ref` value
 */
function useCommittedRef_useCommittedRef(value) {
  const ref = (0,react.useRef)(value);
  (0,react.useEffect)(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
/* harmony default export */ const esm_useCommittedRef = (useCommittedRef_useCommittedRef);
;// CONCATENATED MODULE: ./node_modules/@restart/ui/node_modules/@restart/hooks/esm/useEventCallback.js


function useEventCallback(fn) {
  const ref = esm_useCommittedRef(fn);
  return (0,react.useCallback)(function (...args) {
    return ref.current && ref.current(...args);
  }, [ref]);
}
;// CONCATENATED MODULE: ./node_modules/@restart/ui/node_modules/@restart/hooks/esm/useEventListener.js


/**
 * Attaches an event handler outside directly to specified DOM element
 * bypassing the react synthetic event system.
 *
 * @param element The target to listen for events on
 * @param event The DOM event name
 * @param handler An event handler
 * @param capture Whether or not to listen during the capture event phase
 */
function useEventListener_useEventListener(eventTarget, event, listener, capture = false) {
  const handler = useEventCallback(listener);
  (0,react.useEffect)(() => {
    const target = typeof eventTarget === 'function' ? eventTarget() : eventTarget;
    target.addEventListener(event, handler, capture);
    return () => target.removeEventListener(event, handler, capture);
  }, [eventTarget]);
}
;// CONCATENATED MODULE: ./node_modules/@restart/ui/esm/DropdownContext.js

const DropdownContext = /*#__PURE__*/react.createContext(null);
/* harmony default export */ const esm_DropdownContext = (DropdownContext);
;// CONCATENATED MODULE: ./node_modules/@restart/ui/node_modules/@restart/hooks/esm/useCallbackRef.js


/**
 * A convenience hook around `useState` designed to be paired with
 * the component [callback ref](https://reactjs.org/docs/refs-and-the-dom.html#callback-refs) api.
 * Callback refs are useful over `useRef()` when you need to respond to the ref being set
 * instead of lazily accessing it in an effect.
 *
 * ```ts
 * const [element, attachRef] = useCallbackRef<HTMLDivElement>()
 *
 * useEffect(() => {
 *   if (!element) return
 *
 *   const calendar = new FullCalendar.Calendar(element)
 *
 *   return () => {
 *     calendar.destroy()
 *   }
 * }, [element])
 *
 * return <div ref={attachRef} />
 * ```
 *
 * @category refs
 */
function useCallbackRef() {
  return (0,react.useState)(null);
}
;// CONCATENATED MODULE: ./node_modules/dequal/dist/index.mjs
var has = Object.prototype.hasOwnProperty;

function find(iter, tar, key) {
	for (key of iter.keys()) {
		if (dequal(key, tar)) return key;
	}
}

function dequal(foo, bar) {
	var ctor, len, tmp;
	if (foo === bar) return true;

	if (foo && bar && (ctor=foo.constructor) === bar.constructor) {
		if (ctor === Date) return foo.getTime() === bar.getTime();
		if (ctor === RegExp) return foo.toString() === bar.toString();

		if (ctor === Array) {
			if ((len=foo.length) === bar.length) {
				while (len-- && dequal(foo[len], bar[len]));
			}
			return len === -1;
		}

		if (ctor === Set) {
			if (foo.size !== bar.size) {
				return false;
			}
			for (len of foo) {
				tmp = len;
				if (tmp && typeof tmp === 'object') {
					tmp = find(bar, tmp);
					if (!tmp) return false;
				}
				if (!bar.has(tmp)) return false;
			}
			return true;
		}

		if (ctor === Map) {
			if (foo.size !== bar.size) {
				return false;
			}
			for (len of foo) {
				tmp = len[0];
				if (tmp && typeof tmp === 'object') {
					tmp = find(bar, tmp);
					if (!tmp) return false;
				}
				if (!dequal(len[1], bar.get(tmp))) {
					return false;
				}
			}
			return true;
		}

		if (ctor === ArrayBuffer) {
			foo = new Uint8Array(foo);
			bar = new Uint8Array(bar);
		} else if (ctor === DataView) {
			if ((len=foo.byteLength) === bar.byteLength) {
				while (len-- && foo.getInt8(len) === bar.getInt8(len));
			}
			return len === -1;
		}

		if (ArrayBuffer.isView(foo)) {
			if ((len=foo.byteLength) === bar.byteLength) {
				while (len-- && foo[len] === bar[len]);
			}
			return len === -1;
		}

		if (!ctor || typeof foo === 'object') {
			len = 0;
			for (ctor in foo) {
				if (has.call(foo, ctor) && ++len && !has.call(bar, ctor)) return false;
				if (!(ctor in bar) || !dequal(foo[ctor], bar[ctor])) return false;
			}
			return Object.keys(bar).length === len;
		}
	}

	return foo !== foo && bar !== bar;
}

;// CONCATENATED MODULE: ./node_modules/@restart/ui/node_modules/@restart/hooks/esm/useMounted.js


/**
 * Track whether a component is current mounted. Generally less preferable than
 * properlly canceling effects so they don't run after a component is unmounted,
 * but helpful in cases where that isn't feasible, such as a `Promise` resolution.
 *
 * @returns a function that returns the current isMounted state of the component
 *
 * ```ts
 * const [data, setData] = useState(null)
 * const isMounted = useMounted()
 *
 * useEffect(() => {
 *   fetchdata().then((newData) => {
 *      if (isMounted()) {
 *        setData(newData);
 *      }
 *   })
 * })
 * ```
 */
function useMounted() {
  const mounted = (0,react.useRef)(true);
  const isMounted = (0,react.useRef)(() => mounted.current);
  (0,react.useEffect)(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return isMounted.current;
}
;// CONCATENATED MODULE: ./node_modules/@restart/ui/node_modules/@restart/hooks/esm/useSafeState.js



/**
 * `useSafeState` takes the return value of a `useState` hook and wraps the
 * setter to prevent updates onces the component has unmounted. Can used
 * with `useMergeState` and `useStateAsync` as well
 *
 * @param state The return value of a useStateHook
 *
 * ```ts
 * const [show, setShow] = useSafeState(useState(true));
 * ```
 */

function useSafeState(state) {
  const isMounted = useMounted();
  return [state[0], (0,react.useCallback)(nextState => {
    if (!isMounted()) return;
    return state[1](nextState);
  }, [isMounted, state[1]])];
}
/* harmony default export */ const esm_useSafeState = (useSafeState);
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/utils/getBasePlacement.js

function getBasePlacement(placement) {
  return placement.split('-')[0];
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/getWindow.js
function getWindow_getWindow(node) {
  if (node == null) {
    return window;
  }

  if (node.toString() !== '[object Window]') {
    var ownerDocument = node.ownerDocument;
    return ownerDocument ? ownerDocument.defaultView || window : window;
  }

  return node;
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/instanceOf.js


function isElement(node) {
  var OwnElement = getWindow_getWindow(node).Element;
  return node instanceof OwnElement || node instanceof Element;
}

function isHTMLElement(node) {
  var OwnElement = getWindow_getWindow(node).HTMLElement;
  return node instanceof OwnElement || node instanceof HTMLElement;
}

function isShadowRoot(node) {
  // IE 11 has no ShadowRoot
  if (typeof ShadowRoot === 'undefined') {
    return false;
  }

  var OwnElement = getWindow_getWindow(node).ShadowRoot;
  return node instanceof OwnElement || node instanceof ShadowRoot;
}


;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/utils/math.js
var math_max = Math.max;
var math_min = Math.min;
var round = Math.round;
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/utils/userAgent.js
function getUAString() {
  var uaData = navigator.userAgentData;

  if (uaData != null && uaData.brands && Array.isArray(uaData.brands)) {
    return uaData.brands.map(function (item) {
      return item.brand + "/" + item.version;
    }).join(' ');
  }

  return navigator.userAgent;
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/isLayoutViewport.js

function isLayoutViewport() {
  return !/^((?!chrome|android).)*safari/i.test(getUAString());
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/getBoundingClientRect.js




function getBoundingClientRect(element, includeScale, isFixedStrategy) {
  if (includeScale === void 0) {
    includeScale = false;
  }

  if (isFixedStrategy === void 0) {
    isFixedStrategy = false;
  }

  var clientRect = element.getBoundingClientRect();
  var scaleX = 1;
  var scaleY = 1;

  if (includeScale && isHTMLElement(element)) {
    scaleX = element.offsetWidth > 0 ? round(clientRect.width) / element.offsetWidth || 1 : 1;
    scaleY = element.offsetHeight > 0 ? round(clientRect.height) / element.offsetHeight || 1 : 1;
  }

  var _ref = isElement(element) ? getWindow_getWindow(element) : window,
      visualViewport = _ref.visualViewport;

  var addVisualOffsets = !isLayoutViewport() && isFixedStrategy;
  var x = (clientRect.left + (addVisualOffsets && visualViewport ? visualViewport.offsetLeft : 0)) / scaleX;
  var y = (clientRect.top + (addVisualOffsets && visualViewport ? visualViewport.offsetTop : 0)) / scaleY;
  var width = clientRect.width / scaleX;
  var height = clientRect.height / scaleY;
  return {
    width: width,
    height: height,
    top: y,
    right: x + width,
    bottom: y + height,
    left: x,
    x: x,
    y: y
  };
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/getLayoutRect.js
 // Returns the layout rect of an element relative to its offsetParent. Layout
// means it doesn't take into account transforms.

function getLayoutRect(element) {
  var clientRect = getBoundingClientRect(element); // Use the clientRect sizes if it's not been transformed.
  // Fixes https://github.com/popperjs/popper-core/issues/1223

  var width = element.offsetWidth;
  var height = element.offsetHeight;

  if (Math.abs(clientRect.width - width) <= 1) {
    width = clientRect.width;
  }

  if (Math.abs(clientRect.height - height) <= 1) {
    height = clientRect.height;
  }

  return {
    x: element.offsetLeft,
    y: element.offsetTop,
    width: width,
    height: height
  };
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/contains.js

function contains(parent, child) {
  var rootNode = child.getRootNode && child.getRootNode(); // First, attempt with faster native method

  if (parent.contains(child)) {
    return true;
  } // then fallback to custom implementation with Shadow DOM support
  else if (rootNode && isShadowRoot(rootNode)) {
      var next = child;

      do {
        if (next && parent.isSameNode(next)) {
          return true;
        } // $FlowFixMe[prop-missing]: need a better way to handle this...


        next = next.parentNode || next.host;
      } while (next);
    } // Give up, the result is false


  return false;
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/getNodeName.js
function getNodeName(element) {
  return element ? (element.nodeName || '').toLowerCase() : null;
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/getComputedStyle.js

function getComputedStyle(element) {
  return getWindow_getWindow(element).getComputedStyle(element);
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/isTableElement.js

function isTableElement(element) {
  return ['table', 'td', 'th'].indexOf(getNodeName(element)) >= 0;
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/getDocumentElement.js

function getDocumentElement(element) {
  // $FlowFixMe[incompatible-return]: assume body is always available
  return ((isElement(element) ? element.ownerDocument : // $FlowFixMe[prop-missing]
  element.document) || window.document).documentElement;
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/getParentNode.js



function getParentNode(element) {
  if (getNodeName(element) === 'html') {
    return element;
  }

  return (// this is a quicker (but less type safe) way to save quite some bytes from the bundle
    // $FlowFixMe[incompatible-return]
    // $FlowFixMe[prop-missing]
    element.assignedSlot || // step into the shadow DOM of the parent of a slotted node
    element.parentNode || ( // DOM Element detected
    isShadowRoot(element) ? element.host : null) || // ShadowRoot detected
    // $FlowFixMe[incompatible-call]: HTMLElement is a Node
    getDocumentElement(element) // fallback

  );
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/getOffsetParent.js








function getTrueOffsetParent(element) {
  if (!isHTMLElement(element) || // https://github.com/popperjs/popper-core/issues/837
  getComputedStyle(element).position === 'fixed') {
    return null;
  }

  return element.offsetParent;
} // `.offsetParent` reports `null` for fixed elements, while absolute elements
// return the containing block


function getContainingBlock(element) {
  var isFirefox = /firefox/i.test(getUAString());
  var isIE = /Trident/i.test(getUAString());

  if (isIE && isHTMLElement(element)) {
    // In IE 9, 10 and 11 fixed elements containing block is always established by the viewport
    var elementCss = getComputedStyle(element);

    if (elementCss.position === 'fixed') {
      return null;
    }
  }

  var currentNode = getParentNode(element);

  if (isShadowRoot(currentNode)) {
    currentNode = currentNode.host;
  }

  while (isHTMLElement(currentNode) && ['html', 'body'].indexOf(getNodeName(currentNode)) < 0) {
    var css = getComputedStyle(currentNode); // This is non-exhaustive but covers the most common CSS properties that
    // create a containing block.
    // https://developer.mozilla.org/en-US/docs/Web/CSS/Containing_block#identifying_the_containing_block

    if (css.transform !== 'none' || css.perspective !== 'none' || css.contain === 'paint' || ['transform', 'perspective'].indexOf(css.willChange) !== -1 || isFirefox && css.willChange === 'filter' || isFirefox && css.filter && css.filter !== 'none') {
      return currentNode;
    } else {
      currentNode = currentNode.parentNode;
    }
  }

  return null;
} // Gets the closest ancestor positioned element. Handles some edge cases,
// such as table ancestors and cross browser bugs.


function getOffsetParent(element) {
  var window = getWindow_getWindow(element);
  var offsetParent = getTrueOffsetParent(element);

  while (offsetParent && isTableElement(offsetParent) && getComputedStyle(offsetParent).position === 'static') {
    offsetParent = getTrueOffsetParent(offsetParent);
  }

  if (offsetParent && (getNodeName(offsetParent) === 'html' || getNodeName(offsetParent) === 'body' && getComputedStyle(offsetParent).position === 'static')) {
    return window;
  }

  return offsetParent || getContainingBlock(element) || window;
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/utils/getMainAxisFromPlacement.js
function getMainAxisFromPlacement(placement) {
  return ['top', 'bottom'].indexOf(placement) >= 0 ? 'x' : 'y';
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/utils/within.js

function within(min, value, max) {
  return math_max(min, math_min(value, max));
}
function withinMaxClamp(min, value, max) {
  var v = within(min, value, max);
  return v > max ? max : v;
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/utils/getFreshSideObject.js
function getFreshSideObject() {
  return {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0
  };
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/utils/mergePaddingObject.js

function mergePaddingObject(paddingObject) {
  return Object.assign({}, getFreshSideObject(), paddingObject);
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/utils/expandToHashMap.js
function expandToHashMap(value, keys) {
  return keys.reduce(function (hashMap, key) {
    hashMap[key] = value;
    return hashMap;
  }, {});
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/enums.js
var enums_top = 'top';
var bottom = 'bottom';
var right = 'right';
var left = 'left';
var auto = 'auto';
var basePlacements = [enums_top, bottom, right, left];
var start = 'start';
var end = 'end';
var clippingParents = 'clippingParents';
var viewport = 'viewport';
var popper = 'popper';
var reference = 'reference';
var variationPlacements = /*#__PURE__*/basePlacements.reduce(function (acc, placement) {
  return acc.concat([placement + "-" + start, placement + "-" + end]);
}, []);
var enums_placements = /*#__PURE__*/[].concat(basePlacements, [auto]).reduce(function (acc, placement) {
  return acc.concat([placement, placement + "-" + start, placement + "-" + end]);
}, []); // modifiers that need to read the DOM

var beforeRead = 'beforeRead';
var read = 'read';
var afterRead = 'afterRead'; // pure-logic modifiers

var beforeMain = 'beforeMain';
var main = 'main';
var afterMain = 'afterMain'; // modifier with the purpose to write to the DOM (or write into a framework state)

var beforeWrite = 'beforeWrite';
var write = 'write';
var afterWrite = 'afterWrite';
var modifierPhases = [beforeRead, read, afterRead, beforeMain, main, afterMain, beforeWrite, write, afterWrite];
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/modifiers/arrow.js








 // eslint-disable-next-line import/no-unused-modules

var toPaddingObject = function toPaddingObject(padding, state) {
  padding = typeof padding === 'function' ? padding(Object.assign({}, state.rects, {
    placement: state.placement
  })) : padding;
  return mergePaddingObject(typeof padding !== 'number' ? padding : expandToHashMap(padding, basePlacements));
};

function arrow(_ref) {
  var _state$modifiersData$;

  var state = _ref.state,
      name = _ref.name,
      options = _ref.options;
  var arrowElement = state.elements.arrow;
  var popperOffsets = state.modifiersData.popperOffsets;
  var basePlacement = getBasePlacement(state.placement);
  var axis = getMainAxisFromPlacement(basePlacement);
  var isVertical = [left, right].indexOf(basePlacement) >= 0;
  var len = isVertical ? 'height' : 'width';

  if (!arrowElement || !popperOffsets) {
    return;
  }

  var paddingObject = toPaddingObject(options.padding, state);
  var arrowRect = getLayoutRect(arrowElement);
  var minProp = axis === 'y' ? enums_top : left;
  var maxProp = axis === 'y' ? bottom : right;
  var endDiff = state.rects.reference[len] + state.rects.reference[axis] - popperOffsets[axis] - state.rects.popper[len];
  var startDiff = popperOffsets[axis] - state.rects.reference[axis];
  var arrowOffsetParent = getOffsetParent(arrowElement);
  var clientSize = arrowOffsetParent ? axis === 'y' ? arrowOffsetParent.clientHeight || 0 : arrowOffsetParent.clientWidth || 0 : 0;
  var centerToReference = endDiff / 2 - startDiff / 2; // Make sure the arrow doesn't overflow the popper if the center point is
  // outside of the popper bounds

  var min = paddingObject[minProp];
  var max = clientSize - arrowRect[len] - paddingObject[maxProp];
  var center = clientSize / 2 - arrowRect[len] / 2 + centerToReference;
  var offset = within(min, center, max); // Prevents breaking syntax highlighting...

  var axisProp = axis;
  state.modifiersData[name] = (_state$modifiersData$ = {}, _state$modifiersData$[axisProp] = offset, _state$modifiersData$.centerOffset = offset - center, _state$modifiersData$);
}

function effect(_ref2) {
  var state = _ref2.state,
      options = _ref2.options;
  var _options$element = options.element,
      arrowElement = _options$element === void 0 ? '[data-popper-arrow]' : _options$element;

  if (arrowElement == null) {
    return;
  } // CSS selector


  if (typeof arrowElement === 'string') {
    arrowElement = state.elements.popper.querySelector(arrowElement);

    if (!arrowElement) {
      return;
    }
  }

  if (!contains(state.elements.popper, arrowElement)) {
    return;
  }

  state.elements.arrow = arrowElement;
} // eslint-disable-next-line import/no-unused-modules


/* harmony default export */ const modifiers_arrow = ({
  name: 'arrow',
  enabled: true,
  phase: 'main',
  fn: arrow,
  effect: effect,
  requires: ['popperOffsets'],
  requiresIfExists: ['preventOverflow']
});
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/utils/getVariation.js
function getVariation(placement) {
  return placement.split('-')[1];
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/modifiers/computeStyles.js







 // eslint-disable-next-line import/no-unused-modules

var unsetSides = {
  top: 'auto',
  right: 'auto',
  bottom: 'auto',
  left: 'auto'
}; // Round the offsets to the nearest suitable subpixel based on the DPR.
// Zooming can change the DPR, but it seems to report a value that will
// cleanly divide the values into the appropriate subpixels.

function roundOffsetsByDPR(_ref, win) {
  var x = _ref.x,
      y = _ref.y;
  var dpr = win.devicePixelRatio || 1;
  return {
    x: round(x * dpr) / dpr || 0,
    y: round(y * dpr) / dpr || 0
  };
}

function mapToStyles(_ref2) {
  var _Object$assign2;

  var popper = _ref2.popper,
      popperRect = _ref2.popperRect,
      placement = _ref2.placement,
      variation = _ref2.variation,
      offsets = _ref2.offsets,
      position = _ref2.position,
      gpuAcceleration = _ref2.gpuAcceleration,
      adaptive = _ref2.adaptive,
      roundOffsets = _ref2.roundOffsets,
      isFixed = _ref2.isFixed;
  var _offsets$x = offsets.x,
      x = _offsets$x === void 0 ? 0 : _offsets$x,
      _offsets$y = offsets.y,
      y = _offsets$y === void 0 ? 0 : _offsets$y;

  var _ref3 = typeof roundOffsets === 'function' ? roundOffsets({
    x: x,
    y: y
  }) : {
    x: x,
    y: y
  };

  x = _ref3.x;
  y = _ref3.y;
  var hasX = offsets.hasOwnProperty('x');
  var hasY = offsets.hasOwnProperty('y');
  var sideX = left;
  var sideY = enums_top;
  var win = window;

  if (adaptive) {
    var offsetParent = getOffsetParent(popper);
    var heightProp = 'clientHeight';
    var widthProp = 'clientWidth';

    if (offsetParent === getWindow_getWindow(popper)) {
      offsetParent = getDocumentElement(popper);

      if (getComputedStyle(offsetParent).position !== 'static' && position === 'absolute') {
        heightProp = 'scrollHeight';
        widthProp = 'scrollWidth';
      }
    } // $FlowFixMe[incompatible-cast]: force type refinement, we compare offsetParent with window above, but Flow doesn't detect it


    offsetParent = offsetParent;

    if (placement === enums_top || (placement === left || placement === right) && variation === end) {
      sideY = bottom;
      var offsetY = isFixed && offsetParent === win && win.visualViewport ? win.visualViewport.height : // $FlowFixMe[prop-missing]
      offsetParent[heightProp];
      y -= offsetY - popperRect.height;
      y *= gpuAcceleration ? 1 : -1;
    }

    if (placement === left || (placement === enums_top || placement === bottom) && variation === end) {
      sideX = right;
      var offsetX = isFixed && offsetParent === win && win.visualViewport ? win.visualViewport.width : // $FlowFixMe[prop-missing]
      offsetParent[widthProp];
      x -= offsetX - popperRect.width;
      x *= gpuAcceleration ? 1 : -1;
    }
  }

  var commonStyles = Object.assign({
    position: position
  }, adaptive && unsetSides);

  var _ref4 = roundOffsets === true ? roundOffsetsByDPR({
    x: x,
    y: y
  }, getWindow_getWindow(popper)) : {
    x: x,
    y: y
  };

  x = _ref4.x;
  y = _ref4.y;

  if (gpuAcceleration) {
    var _Object$assign;

    return Object.assign({}, commonStyles, (_Object$assign = {}, _Object$assign[sideY] = hasY ? '0' : '', _Object$assign[sideX] = hasX ? '0' : '', _Object$assign.transform = (win.devicePixelRatio || 1) <= 1 ? "translate(" + x + "px, " + y + "px)" : "translate3d(" + x + "px, " + y + "px, 0)", _Object$assign));
  }

  return Object.assign({}, commonStyles, (_Object$assign2 = {}, _Object$assign2[sideY] = hasY ? y + "px" : '', _Object$assign2[sideX] = hasX ? x + "px" : '', _Object$assign2.transform = '', _Object$assign2));
}

function computeStyles(_ref5) {
  var state = _ref5.state,
      options = _ref5.options;
  var _options$gpuAccelerat = options.gpuAcceleration,
      gpuAcceleration = _options$gpuAccelerat === void 0 ? true : _options$gpuAccelerat,
      _options$adaptive = options.adaptive,
      adaptive = _options$adaptive === void 0 ? true : _options$adaptive,
      _options$roundOffsets = options.roundOffsets,
      roundOffsets = _options$roundOffsets === void 0 ? true : _options$roundOffsets;
  var commonStyles = {
    placement: getBasePlacement(state.placement),
    variation: getVariation(state.placement),
    popper: state.elements.popper,
    popperRect: state.rects.popper,
    gpuAcceleration: gpuAcceleration,
    isFixed: state.options.strategy === 'fixed'
  };

  if (state.modifiersData.popperOffsets != null) {
    state.styles.popper = Object.assign({}, state.styles.popper, mapToStyles(Object.assign({}, commonStyles, {
      offsets: state.modifiersData.popperOffsets,
      position: state.options.strategy,
      adaptive: adaptive,
      roundOffsets: roundOffsets
    })));
  }

  if (state.modifiersData.arrow != null) {
    state.styles.arrow = Object.assign({}, state.styles.arrow, mapToStyles(Object.assign({}, commonStyles, {
      offsets: state.modifiersData.arrow,
      position: 'absolute',
      adaptive: false,
      roundOffsets: roundOffsets
    })));
  }

  state.attributes.popper = Object.assign({}, state.attributes.popper, {
    'data-popper-placement': state.placement
  });
} // eslint-disable-next-line import/no-unused-modules


/* harmony default export */ const modifiers_computeStyles = ({
  name: 'computeStyles',
  enabled: true,
  phase: 'beforeWrite',
  fn: computeStyles,
  data: {}
});
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/modifiers/eventListeners.js
 // eslint-disable-next-line import/no-unused-modules

var passive = {
  passive: true
};

function eventListeners_effect(_ref) {
  var state = _ref.state,
      instance = _ref.instance,
      options = _ref.options;
  var _options$scroll = options.scroll,
      scroll = _options$scroll === void 0 ? true : _options$scroll,
      _options$resize = options.resize,
      resize = _options$resize === void 0 ? true : _options$resize;
  var window = getWindow_getWindow(state.elements.popper);
  var scrollParents = [].concat(state.scrollParents.reference, state.scrollParents.popper);

  if (scroll) {
    scrollParents.forEach(function (scrollParent) {
      scrollParent.addEventListener('scroll', instance.update, passive);
    });
  }

  if (resize) {
    window.addEventListener('resize', instance.update, passive);
  }

  return function () {
    if (scroll) {
      scrollParents.forEach(function (scrollParent) {
        scrollParent.removeEventListener('scroll', instance.update, passive);
      });
    }

    if (resize) {
      window.removeEventListener('resize', instance.update, passive);
    }
  };
} // eslint-disable-next-line import/no-unused-modules


/* harmony default export */ const eventListeners = ({
  name: 'eventListeners',
  enabled: true,
  phase: 'write',
  fn: function fn() {},
  effect: eventListeners_effect,
  data: {}
});
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/utils/getOppositePlacement.js
var hash = {
  left: 'right',
  right: 'left',
  bottom: 'top',
  top: 'bottom'
};
function getOppositePlacement(placement) {
  return placement.replace(/left|right|bottom|top/g, function (matched) {
    return hash[matched];
  });
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/utils/getOppositeVariationPlacement.js
var getOppositeVariationPlacement_hash = {
  start: 'end',
  end: 'start'
};
function getOppositeVariationPlacement(placement) {
  return placement.replace(/start|end/g, function (matched) {
    return getOppositeVariationPlacement_hash[matched];
  });
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/getWindowScroll.js

function getWindowScroll(node) {
  var win = getWindow_getWindow(node);
  var scrollLeft = win.pageXOffset;
  var scrollTop = win.pageYOffset;
  return {
    scrollLeft: scrollLeft,
    scrollTop: scrollTop
  };
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/getWindowScrollBarX.js



function getWindowScrollBarX(element) {
  // If <html> has a CSS width greater than the viewport, then this will be
  // incorrect for RTL.
  // Popper 1 is broken in this case and never had a bug report so let's assume
  // it's not an issue. I don't think anyone ever specifies width on <html>
  // anyway.
  // Browsers where the left scrollbar doesn't cause an issue report `0` for
  // this (e.g. Edge 2019, IE11, Safari)
  return getBoundingClientRect(getDocumentElement(element)).left + getWindowScroll(element).scrollLeft;
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/getViewportRect.js




function getViewportRect(element, strategy) {
  var win = getWindow_getWindow(element);
  var html = getDocumentElement(element);
  var visualViewport = win.visualViewport;
  var width = html.clientWidth;
  var height = html.clientHeight;
  var x = 0;
  var y = 0;

  if (visualViewport) {
    width = visualViewport.width;
    height = visualViewport.height;
    var layoutViewport = isLayoutViewport();

    if (layoutViewport || !layoutViewport && strategy === 'fixed') {
      x = visualViewport.offsetLeft;
      y = visualViewport.offsetTop;
    }
  }

  return {
    width: width,
    height: height,
    x: x + getWindowScrollBarX(element),
    y: y
  };
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/getDocumentRect.js




 // Gets the entire size of the scrollable document area, even extending outside
// of the `<html>` and `<body>` rect bounds if horizontally scrollable

function getDocumentRect(element) {
  var _element$ownerDocumen;

  var html = getDocumentElement(element);
  var winScroll = getWindowScroll(element);
  var body = (_element$ownerDocumen = element.ownerDocument) == null ? void 0 : _element$ownerDocumen.body;
  var width = math_max(html.scrollWidth, html.clientWidth, body ? body.scrollWidth : 0, body ? body.clientWidth : 0);
  var height = math_max(html.scrollHeight, html.clientHeight, body ? body.scrollHeight : 0, body ? body.clientHeight : 0);
  var x = -winScroll.scrollLeft + getWindowScrollBarX(element);
  var y = -winScroll.scrollTop;

  if (getComputedStyle(body || html).direction === 'rtl') {
    x += math_max(html.clientWidth, body ? body.clientWidth : 0) - width;
  }

  return {
    width: width,
    height: height,
    x: x,
    y: y
  };
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/isScrollParent.js

function isScrollParent(element) {
  // Firefox wants us to check `-x` and `-y` variations as well
  var _getComputedStyle = getComputedStyle(element),
      overflow = _getComputedStyle.overflow,
      overflowX = _getComputedStyle.overflowX,
      overflowY = _getComputedStyle.overflowY;

  return /auto|scroll|overlay|hidden/.test(overflow + overflowY + overflowX);
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/getScrollParent.js




function getScrollParent(node) {
  if (['html', 'body', '#document'].indexOf(getNodeName(node)) >= 0) {
    // $FlowFixMe[incompatible-return]: assume body is always available
    return node.ownerDocument.body;
  }

  if (isHTMLElement(node) && isScrollParent(node)) {
    return node;
  }

  return getScrollParent(getParentNode(node));
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/listScrollParents.js




/*
given a DOM element, return the list of all scroll parents, up the list of ancesors
until we get to the top window object. This list is what we attach scroll listeners
to, because if any of these parent elements scroll, we'll need to re-calculate the
reference element's position.
*/

function listScrollParents(element, list) {
  var _element$ownerDocumen;

  if (list === void 0) {
    list = [];
  }

  var scrollParent = getScrollParent(element);
  var isBody = scrollParent === ((_element$ownerDocumen = element.ownerDocument) == null ? void 0 : _element$ownerDocumen.body);
  var win = getWindow_getWindow(scrollParent);
  var target = isBody ? [win].concat(win.visualViewport || [], isScrollParent(scrollParent) ? scrollParent : []) : scrollParent;
  var updatedList = list.concat(target);
  return isBody ? updatedList : // $FlowFixMe[incompatible-call]: isBody tells us target will be an HTMLElement here
  updatedList.concat(listScrollParents(getParentNode(target)));
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/utils/rectToClientRect.js
function rectToClientRect(rect) {
  return Object.assign({}, rect, {
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height
  });
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/getClippingRect.js















function getInnerBoundingClientRect(element, strategy) {
  var rect = getBoundingClientRect(element, false, strategy === 'fixed');
  rect.top = rect.top + element.clientTop;
  rect.left = rect.left + element.clientLeft;
  rect.bottom = rect.top + element.clientHeight;
  rect.right = rect.left + element.clientWidth;
  rect.width = element.clientWidth;
  rect.height = element.clientHeight;
  rect.x = rect.left;
  rect.y = rect.top;
  return rect;
}

function getClientRectFromMixedType(element, clippingParent, strategy) {
  return clippingParent === viewport ? rectToClientRect(getViewportRect(element, strategy)) : isElement(clippingParent) ? getInnerBoundingClientRect(clippingParent, strategy) : rectToClientRect(getDocumentRect(getDocumentElement(element)));
} // A "clipping parent" is an overflowable container with the characteristic of
// clipping (or hiding) overflowing elements with a position different from
// `initial`


function getClippingParents(element) {
  var clippingParents = listScrollParents(getParentNode(element));
  var canEscapeClipping = ['absolute', 'fixed'].indexOf(getComputedStyle(element).position) >= 0;
  var clipperElement = canEscapeClipping && isHTMLElement(element) ? getOffsetParent(element) : element;

  if (!isElement(clipperElement)) {
    return [];
  } // $FlowFixMe[incompatible-return]: https://github.com/facebook/flow/issues/1414


  return clippingParents.filter(function (clippingParent) {
    return isElement(clippingParent) && contains(clippingParent, clipperElement) && getNodeName(clippingParent) !== 'body';
  });
} // Gets the maximum area that the element is visible in due to any number of
// clipping parents


function getClippingRect(element, boundary, rootBoundary, strategy) {
  var mainClippingParents = boundary === 'clippingParents' ? getClippingParents(element) : [].concat(boundary);
  var clippingParents = [].concat(mainClippingParents, [rootBoundary]);
  var firstClippingParent = clippingParents[0];
  var clippingRect = clippingParents.reduce(function (accRect, clippingParent) {
    var rect = getClientRectFromMixedType(element, clippingParent, strategy);
    accRect.top = math_max(rect.top, accRect.top);
    accRect.right = math_min(rect.right, accRect.right);
    accRect.bottom = math_min(rect.bottom, accRect.bottom);
    accRect.left = math_max(rect.left, accRect.left);
    return accRect;
  }, getClientRectFromMixedType(element, firstClippingParent, strategy));
  clippingRect.width = clippingRect.right - clippingRect.left;
  clippingRect.height = clippingRect.bottom - clippingRect.top;
  clippingRect.x = clippingRect.left;
  clippingRect.y = clippingRect.top;
  return clippingRect;
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/utils/computeOffsets.js




function computeOffsets(_ref) {
  var reference = _ref.reference,
      element = _ref.element,
      placement = _ref.placement;
  var basePlacement = placement ? getBasePlacement(placement) : null;
  var variation = placement ? getVariation(placement) : null;
  var commonX = reference.x + reference.width / 2 - element.width / 2;
  var commonY = reference.y + reference.height / 2 - element.height / 2;
  var offsets;

  switch (basePlacement) {
    case enums_top:
      offsets = {
        x: commonX,
        y: reference.y - element.height
      };
      break;

    case bottom:
      offsets = {
        x: commonX,
        y: reference.y + reference.height
      };
      break;

    case right:
      offsets = {
        x: reference.x + reference.width,
        y: commonY
      };
      break;

    case left:
      offsets = {
        x: reference.x - element.width,
        y: commonY
      };
      break;

    default:
      offsets = {
        x: reference.x,
        y: reference.y
      };
  }

  var mainAxis = basePlacement ? getMainAxisFromPlacement(basePlacement) : null;

  if (mainAxis != null) {
    var len = mainAxis === 'y' ? 'height' : 'width';

    switch (variation) {
      case start:
        offsets[mainAxis] = offsets[mainAxis] - (reference[len] / 2 - element[len] / 2);
        break;

      case end:
        offsets[mainAxis] = offsets[mainAxis] + (reference[len] / 2 - element[len] / 2);
        break;

      default:
    }
  }

  return offsets;
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/utils/detectOverflow.js








 // eslint-disable-next-line import/no-unused-modules

function detectOverflow(state, options) {
  if (options === void 0) {
    options = {};
  }

  var _options = options,
      _options$placement = _options.placement,
      placement = _options$placement === void 0 ? state.placement : _options$placement,
      _options$strategy = _options.strategy,
      strategy = _options$strategy === void 0 ? state.strategy : _options$strategy,
      _options$boundary = _options.boundary,
      boundary = _options$boundary === void 0 ? clippingParents : _options$boundary,
      _options$rootBoundary = _options.rootBoundary,
      rootBoundary = _options$rootBoundary === void 0 ? viewport : _options$rootBoundary,
      _options$elementConte = _options.elementContext,
      elementContext = _options$elementConte === void 0 ? popper : _options$elementConte,
      _options$altBoundary = _options.altBoundary,
      altBoundary = _options$altBoundary === void 0 ? false : _options$altBoundary,
      _options$padding = _options.padding,
      padding = _options$padding === void 0 ? 0 : _options$padding;
  var paddingObject = mergePaddingObject(typeof padding !== 'number' ? padding : expandToHashMap(padding, basePlacements));
  var altContext = elementContext === popper ? reference : popper;
  var popperRect = state.rects.popper;
  var element = state.elements[altBoundary ? altContext : elementContext];
  var clippingClientRect = getClippingRect(isElement(element) ? element : element.contextElement || getDocumentElement(state.elements.popper), boundary, rootBoundary, strategy);
  var referenceClientRect = getBoundingClientRect(state.elements.reference);
  var popperOffsets = computeOffsets({
    reference: referenceClientRect,
    element: popperRect,
    strategy: 'absolute',
    placement: placement
  });
  var popperClientRect = rectToClientRect(Object.assign({}, popperRect, popperOffsets));
  var elementClientRect = elementContext === popper ? popperClientRect : referenceClientRect; // positive = overflowing the clipping rect
  // 0 or negative = within the clipping rect

  var overflowOffsets = {
    top: clippingClientRect.top - elementClientRect.top + paddingObject.top,
    bottom: elementClientRect.bottom - clippingClientRect.bottom + paddingObject.bottom,
    left: clippingClientRect.left - elementClientRect.left + paddingObject.left,
    right: elementClientRect.right - clippingClientRect.right + paddingObject.right
  };
  var offsetData = state.modifiersData.offset; // Offsets can be applied only to the popper element

  if (elementContext === popper && offsetData) {
    var offset = offsetData[placement];
    Object.keys(overflowOffsets).forEach(function (key) {
      var multiply = [right, bottom].indexOf(key) >= 0 ? 1 : -1;
      var axis = [enums_top, bottom].indexOf(key) >= 0 ? 'y' : 'x';
      overflowOffsets[key] += offset[axis] * multiply;
    });
  }

  return overflowOffsets;
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/utils/computeAutoPlacement.js




function computeAutoPlacement(state, options) {
  if (options === void 0) {
    options = {};
  }

  var _options = options,
      placement = _options.placement,
      boundary = _options.boundary,
      rootBoundary = _options.rootBoundary,
      padding = _options.padding,
      flipVariations = _options.flipVariations,
      _options$allowedAutoP = _options.allowedAutoPlacements,
      allowedAutoPlacements = _options$allowedAutoP === void 0 ? enums_placements : _options$allowedAutoP;
  var variation = getVariation(placement);
  var placements = variation ? flipVariations ? variationPlacements : variationPlacements.filter(function (placement) {
    return getVariation(placement) === variation;
  }) : basePlacements;
  var allowedPlacements = placements.filter(function (placement) {
    return allowedAutoPlacements.indexOf(placement) >= 0;
  });

  if (allowedPlacements.length === 0) {
    allowedPlacements = placements;
  } // $FlowFixMe[incompatible-type]: Flow seems to have problems with two array unions...


  var overflows = allowedPlacements.reduce(function (acc, placement) {
    acc[placement] = detectOverflow(state, {
      placement: placement,
      boundary: boundary,
      rootBoundary: rootBoundary,
      padding: padding
    })[getBasePlacement(placement)];
    return acc;
  }, {});
  return Object.keys(overflows).sort(function (a, b) {
    return overflows[a] - overflows[b];
  });
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/modifiers/flip.js






 // eslint-disable-next-line import/no-unused-modules

function getExpandedFallbackPlacements(placement) {
  if (getBasePlacement(placement) === auto) {
    return [];
  }

  var oppositePlacement = getOppositePlacement(placement);
  return [getOppositeVariationPlacement(placement), oppositePlacement, getOppositeVariationPlacement(oppositePlacement)];
}

function flip(_ref) {
  var state = _ref.state,
      options = _ref.options,
      name = _ref.name;

  if (state.modifiersData[name]._skip) {
    return;
  }

  var _options$mainAxis = options.mainAxis,
      checkMainAxis = _options$mainAxis === void 0 ? true : _options$mainAxis,
      _options$altAxis = options.altAxis,
      checkAltAxis = _options$altAxis === void 0 ? true : _options$altAxis,
      specifiedFallbackPlacements = options.fallbackPlacements,
      padding = options.padding,
      boundary = options.boundary,
      rootBoundary = options.rootBoundary,
      altBoundary = options.altBoundary,
      _options$flipVariatio = options.flipVariations,
      flipVariations = _options$flipVariatio === void 0 ? true : _options$flipVariatio,
      allowedAutoPlacements = options.allowedAutoPlacements;
  var preferredPlacement = state.options.placement;
  var basePlacement = getBasePlacement(preferredPlacement);
  var isBasePlacement = basePlacement === preferredPlacement;
  var fallbackPlacements = specifiedFallbackPlacements || (isBasePlacement || !flipVariations ? [getOppositePlacement(preferredPlacement)] : getExpandedFallbackPlacements(preferredPlacement));
  var placements = [preferredPlacement].concat(fallbackPlacements).reduce(function (acc, placement) {
    return acc.concat(getBasePlacement(placement) === auto ? computeAutoPlacement(state, {
      placement: placement,
      boundary: boundary,
      rootBoundary: rootBoundary,
      padding: padding,
      flipVariations: flipVariations,
      allowedAutoPlacements: allowedAutoPlacements
    }) : placement);
  }, []);
  var referenceRect = state.rects.reference;
  var popperRect = state.rects.popper;
  var checksMap = new Map();
  var makeFallbackChecks = true;
  var firstFittingPlacement = placements[0];

  for (var i = 0; i < placements.length; i++) {
    var placement = placements[i];

    var _basePlacement = getBasePlacement(placement);

    var isStartVariation = getVariation(placement) === start;
    var isVertical = [enums_top, bottom].indexOf(_basePlacement) >= 0;
    var len = isVertical ? 'width' : 'height';
    var overflow = detectOverflow(state, {
      placement: placement,
      boundary: boundary,
      rootBoundary: rootBoundary,
      altBoundary: altBoundary,
      padding: padding
    });
    var mainVariationSide = isVertical ? isStartVariation ? right : left : isStartVariation ? bottom : enums_top;

    if (referenceRect[len] > popperRect[len]) {
      mainVariationSide = getOppositePlacement(mainVariationSide);
    }

    var altVariationSide = getOppositePlacement(mainVariationSide);
    var checks = [];

    if (checkMainAxis) {
      checks.push(overflow[_basePlacement] <= 0);
    }

    if (checkAltAxis) {
      checks.push(overflow[mainVariationSide] <= 0, overflow[altVariationSide] <= 0);
    }

    if (checks.every(function (check) {
      return check;
    })) {
      firstFittingPlacement = placement;
      makeFallbackChecks = false;
      break;
    }

    checksMap.set(placement, checks);
  }

  if (makeFallbackChecks) {
    // `2` may be desired in some cases – research later
    var numberOfChecks = flipVariations ? 3 : 1;

    var _loop = function _loop(_i) {
      var fittingPlacement = placements.find(function (placement) {
        var checks = checksMap.get(placement);

        if (checks) {
          return checks.slice(0, _i).every(function (check) {
            return check;
          });
        }
      });

      if (fittingPlacement) {
        firstFittingPlacement = fittingPlacement;
        return "break";
      }
    };

    for (var _i = numberOfChecks; _i > 0; _i--) {
      var _ret = _loop(_i);

      if (_ret === "break") break;
    }
  }

  if (state.placement !== firstFittingPlacement) {
    state.modifiersData[name]._skip = true;
    state.placement = firstFittingPlacement;
    state.reset = true;
  }
} // eslint-disable-next-line import/no-unused-modules


/* harmony default export */ const modifiers_flip = ({
  name: 'flip',
  enabled: true,
  phase: 'main',
  fn: flip,
  requiresIfExists: ['offset'],
  data: {
    _skip: false
  }
});
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/modifiers/hide.js



function getSideOffsets(overflow, rect, preventedOffsets) {
  if (preventedOffsets === void 0) {
    preventedOffsets = {
      x: 0,
      y: 0
    };
  }

  return {
    top: overflow.top - rect.height - preventedOffsets.y,
    right: overflow.right - rect.width + preventedOffsets.x,
    bottom: overflow.bottom - rect.height + preventedOffsets.y,
    left: overflow.left - rect.width - preventedOffsets.x
  };
}

function isAnySideFullyClipped(overflow) {
  return [enums_top, right, bottom, left].some(function (side) {
    return overflow[side] >= 0;
  });
}

function hide(_ref) {
  var state = _ref.state,
      name = _ref.name;
  var referenceRect = state.rects.reference;
  var popperRect = state.rects.popper;
  var preventedOffsets = state.modifiersData.preventOverflow;
  var referenceOverflow = detectOverflow(state, {
    elementContext: 'reference'
  });
  var popperAltOverflow = detectOverflow(state, {
    altBoundary: true
  });
  var referenceClippingOffsets = getSideOffsets(referenceOverflow, referenceRect);
  var popperEscapeOffsets = getSideOffsets(popperAltOverflow, popperRect, preventedOffsets);
  var isReferenceHidden = isAnySideFullyClipped(referenceClippingOffsets);
  var hasPopperEscaped = isAnySideFullyClipped(popperEscapeOffsets);
  state.modifiersData[name] = {
    referenceClippingOffsets: referenceClippingOffsets,
    popperEscapeOffsets: popperEscapeOffsets,
    isReferenceHidden: isReferenceHidden,
    hasPopperEscaped: hasPopperEscaped
  };
  state.attributes.popper = Object.assign({}, state.attributes.popper, {
    'data-popper-reference-hidden': isReferenceHidden,
    'data-popper-escaped': hasPopperEscaped
  });
} // eslint-disable-next-line import/no-unused-modules


/* harmony default export */ const modifiers_hide = ({
  name: 'hide',
  enabled: true,
  phase: 'main',
  requiresIfExists: ['preventOverflow'],
  fn: hide
});
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/modifiers/offset.js

 // eslint-disable-next-line import/no-unused-modules

function distanceAndSkiddingToXY(placement, rects, offset) {
  var basePlacement = getBasePlacement(placement);
  var invertDistance = [left, enums_top].indexOf(basePlacement) >= 0 ? -1 : 1;

  var _ref = typeof offset === 'function' ? offset(Object.assign({}, rects, {
    placement: placement
  })) : offset,
      skidding = _ref[0],
      distance = _ref[1];

  skidding = skidding || 0;
  distance = (distance || 0) * invertDistance;
  return [left, right].indexOf(basePlacement) >= 0 ? {
    x: distance,
    y: skidding
  } : {
    x: skidding,
    y: distance
  };
}

function offset(_ref2) {
  var state = _ref2.state,
      options = _ref2.options,
      name = _ref2.name;
  var _options$offset = options.offset,
      offset = _options$offset === void 0 ? [0, 0] : _options$offset;
  var data = enums_placements.reduce(function (acc, placement) {
    acc[placement] = distanceAndSkiddingToXY(placement, state.rects, offset);
    return acc;
  }, {});
  var _data$state$placement = data[state.placement],
      x = _data$state$placement.x,
      y = _data$state$placement.y;

  if (state.modifiersData.popperOffsets != null) {
    state.modifiersData.popperOffsets.x += x;
    state.modifiersData.popperOffsets.y += y;
  }

  state.modifiersData[name] = data;
} // eslint-disable-next-line import/no-unused-modules


/* harmony default export */ const modifiers_offset = ({
  name: 'offset',
  enabled: true,
  phase: 'main',
  requires: ['popperOffsets'],
  fn: offset
});
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/modifiers/popperOffsets.js


function popperOffsets(_ref) {
  var state = _ref.state,
      name = _ref.name;
  // Offsets are the actual position the popper needs to have to be
  // properly positioned near its reference element
  // This is the most basic placement, and will be adjusted by
  // the modifiers in the next step
  state.modifiersData[name] = computeOffsets({
    reference: state.rects.reference,
    element: state.rects.popper,
    strategy: 'absolute',
    placement: state.placement
  });
} // eslint-disable-next-line import/no-unused-modules


/* harmony default export */ const modifiers_popperOffsets = ({
  name: 'popperOffsets',
  enabled: true,
  phase: 'read',
  fn: popperOffsets,
  data: {}
});
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/utils/getAltAxis.js
function getAltAxis(axis) {
  return axis === 'x' ? 'y' : 'x';
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/modifiers/preventOverflow.js












function preventOverflow(_ref) {
  var state = _ref.state,
      options = _ref.options,
      name = _ref.name;
  var _options$mainAxis = options.mainAxis,
      checkMainAxis = _options$mainAxis === void 0 ? true : _options$mainAxis,
      _options$altAxis = options.altAxis,
      checkAltAxis = _options$altAxis === void 0 ? false : _options$altAxis,
      boundary = options.boundary,
      rootBoundary = options.rootBoundary,
      altBoundary = options.altBoundary,
      padding = options.padding,
      _options$tether = options.tether,
      tether = _options$tether === void 0 ? true : _options$tether,
      _options$tetherOffset = options.tetherOffset,
      tetherOffset = _options$tetherOffset === void 0 ? 0 : _options$tetherOffset;
  var overflow = detectOverflow(state, {
    boundary: boundary,
    rootBoundary: rootBoundary,
    padding: padding,
    altBoundary: altBoundary
  });
  var basePlacement = getBasePlacement(state.placement);
  var variation = getVariation(state.placement);
  var isBasePlacement = !variation;
  var mainAxis = getMainAxisFromPlacement(basePlacement);
  var altAxis = getAltAxis(mainAxis);
  var popperOffsets = state.modifiersData.popperOffsets;
  var referenceRect = state.rects.reference;
  var popperRect = state.rects.popper;
  var tetherOffsetValue = typeof tetherOffset === 'function' ? tetherOffset(Object.assign({}, state.rects, {
    placement: state.placement
  })) : tetherOffset;
  var normalizedTetherOffsetValue = typeof tetherOffsetValue === 'number' ? {
    mainAxis: tetherOffsetValue,
    altAxis: tetherOffsetValue
  } : Object.assign({
    mainAxis: 0,
    altAxis: 0
  }, tetherOffsetValue);
  var offsetModifierState = state.modifiersData.offset ? state.modifiersData.offset[state.placement] : null;
  var data = {
    x: 0,
    y: 0
  };

  if (!popperOffsets) {
    return;
  }

  if (checkMainAxis) {
    var _offsetModifierState$;

    var mainSide = mainAxis === 'y' ? enums_top : left;
    var altSide = mainAxis === 'y' ? bottom : right;
    var len = mainAxis === 'y' ? 'height' : 'width';
    var offset = popperOffsets[mainAxis];
    var min = offset + overflow[mainSide];
    var max = offset - overflow[altSide];
    var additive = tether ? -popperRect[len] / 2 : 0;
    var minLen = variation === start ? referenceRect[len] : popperRect[len];
    var maxLen = variation === start ? -popperRect[len] : -referenceRect[len]; // We need to include the arrow in the calculation so the arrow doesn't go
    // outside the reference bounds

    var arrowElement = state.elements.arrow;
    var arrowRect = tether && arrowElement ? getLayoutRect(arrowElement) : {
      width: 0,
      height: 0
    };
    var arrowPaddingObject = state.modifiersData['arrow#persistent'] ? state.modifiersData['arrow#persistent'].padding : getFreshSideObject();
    var arrowPaddingMin = arrowPaddingObject[mainSide];
    var arrowPaddingMax = arrowPaddingObject[altSide]; // If the reference length is smaller than the arrow length, we don't want
    // to include its full size in the calculation. If the reference is small
    // and near the edge of a boundary, the popper can overflow even if the
    // reference is not overflowing as well (e.g. virtual elements with no
    // width or height)

    var arrowLen = within(0, referenceRect[len], arrowRect[len]);
    var minOffset = isBasePlacement ? referenceRect[len] / 2 - additive - arrowLen - arrowPaddingMin - normalizedTetherOffsetValue.mainAxis : minLen - arrowLen - arrowPaddingMin - normalizedTetherOffsetValue.mainAxis;
    var maxOffset = isBasePlacement ? -referenceRect[len] / 2 + additive + arrowLen + arrowPaddingMax + normalizedTetherOffsetValue.mainAxis : maxLen + arrowLen + arrowPaddingMax + normalizedTetherOffsetValue.mainAxis;
    var arrowOffsetParent = state.elements.arrow && getOffsetParent(state.elements.arrow);
    var clientOffset = arrowOffsetParent ? mainAxis === 'y' ? arrowOffsetParent.clientTop || 0 : arrowOffsetParent.clientLeft || 0 : 0;
    var offsetModifierValue = (_offsetModifierState$ = offsetModifierState == null ? void 0 : offsetModifierState[mainAxis]) != null ? _offsetModifierState$ : 0;
    var tetherMin = offset + minOffset - offsetModifierValue - clientOffset;
    var tetherMax = offset + maxOffset - offsetModifierValue;
    var preventedOffset = within(tether ? math_min(min, tetherMin) : min, offset, tether ? math_max(max, tetherMax) : max);
    popperOffsets[mainAxis] = preventedOffset;
    data[mainAxis] = preventedOffset - offset;
  }

  if (checkAltAxis) {
    var _offsetModifierState$2;

    var _mainSide = mainAxis === 'x' ? enums_top : left;

    var _altSide = mainAxis === 'x' ? bottom : right;

    var _offset = popperOffsets[altAxis];

    var _len = altAxis === 'y' ? 'height' : 'width';

    var _min = _offset + overflow[_mainSide];

    var _max = _offset - overflow[_altSide];

    var isOriginSide = [enums_top, left].indexOf(basePlacement) !== -1;

    var _offsetModifierValue = (_offsetModifierState$2 = offsetModifierState == null ? void 0 : offsetModifierState[altAxis]) != null ? _offsetModifierState$2 : 0;

    var _tetherMin = isOriginSide ? _min : _offset - referenceRect[_len] - popperRect[_len] - _offsetModifierValue + normalizedTetherOffsetValue.altAxis;

    var _tetherMax = isOriginSide ? _offset + referenceRect[_len] + popperRect[_len] - _offsetModifierValue - normalizedTetherOffsetValue.altAxis : _max;

    var _preventedOffset = tether && isOriginSide ? withinMaxClamp(_tetherMin, _offset, _tetherMax) : within(tether ? _tetherMin : _min, _offset, tether ? _tetherMax : _max);

    popperOffsets[altAxis] = _preventedOffset;
    data[altAxis] = _preventedOffset - _offset;
  }

  state.modifiersData[name] = data;
} // eslint-disable-next-line import/no-unused-modules


/* harmony default export */ const modifiers_preventOverflow = ({
  name: 'preventOverflow',
  enabled: true,
  phase: 'main',
  fn: preventOverflow,
  requiresIfExists: ['offset']
});
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/getHTMLElementScroll.js
function getHTMLElementScroll(element) {
  return {
    scrollLeft: element.scrollLeft,
    scrollTop: element.scrollTop
  };
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/getNodeScroll.js




function getNodeScroll(node) {
  if (node === getWindow_getWindow(node) || !isHTMLElement(node)) {
    return getWindowScroll(node);
  } else {
    return getHTMLElementScroll(node);
  }
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/dom-utils/getCompositeRect.js









function isElementScaled(element) {
  var rect = element.getBoundingClientRect();
  var scaleX = round(rect.width) / element.offsetWidth || 1;
  var scaleY = round(rect.height) / element.offsetHeight || 1;
  return scaleX !== 1 || scaleY !== 1;
} // Returns the composite rect of an element relative to its offsetParent.
// Composite means it takes into account transforms as well as layout.


function getCompositeRect(elementOrVirtualElement, offsetParent, isFixed) {
  if (isFixed === void 0) {
    isFixed = false;
  }

  var isOffsetParentAnElement = isHTMLElement(offsetParent);
  var offsetParentIsScaled = isHTMLElement(offsetParent) && isElementScaled(offsetParent);
  var documentElement = getDocumentElement(offsetParent);
  var rect = getBoundingClientRect(elementOrVirtualElement, offsetParentIsScaled, isFixed);
  var scroll = {
    scrollLeft: 0,
    scrollTop: 0
  };
  var offsets = {
    x: 0,
    y: 0
  };

  if (isOffsetParentAnElement || !isOffsetParentAnElement && !isFixed) {
    if (getNodeName(offsetParent) !== 'body' || // https://github.com/popperjs/popper-core/issues/1078
    isScrollParent(documentElement)) {
      scroll = getNodeScroll(offsetParent);
    }

    if (isHTMLElement(offsetParent)) {
      offsets = getBoundingClientRect(offsetParent, true);
      offsets.x += offsetParent.clientLeft;
      offsets.y += offsetParent.clientTop;
    } else if (documentElement) {
      offsets.x = getWindowScrollBarX(documentElement);
    }
  }

  return {
    x: rect.left + scroll.scrollLeft - offsets.x,
    y: rect.top + scroll.scrollTop - offsets.y,
    width: rect.width,
    height: rect.height
  };
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/utils/orderModifiers.js
 // source: https://stackoverflow.com/questions/49875255

function order(modifiers) {
  var map = new Map();
  var visited = new Set();
  var result = [];
  modifiers.forEach(function (modifier) {
    map.set(modifier.name, modifier);
  }); // On visiting object, check for its dependencies and visit them recursively

  function sort(modifier) {
    visited.add(modifier.name);
    var requires = [].concat(modifier.requires || [], modifier.requiresIfExists || []);
    requires.forEach(function (dep) {
      if (!visited.has(dep)) {
        var depModifier = map.get(dep);

        if (depModifier) {
          sort(depModifier);
        }
      }
    });
    result.push(modifier);
  }

  modifiers.forEach(function (modifier) {
    if (!visited.has(modifier.name)) {
      // check for visited object
      sort(modifier);
    }
  });
  return result;
}

function orderModifiers(modifiers) {
  // order based on dependencies
  var orderedModifiers = order(modifiers); // order based on phase

  return modifierPhases.reduce(function (acc, phase) {
    return acc.concat(orderedModifiers.filter(function (modifier) {
      return modifier.phase === phase;
    }));
  }, []);
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/utils/debounce.js
function debounce(fn) {
  var pending;
  return function () {
    if (!pending) {
      pending = new Promise(function (resolve) {
        Promise.resolve().then(function () {
          pending = undefined;
          resolve(fn());
        });
      });
    }

    return pending;
  };
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/utils/mergeByName.js
function mergeByName(modifiers) {
  var merged = modifiers.reduce(function (merged, current) {
    var existing = merged[current.name];
    merged[current.name] = existing ? Object.assign({}, existing, current, {
      options: Object.assign({}, existing.options, current.options),
      data: Object.assign({}, existing.data, current.data)
    }) : current;
    return merged;
  }, {}); // IE11 does not support Object.values

  return Object.keys(merged).map(function (key) {
    return merged[key];
  });
}
;// CONCATENATED MODULE: ./node_modules/@popperjs/core/lib/createPopper.js









var DEFAULT_OPTIONS = {
  placement: 'bottom',
  modifiers: [],
  strategy: 'absolute'
};

function areValidElements() {
  for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
    args[_key] = arguments[_key];
  }

  return !args.some(function (element) {
    return !(element && typeof element.getBoundingClientRect === 'function');
  });
}

function popperGenerator(generatorOptions) {
  if (generatorOptions === void 0) {
    generatorOptions = {};
  }

  var _generatorOptions = generatorOptions,
      _generatorOptions$def = _generatorOptions.defaultModifiers,
      defaultModifiers = _generatorOptions$def === void 0 ? [] : _generatorOptions$def,
      _generatorOptions$def2 = _generatorOptions.defaultOptions,
      defaultOptions = _generatorOptions$def2 === void 0 ? DEFAULT_OPTIONS : _generatorOptions$def2;
  return function createPopper(reference, popper, options) {
    if (options === void 0) {
      options = defaultOptions;
    }

    var state = {
      placement: 'bottom',
      orderedModifiers: [],
      options: Object.assign({}, DEFAULT_OPTIONS, defaultOptions),
      modifiersData: {},
      elements: {
        reference: reference,
        popper: popper
      },
      attributes: {},
      styles: {}
    };
    var effectCleanupFns = [];
    var isDestroyed = false;
    var instance = {
      state: state,
      setOptions: function setOptions(setOptionsAction) {
        var options = typeof setOptionsAction === 'function' ? setOptionsAction(state.options) : setOptionsAction;
        cleanupModifierEffects();
        state.options = Object.assign({}, defaultOptions, state.options, options);
        state.scrollParents = {
          reference: isElement(reference) ? listScrollParents(reference) : reference.contextElement ? listScrollParents(reference.contextElement) : [],
          popper: listScrollParents(popper)
        }; // Orders the modifiers based on their dependencies and `phase`
        // properties

        var orderedModifiers = orderModifiers(mergeByName([].concat(defaultModifiers, state.options.modifiers))); // Strip out disabled modifiers

        state.orderedModifiers = orderedModifiers.filter(function (m) {
          return m.enabled;
        });
        runModifierEffects();
        return instance.update();
      },
      // Sync update – it will always be executed, even if not necessary. This
      // is useful for low frequency updates where sync behavior simplifies the
      // logic.
      // For high frequency updates (e.g. `resize` and `scroll` events), always
      // prefer the async Popper#update method
      forceUpdate: function forceUpdate() {
        if (isDestroyed) {
          return;
        }

        var _state$elements = state.elements,
            reference = _state$elements.reference,
            popper = _state$elements.popper; // Don't proceed if `reference` or `popper` are not valid elements
        // anymore

        if (!areValidElements(reference, popper)) {
          return;
        } // Store the reference and popper rects to be read by modifiers


        state.rects = {
          reference: getCompositeRect(reference, getOffsetParent(popper), state.options.strategy === 'fixed'),
          popper: getLayoutRect(popper)
        }; // Modifiers have the ability to reset the current update cycle. The
        // most common use case for this is the `flip` modifier changing the
        // placement, which then needs to re-run all the modifiers, because the
        // logic was previously ran for the previous placement and is therefore
        // stale/incorrect

        state.reset = false;
        state.placement = state.options.placement; // On each update cycle, the `modifiersData` property for each modifier
        // is filled with the initial data specified by the modifier. This means
        // it doesn't persist and is fresh on each update.
        // To ensure persistent data, use `${name}#persistent`

        state.orderedModifiers.forEach(function (modifier) {
          return state.modifiersData[modifier.name] = Object.assign({}, modifier.data);
        });

        for (var index = 0; index < state.orderedModifiers.length; index++) {
          if (state.reset === true) {
            state.reset = false;
            index = -1;
            continue;
          }

          var _state$orderedModifie = state.orderedModifiers[index],
              fn = _state$orderedModifie.fn,
              _state$orderedModifie2 = _state$orderedModifie.options,
              _options = _state$orderedModifie2 === void 0 ? {} : _state$orderedModifie2,
              name = _state$orderedModifie.name;

          if (typeof fn === 'function') {
            state = fn({
              state: state,
              options: _options,
              name: name,
              instance: instance
            }) || state;
          }
        }
      },
      // Async and optimistically optimized update – it will not be executed if
      // not necessary (debounced to run at most once-per-tick)
      update: debounce(function () {
        return new Promise(function (resolve) {
          instance.forceUpdate();
          resolve(state);
        });
      }),
      destroy: function destroy() {
        cleanupModifierEffects();
        isDestroyed = true;
      }
    };

    if (!areValidElements(reference, popper)) {
      return instance;
    }

    instance.setOptions(options).then(function (state) {
      if (!isDestroyed && options.onFirstUpdate) {
        options.onFirstUpdate(state);
      }
    }); // Modifiers have the ability to execute arbitrary code before the first
    // update cycle runs. They will be executed in the same order as the update
    // cycle. This is useful when a modifier adds some persistent data that
    // other modifiers need to use, but the modifier is run after the dependent
    // one.

    function runModifierEffects() {
      state.orderedModifiers.forEach(function (_ref) {
        var name = _ref.name,
            _ref$options = _ref.options,
            options = _ref$options === void 0 ? {} : _ref$options,
            effect = _ref.effect;

        if (typeof effect === 'function') {
          var cleanupFn = effect({
            state: state,
            name: name,
            instance: instance,
            options: options
          });

          var noopFn = function noopFn() {};

          effectCleanupFns.push(cleanupFn || noopFn);
        }
      });
    }

    function cleanupModifierEffects() {
      effectCleanupFns.forEach(function (fn) {
        return fn();
      });
      effectCleanupFns = [];
    }

    return instance;
  };
}
var createPopper = /*#__PURE__*/(/* unused pure expression or super */ null && (popperGenerator())); // eslint-disable-next-line import/no-unused-modules


;// CONCATENATED MODULE: ./node_modules/@restart/ui/esm/popper.js











// For the common JS build we will turn this file into a bundle with no imports.
// This is b/c the Popper lib is all esm files, and would break in a common js only environment
const popper_createPopper = popperGenerator({
  defaultModifiers: [modifiers_hide, modifiers_popperOffsets, modifiers_computeStyles, eventListeners, modifiers_offset, modifiers_flip, modifiers_preventOverflow, modifiers_arrow]
});

;// CONCATENATED MODULE: ./node_modules/@restart/ui/esm/usePopper.js
const _excluded = ["enabled", "placement", "strategy", "modifiers"];
function usePopper_objectWithoutPropertiesLoose(r, e) { if (null == r) return {}; var t = {}; for (var n in r) if ({}.hasOwnProperty.call(r, n)) { if (e.indexOf(n) >= 0) continue; t[n] = r[n]; } return t; }




const disabledApplyStylesModifier = {
  name: 'applyStyles',
  enabled: false,
  phase: 'afterWrite',
  fn: () => undefined
};

// until docjs supports type exports...

const ariaDescribedByModifier = {
  name: 'ariaDescribedBy',
  enabled: true,
  phase: 'afterWrite',
  effect: ({
    state
  }) => () => {
    const {
      reference,
      popper
    } = state.elements;
    if ('removeAttribute' in reference) {
      const ids = (reference.getAttribute('aria-describedby') || '').split(',').filter(id => id.trim() !== popper.id);
      if (!ids.length) reference.removeAttribute('aria-describedby');else reference.setAttribute('aria-describedby', ids.join(','));
    }
  },
  fn: ({
    state
  }) => {
    var _popper$getAttribute;
    const {
      popper,
      reference
    } = state.elements;
    const role = (_popper$getAttribute = popper.getAttribute('role')) == null ? void 0 : _popper$getAttribute.toLowerCase();
    if (popper.id && role === 'tooltip' && 'setAttribute' in reference) {
      const ids = reference.getAttribute('aria-describedby');
      if (ids && ids.split(',').indexOf(popper.id) !== -1) {
        return;
      }
      reference.setAttribute('aria-describedby', ids ? `${ids},${popper.id}` : popper.id);
    }
  }
};
const EMPTY_MODIFIERS = [];
/**
 * Position an element relative some reference element using Popper.js
 *
 * @param referenceElement
 * @param popperElement
 * @param {object}      options
 * @param {object=}     options.modifiers Popper.js modifiers
 * @param {boolean=}    options.enabled toggle the popper functionality on/off
 * @param {string=}     options.placement The popper element placement relative to the reference element
 * @param {string=}     options.strategy the positioning strategy
 * @param {function=}   options.onCreate called when the popper is created
 * @param {function=}   options.onUpdate called when the popper is updated
 *
 * @returns {UsePopperState} The popper state
 */
function usePopper(referenceElement, popperElement, _ref = {}) {
  let {
      enabled = true,
      placement = 'bottom',
      strategy = 'absolute',
      modifiers = EMPTY_MODIFIERS
    } = _ref,
    config = usePopper_objectWithoutPropertiesLoose(_ref, _excluded);
  const prevModifiers = (0,react.useRef)(modifiers);
  const popperInstanceRef = (0,react.useRef)();
  const update = (0,react.useCallback)(() => {
    var _popperInstanceRef$cu;
    (_popperInstanceRef$cu = popperInstanceRef.current) == null ? void 0 : _popperInstanceRef$cu.update();
  }, []);
  const forceUpdate = (0,react.useCallback)(() => {
    var _popperInstanceRef$cu2;
    (_popperInstanceRef$cu2 = popperInstanceRef.current) == null ? void 0 : _popperInstanceRef$cu2.forceUpdate();
  }, []);
  const [popperState, setState] = esm_useSafeState((0,react.useState)({
    placement,
    update,
    forceUpdate,
    attributes: {},
    styles: {
      popper: {},
      arrow: {}
    }
  }));
  const updateModifier = (0,react.useMemo)(() => ({
    name: 'updateStateModifier',
    enabled: true,
    phase: 'write',
    requires: ['computeStyles'],
    fn: ({
      state
    }) => {
      const styles = {};
      const attributes = {};
      Object.keys(state.elements).forEach(element => {
        styles[element] = state.styles[element];
        attributes[element] = state.attributes[element];
      });
      setState({
        state,
        styles,
        attributes,
        update,
        forceUpdate,
        placement: state.placement
      });
    }
  }), [update, forceUpdate, setState]);
  const nextModifiers = (0,react.useMemo)(() => {
    if (!dequal(prevModifiers.current, modifiers)) {
      prevModifiers.current = modifiers;
    }
    return prevModifiers.current;
  }, [modifiers]);
  (0,react.useEffect)(() => {
    if (!popperInstanceRef.current || !enabled) return;
    popperInstanceRef.current.setOptions({
      placement,
      strategy,
      modifiers: [...nextModifiers, updateModifier, disabledApplyStylesModifier]
    });
  }, [strategy, placement, updateModifier, enabled, nextModifiers]);
  (0,react.useEffect)(() => {
    if (!enabled || referenceElement == null || popperElement == null) {
      return undefined;
    }
    popperInstanceRef.current = popper_createPopper(referenceElement, popperElement, Object.assign({}, config, {
      placement,
      strategy,
      modifiers: [...nextModifiers, ariaDescribedByModifier, updateModifier]
    }));
    return () => {
      if (popperInstanceRef.current != null) {
        popperInstanceRef.current.destroy();
        popperInstanceRef.current = undefined;
        setState(s => Object.assign({}, s, {
          attributes: {},
          styles: {
            popper: {}
          }
        }));
      }
    };
    // This is only run once to _create_ the popper
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, referenceElement, popperElement]);
  return popperState;
}
/* harmony default export */ const esm_usePopper = (usePopper);
;// CONCATENATED MODULE: ./node_modules/dom-helpers/esm/contains.js
/* eslint-disable no-bitwise, no-cond-assign */

/**
 * Checks if an element contains another given element.
 * 
 * @param context the context element
 * @param node the element to check
 */
function contains_contains(context, node) {
  // HTML DOM and SVG DOM may have different support levels,
  // so we need to check on context instead of a document root element.
  if (context.contains) return context.contains(node);
  if (context.compareDocumentPosition) return context === node || !!(context.compareDocumentPosition(node) & 16);
}
;// CONCATENATED MODULE: ./node_modules/dom-helpers/esm/removeEventListener.js
/**
 * A `removeEventListener` ponyfill
 * 
 * @param node the element
 * @param eventName the event name
 * @param handle the handler
 * @param options event options
 */
function removeEventListener(node, eventName, handler, options) {
  var capture = options && typeof options !== 'boolean' ? options.capture : options;
  node.removeEventListener(eventName, handler, capture);

  if (handler.__once) {
    node.removeEventListener(eventName, handler.__once, capture);
  }
}

/* harmony default export */ const esm_removeEventListener = (removeEventListener);
;// CONCATENATED MODULE: ./node_modules/dom-helpers/esm/listen.js



function listen(node, eventName, handler, options) {
  esm_addEventListener(node, eventName, handler, options);
  return function () {
    esm_removeEventListener(node, eventName, handler, options);
  };
}

/* harmony default export */ const esm_listen = (listen);
;// CONCATENATED MODULE: ./node_modules/dom-helpers/esm/ownerDocument.js
/**
 * Returns the owner document of a given element.
 * 
 * @param node the element
 */
function ownerDocument(node) {
  return node && node.ownerDocument || document;
}
// EXTERNAL MODULE: ./node_modules/warning/warning.js
var warning = __webpack_require__(9771);
var warning_default = /*#__PURE__*/__webpack_require__.n(warning);
;// CONCATENATED MODULE: ./node_modules/@restart/ui/esm/useClickOutside.js






const useClickOutside_noop = () => {};
function isLeftClickEvent(event) {
  return event.button === 0;
}
function isModifiedEvent(event) {
  return !!(event.metaKey || event.altKey || event.ctrlKey || event.shiftKey);
}
const getRefTarget = ref => ref && ('current' in ref ? ref.current : ref);
const InitialTriggerEvents = {
  click: 'mousedown',
  mouseup: 'mousedown',
  pointerup: 'pointerdown'
};

/**
 * The `useClickOutside` hook registers your callback on the document that fires
 * when a pointer event is registered outside of the provided ref or element.
 *
 * @param {Ref<HTMLElement>| HTMLElement} ref  The element boundary
 * @param {function} onClickOutside
 * @param {object=}  options
 * @param {boolean=} options.disabled
 * @param {string=}  options.clickTrigger The DOM event name (click, mousedown, etc) to attach listeners on
 */
function useClickOutside(ref, onClickOutside = useClickOutside_noop, {
  disabled,
  clickTrigger = 'click'
} = {}) {
  const preventMouseClickOutsideRef = (0,react.useRef)(false);
  const waitingForTrigger = (0,react.useRef)(false);
  const handleMouseCapture = (0,react.useCallback)(e => {
    const currentTarget = getRefTarget(ref);
    warning_default()(!!currentTarget, 'ClickOutside captured a close event but does not have a ref to compare it to. ' + 'useClickOutside(), should be passed a ref that resolves to a DOM node');
    preventMouseClickOutsideRef.current = !currentTarget || isModifiedEvent(e) || !isLeftClickEvent(e) || !!contains_contains(currentTarget, e.target) || waitingForTrigger.current;
    waitingForTrigger.current = false;
  }, [ref]);
  const handleInitialMouse = useEventCallback(e => {
    const currentTarget = getRefTarget(ref);
    if (currentTarget && contains_contains(currentTarget, e.target)) {
      waitingForTrigger.current = true;
    } else {
      // When clicking on scrollbars within current target, click events are not triggered, so this ref
      // is never reset inside `handleMouseCapture`. This would cause a bug where it requires 2 clicks
      // to close the overlay.
      waitingForTrigger.current = false;
    }
  });
  const handleMouse = useEventCallback(e => {
    if (!preventMouseClickOutsideRef.current) {
      onClickOutside(e);
    }
  });
  (0,react.useEffect)(() => {
    var _ownerWindow$event, _ownerWindow$parent;
    if (disabled || ref == null) return undefined;
    const doc = ownerDocument(getRefTarget(ref));
    const ownerWindow = doc.defaultView || window;

    // Store the current event to avoid triggering handlers immediately
    // For things rendered in an iframe, the event might originate on the parent window
    // so we should fall back to that global event if the local one doesn't exist
    // https://github.com/facebook/react/issues/20074
    let currentEvent = (_ownerWindow$event = ownerWindow.event) != null ? _ownerWindow$event : (_ownerWindow$parent = ownerWindow.parent) == null ? void 0 : _ownerWindow$parent.event;
    let removeInitialTriggerListener = null;
    if (InitialTriggerEvents[clickTrigger]) {
      removeInitialTriggerListener = esm_listen(doc, InitialTriggerEvents[clickTrigger], handleInitialMouse, true);
    }

    // Use capture for this listener so it fires before React's listener, to
    // avoid false positives in the contains() check below if the target DOM
    // element is removed in the React mouse callback.
    const removeMouseCaptureListener = esm_listen(doc, clickTrigger, handleMouseCapture, true);
    const removeMouseListener = esm_listen(doc, clickTrigger, e => {
      // skip if this event is the same as the one running when we added the handlers
      if (e === currentEvent) {
        currentEvent = undefined;
        return;
      }
      handleMouse(e);
    });
    let mobileSafariHackListeners = [];
    if ('ontouchstart' in doc.documentElement) {
      mobileSafariHackListeners = [].slice.call(doc.body.children).map(el => esm_listen(el, 'mousemove', useClickOutside_noop));
    }
    return () => {
      removeInitialTriggerListener == null ? void 0 : removeInitialTriggerListener();
      removeMouseCaptureListener();
      removeMouseListener();
      mobileSafariHackListeners.forEach(remove => remove());
    };
  }, [ref, disabled, clickTrigger, handleMouseCapture, handleInitialMouse, handleMouse]);
}
/* harmony default export */ const esm_useClickOutside = (useClickOutside);
;// CONCATENATED MODULE: ./node_modules/@restart/ui/esm/mergeOptionsWithPopperConfig.js
function toModifierMap(modifiers) {
  const result = {};
  if (!Array.isArray(modifiers)) {
    return modifiers || result;
  }

  // eslint-disable-next-line no-unused-expressions
  modifiers == null ? void 0 : modifiers.forEach(m => {
    result[m.name] = m;
  });
  return result;
}
function toModifierArray(map = {}) {
  if (Array.isArray(map)) return map;
  return Object.keys(map).map(k => {
    map[k].name = k;
    return map[k];
  });
}
function mergeOptionsWithPopperConfig({
  enabled,
  enableEvents,
  placement,
  flip,
  offset,
  fixed,
  containerPadding,
  arrowElement,
  popperConfig = {}
}) {
  var _modifiers$eventListe, _modifiers$preventOve, _modifiers$preventOve2, _modifiers$offset, _modifiers$arrow;
  const modifiers = toModifierMap(popperConfig.modifiers);
  return Object.assign({}, popperConfig, {
    placement,
    enabled,
    strategy: fixed ? 'fixed' : popperConfig.strategy,
    modifiers: toModifierArray(Object.assign({}, modifiers, {
      eventListeners: {
        enabled: enableEvents,
        options: (_modifiers$eventListe = modifiers.eventListeners) == null ? void 0 : _modifiers$eventListe.options
      },
      preventOverflow: Object.assign({}, modifiers.preventOverflow, {
        options: containerPadding ? Object.assign({
          padding: containerPadding
        }, (_modifiers$preventOve = modifiers.preventOverflow) == null ? void 0 : _modifiers$preventOve.options) : (_modifiers$preventOve2 = modifiers.preventOverflow) == null ? void 0 : _modifiers$preventOve2.options
      }),
      offset: {
        options: Object.assign({
          offset
        }, (_modifiers$offset = modifiers.offset) == null ? void 0 : _modifiers$offset.options)
      },
      arrow: Object.assign({}, modifiers.arrow, {
        enabled: !!arrowElement,
        options: Object.assign({}, (_modifiers$arrow = modifiers.arrow) == null ? void 0 : _modifiers$arrow.options, {
          element: arrowElement
        })
      }),
      flip: Object.assign({
        enabled: !!flip
      }, modifiers.flip)
    }))
  });
}
// EXTERNAL MODULE: ./node_modules/react/jsx-runtime.js
var jsx_runtime = __webpack_require__(4848);
;// CONCATENATED MODULE: ./node_modules/@restart/ui/esm/DropdownMenu.js
const DropdownMenu_excluded = ["children", "usePopper"];
function DropdownMenu_objectWithoutPropertiesLoose(r, e) { if (null == r) return {}; var t = {}; for (var n in r) if ({}.hasOwnProperty.call(r, n)) { if (e.indexOf(n) >= 0) continue; t[n] = r[n]; } return t; }








const DropdownMenu_noop = () => {};

/**
 * @memberOf Dropdown
 * @param {object}  options
 * @param {boolean} options.flip Automatically adjust the menu `drop` position based on viewport edge detection
 * @param {[number, number]} options.offset Define an offset distance between the Menu and the Toggle
 * @param {boolean} options.show Display the menu manually, ignored in the context of a `Dropdown`
 * @param {boolean} options.usePopper opt in/out of using PopperJS to position menus. When disabled you must position it yourself.
 * @param {string}  options.rootCloseEvent The pointer event to listen for when determining "clicks outside" the menu for triggering a close.
 * @param {object}  options.popperConfig Options passed to the [`usePopper`](/api/usePopper) hook.
 */
function useDropdownMenu(options = {}) {
  const context = (0,react.useContext)(esm_DropdownContext);
  const [arrowElement, attachArrowRef] = useCallbackRef();
  const hasShownRef = (0,react.useRef)(false);
  const {
    flip,
    offset,
    rootCloseEvent,
    fixed = false,
    placement: placementOverride,
    popperConfig = {},
    enableEventListeners = true,
    usePopper: shouldUsePopper = !!context
  } = options;
  const show = (context == null ? void 0 : context.show) == null ? !!options.show : context.show;
  if (show && !hasShownRef.current) {
    hasShownRef.current = true;
  }
  const handleClose = e => {
    context == null ? void 0 : context.toggle(false, e);
  };
  const {
    placement,
    setMenu,
    menuElement,
    toggleElement
  } = context || {};
  const popper = esm_usePopper(toggleElement, menuElement, mergeOptionsWithPopperConfig({
    placement: placementOverride || placement || 'bottom-start',
    enabled: shouldUsePopper,
    enableEvents: enableEventListeners == null ? show : enableEventListeners,
    offset,
    flip,
    fixed,
    arrowElement,
    popperConfig
  }));
  const menuProps = Object.assign({
    ref: setMenu || DropdownMenu_noop,
    'aria-labelledby': toggleElement == null ? void 0 : toggleElement.id
  }, popper.attributes.popper, {
    style: popper.styles.popper
  });
  const metadata = {
    show,
    placement,
    hasShown: hasShownRef.current,
    toggle: context == null ? void 0 : context.toggle,
    popper: shouldUsePopper ? popper : null,
    arrowProps: shouldUsePopper ? Object.assign({
      ref: attachArrowRef
    }, popper.attributes.arrow, {
      style: popper.styles.arrow
    }) : {}
  };
  esm_useClickOutside(menuElement, handleClose, {
    clickTrigger: rootCloseEvent,
    disabled: !show
  });
  return [menuProps, metadata];
}
/**
 * Also exported as `<Dropdown.Menu>` from `Dropdown`.
 *
 * @displayName DropdownMenu
 * @memberOf Dropdown
 */
function DropdownMenu(_ref) {
  let {
      children,
      usePopper: usePopperProp = true
    } = _ref,
    options = DropdownMenu_objectWithoutPropertiesLoose(_ref, DropdownMenu_excluded);
  const [props, meta] = useDropdownMenu(Object.assign({}, options, {
    usePopper: usePopperProp
  }));
  return /*#__PURE__*/(0,jsx_runtime.jsx)(jsx_runtime.Fragment, {
    children: children(props, meta)
  });
}
DropdownMenu.displayName = 'DropdownMenu';

/** @component */
/* harmony default export */ const esm_DropdownMenu = (DropdownMenu);
;// CONCATENATED MODULE: ./node_modules/@react-aria/ssr/dist/SSRProvider.mjs


/*
 * Copyright 2020 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */ // We must avoid a circular dependency with @react-aria/utils, and this useLayoutEffect is
// guarded by a check that it only runs on the client side.
// eslint-disable-next-line rulesdir/useLayoutEffectRule

// Default context value to use in case there is no SSRProvider. This is fine for
// client-only apps. In order to support multiple copies of React Aria potentially
// being on the page at once, the prefix is set to a random number. SSRProvider
// will reset this to zero for consistency between server and client, so in the
// SSR case multiple copies of React Aria is not supported.
const $b5e257d569688ac6$var$defaultContext = {
    prefix: String(Math.round(Math.random() * 10000000000)),
    current: 0
};
const $b5e257d569688ac6$var$SSRContext = /*#__PURE__*/ (0, react).createContext($b5e257d569688ac6$var$defaultContext);
const $b5e257d569688ac6$var$IsSSRContext = /*#__PURE__*/ (0, react).createContext(false);
// This is only used in React < 18.
function $b5e257d569688ac6$var$LegacySSRProvider(props) {
    let cur = (0, $670gB$useContext)($b5e257d569688ac6$var$SSRContext);
    let counter = $b5e257d569688ac6$var$useCounter(cur === $b5e257d569688ac6$var$defaultContext);
    let [isSSR, setIsSSR] = (0, $670gB$useState)(true);
    let value = (0, $670gB$useMemo)(()=>({
            // If this is the first SSRProvider, start with an empty string prefix, otherwise
            // append and increment the counter.
            prefix: cur === $b5e257d569688ac6$var$defaultContext ? '' : `${cur.prefix}-${counter}`,
            current: 0
        }), [
        cur,
        counter
    ]);
    // If on the client, and the component was initially server rendered,
    // then schedule a layout effect to update the component after hydration.
    if (typeof document !== 'undefined') // This if statement technically breaks the rules of hooks, but is safe
    // because the condition never changes after mounting.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    (0, $670gB$useLayoutEffect)(()=>{
        setIsSSR(false);
    }, []);
    return /*#__PURE__*/ (0, $670gB$react).createElement($b5e257d569688ac6$var$SSRContext.Provider, {
        value: value
    }, /*#__PURE__*/ (0, $670gB$react).createElement($b5e257d569688ac6$var$IsSSRContext.Provider, {
        value: isSSR
    }, props.children));
}
let $b5e257d569688ac6$var$warnedAboutSSRProvider = false;
function $b5e257d569688ac6$export$9f8ac96af4b1b2ae(props) {
    if (typeof (0, $670gB$react)['useId'] === 'function') {
        if ( true && !$b5e257d569688ac6$var$warnedAboutSSRProvider) {
            console.warn('In React 18, SSRProvider is not necessary and is a noop. You can remove it from your app.');
            $b5e257d569688ac6$var$warnedAboutSSRProvider = true;
        }
        return /*#__PURE__*/ (0, $670gB$react).createElement((0, $670gB$react).Fragment, null, props.children);
    }
    return /*#__PURE__*/ (0, $670gB$react).createElement($b5e257d569688ac6$var$LegacySSRProvider, props);
}
let $b5e257d569688ac6$var$canUseDOM = Boolean(typeof window !== 'undefined' && window.document && window.document.createElement);
let $b5e257d569688ac6$var$componentIds = new WeakMap();
function $b5e257d569688ac6$var$useCounter(isDisabled = false) {
    let ctx = (0, react.useContext)($b5e257d569688ac6$var$SSRContext);
    let ref = (0, react.useRef)(null);
    // eslint-disable-next-line rulesdir/pure-render
    if (ref.current === null && !isDisabled) {
        var _React___SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_ReactCurrentOwner, _React___SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
        // In strict mode, React renders components twice, and the ref will be reset to null on the second render.
        // This means our id counter will be incremented twice instead of once. This is a problem because on the
        // server, components are only rendered once and so ids generated on the server won't match the client.
        // In React 18, useId was introduced to solve this, but it is not available in older versions. So to solve this
        // we need to use some React internals to access the underlying Fiber instance, which is stable between renders.
        // This is exposed as ReactCurrentOwner in development, which is all we need since StrictMode only runs in development.
        // To ensure that we only increment the global counter once, we store the starting id for this component in
        // a weak map associated with the Fiber. On the second render, we reset the global counter to this value.
        // Since React runs the second render immediately after the first, this is safe.
        // @ts-ignore
        let currentOwner = (_React___SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED = (0, react).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED) === null || _React___SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED === void 0 ? void 0 : (_React___SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_ReactCurrentOwner = _React___SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentOwner) === null || _React___SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_ReactCurrentOwner === void 0 ? void 0 : _React___SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_ReactCurrentOwner.current;
        if (currentOwner) {
            let prevComponentValue = $b5e257d569688ac6$var$componentIds.get(currentOwner);
            if (prevComponentValue == null) // On the first render, and first call to useId, store the id and state in our weak map.
            $b5e257d569688ac6$var$componentIds.set(currentOwner, {
                id: ctx.current,
                state: currentOwner.memoizedState
            });
            else if (currentOwner.memoizedState !== prevComponentValue.state) {
                // On the second render, the memoizedState gets reset by React.
                // Reset the counter, and remove from the weak map so we don't
                // do this for subsequent useId calls.
                ctx.current = prevComponentValue.id;
                $b5e257d569688ac6$var$componentIds.delete(currentOwner);
            }
        }
        // eslint-disable-next-line rulesdir/pure-render
        ref.current = ++ctx.current;
    }
    // eslint-disable-next-line rulesdir/pure-render
    return ref.current;
}
function $b5e257d569688ac6$var$useLegacySSRSafeId(defaultId) {
    let ctx = (0, react.useContext)($b5e257d569688ac6$var$SSRContext);
    // If we are rendering in a non-DOM environment, and there's no SSRProvider,
    // provide a warning to hint to the developer to add one.
    if (ctx === $b5e257d569688ac6$var$defaultContext && !$b5e257d569688ac6$var$canUseDOM) console.warn('When server rendering, you must wrap your application in an <SSRProvider> to ensure consistent ids are generated between the client and server.');
    let counter = $b5e257d569688ac6$var$useCounter(!!defaultId);
    let prefix = ctx === $b5e257d569688ac6$var$defaultContext && "production" === 'test' ? 0 : `react-aria${ctx.prefix}`;
    return defaultId || `${prefix}-${counter}`;
}
function $b5e257d569688ac6$var$useModernSSRSafeId(defaultId) {
    let id = (0, react).useId();
    let [didSSR] = (0, react.useState)($b5e257d569688ac6$export$535bd6ca7f90a273());
    let prefix = didSSR || "production" === 'test' ? 'react-aria' : `react-aria${$b5e257d569688ac6$var$defaultContext.prefix}`;
    return defaultId || `${prefix}-${id}`;
}
const $b5e257d569688ac6$export$619500959fc48b26 = typeof (0, react)['useId'] === 'function' ? $b5e257d569688ac6$var$useModernSSRSafeId : $b5e257d569688ac6$var$useLegacySSRSafeId;
function $b5e257d569688ac6$var$getSnapshot() {
    return false;
}
function $b5e257d569688ac6$var$getServerSnapshot() {
    return true;
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function $b5e257d569688ac6$var$subscribe(onStoreChange) {
    // noop
    return ()=>{};
}
function $b5e257d569688ac6$export$535bd6ca7f90a273() {
    // In React 18, we can use useSyncExternalStore to detect if we're server rendering or hydrating.
    if (typeof (0, react)['useSyncExternalStore'] === 'function') return (0, react)['useSyncExternalStore']($b5e257d569688ac6$var$subscribe, $b5e257d569688ac6$var$getSnapshot, $b5e257d569688ac6$var$getServerSnapshot);
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return (0, react.useContext)($b5e257d569688ac6$var$IsSSRContext);
}



//# sourceMappingURL=SSRProvider.module.js.map

;// CONCATENATED MODULE: ./node_modules/@restart/ui/esm/DropdownToggle.js





const isRoleMenu = el => {
  var _el$getAttribute;
  return ((_el$getAttribute = el.getAttribute('role')) == null ? void 0 : _el$getAttribute.toLowerCase()) === 'menu';
};
const DropdownToggle_noop = () => {};

/**
 * Wires up Dropdown toggle functionality, returning a set a props to attach
 * to the element that functions as the dropdown toggle (generally a button).
 *
 * @memberOf Dropdown
 */
function useDropdownToggle() {
  const id = $b5e257d569688ac6$export$619500959fc48b26();
  const {
    show = false,
    toggle = DropdownToggle_noop,
    setToggle,
    menuElement
  } = (0,react.useContext)(esm_DropdownContext) || {};
  const handleClick = (0,react.useCallback)(e => {
    toggle(!show, e);
  }, [show, toggle]);
  const props = {
    id,
    ref: setToggle || DropdownToggle_noop,
    onClick: handleClick,
    'aria-expanded': !!show
  };

  // This is maybe better down in an effect, but
  // the component is going to update anyway when the menu element
  // is set so might return new props.
  if (menuElement && isRoleMenu(menuElement)) {
    props['aria-haspopup'] = true;
  }
  return [props, {
    show,
    toggle
  }];
}
/**
 * Also exported as `<Dropdown.Toggle>` from `Dropdown`.
 *
 * @displayName DropdownToggle
 * @memberOf Dropdown
 */
function DropdownToggle({
  children
}) {
  const [props, meta] = useDropdownToggle();
  return /*#__PURE__*/(0,jsx_runtime.jsx)(jsx_runtime.Fragment, {
    children: children(props, meta)
  });
}
DropdownToggle.displayName = 'DropdownToggle';

/** @component */
/* harmony default export */ const esm_DropdownToggle = (DropdownToggle);
;// CONCATENATED MODULE: ./node_modules/@restart/ui/esm/SelectableContext.js

const SelectableContext = /*#__PURE__*/react.createContext(null);
const makeEventKey = (eventKey, href = null) => {
  if (eventKey != null) return String(eventKey);
  return href || null;
};
/* harmony default export */ const esm_SelectableContext = (SelectableContext);
;// CONCATENATED MODULE: ./node_modules/@restart/ui/esm/NavContext.js

const NavContext = /*#__PURE__*/react.createContext(null);
NavContext.displayName = 'NavContext';
/* harmony default export */ const esm_NavContext = (NavContext);
;// CONCATENATED MODULE: ./node_modules/@restart/ui/esm/Button.js
const Button_excluded = ["as", "disabled"];
function Button_objectWithoutPropertiesLoose(r, e) { if (null == r) return {}; var t = {}; for (var n in r) if ({}.hasOwnProperty.call(r, n)) { if (e.indexOf(n) >= 0) continue; t[n] = r[n]; } return t; }


function isTrivialHref(href) {
  return !href || href.trim() === '#';
}
function useButtonProps({
  tagName,
  disabled,
  href,
  target,
  rel,
  role,
  onClick,
  tabIndex = 0,
  type
}) {
  if (!tagName) {
    if (href != null || target != null || rel != null) {
      tagName = 'a';
    } else {
      tagName = 'button';
    }
  }
  const meta = {
    tagName
  };
  if (tagName === 'button') {
    return [{
      type: type || 'button',
      disabled
    }, meta];
  }
  const handleClick = event => {
    if (disabled || tagName === 'a' && isTrivialHref(href)) {
      event.preventDefault();
    }
    if (disabled) {
      event.stopPropagation();
      return;
    }
    onClick == null ? void 0 : onClick(event);
  };
  const handleKeyDown = event => {
    if (event.key === ' ') {
      event.preventDefault();
      handleClick(event);
    }
  };
  if (tagName === 'a') {
    // Ensure there's a href so Enter can trigger anchor button.
    href || (href = '#');
    if (disabled) {
      href = undefined;
    }
  }
  return [{
    role: role != null ? role : 'button',
    // explicitly undefined so that it overrides the props disabled in a spread
    // e.g. <Tag {...props} {...hookProps} />
    disabled: undefined,
    tabIndex: disabled ? undefined : tabIndex,
    href,
    target: tagName === 'a' ? target : undefined,
    'aria-disabled': !disabled ? undefined : disabled,
    rel: tagName === 'a' ? rel : undefined,
    onClick: handleClick,
    onKeyDown: handleKeyDown
  }, meta];
}
const Button = /*#__PURE__*/react.forwardRef((_ref, ref) => {
  let {
      as: asProp,
      disabled
    } = _ref,
    props = Button_objectWithoutPropertiesLoose(_ref, Button_excluded);
  const [buttonProps, {
    tagName: Component
  }] = useButtonProps(Object.assign({
    tagName: asProp,
    disabled
  }, props));
  return /*#__PURE__*/(0,jsx_runtime.jsx)(Component, Object.assign({}, props, buttonProps, {
    ref: ref
  }));
});
Button.displayName = 'Button';
/* harmony default export */ const esm_Button = (Button);
;// CONCATENATED MODULE: ./node_modules/@restart/ui/esm/DataKey.js
const ATTRIBUTE_PREFIX = `data-rr-ui-`;
const PROPERTY_PREFIX = (/* unused pure expression or super */ null && (`rrUi`));
function dataAttr(property) {
  return `${ATTRIBUTE_PREFIX}${property}`;
}
function dataProp(property) {
  return `${PROPERTY_PREFIX}${property}`;
}
;// CONCATENATED MODULE: ./node_modules/@restart/ui/esm/DropdownItem.js
const DropdownItem_excluded = ["eventKey", "disabled", "onClick", "active", "as"];
function DropdownItem_objectWithoutPropertiesLoose(r, e) { if (null == r) return {}; var t = {}; for (var n in r) if ({}.hasOwnProperty.call(r, n)) { if (e.indexOf(n) >= 0) continue; t[n] = r[n]; } return t; }








/**
 * Create a dropdown item. Returns a set of props for the dropdown item component
 * including an `onClick` handler that prevents selection when the item is disabled
 */
function useDropdownItem({
  key,
  href,
  active,
  disabled,
  onClick
}) {
  const onSelectCtx = (0,react.useContext)(esm_SelectableContext);
  const navContext = (0,react.useContext)(esm_NavContext);
  const {
    activeKey
  } = navContext || {};
  const eventKey = makeEventKey(key, href);
  const isActive = active == null && key != null ? makeEventKey(activeKey) === eventKey : active;
  const handleClick = useEventCallback(event => {
    if (disabled) return;
    onClick == null ? void 0 : onClick(event);
    if (onSelectCtx && !event.isPropagationStopped()) {
      onSelectCtx(eventKey, event);
    }
  });
  return [{
    onClick: handleClick,
    'aria-disabled': disabled || undefined,
    'aria-selected': isActive,
    [dataAttr('dropdown-item')]: ''
  }, {
    isActive
  }];
}
const DropdownItem = /*#__PURE__*/react.forwardRef((_ref, ref) => {
  let {
      eventKey,
      disabled,
      onClick,
      active,
      as: Component = esm_Button
    } = _ref,
    props = DropdownItem_objectWithoutPropertiesLoose(_ref, DropdownItem_excluded);
  const [dropdownItemProps] = useDropdownItem({
    key: eventKey,
    href: props.href,
    disabled,
    onClick,
    active
  });
  return /*#__PURE__*/(0,jsx_runtime.jsx)(Component, Object.assign({}, props, {
    ref: ref
  }, dropdownItemProps));
});
DropdownItem.displayName = 'DropdownItem';
/* harmony default export */ const esm_DropdownItem = (DropdownItem);
;// CONCATENATED MODULE: ./node_modules/@restart/ui/esm/useWindow.js


const Context = /*#__PURE__*/(0,react.createContext)(canUseDOM ? window : undefined);
const WindowProvider = Context.Provider;

/**
 * The document "window" placed in React context. Helpful for determining
 * SSR context, or when rendering into an iframe.
 *
 * @returns the current window
 */
function useWindow() {
  return (0,react.useContext)(Context);
}
;// CONCATENATED MODULE: ./node_modules/@restart/ui/esm/Dropdown.js

















function useRefWithUpdate() {
  const forceUpdate = useForceUpdate();
  const ref = (0,react.useRef)(null);
  const attachRef = (0,react.useCallback)(element => {
    ref.current = element;
    // ensure that a menu set triggers an update for consumers
    forceUpdate();
  }, [forceUpdate]);
  return [ref, attachRef];
}

/**
 * @displayName Dropdown
 * @public
 */
function Dropdown({
  defaultShow,
  show: rawShow,
  onSelect,
  onToggle: rawOnToggle,
  itemSelector = `* [${dataAttr('dropdown-item')}]`,
  focusFirstItemOnShow,
  placement = 'bottom-start',
  children
}) {
  const window = useWindow();
  const [show, onToggle] = useUncontrolledProp(rawShow, defaultShow, rawOnToggle);

  // We use normal refs instead of useCallbackRef in order to populate the
  // the value as quickly as possible, otherwise the effect to focus the element
  // may run before the state value is set
  const [menuRef, setMenu] = useRefWithUpdate();
  const menuElement = menuRef.current;
  const [toggleRef, setToggle] = useRefWithUpdate();
  const toggleElement = toggleRef.current;
  const lastShow = usePrevious(show);
  const lastSourceEvent = (0,react.useRef)(null);
  const focusInDropdown = (0,react.useRef)(false);
  const onSelectCtx = (0,react.useContext)(esm_SelectableContext);
  const toggle = (0,react.useCallback)((nextShow, event, source = event == null ? void 0 : event.type) => {
    onToggle(nextShow, {
      originalEvent: event,
      source
    });
  }, [onToggle]);
  const handleSelect = useEventCallback((key, event) => {
    onSelect == null ? void 0 : onSelect(key, event);
    toggle(false, event, 'select');
    if (!event.isPropagationStopped()) {
      onSelectCtx == null ? void 0 : onSelectCtx(key, event);
    }
  });
  const context = (0,react.useMemo)(() => ({
    toggle,
    placement,
    show,
    menuElement,
    toggleElement,
    setMenu,
    setToggle
  }), [toggle, placement, show, menuElement, toggleElement, setMenu, setToggle]);
  if (menuElement && lastShow && !show) {
    focusInDropdown.current = menuElement.contains(menuElement.ownerDocument.activeElement);
  }
  const focusToggle = useEventCallback(() => {
    if (toggleElement && toggleElement.focus) {
      toggleElement.focus();
    }
  });
  const maybeFocusFirst = useEventCallback(() => {
    const type = lastSourceEvent.current;
    let focusType = focusFirstItemOnShow;
    if (focusType == null) {
      focusType = menuRef.current && isRoleMenu(menuRef.current) ? 'keyboard' : false;
    }
    if (focusType === false || focusType === 'keyboard' && !/^key.+$/.test(type)) {
      return;
    }
    const first = qsa(menuRef.current, itemSelector)[0];
    if (first && first.focus) first.focus();
  });
  (0,react.useEffect)(() => {
    if (show) maybeFocusFirst();else if (focusInDropdown.current) {
      focusInDropdown.current = false;
      focusToggle();
    }
    // only `show` should be changing
  }, [show, focusInDropdown, focusToggle, maybeFocusFirst]);
  (0,react.useEffect)(() => {
    lastSourceEvent.current = null;
  });
  const getNextFocusedChild = (current, offset) => {
    if (!menuRef.current) return null;
    const items = qsa(menuRef.current, itemSelector);
    let index = items.indexOf(current) + offset;
    index = Math.max(0, Math.min(index, items.length));
    return items[index];
  };
  useEventListener_useEventListener((0,react.useCallback)(() => window.document, [window]), 'keydown', event => {
    var _menuRef$current, _toggleRef$current;
    const {
      key
    } = event;
    const target = event.target;
    const fromMenu = (_menuRef$current = menuRef.current) == null ? void 0 : _menuRef$current.contains(target);
    const fromToggle = (_toggleRef$current = toggleRef.current) == null ? void 0 : _toggleRef$current.contains(target);

    // Second only to https://github.com/twbs/bootstrap/blob/8cfbf6933b8a0146ac3fbc369f19e520bd1ebdac/js/src/dropdown.js#L400
    // in inscrutability
    const isInput = /input|textarea/i.test(target.tagName);
    if (isInput && (key === ' ' || key !== 'Escape' && fromMenu || key === 'Escape' && target.type === 'search')) {
      return;
    }
    if (!fromMenu && !fromToggle) {
      return;
    }
    if (key === 'Tab' && (!menuRef.current || !show)) {
      return;
    }
    lastSourceEvent.current = event.type;
    const meta = {
      originalEvent: event,
      source: event.type
    };
    switch (key) {
      case 'ArrowUp':
        {
          const next = getNextFocusedChild(target, -1);
          if (next && next.focus) next.focus();
          event.preventDefault();
          return;
        }
      case 'ArrowDown':
        event.preventDefault();
        if (!show) {
          onToggle(true, meta);
        } else {
          const next = getNextFocusedChild(target, 1);
          if (next && next.focus) next.focus();
        }
        return;
      case 'Tab':
        // on keydown the target is the element being tabbed FROM, we need that
        // to know if this event is relevant to this dropdown (e.g. in this menu).
        // On `keyup` the target is the element being tagged TO which we use to check
        // if focus has left the menu
        esm_addEventListener(target.ownerDocument, 'keyup', e => {
          var _menuRef$current2;
          if (e.key === 'Tab' && !e.target || !((_menuRef$current2 = menuRef.current) != null && _menuRef$current2.contains(e.target))) {
            onToggle(false, meta);
          }
        }, {
          once: true
        });
        break;
      case 'Escape':
        if (key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
        }
        onToggle(false, meta);
        break;
      default:
    }
  });
  return /*#__PURE__*/(0,jsx_runtime.jsx)(esm_SelectableContext.Provider, {
    value: handleSelect,
    children: /*#__PURE__*/(0,jsx_runtime.jsx)(esm_DropdownContext.Provider, {
      value: context,
      children: children
    })
  });
}
Dropdown.displayName = 'Dropdown';
Dropdown.Menu = esm_DropdownMenu;
Dropdown.Toggle = esm_DropdownToggle;
Dropdown.Item = esm_DropdownItem;
/* harmony default export */ const esm_Dropdown = (Dropdown);
// EXTERNAL MODULE: ./node_modules/invariant/browser.js
var browser = __webpack_require__(311);
var browser_default = /*#__PURE__*/__webpack_require__.n(browser);
;// CONCATENATED MODULE: ./node_modules/uncontrollable/lib/esm/utils.js


var utils_noop = function noop() {};

function readOnlyPropType(handler, name) {
  return function (props, propName) {
    if (props[propName] !== undefined) {
      if (!props[handler]) {
        return new Error("You have provided a `" + propName + "` prop to `" + name + "` " + ("without an `" + handler + "` handler prop. This will render a read-only field. ") + ("If the field should be mutable use `" + utils_defaultKey(propName) + "`. ") + ("Otherwise, set `" + handler + "`."));
      }
    }
  };
}

function uncontrolledPropTypes(controlledValues, displayName) {
  var propTypes = {};
  Object.keys(controlledValues).forEach(function (prop) {
    // add default propTypes for folks that use runtime checks
    propTypes[utils_defaultKey(prop)] = utils_noop;

    if (false) { var handler; }
  });
  return propTypes;
}
function isProp(props, prop) {
  return props[prop] !== undefined;
}
function utils_defaultKey(key) {
  return 'default' + key.charAt(0).toUpperCase() + key.substr(1);
}
/**
 * Copyright (c) 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

function canAcceptRef(component) {
  return !!component && (typeof component !== 'function' || component.prototype && component.prototype.isReactComponent);
}
;// CONCATENATED MODULE: ./node_modules/uncontrollable/lib/esm/hook.js



function hook_toPropertyKey(arg) { var key = hook_toPrimitive(arg, "string"); return typeof key === "symbol" ? key : String(key); }

function hook_toPrimitive(input, hint) { if (typeof input !== "object" || input === null) return input; var prim = input[Symbol.toPrimitive]; if (prim !== undefined) { var res = prim.call(input, hint || "default"); if (typeof res !== "object") return res; throw new TypeError("@@toPrimitive must return a primitive value."); } return (hint === "string" ? String : Number)(input); }




function hook_useUncontrolledProp(propValue, defaultValue, handler) {
  var wasPropRef = (0,react.useRef)(propValue !== undefined);

  var _useState = (0,react.useState)(defaultValue),
      stateValue = _useState[0],
      setState = _useState[1];

  var isProp = propValue !== undefined;
  var wasProp = wasPropRef.current;
  wasPropRef.current = isProp;
  /**
   * If a prop switches from controlled to Uncontrolled
   * reset its value to the defaultValue
   */

  if (!isProp && wasProp && stateValue !== defaultValue) {
    setState(defaultValue);
  }

  return [isProp ? propValue : stateValue, (0,react.useCallback)(function (value) {
    for (var _len = arguments.length, args = new Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
      args[_key - 1] = arguments[_key];
    }

    if (handler) handler.apply(void 0, [value].concat(args));
    setState(value);
  }, [handler])];
}


function hook_useUncontrolled(props, config) {
  return Object.keys(config).reduce(function (result, fieldName) {
    var _extends2;

    var _ref = result,
        defaultValue = _ref[utils_defaultKey(fieldName)],
        propsValue = _ref[fieldName],
        rest = objectWithoutPropertiesLoose_objectWithoutPropertiesLoose(_ref, [utils_defaultKey(fieldName), fieldName].map(hook_toPropertyKey));

    var handlerName = config[fieldName];

    var _useUncontrolledProp = hook_useUncontrolledProp(propsValue, defaultValue, props[handlerName]),
        value = _useUncontrolledProp[0],
        handler = _useUncontrolledProp[1];

    return extends_extends({}, rest, (_extends2 = {}, _extends2[fieldName] = value, _extends2[handlerName] = handler, _extends2));
  }, props);
}
;// CONCATENATED MODULE: ./node_modules/uncontrollable/lib/esm/uncontrollable.js



var _jsxFileName = "/Users/jquense/src/uncontrollable/src/uncontrollable.js";




function uncontrollable(Component, controlledValues, methods) {
  if (methods === void 0) {
    methods = [];
  }

  var displayName = Component.displayName || Component.name || 'Component';
  var canAcceptRef = Utils.canAcceptRef(Component);
  var controlledProps = Object.keys(controlledValues);
  var PROPS_TO_OMIT = controlledProps.map(Utils.defaultKey);
  !(canAcceptRef || !methods.length) ?  false ? 0 : invariant(false) : void 0;

  var UncontrolledComponent =
  /*#__PURE__*/
  function (_React$Component) {
    _inheritsLoose(UncontrolledComponent, _React$Component);

    function UncontrolledComponent() {
      var _this;

      for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
        args[_key] = arguments[_key];
      }

      _this = _React$Component.call.apply(_React$Component, [this].concat(args)) || this;
      _this.handlers = Object.create(null);
      controlledProps.forEach(function (propName) {
        var handlerName = controlledValues[propName];

        var handleChange = function handleChange(value) {
          if (_this.props[handlerName]) {
            var _this$props;

            _this._notifying = true;

            for (var _len2 = arguments.length, args = new Array(_len2 > 1 ? _len2 - 1 : 0), _key2 = 1; _key2 < _len2; _key2++) {
              args[_key2 - 1] = arguments[_key2];
            }

            (_this$props = _this.props)[handlerName].apply(_this$props, [value].concat(args));

            _this._notifying = false;
          }

          if (!_this.unmounted) _this.setState(function (_ref) {
            var _extends2;

            var values = _ref.values;
            return {
              values: _extends(Object.create(null), values, (_extends2 = {}, _extends2[propName] = value, _extends2))
            };
          });
        };

        _this.handlers[handlerName] = handleChange;
      });
      if (methods.length) _this.attachRef = function (ref) {
        _this.inner = ref;
      };
      var values = Object.create(null);
      controlledProps.forEach(function (key) {
        values[key] = _this.props[Utils.defaultKey(key)];
      });
      _this.state = {
        values: values,
        prevProps: {}
      };
      return _this;
    }

    var _proto = UncontrolledComponent.prototype;

    _proto.shouldComponentUpdate = function shouldComponentUpdate() {
      //let setState trigger the update
      return !this._notifying;
    };

    UncontrolledComponent.getDerivedStateFromProps = function getDerivedStateFromProps(props, _ref2) {
      var values = _ref2.values,
          prevProps = _ref2.prevProps;
      var nextState = {
        values: _extends(Object.create(null), values),
        prevProps: {}
      };
      controlledProps.forEach(function (key) {
        /**
         * If a prop switches from controlled to Uncontrolled
         * reset its value to the defaultValue
         */
        nextState.prevProps[key] = props[key];

        if (!Utils.isProp(props, key) && Utils.isProp(prevProps, key)) {
          nextState.values[key] = props[Utils.defaultKey(key)];
        }
      });
      return nextState;
    };

    _proto.componentWillUnmount = function componentWillUnmount() {
      this.unmounted = true;
    };

    _proto.render = function render() {
      var _this2 = this;

      var _this$props2 = this.props,
          innerRef = _this$props2.innerRef,
          props = _objectWithoutPropertiesLoose(_this$props2, ["innerRef"]);

      PROPS_TO_OMIT.forEach(function (prop) {
        delete props[prop];
      });
      var newProps = {};
      controlledProps.forEach(function (propName) {
        var propValue = _this2.props[propName];
        newProps[propName] = propValue !== undefined ? propValue : _this2.state.values[propName];
      });
      return React.createElement(Component, _extends({}, props, newProps, this.handlers, {
        ref: innerRef || this.attachRef
      }));
    };

    return UncontrolledComponent;
  }(React.Component);

  polyfill(UncontrolledComponent);
  UncontrolledComponent.displayName = "Uncontrolled(" + displayName + ")";
  UncontrolledComponent.propTypes = _extends({
    innerRef: function innerRef() {}
  }, Utils.uncontrolledPropTypes(controlledValues, displayName));
  methods.forEach(function (method) {
    UncontrolledComponent.prototype[method] = function $proxiedMethod() {
      var _this$inner;

      return (_this$inner = this.inner)[method].apply(_this$inner, arguments);
    };
  });
  var WrappedComponent = UncontrolledComponent;

  if (React.forwardRef) {
    WrappedComponent = React.forwardRef(function (props, ref) {
      return React.createElement(UncontrolledComponent, _extends({}, props, {
        innerRef: ref,
        __source: {
          fileName: _jsxFileName,
          lineNumber: 128
        },
        __self: this
      }));
    });
    WrappedComponent.propTypes = UncontrolledComponent.propTypes;
  }

  WrappedComponent.ControlledComponent = Component;
  /**
   * useful when wrapping a Component and you want to control
   * everything
   */

  WrappedComponent.deferControlTo = function (newComponent, additions, nextMethods) {
    if (additions === void 0) {
      additions = {};
    }

    return uncontrollable(newComponent, _extends({}, controlledValues, additions), nextMethods);
  };

  return WrappedComponent;
}
;// CONCATENATED MODULE: ./node_modules/uncontrollable/lib/esm/index.js


;// CONCATENATED MODULE: ./node_modules/@restart/hooks/esm/useCommittedRef.js


/**
 * Creates a `Ref` whose value is updated in an effect, ensuring the most recent
 * value is the one rendered with. Generally only required for Concurrent mode usage
 * where previous work in `render()` may be discarded before being used.
 *
 * This is safe to access in an event handler.
 *
 * @param value The `Ref` value
 */
function esm_useCommittedRef_useCommittedRef(value) {
  const ref = (0,react.useRef)(value);
  (0,react.useEffect)(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
/* harmony default export */ const hooks_esm_useCommittedRef = (esm_useCommittedRef_useCommittedRef);
;// CONCATENATED MODULE: ./node_modules/@restart/hooks/esm/useEventCallback.js


function useEventCallback_useEventCallback(fn) {
  const ref = hooks_esm_useCommittedRef(fn);
  return (0,react.useCallback)(function (...args) {
    return ref.current && ref.current(...args);
  }, [ref]);
}
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/DropdownContext.js
"use client";


const DropdownContext_DropdownContext = /*#__PURE__*/react.createContext({});
DropdownContext_DropdownContext.displayName = 'DropdownContext';
/* harmony default export */ const react_bootstrap_esm_DropdownContext = (DropdownContext_DropdownContext);
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/ThemeProvider.js
"use client";




const DEFAULT_BREAKPOINTS = ['xxl', 'xl', 'lg', 'md', 'sm', 'xs'];
const DEFAULT_MIN_BREAKPOINT = 'xs';
const ThemeContext = /*#__PURE__*/react.createContext({
  prefixes: {},
  breakpoints: DEFAULT_BREAKPOINTS,
  minBreakpoint: DEFAULT_MIN_BREAKPOINT
});
const {
  Consumer,
  Provider
} = ThemeContext;
function ThemeProvider({
  prefixes = {},
  breakpoints = DEFAULT_BREAKPOINTS,
  minBreakpoint = DEFAULT_MIN_BREAKPOINT,
  dir,
  children
}) {
  const contextValue = useMemo(() => ({
    prefixes: {
      ...prefixes
    },
    breakpoints,
    minBreakpoint,
    dir
  }), [prefixes, breakpoints, minBreakpoint, dir]);
  return /*#__PURE__*/_jsx(Provider, {
    value: contextValue,
    children: children
  });
}
function useBootstrapPrefix(prefix, defaultPrefix) {
  const {
    prefixes
  } = (0,react.useContext)(ThemeContext);
  return prefix || prefixes[defaultPrefix] || defaultPrefix;
}
function useBootstrapBreakpoints() {
  const {
    breakpoints
  } = useContext(ThemeContext);
  return breakpoints;
}
function useBootstrapMinBreakpoint() {
  const {
    minBreakpoint
  } = useContext(ThemeContext);
  return minBreakpoint;
}
function useIsRTL() {
  const {
    dir
  } = (0,react.useContext)(ThemeContext);
  return dir === 'rtl';
}
function createBootstrapComponent(Component, opts) {
  if (typeof opts === 'string') opts = {
    prefix: opts
  };
  const isClassy = Component.prototype && Component.prototype.isReactComponent;
  // If it's a functional component make sure we don't break it with a ref
  const {
    prefix,
    forwardRefAs = isClassy ? 'ref' : 'innerRef'
  } = opts;
  const Wrapped = /*#__PURE__*/React.forwardRef(({
    ...props
  }, ref) => {
    props[forwardRefAs] = ref;
    const bsPrefix = useBootstrapPrefix(props.bsPrefix, prefix);
    return /*#__PURE__*/_jsx(Component, {
      ...props,
      bsPrefix: bsPrefix
    });
  });
  Wrapped.displayName = `Bootstrap(${Component.displayName || Component.name})`;
  return Wrapped;
}

/* harmony default export */ const esm_ThemeProvider = ((/* unused pure expression or super */ null && (ThemeProvider)));
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/DropdownDivider.js
"use client";





const DropdownDivider = /*#__PURE__*/react.forwardRef(({
  className,
  bsPrefix,
  as: Component = 'hr',
  role = 'separator',
  ...props
}, ref) => {
  bsPrefix = useBootstrapPrefix(bsPrefix, 'dropdown-divider');
  return /*#__PURE__*/(0,jsx_runtime.jsx)(Component, {
    ref: ref,
    className: classnames_default()(className, bsPrefix),
    role: role,
    ...props
  });
});
DropdownDivider.displayName = 'DropdownDivider';
/* harmony default export */ const esm_DropdownDivider = (DropdownDivider);
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/DropdownHeader.js
"use client";





const DropdownHeader = /*#__PURE__*/react.forwardRef(({
  className,
  bsPrefix,
  as: Component = 'div',
  role = 'heading',
  ...props
}, ref) => {
  bsPrefix = useBootstrapPrefix(bsPrefix, 'dropdown-header');
  return /*#__PURE__*/(0,jsx_runtime.jsx)(Component, {
    ref: ref,
    className: classnames_default()(className, bsPrefix),
    role: role,
    ...props
  });
});
DropdownHeader.displayName = 'DropdownHeader';
/* harmony default export */ const esm_DropdownHeader = (DropdownHeader);
;// CONCATENATED MODULE: ./node_modules/@restart/ui/node_modules/@restart/hooks/esm/useGlobalListener.js


/**
 * Attaches an event handler outside directly to the `document`,
 * bypassing the react synthetic event system.
 *
 * ```ts
 * useGlobalListener('keydown', (event) => {
 *  console.log(event.key)
 * })
 * ```
 *
 * @param event The DOM event name
 * @param handler An event handler
 * @param capture Whether or not to listen during the capture event phase
 */
function useGlobalListener(event, handler, capture = false) {
  const documentTarget = useCallback(() => document, []);
  return useEventListener(documentTarget, event, handler, capture);
}
;// CONCATENATED MODULE: ./node_modules/@restart/ui/node_modules/@restart/hooks/esm/useInterval.js



/**
 * Creates a `setInterval` that is properly cleaned up when a component unmounted
 *
 * ```tsx
 *  function Timer() {
 *    const [timer, setTimer] = useState(0)
 *    useInterval(() => setTimer(i => i + 1), 1000)
 *
 *    return <span>{timer} seconds past</span>
 *  }
 * ```
 *
 * @param fn an function run on each interval
 * @param ms The milliseconds duration of the interval
 */

/**
 * Creates a pausable `setInterval` that is properly cleaned up when a component unmounted
 *
 * ```tsx
 *  const [paused, setPaused] = useState(false)
 *  const [timer, setTimer] = useState(0)
 *
 *  useInterval(() => setTimer(i => i + 1), 1000, paused)
 *
 *  return (
 *    <span>
 *      {timer} seconds past
 *
 *      <button onClick={() => setPaused(p => !p)}>{paused ? 'Play' : 'Pause' }</button>
 *    </span>
 * )
 * ```
 *
 * @param fn an function run on each interval
 * @param ms The milliseconds duration of the interval
 * @param paused Whether or not the interval is currently running
 */

/**
 * Creates a pausable `setInterval` that _fires_ immediately and is
 * properly cleaned up when a component unmounted
 *
 * ```tsx
 *  const [timer, setTimer] = useState(-1)
 *  useInterval(() => setTimer(i => i + 1), 1000, false, true)
 *
 *  // will update to 0 on the first effect
 *  return <span>{timer} seconds past</span>
 * ```
 *
 * @param fn an function run on each interval
 * @param ms The milliseconds duration of the interval
 * @param paused Whether or not the interval is currently running
 * @param runImmediately Whether to run the function immediately on mount or unpause
 * rather than waiting for the first interval to elapse
 *

 */

function useInterval(fn, ms, paused = false, runImmediately = false) {
  let handle;
  const fnRef = useCommittedRef(fn);
  // this ref is necessary b/c useEffect will sometimes miss a paused toggle
  // orphaning a setTimeout chain in the aether, so relying on it's refresh logic is not reliable.
  const pausedRef = useCommittedRef(paused);
  const tick = () => {
    if (pausedRef.current) return;
    fnRef.current();
    schedule(); // eslint-disable-line no-use-before-define
  };

  const schedule = () => {
    clearTimeout(handle);
    handle = setTimeout(tick, ms);
  };
  useEffect(() => {
    if (runImmediately) {
      tick();
    } else {
      schedule();
    }
    return () => clearTimeout(handle);
  }, [paused, runImmediately]);
}
/* harmony default export */ const esm_useInterval = ((/* unused pure expression or super */ null && (useInterval)));
;// CONCATENATED MODULE: ./node_modules/@restart/ui/node_modules/@restart/hooks/esm/useRafInterval.js


function useRafInterval(fn, ms, paused = false) {
  let handle;
  let start = new Date().getTime();
  const fnRef = useCommittedRef(fn);
  // this ref is necessary b/c useEffect will sometimes miss a paused toggle
  // orphaning a setTimeout chain in the aether, so relying on it's refresh logic is not reliable.
  const pausedRef = useCommittedRef(paused);
  function loop() {
    const current = new Date().getTime();
    const delta = current - start;
    if (pausedRef.current) return;
    if (delta >= ms && fnRef.current) {
      fnRef.current();
      start = new Date().getTime();
    }
    cancelAnimationFrame(handle);
    handle = requestAnimationFrame(loop);
  }
  useEffect(() => {
    handle = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(handle);
  }, []);
}
/* harmony default export */ const esm_useRafInterval = ((/* unused pure expression or super */ null && (useRafInterval)));
;// CONCATENATED MODULE: ./node_modules/@restart/ui/node_modules/@restart/hooks/esm/useMergeState.js


/**
 * Updates state, partial updates are merged into existing state values
 */

/**
 * Mimics a React class component's state model, of having a single unified
 * `state` object and an updater that merges updates into the existing state, as
 * opposed to replacing it.
 *
 * ```js
 * const [state, setState] = useMergeState({ name: 'Betsy', age: 24 })
 *
 * setState({ name: 'Johan' }) // { name: 'Johan', age: 24 }
 *
 * setState(state => ({ age: state.age + 10 })) // { name: 'Johan', age: 34 }
 * ```
 *
 * @param initialState The initial state object
 */
function useMergeState_useMergeState(initialState) {
  const [state, setState] = useState(initialState);
  const updater = useCallback(update => {
    if (update === null) return;
    if (typeof update === 'function') {
      setState(state => {
        const nextState = update(state);
        return nextState == null ? state : Object.assign({}, state, nextState);
      });
    } else {
      setState(state => Object.assign({}, state, update));
    }
  }, [setState]);
  return [state, updater];
}
;// CONCATENATED MODULE: ./node_modules/@restart/ui/node_modules/@restart/hooks/esm/useMergeStateFromProps.js

function useMergeStateFromProps(props, gDSFP, initialState) {
  const [state, setState] = useMergeState(initialState);
  const nextState = gDSFP(props, state);
  if (nextState !== null) setState(nextState);
  return [state, setState];
}
;// CONCATENATED MODULE: ./node_modules/@restart/ui/node_modules/@restart/hooks/esm/useImage.js

/**
 * Fetch and load an image for programatic use such as in a `<canvas>` element.
 *
 * @param imageOrUrl The `HtmlImageElement` or image url to load
 * @param crossOrigin The `crossorigin` attribute to set
 *
 * ```ts
 * const { image, error } = useImage('/static/kittens.png')
 * const ref = useRef<HTMLCanvasElement>()
 *
 * useEffect(() => {
 *   const ctx = ref.current.getContext('2d')
 *
 *   if (image) {
 *     ctx.drawImage(image, 0, 0)
 *   }
 * }, [ref, image])
 *
 * return (
 *   <>
 *     {error && "there was a problem loading the image"}
 *     <canvas ref={ref} />
 *   </>
 * ```
 */
function useImage(imageOrUrl, crossOrigin) {
  const [state, setState] = useState({
    image: null,
    error: null
  });
  useEffect(() => {
    if (!imageOrUrl) return undefined;
    let image;
    if (typeof imageOrUrl === 'string') {
      image = new Image();
      if (crossOrigin) image.crossOrigin = crossOrigin;
      image.src = imageOrUrl;
    } else {
      image = imageOrUrl;
      if (image.complete && image.naturalHeight > 0) {
        setState({
          image,
          error: null
        });
        return;
      }
    }
    function onLoad() {
      setState({
        image,
        error: null
      });
    }
    function onError(error) {
      setState({
        image,
        error
      });
    }
    image.addEventListener('load', onLoad);
    image.addEventListener('error', onError);
    return () => {
      image.removeEventListener('load', onLoad);
      image.removeEventListener('error', onError);
    };
  }, [imageOrUrl, crossOrigin]);
  return state;
}
;// CONCATENATED MODULE: ./node_modules/@restart/ui/node_modules/@restart/hooks/esm/useIsomorphicEffect.js

const isReactNative = typeof __webpack_require__.g !== 'undefined' &&
// @ts-ignore
__webpack_require__.g.navigator &&
// @ts-ignore
__webpack_require__.g.navigator.product === 'ReactNative';
const isDOM = typeof document !== 'undefined';

/**
 * Is `useLayoutEffect` in a DOM or React Native environment, otherwise resolves to useEffect
 * Only useful to avoid the console warning.
 *
 * PREFER `useEffect` UNLESS YOU KNOW WHAT YOU ARE DOING.
 *
 * @category effects
 */
/* harmony default export */ const useIsomorphicEffect = ((/* unused pure expression or super */ null && (isDOM || isReactNative ? useLayoutEffect : useEffect)));
;// CONCATENATED MODULE: ./node_modules/@restart/ui/node_modules/@restart/hooks/esm/useResizeObserver.js


const targetMap = new WeakMap();
let resizeObserver;
function getResizeObserver() {
  // eslint-disable-next-line no-return-assign
  return resizeObserver = resizeObserver || new window.ResizeObserver(entries => {
    entries.forEach(entry => {
      const handler = targetMap.get(entry.target);
      if (handler) handler(entry.contentRect);
    });
  });
}

/**
 * Efficiently observe size changes on an element. Depends on the `ResizeObserver` api,
 * and polyfills are needed in older browsers.
 *
 * ```ts
 * const [ref, attachRef] = useCallbackRef(null);
 *
 * const rect = useResizeObserver(ref);
 *
 * return (
 *  <div ref={attachRef}>
 *    {JSON.stringify(rect)}
 *  </div>
 * )
 * ```
 *
 * @param element The DOM element to observe
 */
function useResizeObserver(element) {
  const [rect, setRect] = useState(null);
  useEffect(() => {
    if (!element) return;
    getResizeObserver().observe(element);
    setRect(element.getBoundingClientRect());
    targetMap.set(element, rect => {
      setRect(rect);
    });
    return () => {
      targetMap.delete(element);
    };
  }, [element]);
  return rect;
}
;// CONCATENATED MODULE: ./node_modules/@restart/ui/node_modules/@restart/hooks/esm/index.js














;// CONCATENATED MODULE: ./node_modules/@restart/ui/esm/Anchor.js
const Anchor_excluded = ["onKeyDown"];
function Anchor_objectWithoutPropertiesLoose(r, e) { if (null == r) return {}; var t = {}; for (var n in r) if ({}.hasOwnProperty.call(r, n)) { if (e.indexOf(n) >= 0) continue; t[n] = r[n]; } return t; }
/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/anchor-has-content */





function Anchor_isTrivialHref(href) {
  return !href || href.trim() === '#';
}
/**
 * An generic `<a>` component that covers a few A11y cases, ensuring that
 * cases where the `href` is missing or trivial like "#" are treated like buttons.
 */
const Anchor = /*#__PURE__*/react.forwardRef((_ref, ref) => {
  let {
      onKeyDown
    } = _ref,
    props = Anchor_objectWithoutPropertiesLoose(_ref, Anchor_excluded);
  const [buttonProps] = useButtonProps(Object.assign({
    tagName: 'a'
  }, props));
  const handleKeyDown = useEventCallback(e => {
    buttonProps.onKeyDown(e);
    onKeyDown == null ? void 0 : onKeyDown(e);
  });
  if (Anchor_isTrivialHref(props.href) || props.role === 'button') {
    return /*#__PURE__*/(0,jsx_runtime.jsx)("a", Object.assign({
      ref: ref
    }, props, buttonProps, {
      onKeyDown: handleKeyDown
    }));
  }
  return /*#__PURE__*/(0,jsx_runtime.jsx)("a", Object.assign({
    ref: ref
  }, props, {
    onKeyDown: onKeyDown
  }));
});
Anchor.displayName = 'Anchor';
/* harmony default export */ const esm_Anchor = (Anchor);
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/DropdownItem.js
"use client";







const DropdownItem_DropdownItem = /*#__PURE__*/react.forwardRef(({
  bsPrefix,
  className,
  eventKey,
  disabled = false,
  onClick,
  active,
  as: Component = esm_Anchor,
  ...props
}, ref) => {
  const prefix = useBootstrapPrefix(bsPrefix, 'dropdown-item');
  const [dropdownItemProps, meta] = useDropdownItem({
    key: eventKey,
    href: props.href,
    disabled,
    onClick,
    active
  });
  return /*#__PURE__*/(0,jsx_runtime.jsx)(Component, {
    ...props,
    ...dropdownItemProps,
    ref: ref,
    className: classnames_default()(className, prefix, meta.isActive && 'active', disabled && 'disabled')
  });
});
DropdownItem_DropdownItem.displayName = 'DropdownItem';
/* harmony default export */ const react_bootstrap_esm_DropdownItem = (DropdownItem_DropdownItem);
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/DropdownItemText.js
"use client";





const DropdownItemText = /*#__PURE__*/react.forwardRef(({
  className,
  bsPrefix,
  as: Component = 'span',
  ...props
}, ref) => {
  bsPrefix = useBootstrapPrefix(bsPrefix, 'dropdown-item-text');
  return /*#__PURE__*/(0,jsx_runtime.jsx)(Component, {
    ref: ref,
    className: classnames_default()(className, bsPrefix),
    ...props
  });
});
DropdownItemText.displayName = 'DropdownItemText';
/* harmony default export */ const esm_DropdownItemText = (DropdownItemText);
;// CONCATENATED MODULE: ./node_modules/@restart/hooks/esm/useIsomorphicEffect.js

const useIsomorphicEffect_isReactNative = typeof __webpack_require__.g !== 'undefined' &&
// @ts-ignore
__webpack_require__.g.navigator &&
// @ts-ignore
__webpack_require__.g.navigator.product === 'ReactNative';
const useIsomorphicEffect_isDOM = typeof document !== 'undefined';

/**
 * Is `useLayoutEffect` in a DOM or React Native environment, otherwise resolves to useEffect
 * Only useful to avoid the console warning.
 *
 * PREFER `useEffect` UNLESS YOU KNOW WHAT YOU ARE DOING.
 *
 * @category effects
 */
/* harmony default export */ const esm_useIsomorphicEffect = (useIsomorphicEffect_isDOM || useIsomorphicEffect_isReactNative ? react.useLayoutEffect : react.useEffect);
;// CONCATENATED MODULE: ./node_modules/@restart/hooks/esm/useMergedRefs.js

const toFnRef = ref => !ref || typeof ref === 'function' ? ref : value => {
  ref.current = value;
};
function mergeRefs(refA, refB) {
  const a = toFnRef(refA);
  const b = toFnRef(refB);
  return value => {
    if (a) a(value);
    if (b) b(value);
  };
}

/**
 * Create and returns a single callback ref composed from two other Refs.
 *
 * ```tsx
 * const Button = React.forwardRef((props, ref) => {
 *   const [element, attachRef] = useCallbackRef<HTMLButtonElement>();
 *   const mergedRef = useMergedRefs(ref, attachRef);
 *
 *   return <button ref={mergedRef} {...props}/>
 * })
 * ```
 *
 * @param refA A Callback or mutable Ref
 * @param refB A Callback or mutable Ref
 * @category refs
 */
function useMergedRefs(refA, refB) {
  return (0,react.useMemo)(() => mergeRefs(refA, refB), [refA, refB]);
}
/* harmony default export */ const esm_useMergedRefs = (useMergedRefs);
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/InputGroupContext.js
"use client";


const context = /*#__PURE__*/react.createContext(null);
context.displayName = 'InputGroupContext';
/* harmony default export */ const InputGroupContext = (context);
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/NavbarContext.js
"use client";



// TODO: check

const NavbarContext_context = /*#__PURE__*/react.createContext(null);
NavbarContext_context.displayName = 'NavbarContext';
/* harmony default export */ const NavbarContext = (NavbarContext_context);
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/useWrappedRefWithWarning.js



function useWrappedRefWithWarning(ref, componentName) {
  // @ts-ignore
  if (true) return ref;

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const warningRef = (0,react.useCallback)(refValue => {
    !(refValue == null || !refValue.isReactComponent) ?  false ? 0 : browser_default()(false) : void 0;
  }, [componentName]);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return esm_useMergedRefs(warningRef, ref);
}
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/DropdownMenu.js
"use client";















function getDropdownMenuPlacement(alignEnd, dropDirection, isRTL) {
  const topStart = isRTL ? 'top-end' : 'top-start';
  const topEnd = isRTL ? 'top-start' : 'top-end';
  const bottomStart = isRTL ? 'bottom-end' : 'bottom-start';
  const bottomEnd = isRTL ? 'bottom-start' : 'bottom-end';
  const leftStart = isRTL ? 'right-start' : 'left-start';
  const leftEnd = isRTL ? 'right-end' : 'left-end';
  const rightStart = isRTL ? 'left-start' : 'right-start';
  const rightEnd = isRTL ? 'left-end' : 'right-end';
  let placement = alignEnd ? bottomEnd : bottomStart;
  if (dropDirection === 'up') placement = alignEnd ? topEnd : topStart;else if (dropDirection === 'end') placement = alignEnd ? rightEnd : rightStart;else if (dropDirection === 'start') placement = alignEnd ? leftEnd : leftStart;else if (dropDirection === 'down-centered') placement = 'bottom';else if (dropDirection === 'up-centered') placement = 'top';
  return placement;
}
const DropdownMenu_DropdownMenu = /*#__PURE__*/react.forwardRef(({
  bsPrefix,
  className,
  align,
  rootCloseEvent,
  flip = true,
  show: showProps,
  renderOnMount,
  // Need to define the default "as" during prop destructuring to be compatible with styled-components github.com/react-bootstrap/react-bootstrap/issues/3595
  as: Component = 'div',
  popperConfig,
  variant,
  ...props
}, ref) => {
  let alignEnd = false;
  const isNavbar = (0,react.useContext)(NavbarContext);
  const prefix = useBootstrapPrefix(bsPrefix, 'dropdown-menu');
  const {
    align: contextAlign,
    drop,
    isRTL
  } = (0,react.useContext)(react_bootstrap_esm_DropdownContext);
  align = align || contextAlign;
  const isInputGroup = (0,react.useContext)(InputGroupContext);
  const alignClasses = [];
  if (align) {
    if (typeof align === 'object') {
      const keys = Object.keys(align);
       false ? 0 : void 0;
      if (keys.length) {
        const brkPoint = keys[0];
        const direction = align[brkPoint];

        // .dropdown-menu-end is required for responsively aligning
        // left in addition to align left classes.
        alignEnd = direction === 'start';
        alignClasses.push(`${prefix}-${brkPoint}-${direction}`);
      }
    } else if (align === 'end') {
      alignEnd = true;
    }
  }
  const placement = getDropdownMenuPlacement(alignEnd, drop, isRTL);
  const [menuProps, {
    hasShown,
    popper,
    show,
    toggle
  }] = useDropdownMenu({
    flip,
    rootCloseEvent,
    show: showProps,
    usePopper: !isNavbar && alignClasses.length === 0,
    offset: [0, 2],
    popperConfig,
    placement
  });
  menuProps.ref = esm_useMergedRefs(useWrappedRefWithWarning(ref, 'DropdownMenu'), menuProps.ref);
  esm_useIsomorphicEffect(() => {
    // Popper's initial position for the menu is incorrect when
    // renderOnMount=true. Need to call update() to correct it.
    if (show) popper == null || popper.update();
  }, [show]);
  if (!hasShown && !renderOnMount && !isInputGroup) return null;

  // For custom components provide additional, non-DOM, props;
  if (typeof Component !== 'string') {
    menuProps.show = show;
    menuProps.close = () => toggle == null ? void 0 : toggle(false);
    menuProps.align = align;
  }
  let style = props.style;
  if (popper != null && popper.placement) {
    // we don't need the default popper style,
    // menus are display: none when not shown.
    style = {
      ...props.style,
      ...menuProps.style
    };
    props['x-placement'] = popper.placement;
  }
  return /*#__PURE__*/(0,jsx_runtime.jsx)(Component, {
    ...props,
    ...menuProps,
    style: style
    // Bootstrap css requires this data attrib to style responsive menus.
    ,
    ...((alignClasses.length || isNavbar) && {
      'data-bs-popper': 'static'
    }),
    className: classnames_default()(className, prefix, show && 'show', alignEnd && `${prefix}-end`, variant && `${prefix}-${variant}`, ...alignClasses)
  });
});
DropdownMenu_DropdownMenu.displayName = 'DropdownMenu';
/* harmony default export */ const react_bootstrap_esm_DropdownMenu = (DropdownMenu_DropdownMenu);
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/Button.js
"use client";






const Button_Button = /*#__PURE__*/react.forwardRef(({
  as,
  bsPrefix,
  variant = 'primary',
  size,
  active = false,
  disabled = false,
  className,
  ...props
}, ref) => {
  const prefix = useBootstrapPrefix(bsPrefix, 'btn');
  const [buttonProps, {
    tagName
  }] = useButtonProps({
    tagName: as,
    disabled,
    ...props
  });
  const Component = tagName;
  return /*#__PURE__*/(0,jsx_runtime.jsx)(Component, {
    ...buttonProps,
    ...props,
    ref: ref,
    disabled: disabled,
    className: classnames_default()(className, prefix, active && 'active', variant && `${prefix}-${variant}`, size && `${prefix}-${size}`, props.href && disabled && 'disabled')
  });
});
Button_Button.displayName = 'Button';
/* harmony default export */ const react_bootstrap_esm_Button = (Button_Button);
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/DropdownToggle.js
"use client";











const DropdownToggle_DropdownToggle = /*#__PURE__*/react.forwardRef(({
  bsPrefix,
  split,
  className,
  childBsPrefix,
  // Need to define the default "as" during prop destructuring to be compatible with styled-components github.com/react-bootstrap/react-bootstrap/issues/3595
  as: Component = react_bootstrap_esm_Button,
  ...props
}, ref) => {
  const prefix = useBootstrapPrefix(bsPrefix, 'dropdown-toggle');
  const dropdownContext = (0,react.useContext)(esm_DropdownContext);
  if (childBsPrefix !== undefined) {
    props.bsPrefix = childBsPrefix;
  }
  const [toggleProps] = useDropdownToggle();
  toggleProps.ref = esm_useMergedRefs(toggleProps.ref, useWrappedRefWithWarning(ref, 'DropdownToggle'));

  // This intentionally forwards size and variant (if set) to the
  // underlying component, to allow it to render size and style variants.
  return /*#__PURE__*/(0,jsx_runtime.jsx)(Component, {
    className: classnames_default()(className, prefix, split && `${prefix}-split`, (dropdownContext == null ? void 0 : dropdownContext.show) && 'show'),
    ...toggleProps,
    ...props
  });
});
DropdownToggle_DropdownToggle.displayName = 'DropdownToggle';
/* harmony default export */ const react_bootstrap_esm_DropdownToggle = (DropdownToggle_DropdownToggle);
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/Dropdown.js
"use client";


















const Dropdown_Dropdown = /*#__PURE__*/react.forwardRef((pProps, ref) => {
  const {
    bsPrefix,
    drop = 'down',
    show,
    className,
    align = 'start',
    onSelect,
    onToggle,
    focusFirstItemOnShow,
    // Need to define the default "as" during prop destructuring to be compatible with styled-components github.com/react-bootstrap/react-bootstrap/issues/3595
    as: Component = 'div',
    navbar: _4,
    autoClose = true,
    ...props
  } = hook_useUncontrolled(pProps, {
    show: 'onToggle'
  });
  const isInputGroup = (0,react.useContext)(InputGroupContext);
  const prefix = useBootstrapPrefix(bsPrefix, 'dropdown');
  const isRTL = useIsRTL();
  const isClosingPermitted = source => {
    // autoClose=false only permits close on button click
    if (autoClose === false) return source === 'click';

    // autoClose=inside doesn't permit close on rootClose
    if (autoClose === 'inside') return source !== 'rootClose';

    // autoClose=outside doesn't permit close on select
    if (autoClose === 'outside') return source !== 'select';
    return true;
  };
  const handleToggle = useEventCallback_useEventCallback((nextShow, meta) => {
    var _meta$originalEvent;
    /** Checking if target of event is ToggleButton,
     * if it is then nullify mousedown event
     */
    const isToggleButton = (_meta$originalEvent = meta.originalEvent) == null || (_meta$originalEvent = _meta$originalEvent.target) == null ? void 0 : _meta$originalEvent.classList.contains('dropdown-toggle');
    if (isToggleButton && meta.source === 'mousedown') {
      return;
    }
    if (meta.originalEvent.currentTarget === document && (meta.source !== 'keydown' || meta.originalEvent.key === 'Escape')) meta.source = 'rootClose';
    if (isClosingPermitted(meta.source)) onToggle == null || onToggle(nextShow, meta);
  });
  const alignEnd = align === 'end';
  const placement = getDropdownMenuPlacement(alignEnd, drop, isRTL);
  const contextValue = (0,react.useMemo)(() => ({
    align,
    drop,
    isRTL
  }), [align, drop, isRTL]);
  const directionClasses = {
    down: prefix,
    'down-centered': `${prefix}-center`,
    up: 'dropup',
    'up-centered': 'dropup-center dropup',
    end: 'dropend',
    start: 'dropstart'
  };
  return /*#__PURE__*/(0,jsx_runtime.jsx)(react_bootstrap_esm_DropdownContext.Provider, {
    value: contextValue,
    children: /*#__PURE__*/(0,jsx_runtime.jsx)(esm_Dropdown, {
      placement: placement,
      show: show,
      onSelect: onSelect,
      onToggle: handleToggle,
      focusFirstItemOnShow: focusFirstItemOnShow,
      itemSelector: `.${prefix}-item:not(.disabled):not(:disabled)`,
      children: isInputGroup ? props.children : /*#__PURE__*/(0,jsx_runtime.jsx)(Component, {
        ...props,
        ref: ref,
        className: classnames_default()(className, show && 'show', directionClasses[drop])
      })
    })
  });
});
Dropdown_Dropdown.displayName = 'Dropdown';
/* harmony default export */ const react_bootstrap_esm_Dropdown = (Object.assign(Dropdown_Dropdown, {
  Toggle: react_bootstrap_esm_DropdownToggle,
  Menu: react_bootstrap_esm_DropdownMenu,
  Item: react_bootstrap_esm_DropdownItem,
  ItemText: esm_DropdownItemText,
  Divider: esm_DropdownDivider,
  Header: esm_DropdownHeader
}));
;// CONCATENATED MODULE: ./app/js/CorralTab.tsx










function keywordFilter(keyword) {
    return function (tab) {
        const test = new RegExp(keyword, "i");
        return (tab.title != null && test.exec(tab.title)) || (tab.url != null && test.exec(tab.url));
    };
}
const AlphaSorter = {
    key: "alpha",
    label: () => chrome.i18n.getMessage("corral_sortPageTitle") || "",
    shortLabel: () => chrome.i18n.getMessage("corral_sortPageTitle_short") || "",
    sort(tabA, tabB) {
        if (tabA == null || tabB == null || tabA.title == null || tabB.title == null) {
            return 0;
        }
        else {
            return tabA.title.localeCompare(tabB.title);
        }
    },
};
const ReverseAlphaSorter = {
    key: "reverseAlpha",
    label: () => chrome.i18n.getMessage("corral_sortPageTitle_descending") || "",
    shortLabel: () => chrome.i18n.getMessage("corral_sortPageTitle_descending_short") || "",
    sort(tabA, tabB) {
        return -1 * AlphaSorter.sort(tabA, tabB);
    },
};
const ChronoSorter = {
    key: "chrono",
    label: () => chrome.i18n.getMessage("corral_sortTimeClosed") || "",
    shortLabel: () => chrome.i18n.getMessage("corral_sortTimeClosed_short") || "",
    sort(tabA, tabB) {
        if (tabA == null || tabB == null) {
            return 0;
        }
        else {
            // @ts-expect-error `closedAt` is a TW expando property on tabs
            return tabA.closedAt - tabB.closedAt;
        }
    },
};
const ReverseChronoSorter = {
    key: "reverseChrono",
    label: () => chrome.i18n.getMessage("corral_sortTimeClosed_descending") || "",
    shortLabel: () => chrome.i18n.getMessage("corral_sortTimeClosed_descending_short") || "",
    sort(tabA, tabB) {
        return -1 * ChronoSorter.sort(tabA, tabB);
    },
};
const DomainSorter = {
    key: "domain",
    label: () => chrome.i18n.getMessage("corral_sortDomain") || "",
    shortLabel: () => chrome.i18n.getMessage("corral_sortDomain_short") || "",
    sort(tabA, tabB) {
        if (tabA == null || tabB == null || tabA.url == null || tabB.url == null) {
            return 0;
        }
        else {
            const tabAUrl = tabA.url;
            const tabBUrl = tabB.url;
            const tabAHostname = extractHostname(tabAUrl);
            const tabBHostname = extractHostname(tabBUrl);
            const tabARootDomain = extractRootDomain(tabAUrl);
            const tabBRootDomain = extractRootDomain(tabBUrl);
            // Sort by root domain, then by hostname (like the subdomain), and then by closing time. This
            // gives a predictable sorting order at each level of sort.
            return (tabARootDomain.localeCompare(tabBRootDomain) ||
                tabAHostname.localeCompare(tabBHostname) ||
                ReverseChronoSorter.sort(tabA, tabB));
        }
    },
};
const ReverseDomainSorter = {
    key: "reverseDomain",
    label: () => chrome.i18n.getMessage("corral_sortDomain_descending") || "",
    shortLabel: () => chrome.i18n.getMessage("corral_sortDomain_descending_short") || "",
    sort(tabA, tabB) {
        return -1 * DomainSorter.sort(tabA, tabB);
    },
};
const DEFAULT_SORTER = ReverseChronoSorter;
const Sorters = [
    DomainSorter,
    ReverseDomainSorter,
    AlphaSorter,
    ReverseAlphaSorter,
    ChronoSorter,
    ReverseChronoSorter,
];
function sessionFuzzyMatchesTab(session, tab) {
    // Sessions' `lastModified` is only accurate to the second in Chrome whereas `closedAt` is
    // accurate to the millisecond. Convert to ms if needed.
    const lastModifiedMs = session.lastModified < 10000000000 ? session.lastModified * 1000 : session.lastModified;
    return (session.tab != null &&
        // Tabs with no favIcons have the value `undefined`, but once converted into a session the tab
        // has an empty string (`''`) as its favIcon value. Account for that case for "equality".
        (session.tab.favIconUrl === tab.favIconUrl ||
            (session.tab.favIconUrl === "" && tab.favIconUrl == null)) &&
        session.tab.title === tab.title &&
        session.tab.url === tab.url &&
        // Ensure the browser's last modified time is within 1s of Tab Wrangler's close to as a fuzzy,
        // but likely always correct, match.
        // @ts-expect-error `closedAt` is a TW expando property on tabs
        Math.abs(lastModifiedMs - tab.closedAt) < 1000);
}
function rowRenderer({ key, rowData, style, }) {
    return (react.createElement(ClosedTabRow, { isSelected: rowData.isSelected, key: key, onOpenTab: rowData.onOpenTab, onRemoveTab: rowData.onRemoveTab, onToggleTab: rowData.onToggleTab, session: rowData.session, style: style, tab: rowData.tab }));
}
function CorralTab() {
    // Focus the search input so it's simple to type immediately. This must be done after the popup
    // is available, which is roughly 150ms after the popup is opened (determined empirically). Use
    // 350ms to ensure this always works.
    const searchRef = react.useRef(null);
    react.useEffect(() => {
        const searchRefFocusTimeout = setTimeout(() => {
            if (searchRef.current != null)
                searchRef.current.focus();
        }, 350);
        return () => {
            clearTimeout(searchRefFocusTimeout);
        };
    }, []);
    const [filter, setFilter] = react.useState("");
    const [savedSortOrder, setSavedSortOrder] = react.useState(js_settings.get("corralTabSortOrder"));
    const [currSorter, setCurrSorter] = react.useState(() => {
        const savedSortOrder = js_settings.get("corralTabSortOrder");
        let nextSorter = savedSortOrder == null ? DEFAULT_SORTER : Sorters.find((s) => s.key === savedSortOrder);
        // If settings somehow stores a bad value, always fall back to default order.
        if (nextSorter == null)
            nextSorter = DEFAULT_SORTER;
        return nextSorter;
    });
    const queryClient = useQueryClient();
    const { data: sessions } = useQuery({
        queryFn: () => chrome.sessions.getRecentlyClosed(),
        queryKey: ["sessionsQuery"],
    });
    react.useEffect(() => {
        function handleChanged() {
            queryClient.invalidateQueries({ queryKey: ["sessionsQuery"] });
        }
        chrome.sessions.onChanged.addListener(handleChanged);
        return () => {
            chrome.sessions.onChanged.removeListener(handleChanged);
        };
    }, [queryClient]);
    const { data: localStorageData } = useStorageLocalPersistQuery();
    const lastSelectedTabRef = react.useRef(null);
    const [selectedTabs, setSelectedTabs] = react.useState(new Set());
    const closedTabs = react.useMemo(() => {
        if (localStorageData == null || !("savedTabs" in localStorageData))
            return [];
        return localStorageData.savedTabs.filter(keywordFilter(filter)).sort(currSorter.sort);
    }, [currSorter.sort, filter, localStorageData]);
    const areAllClosedTabsSelected = closedTabs.length > 0 && closedTabs.every((tab) => selectedTabs.has(serializeTab(tab)));
    const hasVisibleSelectedTabs = closedTabs.some((tab) => selectedTabs.has(serializeTab(tab)));
    const percentClosed = localStorageData == null ||
        !("totalTabsRemoved" in localStorageData) ||
        !("totalTabsWrangled" in localStorageData) ||
        localStorageData.totalTabsRemoved === 0
        ? 0
        : Math.trunc((localStorageData.totalTabsWrangled / localStorageData.totalTabsRemoved) * 100);
    react.useEffect(() => {
        function handleKeypress(event) {
            if (event.key !== "/")
                return;
            // Focus and prevent default only if the input is not already active. This way the intial act of
            // focusing does not print a '/' character, but if the input is already active then '/' can be
            // typed.
            if (searchRef.current != null && document.activeElement !== searchRef.current) {
                searchRef.current.focus();
                event.preventDefault();
            }
        }
        window.addEventListener("keypress", handleKeypress);
        return () => {
            window.removeEventListener("keypress", handleKeypress);
        };
    }, []);
    function handleChangeSaveSortOrder(event) {
        if (event.target.checked) {
            js_settings.set("corralTabSortOrder", currSorter.key);
            setSavedSortOrder(currSorter.key);
        }
        else {
            js_settings.set("corralTabSortOrder", null);
            setSavedSortOrder(null);
        }
    }
    async function handleRemoveSelectedTabs() {
        await removeSavedTabs(closedTabs.filter((tab) => selectedTabs.has(serializeTab(tab))));
        setSelectedTabs(new Set());
    }
    async function handleOpenTab(tab, session) {
        await unwrangleTabs([{ session, tab }]);
        const nextSelectedTabs = new Set(selectedTabs);
        nextSelectedTabs.delete(serializeTab(tab));
        setSelectedTabs(nextSelectedTabs);
    }
    async function handleOpenSelectedTabs() {
        await unwrangleTabs(closedTabs
            .filter((tab) => selectedTabs.has(serializeTab(tab)))
            .map((tab) => ({
            session: sessions === null || sessions === void 0 ? void 0 : sessions.find((session) => sessionFuzzyMatchesTab(session, tab)),
            tab,
        })));
        setSelectedTabs(new Set());
    }
    async function handleRemoveTab(tab) {
        await removeSavedTabs([tab]);
        const nextSelectedTabs = new Set(selectedTabs);
        nextSelectedTabs.delete(serializeTab(tab));
        setSelectedTabs(nextSelectedTabs);
    }
    function handleToggleTab(tab, isSelected, multiselect) {
        // If this is a multiselect (done by holding the Shift key and clicking), see if the last
        // selected tab is still visible and, if it is, toggle all tabs between it and this new clicked
        // tab.
        const nextSelectedTabs = new Set(selectedTabs);
        if (multiselect && lastSelectedTabRef.current != null) {
            const lastSelectedTabIndex = closedTabs.indexOf(lastSelectedTabRef.current);
            if (lastSelectedTabIndex >= 0) {
                const tabIndex = closedTabs.indexOf(tab);
                for (let i = Math.min(lastSelectedTabIndex, tabIndex); i <= Math.max(lastSelectedTabIndex, tabIndex); i++) {
                    if (isSelected) {
                        nextSelectedTabs.add(serializeTab(closedTabs[i]));
                    }
                    else {
                        nextSelectedTabs.delete(serializeTab(closedTabs[i]));
                    }
                }
            }
        }
        else {
            if (isSelected) {
                nextSelectedTabs.add(serializeTab(tab));
            }
            else {
                nextSelectedTabs.delete(serializeTab(tab));
            }
        }
        lastSelectedTabRef.current = tab;
        setSelectedTabs(nextSelectedTabs);
    }
    function toggleAllTabs() {
        let nextSelectedTabs;
        if (areAllClosedTabsSelected) {
            nextSelectedTabs = new Set(selectedTabs);
            closedTabs.forEach((tab) => {
                nextSelectedTabs.delete(serializeTab(tab));
            });
        }
        else {
            nextSelectedTabs = new Set(closedTabs.map(serializeTab));
        }
        lastSelectedTabRef.current = null;
        setSelectedTabs(nextSelectedTabs);
    }
    function renderNoRows() {
        return (react.createElement("div", { "aria-label": "row", className: "ReactVirtualized__Table__row", role: "row" },
            react.createElement("div", { className: "ReactVirtualized__Table__rowColumn text-center", style: { flex: 1, padding: "8px" } }, localStorageData == null ||
                !("savedTabs" in localStorageData) ||
                localStorageData.savedTabs.length === 0
                ? chrome.i18n.getMessage("corral_emptyList")
                : chrome.i18n.getMessage("corral_noTabsMatch"))));
    }
    return (react.createElement("div", { className: "tab-pane active" },
        react.createElement("div", { className: "row align-items-center mb-1" },
            react.createElement("form", { className: "form-search col" },
                react.createElement("div", { className: "form-group mb-0" },
                    react.createElement("input", { className: "form-control", name: "search", onChange: (event) => {
                            setFilter(event.target.value);
                        }, placeholder: chrome.i18n.getMessage("corral_searchTabs"), ref: (nextSearchRef) => {
                            searchRef.current = nextSearchRef;
                        }, type: "search", value: filter }))),
            react.createElement("div", { className: "col text-end" }, chrome.i18n.getMessage("corral_tabsWrangledFull", [
                String(localStorageData == null || !("totalTabsWrangled" in localStorageData)
                    ? 0
                    : localStorageData.totalTabsWrangled),
                String(percentClosed),
            ]))),
        react.createElement("div", { className: "corral-tab--control-bar py-2 border-bottom" },
            react.createElement("div", null,
                react.createElement("button", { className: "btn btn-secondary btn-sm", disabled: closedTabs.length === 0, onClick: toggleAllTabs, title: areAllClosedTabsSelected
                        ? chrome.i18n.getMessage("corral_toggleAllTabs_deselectAll")
                        : chrome.i18n.getMessage("corral_toggleAllTabs_selectAll") },
                    react.createElement("input", { checked: areAllClosedTabsSelected, readOnly: true, style: { margin: 0 }, type: "checkbox" })),
                hasVisibleSelectedTabs ? (react.createElement(react.Fragment, null,
                    react.createElement("button", { className: "btn btn-secondary btn-sm ms-1 px-3", onClick: handleOpenSelectedTabs, title: chrome.i18n.getMessage("corral_restoreSelectedTabs"), type: "button" },
                        react.createElement("span", { className: "sr-only" }, chrome.i18n.getMessage("corral_removeSelectedTabs")),
                        react.createElement("i", { className: "fas fa-external-link-alt" })),
                    react.createElement("button", { className: "btn btn-secondary btn-sm ms-1 px-3", onClick: handleRemoveSelectedTabs, title: chrome.i18n.getMessage("corral_removeSelectedTabs"), type: "button" },
                        react.createElement("span", { className: "sr-only" }, chrome.i18n.getMessage("corral_removeSelectedTabs")),
                        react.createElement("i", { className: "fas fa-trash-alt" })))) : null),
            react.createElement("div", { className: "d-flex" },
                filter.length > 0 ? (react.createElement("span", { className: "badge badge-pill badge-primary d-flex align-items-center px-2 me-1" },
                    chrome.i18n.getMessage("corral_searchResults_label", `${closedTabs.length}`),
                    react.createElement("button", { className: "close close-xs ms-1", onClick: () => {
                            setFilter("");
                        }, style: { marginTop: "-2px" }, title: chrome.i18n.getMessage("corral_searchResults_clear") }, "\u00D7"))) : null,
                react.createElement(react_bootstrap_esm_Dropdown, null,
                    react.createElement(react_bootstrap_esm_Dropdown.Toggle, { size: "sm", title: chrome.i18n.getMessage("corral_currentSort", currSorter.label()), variant: "secondary" },
                        chrome.i18n.getMessage("corral_sortBy"),
                        " ",
                        currSorter.shortLabel()),
                    react.createElement(react_bootstrap_esm_Dropdown.Menu, null,
                        Sorters.map((sorter) => (react.createElement(react_bootstrap_esm_Dropdown.Item, { active: currSorter === sorter, as: "button", key: sorter.label(), onClick: () => {
                                if (sorter !== currSorter) {
                                    // When the saved sort order is not null then the user wants to preserve it.
                                    // Update to the new sort order and persist it.
                                    if (js_settings.get("corralTabSortOrder") != null) {
                                        js_settings.set("corralTabSortOrder", sorter.key);
                                    }
                                    setCurrSorter(sorter);
                                }
                            } }, sorter.label()))),
                        react.createElement(react_bootstrap_esm_Dropdown.Divider, null),
                        react.createElement(react_bootstrap_esm_Dropdown.ItemText, null,
                            react.createElement("div", { className: "form-group mb-0" },
                                react.createElement("div", { className: "form-check" },
                                    react.createElement("input", { checked: savedSortOrder != null, className: "form-check-input", id: "corral-tab--save-sort-order", onChange: handleChangeSaveSortOrder, type: "checkbox" }),
                                    react.createElement("label", { className: "form-check-label", htmlFor: "corral-tab--save-sort-order" }, chrome.i18n.getMessage("options_option_saveSortOrder"))))))))),
        react.createElement(WindowScroller_WindowScroller, null, ({ height, isScrolling, onChildScroll, scrollTop }) => (react.createElement(Table_Table, { autoHeight: true, className: "table table-hover", headerHeight: 0, height: height, isScrolling: isScrolling, noRowsRenderer: renderNoRows, onScroll: onChildScroll, rowCount: closedTabs.length, rowGetter: ({ index }) => {
                const tab = closedTabs[index];
                return {
                    isSelected: selectedTabs.has(serializeTab(tab)),
                    onOpenTab: handleOpenTab,
                    onRemoveTab: handleRemoveTab,
                    onToggleTab: handleToggleTab,
                    // The Chrome extension API claims [`getRecentlyClosed`][0] always returns an
                    // Array<chrome.sessions.Session>, but in at least one case a user is getting an
                    // exception where `this.props.sessions` is null. Because it's safe to continue
                    // without Sessions, do a null check and continue on unless a more thorough solution
                    // is eventually found.
                    //
                    // See https://github.com/tabwrangler/tabwrangler/issues/275
                    session: sessions === null || sessions === void 0 ? void 0 : sessions.find((session) => sessionFuzzyMatchesTab(session, tab)),
                    tab,
                };
            }, rowHeight: 38, rowRenderer: rowRenderer, scrollTop: scrollTop, tabIndex: null, width: 670 })))));
}
// [0]: https://developer.chrome.com/extensions/sessions#method-getRecentlyClosed

;// CONCATENATED MODULE: ./app/js/OpenTabRow.tsx






function zeropad(num) {
    return num < 10 ? `0${num}` : String(num);
}
function secondsToHms(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const s = Math.floor((seconds % 3600) % 60);
    const hDisplay = hours > 0 ? `${zeropad(hours)}:` : "";
    return `${hDisplay}${zeropad(minutes)}:${zeropad(s)}`;
}
function OpenTabRow({ isLast, isLocked, onToggleTab, tab, tabTime = Date.now(), windowId, }) {
    var _a;
    const { data: syncPersistData } = useStorageSyncPersistQuery();
    const now = react.useContext(UseNowContext);
    const paused = syncPersistData === null || syncPersistData === void 0 ? void 0 : syncPersistData.paused;
    const tabWhitelistMatch = js_settings.getWhitelistMatch(tab.url);
    let lockStatusElement;
    if (isLocked) {
        let reason;
        if (tab.pinned) {
            reason = chrome.i18n.getMessage("tabLock_lockedReason_pinned");
        }
        else if (js_settings.get("filterAudio") && tab.audible) {
            reason = react.createElement("abbr", { title: chrome.i18n.getMessage("tabLock_lockedReason_audible") }, "Locked");
        }
        else if (js_settings.get("filterGroupedTabs") && "groupId" in tab && tab.groupId > 0) {
            reason = chrome.i18n.getMessage("tabLock_lockedReason_group");
        }
        else if (tabWhitelistMatch) {
            reason = (react.createElement("abbr", { title: chrome.i18n.getMessage("tabLock_lockedReason_matches", tabWhitelistMatch) }, "Auto-Locked"));
        }
        else {
            reason = chrome.i18n.getMessage("tabLock_lockedReason_locked");
        }
        lockStatusElement = (react.createElement("td", { className: classnames_default()("text-center muted", { "border-0": isLast }), style: { verticalAlign: "middle" } }, reason));
    }
    else {
        let timeLeftContent;
        if (paused) {
            timeLeftContent = chrome.i18n.getMessage("tabLock_lockedReason_paused");
        }
        else {
            const cutOff = now - js_settings.get("stayOpen");
            const timeLeft = -1 * Math.round((cutOff - tabTime) / 1000);
            // If `timeLeft` is less than 0, the countdown likely continued and is waiting for the
            // interval to clean up this tab. It's also possible the number of tabs is not below
            // `minTabs`, which has stopped the countdown and locked this at a negative `timeLeft` until
            // another tab is opened to jump start the countdown again.
            timeLeftContent = timeLeft < 0 ? "…" : react.createElement("time", null, secondsToHms(timeLeft));
        }
        lockStatusElement = (react.createElement("td", { className: classnames_default()("text-center", { "border-0": isLast }), style: { verticalAlign: "middle" } }, timeLeftContent));
    }
    return (react.createElement("tr", { className: classnames_default()({ "table-warning": isLocked }) },
        react.createElement("td", { className: classnames_default()("text-center", { "border-0": isLast }), style: { verticalAlign: "middle", width: "1px" } },
            react.createElement("input", { checked: isLocked, className: "mx-1", disabled: !js_settings.isTabManuallyLockable(tab), onClick: (event) => {
                    if (!(event.target instanceof HTMLInputElement))
                        return;
                    onToggleTab(windowId, tab, event.target.checked, event.shiftKey);
                }, type: "checkbox", readOnly: true })),
        react.createElement("td", { className: classnames_default()("text-center", { "border-0": isLast }), style: { verticalAlign: "middle", width: "32px" } },
            react.createElement(LazyImage, { alt: "", height: 16, src: (_a = tab.favIconUrl) !== null && _a !== void 0 ? _a : "", style: { height: "16px", maxWidth: "none" }, width: 16 })),
        react.createElement("td", { className: classnames_default()({ "border-0": isLast }), style: { paddingBottom: "4px", paddingTop: "4px", width: "75%" } },
            react.createElement("div", { className: "d-flex", style: { lineHeight: "1.3" } },
                react.createElement("div", { className: "flex-fill text-truncate", style: { width: "1px" } },
                    tab.title,
                    react.createElement("br", null),
                    react.createElement("small", { className: classnames_default()({ "text-muted": !isLocked }) },
                        "(",
                        tab.url,
                        ")")))),
        lockStatusElement));
}

;// CONCATENATED MODULE: ./app/js/LockTab.tsx









const LockTab_AlphaSorter = {
    key: "alpha",
    label: () => chrome.i18n.getMessage("corral_sortPageTitle") || "",
    shortLabel: () => chrome.i18n.getMessage("corral_sortPageTitle_short") || "",
    sort(tabA, tabB) {
        if (tabA == null || tabB == null || tabA.title == null || tabB.title == null) {
            return 0;
        }
        else {
            return tabA.title.localeCompare(tabB.title);
        }
    },
};
const LockTab_ReverseAlphaSorter = {
    key: "reverseAlpha",
    label: () => chrome.i18n.getMessage("corral_sortPageTitle_descending") || "",
    shortLabel: () => chrome.i18n.getMessage("corral_sortPageTitle_descending_short") || "",
    sort(tabA, tabB) {
        return -1 * LockTab_AlphaSorter.sort(tabA, tabB, {});
    },
};
const LockTab_ChronoSorter = {
    key: "chrono",
    label: () => chrome.i18n.getMessage("tabLock_sort_timeUntilClose") || "",
    shortLabel: () => chrome.i18n.getMessage("tabLock_sort_timeUntilClose_short") || "",
    sort(tabA, tabB, tabTimes) {
        if (tabA == null || tabB == null) {
            return 0;
        }
        else if (js_settings.isTabLocked(tabA) && !js_settings.isTabLocked(tabB)) {
            return 1;
        }
        else if (!js_settings.isTabLocked(tabA) && js_settings.isTabLocked(tabB)) {
            return -1;
        }
        else {
            const lastModifiedA = tabA.id == null ? -1 : tabTimes[tabA.id];
            const lastModifiedB = tabB.id == null ? -1 : tabTimes[tabB.id];
            return lastModifiedA - lastModifiedB;
        }
    },
};
const LockTab_ReverseChronoSorter = {
    key: "reverseChrono",
    label: () => chrome.i18n.getMessage("tabLock_sort_timeUntilClose_desc") || "",
    shortLabel: () => chrome.i18n.getMessage("tabLock_sort_timeUntilClose_desc_short") || "",
    sort(tabA, tabB, tabTimes) {
        return -1 * LockTab_ChronoSorter.sort(tabA, tabB, tabTimes);
    },
};
const TabOrderSorter = {
    key: "tabOrder",
    label: () => chrome.i18n.getMessage("tabLock_sort_tabOrder") || "",
    shortLabel: () => chrome.i18n.getMessage("tabLock_sort_tabOrder_short") || "",
    sort(tabA, tabB) {
        if (tabA == null || tabB == null) {
            return 0;
        }
        else if (tabA.windowId === tabB.windowId) {
            return tabA.index - tabB.index;
        }
        else {
            return tabA.windowId - tabB.windowId;
        }
    },
};
const ReverseTabOrderSorter = {
    key: "reverseTabOrder",
    label: () => chrome.i18n.getMessage("tabLock_sort_tabOrder_desc") || "",
    shortLabel: () => chrome.i18n.getMessage("tabLock_sort_tabOrder_desc_short") || "",
    sort(tabA, tabB, tabTimes) {
        return -1 * TabOrderSorter.sort(tabA, tabB, tabTimes);
    },
};
const LockTab_DEFAULT_SORTER = TabOrderSorter;
const LockTab_Sorters = [
    TabOrderSorter,
    ReverseTabOrderSorter,
    LockTab_AlphaSorter,
    LockTab_ReverseAlphaSorter,
    LockTab_ChronoSorter,
    LockTab_ReverseChronoSorter,
];
const UseNowContext = react.createContext(new Date().getTime());
function useNow() {
    const [now, setNow] = react.useState(new Date().getTime());
    const intervalRef = react.useRef();
    react.useEffect(() => {
        intervalRef.current = window.setInterval(() => {
            setNow(new Date().getTime());
        }, 1000);
        return () => {
            window.clearInterval(intervalRef.current);
            intervalRef.current = undefined;
        };
    }, []);
    return now;
}
function useTabsQuery() {
    const queryClient = useQueryClient();
    const query = useQuery({
        queryFn: () => chrome.tabs.query({}),
        queryKey: ["tabsQuery"],
    });
    react.useEffect(() => {
        function invalidateTabsQuery() {
            queryClient.invalidateQueries({ queryKey: ["tabsQuery"] });
        }
        chrome.tabs.onCreated.addListener(invalidateTabsQuery);
        chrome.tabs.onRemoved.addListener(invalidateTabsQuery);
        return () => {
            chrome.tabs.onCreated.removeListener(invalidateTabsQuery);
            chrome.tabs.onRemoved.removeListener(invalidateTabsQuery);
        };
    }, [queryClient]);
    return query;
}
function useTabTimesQuery() {
    var _a;
    const queryClient = useQueryClient();
    const query = useQuery({
        queryFn: () => chrome.storage.local.get({ tabTimes: {} }),
        queryKey: ["tabTimesQuery"],
    });
    react.useEffect(() => {
        function invalidateTabTimesQuery(changes, areaName) {
            if (areaName === "local" && "tabTimes" in changes)
                queryClient.invalidateQueries({ queryKey: ["tabTimesQuery"] });
        }
        chrome.storage.onChanged.addListener(invalidateTabTimesQuery);
        return () => {
            chrome.storage.onChanged.removeListener(invalidateTabTimesQuery);
        };
    }, [queryClient]);
    return Object.assign(Object.assign({}, query), { data: (_a = query.data) === null || _a === void 0 ? void 0 : _a.tabTimes });
}
function LockTab() {
    var _a;
    const lastSelectedTabRef = react.useRef(null);
    const now = useNow();
    const [sortOrder, setSortOrder] = react.useState(js_settings.get("lockTabSortOrder"));
    const [currWindow, setCurrWindow] = react.useState();
    react.useEffect(() => {
        async function getCurrentWindow() {
            const win = await chrome.windows.getCurrent({});
            setCurrWindow(win);
        }
        getCurrentWindow();
    }, []);
    const [currSorter, setCurrSorter] = react.useState(() => {
        let sorter = sortOrder == null ? LockTab_DEFAULT_SORTER : LockTab_Sorters.find((s) => s.key === sortOrder);
        // If settings somehow stores a bad value, always fall back to default order.
        if (sorter == null)
            sorter = LockTab_DEFAULT_SORTER;
        return sorter;
    });
    const tabsQuery = useTabsQuery();
    const tabTimesQuery = useTabTimesQuery();
    const tabsByWindowId = react.useMemo(() => {
        const tabs = tabsQuery.data == null || tabTimesQuery.data == null
            ? []
            : tabsQuery.data
                .slice()
                .sort((tabA, tabB) => currSorter.sort(tabA, tabB, tabTimesQuery.data));
        const map = new Map();
        tabs.forEach((tab) => {
            var _a;
            if (!map.has(tab.windowId))
                map.set(tab.windowId, []);
            (_a = map.get(tab.windowId)) === null || _a === void 0 ? void 0 : _a.push(tab);
        });
        const entries = Array.from(map.entries());
        return entries.sort(([a], [b]) => {
            if (a === (currWindow === null || currWindow === void 0 ? void 0 : currWindow.id))
                return -1;
            if (b === (currWindow === null || currWindow === void 0 ? void 0 : currWindow.id))
                return 1;
            return 0;
        });
    }, [currSorter, currWindow === null || currWindow === void 0 ? void 0 : currWindow.id, tabTimesQuery.data, tabsQuery.data]);
    const { data: syncData } = useStorageSyncQuery();
    const lockedTabIds = syncData == null
        ? new Set()
        : new Set((_a = tabsQuery.data) === null || _a === void 0 ? void 0 : _a.filter((tab) => isTabLocked(tab, {
            filterAudio: syncData["filterAudio"],
            filterGroupedTabs: syncData["filterGroupedTabs"],
            lockedIds: syncData["lockedIds"],
            whitelist: syncData["whitelist"],
        })).map((tab) => tab.id));
    async function toggleTab(windowId, tab, selected, multiselect) {
        var _a;
        let tabsToToggle = [tab];
        if (multiselect && lastSelectedTabRef.current != null) {
            const lastSelectedWindowIndex = tabsByWindowId.findIndex(([winId]) => winId === windowId);
            const tabs = (_a = tabsByWindowId[lastSelectedWindowIndex]) === null || _a === void 0 ? void 0 : _a[1];
            if (tabs != null) {
                const fromIndex = tabs.indexOf(lastSelectedTabRef.current);
                const toIndex = tabs.indexOf(tab);
                if (fromIndex !== -1 && toIndex !== -1) {
                    tabsToToggle = tabs.slice(Math.min(fromIndex, toIndex), Math.max(fromIndex, toIndex) + 1);
                }
            }
        }
        // Toggle only the tabs that are manually lockable.
        await Promise.all(tabsToToggle
            .filter((tab) => js_settings.isTabManuallyLockable(tab))
            .map((tab) => {
            if (tab.id == null)
                return Promise.resolve();
            else if (selected)
                return lockTabId(tab.id);
            else
                return unlockTabId(tab.id);
        }));
        lastSelectedTabRef.current = tab;
    }
    return (react.createElement("div", { className: "tab-pane active" },
        react.createElement("div", { className: "d-flex align-items-center justify-content-between pb-2" },
            react.createElement("div", { className: "px-2" },
                react.createElement("abbr", { title: chrome.i18n.getMessage("tabLock_lockLabel") },
                    react.createElement("i", { className: "fas fa-lock" }))),
            react.createElement(react_bootstrap_esm_Dropdown, null,
                react.createElement(react_bootstrap_esm_Dropdown.Toggle, { size: "sm", title: chrome.i18n.getMessage("corral_currentSort", currSorter.label()), variant: "secondary" },
                    chrome.i18n.getMessage("corral_sortBy"),
                    " ",
                    currSorter.shortLabel()),
                react.createElement(react_bootstrap_esm_Dropdown.Menu, null,
                    LockTab_Sorters.map((sorter) => (react.createElement(react_bootstrap_esm_Dropdown.Item, { active: currSorter === sorter, as: "button", key: sorter.label(), onClick: () => {
                            if (sorter !== currSorter) {
                                // When the saved sort order is not null then the user wants to preserve it.
                                // Update to the new sort order and persist it.
                                if (syncData != null) {
                                    js_settings.set("lockTabSortOrder", sorter.key);
                                }
                                setCurrSorter(sorter);
                            }
                        } }, sorter.label()))),
                    react.createElement(react_bootstrap_esm_Dropdown.Divider, null),
                    react.createElement(react_bootstrap_esm_Dropdown.ItemText, null,
                        react.createElement("div", { className: "form-group mb-0" },
                            react.createElement("div", { className: "form-check" },
                                react.createElement("input", { checked: sortOrder != null, className: "form-check-input", id: "lock-tab--save-sort-order", onChange: (event) => {
                                        if (event.target.checked) {
                                            js_settings.set("lockTabSortOrder", currSorter.key);
                                            setSortOrder(currSorter.key);
                                        }
                                        else {
                                            js_settings.set("lockTabSortOrder", null);
                                            setSortOrder(null);
                                        }
                                    }, type: "checkbox" }),
                                react.createElement("label", { className: "form-check-label", htmlFor: "lock-tab--save-sort-order" }, chrome.i18n.getMessage("options_option_saveSortOrder")))))))),
        react.createElement("div", { className: "d-flex flex-column gap-4" },
            react.createElement(UseNowContext.Provider, { value: now }, tabsByWindowId.map(([windowId, tabs]) => (react.createElement("div", { className: "border overflow-hidden rounded", key: windowId },
                react.createElement("table", { className: "table table-hover table-sm mb-0" },
                    react.createElement("thead", null,
                        react.createElement("tr", null,
                            react.createElement("th", { className: classnames_default()("p-2 bg-body-tertiary"), colSpan: 5 },
                                react.createElement("div", { className: "d-flex justify-content-between" },
                                    react.createElement("div", null),
                                    react.createElement("div", null,
                                        (currWindow === null || currWindow === void 0 ? void 0 : currWindow.id) === windowId && (react.createElement("span", { className: "badge text-bg-success me-2 position-relative", style: { top: "-1px" } }, "CURRENT")),
                                        react.createElement("i", { className: "fas fa-window-maximize", title: `Window ${windowId}` })))))),
                    react.createElement("tbody", null, tabs.map((tab, index) => (react.createElement(OpenTabRow, { isLast: index === tabs.length - 1, isLocked: lockedTabIds.has(tab.id), key: tab.id, onToggleTab: toggleTab, tab: tab, tabTime: tabTimesQuery.data == null || tab.id == null
                            ? undefined
                            : tabTimesQuery.data[tab.id], windowId: windowId }))))))))))));
}

;// CONCATENATED MODULE: ./app/js/actions/importExportActions.ts
/**
 * Import the backup of saved tabs and the accounting information.
 * If any of the required keys in the backup object is missing, the backup will abort without
 * importing the data.
 *
 * @param event contains the path of the backup file
 */
function importData(event) {
    const files = event.target.files;
    if (files != null && files[0]) {
        return new Promise((resolve, reject) => {
            const fileReader = new FileReader();
            fileReader.onload = () => {
                try {
                    const json = JSON.parse(String(fileReader.result));
                    if (Object.keys(json).length < 4) {
                        reject(new Error("Invalid backup"));
                    }
                    else {
                        chrome.storage.local
                            .get("persist:localStorage")
                            .then((data) => chrome.storage.local.set({
                            "persist:localStorage": Object.assign(Object.assign({}, data["persist:localStorage"]), { savedTabs: json.savedTabs, totalTabsRemoved: json.totalTabsRemoved, totalTabsUnwrangled: json.totalTabsUnwrangled, totalTabsWrangled: json.totalTabsWrangled }),
                        }))
                            .then(resolve);
                    }
                }
                catch (e) {
                    reject(e);
                }
            };
            fileReader.onerror = (arg) => {
                reject(arg);
            };
            fileReader.readAsText(files[0], "utf-8");
        });
    }
    else {
        return Promise.reject("Nothing to import");
    }
}
/**
 * Export all saved tabs and some accounting information in one object. The object has 4 keys:
 *
 * - savedTabs
 * - totalTabsRemoved
 * - totalTabsUnwrangled
 * - totalTabsWrangled
 */
async function exportData() {
    const data = await chrome.storage.local.get("persist:localStorage");
    const localStorage = data["persist:localStorage"];
    const exportData = JSON.stringify({
        savedTabs: localStorage.savedTabs,
        totalTabsRemoved: localStorage.totalTabsRemoved,
        totalTabsUnwrangled: localStorage.totalTabsUnwrangled,
        totalTabsWrangled: localStorage.totalTabsWrangled,
    });
    return new Blob([exportData], {
        type: "application/json;charset=utf-8",
    });
}
const exportFileName = (date) => {
    // Use a format like YYYY-MM-DD, which is the first 10 characters of the ISO string format.
    const localeDateString = date.toISOString().substr(0, 10);
    return `TabWranglerExport-${localeDateString}.json`;
};


// EXTERNAL MODULE: ./node_modules/file-saver/dist/FileSaver.min.js
var FileSaver_min = __webpack_require__(4213);
var FileSaver_min_default = /*#__PURE__*/__webpack_require__.n(FileSaver_min);
;// CONCATENATED MODULE: ./app/js/TabWrangleOption.tsx

function TabWrangleOption(props) {
    // Declare this dynamically so it is available inside tests. It's not simple to modify globals,
    // like `chrome`, using Jest. Is there a better way to do this? Probably.
    const OPTIONS = [
        { name: "withDupes", text: chrome.i18n.getMessage("options_dedupe_option_withDupes") },
        {
            name: "exactURLMatch",
            text: chrome.i18n.getMessage("options_dedupe_option_exactURLMatch"),
        },
        {
            name: "hostnameAndTitleMatch",
            text: chrome.i18n.getMessage("options_dedupe_option_hostnameAndTitleMatch"),
        },
    ];
    return (react.createElement(react.Fragment, null,
        react.createElement("label", { className: "form-label" },
            react.createElement("strong", null, chrome.i18n.getMessage("options_dedupe_label"))),
        OPTIONS.map((option) => (react.createElement("div", { className: "form-check", key: option.name },
            react.createElement("input", { checked: props.selectedOption === option.name, className: "form-check-input", id: option.name, name: "wrangleOption", onChange: props.onChange, type: "radio", value: option.name }),
            react.createElement("label", { className: "form-check-label", htmlFor: option.name }, option.text)))),
        react.createElement("div", { className: "row" },
            react.createElement("div", { className: "col-8 form-text text-muted", style: { marginBottom: 0 } },
                react.createElement("dl", { style: { marginBottom: 0 } },
                    react.createElement("dt", null, chrome.i18n.getMessage("options_dedupe_option_withDupes_label")),
                    react.createElement("dd", null, chrome.i18n.getMessage("options_dedupe_option_withDupes_description")),
                    react.createElement("dt", { style: { marginTop: "10px" } }, chrome.i18n.getMessage("options_dedupe_option_exactURLMatch_label")),
                    react.createElement("dd", null, chrome.i18n.getMessage("options_dedupe_option_exactURLMatch_description")),
                    react.createElement("dt", { style: { marginTop: "10px" } }, chrome.i18n.getMessage("options_dedupe_option_hostnameAndTitleMatch_label")),
                    react.createElement("dd", null, chrome.i18n.getMessage("options_dedupe_option_hostnameAndTitleMatch_description")))))));
}

;// CONCATENATED MODULE: ./node_modules/@restart/hooks/esm/useMounted.js


/**
 * Track whether a component is current mounted. Generally less preferable than
 * properlly canceling effects so they don't run after a component is unmounted,
 * but helpful in cases where that isn't feasible, such as a `Promise` resolution.
 *
 * @returns a function that returns the current isMounted state of the component
 *
 * ```ts
 * const [data, setData] = useState(null)
 * const isMounted = useMounted()
 *
 * useEffect(() => {
 *   fetchdata().then((newData) => {
 *      if (isMounted()) {
 *        setData(newData);
 *      }
 *   })
 * })
 * ```
 */
function useMounted_useMounted() {
  const mounted = (0,react.useRef)(true);
  const isMounted = (0,react.useRef)(() => mounted.current);
  (0,react.useEffect)(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return isMounted.current;
}
;// CONCATENATED MODULE: ./node_modules/@restart/hooks/esm/useUpdatedRef.js


/**
 * Returns a ref that is immediately updated with the new value
 *
 * @param value The Ref value
 * @category refs
 */
function useUpdatedRef(value) {
  const valueRef = (0,react.useRef)(value);
  valueRef.current = value;
  return valueRef;
}
;// CONCATENATED MODULE: ./node_modules/@restart/hooks/esm/useWillUnmount.js



/**
 * Attach a callback that fires when a component unmounts
 *
 * @param fn Handler to run when the component unmounts
 * @category effects
 */
function useWillUnmount(fn) {
  const onUnmount = useUpdatedRef(fn);
  (0,react.useEffect)(() => () => onUnmount.current(), []);
}
;// CONCATENATED MODULE: ./node_modules/@restart/hooks/esm/useTimeout.js




/*
 * Browsers including Internet Explorer, Chrome, Safari, and Firefox store the
 * delay as a 32-bit signed integer internally. This causes an integer overflow
 * when using delays larger than 2,147,483,647 ms (about 24.8 days),
 * resulting in the timeout being executed immediately.
 *
 * via: https://developer.mozilla.org/en-US/docs/Web/API/WindowOrWorkerGlobalScope/setTimeout
 */
const MAX_DELAY_MS = 2 ** 31 - 1;
function setChainedTimeout(handleRef, fn, timeoutAtMs) {
  const delayMs = timeoutAtMs - Date.now();
  handleRef.current = delayMs <= MAX_DELAY_MS ? setTimeout(fn, delayMs) : setTimeout(() => setChainedTimeout(handleRef, fn, timeoutAtMs), MAX_DELAY_MS);
}

/**
 * Returns a controller object for setting a timeout that is properly cleaned up
 * once the component unmounts. New timeouts cancel and replace existing ones.
 *
 *
 *
 * ```tsx
 * const { set, clear } = useTimeout();
 * const [hello, showHello] = useState(false);
 * //Display hello after 5 seconds
 * set(() => showHello(true), 5000);
 * return (
 *   <div className="App">
 *     {hello ? <h3>Hello</h3> : null}
 *   </div>
 * );
 * ```
 */
function useTimeout() {
  const isMounted = useMounted_useMounted();

  // types are confused between node and web here IDK
  const handleRef = (0,react.useRef)();
  useWillUnmount(() => clearTimeout(handleRef.current));
  return (0,react.useMemo)(() => {
    const clear = () => clearTimeout(handleRef.current);
    function set(fn, delayMs = 0) {
      if (!isMounted()) return;
      clear();
      if (delayMs <= MAX_DELAY_MS) {
        // For simplicity, if the timeout is short, just set a normal timeout.
        handleRef.current = setTimeout(fn, delayMs);
      } else {
        setChainedTimeout(handleRef, fn, Date.now() + delayMs);
      }
    }
    return {
      set,
      clear,
      handleRef
    };
  }, []);
}
;// CONCATENATED MODULE: ./node_modules/@restart/ui/esm/utils.js

function isEscKey(e) {
  return e.code === 'Escape' || e.keyCode === 27;
}
function getReactVersion() {
  const parts = react.version.split('.');
  return {
    major: +parts[0],
    minor: +parts[1],
    patch: +parts[2]
  };
}
function getChildRef(element) {
  if (!element || typeof element === 'function') {
    return null;
  }
  const {
    major
  } = getReactVersion();
  const childRef = major >= 19 ? element.props.ref : element.ref;
  return childRef;
}
;// CONCATENATED MODULE: ./node_modules/dom-helpers/esm/ownerWindow.js

/**
 * Returns the owner window of a given element.
 * 
 * @param node the element
 */

function ownerWindow(node) {
  var doc = ownerDocument(node);
  return doc && doc.defaultView || window;
}
;// CONCATENATED MODULE: ./node_modules/dom-helpers/esm/getComputedStyle.js

/**
 * Returns one or all computed style properties of an element.
 * 
 * @param node the element
 * @param psuedoElement the style property
 */

function getComputedStyle_getComputedStyle(node, psuedoElement) {
  return ownerWindow(node).getComputedStyle(node, psuedoElement);
}
;// CONCATENATED MODULE: ./node_modules/dom-helpers/esm/hyphenate.js
var rUpper = /([A-Z])/g;
function hyphenate(string) {
  return string.replace(rUpper, '-$1').toLowerCase();
}
;// CONCATENATED MODULE: ./node_modules/dom-helpers/esm/hyphenateStyle.js
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 * https://github.com/facebook/react/blob/2aeb8a2a6beb00617a4217f7f8284924fa2ad819/src/vendor/core/hyphenateStyleName.js
 */

var msPattern = /^ms-/;
function hyphenateStyleName(string) {
  return hyphenate(string).replace(msPattern, '-ms-');
}
;// CONCATENATED MODULE: ./node_modules/dom-helpers/esm/isTransform.js
var supportedTransforms = /^((translate|rotate|scale)(X|Y|Z|3d)?|matrix(3d)?|perspective|skew(X|Y)?)$/i;
function isTransform(value) {
  return !!(value && supportedTransforms.test(value));
}
;// CONCATENATED MODULE: ./node_modules/dom-helpers/esm/css.js




function style(node, property) {
  var css = '';
  var transforms = '';

  if (typeof property === 'string') {
    return node.style.getPropertyValue(hyphenateStyleName(property)) || getComputedStyle_getComputedStyle(node).getPropertyValue(hyphenateStyleName(property));
  }

  Object.keys(property).forEach(function (key) {
    var value = property[key];

    if (!value && value !== 0) {
      node.style.removeProperty(hyphenateStyleName(key));
    } else if (isTransform(key)) {
      transforms += key + "(" + value + ") ";
    } else {
      css += hyphenateStyleName(key) + ": " + value + ";";
    }
  });

  if (transforms) {
    css += "transform: " + transforms + ";";
  }

  node.style.cssText += ";" + css;
}

/* harmony default export */ const css = (style);
;// CONCATENATED MODULE: ./node_modules/dom-helpers/esm/triggerEvent.js
/**
 * Triggers an event on a given element.
 * 
 * @param node the element
 * @param eventName the event name to trigger
 * @param bubbles whether the event should bubble up
 * @param cancelable whether the event should be cancelable
 */
function triggerEvent(node, eventName, bubbles, cancelable) {
  if (bubbles === void 0) {
    bubbles = false;
  }

  if (cancelable === void 0) {
    cancelable = true;
  }

  if (node) {
    var event = document.createEvent('HTMLEvents');
    event.initEvent(eventName, bubbles, cancelable);
    node.dispatchEvent(event);
  }
}
;// CONCATENATED MODULE: ./node_modules/dom-helpers/esm/transitionEnd.js




function parseDuration(node) {
  var str = css(node, 'transitionDuration') || '';
  var mult = str.indexOf('ms') === -1 ? 1000 : 1;
  return parseFloat(str) * mult;
}

function emulateTransitionEnd(element, duration, padding) {
  if (padding === void 0) {
    padding = 5;
  }

  var called = false;
  var handle = setTimeout(function () {
    if (!called) triggerEvent(element, 'transitionend', true);
  }, duration + padding);
  var remove = esm_listen(element, 'transitionend', function () {
    called = true;
  }, {
    once: true
  });
  return function () {
    clearTimeout(handle);
    remove();
  };
}

function transitionEnd(element, handler, duration, padding) {
  if (duration == null) duration = parseDuration(element) || 0;
  var removeEmulate = emulateTransitionEnd(element, duration, padding);
  var remove = esm_listen(element, 'transitionend', handler);
  return function () {
    removeEmulate();
    remove();
  };
}
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/transitionEndListener.js


function transitionEndListener_parseDuration(node, property) {
  const str = css(node, property) || '';
  const mult = str.indexOf('ms') === -1 ? 1000 : 1;
  return parseFloat(str) * mult;
}
function transitionEndListener(element, handler) {
  const duration = transitionEndListener_parseDuration(element, 'transitionDuration');
  const delay = transitionEndListener_parseDuration(element, 'transitionDelay');
  const remove = transitionEnd(element, e => {
    if (e.target === element) {
      remove();
      handler(e);
    }
  }, duration + delay);
}
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/triggerBrowserReflow.js
// reading a dimension prop will cause the browser to recalculate,
// which will let our animations work
function triggerBrowserReflow(node) {
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  node.offsetHeight;
}
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/safeFindDOMNode.js

function safeFindDOMNode(componentOrElement) {
  if (componentOrElement && 'setState' in componentOrElement) {
    return react_dom.findDOMNode(componentOrElement);
  }
  return componentOrElement != null ? componentOrElement : null;
}
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/TransitionWrapper.js
"use client";






// Normalizes Transition callbacks when nodeRef is used.
const TransitionWrapper = /*#__PURE__*/react.forwardRef(({
  onEnter,
  onEntering,
  onEntered,
  onExit,
  onExiting,
  onExited,
  addEndListener,
  children,
  childRef,
  ...props
}, ref) => {
  const nodeRef = (0,react.useRef)(null);
  const mergedRef = esm_useMergedRefs(nodeRef, childRef);
  const attachRef = r => {
    mergedRef(safeFindDOMNode(r));
  };
  const normalize = callback => param => {
    if (callback && nodeRef.current) {
      callback(nodeRef.current, param);
    }
  };

  /* eslint-disable react-hooks/exhaustive-deps */
  const handleEnter = (0,react.useCallback)(normalize(onEnter), [onEnter]);
  const handleEntering = (0,react.useCallback)(normalize(onEntering), [onEntering]);
  const handleEntered = (0,react.useCallback)(normalize(onEntered), [onEntered]);
  const handleExit = (0,react.useCallback)(normalize(onExit), [onExit]);
  const handleExiting = (0,react.useCallback)(normalize(onExiting), [onExiting]);
  const handleExited = (0,react.useCallback)(normalize(onExited), [onExited]);
  const handleAddEndListener = (0,react.useCallback)(normalize(addEndListener), [addEndListener]);
  /* eslint-enable react-hooks/exhaustive-deps */

  return /*#__PURE__*/(0,jsx_runtime.jsx)(esm_Transition, {
    ref: ref,
    ...props,
    onEnter: handleEnter,
    onEntered: handleEntered,
    onEntering: handleEntering,
    onExit: handleExit,
    onExited: handleExited,
    onExiting: handleExiting,
    addEndListener: handleAddEndListener,
    nodeRef: nodeRef,
    children: typeof children === 'function' ? (status, innerProps) =>
    // TODO: Types for RTG missing innerProps, so need to cast.
    children(status, {
      ...innerProps,
      ref: attachRef
    }) : /*#__PURE__*/react.cloneElement(children, {
      ref: attachRef
    })
  });
});
/* harmony default export */ const esm_TransitionWrapper = (TransitionWrapper);
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/Fade.js









const fadeStyles = {
  [ENTERING]: 'show',
  [ENTERED]: 'show'
};
const Fade = /*#__PURE__*/react.forwardRef(({
  className,
  children,
  transitionClasses = {},
  onEnter,
  ...rest
}, ref) => {
  const props = {
    in: false,
    timeout: 300,
    mountOnEnter: false,
    unmountOnExit: false,
    appear: false,
    ...rest
  };
  const handleEnter = (0,react.useCallback)((node, isAppearing) => {
    triggerBrowserReflow(node);
    onEnter == null || onEnter(node, isAppearing);
  }, [onEnter]);
  return /*#__PURE__*/(0,jsx_runtime.jsx)(esm_TransitionWrapper, {
    ref: ref,
    addEndListener: transitionEndListener,
    ...props,
    onEnter: handleEnter,
    childRef: getChildRef(children),
    children: (status, innerProps) => /*#__PURE__*/react.cloneElement(children, {
      ...innerProps,
      className: classnames_default()('fade', className, children.props.className, fadeStyles[status], transitionClasses[status])
    })
  });
});
Fade.displayName = 'Fade';
/* harmony default export */ const esm_Fade = (Fade);
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/ToastFade.js




const ToastFade_fadeStyles = {
  [ENTERING]: 'showing',
  [EXITING]: 'showing show'
};
const ToastFade = /*#__PURE__*/react.forwardRef((props, ref) => /*#__PURE__*/(0,jsx_runtime.jsx)(esm_Fade, {
  ...props,
  ref: ref,
  transitionClasses: ToastFade_fadeStyles
}));
ToastFade.displayName = 'ToastFade';
/* harmony default export */ const esm_ToastFade = (ToastFade);
// EXTERNAL MODULE: ./node_modules/prop-types/index.js
var prop_types = __webpack_require__(5556);
var prop_types_default = /*#__PURE__*/__webpack_require__.n(prop_types);
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/CloseButton.js




const propTypes = {
  /** An accessible label indicating the relevant information about the Close Button. */
  'aria-label': (prop_types_default()).string,
  /** A callback fired after the Close Button is clicked. */
  onClick: (prop_types_default()).func,
  /**
   * Render different color variant for the button.
   *
   * Omitting this will render the default dark color.
   */
  variant: prop_types_default().oneOf(['white'])
};
const CloseButton = /*#__PURE__*/react.forwardRef(({
  className,
  variant,
  'aria-label': ariaLabel = 'Close',
  ...props
}, ref) => /*#__PURE__*/(0,jsx_runtime.jsx)("button", {
  ref: ref,
  type: "button",
  className: classnames_default()('btn-close', variant && `btn-close-${variant}`, className),
  "aria-label": ariaLabel,
  ...props
}));
CloseButton.displayName = 'CloseButton';
CloseButton.propTypes = propTypes;
/* harmony default export */ const esm_CloseButton = (CloseButton);
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/ToastContext.js
"use client";


const ToastContext = /*#__PURE__*/react.createContext({
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  onClose() {}
});
/* harmony default export */ const esm_ToastContext = (ToastContext);
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/ToastHeader.js
"use client";










const ToastHeader = /*#__PURE__*/react.forwardRef(({
  bsPrefix,
  closeLabel = 'Close',
  closeVariant,
  closeButton = true,
  className,
  children,
  ...props
}, ref) => {
  bsPrefix = useBootstrapPrefix(bsPrefix, 'toast-header');
  const context = (0,react.useContext)(esm_ToastContext);
  const handleClick = useEventCallback_useEventCallback(e => {
    context == null || context.onClose == null || context.onClose(e);
  });
  return /*#__PURE__*/(0,jsx_runtime.jsxs)("div", {
    ref: ref,
    ...props,
    className: classnames_default()(bsPrefix, className),
    children: [children, closeButton && /*#__PURE__*/(0,jsx_runtime.jsx)(esm_CloseButton, {
      "aria-label": closeLabel,
      variant: closeVariant,
      onClick: handleClick,
      "data-dismiss": "toast"
    })]
  });
});
ToastHeader.displayName = 'ToastHeader';
/* harmony default export */ const esm_ToastHeader = (ToastHeader);
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/ToastBody.js
"use client";





const ToastBody = /*#__PURE__*/react.forwardRef(({
  className,
  bsPrefix,
  as: Component = 'div',
  ...props
}, ref) => {
  bsPrefix = useBootstrapPrefix(bsPrefix, 'toast-body');
  return /*#__PURE__*/(0,jsx_runtime.jsx)(Component, {
    ref: ref,
    className: classnames_default()(className, bsPrefix),
    ...props
  });
});
ToastBody.displayName = 'ToastBody';
/* harmony default export */ const esm_ToastBody = (ToastBody);
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/Toast.js
"use client";











const Toast = /*#__PURE__*/react.forwardRef(({
  bsPrefix,
  className,
  transition: Transition = esm_ToastFade,
  show = true,
  animation = true,
  delay = 5000,
  autohide = false,
  onClose,
  onEntered,
  onExit,
  onExiting,
  onEnter,
  onEntering,
  onExited,
  bg,
  ...props
}, ref) => {
  bsPrefix = useBootstrapPrefix(bsPrefix, 'toast');

  // We use refs for these, because we don't want to restart the autohide
  // timer in case these values change.
  const delayRef = (0,react.useRef)(delay);
  const onCloseRef = (0,react.useRef)(onClose);
  (0,react.useEffect)(() => {
    delayRef.current = delay;
    onCloseRef.current = onClose;
  }, [delay, onClose]);
  const autohideTimeout = useTimeout();
  const autohideToast = !!(autohide && show);
  const autohideFunc = (0,react.useCallback)(() => {
    if (autohideToast) {
      onCloseRef.current == null || onCloseRef.current();
    }
  }, [autohideToast]);
  (0,react.useEffect)(() => {
    // Only reset timer if show or autohide changes.
    autohideTimeout.set(autohideFunc, delayRef.current);
  }, [autohideTimeout, autohideFunc]);
  const toastContext = (0,react.useMemo)(() => ({
    onClose
  }), [onClose]);
  const hasAnimation = !!(Transition && animation);
  const toast = /*#__PURE__*/(0,jsx_runtime.jsx)("div", {
    ...props,
    ref: ref,
    className: classnames_default()(bsPrefix, className, bg && `bg-${bg}`, !hasAnimation && (show ? 'show' : 'hide')),
    role: "alert",
    "aria-live": "assertive",
    "aria-atomic": "true"
  });
  return /*#__PURE__*/(0,jsx_runtime.jsx)(esm_ToastContext.Provider, {
    value: toastContext,
    children: hasAnimation && Transition ? /*#__PURE__*/(0,jsx_runtime.jsx)(Transition, {
      in: show,
      onEnter: onEnter,
      onEntering: onEntering,
      onEntered: onEntered,
      onExit: onExit,
      onExiting: onExiting,
      onExited: onExited,
      unmountOnExit: true,
      children: toast
    }) : toast
  });
});
Toast.displayName = 'Toast';
/* harmony default export */ const esm_Toast = (Object.assign(Toast, {
  Body: esm_ToastBody,
  Header: esm_ToastHeader
}));
;// CONCATENATED MODULE: ./node_modules/react-bootstrap/esm/ToastContainer.js
"use client";





const positionClasses = {
  'top-start': 'top-0 start-0',
  'top-center': 'top-0 start-50 translate-middle-x',
  'top-end': 'top-0 end-0',
  'middle-start': 'top-50 start-0 translate-middle-y',
  'middle-center': 'top-50 start-50 translate-middle',
  'middle-end': 'top-50 end-0 translate-middle-y',
  'bottom-start': 'bottom-0 start-0',
  'bottom-center': 'bottom-0 start-50 translate-middle-x',
  'bottom-end': 'bottom-0 end-0'
};
const ToastContainer = /*#__PURE__*/react.forwardRef(({
  bsPrefix,
  position,
  containerPosition,
  className,
  // Need to define the default "as" during prop destructuring to be compatible with styled-components github.com/react-bootstrap/react-bootstrap/issues/3595
  as: Component = 'div',
  ...props
}, ref) => {
  bsPrefix = useBootstrapPrefix(bsPrefix, 'toast-container');
  return /*#__PURE__*/(0,jsx_runtime.jsx)(Component, {
    ref: ref,
    ...props,
    className: classnames_default()(bsPrefix, position && positionClasses[position], containerPosition && `position-${containerPosition}`, className)
  });
});
ToastContainer.displayName = 'ToastContainer';
/* harmony default export */ const esm_ToastContainer = (ToastContainer);
;// CONCATENATED MODULE: ./node_modules/@react-hook/latest/dist/module/index.js


const useLatest = current => {
  const storedValue = react.useRef(current);
  react.useEffect(() => {
    storedValue.current = current;
  });
  return storedValue;
};

/* harmony default export */ const dist_module = (useLatest);
;// CONCATENATED MODULE: ./node_modules/@react-hook/debounce/dist/module/index.js


const useDebounceCallback = (callback, wait = 100, leading = false) => {
  const storedCallback = dist_module(callback);
  const timeout = react.useRef();
  const deps = [wait, leading, storedCallback]; // Cleans up pending timeouts when the deps change

  function _ref() {
    timeout.current && clearTimeout(timeout.current);
    timeout.current = void 0;
  }

  react.useEffect(() => _ref, deps);

  function _ref2() {
    timeout.current = void 0;
  }

  return react.useCallback(function () {
    // eslint-disable-next-line prefer-rest-params
    const args = arguments;
    const {
      current
    } = timeout; // Calls on leading edge

    if (current === void 0 && leading) {
      timeout.current = setTimeout(_ref2, wait); // eslint-disable-next-line prefer-spread

      return storedCallback.current.apply(null, args);
    } // Clear the timeout every call and start waiting again


    current && clearTimeout(current); // Waits for `wait` before invoking the callback

    timeout.current = setTimeout(() => {
      timeout.current = void 0;
      storedCallback.current.apply(null, args);
    }, wait);
  }, deps);
};
const useDebounce = (initialState, wait, leading) => {
  const state = React.useState(initialState);
  return [state[0], useDebounceCallback(state[1], wait, leading), state[1]];
};
;// CONCATENATED MODULE: ./app/js/OptionsTab.tsx













function isValidPattern(pattern) {
    return pattern != null && pattern.length > 0 && /\S/.test(pattern);
}
function OptionsTab() {
    var _a, _b;
    const { data: syncPersistData } = useStorageSyncPersistQuery();
    const { data: syncData } = useStorageSyncQuery();
    const fileSelectorRef = react.useRef(null);
    const importExportAlertTimeoutRef = react.useRef();
    const theme = (_a = syncPersistData === null || syncPersistData === void 0 ? void 0 : syncPersistData.theme) !== null && _a !== void 0 ? _a : "system";
    const whitelist = (_b = syncData === null || syncData === void 0 ? void 0 : syncData.whitelist) !== null && _b !== void 0 ? _b : [];
    const [errors, setErrors] = react.useState([]);
    const [importExportAlertVisible, setImportExportAlertVisible] = react.useState(false);
    const [importExportErrors, setImportExportErrors] = react.useState([]);
    const [importExportOperationName, setImportExportOperationName] = react.useState("");
    const [newPattern, setNewPattern] = react.useState("");
    const saveAlertTimeoutRef = react.useRef();
    const [saveAlertVisible, setSaveAlertVisible] = react.useState(false);
    const [showFilterTabGroupsOption, setShowFilterTabGroupsOption] = react.useState(false);
    const [maxTabs, setMaxTabs] = react.useState(js_settings.get("maxTabs"));
    function resetMaxTabs() {
        setMaxTabs(js_settings.get("maxTabs"));
    }
    function saveMaxTabs() {
        saveSetting("maxTabs", maxTabs);
    }
    const persistSettingMutation = useMutation({
        mutationFn: mutateStorageSyncPersist,
    });
    const settingMutation = useMutation({
        mutationFn: ({ key, value }) => chrome.storage.sync.set({ [key]: value }),
    });
    function handleClickRemovePattern(pattern) {
        const nextWhitelist = whitelist.slice();
        nextWhitelist.splice(whitelist.indexOf(pattern), 1);
        settingMutation.mutate({ key: "whitelist", value: nextWhitelist });
    }
    react.useEffect(() => {
        // determine if we should show the filter tab groups setting
        async function checkForTabGroups() {
            const tabs = await chrome.tabs.query({});
            // this shouldn't happen but we'll bail if there are zero tabs
            if (tabs.length < 1) {
                return;
            }
            if ("groupId" in tabs[0]) {
                setShowFilterTabGroupsOption(true);
            }
        }
        checkForTabGroups();
    }, []);
    async function saveSetting(key, value) {
        if (saveAlertTimeoutRef.current != null) {
            window.clearTimeout(saveAlertTimeoutRef.current);
        }
        try {
            await js_settings.set(key, value);
        }
        catch (err) {
            if (err instanceof Error)
                setErrors([...errors, err]);
            return;
        }
        setErrors([]);
        setSaveAlertVisible(true);
        saveAlertTimeoutRef.current = window.setTimeout(() => {
            setSaveAlertVisible(false);
        }, 1000);
    }
    const debouncedHandleSettingsChange = useDebounceCallback((event) => {
        if (event.target.type === "checkbox") {
            saveSetting(event.target.id, !!event.target.checked);
        }
        else if (event.target.type === "radio") {
            saveSetting(event.target.name, event.target.value);
        }
        else {
            saveSetting(event.target.id, event.target.value);
        }
    }, 150);
    function addWhitelistPattern(event) {
        event.preventDefault();
        if (!isValidPattern(newPattern)) {
            return;
        }
        // Only add the pattern again if it's new, not yet in the whitelist.
        if (whitelist.indexOf(newPattern) === -1) {
            settingMutation.mutate({ key: "whitelist", value: [...whitelist, newPattern] });
        }
        setNewPattern("");
    }
    function handleSettingsChange(event) {
        event.persist();
        debouncedHandleSettingsChange(event);
    }
    function importExportDataWithFeedback(operationName, func, funcArg, onSuccess) {
        if (importExportAlertTimeoutRef.current != null) {
            window.clearTimeout(importExportAlertTimeoutRef.current);
        }
        setImportExportErrors([]);
        setImportExportAlertVisible(true);
        setImportExportOperationName(operationName);
        func(funcArg)
            .then((blob) => {
            if (onSuccess != null)
                onSuccess(blob);
        })
            .catch((err) => {
            setImportExportErrors((currImportExportErrors) => [...currImportExportErrors, err]);
        });
    }
    function handleExportData(event) {
        importExportDataWithFeedback(chrome.i18n.getMessage("options_importExport_exporting") || "", exportData, event, (blob) => {
            FileSaver_min_default().saveAs(blob, exportFileName(new Date(Date.now())));
        });
    }
    function handleImportData(event) {
        importExportDataWithFeedback(chrome.i18n.getMessage("options_importExport_importing") || "", importData, event);
    }
    return (react.createElement(react.Fragment, null,
        react.createElement("div", { className: "tab-pane active" },
            react.createElement("form", null,
                react.createElement("label", { className: "form-label" },
                    react.createElement("strong", null, chrome.i18n.getMessage("options_option_theme_label"))),
                react.createElement("div", null,
                    react.createElement("div", { className: "btn-group" },
                        react.createElement("button", { className: classnames_default()("btn", {
                                active: theme == null || theme === "system",
                                "btn-secondary": theme == null || theme === "system",
                                "btn-outline-secondary": !(theme == null || theme === "system"),
                            }), onClick: () => {
                                persistSettingMutation.mutate({ key: "theme", value: "system" });
                            }, type: "button" }, chrome.i18n.getMessage("options_option_theme_system")),
                        react.createElement("button", { className: classnames_default()("btn", {
                                active: theme === "light",
                                "btn-secondary": theme === "light",
                                "btn-outline-secondary": theme !== "light",
                            }), onClick: () => {
                                persistSettingMutation.mutate({ key: "theme", value: "light" });
                            }, type: "button" },
                            react.createElement("i", { className: "fas fa-sun me-1" }),
                            chrome.i18n.getMessage("options_option_theme_light")),
                        react.createElement("button", { className: classnames_default()("btn", {
                                active: theme === "dark",
                                "btn-secondary": theme === "dark",
                                "btn-outline-secondary": theme !== "dark",
                            }), onClick: () => {
                                persistSettingMutation.mutate({ key: "theme", value: "dark" });
                            }, type: "button" },
                            react.createElement("i", { className: "fas fa-moon me-1" }),
                            chrome.i18n.getMessage("options_option_theme_dark")))),
                react.createElement("label", { className: "form-label mt-3" },
                    react.createElement("strong", null, chrome.i18n.getMessage("options_option_timeInactive_label"))),
                react.createElement("div", { className: "row align-items-center" },
                    react.createElement("div", { className: "col-4" },
                        react.createElement("div", { className: "input-group" },
                            react.createElement("input", { className: "form-control", defaultValue: js_settings.get("minutesInactive"), id: "minutesInactive", max: "7200", min: "0", name: "minutesInactive", onChange: handleSettingsChange, title: chrome.i18n.getMessage("options_option_timeInactive_minutes"), type: "number" }),
                            react.createElement("span", { className: "input-group-text" }, chrome.i18n.getMessage("options_option_timeInactive_label_minutes")))),
                    react.createElement("div", { className: "w-auto p-0 mx-n1" }, ":"),
                    react.createElement("div", { className: "col-4" },
                        react.createElement("div", { className: "input-group" },
                            react.createElement("input", { className: "form-control", defaultValue: js_settings.get("secondsInactive"), id: "secondsInactive", max: "59", min: "0", name: "secondsInactive", onChange: handleSettingsChange, title: chrome.i18n.getMessage("options_option_timeInactive_seconds"), type: "number" }),
                            react.createElement("span", { className: "input-group-text" }, chrome.i18n.getMessage("options_option_timeInactive_label_seconds"))))),
                react.createElement("label", { className: "form-label mt-3", htmlFor: "minTabs" },
                    react.createElement("strong", null, chrome.i18n.getMessage("options_option_minTabs_label"))),
                react.createElement("div", { className: "row align-items-center" },
                    react.createElement("div", { className: "col-8" },
                        react.createElement("div", { className: "input-group" },
                            react.createElement("input", { className: "form-control", defaultValue: js_settings.get("minTabs"), id: "minTabs", min: "0", name: "minTabs", onChange: handleSettingsChange, title: chrome.i18n.getMessage("options_option_minTabs_tabs"), type: "number" }),
                            react.createElement("div", { className: "input-group-text" }, "open tabs"),
                            react.createElement("select", { className: "form-select", id: "minTabsStrategy", name: "minTabsStrategy", onChange: (event) => {
                                    saveSetting("minTabsStrategy", event.target.value);
                                }, style: { flex: 3 }, value: js_settings.get("minTabsStrategy") },
                                react.createElement("option", { value: "allWindows" }, chrome.i18n.getMessage("options_option_minTabs_option_total")),
                                react.createElement("option", { value: "givenWindow" }, chrome.i18n.getMessage("options_option_minTabs_option_givenWindow")))))),
                react.createElement("div", { className: "form-text mb-1" }, chrome.i18n.getMessage("options_option_minTabs_postLabel")),
                react.createElement("div", { className: "form-check mb-1" },
                    react.createElement("input", { className: "form-check-input", defaultChecked: js_settings.get("debounceOnActivated"), id: "debounceOnActivated", name: "debounceOnActivated", onChange: handleSettingsChange, type: "checkbox" }),
                    react.createElement("label", { className: "form-check-label", htmlFor: "debounceOnActivated" }, chrome.i18n.getMessage("options_option_debounceOnActivated_label"))),
                react.createElement("div", { className: "form-check mb-1" },
                    react.createElement("input", { className: "form-check-input", defaultChecked: js_settings.get("filterAudio"), id: "filterAudio", name: "filterAudio", onChange: handleSettingsChange, type: "checkbox" }),
                    react.createElement("label", { className: "form-check-label", htmlFor: "filterAudio" }, chrome.i18n.getMessage("options_option_filterAudio_label"))),
                react.createElement("div", { className: "form-check" },
                    react.createElement("input", { className: "form-check-input", defaultChecked: js_settings.get("filterGroupedTabs"), disabled: !showFilterTabGroupsOption, id: "filterGroupedTabs", name: "filterGroupedTabs", onChange: handleSettingsChange, type: "checkbox" }),
                    react.createElement("label", { className: "form-check-label", htmlFor: "filterGroupedTabs" }, chrome.i18n.getMessage("options_option_filterGroupedTabs_label"))),
                react.createElement("label", { className: "form-label mt-3", htmlFor: "maxTabs" },
                    react.createElement("strong", null, chrome.i18n.getMessage("options_option_rememberTabs_label"))),
                react.createElement("div", { className: "row align-items-center" },
                    react.createElement("div", { className: "col-3" },
                        react.createElement("input", { className: classnames_default()("form-control me-1", {
                                "border-primary": maxTabs !== js_settings.get("maxTabs"),
                            }), id: "maxTabs", min: "0", name: "maxTabs", onChange: (event) => {
                                const parsedValue = parseInt(event.target.value);
                                setMaxTabs(isNaN(parsedValue) ? "" : parsedValue);
                            }, title: chrome.i18n.getMessage("options_option_rememberTabs_tabs"), type: "number", value: maxTabs })),
                    react.createElement("div", { className: "w-auto p-0" }, chrome.i18n.getMessage("options_option_rememberTabs_postLabel"))),
                typeof maxTabs === "string" && (react.createElement("div", { className: "row" },
                    react.createElement("div", { className: "col-8 form-text text-primary" }, chrome.i18n.getMessage("options_option_rememberTabs_validNumber")))),
                typeof maxTabs === "number" && maxTabs < js_settings.get("maxTabs") && (react.createElement("div", { className: "row" },
                    react.createElement("div", { className: "col-8 form-text text-primary" }, chrome.i18n.getMessage("options_option_rememberTabs_truncateMsg")))),
                typeof maxTabs === "number" && maxTabs > js_settings.get("maxTabs") && (react.createElement("div", { className: "row" },
                    react.createElement("div", { className: "col-8 form-text text-primary" }, chrome.i18n.getMessage("options_option_rememberTabs_saveToConfirm")))),
                react.createElement("div", { className: "form-check mb-1 mt-2" },
                    react.createElement("input", { className: "form-check-input", defaultChecked: js_settings.get("purgeClosedTabs"), id: "purgeClosedTabs", name: "purgeClosedTabs", onChange: handleSettingsChange, type: "checkbox" }),
                    react.createElement("label", { className: "form-check-label", htmlFor: "purgeClosedTabs" }, chrome.i18n.getMessage("options_option_clearOnQuit_label"))),
                react.createElement("div", { className: "form-check mb-1" },
                    react.createElement("input", { className: "form-check-input", defaultChecked: js_settings.get("showBadgeCount"), id: "showBadgeCount", name: "showBadgeCount", onChange: handleSettingsChange, type: "checkbox" }),
                    react.createElement("label", { className: "form-check-label", htmlFor: "showBadgeCount" }, chrome.i18n.getMessage("options_option_showBadgeCount_label"))),
                react.createElement("div", { className: "form-check mb-3" },
                    react.createElement("input", { className: "form-check-input", defaultChecked: js_settings.get("createContextMenu"), id: "createContextMenu", name: "createContextMenu", onChange: handleSettingsChange, type: "checkbox" }),
                    react.createElement("label", { className: "form-check-label", htmlFor: "createContextMenu" }, chrome.i18n.getMessage("options_option_createContextMenu_label"))),
                react.createElement(TabWrangleOption, { onChange: handleSettingsChange, selectedOption: js_settings.get("wrangleOption") })),
            react.createElement("h5", { className: "mt-3" }, chrome.i18n.getMessage("options_section_autoLock")),
            react.createElement("div", { className: "row" },
                react.createElement("div", { className: "col-8" },
                    react.createElement("form", { onSubmit: addWhitelistPattern },
                        react.createElement("label", { className: "form-label", htmlFor: "wl-add" }, chrome.i18n.getMessage("options_option_autoLock_label")),
                        react.createElement("div", { className: "input-group" },
                            react.createElement("input", { className: "form-control", id: "wl-add", onChange: (event) => {
                                    setNewPattern(event.target.value);
                                }, type: "text", value: newPattern }),
                            react.createElement("button", { className: "btn btn-secondary", disabled: !isValidPattern(newPattern), id: "addToWL", type: "submit" }, chrome.i18n.getMessage("options_option_autoLock_add"))),
                        react.createElement("p", { className: "form-text" }, chrome.i18n.getMessage("options_option_autoLock_example"))))),
            react.createElement("table", { className: "table table-hover" },
                react.createElement("thead", null,
                    react.createElement("tr", null,
                        react.createElement("th", { style: { width: "100%" } }, chrome.i18n.getMessage("options_option_autoLock_urlHeader")),
                        react.createElement("th", null))),
                react.createElement("tbody", null, whitelist.length === 0 ? (react.createElement("tr", null,
                    react.createElement("td", { className: "text-center", colSpan: 2 }, chrome.i18n.getMessage("options_option_autoLock_empty")))) : (whitelist.map((pattern) => (react.createElement("tr", { className: "align-middle", key: pattern },
                    react.createElement("td", null,
                        react.createElement("code", null, pattern)),
                    react.createElement("td", null,
                        react.createElement("button", { className: "btn btn-outline-secondary btn-sm my-n1", onClick: () => {
                                handleClickRemovePattern(pattern);
                            } }, chrome.i18n.getMessage("options_option_autoLock_remove"))))))))),
            react.createElement("h5", { className: "mt-3" }, chrome.i18n.getMessage("options_section_importExport")),
            react.createElement("div", { className: "row" },
                react.createElement("div", { className: "col-8" }, chrome.i18n.getMessage("options_importExport_description"))),
            react.createElement("div", { className: "row my-2" },
                react.createElement("div", { className: "col-8 mb-1" },
                    react.createElement("button", { className: "btn btn-secondary", onClick: handleExportData },
                        react.createElement("i", { className: "fas fa-file-export me-1" }),
                        chrome.i18n.getMessage("options_importExport_export")),
                    " ",
                    react.createElement("button", { className: "btn btn-secondary", onClick: () => {
                            if (fileSelectorRef.current != null)
                                fileSelectorRef.current.click();
                        } },
                        react.createElement("i", { className: "fas fa-file-import me-1" }),
                        chrome.i18n.getMessage("options_importExport_import")),
                    react.createElement("input", { accept: ".json", onChange: handleImportData, ref: (input) => {
                            fileSelectorRef.current = input;
                        }, style: { display: "none" }, type: "file" }))),
            react.createElement("div", { className: "row" },
                react.createElement("div", { className: "col-8" },
                    react.createElement("div", { className: "alert alert-warning" }, chrome.i18n.getMessage("options_importExport_importWarning"))))),
        react.createElement(esm_ToastContainer, { className: "p-3", containerPosition: "fixed", position: "bottom-start" },
            react.createElement(esm_Toast, { bg: "danger", show: errors.length > 0 },
                react.createElement(esm_Toast.Body, null,
                    react.createElement("strong", null, chrome.i18n.getMessage("options_errorSavingSettings")),
                    react.createElement("ul", { className: "mb-0" }, errors.map((error, i) => (react.createElement("li", { key: i }, error.message)))))),
            react.createElement(esm_Toast, { bg: "danger", show: importExportErrors.length > 0 },
                react.createElement(esm_Toast.Body, null,
                    react.createElement("strong", null, chrome.i18n.getMessage("options_errorImportExport")),
                    react.createElement("ul", { className: "mb-0" }, importExportErrors.map((error, i) => (react.createElement("li", { key: i }, error.message)))))),
            react.createElement(esm_Toast, { autohide: true, bg: "success", delay: 2000, onClose: () => {
                    setImportExportAlertVisible(false);
                }, show: importExportAlertVisible },
                react.createElement(esm_Toast.Body, null, importExportOperationName)),
            react.createElement(esm_Toast, { bg: "success", show: saveAlertVisible },
                react.createElement(esm_Toast.Body, null, chrome.i18n.getMessage("options_saving"))),
            react.createElement(esm_Toast, { bg: "primary", show: maxTabs !== js_settings.get("maxTabs") },
                react.createElement(esm_Toast.Body, { className: "d-flex align-items-center justify-content-between" },
                    react.createElement("div", { className: "text-light" }, chrome.i18n.getMessage("options_unsavedChanges")),
                    react.createElement("div", { className: "d-flex gap-2" },
                        react.createElement("button", { className: "btn btn-outline-light", onClick: resetMaxTabs }, chrome.i18n.getMessage("options_discard")),
                        react.createElement("button", { className: "btn btn-light", disabled: maxTabs === "", onClick: saveMaxTabs }, chrome.i18n.getMessage("options_save"))))))));
}

// EXTERNAL MODULE: ./node_modules/timeago.js/lib/lang/index.js
var lang = __webpack_require__(6827);
;// CONCATENATED MODULE: ./app/js/timeagoLocale.ts

const timeagoLocale = {
    get ar() {
        return lang.ar;
    },
    get be() {
        return lang.be;
    },
    get bg() {
        return lang.bg;
    },
    get ca() {
        return lang.ca;
    },
    get de() {
        return lang.de;
    },
    get el() {
        return lang.el;
    },
    get en() {
        return lang/* en_US */.Bh;
    },
    get en_short() {
        return lang/* en_short */.x9;
    },
    get es() {
        return lang.es;
    },
    get eu() {
        return lang.eu;
    },
    get fa() {
        return lang.fa;
    },
    get fi() {
        return lang.fi;
    },
    get fr() {
        return lang.fr;
    },
    get he() {
        return lang.he;
    },
    get hu() {
        return lang.hu;
    },
    get in_BG() {
        return lang/* bn_IN */.Dd;
    },
    get in_HI() {
        return lang/* hi_IN */.Ih;
    },
    get in_ID() {
        return lang/* id_ID */.EN;
    },
    get it() {
        return lang.it;
    },
    get ja() {
        return lang.ja;
    },
    get ko() {
        return lang.ko;
    },
    get ml() {
        return lang.ml;
    },
    get my() {
        return lang.my;
    },
    get nb_NO() {
        return lang/* nb_NO */.Fo;
    },
    get nl() {
        return lang.nl;
    },
    get nn_NO() {
        return lang/* nn_NO */.$h;
    },
    get pl() {
        return lang.pl;
    },
    get pt_BR() {
        return lang/* pt_BR */.iR;
    },
    get ro() {
        return lang.ro;
    },
    get ru() {
        return lang.ru;
    },
    get sv() {
        return lang.sv;
    },
    get ta() {
        return lang.ta;
    },
    get th() {
        return lang.th;
    },
    get tr() {
        return lang.tr;
    },
    get uk() {
        return lang.uk;
    },
    get vi() {
        return lang.vi;
    },
    get zh_CN() {
        return lang/* zh_CN */.xC;
    },
    get zh_TW() {
        return lang/* zh_TW */.lm;
    },
};
/* harmony default export */ const js_timeagoLocale = (timeagoLocale);

;// CONCATENATED MODULE: ./app/js/Popup.tsx









function Popup() {
    const { data: storageSyncPersistData } = useStorageSyncPersistQuery();
    react.useEffect(() => {
        // Configure Timeago to use the current UI language of the browser.
        const uiLanguage = chrome.i18n.getUILanguage();
        register(uiLanguage, js_timeagoLocale[uiLanguage]);
    }, []);
    // Apply a color theme to <html> using [Bootstrap's Color Mode][0]. The applied data attribute
    // must be named `data-bs-theme` and match either "light" or "dark".
    //
    // [0]: https://getbootstrap.com/docs/5.3/customize/color-modes/
    react.useEffect(() => {
        function setTheme(prefersDark) {
            const storedTheme = storageSyncPersistData === null || storageSyncPersistData === void 0 ? void 0 : storageSyncPersistData.theme;
            let theme;
            if (storedTheme != null && storedTheme !== "system") {
                theme = storedTheme;
            }
            else {
                theme = prefersDark ? "dark" : "light";
            }
            if (theme === "light" || theme === "dark")
                document.documentElement.setAttribute("data-bs-theme", theme);
            else
                document.documentElement.removeAttribute("data-bs-theme");
        }
        function handlePrefersDarkChange(event) {
            setTheme(event.matches);
        }
        // Check current color scheme preference and listen for changes.
        const prefersDarkQL = window.matchMedia("(prefers-color-scheme: dark)");
        setTheme(prefersDarkQL.matches);
        prefersDarkQL.addEventListener("change", handlePrefersDarkChange);
        return () => {
            prefersDarkQL.removeEventListener("change", handlePrefersDarkChange);
        };
    }, [storageSyncPersistData === null || storageSyncPersistData === void 0 ? void 0 : storageSyncPersistData.theme]);
    const [activeTabId, setActiveTabId] = react.useState("corral");
    let activeTab;
    switch (activeTabId) {
        case "about":
            activeTab = react.createElement(AboutTab, null);
            break;
        case "corral":
            activeTab = react.createElement(CorralTab, null);
            break;
        case "lock":
            activeTab = react.createElement(LockTab, null);
            break;
        case "options":
            activeTab = react.createElement(OptionsTab, null);
            break;
    }
    return (react.createElement(react.Fragment, null,
        react.createElement(NavBar, { activeTabId: activeTabId, onClickTab: setActiveTabId }),
        react.createElement("div", { className: "tab-content container-fluid" }, activeTab)));
}

// EXTERNAL MODULE: ./node_modules/react-dom/client.js
var client = __webpack_require__(5338);
;// CONCATENATED MODULE: ./app/popup.tsx









const queryClient = new QueryClient();
function PopupWrapper() {
    const [isDelayed, setIsDelayed] = react.useState(false);
    const [isSettingsInit, setIsSettingsInit] = react.useState(false);
    react.useEffect(() => {
        const timeout = setTimeout(() => {
            setIsDelayed(true);
        }, 2500);
        return () => {
            clearTimeout(timeout);
        };
    }, []);
    react.useEffect(() => {
        async function initSettings() {
            // Await settings that are loaded from async browser storage before rendering.
            console.debug("[PopupWrapper]: awaiting settings.init");
            await js_settings.init();
            console.debug("[PopupWrapper]: settings ready!");
            setIsSettingsInit(true);
        }
        initSettings();
    }, []);
    const isReady = isSettingsInit;
    if (!isReady && !isDelayed) {
        // Render nothing initially, this happens every time the popup is opened. Start with nothing so
        // there is no flash of unneeded UI if the popup is going to render correctly.
        return react.createElement(react.Fragment, null);
    }
    else if (!isReady) {
        // If there is a delay in initializing the connection to the background script, give the user
        // the ability to refresh the runtime and restart that background script. This is for the
        // rare case of https://crbug.com/1316588 not restarting the background script.
        return (react.createElement("div", { style: { margin: "0.75em 1em" } },
            react.createElement("div", { style: { marginBottom: "0.75em" } }, "Loading\u2026"),
            react.createElement("button", { onClick: () => {
                    chrome.runtime.sendMessage("reload");
                } }, "Reload \uD83D\uDD04")));
    }
    else {
        // When everything is initialized as expected, render normally.
        return (react.createElement(QueryClientProvider, { client: queryClient },
            react.createElement(Popup, null)));
    }
}
const popupElement = document.getElementById("popup");
if (popupElement == null)
    throw new Error("Could not find #popup element. Re-open the popup to try again.");
const root = (0,client/* createRoot */.H)(popupElement);
root.render(react.createElement(PopupWrapper, null));
// The popup fires `pagehide` when the popup is going away. Make sure to unmount the component so
// it can unsubscribe from the Store events.
const unmountPopup = function unmountPopup() {
    root.unmount();
    window.removeEventListener("pagehide", unmountPopup);
};
window.addEventListener("pagehide", unmountPopup);

})();

/******/ })()
;