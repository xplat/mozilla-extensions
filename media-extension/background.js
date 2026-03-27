// background.js — Media Viewer background script (MV3, Firefox)
'use strict';

const VIEWER_HTML = chrome.runtime.getURL('viewer.html');
const HOST_NAME   = 'media_viewer_host';

// Fixed loopback address distinct from the CBZ viewer's 127.7.203.66.
// All of 127.0.0.0/8 is loopback on Linux/macOS; this specific address is
// unlikely to conflict with anything real, and file paths won't leak off the
// machine if redirect handling has a bug.
const LOOPBACK = '127.7.203.98';

// Proxy URL prefixes used by the viewer.  The background rewrites every
// request to the real server URL (with port + token) on the fly, so neither
// the port nor the token ever appear in the viewer page or its URL.
const FILE_PROXY_PREFIX      = 'http://' + LOOPBACK + '/media-file/';
const DIR_PROXY_PREFIX       = 'http://' + LOOPBACK + '/media-dir/';
const THUMB_PROXY_PREFIX     = 'http://' + LOOPBACK + '/media-thumb/';
const QUEUE_DIR_PROXY_PREFIX = 'http://' + LOOPBACK + '/media-queue-dir/';

// ── Per-request proxy redirect ────────────────────────────────────────────

chrome.webRequest.onBeforeRequest.addListener(
  function(details) {
    // Only allow requests originating from our own extension pages.
    var origin = details.originUrl || details.documentUrl || '';
    if (!origin.startsWith(chrome.runtime.getURL(''))) {
      return { cancel: true };
    }

    if (!serverPort || !serverToken) {
      return { cancel: true };
    }

    var url = details.url;
    var encodedPath;

    if (url.startsWith(FILE_PROXY_PREFIX)) {
      encodedPath = url.slice(FILE_PROXY_PREFIX.length);
      return {
        redirectUrl: 'http://' + LOOPBACK + ':' + serverPort +
                     '/' + serverToken + '/media-file/' + encodedPath
      };
    }

    if (url.startsWith(DIR_PROXY_PREFIX)) {
      encodedPath = url.slice(DIR_PROXY_PREFIX.length);
      return {
        redirectUrl: 'http://' + LOOPBACK + ':' + serverPort +
                     '/' + serverToken + '/media-dir/' + encodedPath
      };
    }

    if (url.startsWith(THUMB_PROXY_PREFIX)) {
      encodedPath = url.slice(THUMB_PROXY_PREFIX.length);
      return {
        redirectUrl: 'http://' + LOOPBACK + ':' + serverPort +
                     '/' + serverToken + '/media-thumb/' + encodedPath
      };
    }

    if (url.startsWith(QUEUE_DIR_PROXY_PREFIX)) {
      encodedPath = url.slice(QUEUE_DIR_PROXY_PREFIX.length);
      return {
        redirectUrl: 'http://' + LOOPBACK + ':' + serverPort +
                     '/' + serverToken + '/media-queue-dir/' + encodedPath
      };
    }

    return { cancel: true };
  },
  {
    urls: [FILE_PROXY_PREFIX + '*', DIR_PROXY_PREFIX + '*',
           THUMB_PROXY_PREFIX + '*', QUEUE_DIR_PROXY_PREFIX + '*'],
    types: ['xmlhttprequest', 'image', 'media', 'other']
  },
  ['blocking']
);

// ── Native messaging ──────────────────────────────────────────────────────

function handleNativeOpen(msg) {
  // Build a file:// URL for the directory (stable, pasteable).
  // Encode each path segment so spaces/special chars are valid in the URL.
  var dirPath    = msg.dir  || '';
  var fileName   = msg.file || '';
  var encodedDir = dirPath.split('/').map(encodeURIComponent).join('/');
  var dirUrl     = 'file://' + encodedDir;

  var viewerUrl  = VIEWER_HTML + '?dir=' + encodeURIComponent(dirUrl);
  if (fileName) {
    viewerUrl += '&file=' + encodeURIComponent(fileName);
  }
  chrome.tabs.create({ url: viewerUrl });
}

// handleNativeOpen and HOST_NAME are defined above; load shared plumbing.
// importScripts is only available in service-worker contexts (Chrome MV3);
// in Firefox MV3 event-page contexts it is undefined, and native-messaging.js
// is instead listed first in the manifest's background.scripts array.
if (typeof importScripts !== 'undefined') importScripts('native-messaging.js');
connectNative();

// ── Audio queue engine ────────────────────────────────────────────────────
//
// The audio queue plays here in the background script (Firefox MV3 event
// pages have a full DOM, including HTMLAudioElement).  Files are served via
// the same loopback proxy used by the viewer tabs.
//
// State layout:
//   _aq  { items: [{dir, file}, …], index, time }  — audio queue
//   _vq  { items: [{dir, file}, …], index }         — video queue
//     (video plays in the viewer tab; we only track list + position here)
//
// _aqPlaying   = true  means the user wants the queue to be playing.
//                It stays true even while _aqSuppressed is true.
// _aqSuppressed = true means foreground audio is playing and we've paused
//                temporarily; will auto-resume on 'media-stopped'.

