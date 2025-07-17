// Copyright (c) 2012 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

const animationFrames = 36;
const animationSpeed = 10; // ms

let loggedInImage = async () => {
  const request = await fetch('gmail_logged_in.png');
  const blob = await request.blob();
  return createImageBitmap(blob);
}

let canvas;
let canvasContext;

loggedInImage().then(
  img => {
    loggedInImage = img;
    canvas = new OffscreenCanvas(img.width, img.height);
    canvasContext = canvas.getContext('2d');
  }
);

const pollIntervalMin = 5;  // 5 minutes
const pollIntervalMax = 60;  // 1 hour
const requestTimeout = 1000 * 2;  // 2 seconds
let rotation = 0;

// A "loading" animation displayed while we wait for the first response from
// Gmail. This animates the badge text with a dot that cycles from left to
// right.
class LoadingAnimation {
  constructor() {
    this.timerId = 0;
    this.maxCount = 8;  // Total number of states in animation
    this.current = 0;  // Current state
    this.maxDot = 4;  // Max number of dots in animation
  }

  paintFrame() {
    let text = "";
    for (let i = 0; i < this.maxDot; i++) {
      text += (i === this.current) ? "." : " ";
    }
    if (this.current >= this.maxDot) {
      text += "";
    }

    chrome.action.setBadgeText({ text: text });
    this.current++;
    if (this.current === this.maxCount) {
      this.current = 0;
    }
  }

  start() {
    if (this.timerId) {
      return;
    }

    this.timerId = setInterval(() => {
      this.paintFrame();
    }, 100);
  }

  stop() {
    if (!this.timerId) {
      return;
    }

    clearInterval(this.timerId);
    this.timerId = 0;
  }
}

const loadingAnimation = new LoadingAnimation();

function getGmailUrl() {
  return "https://mail.google.com/mail/";
}

// Identifier used to debug the possibility of multiple instances of the
// extension making requests on behalf of a single user.
async function getInstanceId() {
  let {instanceId} = await chrome.storage.local.get('instanceId');

  if (!instanceId) {
    instanceId = 'gmc' + parseInt(Date.now() * Math.random(), 10);
    chrome.storage.local.set({instanceId});
  }

  return instanceId;
}

async function getFeedUrl() {
  // "zx" is a Gmail query parameter that is expected to contain a random
  // string and may be ignored/stripped.
  const instanceId = await getInstanceId();
  return `${getGmailUrl()}feed/atom?zx=${encodeURIComponent(instanceId)}`;
}

function isGmailUrl(url) {
  // Return whether the URL starts with the Gmail prefix.
  return url?.indexOf(getGmailUrl()) == 0;
}

async function updateIcon() {
  const {unreadCount} = await chrome.storage.local.get('unreadCount');
  if (!unreadCount) {
    chrome.action.setIcon({path:"gmail_not_logged_in.png"});
    chrome.action.setBadgeBackgroundColor({color:[190, 190, 190, 230]});
    chrome.action.setBadgeText({text:"?"});
  } else {
    chrome.action.setIcon({path: "gmail_logged_in.png"});
    chrome.action.setBadgeBackgroundColor({color:[208, 0, 24, 255]});
    chrome.action.setBadgeText({
      text: unreadCount != "0" ? unreadCount : ""
    });
  }
}

async function scheduleRequest() {
  console.log('scheduleRequest');
  const randomness = Math.random() * 2;

  let {requestFailureCount} = await chrome.storage.local.get('requestFailureCount');
  const exponent = Math.pow(2, requestFailureCount || 0);
  const multiplier = Math.max(randomness * exponent, 1);
  const delay = Math.round(Math.min(multiplier * pollIntervalMin, pollIntervalMax));
  console.log('Scheduling for: ' + delay);

  console.log('Creating alarm');
  // Use a repeating alarm so that it fires again if there was a problem
  // setting the next alarm.
  chrome.alarms.create('refresh', {periodInMinutes: delay});
}

// ajax stuff
async function startRequest(params) {
  // Schedule request immediately. We want to be sure to reschedule, even in the
  // case where the extension process shuts down while this request is
  // outstanding.
  if (params?.scheduleRequest) {
    await scheduleRequest();
  }

  function stopLoadingAnimation() {
    if (params?.showLoadingAnimation) {
      loadingAnimation.stop();
    }
  }

  if (params?.showLoadingAnimation) {
    loadingAnimation.start();
  }

  await getInboxCount(
    async (count) => {
      stopLoadingAnimation();
      await updateUnreadCount(count);
    },
    async () => {
      stopLoadingAnimation();
      await chrome.storage.local.remove('unreadCount');
      await updateIcon();
    }
  );
}

async function getInboxCount(onSuccess, onError) {

  const abortController = new AbortController();
  const signal = abortController.signal;

  const abortTimerId = setTimeout(() => {
    abortController.abort();
  }, requestTimeout);

  async function handleSuccess(count) {
    await chrome.storage.local.set({requestFailureCount: 0});
    clearTimeout(abortTimerId);
    if (onSuccess) {
      onSuccess(count);
    }
  }

  let invokedErrorCallback = false;

  async function handleError() {
    let {requestFailureCount} = await chrome.storage.local.get('requestFailureCount');
    requestFailureCount = requestFailureCount + 1

    await chrome.storage.local.set({requestFailureCount});
    clearTimeout(abortTimerId);
    if (onError && !invokedErrorCallback) {
      onError();
    }
    invokedErrorCallback = true;
  }

  try {
    fetch(await getFeedUrl(), { signal })
      .then(response => {
        if (response.ok) {
          return response.text();
        }
      })
      .then(text => {
        const {fullcount} = xmlToJson(text);

        if (!isNaN(parseInt(fullcount))) {
          handleSuccess(fullcount);
        } else {
          console.error(chrome.i18n.getMessage("gmailcheck_node_error"));
          handleError();
        }
      })
      .catch(error => {
        console.error(chrome.i18n.getMessage("gmailcheck_exception", error));
        handleError();
      });
  } catch(e) {
    console.error(chrome.i18n.getMessage("gmailcheck_exception", e));
    handleError();
  }
}

