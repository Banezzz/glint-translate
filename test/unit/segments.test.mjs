import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSegmentsInput, createSegmentParser } from '../../src/shared/segments.js';

test('buildSegmentsInput numbers segments from 1', () => {
  assert.equal(buildSegmentsInput(['Hello', 'Two\nlines']), '<seg id="1">Hello</seg>\n<seg id="2">Two\nlines</seg>');
});

test('segment parser emits each segment as soon as it closes', () => {
  const parser = createSegmentParser(3);
  const stream = '<seg id="1">你好</seg>\n<seg id="2">第二\n段</seg>\n<seg id="3">第三段</seg>';
  const emitted = [];
  // Feed in awkward 5-character chunks that split tags apart.
  for (const chunk of stream.match(/[\s\S]{1,5}/g)) {
    emitted.push(...parser.push(chunk));
  }
  assert.deepEqual(
    emitted,
    [
      { index: 0, text: '你好' },
      { index: 1, text: '第二\n段' },
      { index: 2, text: '第三段' },
    ],
  );
  assert.deepEqual(parser.finish(), []);
  assert.deepEqual(parser.missing(), []);
});

test('segment parser tolerates loose formatting, duplicates and unknown ids', () => {
  const parser = createSegmentParser(3);
  const found = parser.push("Sure:\n<seg id=2> B </seg><SEG id='1'>A</SEG>\n<seg id=\"2\">dup</seg><seg id=\"9\">x</seg>");
  assert.deepEqual(found, [
    { index: 1, text: 'B' },
    { index: 0, text: 'A' },
  ]);
  assert.deepEqual(parser.missing(), [2]);
});

test('segment parser recovers a final segment without its closing tag', () => {
  const parser = createSegmentParser(2);
  assert.deepEqual(parser.push('<seg id="1">一</seg>\n<seg id="2">二'), [{ index: 0, text: '一' }]);
  assert.deepEqual(parser.finish(), [{ index: 1, text: '二' }]);
  assert.deepEqual(parser.missing(), []);
});

test('a single segment answered without tags is still used', () => {
  const parser = createSegmentParser(1);
  assert.deepEqual(parser.push('只有译文'), []);
  assert.deepEqual(parser.finish(), [{ index: 0, text: '只有译文' }]);
  // With several segments untagged output is ambiguous and dropped.
  const many = createSegmentParser(2);
  many.push('一\n二');
  assert.deepEqual(many.finish(), []);
  assert.deepEqual(many.missing(), [0, 1]);
});