var _aq = { items: [], index: 0, time: 0 };
var _vq = { items: [], index: 0 };
var _aqPlaying    = false;
var _aqSuppressed = false;

var _queueAudio = new Audio();

// Proxy URL helper — mirrors viewer.js toProxyFile().
function _toProxyFile(fileUrl) {
  var path    = fileUrl.replace(/^file:\/\//, '');
  var encoded = path.split('/').map(encodeURIComponent).join('/');
  return FILE_PROXY_PREFIX + encoded;
}

// ── State persistence ─────────────────────────────────────────────────────

function _loadQueueState() {
  try {
    var as = localStorage.getItem('media-audio-queue');
    if (as) _aq = JSON.parse(as);
  } catch (e) {}
  _aq.items = Array.isArray(_aq.items) ? _aq.items : [];
  _aq.index = (_aq.index > 0 && _aq.index < _aq.items.length) ? _aq.index : 0;
  _aq.time  = _aq.time  > 0 ? _aq.time  : 0;

  try {
    var vs = localStorage.getItem('media-video-queue');
    if (vs) _vq = JSON.parse(vs);
  } catch (e) {}
  _vq.items = Array.isArray(_vq.items) ? _vq.items : [];
  _vq.index = (_vq.index > 0 && _vq.index < _vq.items.length) ? _vq.index : 0;
}

function _saveQueueState() {
  if (_queueAudio.readyState > 0) _aq.time = _queueAudio.currentTime;
  try {
    localStorage.setItem('media-audio-queue', JSON.stringify(_aq));
    localStorage.setItem('media-video-queue', JSON.stringify(_vq));
  } catch (e) {}
}

var _saveTimer = null;
function _scheduleSave() {
  if (_saveTimer !== null) return;
  _saveTimer = setTimeout(function() { _saveTimer = null; _saveQueueState(); }, 5000);
}

// ── State broadcast ───────────────────────────────────────────────────────

var _queueChannel = new BroadcastChannel('media-queue');

function _currentTime() {
  return (_queueAudio.readyState > 0) ? _queueAudio.currentTime : _aq.time;
}

function _broadcastState() {
  // Items are already in localStorage (written by _saveQueueState before every
  // broadcast); we send only the volatile bits so we don't push potentially
  // large arrays through the channel on every skip or play/pause.
  _queueChannel.postMessage({
    cmd:   'q-changed',
    audio: { index: _aq.index, time: _currentTime(), playing: _aqPlaying, suppressed: _aqSuppressed },
    video: { index: _vq.index }
  });
}

// ── Audio item loader ─────────────────────────────────────────────────────

function _loadAudioItem(index, timeOffset, autoPlay) {
  if (!_aq.items.length || index < 0 || index >= _aq.items.length) {
    _queueAudio.pause();
    _queueAudio.src = '';
    _aqPlaying    = false;
    _aqSuppressed = false;
    _broadcastState();
    _saveQueueState();
    return;
  }
  var item    = _aq.items[index];
  var fileUrl = item.dir.replace(/\/$/, '') + '/' + item.file;
  _aq.index = index;
  _aq.time  = timeOffset;

  _queueAudio.src = _toProxyFile(fileUrl);

  if (timeOffset > 0) {
    _queueAudio.addEventListener('loadedmetadata', function() {
      _queueAudio.currentTime = timeOffset;
    }, { once: true });
  }

  if (autoPlay) {
    _queueAudio.play().catch(function() {
      _aqPlaying = false;
      _broadcastState();
    });
  }

  _broadcastState();
  _saveQueueState();
}

// ── Queue controls ────────────────────────────────────────────────────────

function _toggleAudioQueue() {
  if (_aqPlaying) {
    // Manual pause: stop and clear suppression flag.
    _queueAudio.pause();
    if (_queueAudio.readyState > 0) _aq.time = _queueAudio.currentTime;
    _aqPlaying    = false;
    _aqSuppressed = false;
  } else {
    if (!_aq.items.length) return;
    _aqPlaying    = true;
    _aqSuppressed = false;
    if (!_queueAudio.src) {
      _loadAudioItem(_aq.index, _aq.time, true);
      return;  // _loadAudioItem calls _broadcastState / _saveQueueState
    }
    _queueAudio.play().catch(function() {
      _aqPlaying = false;
      _broadcastState();
    });
  }
  _broadcastState();
  _saveQueueState();
}

// delta: +1 = next, -1 = prev.
function _audioQueueSkip(delta) {
  if (delta < 0) {
    // Prev: restart current track if past 3 s or at first item.
    var t = _currentTime();
    if (t > 3 || _aq.index === 0) {
      if (_queueAudio.readyState > 0) _queueAudio.currentTime = 0;
      _aq.time = 0;
      _broadcastState();
      _saveQueueState();
      return;
    }
  }
  var next = _aq.index + delta;
  if (next < 0) next = _aq.items.length - 1;       // manual wrap
  if (next >= _aq.items.length) next = 0;           // manual wrap
  _loadAudioItem(next, 0, _aqPlaying && !_aqSuppressed);
}

// ── Audio element events ──────────────────────────────────────────────────

_queueAudio.addEventListener('ended', function() {
  var next = _aq.index + 1;
  if (next >= _aq.items.length) {
    // End of queue — stop and rewind to beginning.
    _queueAudio.src = '';
    _aqPlaying = false;
    _aq.index  = 0;
    _aq.time   = 0;
    _broadcastState();
    _saveQueueState();
  } else {
    _loadAudioItem(next, 0, true);
  }
});

_queueAudio.addEventListener('timeupdate', _scheduleSave);

_queueAudio.addEventListener('error', function() {
  // Skip over unplayable item rather than stalling.
  var next = _aq.index + 1;
  if (next < _aq.items.length) {
    _loadAudioItem(next, 0, _aqPlaying && !_aqSuppressed);
  } else {
    _queueAudio.src = '';
    _aqPlaying = false;
    _broadcastState();
    _saveQueueState();
  }
});

// ── Queue commands from viewer tabs ───────────────────────────────────────

_queueChannel.onmessage = function(e) {
  if (!e.data) return;
  var d = e.data;
  switch (d.cmd) {
    case 'q-add':
      if (d.type === 'audio') {
        _aq.items = _aq.items.concat(d.items || []);
      } else if (d.type === 'video') {
        _vq.items = _vq.items.concat(d.items || []);
      }
      _saveQueueState();
      _broadcastState();
      break;

    case 'q-toggle':
      _toggleAudioQueue();
      break;

    case 'q-skip':
      _audioQueueSkip(d.delta || 1);
      break;

    case 'q-jump':
      if (d.type === 'audio') {
        _loadAudioItem(d.index, 0, _aqPlaying && !_aqSuppressed);
      } else if (d.type === 'video') {
        _vq.index = Math.max(0, Math.min(_vq.items.length - 1, d.index));
        _saveQueueState();
        _broadcastState();
      }
      break;

    case 'q-clear':
      if (d.type === 'audio') {
        _queueAudio.pause();
        _queueAudio.src = '';
        _aqPlaying    = false;
        _aqSuppressed = false;
        _aq = { items: [], index: 0, time: 0 };
      } else if (d.type === 'video') {
        _vq = { items: [], index: 0 };
      }
      _saveQueueState();
      _broadcastState();
      break;

    case 'q-sync':
      _broadcastState();
      break;
  }
};

// ── Foreground-audio suppression ──────────────────────────────────────────
//
// When a viewer tab starts playing audio ('pause' on media-viewer channel),
// we pause the audio queue (_aqSuppressed = true, _aqPlaying stays true).
// When foreground audio ends ('media-stopped'), we auto-resume.
// When a tab is removed we tentatively resume; if another tab is still
// playing it will re-suppress on its next 'pause' broadcast.

var _viewerChannel = new BroadcastChannel('media-viewer');

_viewerChannel.onmessage = function(e) {
  if (!e.data) return;
  if (e.data.cmd === 'pause' && _aqPlaying && !_aqSuppressed) {
    _queueAudio.pause();
    _aqSuppressed = true;
    _broadcastState();
  } else if (e.data.cmd === 'media-stopped' && _aqSuppressed) {
    _aqSuppressed = false;
    _queueAudio.play().catch(function() {
      _aqPlaying = false;
      _broadcastState();
    });
    _broadcastState();
  }
};

chrome.tabs.onRemoved.addListener(function() {
  if (_aqSuppressed) {
    _aqSuppressed = false;
    _queueAudio.play().catch(function() {
      _aqPlaying = false;
      _broadcastState();
    });
    _broadcastState();
  }
});

// ── Popup message handler ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (!msg || !msg.cmd) return false;

  function state() {
    return {
      audio: { index: _aq.index, time: _currentTime(), playing: _aqPlaying, suppressed: _aqSuppressed },
      video: { index: _vq.index }
    };
  }

  switch (msg.cmd) {
    case 'q-get-state':
      sendResponse(state());
      return true;
    case 'q-toggle':
      _toggleAudioQueue();
      sendResponse(state());
      return true;
    case 'q-skip':
      _audioQueueSkip(msg.delta || 1);
      sendResponse(state());
      return true;
  }
  return false;
});

// ── Initialise ────────────────────────────────────────────────────────────

_loadQueueState();
// Restore audio queue to saved position without autoplaying on startup.
if (_aq.items.length > 0) {
  _loadAudioItem(_aq.index, _aq.time, false);
}
