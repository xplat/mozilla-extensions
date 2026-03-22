'use strict';

// The popup's only job now is to open a viewer tab where the user can pick
// a file. All file reading happens inside the viewer tab itself, so there's
// no cross-context transfer problem at all.
document.getElementById('open-btn').addEventListener('click', function() {
  chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
  window.close();
});
