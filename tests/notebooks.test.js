import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { createStore } from '../server/store.js';

const fakeLlm = {
  demo: true,
  async translateParagraphs(paragraphs) {
    return paragraphs.map((paragraph) => `译：${paragraph}`);
  },
  async explainWord({ word }) {
    return {
      word,
      lemma: word.toLowerCase(),
      contextual: { pos: 'n.', meaning: '（旧义）缺乏，需要' },
      common: [{ pos: 'v.', meaning: '想要' }],
    };
  },
};

async function withApp(run) {
  const dataDir = mkdtempSync(join(tmpdir(), 'at-notebook-'));
  const config = loadConfig({ LLM_MOCK: '1', LLM_API_KEY: '' });
  const store = createStore({ dataDir, timeZone: config.timeZone });
  const app = createApp({ config, llm: fakeLlm, store });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    await run(`http://127.0.0.1:${port}`, store);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const readJson = async (response) => ({ status: response.status, body: await response.json() });

test('notebooks persist, dedupe entries, and survive a reload', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'at-store-'));
  try {
    const store = createStore({ dataDir, timeZone: 'Asia/Shanghai' });
    const notebook = store.create({
      source: 'It is a truth universally acknowledged, that a single man in possession of a good fortune.',
    });

    assert.match(notebook.title, /^It is a truth/);
    assert.equal(notebook.entries.length, 0);

    const first = store.addEntry(notebook.id, {
      term: 'want',
      lemma: 'want',
      contextual: { pos: 'n.', meaning: '（旧义）缺乏，需要' },
      common: [{ pos: 'v.', meaning: '想要' }],
      sentence: 'must be in want of a wife.',
    });
    assert.equal(first.added, true);

    const duplicate = store.addEntry(notebook.id, { term: 'Want' });
    assert.equal(duplicate.added, false);
    assert.equal(duplicate.entry.id, first.entry.id);

    const reopened = createStore({ dataDir, timeZone: 'Asia/Shanghai' });
    assert.equal(reopened.list().length, 1);
    assert.equal(reopened.get(notebook.id).entries.length, 1);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('API creates a notebook per translation and auto-collects clicked words', async () => {
  await withApp(async (base, store) => {
    const translated = await readJson(
      await fetch(`${base}/api/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'One.\n\nTwo.' }),
      }),
    );

    assert.equal(translated.status, 200);
    const notebookId = translated.body.notebook.id;
    assert.equal(translated.body.notebook.entries.length, 0);
    assert.equal(store.list().length, 1);

    const first = await readJson(
      await fetch(`${base}/api/word`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          word: 'want',
          sentence: 'must be in want of a wife.',
          notebookId,
        }),
      }),
    );

    assert.equal(first.status, 200);
    assert.equal(first.body.notebookEntry.added, true);

    const duplicate = await readJson(
      await fetch(`${base}/api/word`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          word: 'want',
          sentence: 'must be in want of a wife.',
          notebookId,
        }),
      }),
    );
    assert.equal(duplicate.body.notebookEntry.added, false);
    assert.equal(store.get(notebookId).entries.length, 1);

    const patched = await readJson(
      await fetch(`${base}/api/notebooks/${notebookId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Renamed notebook' }),
      }),
    );
    assert.equal(patched.status, 200);
    assert.equal(patched.body.notebook.title, 'Renamed notebook');

    const listed = await readJson(await fetch(`${base}/api/notebooks`));
    assert.equal(listed.body.notebooks.length, 1);
    assert.equal(listed.body.notebooks[0].entryCount, 1);

    const markdown = await fetch(`${base}/api/notebooks/${notebookId}/export.md`);
    assert.equal(markdown.status, 200);
    assert.match(await markdown.text(), /want/);

    const vocabcurve = await fetch(`${base}/api/notebooks/export/vocabcurve.txt`);
    assert.equal(vocabcurve.status, 200);
    assert.match(await vocabcurve.text(), /第1篇/);
  });
});
