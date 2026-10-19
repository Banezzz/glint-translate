// Styles for the in-page trigger and translation card. Applied to the shadow
// root as a constructed stylesheet, which page CSP cannot block.
globalThis.GLINT_CARD_CSS = `
:host { all: initial; }

.glint-root {
  --g-bg: rgba(255, 255, 255, 0.94);
  --g-bg-solid: #ffffff;
  --g-border: rgba(15, 23, 42, 0.08);
  --g-divider: rgba(15, 23, 42, 0.06);
  --g-text: #1f2328;
  --g-muted: #656d76;
  --g-faint: #9198a1;
  --g-hover: rgba(15, 23, 42, 0.05);
  --g-active: rgba(15, 23, 42, 0.09);
  --g-accent: #5b5bd6;
  --g-accent-soft: rgba(99, 102, 241, 0.1);
  --g-danger: #dc3e42;
  --g-danger-soft: rgba(229, 72, 77, 0.08);
  --g-shadow: 0 0 0 1px rgba(15, 23, 42, 0.02), 0 2px 4px rgba(15, 23, 42, 0.04), 0 12px 32px -4px rgba(15, 23, 42, 0.16), 0 24px 60px -12px rgba(15, 23, 42, 0.12);
  --g-font-size: 15px;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--g-text);
  -webkit-font-smoothing: antialiased;
  text-align: left;
  letter-spacing: normal;
}

.glint-root[data-theme="dark"] {
  --g-bg: rgba(30, 30, 35, 0.92);
  --g-bg-solid: #212126;
  --g-border: rgba(255, 255, 255, 0.09);
  --g-divider: rgba(255, 255, 255, 0.07);
  --g-text: #ececf1;
  --g-muted: #a1a1aa;
  --g-faint: #71717a;
  --g-hover: rgba(255, 255, 255, 0.06);
  --g-active: rgba(255, 255, 255, 0.1);
  --g-accent: #9b9ef0;
  --g-accent-soft: rgba(129, 140, 248, 0.16);
  --g-danger: #ff7b80;
  --g-danger-soft: rgba(255, 99, 105, 0.1);
  --g-shadow: 0 0 0 1px rgba(0, 0, 0, 0.2), 0 12px 32px -4px rgba(0, 0, 0, 0.5), 0 24px 60px -12px rgba(0, 0, 0, 0.45);
}

*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
button {
  font: inherit; color: inherit; background: none; border: 0; margin: 0; padding: 0;
  cursor: pointer; -webkit-tap-highlight-color: transparent;
}
button:focus-visible { outline: 2px solid var(--g-accent); outline-offset: 1px; }
svg { display: block; flex: none; }

/* Floating trigger next to the selection */
.trigger {
  position: absolute;
  width: 28px; height: 28px;
  display: grid; place-items: center;
  border-radius: 9px;
  color: #fff;
  background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.22), 0 4px 12px -2px rgba(99, 102, 241, 0.55), 0 1px 3px rgba(15, 23, 42, 0.2);
  animation: g-pop 180ms cubic-bezier(0.2, 0.9, 0.3, 1.25);
  transition: transform 120ms ease, box-shadow 120ms ease;
}
.trigger:hover { transform: translateY(-1px) scale(1.06); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.28), 0 6px 16px -2px rgba(99, 102, 241, 0.6), 0 1px 3px rgba(15, 23, 42, 0.2); }
.trigger:active { transform: scale(0.95); }
.trigger svg { width: 18px; height: 18px; }

/* Card */
.card {
  position: absolute;
  width: 380px;
  max-width: calc(100vw - 16px);
  max-height: min(460px, calc(100vh - 16px));
  display: flex; flex-direction: column;
  background: var(--g-bg);
  -webkit-backdrop-filter: blur(24px) saturate(1.8);
  backdrop-filter: blur(24px) saturate(1.8);
  border: 1px solid var(--g-border);
  border-radius: 14px;
  box-shadow: var(--g-shadow);
  animation: g-in 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.card-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 8px 8px 4px 14px;
  cursor: grab; user-select: none;
}
.card-head.dragging { cursor: grabbing; }
.langs { position: relative; display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12.5px; color: var(--g-muted); }
.lang-source { white-space: nowrap; }
.lang-arrow { color: var(--g-faint); }
.lang-arrow svg { width: 13px; height: 13px; }
.lang-target {
  display: inline-flex; align-items: center; gap: 3px;
  height: 24px; padding: 0 6px 0 9px;
  border-radius: 7px;
  font-weight: 600;
  color: var(--g-accent);
  background: var(--g-accent-soft);
  white-space: nowrap;
  transition: filter 120ms ease;
}
.lang-target:hover { filter: brightness(0.96) saturate(1.2); }
.lang-target svg { width: 14px; height: 14px; opacity: 0.8; }

.lang-menu {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 2;
  width: 168px; max-height: 264px; overflow: auto; overscroll-behavior: contain;
  padding: 4px;
  background: var(--g-bg-solid);
  border: 1px solid var(--g-border);
  border-radius: 10px;
  box-shadow: var(--g-shadow);
  animation: g-in 140ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.lang-item {
  display: flex; align-items: center; justify-content: space-between;
  width: 100%; padding: 6px 10px;
  border-radius: 7px;
  font-size: 13px; color: var(--g-text); text-align: left;
}
.lang-item:hover { background: var(--g-hover); }
.lang-item[aria-selected="true"] { color: var(--g-accent); font-weight: 600; }
.lang-item svg { width: 14px; height: 14px; }

.head-actions, .foot-actions { display: flex; align-items: center; gap: 2px; }
.icon-btn {
  width: 28px; height: 28px;
  display: grid; place-items: center;
  border-radius: 8px;
  color: var(--g-faint);
  transition: background 120ms ease, color 120ms ease;
}
.icon-btn:hover { background: var(--g-hover); color: var(--g-text); }
.icon-btn:active { background: var(--g-active); }
.icon-btn svg { width: 16px; height: 16px; }
.icon-btn.active { color: var(--g-accent); background: var(--g-accent-soft); }
.icon-btn.done { color: #30a46c; }
.icon-btn:disabled { opacity: 0.4; pointer-events: none; }

.card-body {
  flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain;
  padding: 4px 14px 12px;
  scrollbar-width: thin;
}

.source {
  font-size: 13px; line-height: 1.6; color: var(--g-muted);
  white-space: pre-wrap; word-break: break-word;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden;
  cursor: pointer;
}
.source.expanded { display: block; overflow: visible; }

.result { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--g-divider); }
.output {
  font-size: var(--g-font-size); line-height: 1.7;
  white-space: pre-wrap; word-break: break-word;
  user-select: text; cursor: text;
}
.caret {
  display: inline-block; width: 2px; height: 1.05em; margin-left: 2px; vertical-align: -0.16em;
  border-radius: 1px; background: var(--g-accent);
  animation: g-blink 1s steps(2, start) infinite;
}
.output:not(.streaming) .caret { display: none; }

.skeleton { display: grid; gap: 9px; padding: 5px 0 3px; }
.skeleton i {
  display: block; height: 10px; border-radius: 5px;
  background: linear-gradient(90deg, var(--g-hover) 20%, var(--g-accent-soft) 50%, var(--g-hover) 80%);
  background-size: 220% 100%;
  animation: g-shimmer 1.3s linear infinite;
}
.skeleton i:nth-child(1) { width: 94%; }
.skeleton i:nth-child(2) { width: 78%; }
.skeleton i:nth-child(3) { width: 52%; }

/* Dictionary entries */
.dict-head { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; }
.dict-word { font-size: 20px; font-weight: 650; letter-spacing: -0.01em; color: var(--g-text); word-break: break-word; }
.dict-phonetic { font-size: 13px; color: var(--g-muted); font-family: "Lucida Sans Unicode", "Segoe UI", "Arial Unicode MS", sans-serif; }
.dict-head .icon-btn { width: 26px; height: 26px; margin-left: -4px; }
.dict { display: grid; gap: 6px; user-select: text; }
.dict-row { display: flex; align-items: flex-start; gap: 8px; font-size: var(--g-font-size); line-height: 1.6; }
.dict-pos {
  flex: none; min-width: 34px; height: 20px; margin-top: calc((var(--g-font-size) * 1.6 - 20px) / 2);
  padding: 0 6px; border-radius: 6px;
  font-size: 12px; line-height: 20px; font-weight: 600; font-style: italic; text-align: center;
  color: var(--g-accent); background: var(--g-accent-soft);
}
.dict-text { word-break: break-word; }
.dict-example {
  margin-top: 4px; padding: 8px 10px; border-radius: 8px;
  font-size: 13px; line-height: 1.6; color: var(--g-muted); background: var(--g-hover);
}

/* Errors */
.error {
  display: flex; gap: 10px; padding: 10px 12px;
  border-radius: 10px; background: var(--g-danger-soft);
}
.error > svg { width: 18px; height: 18px; margin-top: 1px; color: var(--g-danger); }
.error-title { font-weight: 600; color: var(--g-danger); }
.error-detail { margin-top: 2px; font-size: 12px; color: var(--g-muted); word-break: break-word; user-select: text; }
.error-actions { display: flex; gap: 6px; margin-top: 8px; }
.chip-btn {
  height: 26px; padding: 0 10px; border-radius: 7px;
  font-size: 12.5px; font-weight: 600;
  background: var(--g-bg-solid); border: 1px solid var(--g-border); color: var(--g-text);
}
.chip-btn:hover { background: var(--g-hover); }
.chip-btn.primary { color: #fff; border-color: transparent; background: linear-gradient(135deg, #6366f1, #8b5cf6); }
.chip-btn.primary:hover { filter: brightness(1.06); }

.card-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 4px 8px 8px 14px;
}
.model {
  display: inline-flex; align-items: center; gap: 6px; min-width: 0;
  font-size: 11.5px; color: var(--g-faint);
}
.model::before {
  content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%;
  background: linear-gradient(135deg, #6366f1, #a855f7);
}
.model:empty::before { display: none; }
.model-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 190px; }

@keyframes g-in { from { opacity: 0; transform: translateY(4px) scale(0.98); } }
@keyframes g-pop { from { opacity: 0; transform: scale(0.6); } }
@keyframes g-blink { to { opacity: 0; } }
@keyframes g-shimmer { from { background-position: 110% 0; } to { background-position: -110% 0; } }

@media (prefers-reduced-motion: reduce) {
  .trigger, .card, .lang-menu, .caret, .skeleton i { animation: none !important; }
}
`;
