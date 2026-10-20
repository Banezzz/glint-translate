// DOM helpers shared by the content scripts (selection card and page
// translation). Elements are built node by node; no HTML strings ever reach
// the page, so Trusted Types and strict CSP sites keep working.
globalThis.GLINT_DOM = (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';

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

  function alive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  // Interface language from the uiLang setting; 'auto' follows the browser.
  function localeOf(settings) {
    return GLINT_I18N.resolveLocale(settings?.uiLang, browserLanguage());
  }

  function browserLanguage() {
    try {
      return chrome.i18n.getUILanguage();
    } catch {
      // Extension context gone.
      return navigator.language;
    }
  }

  // Re-labels static controls in place: data-i18n sets the text,
  // data-i18n-title sets both title and aria-label.
  function localize(root, t) {
    if (!root) return;
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of root.querySelectorAll('[data-i18n-title]')) {
      el.title = t(el.dataset.i18nTitle);
      el.setAttribute('aria-label', el.title);
    }
  }

  return Object.freeze({ h, icon, alive, localeOf, localize });
})();
