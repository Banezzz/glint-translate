// Selection trigger and translation card. Runs as a classic content script
// after languages.js, card-styles.js and icons.js (shared isolated world).
(() => {
  if (!(document.documentElement instanceof HTMLElement)) return;

  // Replace a stale copy of this script (e.g. after the extension updated).
  document.dispatchEvent(new CustomEvent('glint:teardown'));

  const PORT_NAME = 'glint:translate';
  const MAX_TEXT = 6000;
  const DEFAULTS = { enabled: true, targetLang: 'zh-CN', trigger: 'icon', theme: 'auto', fontSize: 15, disabledSites: [] };
  const SETTINGS_ERRORS = new Set(['not_configured', 'auth', 'network', 'http_400', 'http_401', 'http_403', 'http_404']);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');

  let settings = { ...DEFAULTS };
  let host = null;
  let root = null;
  let trigger = null;
  let triggerText = '';
  let card = null;
  const ui = {};
  let port = null;
  let seq = 0;
  // The request shown in the card: { id, text, targetOverride, status, raw, meta, error, retried }
  let current = null;
  let lastPointer = null;
  let anchor = null;
  // 'below' | 'above' the anchor, decided once per opening so a growing
  // card never flips sides mid-stream.
  let placement = null;
  let pinned = false;
  let dragged = false;
  // Speech started by this card (never cancel the page's own speech).
  let utteranceActive = false;
  const cleanups = [];

  // ---------------------------------------------------------------- helpers

  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  }

  function alive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value === null || value === undefined) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child !== null && child !== undefined && child !== false) el.append(child);
    }
    return el;
  }

  function icon(name) {
    const def = GLINT_ICONS[name];
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    if (def.fill) {
      svg.setAttribute('fill', 'currentColor');
    } else {
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.8');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
    }
    for (const d of def.paths) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  function iconButton(name, title, onclick) {
    return h('button', { class: 'icon-btn', type: 'button', title, 'aria-label': title, onclick }, icon(name));
  }

  function setIcon(button, name) {
    button.replaceChildren(icon(name));
  }

  function langInfo(code) {
    if (!code) return null;
    const lower = code.toLowerCase();
    const primary = lower.split(/[-_]/)[0];
    return (
      GLINT_LANGUAGES.find((l) => l.code.toLowerCase() === lower) ??
      GLINT_LANGUAGES.find((l) => l.code.toLowerCase().split('-')[0] === primary) ??
      null
    );
  }

  function langLabel(code) {
    if (!code || code === 'und') return '自动检测';
    if (code.toLowerCase() === 'zh') return '中文';
    return langInfo(code)?.label ?? code;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  function worthTranslating(text) {
    const t = text.trim();
    return t.length > 0 && !/^[\s\d\p{P}\p{S}]+$/u.test(t);
  }

  function siteDisabled() {
    return settings.disabledSites.includes(location.hostname);
  }

  // ------------------------------------------------------------- settings

  function applyTheme() {
    if (!root) return;
    const dark = settings.theme === 'dark' || (settings.theme === 'auto' && darkQuery.matches);
    root.dataset.theme = dark ? 'dark' : 'light';
    root.style.setProperty('--g-font-size', `${clamp(Number(settings.fontSize) || 15, 12, 22)}px`);
  }

  async function loadSettings() {
    try {
      const { settings: stored } = await chrome.storage.local.get('settings');
      settings = { ...DEFAULTS, ...(stored || {}) };
      applyTheme();
    } catch {
      // Extension context gone; teardown happens on next interaction.
    }
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local' || !changes.settings) return;
    settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
    applyTheme();
    if (!settings.enabled || siteDisabled()) hideTrigger();
  }

  // ------------------------------------------------------------- selection

  function deepActiveElement() {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  function isEditable(node) {
    const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return Boolean(el?.closest?.('input, textarea, [contenteditable]:not([contenteditable="false"])'));
  }

  function readSelection() {
    const active = deepActiveElement();
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
      try {
        const { selectionStart: start, selectionEnd: end, value } = active;
        if (typeof start === 'number' && end > start) {
          return { text: value.slice(start, end), rect: active.getBoundingClientRect(), editable: true };
        }
      } catch {
        // Input types without selection support.
      }
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const text = selection.toString();
    if (!text.trim()) return null;
    const range = selection.getRangeAt(0);
    return { text, rect: range.getBoundingClientRect(), editable: isEditable(range.commonAncestorContainer) };
  }

  // Anchor in document coordinates: below/above which the card is placed.
  function anchorFrom(rect, pointer) {
    const usable = rect && (rect.width || rect.height) && rect.bottom > 0 && rect.top < innerHeight;
    let box;
    if (usable && !(rect.height > 160 && pointer)) box = { left: rect.left, top: rect.top, bottom: rect.bottom };
    else if (pointer) box = { left: pointer.x - 24, top: pointer.y - 12, bottom: pointer.y + 12 };
    else box = { left: innerWidth / 2 - 190, top: 72, bottom: 72 };
    return { left: box.left + scrollX, top: box.top + scrollY, bottom: box.bottom + scrollY };
  }

  // --------------------------------------------------------------- DOM host

  function ensureHost() {
    if (host?.isConnected) return;
    host = document.createElement('glint-translate');
    host.style.cssText =
      'all: initial !important; position: absolute !important; top: 0 !important; left: 0 !important; ' +
      'width: 0 !important; height: 0 !important; z-index: 2147483647 !important; display: block !important;';
    const shadow = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(GLINT_CARD_CSS);
    shadow.adoptedStyleSheets = [sheet];
    root = h('div', { class: 'glint-root' });
    shadow.append(root);
    trigger = null;
    card = null;
    document.documentElement.append(host);
    applyTheme();
  }

  function insideHost(event) {
    return Boolean(host) && event.composedPath().includes(host);
  }

  // ---------------------------------------------------------------- trigger

  function showTrigger(point, text) {
    ensureHost();
    if (!trigger) {
      trigger = h('button', {
        class: 'trigger',
        type: 'button',
        title: '翻译选中文本',
        'aria-label': '翻译选中文本',
        // Keep the page selection intact while clicking.
        onmousedown: (e) => e.preventDefault(),
        onclick: () => {
          const selection = readSelection();
          const text = selection?.text.trim() ? selection.text : triggerText;
          openCard(text, anchorFrom(selection?.rect, lastPointer));
        },
      }, icon('sparkle'));
      root.append(trigger);
    }
    triggerText = text;
    const vw = document.documentElement.clientWidth || innerWidth;
    const x = clamp(point.x + 6, 4, vw - 34);
    const y = point.y + 40 > innerHeight ? point.y - 38 : point.y + 10;
    trigger.style.left = `${x + scrollX}px`;
    trigger.style.top = `${y + scrollY}px`;
    // Restart the pop-in animation.
    trigger.hidden = true;
    void trigger.offsetWidth;
    trigger.hidden = false;
  }

  function hideTrigger() {
    if (trigger) trigger.hidden = true;
  }

  // ------------------------------------------------------------------- card

  function buildCard() {
    ui.source = h('span', { class: 'lang-source' });
    ui.targetLabel = h('span');
    ui.target = h('button', { class: 'lang-target', type: 'button', title: '切换目标语言', onclick: toggleLangMenu }, ui.targetLabel, icon('chevronDown'));
    ui.menu = h('div', { class: 'lang-menu', role: 'listbox', hidden: true });
    ui.pin = iconButton('pin', '固定窗口', togglePin);
    ui.head = h(
      'header',
      { class: 'card-head' },
      h('div', { class: 'langs' }, ui.source, h('span', { class: 'lang-arrow' }, icon('arrowRight')), ui.target, ui.menu),
      h('div', { class: 'head-actions' }, ui.pin, iconButton('close', '关闭 (Esc)', closeCard)),
    );
    ui.sourceBox = h('div');
    ui.result = h('div', { class: 'result', 'aria-live': 'polite' });
    ui.body = h('div', { class: 'card-body' }, ui.sourceBox, ui.result);
    ui.model = h('span', { class: 'model' });
    ui.speak = iconButton('volume', '朗读原文', () => speak(current?.text, current?.meta?.sourceLang, ui.speak));
    ui.copy = iconButton('copy', '复制译文', copyResult);
    ui.retry = iconButton('refresh', '重新翻译', () => current && translate(current.text, current.targetOverride, true));
    const foot = h(
      'footer',
      { class: 'card-foot' },
      ui.model,
      h('div', { class: 'foot-actions' }, ui.speak, ui.copy, ui.retry, iconButton('settings', '设置', openSettings)),
    );
    card = h('section', { class: 'card', role: 'dialog', 'aria-label': 'Glint 翻译', hidden: true }, ui.head, ui.body, foot);
    root.append(card);
    ui.head.addEventListener('pointerdown', startDrag);
    new ResizeObserver(() => placeCard()).observe(card);
  }

  function cardOpen() {
    return Boolean(card && !card.hidden && card.isConnected);
  }

  function openCard(text, at) {
    if (!alive()) return teardown();
    const clean = String(text || '').trim().slice(0, MAX_TEXT);
    if (!clean) return;
    ensureHost();
    hideTrigger();
    if (!card) buildCard();
    anchor = at;
    placement = null;
    // A pinned card the user moved stays where they put it.
    if (!pinned) dragged = false;
    if (!cardOpen()) {
      card.hidden = false;
      card.style.animation = 'none';
      void card.offsetWidth;
      card.style.animation = '';
    }
    translate(clean, null, false);
    placeCard();
  }

  function closeCard() {
    if (!card) return;
    card.hidden = true;
    ui.menu.hidden = true;
    pinned = false;
    ui.pin.classList.remove('active');
    if (current && current.status !== 'done' && current.status !== 'error') safePost({ type: 'cancel' });
    current = null;
    if (utteranceActive) speechSynthesis.cancel();
  }

  function placeCard() {
    if (!cardOpen() || !anchor || dragged) return;
    const vw = document.documentElement.clientWidth || innerWidth;
    const vh = innerHeight;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const top = anchor.top - scrollY;
    const bottom = anchor.bottom - scrollY;
    if (!placement) {
      const spaceBelow = vh - bottom - 10;
      placement = spaceBelow >= Math.max(height, 220) || spaceBelow >= top - 10 ? 'below' : 'above';
    }
    const y = clamp(placement === 'below' ? bottom + 10 : top - 10 - height, 8, vh - height - 8);
    const x = clamp(anchor.left - scrollX, 8, vw - width - 8);
    card.style.left = `${x + scrollX}px`;
    card.style.top = `${y + scrollY}px`;
  }

  function startDrag(event) {
    if (event.button !== 0 || event.target.closest('button, .lang-menu')) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const left = parseFloat(card.style.left) || 0;
    const top = parseFloat(card.style.top) || 0;
    ui.head.setPointerCapture(event.pointerId);
    ui.head.classList.add('dragging');
    const move = (e) => {
      dragged = true;
      card.style.left = `${left + e.clientX - startX}px`;
      card.style.top = `${top + e.clientY - startY}px`;
    };
    const end = () => {
      ui.head.classList.remove('dragging');
      ui.head.removeEventListener('pointermove', move);
      ui.head.removeEventListener('pointerup', end);
      ui.head.removeEventListener('pointercancel', end);
    };
    ui.head.addEventListener('pointermove', move);
    ui.head.addEventListener('pointerup', end);
    ui.head.addEventListener('pointercancel', end);
  }

  function togglePin() {
    pinned = !pinned;
    ui.pin.classList.toggle('active', pinned);
    ui.pin.title = pinned ? '取消固定' : '固定窗口';
  }

  function toggleLangMenu() {
    if (!ui.menu.hidden) {
      ui.menu.hidden = true;
      return;
    }
    const selected = current?.meta?.targetLang || current?.targetOverride || settings.targetLang;
    ui.menu.replaceChildren(
      ...GLINT_LANGUAGES.map((lang) => {
        const isSelected = langInfo(selected)?.code === lang.code;
        return h(
          'button',
          {
            class: 'lang-item',
            type: 'button',
            role: 'option',
            'aria-selected': String(isSelected),
            onclick: () => {
              ui.menu.hidden = true;
              if (current) translate(current.text, lang.code, false);
            },
          },
          lang.label,
          isSelected ? icon('check') : null,
        );
      }),
    );
    ui.menu.hidden = false;
  }

  // ------------------------------------------------------------ rendering

  function render() {
    if (!current || !card) return;
    const { meta, status, mode } = current;
    ui.source.textContent = meta ? langLabel(meta.sourceLang) : status === 'error' ? '原文' : '识别中…';
    ui.targetLabel.textContent = langLabel(meta?.targetLang || current.targetOverride || settings.targetLang);
    ui.model.replaceChildren(...(meta?.model ? [h('span', { class: 'model-name', title: meta.model }, meta.model)] : []));
    ui.copy.disabled = status !== 'done';
    ui.speak.hidden = mode === 'dictionary';
    renderSource();
    renderResult();
  }

  function renderSource() {
    const { text, mode } = current;
    if (mode === 'dictionary') {
      const phonetic = GLINT_PARSE_DICTIONARY(current.raw).phonetic;
      ui.sourceBox.className = 'dict-head';
      ui.sourceBox.replaceChildren(
        h('span', { class: 'dict-word' }, text),
        phonetic ? h('span', { class: 'dict-phonetic' }, phonetic) : null,
        iconButton('volume', '朗读', (e) => speak(text, current?.meta?.sourceLang, e.currentTarget)),
      );
      return;
    }
    if (ui.sourceBox.className.startsWith('source') && ui.sourceBox.textContent === text) return;
    ui.sourceBox.className = 'source';
    ui.sourceBox.title = '点击展开 / 收起原文';
    ui.sourceBox.textContent = text;
    ui.sourceBox.onclick = () => ui.sourceBox.classList.toggle('expanded');
  }

  function renderResult() {
    const { status, raw, mode, error } = current;
    if (status === 'loading') {
      if (!ui.result.querySelector('.skeleton')) ui.result.replaceChildren(h('div', { class: 'skeleton' }, h('i'), h('i'), h('i')));
      return;
    }
    if (status === 'error') {
      ui.result.replaceChildren(errorView(error));
      return;
    }
    if (mode === 'dictionary') {
      ui.result.replaceChildren(dictionaryView(GLINT_PARSE_DICTIONARY(raw), status === 'streaming'));
      return;
    }
    let output = ui.result.querySelector('.output');
    if (!output) {
      output = h('div', { class: 'output' }, h('span'), h('span', { class: 'caret' }));
      ui.result.replaceChildren(output);
    }
    output.firstChild.textContent = raw;
    output.classList.toggle('streaming', status === 'streaming');
  }

  function dictionaryView({ rows }, streaming) {
    const view = h(
      'div',
      { class: 'dict' },
      rows.map((row) => {
        if (row.kind === 'example') return h('div', { class: 'dict-example' }, row.text);
        if (row.kind === 'pos') return h('div', { class: 'dict-row' }, h('span', { class: 'dict-pos' }, row.pos), h('span', { class: 'dict-text' }, row.text));
        return h('div', { class: 'dict-row' }, h('span', { class: 'dict-text' }, row.text));
      }),
    );
    if (streaming) (view.lastElementChild?.lastElementChild ?? view.lastElementChild ?? view).append(h('span', { class: 'caret' }));
    return view;
  }

  function errorView(error) {
    const actions = [];
    if (SETTINGS_ERRORS.has(error.code)) actions.push(h('button', { class: 'chip-btn primary', type: 'button', onclick: openSettings }, '打开设置'));
    if (error.code !== 'not_configured' && error.code !== 'context_invalidated') {
      actions.push(h('button', { class: 'chip-btn', type: 'button', onclick: () => translate(current.text, current.targetOverride, true) }, '重试'));
    }
    return h(
      'div',
      { class: 'error', role: 'alert' },
      icon('alert'),
      h(
        'div',
        { class: 'error-body' },
        h('div', { class: 'error-title' }, error.message),
        error.detail ? h('div', { class: 'error-detail' }, error.detail) : null,
        actions.length ? h('div', { class: 'error-actions' }, actions) : null,
      ),
    );
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
      if (!current || current.status === 'done' || current.status === 'error') return;
      // The worker may have been suspended mid-request: retry once.
      if (!current.retried && alive()) {
        current.retried = true;
        send(current);
      } else {
        fail({ code: 'disconnected', message: '与扩展的连接已断开', detail: '请重试；若扩展刚更新过，请刷新页面' });
      }
    });
    return port;
  }

  function safePost(message) {
    try {
      port?.postMessage(message);
    } catch {
      port = null;
    }
  }

  function send(request) {
    const p = getPort();
    if (!p) {
      fail({ code: 'context_invalidated', message: '扩展已更新或被停用', detail: '请刷新页面后再试' });
      return;
    }
    p.postMessage({
      type: 'translate',
      id: request.id,
      text: request.text,
      targetLang: request.targetOverride || undefined,
      fresh: request.fresh,
    });
  }

  function translate(text, targetOverride, fresh) {
    current = { id: ++seq, text, targetOverride, fresh, status: 'loading', raw: '', meta: null, mode: 'translate', error: null, retried: false };
    render();
    send(current);
  }

  function fail(error) {
    if (!current) return;
    current.status = 'error';
    current.error = error;
    render();
  }

  function onPortMessage(message) {
    if (!current || message.id !== current.id) return;
    switch (message.type) {
      case 'meta':
        current.meta = message;
        current.mode = message.mode;
        break;
      case 'delta':
        current.raw += message.text;
        current.status = 'streaming';
        break;
      case 'done':
        current.raw = message.text;
        current.status = 'done';
        break;
      case 'error':
        current.status = 'error';
        current.error = message;
        break;
      default:
        return;
    }
    render();
  }

  function onRuntimeMessage(message, _sender, sendResponse) {
    if (message?.type === 'glint:translate-selection') {
      // Commands go to every frame; only the focused one acts.
      const selection = document.hasFocus() ? readSelection() : null;
      if (selection && worthTranslating(selection.text)) openCard(selection.text, anchorFrom(selection.rect, lastPointer));
      sendResponse({ ok: true });
    } else if (message?.type === 'glint:show') {
      const selection = readSelection();
      const text = selection?.text.trim() ? selection.text : message.text;
      if (text?.trim()) openCard(text, anchorFrom(selection?.rect, lastPointer));
      sendResponse({ ok: true });
    }
  }

  // --------------------------------------------------------------- actions

  function openSettings() {
    try {
      chrome.runtime.sendMessage({ type: 'glint:open-options' }).catch(() => {});
    } catch {
      teardown();
    }
  }

  async function copyResult() {
    const text = current?.raw;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = h('textarea');
      area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      area.value = text;
      (document.body || document.documentElement).append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    ui.copy.classList.add('done');
    setIcon(ui.copy, 'check');
    setTimeout(() => {
      ui.copy.classList.remove('done');
      setIcon(ui.copy, 'copy');
    }, 1200);
  }

  // Toggles reading the source text aloud.
  function speak(text, lang, button) {
    if (!text) return;
    if (utteranceActive) {
      speechSynthesis.cancel();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text.slice(0, 1000));
    const info = langInfo(lang);
    if (info) utterance.lang = info.speech;
    setIcon(button, 'stop');
    button.classList.add('active');
    utterance.onend = utterance.onerror = () => {
      utteranceActive = false;
      setIcon(button, 'volume');
      button.classList.remove('active');
    };
    utteranceActive = true;
    speechSynthesis.speak(utterance);
  }

  // ---------------------------------------------------------------- events

  function onMouseUp(event) {
    if (event.button !== 0 || insideHost(event)) return;
    lastPointer = { x: event.clientX, y: event.clientY };
    // Let the browser finish updating (or collapsing) the selection first.
    setTimeout(() => {
      if (!alive()) return teardown();
      if (!settings.enabled || settings.trigger === 'manual' || siteDisabled()) return;
      const selection = readSelection();
      if (!selection || selection.editable || !worthTranslating(selection.text)) return;
      if (cardOpen() && current?.text === selection.text.trim()) return;
      if (settings.trigger === 'auto') openCard(selection.text, anchorFrom(selection.rect, lastPointer));
      else showTrigger(lastPointer, selection.text);
    }, 10);
  }

  function onPointerDown(event) {
    if (insideHost(event)) return;
    // Dragging the page scrollbar should not dismiss anything.
    if (event.target === document.documentElement && event.clientX >= document.documentElement.clientWidth) return;
    hideTrigger();
    if (cardOpen() && !pinned) closeCard();
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape') return;
    hideTrigger();
    if (!cardOpen()) return;
    if (!ui.menu.hidden) ui.menu.hidden = true;
    else closeCard();
  }

  function onSelectionChange() {
    if (trigger && !trigger.hidden && !window.getSelection()?.toString().trim()) hideTrigger();
  }

  function teardown() {
    for (const cleanup of cleanups.splice(0)) cleanup();
    try {
      port?.disconnect();
    } catch {
      // Already gone.
    }
    port = null;
    host?.remove();
    host = null;
  }

  listen(document, 'mouseup', onMouseUp, true);
  listen(document, 'pointerdown', onPointerDown, true);
  listen(document, 'keydown', onKeyDown, true);
  listen(document, 'selectionchange', onSelectionChange);
  listen(document, 'contextmenu', (e) => (lastPointer = { x: e.clientX, y: e.clientY }), true);
  listen(document, 'glint:teardown', teardown);
  listen(window, 'resize', () => placeCard());
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
