import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { createEbookStore } from '../server/ebook-store.js';
import { createStore } from '../server/store.js';

process.env.NODE_ENV = 'test';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function fakeLlm() {
  let transcribed = 0;
  return {
    demo: true,
    async transcribeImage() {
      transcribed += 1;
      return transcribed === 1
        ? 'It is a truth universally acknowledged.'
        : `A second imported page, number ${transcribed}.`;
    },
    async translateParagraphs(paragraphs) {
      return paragraphs.map((paragraph) => `译：${paragraph}`);
    },
    async explainWord({ word }) {
      return {
        word,
        lemma: word.toLowerCase(),
        contextual: { pos: 'n.', meaning: '语境义' },
        common: [{ pos: 'n.', meaning: '常用义' }],
      };
    },
  };
}

async function withServer(run) {
  const dataDir = mkdtempSync(join(tmpdir(), 'at-ebook-'));
  const config = loadConfig({ LLM_MOCK: '1', LLM_API_KEY: '' });
  const store = createStore({ dataDir, timeZone: config.timeZone });
  const ebookStore = createEbookStore({ dataDir });
  const app = createApp({
    config,
    llm: fakeLlm(),
    store,
    ebookStore,
    coverFinder: async () => null,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function json(response) {
  return { status: response.status, body: await response.json() };
}

test('ebooks import pages serially and expose translated pages', async () => {
  await withServer(async (base) => {
    const created = await json(
      await fetch(`${base}/api/ebooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Pride and Prejudice',
          author: 'Jane Austen',
          context: '19 世纪英国小说',
        }),
      }),
    );

    assert.equal(created.status, 201);
    const bookId = created.body.book.id;
    assert.equal(created.body.book.pageCount, 0);

    for (let index = 0; index < 2; index += 1) {
      const bytes = index === 0 ? PNG : Buffer.concat([PNG, Buffer.from([0])]);
      const form = new FormData();
      form.append('image', new Blob([bytes], { type: 'image/png' }), `page-${index}.png`);
      const uploaded = await json(
        await fetch(`${base}/api/ebooks/${bookId}/pages`, { method: 'POST', body: form }),
      );
      assert.equal(uploaded.status, 201);
      assert.equal(uploaded.body.page.status, 'pending');
    }

    const duplicateForm = new FormData();
    duplicateForm.append('image', new Blob([PNG], { type: 'image/png' }), 'duplicate.png');
    const duplicate = await json(
      await fetch(`${base}/api/ebooks/${bookId}/pages`, {
        method: 'POST',
        body: duplicateForm,
      }),
    );
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.book.pageCount, 2);

    let book;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const response = await json(await fetch(`${base}/api/ebooks/${bookId}`));
      book = response.body.book;
      if (book.status === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.equal(book.status, 'done');
    assert.equal(book.pageCount, 2);
    assert.equal(book.doneCount, 2);
    assert.equal(book.progress, 100);
    assert.equal(book.pages.length, 2);
    assert.equal(book.pages[0].paragraphs[0].source, 'It is a truth universally acknowledged.');
    assert.equal(book.pages[0].paragraphs[0].translation, '译：It is a truth universally acknowledged.');

    const image = await fetch(`${base}/api/ebooks/${bookId}/pages/${book.pages[0].id}/image`);
    assert.equal(image.status, 200);
    assert.match(image.headers.get('content-type') || '', /image\/png/);
    assert.equal((await image.arrayBuffer()).byteLength, PNG.length);

    const list = await json(await fetch(`${base}/api/ebooks`));
    assert.equal(list.body.books.length, 1);
    assert.equal(list.body.books[0].title, 'Pride and Prejudice');
    assert.equal(list.body.books[0].coverPageId, book.pages[0].id);

    const removed = await json(
      await fetch(`${base}/api/ebooks/${bookId}/pages/${book.pages[1].id}`, {
        method: 'DELETE',
      }),
    );
    assert.equal(removed.status, 200);
    assert.equal(removed.body.book.pageCount, 1);
    const afterDelete = await json(await fetch(`${base}/api/ebooks/${bookId}`));
    assert.equal(afterDelete.body.book.pages[0].id, book.pages[0].id);
  });
});

test('ebook context and title can be edited', async () => {
  await withServer(async (base) => {
    const created = await json(
      await fetch(`${base}/api/ebooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Draft' }),
      }),
    );
    const bookId = created.body.book.id;

    const patched = await json(
      await fetch(`${base}/api/ebooks/${bookId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Emma', author: 'Jane Austen', context: '英国小说' }),
      }),
    );

    assert.equal(patched.status, 200);
    assert.equal(patched.body.book.title, 'Emma');
    assert.equal(patched.body.book.author, 'Jane Austen');
    assert.equal(patched.body.book.context, '英国小说');
  });
});
