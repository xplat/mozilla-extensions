'use strict';

var statusEl = document.getElementById('queue-status');
var trackEl  = document.getElementById('queue-track');
var timeEl   = document.getElementById('queue-time');
var btnPrev  = document.getElementById('btn-prev');
var btnPlay  = document.getElementById('btn-play-pause');
var btnNext  = document.getElementById('btn-next');

function fmtTime(secs) {
  var s = Math.floor(secs), m = Math.floor(s / 60), h = Math.floor(m / 60);
  m = m % 60; s = s % 60;
  var p = function(n) { return n < 10 ? '0' + n : String(n); };
  return h > 0 ? h + ':' + p(m) + ':' + p(s) : m + ':' + p(s);
}

function _qAudioItems() {
  try { return JSON.parse(localStorage.getItem('media-audio-queue') || '{}').items || []; }
  catch (e) { return []; }
}

function render(state) {
  var a     = state.audio;
  var items = _qAudioItems();
  if (!items.length) {
    statusEl.textContent = 'QUEUE EMPTY';
    statusEl.className   = '';
    trackEl.textContent  = '';
    timeEl.textContent   = '';
    btnPlay.textContent  = '▶';
    return;
  }
  var item = items[a.index] || {};
  trackEl.textContent = (a.index + 1) + '/' + items.length + '  ' + (item.file || '');
  timeEl.textContent  = fmtTime(a.time || 0);

  if (a.suppressed) {
    statusEl.textContent = '⏸ SUPPRESSED';
    statusEl.className   = 'suppressed';
  } else if (a.playing) {
    statusEl.textContent = '▶ PLAYING';
    statusEl.className   = 'active';
  } else {
    statusEl.textContent = '⏸ PAUSED';
    statusEl.className   = '';
  }
  btnPlay.textContent = (a.playing && !a.suppressed) ? '⏸' : '▶';
}

function sendCmd(cmd, extra) {
  chrome.runtime.sendMessage(Object.assign({ cmd: cmd }, extra || {}), render);
}

btnPrev.addEventListener('click', function() { sendCmd('q-skip', { delta: -1 }); });
btnNext.addEventListener('click', function() { sendCmd('q-skip', { delta:  1 }); });
btnPlay.addEventListener('click', function() { sendCmd('q-toggle'); });

// Initial state fetch.
chrome.runtime.sendMessage({ cmd: 'q-get-state' }, render);

// Live updates via BroadcastChannel (popup shares extension origin and localStorage).
var ch = new BroadcastChannel('media-queue');
ch.onmessage = function(e) {
  if (e.data && e.data.cmd === 'q-changed') render(e.data);
};
