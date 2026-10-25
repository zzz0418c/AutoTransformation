import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { buildIcs } from '../server/ics.js';
import {
  buildPushRequest,
  buildReminderText,
  dueNotebooks,
} from '../server/reminders.js';
import { createStore } from '../server/store.js';
import { todayInZone, zonedDateTimeToUtc } from '../server/lib/time.js';

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

test('review date changes reset the notified marker', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'at-review-'));
  try {
    const store = createStore({ dataDir, timeZone: 'Asia/Shanghai' });
    const notebook = store.create({ source: 'A page.' });
    store.addEntry(notebook.id, { term: 'want', contextual: { meaning: '缺乏' } });

    const updated = store.update(notebook.id, { reviewDate: '2026-10-27' });
    assert.equal(updated.reviewDate, '2026-10-27');
    assert.equal(updated.lastNotifiedFor, null);

    store.markNotified(notebook.id);
    assert.equal(store.get(notebook.id).lastNotifiedFor, '2026-10-27');

    const changed = store.update(notebook.id, { reviewDate: '2026-10-30' });
    assert.equal(changed.lastNotifiedFor, null);

    assert.throws(() => store.update(notebook.id, { reviewDate: '2026-13-40' }), /复习日期/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('due selection ignores empty, future, and already-sent notebooks', () => {
  const books = [
    { id: 'a', reviewDate: '2026-10-24', entries: [{}], lastNotifiedFor: null, createdAt: '1' },
    { id: 'b', reviewDate: '2026-10-26', entries: [{}], lastNotifiedFor: null, createdAt: '2' },
    { id: 'c', reviewDate: '2026-10-24', entries: [{}], lastNotifiedFor: '2026-10-24', createdAt: '3' },
    { id: 'd', reviewDate: '2026-10-24', entries: [], lastNotifiedFor: null, createdAt: '4' },
  ];

  assert.deepEqual(
    dueNotebooks(books, '2026-10-25').map((item) => item.id),
    ['a'],
  );
  assert.deepEqual(
    dueNotebooks(books, '2026-10-25', { includeNotified: true }).map((item) => item.id),
    ['a', 'c'],
  );

  const text = buildReminderText([books[0]], '2026-10-25');
  assert.match(text, /逾期 1 天/);
});

test('ics export uses UTC times and escapes text', () => {
  const ics = buildIcs(
    [
      {
        id: 'nb_a',
        title: 'Truth, universally',
        reviewDate: '2026-10-27',
        entries: [{ term: 'want' }],
      },
    ],
    {
      timeZone: 'Asia/Shanghai',
      remindAt: '07:30',
      now: new Date('2026-10-25T00:00:00Z'),
    },
  );

  assert.match(ics, /DTSTART:20261026T233000Z/);
  assert.match(ics, /DTSTAMP:20261025T000000Z/);
  assert.match(ics, /SUMMARY:单词复习 · Truth\\, universally/);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('\r\n'));
});

test('time helpers convert Shanghai review time to UTC', () => {
  assert.equal(
    zonedDateTimeToUtc('2026-10-27', '07:30', 'Asia/Shanghai').toISOString(),
    '2026-10-26T23:30:00.000Z',
  );
  assert.equal(todayInZone('Asia/Shanghai', new Date('2026-10-25T07:00:00Z')), '2026-10-25');
});

test('push payloads match vocabcurve formats', () => {
  const wecom = buildPushRequest('wecom', '标题', '正文');
  assert.deepEqual(JSON.parse(wecom.body), { msgtype: 'text', text: { content: '正文' } });

  const ntfy = buildPushRequest('ntfy', '标题', '正文');
  assert.equal(ntfy.body, '标题\n正文');

  const serverchan = buildPushRequest('serverchan', '标题', '正文');
  assert.match(serverchan.body, /title=/);
  assert.match(serverchan.body, /desp=/);
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
        body: JSON.stringify({ reviewDate: '2026-10-24' }),
      }),
    );
    assert.equal(patched.status, 200);
    assert.equal(patched.body.notebook.reviewDate, '2026-10-24');

    const listed = await readJson(await fetch(`${base}/api/notebooks`));
    assert.equal(listed.body.notebooks.length, 1);
    assert.equal(listed.body.due.length, 1);
    assert.equal(listed.body.due[0].entryCount, 1);

    const markdown = await fetch(`${base}/api/notebooks/${notebookId}/export.md`);
    assert.equal(markdown.status, 200);
    assert.match(await markdown.text(), /want/);

    const vocabcurve = await fetch(`${base}/api/notebooks/export/vocabcurve.txt`);
    assert.equal(vocabcurve.status, 200);
    assert.match(await vocabcurve.text(), /第1篇/);

    const ics = await fetch(`${base}/api/notebooks/export.ics`);
    assert.equal(ics.status, 200);
    assert.match(ics.headers.get('content-type') ?? '', /text\/calendar/);
    assert.match(await ics.text(), /DTSTART:/);

    const invalid = await readJson(
      await fetch(`${base}/api/notebooks/${notebookId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewDate: '2026-13-40' }),
      }),
    );
    assert.equal(invalid.status, 400);
  });
});
