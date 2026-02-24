// page-script.js — MAIN world, document_start
// Patches window.fetch to intercept ChatGPT API responses and trim
// conversation data BEFORE React renders it.

(function () {
  if (window.__CGT_INSTALLED__) return;
  window.__CGT_INSTALLED__ = true;

  // ── Constants ────────────────────────────────────────────────────────────────

  const CONFIG_KEY  = 'cgt_config';
  const EXTRA_KEY   = 'cgt_extra';
  const NAV_KEY     = 'cgt_nav';
  const HIDDEN_ROLES = new Set(['system', 'tool', 'thinking']);

  // ── Module state (reset on each navigation) ──────────────────────────────────

  let extra            = 0;
  let convId           = null;
  let baseline         = null;
  let warnedThisSession = false;

  // ── Logging ──────────────────────────────────────────────────────────────────

  function log(...args) {
    if (window.__CGT_DEBUG__) console.log('[CGT]', ...args);
  }

  // ── Config ───────────────────────────────────────────────────────────────────

  function readConfig() {
    const defaults = { enabled: true, messageLimit: 20, debug: false };
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (!raw) return defaults;
      const obj = JSON.parse(raw);
      return {
        enabled:      typeof obj.enabled === 'boolean'      ? obj.enabled      : defaults.enabled,
        messageLimit: Number.isFinite(obj.messageLimit) && obj.messageLimit >= 1
                        ? Math.floor(obj.messageLimit)
                        : defaults.messageLimit,
        debug:        typeof obj.debug === 'boolean'        ? obj.debug        : defaults.debug
      };
    } catch {
      return defaults;
    }
  }

  // ── Trimming ─────────────────────────────────────────────────────────────────

  function roleOf(node) {
    return node?.message?.author?.role ?? null;
  }

  function isVisible(node) {
    const role = roleOf(node);
    return role !== null && !HIDDEN_ROLES.has(role);
  }

  function countTurns(ids, mapping) {
    let turns = 0;
    let prev  = null;
    for (const id of ids) {
      if (!isVisible(mapping[id])) continue;
      const role = roleOf(mapping[id]);
      if (role !== prev) { turns++; prev = role; }
    }
    return turns;
  }

  function trim(data, limit, extraMsgs) {
    const { mapping, current_node } = data;
    if (!mapping || !current_node || !mapping[current_node]) return null;

    // 1. Collect the active branch by following parent links from current_node
    //    to the root. Guard against cycles with a visited set.
    const branch = [];
    const seen   = new Set();
    let id       = current_node;
    while (id && mapping[id] && !seen.has(id)) {
      seen.add(id);
      branch.push(id);
      id = mapping[id].parent ?? null;
    }
    branch.reverse(); // chronological: oldest → newest

    const totalTurns = countTurns(branch, mapping);
    const wantTurns  = Math.max(1, limit + extraMsgs);

    // 2. Find where to start the window by scanning backward and counting turns.
    let windowStart = 0;
    let turnsAccum  = 0;
    let prevRole    = null;
    for (let i = branch.length - 1; i >= 0; i--) {
      if (!isVisible(mapping[branch[i]])) continue;
      const role = roleOf(mapping[branch[i]]);
      if (role !== prevRole) { turnsAccum++; prevRole = role; }
      if (turnsAccum > wantTurns) { windowStart = i + 1; break; }
    }

    // 3. Collect only visible nodes inside the window
    const kept      = branch.slice(windowStart).filter(id => isVisible(mapping[id]));
    if (kept.length === 0) return null;

    const keptTurns = countTurns(kept, mapping);

    // 4. Build the new mapping, preserving the original root as a tree anchor.
    const rootId   = branch[0];
    const rootNode = rootId ? mapping[rootId] : null;
    const out      = {};

    if (rootNode && !kept.includes(rootId)) {
      out[rootId] = { ...rootNode, parent: null, children: [kept[0]] };
    }

    for (let i = 0; i < kept.length; i++) {
      const nodeId   = kept[i];
      const parentId = i === 0 ? (nodeId === rootId ? null : rootId) : kept[i - 1];
      const childId  = kept[i + 1] ?? null;
      out[nodeId] = {
        ...mapping[nodeId],
        parent:   parentId,
        children: childId ? [childId] : []
      };
    }

    const newRoot        = rootNode ? rootId : kept[0];
    const newCurrentNode = kept[kept.length - 1];
    if (!newRoot || !newCurrentNode) return null;

    return {
      mapping:          out,
      current_node:     newCurrentNode,
      root:             newRoot,
      visibleKept:      keptTurns,
      visibleTotal:     totalTurns,
      hasOlderMessages: keptTurns < totalTurns
    };
  }

  // ── Navigation handling ───────────────────────────────────────────────────────

  let lastUrl = location.href;

  function handleNavigate() {
    const currentUrl = location.href;
    if (currentUrl === lastUrl) return;
    lastUrl = currentUrl;

    convId            = null;
    baseline          = null;
    warnedThisSession = false;
    extra             = 0;
    log('Navigation → new URL:', currentUrl);
    window.postMessage({ type: 'cgt:nav' }, '*');
  }

  function patchHistory() {
    const wrap = (orig) => function (...args) {
      const result = orig.apply(this, args);
      handleNavigate();
      return result;
    };
    history.pushState    = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener('popstate', handleNavigate);
  }

  // ── Startup: synchronous flag consumption ─────────────────────────────────────

  function consumeNavigationFlags() {
    try {
      if (!sessionStorage.getItem(NAV_KEY)) return;
      const raw = localStorage.getItem(EXTRA_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.url === location.href) {
          extra = saved.extra || 0;
          log('Reload after load-older — extra:', extra);
        }
      }
      sessionStorage.removeItem(NAV_KEY);
      localStorage.removeItem(EXTRA_KEY);
    } catch { /* ignore */ }
  }

  // ── Response construction ─────────────────────────────────────────────────────

  function buildResponse(source, data) {
    // Rebuild headers, skipping any that would be wrong for the new body
    const h = new Headers();
    source.headers.forEach((val, name) => {
      if (name !== 'content-length' && name !== 'content-encoding') {
        h.append(name, val);
      }
    });
    h.set('content-type', 'application/json; charset=utf-8');

    const r = new Response(JSON.stringify(data), {
      status:     source.status,
      statusText: source.statusText,
      headers:    h
    });

    // Patch read-only properties the Response constructor doesn't accept
    for (const key of ['url', 'type']) {
      if (source[key]) {
        try { Object.defineProperty(r, key, { value: source[key] }); } catch { /* ignore */ }
      }
    }
    return r;
  }

  // ── Fetch interception ────────────────────────────────────────────────────────

  function parseRequest(resource, options) {
    if (resource instanceof Request) {
      return {
        url:    resource.url,
        method: (options?.method ?? resource.method).toUpperCase()
      };
    }
    return {
      url:    resource instanceof URL ? resource.href : String(resource),
      method: (options?.method ?? 'GET').toUpperCase()
    };
  }

  function patchFetch() {
    const native = window.fetch.bind(window);

    window.fetch = async function (...args) {
      const cfg = readConfig();
      window.__CGT_DEBUG__ = cfg.debug;

      if (!cfg.enabled) return native(...args);

      const { url: urlStr, method } = parseRequest(args[0], args[1]);
      const url = new URL(urlStr, location.href);

      if (method !== 'GET' || !url.pathname.startsWith('/backend-api/')) {
        return native(...args);
      }

      const res = await native(...args);

      try {
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('application/json')) return res;

        const json = await res.clone().json().catch(() => null);
        if (!json || !json.mapping || !json.current_node) return res;

        // Detect conversation change → reset state
        if (json.conversation_id && json.conversation_id !== convId) {
          if (convId !== null) {
            log('Conversation changed — resetting state');
            extra = 0;
          }
          convId            = json.conversation_id;
          baseline          = null;
          warnedThisSession = false;
          log('Tracking conversation:', convId);
        }

        const result = trim(json, cfg.messageLimit, extra);
        if (!result) return res;

        log(`Trimmed: ${result.visibleKept}/${result.visibleTotal} turns (limit: ${cfg.messageLimit}, extra: ${extra})`);

        // Performance warning: fire once when new turns accumulate past the limit
        if (!warnedThisSession && extra === 0) {
          if (baseline === null) {
            baseline = result.visibleTotal;
          } else if (result.visibleTotal - baseline >= cfg.messageLimit) {
            warnedThisSession = true;
            window.postMessage({
              type:    'cgt:warn',
              payload: { newTurns: result.visibleTotal - baseline, limit: cfg.messageLimit }
            }, '*');
          }
        }

        window.postMessage({
          type:    'cgt:status',
          payload: {
            totalMessages:    result.visibleTotal,
            renderedMessages: result.visibleKept,
            hasOlderMessages: result.hasOlderMessages
          }
        }, '*');

        return buildResponse(res, {
          ...json,
          mapping:      result.mapping,
          current_node: result.current_node,
          root:         result.root
        });
      } catch (err) {
        log('Fetch intercept error:', err);
        return res;
      }
    };

    log('Fetch patched');
  }

  // ── Boot ─────────────────────────────────────────────────────────────────────

  consumeNavigationFlags();
  patchHistory();
  patchFetch();

})();
