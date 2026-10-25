#!/usr/bin/env node
/**
 * Send today's vocabulary review reminder.
 *
 * Usage:
 *   node scripts/notify.mjs --dry-run
 *   node scripts/notify.mjs --date 2026-10-27 --dry-run
 *   node scripts/notify.mjs                 # reads PUSH_URL from .env
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '../server/config.js';
import { isDateOnly, todayInZone } from '../server/lib/time.js';
import { buildReminderText, buildReminderTitle, dueNotebooks, sendPush } from '../server/reminders.js';
import { createStore } from '../server/store.js';

function parseArgs(argv) {
  const options = { dryRun: false, date: null, url: null, format: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--date') options.date = argv[++index];
    else if (arg === '--url') options.url = argv[++index];
    else if (arg === '--format') options.format = argv[++index];
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：node scripts/notify.mjs [--dry-run] [--date YYYY-MM-DD] [--url URL] [--format wecom|serverchan|ntfy|json]');
      process.exit(0);
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }

  return options;
}

const options = parseArgs(process.argv.slice(2));
const config = loadConfig();
const date = options.date ?? todayInZone(config.timeZone);

if (!isDateOnly(date)) {
  console.error(`日期格式不对：${date}（应为 YYYY-MM-DD）`);
  process.exit(2);
}

mkdirSync(config.dataDir, { recursive: true });
const logFile = join(config.dataDir, 'notify.log');

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  appendFileSync(logFile, line, 'utf8');
  console.log(message);
}

const store = createStore({ dataDir: config.dataDir, timeZone: config.timeZone });
const due = dueNotebooks(store.list(), date);

if (!due.length) {
  log(`[notify] ${date} 没有到期的生词本。`);
  process.exit(0);
}

const title = buildReminderTitle(due, date);
const text = buildReminderText(due, date);
console.log(text);
console.log('');

if (options.dryRun) {
  log(`[notify] dry-run：${due.length} 篇待发，未推送。`);
  process.exit(0);
}

const url = options.url ?? config.pushUrl;
const format = (options.format ?? config.pushFormat).toLowerCase();

if (!url) {
  log('[notify] 没有配置 PUSH_URL，内容只打印在这里，没有发送。');
  process.exit(0);
}

try {
  const response = await sendPush({ url, format, title, text });
  for (const notebook of due) store.markNotified(notebook.id);
  log(`[notify] 已推送 ${due.length} 篇（${format}）：${String(response).slice(0, 120)}`);
} catch (error) {
  log(`[notify] 推送失败：${error.message}`);
  process.exit(1);
}
