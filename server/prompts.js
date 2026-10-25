/**
 * Prompts live here so they can be tuned without touching the HTTP layer.
 * The model-facing instructions are in English; the required output language
 * is stated explicitly in each prompt.
 */

const CONTEXT_FALLBACK = 'an English book';

function contextLine(context) {
  const value = String(context ?? '').trim();
  return value || CONTEXT_FALLBACK;
}

export function transcribePrompt(context) {
  return `You transcribe photographed pages of an English book into plain text.

Rules:
- Output ONLY the body text, exactly as printed. No translation, no commentary, no label such as "Transcription:".
- Keep the original spelling, capitalisation and punctuation. Do not modernise or correct the author.
- Put one blank line between paragraphs.
- Join words that are hyphenated across a line break. Drop running heads, page numbers and rule lines.
- If a word is genuinely illegible, write [?] instead of guessing.
- The book: ${contextLine(context)}.`;
}

export function translatePrompt(context, items, strict = false) {
  const numbered = items.map((item) => `[${item.id}] ${item.text}`).join('\n\n');
  const strictNote = strict
    ? '\nYour previous reply could not be parsed. Return ONLY the JSON object, with no prose and no markdown fences.\n'
    : '';

  return `Translate the numbered English paragraphs below into natural Simplified Chinese.

Rules:
- Translate paragraph by paragraph and keep the same ids.
- Preserve the author's tone and sentence rhythm. Do not add explanations, notes or extra sentences.
- Keep proper names as they appear in the original.
- Return ONLY a JSON object in this exact shape:
{"translations":[{"id":1,"text":"..."}]}
${strictNote}
The book: ${contextLine(context)}.

${numbered}`;
}

export function translateOnePrompt(context, paragraph) {
  return `Translate this paragraph from an English book into natural Simplified Chinese.
Output only the translation, with no quotes, notes or explanation.
The book: ${contextLine(context)}.

${paragraph}`;
}

export function wordPrompt({ context, word, sentence, paragraph, strict = false }) {
  const strictNote = strict
    ? '\nYour previous reply could not be parsed. Return ONLY the JSON object, with no prose and no markdown fences.\n'
    : '';

  return `You are a bilingual lexicographer helping a Chinese reader understand ${contextLine(context)}.
The reader clicked a word or phrase while reading. Explain it in THIS sentence.

WORD: ${word}
SENTENCE: ${sentence}
PARAGRAPH (for context): ${paragraph || '(not provided)'}

Return ONLY a JSON object in this exact shape:
{"lemma":"...","contextual":{"pos":"...","meaning":"..."},"common":[{"pos":"...","meaning":"..."}]}

Rules:
- contextual.meaning: the meaning actually used in this sentence, in Simplified Chinese, at most 40 characters. If the sense is archaic, literary or otherwise unusual in modern English, say so briefly inside the meaning, e.g. "（旧义）缺少，需要".
- common: 2 to 4 senses the word most often has in modern English, in Simplified Chinese, each at most 20 characters. Do not repeat the contextual sense.
- pos: a short English part of speech, e.g. n., v., adj., adv.
- lemma: the dictionary form of the word. If the reader selected a phrase, repeat the phrase.
- Do not add keys, comments or markdown.
${strictNote}`;
}
