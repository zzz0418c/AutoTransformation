/**
 * Pure text helpers shared by the browser UI and the Node test suite.
 * Kept DOM-free so both environments can import them.
 */

const WORD_PATTERN = /[A-Za-z]+(?:[’'\-][A-Za-z]+)*/g;

/** Split a paragraph into word tokens and the text between them. */
export function tokenize(text) {
  const tokens = [];
  let cursor = 0;

  for (const match of text.matchAll(WORD_PATTERN)) {
    const start = match.index;
    if (start > cursor) {
      tokens.push({ type: 'text', value: text.slice(cursor, start), start: cursor, end: start });
    }
    tokens.push({
      type: 'word',
      value: match[0],
      start,
      end: start + match[0].length,
    });
    cursor = start + match[0].length;
  }

  if (cursor < text.length) {
    tokens.push({ type: 'text', value: text.slice(cursor), start: cursor, end: text.length });
  }

  return tokens;
}

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'capt', 'col', 'gen', 'lt', 'rev', 'hon', 'prof',
  'vs', 'etc', 'no',
]);

function isAbbreviation(text, periodIndex) {
  const match = text.slice(0, periodIndex).match(/([A-Za-z.]+)$/);
  if (!match) return false;

  const word = match[1].replace(/\./g, '').toLowerCase();
  if (ABBREVIATIONS.has(word)) return true;
  return word.length === 1; // initials, e.g. "J. Austen"
}

/**
 * Return the sentence that contains [start, end).
 * Falls back to the whole paragraph when no clear sentence boundary exists.
 */
export function sentenceAround(text, start, end) {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));

  let begin = 0;
  let finish = text.length;

  const boundary = /[.!?][)"'”’]?(?=\s|$)/g;
  let match;

  while ((match = boundary.exec(text)) !== null) {
    const stop = match.index;
    const after = boundary.lastIndex;

    if (after <= from) {
      if (text[stop] === '.' && isAbbreviation(text, stop)) continue;
      begin = after;
    } else if (stop >= to) {
      finish = after;
      break;
    }
  }

  return text.slice(begin, finish).trim();
}
