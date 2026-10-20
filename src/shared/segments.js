// Batch format for whole-page translation. Several paragraphs travel in one
// request, each wrapped as <seg id="N">…</seg>, and the model answers in the
// same shape. The parser emits each segment as soon as its closing tag
// streams in, so paragraphs fill in one by one.

// Upper bounds the worker enforces; the content script batches below them.
export const MAX_BATCH_SEGMENTS = 16;
export const MAX_BATCH_CHARS = 6000;

export function buildSegmentsInput(segments) {
  return segments.map((text, index) => `<seg id="${index + 1}">${text}</seg>`).join('\n');
}

const SEGMENT_RE = /<seg\s+id\s*=\s*["']?(\d+)["']?\s*>([\s\S]*?)<\/seg\s*>/gi;

/**
 * push(delta) returns segments completed by this delta, as
 * [{ index, text }] with zero-based indices; finish() returns the rest.
 */
export function createSegmentParser(count) {
  let buffer = '';
  let offset = 0;
  const seen = new Set();

  function take(match) {
    const index = Number(match[1]) - 1;
    if (index < 0 || index >= count || seen.has(index)) return null;
    seen.add(index);
    return { index, text: match[2].trim() };
  }

  return {
    push(delta) {
      buffer += delta;
      const out = [];
      SEGMENT_RE.lastIndex = offset;
      for (let match; (match = SEGMENT_RE.exec(buffer)); ) {
        offset = SEGMENT_RE.lastIndex;
        const segment = take(match);
        if (segment) out.push(segment);
      }
      return out;
    },
    finish() {
      const out = [];
      // A final segment whose closing tag got cut off.
      const tail = /<seg\s+id\s*=\s*["']?(\d+)["']?\s*>([\s\S]*)$/i.exec(buffer.slice(offset));
      if (tail) {
        const segment = take(tail);
        if (segment?.text) out.push(segment);
      }
      // Single paragraphs sometimes come back without any tags at all.
      if (count === 1 && !seen.size && buffer.trim() && !/<seg\b/i.test(buffer)) {
        seen.add(0);
        out.push({ index: 0, text: buffer.trim() });
      }
      return out;
    },
    missing() {
      return Array.from({ length: count }, (_, i) => i).filter((i) => !seen.has(i));
    },
  };
}
