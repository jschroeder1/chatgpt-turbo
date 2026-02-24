// background.js — service worker

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.storage.sync.set({
      cgt_settings: { enabled: true, messageLimit: 20, debug: false }
    });
  }
});
