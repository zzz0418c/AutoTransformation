import { utcStamp, zonedDateTimeToUtc } from './lib/time.js';

function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** RFC 5545 folds at 75 octets; continuation lines start with one space. */
function foldLine(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;

  const parts = [];
  let current = '';
  let limit = 75;

  for (const char of line) {
    if (Buffer.byteLength(current + char, 'utf8') > limit) {
      parts.push(current);
      current = char;
      limit = 74;
    } else {
      current += char;
    }
  }

  parts.push(current);
  return parts.join('\r\n ');
}

export function notebooksWithReminders(notebooks) {
  return notebooks.filter(
    (notebook) => notebook.reviewDate && notebook.entries.length > 0,
  );
}

/**
 * One all-day-ish event at `remindAt` local time per notebook.
 * Times are emitted in UTC so any calendar app can read them.
 */
export function buildIcs(notebooks, options = {}) {
  const timeZone = options.timeZone ?? 'Asia/Shanghai';
  const remindAt = options.remindAt ?? '07:30';
  const now = options.now ?? new Date();
  const stamp = utcStamp(now);

  const events = [];

  for (const notebook of notebooksWithReminders(notebooks)) {
    const start = zonedDateTimeToUtc(notebook.reviewDate, remindAt, timeZone);
    const end = new Date(start.getTime() + 15 * 60 * 1000);
    const terms = notebook.entries.map((entry) => entry.term).join('、');
    const description = `${notebook.entries.length} 个词：${terms}`.slice(0, 300);

    events.push(
      'BEGIN:VEVENT',
      `UID:${notebook.id}-${notebook.reviewDate.replace(/-/g, '')}@auto-transformation.local`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${utcStamp(start)}`,
      `DTEND:${utcStamp(end)}`,
      `SUMMARY:${escapeText(`单词复习 · ${notebook.title}`)}`,
      `DESCRIPTION:${escapeText(description)}`,
      'STATUS:CONFIRMED',
      'SEQUENCE:0',
      'TRANSP:OPAQUE',
      'END:VEVENT',
    );
  }

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AutoTransformation//Review Calendar//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:AutoTransformation 生词复习',
    ...events,
    'END:VCALENDAR',
  ];

  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
