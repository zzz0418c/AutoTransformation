/**
 * Text shaping shared by the API routes and the LLM client.
 */

/** Normalise newlines and collapse runs of blank lines. */
export function normalizeText(input) {
  return String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Turn a page of OCR output into an array of paragraphs.
 *
 * The transcription prompt asks for blank lines between paragraphs. Real OCR
 * output also arrives hard-wrapped, one visual line per newline, so when there
 * are no blank lines we merge lines that clearly continue a sentence.
 */
export function splitParagraphs(input) {
  const text = normalizeText(input);
  if (!text) return [];

  let paragraphs = text
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean);

  if (paragraphs.length === 1) {
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length > 1) paragraphs = mergeWrappedLines(lines);
  }

  return paragraphs;
}

function mergeWrappedLines(lines) {
  const merged = [];
  for (const line of lines) {
    const previous = merged[merged.length - 1];
    if (previous && !/[.!?:"'”’)\]]$/.test(previous)) {
      merged[merged.length - 1] = `${previous} ${line}`;
    } else {
      merged.push(line);
    }
  }
  return merged;
}

/** Group paragraphs into request-sized chunks, keeping stable 1-based ids. */
export function chunkParagraphs(paragraphs, options = {}) {
  const maxChars = options.maxChars ?? 3000;
  const maxItems = options.maxItems ?? 6;

  const chunks = [];
  let current = [];
  let chars = 0;

  paragraphs.forEach((text, index) => {
    if (current.length && (chars + text.length > maxChars || current.length >= maxItems)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push({ id: index + 1, text });
    chars += text.length;
  });

  if (current.length) chunks.push(current);
  return chunks;
}

/** Count words the way a reader would, for the little toolbar stat. */
export function countWords(text) {
  return (String(text).match(/[A-Za-z]+(?:[’'\-][A-Za-z]+)*/g) ?? []).length;
}
