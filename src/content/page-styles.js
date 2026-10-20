// Styles for whole-page translation. GLINT_PAGE_CSS is adopted by the page
// document (it styles the <glint-tr> elements inserted next to paragraphs)
// as a constructed stylesheet, which page CSP cannot block.
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
