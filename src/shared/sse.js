// Incremental Server-Sent Events parser (https://html.spec.whatwg.org/#event-stream-interpretation).
// push() takes decoded text chunks and returns the events completed so far.
export function createSSEParser() {
  let buffer = '';
  let eventName = '';
  let data = [];

  function dispatch(out) {
    if (data.length) out.push({ event: eventName || 'message', data: data.join('\n') });
    eventName = '';
    data = [];
  }

  function processLine(line, out) {
    if (line === '') return dispatch(out);
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') data.push(value);
  }

  return {
    push(chunk) {
      buffer += chunk;
      const out = [];
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer);
        if (!match) break;
        // A trailing '\r' may be the first half of '\r\n' split across chunks.
        if (match[0] === '\r' && match.index === buffer.length - 1) break;
        processLine(buffer.slice(0, match.index), out);
        buffer = buffer.slice(match.index + match[0].length);
      }
      return out;
    },
    flush() {
      const out = [];
      if (buffer) processLine(buffer.replace(/\r$/, ''), out);
      buffer = '';
      dispatch(out);
      return out;
    },
  };
}
