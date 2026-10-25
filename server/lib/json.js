/**
 * Models are asked for bare JSON, but they still wrap it in fences or add a
 * sentence before it often enough that extracting it is worth its own helper.
 */
export function extractJson(raw) {
  if (typeof raw !== 'string') throw new Error('empty model output');

  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  const start = text.search(/[{[]/);
  if (start === -1) throw new Error('no JSON object in model output');

  const opening = text[start];
  const closing = opening === '{' ? '}' : ']';
  const end = text.lastIndexOf(closing);
  if (end <= start) throw new Error('unterminated JSON in model output');

  return JSON.parse(text.slice(start, end + 1));
}
