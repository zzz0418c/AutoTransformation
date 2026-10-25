import { daysBetween, formatChineseDate } from './lib/time.js';

export function dueNotebooks(notebooks, date, { includeNotified = false } = {}) {
  return notebooks
    .filter(
      (notebook) =>
        notebook.reviewDate &&
        notebook.entries.length > 0 &&
        notebook.reviewDate <= date &&
        (includeNotified || notebook.lastNotifiedFor !== notebook.reviewDate),
    )
    .sort(
      (a, b) =>
        a.reviewDate.localeCompare(b.reviewDate) ||
        String(a.createdAt).localeCompare(String(b.createdAt)),
    );
}

export function buildReminderTitle(notebooks, date) {
  return `生词复习 · ${formatChineseDate(date)}（${notebooks.length} 篇）`;
}

export function buildReminderText(notebooks, date) {
  const lines = [`📚 ${formatChineseDate(date)} · 生词复习 ${notebooks.length} 篇`];

  for (const notebook of notebooks) {
    const late = daysBetween(notebook.reviewDate, date);
    const suffix = late > 0 ? ` · 逾期 ${late} 天` : '';
    lines.push(`· ${notebook.title}（${notebook.entries.length} 词）${suffix}`);
  }

  lines.push('打开 AutoTransformation → 生词本，复习后改下次日期。');
  return lines.join('\n');
}

/**
 * Payload shapes copied from vocabcurve, so an existing webhook keeps working:
 * wecom / serverchan / ntfy / json.
 */
export function buildPushRequest(format, title, text) {
  switch (format) {
    case 'wecom':
      return {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
      };
    case 'serverchan':
      return {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: new URLSearchParams({ title, desp: text }).toString(),
      };
    case 'ntfy':
      return {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: `${title}\n${text}`,
      };
    case 'json':
      return {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ title, text }),
      };
    default:
      throw new Error(`不支持的通知格式：${format}（可用 wecom / serverchan / ntfy / json）`);
  }
}

export async function sendPush({ url, format, title, text, fetchImpl = fetch }) {
  if (!url) throw new Error('没有配置推送地址。');

  const request = buildPushRequest(format, title, text);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.text()).slice(0, 300);

  if (!response.ok) {
    throw new Error(`推送失败 ${response.status}：${body.slice(0, 200)}`);
  }

  if (format === 'wecom') {
    try {
      const data = JSON.parse(body);
      if (data.errcode && data.errcode !== 0) {
        throw new Error(`企业微信返回 ${data.errcode}：${data.errmsg ?? ''}`);
      }
    } catch (error) {
      if (error.message.startsWith('企业微信返回')) throw error;
    }
  }

  return body;
}
