'use strict';

document.getElementById('open-btn').addEventListener('click', function() {
  document.getElementById('file-input').click();
});

document.getElementById('file-input').addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (!file) return;

  // We can't use createObjectURL here: the blob: URL is tied to the popup's
  // browsing context, which is destroyed when window.close() is called —
  // before the viewer tab has a chance to fetch it.
  //
  // Instead, read the file into an ArrayBuffer and hand it to the background
  // script via sendMessage. The background stores it keyed by a random token,
  // opens the viewer tab with that token in the URL, and the viewer exchanges
  // the token for the data via another message. The background then discards it.

  const reader = new FileReader();
  reader.onload = function() {
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    chrome.runtime.sendMessage({
      type: 'storeBlob',
      token: token,
      name: file.name,
      buffer: reader.result,   // ArrayBuffer — transferable across message boundary
    }, function() {
      const viewerUrl = chrome.runtime.getURL('viewer.html') +
        '?src=cbz-blob://' + token +
        '&name=' + encodeURIComponent(file.name);
      chrome.tabs.create({ url: viewerUrl });
      window.close();
    });
  };
  reader.onerror = function() {
    alert('Could not read file: ' + (reader.error && reader.error.message));
  };
  reader.readAsArrayBuffer(file);
});
