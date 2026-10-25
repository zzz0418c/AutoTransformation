/**
 * Timezone helpers. The app stores notebook timestamps in UTC but all
 * user-facing dates (review dates, "today") are in the configured zone.
 */

const pad = (value) => String(value).padStart(2, '0');

function partsInZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

export function todayInZone(timeZone = 'Asia/Shanghai', now = new Date()) {
  const parts = partsInZone(now, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function localStamp(timeZone = 'Asia/Shanghai', now = new Date()) {
  const parts = partsInZone(now, timeZone);
  return {
    date: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
    time: `${pad(parts.hour)}:${pad(parts.minute)}`,
    monthDay: `${parts.month}月${parts.day}日`,
  };
}

/** True for a real calendar date written as YYYY-MM-DD. */
export function isDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Convert "2026-10-27" + "07:30" in Asia/Shanghai to the matching UTC instant.
 * Uses the formatting API instead of hard-coded offsets so DST zones work too.
 */
export function zonedDateTimeToUtc(dateOnly, timeOnly, timeZone = 'Asia/Shanghai') {
  const [year, month, day] = dateOnly.split('-').map(Number);
  const [hour, minute] = timeOnly.split(':').map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  let result = guess;
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const parts = partsInZone(new Date(result), timeZone);
    const rendered = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const offset = rendered - result;
    result = guess - offset;
  }

  return new Date(result);
}

function utcDay(dateOnly) {
  const [year, month, day] = dateOnly.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

/** Whole days from `from` to `to`; positive when `to` is later. */
export function daysBetween(from, to) {
  return Math.round((utcDay(to) - utcDay(from)) / 86_400_000);
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function formatChineseDate(dateOnly) {
  if (!isDateOnly(dateOnly)) return dateOnly;
  const [, month, day] = dateOnly.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(utcDay(dateOnly)).getUTCDay()];
  return `${month}月${day}日 ${weekday}`;
}

/** 2026-10-27T07:40:00Z -> 20261027T074000Z */
export function utcStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