function xmlToJson(xmlString) {
    const jsonObj = {};

    const tags = xmlString.match(/(?<=<)([^\/>]+)(?=>)/g);
    const content = xmlString.match(/(?<=>)([^<]+)(?=<)/g);

    for (let i = 0; i < tags.length; i++) {
        const tag = tags[i]
        const text = content[i - 1]

        // If the tag already exists, make it an array
      if (jsonObj[tag]) {
        if (!Array.isArray(jsonObj[tag])) {
          jsonObj[tag] = [jsonObj[tag]];
        }
        jsonObj[tag].push(text);
      } else {
        jsonObj[tag] = text;
      }
    }

    return jsonObj;
}

/**
 * Updates the unread count in local storage and updates the icon.
 * @param {number} count The new unread count.
 */
async function updateUnreadCount(count) {
  const {unreadCount} = await chrome.storage.local.get('unreadCount');
  const changed = unreadCount != count;
  await chrome.storage.local.set({unreadCount: count});

  await updateIcon();
  if (changed) {
    await animateFlip();
  }
}

/**
 * Eases a value from 0 to 1.
 * @param {number} x The value to ease.
 * @return {number} The eased value.
 */
function ease(x) {
  return (1-Math.sin(Math.PI/2+x*Math.PI))/2;
}

/**
 * Animates the icon by rotating it.
 */
async function animateFlip() {
  rotation += 1/animationFrames;
  drawIconAtRotation();

  if (rotation <= 1) {
    setTimeout(animateFlip, animationSpeed);
  } else {
    rotation = 0;
    await updateIcon();
  }
}

/**
 * Draws the icon at the given rotation.
 */
function drawIconAtRotation() {
  const w = canvas.width;
  const h = canvas.height;

  canvasContext.save();
  canvasContext.clearRect(0, 0, w, h);
  canvasContext.translate(
      Math.ceil(w/2),
      Math.ceil(h/2));
  canvasContext.rotate(2*Math.PI*ease(rotation));
  canvasContext.drawImage(loggedInImage,
      -Math.ceil(w/2),
      -Math.ceil(h/2));
  canvasContext.restore();

  chrome.action.setIcon({
    imageData:canvasContext.getImageData(0, 0,w,h)
  });
}

/**
 * Opens the Gmail inbox.
 */
async function goToInbox() {
  console.log('Going to inbox...');

  chrome.tabs.query({}, async function(tabs) {
    for (let i = 0, tab; tab = tabs[i]; i++) {
      if (isGmailUrl(tab.url)) {
        console.log(`Found Gmail tab: ${tab.url}. Focusing and refreshing count...`);
        chrome.tabs.update(tab.id, {selected: true});
        chrome.windows.update( tab.windowId, { focused : true } )
        await startRequest({scheduleRequest:false, showLoadingAnimation:false});
        return;
      }
    }
    console.log('Could not find Gmail tab. Creating one...');
    chrome.tabs.create({url: getGmailUrl()});
  });
}

/**
 * Initializes the extension.
 */
async function onInit() {
  console.log('onInit');
  await chrome.storage.local.set({requestFailureCount: 0}); // used for exponential backoff
  await startRequest({scheduleRequest:true, showLoadingAnimation:true});
  chrome.alarms.create('watchdog', {periodInMinutes:5});
}

/**
 * Handles an alarm event.
 * @param {object} alarm The alarm that was triggered.
 */
async function onAlarm(alarm) {
  console.log('Got alarm', alarm);
  if (alarm?.name == 'watchdog') {
    onWatchdog();
  } else {
    await startRequest({scheduleRequest:true, showLoadingAnimation:false});
  }
}

/**
 * Checks if the refresh alarm exists. If not, it schedules a refresh.
 */
function onWatchdog() {
  chrome.alarms.get('refresh', function(alarm) {
    if (alarm) {
      console.log('Refresh alarm exists. Yay.');
    } else {
      console.log('Refresh alarm doesn\'t exist!? ' +
                  'Refreshing now and rescheduling.');
      startRequest({scheduleRequest:true, showLoadingAnimation:false});
    }
  });
}

chrome.runtime.onInstalled.addListener(onInit);
chrome.alarms.onAlarm.addListener(onAlarm);

const filters = {
  url: [{urlContains: getGmailUrl().replace(/^https?\:\/\//, '')}]
};

/**
 * Handles a navigation event.
 * @param {object} details The details of the navigation event.
 */
function onNavigate(details) {
  if (details.url && isGmailUrl(details.url)) {
    console.log('Recognized Gmail navigation to: ' + details.url + '.' +
                'Refreshing count...');
    startRequest({scheduleRequest:false, showLoadingAnimation:false});
  }
}

if (chrome.webNavigation?.onDOMContentLoaded &&
    chrome.webNavigation.onReferenceFragmentUpdated) {
  chrome.webNavigation.onDOMContentLoaded.addListener(onNavigate, filters);
  chrome.webNavigation.onReferenceFragmentUpdated.addListener(
      onNavigate, filters);
} else {
  chrome.tabs.onUpdated.addListener(function(_, details) {
    onNavigate(details);
  });
}

chrome.action.onClicked.addListener(goToInbox);

if (chrome.runtime && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(function() {
    console.log('Starting browser... updating icon.');
    startRequest({scheduleRequest:false, showLoadingAnimation:false})
      .then(updateIcon);
  });
}
