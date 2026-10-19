// Parser for the plain-text dictionary format requested in prompt.js:
//   /IPA/
//   pos. meaning; meaning
//   e.g. example → translation
// Loaded both as a classic content script and as a side-effect ES module, so
// it only publishes a function on globalThis. Tolerates partial (streaming) input.
(() => {
  function parseDictionary(raw) {
    const out = { phonetic: '', rows: [] };
    const lines = String(raw)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      if (!out.phonetic && !out.rows.length && /^[/[]/.test(line)) {
        out.phonetic = line;
        continue;
      }
      const example = line.match(/^(?:e\.g\.|例[:：])\s*(.+)$/i);
      if (example) {
        out.rows.push({ kind: 'example', text: example[1] });
        continue;
      }
      const pos = line.match(/^((?:[a-z]{1,6}\.\s*(?:[&/,]\s*)?)+)\s*(.+)$/i);
      if (pos) out.rows.push({ kind: 'pos', pos: pos[1].trim(), text: pos[2] });
      else out.rows.push({ kind: 'text', text: line });
    }
    return out;
  }

  globalThis.GLINT_PARSE_DICTIONARY = parseDictionary;
})();
