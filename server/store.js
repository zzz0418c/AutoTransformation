import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { HttpError } from './lib/errors.js';
import { localStamp } from './lib/time.js';

const SCHEMA_VERSION = 1;
const FILE_NAME = 'notebooks.json';

function excerptOf(source = '') {
  return String(source).replace(/\s+/g, ' ').trim().slice(0, 160);
}

function titleFromSource(source, timeZone, now) {
  const cleaned = String(source ?? '').replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ').filter(Boolean).slice(0, 6).join(' ');

  if (words) {
    return words.length > 60 ? `${words.slice(0, 60)}…` : `${words}…`;
  }

  const stamp = localStamp(timeZone, now);
  return `书页 · ${stamp.monthDay} ${stamp.time}`;
}

function cleanText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeEntry(raw) {
  const term = cleanText(raw?.term, 120);
  if (!term) throw new HttpError(400, '单词不能为空。');
  if (!/[A-Za-z]/.test(term)) throw new HttpError(400, '请选择一个英文单词或短语。');

  const contextual = raw?.contextual ?? {};
  const common = Array.isArray(raw?.common) ? raw.common : [];

  return {
    id: `w_${randomUUID().slice(0, 8)}`,
    term,
    lemma: cleanText(raw?.lemma, 120) || term,
    contextual: {
      pos: cleanText(contextual.pos, 40),
      meaning: cleanText(contextual.meaning, 120) || '—',
    },
    common: common
      .map((item) => ({
        pos: cleanText(item?.pos, 40),
        meaning: cleanText(item?.meaning, 120),
      }))
      .filter((item) => item.meaning)
      .slice(0, 4),
    sentence: cleanText(raw?.sentence, 800),
    addedAt: new Date().toISOString(),
  };
}

export function createStore({ dataDir, timeZone = 'Asia/Shanghai' }) {
  if (!dataDir) throw new Error('dataDir is required');
  mkdirSync(dataDir, { recursive: true });

  const file = join(dataDir, FILE_NAME);

  function read() {
    if (!existsSync(file)) return { version: SCHEMA_VERSION, notebooks: [] };

    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return {
        version: SCHEMA_VERSION,
        notebooks: Array.isArray(parsed.notebooks) ? parsed.notebooks : [],
      };
    } catch {
      // A corrupt file should not take the whole app down. Keep a copy for
      // inspection and start from an empty book.
      try {
        renameSync(file, `${file}.broken-${Date.now()}`);
      } catch {
        // ignore
      }
      return { version: SCHEMA_VERSION, notebooks: [] };
    }
  }

  function write(data) {
    mkdirSync(dataDir, { recursive: true });
    const payload = `${JSON.stringify({ version: SCHEMA_VERSION, notebooks: data.notebooks }, null, 2)}\n`;
    const tmp = `${file}.${process.pid}.tmp`;

    try {
      writeFileSync(tmp, payload, 'utf8');
      renameSync(tmp, file);
    } catch {
      try {
        writeFileSync(file, payload, 'utf8');
      } finally {
        try {
          unlinkSync(tmp);
        } catch {
          // ignore
        }
      }
    }
  }

  function list() {
    return read().notebooks.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  function get(id) {
    return list().find((item) => item.id === id) ?? null;
  }

  function create({ title, source = '', now = new Date() } = {}) {
    const data = read();
    const notebook = {
      id: `nb_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
      title: cleanText(title, 120) || titleFromSource(source, timeZone, now),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      sourceExcerpt: excerptOf(source),
      entries: [],
    };

    data.notebooks.unshift(notebook);
    write(data);
    return notebook;
  }

  function updateSource(id, source = '', now = new Date()) {
    const data = read();
    const notebook = data.notebooks.find((item) => item.id === id);
    if (!notebook) return null;

    notebook.sourceExcerpt = excerptOf(source) || notebook.sourceExcerpt;
    notebook.updatedAt = now.toISOString();
    write(data);
    return notebook;
  }

  function update(id, patch = {}, now = new Date()) {
    const data = read();
    const notebook = data.notebooks.find((item) => item.id === id);
    if (!notebook) return null;

    if (Object.hasOwn(patch, 'title')) {
      const title = cleanText(patch.title, 120);
      if (!title) throw new HttpError(400, '标题不能为空。');
      notebook.title = title;
    }

    notebook.updatedAt = now.toISOString();
    write(data);
    return notebook;
  }

  function remove(id) {
    const data = read();
    const index = data.notebooks.findIndex((item) => item.id === id);
    if (index === -1) return false;

    data.notebooks.splice(index, 1);
    write(data);
    return true;
  }

  function addEntry(id, raw) {
    const data = read();
    const notebook = data.notebooks.find((item) => item.id === id);
    if (!notebook) return null;

    const term = cleanText(raw?.term, 120);
    const key = term.toLowerCase();
    const existing = notebook.entries.find((entry) => entry.term.toLowerCase() === key);
    if (existing) return { entry: existing, added: false };

    const entry = normalizeEntry(raw);
    notebook.entries.push(entry);
    notebook.updatedAt = new Date().toISOString();
    write(data);
    return { entry, added: true };
  }

  function removeEntry(id, entryId) {
    const data = read();
    const notebook = data.notebooks.find((item) => item.id === id);
    if (!notebook) return false;

    const index = notebook.entries.findIndex((entry) => entry.id === entryId);
    if (index === -1) return false;

    notebook.entries.splice(index, 1);
    notebook.updatedAt = new Date().toISOString();
    write(data);
    return true;
  }

  return {
    dataDir,
    file,
    list,
    get,
    create,
    updateSource,
    update,
    remove,
    addEntry,
    removeEntry,
  };
}

export function summarizeNotebook(notebook) {
  return {
    id: notebook.id,
    title: notebook.title,
    createdAt: notebook.createdAt,
    updatedAt: notebook.updatedAt,
    sourceExcerpt: notebook.sourceExcerpt,
    entryCount: notebook.entries.length,
  };
}
