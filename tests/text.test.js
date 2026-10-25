import test from 'node:test';
import assert from 'node:assert/strict';

import { chunkParagraphs, normalizeText, splitParagraphs } from '../server/lib/text.js';
import { extractJson } from '../server/lib/json.js';
import { sentenceAround, tokenize } from '../public/js/text.js';

test('normalizeText repairs CRLF and blank-line runs', () => {
  assert.equal(normalizeText('a\r\n\r\n\r\nb  \r\n'), 'a\n\nb');
});

test('splitParagraphs keeps blank-line paragraphs', () => {
  const paragraphs = splitParagraphs('One line.\n\nSecond para.\r\nStill second.');
  assert.deepEqual(paragraphs, ['One line.', 'Second para. Still second.']);
});

test('splitParagraphs merges hard-wrapped lines when no blank lines exist', () => {
  const paragraphs = splitParagraphs(
    'It is a truth universally\nacknowledged, that a single man\nmust be in want of a wife.',
  );

  assert.equal(paragraphs.length, 1);
  assert.equal(
    paragraphs[0],
    'It is a truth universally acknowledged, that a single man must be in want of a wife.',
  );
});

test('splitParagraphs treats punctuated lines as separate paragraphs', () => {
  const paragraphs = splitParagraphs('First sentence.\nSecond sentence.\nThird one!');
  assert.deepEqual(paragraphs, ['First sentence.', 'Second sentence.', 'Third one!']);
});

test('chunkParagraphs keeps ids stable and respects limits', () => {
  const paragraphs = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
  const chunks = chunkParagraphs(paragraphs, { maxChars: 100, maxItems: 10 });

  assert.deepEqual(
    chunks.map((chunk) => chunk.map((item) => item.id)),
    [
      [1, 2],
      [3],
    ],
  );
});

test('extractJson survives fences and stray prose', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: {"a":[1,2]} — done.'), { a: [1, 2] });
  assert.throws(() => extractJson('no json here'));
});

test('tokenize keeps offsets and groups hyphenated words', () => {
  const text = 'A well-known truth, universally acknowledged.';
  const tokens = tokenize(text);
  const words = tokens.filter((token) => token.type === 'word').map((token) => token.value);

  assert.deepEqual(words, ['A', 'well-known', 'truth', 'universally', 'acknowledged']);

  for (const token of tokens) {
    assert.equal(text.slice(token.start, token.end), token.value);
  }
});

test('sentenceAround ignores common abbreviations', () => {
  const text = 'Mr. Bennet was among the earliest. He was so odd a mixture.';
  const bennet = text.indexOf('Bennet');

  assert.equal(
    sentenceAround(text, bennet, bennet + 6),
    'Mr. Bennet was among the earliest.',
  );

  const odd = text.indexOf('odd');
  assert.equal(sentenceAround(text, odd, odd + 3), 'He was so odd a mixture.');
});

test('sentenceAround handles initials and final sentences', () => {
  const text = 'J. Austen wrote it. She revised it.';
  const austen = text.indexOf('Austen');
  assert.equal(sentenceAround(text, austen, austen + 6), 'J. Austen wrote it.');

  const revised = text.indexOf('revised');
  assert.equal(sentenceAround(text, revised, revised + 7), 'She revised it.');
});
