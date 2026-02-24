// popup.js

document.addEventListener('DOMContentLoaded', () => {
  const SETTINGS_KEY = 'cgt_settings';

  const statusPill   = document.getElementById('statusPill');
  const statRendered = document.getElementById('statRendered');
  const statTotal    = document.getElementById('statTotal');
  const savingsBar   = document.getElementById('savingsBar');
  const statsDetail  = document.getElementById('statsDetail');
  const enabledChk   = document.getElementById('toggleEnabled');
  const debugChk     = document.getElementById('toggleDebug');
  const limitInput   = document.getElementById('messageLimit');

  // ── Display helpers ──────────────────────────────────────

  function setStatus(enabled) {
    statusPill.textContent = enabled ? 'active' : 'off';
    statusPill.classList.toggle('disabled', !enabled);
  }

  function showStats(total, rendered) {
    if (total > 0) {
      statTotal.textContent    = String(total);
      statRendered.textContent = String(rendered);
      const hidden = total - rendered;
      const pct    = Math.round((hidden / total) * 100);
      savingsBar.style.width = `${pct}%`;
      statsDetail.textContent = pct > 0
        ? `${pct}% of messages hidden — ${hidden} not rendered`
        : 'All messages are visible (conversation is short)';
    } else {
      statTotal.textContent    = '—';
      statRendered.textContent = '—';
      savingsBar.style.width   = '0%';
      statsDetail.textContent  = 'Open a ChatGPT conversation to see stats';
    }
  }

  // ── Settings ─────────────────────────────────────────────

  function currentSettings() {
    return {
      enabled:      enabledChk.checked,
      messageLimit: Math.min(100, Math.max(1, parseInt(limitInput.value, 10) || 20)),
      debug:        debugChk.checked
    };
  }

  function save() {
    const s = currentSettings();
    chrome.storage.sync.set({ [SETTINGS_KEY]: s });
    setStatus(s.enabled);
  }

  // Load initial state
  chrome.storage.sync.get({ [SETTINGS_KEY]: { enabled: true, messageLimit: 20, debug: false } }, (data) => {
    const s = data[SETTINGS_KEY];
    enabledChk.checked = s.enabled;
    debugChk.checked   = s.debug;
    limitInput.value   = s.messageLimit;
    setStatus(s.enabled);
  });

  enabledChk.addEventListener('change', save);
  debugChk.addEventListener('change', save);
  limitInput.addEventListener('change', () => {
    let v = parseInt(limitInput.value, 10);
    if (isNaN(v) || v < 1)  v = 1;
    if (v > 100) v = 100;
    limitInput.value = v;
    save();
  });

  // ── Stats from content script ────────────────────────────

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) return;

    const url = tab.url || '';
    const onChatGPT = url.startsWith('https://chat.openai.com/')
                   || url.startsWith('https://chatgpt.com/');

    if (!onChatGPT) { showStats(0, 0); return; }

    chrome.tabs.sendMessage(tab.id, { type: 'getStats' }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      showStats(res.totalMessages, res.renderedMessages);
      setStatus(res.enabled);
    });
  });
});
