'use strict';

document.getElementById('open-btn').addEventListener('click', function() {
  document.getElementById('file-input').click();
});

document.getElementById('file-input').addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (!file) return;

  // createObjectURL produces a blob: URL tied to this browsing context.
  // Blob URLs are NOT accessible from other tabs/origins, but they ARE
  // accessible from extension pages (viewer.html is same extension origin
  // and can fetch() a blob: URL created anywhere in the browser session).
  // This is the standard pattern for Firefox extension file pickers.
  const blobUrl = URL.createObjectURL(file);

  const viewerUrl = chrome.runtime.getURL('viewer.html') +
    '?src=' + encodeURIComponent(blobUrl) +
    '&name=' + encodeURIComponent(file.name);

  chrome.tabs.create({ url: viewerUrl });
  // Don't revoke the blob URL — the viewer tab needs it.
  // It will be released when the browser session ends.
  window.close();
});
