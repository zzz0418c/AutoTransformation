import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Minimal .env reader. Avoids a dependency for the one thing we need:
 * KEY=VALUE lines, optional quotes, never overriding the real environment.
 */
export function loadDotEnv(file = join(projectRoot, '.env')) {
  if (!existsSync(file)) return;
  const contents = readFileSync(file, 'utf8');

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && !(key in process.env)) process.env[key] = value;
  }
}

const truthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
const withoutTrailingSlash = (value) => String(value ?? '').replace(/\/+$/, '');
const text = (value, fallback) => String(value ?? fallback).trim() || fallback;

export function loadConfig(env = process.env) {
  loadDotEnv();

  const textKey = text(env.LLM_API_KEY, '');
  const textBaseUrl = withoutTrailingSlash(text(env.LLM_BASE_URL, 'https://api.deepseek.com'));
  const textModel = text(env.LLM_MODEL, 'deepseek-flash');
  const thinking = text(env.LLM_THINKING, 'auto').toLowerCase();

  const demo = truthy(env.LLM_MOCK) || !textKey;
  const dataDir = text(env.DATA_DIR, 'data');
  const remindAt = text(env.REMIND_AT, '07:30');

  return {
    demo,
    port: Number(env.PORT) || 8787,
    host: text(env.HOST, '127.0.0.1'),
    timeoutMs: Number(env.LLM_TIMEOUT_MS) || 90_000,
    maxUploadMb: Number(env.MAX_UPLOAD_MB) || 12,
    bookContext: text(env.BOOK_CONTEXT, '19 世纪英国小说'),
    thinking: ['auto', 'enabled', 'disabled'].includes(thinking) ? thinking : 'auto',
    dataDir: isAbsolute(dataDir) ? dataDir : resolve(projectRoot, dataDir),
    timeZone: text(env.TIMEZONE, 'Asia/Shanghai'),
    remindAt: /^\d{2}:\d{2}$/.test(remindAt) ? remindAt : '07:30',
    pushUrl: text(env.PUSH_URL, ''),
    pushFormat: text(env.PUSH_FORMAT, 'wecom').toLowerCase(),
    text: { key: textKey, baseUrl: textBaseUrl, model: textModel },
    vision: {
      key: text(env.VISION_API_KEY, textKey),
      baseUrl: withoutTrailingSlash(text(env.VISION_BASE_URL, textBaseUrl)),
      model: text(env.VISION_MODEL, textModel),
    },
  };
}
