// content.js — injected into all pages at document_start
// Handles the fragment (#cbz) case where the server might serve
// a zip with a generic content-type, and the user signals CBZ via fragment.

(function () {
  'use strict';

  const url = window.location.href;
  let hash = '';
  try {
    hash = new URL(url).hash;
  } catch (e) {
    return;
  }

  // Only act on fragment-based CBZ signals
  if (hash !== '#cbz' && !hash.startsWith('#cbz&') && !hash.startsWith('#cbz=')) {
    return;
  }

  // Redirect to viewer immediately (before page renders)
  const viewerBase = chrome.runtime.getURL('viewer.html');
  const viewerUrl = `${viewerBase}?src=${encodeURIComponent(url)}`;
  window.location.replace(viewerUrl);
})();
