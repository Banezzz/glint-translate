// Whole-page bilingual translation and the floating ball. Runs as a classic
// content script after page-styles.js, icons.js and dom.js; only the top
// frame translates its page.
//
// The page is split into paragraph units: runs of inline content inside a
// block element. Units are translated lazily as they scroll into view, in
// batches, and each translation is inserted right after its source as a
// <glint-tr> element, so the original layout and styles carry over.
(() => {
  if (window.top !== window || !(document.documentElement instanceof HTMLElement)) return;

  // Replace a stale copy of this script (e.g. after the extension updated).
  document.dispatchEvent(new CustomEvent('glint:page-teardown'));

  const { h, icon, alive } = GLINT_DOM;
  const PORT_NAME = 'glint:page';
  const POSITION_KEY = 'ballPosition';
  const DEFAULTS = { targetLang: 'zh-CN', theme: 'auto', floatBall: true, ballDisabledSites: [], pageStyle: 'dashed' };
  const SETTINGS_ERRORS = new Set(['not_configured', 'auth', 'network', 'http_400', 'http_401', 'http_403', 'http_404']);
  const BATCH_SEGMENTS = 10;
  const BATCH_CHARS = 2000;
  const MAX_UNIT_CHARS = 5000;
  const MAX_IN_FLIGHT = 3;
  // Units whose text keeps changing (clocks, counters) stop being re-translated.
  const MAX_CHURN = 4;

  const OWN_TAGS = new Set(['GLINT-TR', 'GLINT-TRANSLATE', 'GLINT-BALL']);
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'META', 'LINK',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'BUTTON', 'PRE', 'CODE', 'KBD', 'SAMP', 'VAR',
    'SVG', 'MATH', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO', 'IMG', 'PICTURE',
  ]);
  const SKIP_SELECTOR = [
    ...[...SKIP_TAGS].map((tag) => tag.toLowerCase()),
    '[translate="no"]', '.notranslate', '[contenteditable]:not([contenteditable="false"])',
    'glint-tr', 'glint-translate', 'glint-ball',
  ].join(',');
  const INLINE_DISPLAYS = new Set(['inline', 'inline-block', 'inline-flex', 'inline-grid', 'contents', 'ruby', 'ruby-text']);
  const HEADINGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');

  let settings = { ...DEFAULTS };
  let active = false;
  let sheet = null;
  let port = null;
  let batchSeq = 0;
  let pumpQueued = false;
  let scanTimer = 0;
  let lastError = null;
  // Set by configuration-type errors: further requests would fail the same way.
  let halted = null;
  // Root element -> units found in it that wait to scroll into view.
  const pendingByRoot = new Map();
  // Element actually observed (a root without a box uses its ancestor) -> roots.
  const rootsByTarget = new Map();
  const queue = [];
  // Source text -> units waiting for it; each text is requested once.
  const waiting = new Map();
  const inFlight = new Map();
  // Source text -> translation, for the current target language.
  const translations = new Map();
  const churn = new WeakMap();
  const dirty = new Set();
  const cleanups = [];

  const intersection = new IntersectionObserver(onIntersect, { rootMargin: '600px 0px' });
  const mutations = new MutationObserver(onMutations);

  // ---------------------------------------------------------------- helpers

  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  }

  function primary(code) {
    return String(code || '').toLowerCase().split(/[-_]/)[0];
  }

  function count(text, re) {
    return (text.match(re) || []).length;
  }

  function worthTranslating(text) {
    if (count(text, /\p{L}/gu) < 2 && !/\p{Script=Han}/u.test(text)) return false;
    // File names, hashes, versions, domains, handles: one ASCII token with
    // digits or punctuation in it.
    return !(/^[\x21-\x7e]+$/.test(text) && /[\d._/@#:\\=]/.test(text));
  }

  // Cheap check that a paragraph is already written in the target language.
  // Latin-script targets cannot be told apart by script, so for them the
  // model copies such text unchanged and the copy is hidden afterwards.
  function inTargetLanguage(text) {
    const target = primary(settings.targetLang);
    const letters = count(text, /\p{L}/gu) || 1;
    const share = (re) => count(text, re) / letters;
    const kana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
    switch (target) {
      case 'zh': return !kana && share(/\p{Script=Han}/gu) > 0.5;
      case 'ja': return kana;
      case 'ko': return share(/\p{Script=Hangul}/gu) > 0.5;
      case 'ru': return share(/\p{Script=Cyrillic}/gu) > 0.5;
      case 'ar': return share(/\p{Script=Arabic}/gu) > 0.5;
      case 'th': return share(/\p{Script=Thai}/gu) > 0.5;
      default: return primary(document.documentElement.lang) === target && share(/\p{Script=Latin}/gu) > 0.5;
    }
  }

  function normalize(text) {
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function owned(node) {
    const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return Boolean(el?.closest('glint-tr, glint-translate, glint-ball'));
  }

  // ------------------------------------------------------------- scanning

  // Each scan memoizes computed display values; layout does not change
  // within one synchronous scan.
  function displayOf(el, memo) {
    let value = memo.display.get(el);
    if (value === undefined) {
      value = getComputedStyle(el).display;
      memo.display.set(el, value);
    }
    return value;
  }

  function skippable(el) {
    if (SKIP_TAGS.has(el.tagName.toUpperCase())) return true;
    if (el === document.body) return false;
    return el.getAttribute('translate') === 'no' || el.classList.contains('notranslate') || el.getAttribute('aria-hidden') === 'true' || el.isContentEditable;
  }

  // An element whose whole subtree flows as inline content (a link, an
  // emphasis…) belongs to the surrounding paragraph.
  function isInlineTree(el, memo) {
    let result = memo.inline.get(el);
    if (result !== undefined) return result;
    const display = displayOf(el, memo);
    result = display === 'none' || OWN_TAGS.has(el.tagName) || INLINE_DISPLAYS.has(display);
    if (result && display !== 'none' && !OWN_TAGS.has(el.tagName) && !skippable(el)) {
      for (const child of el.children) {
        if (!isInlineTree(child, memo)) {
          result = false;
          break;
        }
      }
    }
    memo.inline.set(el, result);
    return result;
  }

  function textOf(nodes, memo) {
    let out = '';
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.data.replace(/\s+/g, ' ');
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === 'BR') out += '\n';
        else if (node.tagName === 'CODE' || node.tagName === 'KBD' || node.tagName === 'SAMP' || node.tagName === 'VAR') out += node.textContent;
        else if (!OWN_TAGS.has(node.tagName) && !skippable(node) && displayOf(node, memo) !== 'none') node.childNodes.forEach(walk);
      }
    };
    nodes.forEach(walk);
    return out.replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function isBlank(node) {
    return node.nodeType === Node.TEXT_NODE && !node.data.trim();
  }

  function makeUnit(root, run, memo) {
    let start = 0;
    let end = run.length - 1;
    while (start <= end && isBlank(run[start])) start++;
    while (end >= start && isBlank(run[end])) end--;
    if (start > end) return null;
    const nodes = run.slice(start, end + 1);
    // A lone code span is not prose.
    if (nodes.length === 1 && nodes[0].nodeType === Node.ELEMENT_NODE && skippable(nodes[0])) return null;
    const text = textOf(nodes, memo).slice(0, MAX_UNIT_CHARS);
    if (!worthTranslating(text) || inTargetLanguage(text)) return null;

    const next = nodes.at(-1).nextSibling;
    if (next?.tagName === 'GLINT-TR') {
      if (next.glintSource === text) return null;
      // The page changed the text under an existing translation.
      next.remove();
      const changes = (churn.get(root) || 0) + 1;
      churn.set(root, changes);
      if (changes > MAX_CHURN) return null;
    }
    return { root, nodes, text, wrapper: null, retries: 0 };
  }

  function collect(root, memo) {
    const units = [];
    let run = [];
    const flush = () => {
      const unit = makeUnit(root, run, memo);
      if (unit) units.push(unit);
      run = [];
    };
    for (const child of root.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        run.push(child);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (child.tagName === 'GLINT-TR') {
        flush();
        continue;
      }
      if (OWN_TAGS.has(child.tagName)) continue;
      const display = displayOf(child, memo);
      if (skippable(child)) {
        // Inline code or icons stay part of the sentence around them.
        if (INLINE_DISPLAYS.has(display)) run.push(child);
        else if (display !== 'none') flush();
        continue;
      }
      if (display === 'none') {
        // Hidden menus, tabs and dialogs: their paragraphs get translated
        // once they are shown and scroll into view.
        if (child.firstChild) collect(child, memo);
        continue;
      }
      if (isInlineTree(child, memo)) {
        run.push(child);
      } else {
        flush();
        collect(child, memo);
      }
    }
    flush();
    register(root, units, memo);
  }

  function register(root, units, memo) {
    const previous = pendingByRoot.has(root);
    if (units.length) pendingByRoot.set(root, units);
    else pendingByRoot.delete(root);
    if (units.length && !previous) {
      // display: contents elements have no box to observe.
      let target = root;
      while (target.parentElement && displayOf(target, memo) === 'contents') target = target.parentElement;
      let roots = rootsByTarget.get(target);
      if (!roots) {
        roots = new Set();
        rootsByTarget.set(target, roots);
        intersection.observe(target);
      }
      roots.add(root);
    }
  }

  function newMemo() {
    return { display: new Map(), inline: new Map() };
  }

  function scanAll() {
    if (document.body) collect(document.body, newMemo());
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      if (!active) return;
      const memo = newMemo();
      const roots = new Set();
      for (const node of dirty) {
        let el = node;
        if (!el?.isConnected || el.closest(SKIP_SELECTOR)) continue;
        // Inline content belongs to the paragraph of its block ancestor.
        while (el !== document.body && el.parentElement && isInlineTree(el, memo)) el = el.parentElement;
        roots.add(el);
      }
      dirty.clear();
      const list = [...roots];
      for (const el of list) {
        if (!list.some((other) => other !== el && other.contains(el))) collect(el, memo);
      }
    }, 300);
  }

  function onMutations(records) {
    for (const record of records) {
      if (owned(record.target)) continue;
      if (record.type === 'childList') {
        const foreign = [...record.addedNodes].some((n) => !OWN_TAGS.has(n.tagName));
        // Our own wrappers are removed only while the observer is off, or
        // by makeUnit (which rescans anyway); anything else is the page.
        const lost = [...record.removedNodes].some((n) => n.tagName === 'GLINT-TR');
        const removedText = [...record.removedNodes].some((n) => !OWN_TAGS.has(n.tagName));
        if (!foreign && !lost && !removedText) continue;
        dirty.add(record.target);
      } else if (record.target.parentElement) {
        dirty.add(record.target.parentElement);
      }
    }
    if (dirty.size) scheduleScan();
  }

  function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const roots = rootsByTarget.get(entry.target);
      rootsByTarget.delete(entry.target);
      intersection.unobserve(entry.target);
      for (const root of roots || []) {
        const units = pendingByRoot.get(root);
        pendingByRoot.delete(root);
        for (const unit of units || []) enqueue(unit);
      }
    }
    renderBall();
  }

  // ------------------------------------------------------------ rendering

  function ensureSheet() {
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(GLINT_PAGE_CSS);
    }
    if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }

  function insertWrapper(unit) {
    const last = unit.nodes.at(-1);
    const short = unit.text.length <= 24 && !unit.text.includes('\n');
    // Single-line UI (truncated cells, tabs) keeps its height: the
    // translation follows on the same line and is clipped with it.
    const singleLine = /nowrap|pre$/.test(getComputedStyle(unit.root).whiteSpace);
    const mode = (short && !HEADINGS.has(unit.root.tagName)) || singleLine ? 'inline' : 'block';
    const wrapper = h(
      'glint-tr',
      {
        'data-glint-mode': mode,
        'data-glint-state': 'loading',
        'data-glint-style': settings.pageStyle,
        lang: settings.targetLang,
        translate: 'no',
        onclick: (event) => {
          if (wrapper.dataset.glintState !== 'error') return;
          // Retrying must not follow a link the paragraph sits in.
          event.preventDefault();
          event.stopPropagation();
          retry(unit);
        },
      },
      h('glint-tr-text'),
    );
    wrapper.glintSource = unit.text;
    last.after(wrapper);
    unit.wrapper = wrapper;
  }

  function enqueue(unit) {
    if (!active || !unit.nodes.every((node) => node.isConnected)) return;
    if (!unit.wrapper) insertWrapper(unit);
    const cached = translations.get(unit.text);
    if (cached !== undefined) {
      fill(unit, cached);
      return;
    }
    if (halted) {
      fail(unit, halted);
      return;
    }
    queue.push(unit);
    schedulePump();
  }

  function fill(unit, translated) {
    const wrapper = unit.wrapper;
    if (!wrapper) return;
    if (normalize(translated) === normalize(unit.text)) {
      wrapper.dataset.glintState = 'same';
      return;
    }
    wrapper.firstChild.textContent = translated;
    wrapper.title = '';
    wrapper.dataset.glintState = 'done';
  }

  function fail(unit, error) {
    const wrapper = unit.wrapper;
    if (!wrapper) return;
    wrapper.dataset.glintState = 'error';
    wrapper.firstChild.textContent = '翻译失败，点击重试';
    wrapper.title = [error.message, error.detail].filter(Boolean).join('\n');
  }

  function retry(unit) {
    if (!unit.wrapper) return;
    halted = null;
    hideBubble();
    unit.retries = 0;
    unit.wrapper.dataset.glintState = 'loading';
    unit.wrapper.firstChild.textContent = '';
    unit.wrapper.title = '';
    queue.push(unit);
    schedulePump();
    renderBall();
  }

  function applyPageStyle() {
    for (const wrapper of document.querySelectorAll('glint-tr')) wrapper.dataset.glintStyle = settings.pageStyle;
  }

  // ------------------------------------------------------------ messaging

  function getPort() {
    if (port) return port;
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch {
      return null;
    }
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      // The worker may have been suspended mid-request: retry once.
      const batches = [...inFlight.values()];
      inFlight.clear();
      for (const batch of batches) settle(batch, batch.texts, { code: 'disconnected', message: '与扩展的连接已断开', detail: '请重试；若扩展刚更新过，请刷新页面' });
      renderBall();
    });
    return port;
  }

  // Everything enqueued in the same task (one intersection callback) is
  // batched together.
  function schedulePump() {
    if (pumpQueued) return;
    pumpQueued = true;
    queueMicrotask(pump);
  }

  function pump() {
    pumpQueued = false;
    while (active && inFlight.size < MAX_IN_FLIGHT && queue.length) {
      const texts = [];
      let chars = 0;
      while (queue.length) {
        const unit = queue[0];
        if (!unit.wrapper?.isConnected) {
          queue.shift();
          continue;
        }
        const cached = translations.get(unit.text);
        if (cached !== undefined) {
          queue.shift();
          fill(unit, cached);
          continue;
        }
        const pending = waiting.get(unit.text);
        if (pending) {
          // Same text already requested (repeated menu items and the like).
          queue.shift();
          pending.push(unit);
          continue;
        }
        if (texts.length && (texts.length >= BATCH_SEGMENTS || chars + unit.text.length > BATCH_CHARS)) break;
        queue.shift();
        texts.push(unit.text);
        chars += unit.text.length;
        waiting.set(unit.text, [unit]);
      }
      if (!texts.length) break;
      send({ id: ++batchSeq, texts, done: new Set() });
    }
    renderBall();
  }

  function send(batch) {
    const p = getPort();
    if (!p) {
      teardown();
      return;
    }
    inFlight.set(batch.id, batch);
    p.postMessage({ type: 'batch', id: batch.id, segments: batch.texts, title: document.title, targetLang: settings.targetLang });
  }

  // Hands the units of unfinished texts back to the queue once, or fails them.
  function settle(batch, texts, error) {
    for (const text of texts) {
      if (batch.done.has(text)) continue;
      const units = waiting.get(text) || [];
      waiting.delete(text);
      for (const unit of units) {
        if (!error.final && unit.retries < 1) {
          unit.retries++;
          queue.unshift(unit);
        } else {
          fail(unit, error);
        }
      }
    }
    if (queue.length) schedulePump();
  }

  function onPortMessage(message) {
    const batch = inFlight.get(message.id);
    if (!batch) return;
    if (message.type === 'segment') {
      const text = batch.texts[message.index];
      if (text === undefined) return;
      batch.done.add(text);
      translations.set(text, message.text);
      for (const unit of waiting.get(text) || []) fill(unit, message.text);
      waiting.delete(text);
      return;
    }
    inFlight.delete(message.id);
    if (message.type === 'done') {
      settle(batch, message.missing.map((i) => batch.texts[i]), { message: '模型没有返回这一段的译文' });
    } else if (message.type === 'error') {
      lastError = message;
      settle(batch, batch.texts, { ...message, final: true });
      if (SETTINGS_ERRORS.has(message.code) || message.code === 'http_402' || message.code === 'http_429') {
        halted = message;
        for (const unit of queue.splice(0)) fail(unit, message);
      }
      showBubble(message);
    }
    schedulePump();
    renderBall();
  }

  // ---------------------------------------------------------- start / stop

  function start() {
    if (active || !document.body) return;
    if (!alive()) return teardown();
    active = true;
    lastError = null;
    halted = null;
    hideBubble();
    ensureSheet();
    scanAll();
    mutations.observe(document.body, { childList: true, subtree: true, characterData: true });
    renderBall();
  }

  function stop() {
    if (!active) return;
    active = false;
    mutations.disconnect();
    intersection.disconnect();
    clearTimeout(scanTimer);
    scanTimer = 0;
    if (inFlight.size) {
      try {
        port?.postMessage({ type: 'cancel' });
      } catch {
        port = null;
      }
    }
    inFlight.clear();
    waiting.clear();
    queue.length = 0;
    pendingByRoot.clear();
    rootsByTarget.clear();
    dirty.clear();
    for (const wrapper of document.querySelectorAll('glint-tr')) wrapper.remove();
    hideBubble();
    renderBall();
  }

  function toggle() {
    if (active) stop();
    else start();
  }

  function status() {
    return { active, busy: active && (inFlight.size > 0 || queue.length > 0) };
  }

  // ------------------------------------------------------------------ ball

  const ball = { host: null, root: null, dock: null, button: null, tip: null, bubble: null, bubbleTimer: 0, top: null };

  function ballVisible() {
    return Boolean(settings.floatBall && !settings.ballDisabledSites.includes(location.hostname) && document.body);
  }

  function applyTheme() {
    if (!ball.root) return;
    const dark = settings.theme === 'dark' || (settings.theme === 'auto' && darkQuery.matches);
    ball.root.dataset.theme = dark ? 'dark' : 'light';
  }

  function ensureBall() {
    if (ball.host?.isConnected) return;
    ball.host = document.createElement('glint-ball');
    ball.host.style.cssText =
      'all: initial !important; position: fixed !important; top: 0 !important; right: 0 !important; ' +
      'width: 0 !important; height: 0 !important; z-index: 2147483646 !important; display: block !important;';
    const shadow = ball.host.attachShadow({ mode: 'open' });
    const ballSheet = new CSSStyleSheet();
    ballSheet.replaceSync(GLINT_BALL_CSS);
    shadow.adoptedStyleSheets = [ballSheet];

    ball.button = h(
      'button',
      {
        class: 'ball',
        type: 'button',
        onpointerdown: startBallDrag,
        // Keyboard activation; pointer clicks are handled by the drag logic.
        onclick: (event) => event.detail === 0 && toggle(),
      },
      icon('languages'),
    );
    ball.tip = h('span', { class: 'tip' });
    ball.bubble = h('div', { class: 'bubble', role: 'alert', hidden: true });
    const hide = h(
      'button',
      { class: 'hide-btn', type: 'button', title: '在此网站隐藏悬浮球（可在弹出面板中恢复）', 'aria-label': '在此网站隐藏悬浮球', onclick: hideOnSite },
      icon('close'),
    );
    ball.dock = h('div', { class: 'dock' }, ball.bubble, ball.tip, h('div', { class: 'ball-wrap' }, ball.button, hide));
    ball.root = h('div', { class: 'ball-root' }, ball.dock);
    shadow.append(ball.root);
    document.documentElement.append(ball.host);
    applyTheme();
    placeBall();
  }

  function renderBall() {
    if (!ballVisible()) {
      ball.host?.remove();
      ball.host = null;
      return;
    }
    ensureBall();
    const { busy } = status();
    const state = busy ? 'loading' : active ? 'active' : 'idle';
    ball.dock.dataset.state = state;
    const label = state === 'loading' ? '正在翻译… 点击显示原文' : active ? '显示原文' : '翻译此网页（双语对照）';
    ball.tip.textContent = label;
    ball.button.setAttribute('aria-label', label);
    const ring = ball.button.querySelector('.ring');
    if (busy && !ring) ball.button.append(h('span', { class: 'ring' }));
    else if (!busy) ring?.remove();
  }

  function placeBall() {
    if (!ball.dock) return;
    const vh = innerHeight;
    const top = Math.min(Math.max(ball.top ?? vh * 0.62, 48), vh - 48);
    ball.dock.style.top = `${top}px`;
  }

  function startBallDrag(event) {
    if (event.button !== 0) return;
    const startY = event.clientY;
    const startTop = parseFloat(ball.dock.style.top) || innerHeight * 0.62;
    let dragging = false;
    ball.button.setPointerCapture(event.pointerId);
    const move = (e) => {
      if (!dragging && Math.abs(e.clientY - startY) < 4) return;
      dragging = true;
      ball.dock.classList.add('dragging');
      ball.top = startTop + e.clientY - startY;
      placeBall();
    };
    const end = (e) => {
      ball.button.removeEventListener('pointermove', move);
      ball.button.removeEventListener('pointerup', end);
      ball.button.removeEventListener('pointercancel', end);
      ball.dock.classList.remove('dragging');
      if (dragging) {
        ball.top = parseFloat(ball.dock.style.top);
        chrome.storage.local.set({ [POSITION_KEY]: ball.top / innerHeight }).catch(() => {});
      } else if (e.type === 'pointerup') {
        if (!alive()) return teardown();
        toggle();
      }
    };
    ball.button.addEventListener('pointermove', move);
    ball.button.addEventListener('pointerup', end);
    ball.button.addEventListener('pointercancel', end);
  }

  async function hideOnSite() {
    try {
      const { settings: stored = {} } = await chrome.storage.local.get('settings');
      const sites = new Set(stored.ballDisabledSites || []);
      sites.add(location.hostname);
      await chrome.storage.local.set({ settings: { ...stored, ballDisabledSites: [...sites] } });
    } catch {
      teardown();
    }
  }

  function showBubble(error) {
    if (!ballVisible()) return;
    ensureBall();
    const actions = [];
    if (SETTINGS_ERRORS.has(error.code)) {
      actions.push(h('button', { class: 'chip-btn primary', type: 'button', onclick: openSettings }, '打开设置'));
    }
    actions.push(h('button', { class: 'chip-btn', type: 'button', onclick: hideBubble }, '知道了'));
    ball.bubble.replaceChildren(
      h('div', { class: 'bubble-title' }, error.message || '翻译失败'),
      error.detail ? h('div', { class: 'bubble-detail' }, error.detail) : null,
      h('div', { class: 'bubble-actions' }, actions),
    );
    ball.bubble.hidden = false;
    clearTimeout(ball.bubbleTimer);
    ball.bubbleTimer = setTimeout(hideBubble, 8000);
  }

  function hideBubble() {
    if (ball.bubble) ball.bubble.hidden = true;
  }

  function openSettings() {
    hideBubble();
    try {
      chrome.runtime.sendMessage({ type: 'glint:open-options' }).catch(() => {});
    } catch {
      teardown();
    }
  }

  // ------------------------------------------------------------- settings

  async function loadSettings() {
    try {
      const { settings: stored, [POSITION_KEY]: position } = await chrome.storage.local.get(['settings', POSITION_KEY]);
      settings = { ...DEFAULTS, ...(stored || {}) };
      if (typeof position === 'number') ball.top = position * innerHeight;
      renderBall();
    } catch {
      // Extension context gone.
    }
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local' || !changes.settings) return;
    const previous = settings;
    settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
    if (previous.targetLang !== settings.targetLang) {
      translations.clear();
      if (active) {
        stop();
        start();
      }
    }
    if (previous.pageStyle !== settings.pageStyle) applyPageStyle();
    applyTheme();
    renderBall();
  }

  function onRuntimeMessage(message, _sender, sendResponse) {
    if (message?.type !== 'glint:page') return;
    if (message.action === 'toggle') toggle();
    else if (message.action === 'start') start();
    else if (message.action === 'stop') stop();
    sendResponse({ ...status(), error: lastError?.message || null });
  }

  function teardown() {
    stop();
    for (const cleanup of cleanups.splice(0)) cleanup();
    try {
      port?.disconnect();
    } catch {
      // Already gone.
    }
    port = null;
    ball.host?.remove();
    ball.host = null;
    if (sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
  }

  listen(document, 'glint:page-teardown', teardown);
  listen(window, 'resize', placeBall);
  listen(darkQuery, 'change', applyTheme);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);
  cleanups.push(() => {
    try {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch {
      // Context invalidated.
    }
  });
  loadSettings();
})();
