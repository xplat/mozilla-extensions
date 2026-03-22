'use strict';

const DEFAULTS_KEY = 'cbz_defaults';

// Load saved defaults and reflect them in the toggles
chrome.storage.local.get(DEFAULTS_KEY, data => {
  const d = data[DEFAULTS_KEY] || {};
  document.getElementById('default-two').checked = !!d.twoPage;
  document.getElementById('default-rtl').checked = !!d.rtl;
});

// Save on toggle change
function saveDefaults() {
  const obj = {};
  obj[DEFAULTS_KEY] = {
    twoPage: document.getElementById('default-two').checked,
    rtl:     document.getElementById('default-rtl').checked,
  };
  chrome.storage.local.set(obj);
  // Also write to localStorage so viewer.html (same extension origin) can
  // read defaults without any chrome.* API calls.
  try { localStorage.setItem('cbz_defaults', JSON.stringify(obj[DEFAULTS_KEY])); } catch (_) {}
}
document.getElementById('default-two').addEventListener('change', saveDefaults);
document.getElementById('default-rtl').addEventListener('change', saveDefaults);

// Open a new viewer tab
document.getElementById('open-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
  window.close();
});
