// Styles for whole-page translation. GLINT_PAGE_CSS is adopted by the page
// document (it styles the <glint-tr> elements inserted next to paragraphs);
// GLINT_BALL_CSS lives in the floating ball's shadow root. Both are
// constructed stylesheets, which page CSP cannot block.
globalThis.GLINT_PAGE_CSS = `
glint-tr { all: revert; font: inherit; color: inherit; letter-spacing: inherit; text-align: inherit; }
glint-tr[data-glint-mode="block"] { display: block !important; margin: 0.3em 0 0 !important; }
glint-tr[data-glint-mode="inline"] { display: inline !important; margin-left: 0.4em !important; }
glint-tr[data-glint-state="same"] { display: none !important; }
glint-tr-text { display: inline; }
glint-tr[data-glint-mode="block"] glint-tr-text { white-space: pre-line; }

glint-tr[data-glint-state="loading"] glint-tr-text {
  display: inline-block; width: 0.85em; height: 0.85em; vertical-align: -0.1em;
  border: 2px solid rgba(124, 108, 240, 0.25); border-top-color: #7c6cf0; border-radius: 50%;
  animation: glint-tr-spin 0.8s linear infinite;
}
glint-tr[data-glint-state="error"] glint-tr-text {
  font-size: 0.85em; color: #dc3e42; cursor: pointer;
  text-decoration: underline dotted; text-underline-offset: 3px;
}

glint-tr[data-glint-state="done"][data-glint-style="dashed"] glint-tr-text {
  text-decoration: underline dashed rgba(124, 108, 240, 0.65); text-decoration-thickness: 1px; text-underline-offset: 0.3em;
}
glint-tr[data-glint-state="done"][data-glint-style="faded"] glint-tr-text { opacity: 0.68; }
glint-tr[data-glint-state="done"][data-glint-style="highlight"] glint-tr-text {
  padding: 0 0.15em; border-radius: 0.2em;
  background: rgba(250, 204, 21, 0.28); -webkit-box-decoration-break: clone; box-decoration-break: clone;
}
glint-tr[data-glint-mode="block"][data-glint-state="done"][data-glint-style="border"] {
  padding-left: 0.65em !important; border-left: 2px solid rgba(124, 108, 240, 0.7) !important;
}

@keyframes glint-tr-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  glint-tr[data-glint-state="loading"] glint-tr-text { animation-duration: 2.4s; }
}
`;

globalThis.GLINT_BALL_CSS = `
:host { all: initial; }

.ball-root {
  --g-surface: #ffffff;
  --g-border: rgba(15, 23, 42, 0.08);
  --g-text: #1f2328;
  --g-muted: #656d76;
  --g-accent: #5b5bd6;
  --g-danger: #dc3e42;
  --g-shadow: 0 0 0 1px rgba(15, 23, 42, 0.04), 0 4px 10px -2px rgba(15, 23, 42, 0.12), 0 12px 28px -6px rgba(15, 23, 42, 0.18);
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 13px; line-height: 1.45; color: var(--g-text);
  -webkit-font-smoothing: antialiased;
}
.ball-root[data-theme="dark"] {
  --g-surface: #26262c;
  --g-border: rgba(255, 255, 255, 0.1);
  --g-text: #ececf1;
  --g-muted: #a1a1aa;
  --g-accent: #a5a8f5;
  --g-danger: #ff7b80;
  --g-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25), 0 12px 28px -6px rgba(0, 0, 0, 0.55);
}

*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
button { font: inherit; color: inherit; background: none; border: 0; margin: 0; padding: 0; cursor: pointer; }
button:focus-visible { outline: 2px solid var(--g-accent); outline-offset: 2px; }
svg { display: block; flex: none; }

.dock {
  position: fixed; right: 0; z-index: 2147483646;
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  transform: translateY(-50%);
  user-select: none; -webkit-user-select: none;
}

.ball {
  position: relative;
  width: 46px; height: 40px;
  display: grid; place-items: center;
  padding-right: 6px;
  border-radius: 20px 0 0 20px;
  color: var(--g-accent);
  background: var(--g-surface);
  box-shadow: var(--g-shadow);
  transform: translateX(14px);
  transition: transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1), background 160ms ease, color 160ms ease, opacity 160ms ease;
  opacity: 0.88;
  touch-action: none;
}
.dock:hover .ball, .dock.dragging .ball, .ball:focus-visible, .dock[data-state="loading"] .ball { transform: translateX(0); opacity: 1; }
.ball svg { width: 21px; height: 21px; }
.dock.dragging .ball { cursor: grabbing; }

.dock[data-state="active"] .ball,
.dock[data-state="loading"] .ball {
  color: #fff;
  background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.2), 0 6px 18px -4px rgba(99, 102, 241, 0.6);
}
/* Small check badge once the page is translated. */
.dock[data-state="active"] .ball::after {
  content: ""; position: absolute; bottom: 6px; left: 9px;
  width: 7px; height: 7px; border-radius: 50%;
  background: #34d399; box-shadow: 0 0 0 2px #7c6cf0;
}
.ring {
  position: absolute; left: 7px; top: 4px; width: 32px; height: 32px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.3); border-top-color: #fff;
  animation: g-spin 0.8s linear infinite;
}

.tip {
  padding: 5px 10px;
  border-radius: 8px;
  white-space: nowrap; font-size: 12.5px; font-weight: 550;
  color: var(--g-text); background: var(--g-surface);
  box-shadow: var(--g-shadow);
  opacity: 0; transform: translateX(6px); pointer-events: none;
  transition: opacity 140ms ease, transform 140ms ease;
}
.tip kbd { margin-left: 6px; font: inherit; font-size: 11.5px; color: var(--g-muted); }
.dock:hover:not(.dragging) .tip { opacity: 1; transform: translateX(0); }

@keyframes g-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .ball, .tip { transition: none; }
  .ring { animation-duration: 2.4s; }
}
`;
