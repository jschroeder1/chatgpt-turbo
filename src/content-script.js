// content-script.js — isolated world, document_idle
// Settings sync, badges, load-older button, scroll restore, popup stats.

(function () {

  // ── Constants ─────────────────────────────────────────────────────────────────

  const SETTINGS_KEY = 'cgt_settings';
  const CONFIG_KEY   = 'cgt_config';
  const EXTRA_KEY    = 'cgt_extra';
  const SCROLL_KEY   = 'cgt_scroll';
  const NAV_KEY      = 'cgt_nav';
  const BTN_ATTR     = 'data-cgt-nav';

  // ── State ─────────────────────────────────────────────────────────────────────

  let settings        = { enabled: true, messageLimit: 20, debug: false };
  let stats           = { totalMessages: 0, renderedMessages: 0, hasOlderMessages: false };
  let activeBadgeShown = false;
  let loadMoreBtn     = null;
  let btnObserver     = null;

  // ── Logging ───────────────────────────────────────────────────────────────────

  function log(...args) {
    if (settings.debug) console.log('[CGT]', ...args);
  }

  // ── Settings sync ─────────────────────────────────────────────────────────────

  // Validate and apply an incoming settings object, then mirror it to
  // localStorage so the MAIN-world page-script can read it synchronously.
  function applySettings(incoming) {
    settings = {
      enabled:      typeof incoming.enabled === 'boolean'      ? incoming.enabled      : true,
      messageLimit: Number.isFinite(incoming.messageLimit) && incoming.messageLimit >= 1
                      ? Math.floor(incoming.messageLimit)
                      : 15,
      debug:        typeof incoming.debug === 'boolean'        ? incoming.debug        : false
    };
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(settings));
    } catch { /* storage unavailable */ }
  }

  function watchSettings() {
    const fallback = { enabled: true, messageLimit: 20, debug: false };
    chrome.storage.sync.get(SETTINGS_KEY, (result) => {
      applySettings(result[SETTINGS_KEY] ?? fallback);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      const next = changes[SETTINGS_KEY]?.newValue;
      if (next) {
        applySettings(next);
        updateLoadMoreButton();
      }
    });
  }

  // ── postMessage listener ──────────────────────────────────────────────────────

  function initMessageListener() {
    window.addEventListener('message', (ev) => {
      const { type, payload } = ev.data ?? {};
      if (!type) return;

      if (type === 'cgt:status') {
        if (!payload) return;
        stats.totalMessages    = payload.totalMessages    || 0;
        stats.renderedMessages = payload.renderedMessages || 0;
        stats.hasOlderMessages = payload.hasOlderMessages || false;
        if (!activeBadgeShown && settings.enabled && stats.totalMessages > stats.renderedMessages) {
          activeBadgeShown = true;
          showActiveBadge();
        }
        updateLoadMoreButton();
        return;
      }

      if (type === 'cgt:nav') {
        stats            = { totalMessages: 0, renderedMessages: 0, hasOlderMessages: false };
        activeBadgeShown = false;
        removeLoadMoreButton();
        removePerfWarning();
        log('Nav: UI state reset');
        return;
      }

      if (type === 'cgt:warn') {
        showPerfWarning(payload);
      }
    });
  }

  // ── Popup stats handler ───────────────────────────────────────────────────────

  function initPopupListener() {
    chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
      if (msg?.type === 'getStats') {
        respond({
          totalMessages:    stats.totalMessages,
          renderedMessages: stats.renderedMessages,
          enabled:          settings.enabled
        });
        return true;
      }
    });
  }

  // ── Active badge ──────────────────────────────────────────────────────────────
  // Dark pill style, consistent with the extension's popup colour scheme.

  function showActiveBadge() {
    if (document.getElementById('cgt-active-badge')) return;
    const el = document.createElement('div');
    el.id = 'cgt-active-badge';
    Object.assign(el.style, {
      position:   'fixed',
      bottom:     '24px',
      right:      '24px',
      background: '#0e1015',
      border:     '1px solid #a78bfa',
      color:      '#a78bfa',
      padding:    '6px 14px',
      borderRadius: '999px',
      fontSize:   '12px',
      fontWeight: '500',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      boxShadow:  '0 2px 12px rgba(167, 139, 250, 0.2)',
      zIndex:     '9998',
      pointerEvents: 'none',
      opacity:    '1',
      transition: 'opacity 0.5s ease'
    });
    el.textContent = '⚡ ChatGPT Turbo Active';
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 500);
    }, 4000);
  }

  // ── Performance warning ───────────────────────────────────────────────────────
  // Amber-toned, centred at the bottom of the viewport, click or timeout to dismiss.

  function showPerfWarning(payload) {
    if (document.getElementById('cgt-perf-warning')) return;
    const el = document.createElement('div');
    el.id = 'cgt-perf-warning';
    Object.assign(el.style, {
      position:     'fixed',
      bottom:       '80px',
      left:         '50%',
      transform:    'translateX(-50%)',
      background:   '#1c1400',
      border:       '1px solid #d97706',
      color:        '#fbbf24',
      padding:      '10px 18px',
      borderRadius: '8px',
      fontSize:     '13px',
      lineHeight:   '1.45',
      fontFamily:   '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      whiteSpace:   'nowrap',
      zIndex:       '9999',
      cursor:       'pointer',
      opacity:      '1',
      transition:   'opacity 0.3s ease'
    });
    const n = payload?.newTurns ?? 'several';
    el.textContent = `⚠ ${n} new messages added — refresh to keep ChatGPT fast`;
    const dismiss = () => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    };
    el.addEventListener('click', dismiss);
    document.body.appendChild(el);
    setTimeout(dismiss, 7000);
  }

  function removePerfWarning() {
    document.getElementById('cgt-perf-warning')?.remove();
  }

  // ── Load-older button ─────────────────────────────────────────────────────────

  function getMessagesContainer() {
    return document.querySelector('article[data-testid^="conversation-turn-"]')?.parentElement ?? null;
  }

  function buildButtonLabel(btn) {
    const hidden = Math.max(0, stats.totalMessages - stats.renderedMessages);
    const limit  = settings.messageLimit || 20;
    const count  = hidden > 0 && hidden < limit ? hidden : limit;
    btn.textContent = '';
    const line1 = document.createElement('span');
    line1.style.cssText = 'display:block';
    line1.textContent = `Load ${count} previous messages`;
    const line2 = document.createElement('span');
    line2.style.cssText = 'display:block;font-size:10px;opacity:0.55;margin-top:3px';
    line2.textContent = 'adjust amount in extension settings';
    btn.appendChild(line1);
    btn.appendChild(line2);
  }

  function createLoadMoreButton() {
    const wrapper = document.createElement('div');
    wrapper.setAttribute(BTN_ATTR, 'true');
    Object.assign(wrapper.style, {
      display:        'flex',
      justifyContent: 'center',
      padding:        '18px 0 8px'
    });

    const btn = document.createElement('button');
    buildButtonLabel(btn);
    Object.assign(btn.style, {
      display:        'inline-flex',
      flexDirection:  'column',
      alignItems:     'center',
      padding:        '8px 20px',
      borderRadius:   '999px',
      fontSize:       '13px',
      fontWeight:     '500',
      color:          'inherit',
      background:     'transparent',
      border:         '1px solid currentColor',
      opacity:        '0.5',
      cursor:         'pointer',
      fontFamily:     'inherit',
      transition:     'opacity 150ms ease'
    });

    btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
    btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.5'; });
    btn.addEventListener('click', loadOlderMessages);

    wrapper.appendChild(btn);
    return wrapper;
  }

  function insertLoadMoreButton() {
    if (loadMoreBtn?.isConnected) return;

    const container = getMessagesContainer();
    if (!container) {
      setTimeout(() => { if (stats.hasOlderMessages) insertLoadMoreButton(); }, 500);
      return;
    }

    document.querySelectorAll(`[${BTN_ATTR}]`).forEach(el => el.remove());
    loadMoreBtn = createLoadMoreButton();
    container.insertBefore(loadMoreBtn, container.firstChild);
    log('Load-more button inserted');
    watchButtonRemoval(container);
  }

  function removeLoadMoreButton() {
    loadMoreBtn?.remove();
    loadMoreBtn = null;
    btnObserver?.disconnect();
    btnObserver = null;
  }

  function watchButtonRemoval(container) {
    btnObserver?.disconnect();
    btnObserver = new MutationObserver(() => {
      if (stats.hasOlderMessages && !loadMoreBtn?.isConnected) {
        log('Button removed by React — reinserting');
        loadMoreBtn = null;
        insertLoadMoreButton();
      }
    });
    btnObserver.observe(container, { childList: true });
  }

  function updateLoadMoreButton() {
    const shouldShow = stats.hasOlderMessages
      && stats.totalMessages > 0
      && stats.totalMessages > stats.renderedMessages;

    if (shouldShow && !loadMoreBtn?.isConnected) {
      insertLoadMoreButton();
    } else if (!shouldShow && loadMoreBtn?.isConnected) {
      removeLoadMoreButton();
    } else if (shouldShow && loadMoreBtn?.isConnected) {
      const btn = loadMoreBtn.querySelector('button');
      if (btn) buildButtonLabel(btn);
    }
  }

  // ── Load older messages ───────────────────────────────────────────────────────

  function loadOlderMessages() {
    const limit = settings.messageLimit || 20;
    let currentExtra = 0;
    try {
      const raw = localStorage.getItem(EXTRA_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.url === location.href) currentExtra = saved.extra || 0;
      }
    } catch { /* ignore */ }

    const newExtra = currentExtra + limit;
    log(`Requesting ${limit} more older messages (total extra: ${newExtra})`);

    saveScrollAnchor();

    try {
      sessionStorage.setItem(NAV_KEY, 'true');
      localStorage.setItem(EXTRA_KEY, JSON.stringify({ url: location.href, extra: newExtra }));
    } catch { /* ignore */ }

    location.reload();
  }

  // ── Scroll anchor save & restore ──────────────────────────────────────────────

  function saveScrollAnchor() {
    try {
      const articles = document.querySelectorAll('article[data-testid^="conversation-turn-"]');
      for (const article of articles) {
        const { top, height } = article.getBoundingClientRect();
        // First article that's at least partially in the upper viewport
        if (top >= -(height * 0.25) && top < window.innerHeight) {
          const id = article.querySelector('[data-message-id]')?.dataset.messageId
                   || article.dataset.testid;
          if (id) {
            sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ id, top }));
            log('Scroll anchor saved:', id);
          }
          break;
        }
      }
    } catch { /* ignore */ }
  }

  function restoreScrollAnchor() {
    try {
      const raw = sessionStorage.getItem(SCROLL_KEY);
      if (!raw) return false;
      const { id, top: savedTop } = JSON.parse(raw);

      const el = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`)?.closest('article')
              || document.querySelector(`article[data-testid="${CSS.escape(id)}"]`);
      if (!el) return false;

      sessionStorage.removeItem(SCROLL_KEY);

      // Snap element to top, then fine-tune to match the original viewport offset
      el.scrollIntoView({ block: 'start', behavior: 'instant' });
      const drift = el.getBoundingClientRect().top - savedTop;
      if (Math.abs(drift) > 1) {
        let node = el.parentElement;
        while (node && node !== document.documentElement) {
          const { overflowY } = getComputedStyle(node);
          if (overflowY === 'auto' || overflowY === 'scroll') {
            node.scrollTop += drift;
            break;
          }
          node = node.parentElement;
        }
      }
      log('Scroll restored to:', id);
      return true;
    } catch { /* ignore */ }
    return false;
  }

  function initScrollRestore() {
    if (!sessionStorage.getItem(SCROLL_KEY)) return;

    let attempts = 0;
    const MAX    = 10;

    function attempt() {
      const count = document.querySelectorAll('article[data-testid^="conversation-turn-"]').length;
      if (count >= 3) {
        // Enough messages rendered — try to restore
        if (!restoreScrollAnchor() && ++attempts < MAX) setTimeout(attempt, 300);
        return;
      }
      // Not ready yet — wait for articles to appear
      const obs = new MutationObserver(() => {
        const n = document.querySelectorAll('article[data-testid^="conversation-turn-"]').length;
        if (n >= 3) { obs.disconnect(); setTimeout(attempt, 50); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); attempt(); }, 3000);
    }

    attempt();
  }

  // ── Chat link interceptor ─────────────────────────────────────────────────────
  // ChatGPT is a SPA — clicking a chat link triggers a client-side route change,
  // which means no page reload and no fresh fetch for our patch to intercept.
  // We force a real navigation instead so page-script always starts clean.

  function initLinkInterceptor() {
    document.addEventListener('click', (ev) => {
      const anchor = ev.target.closest('a[href]');
      if (!anchor) return;

      let target;
      try { target = new URL(anchor.href); } catch { return; }

      // Only intercept links to a different conversation
      const goingToChat = target.pathname.startsWith('/c/');
      const differentChat = target.pathname !== location.pathname;
      if (!goingToChat || !differentChat) return;

      ev.preventDefault();
      ev.stopPropagation();

      // Clear any leftover load-older state before switching conversations
      try {
        localStorage.removeItem(EXTRA_KEY);
        sessionStorage.removeItem(NAV_KEY);
        sessionStorage.removeItem(SCROLL_KEY);
      } catch { /* ignore */ }

      location.assign(anchor.href);
    }, true); // capture phase — runs before React's handlers
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────

  watchSettings();
  initMessageListener();
  initPopupListener();
  initScrollRestore();
  initLinkInterceptor();

})();
