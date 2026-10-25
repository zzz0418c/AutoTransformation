import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { LlmError } from '../server/lib/errors.js';
import { createLlm, mockContent } from '../server/llm.js';
import { splitParagraphs } from '../server/lib/text.js';
import { createStore } from '../server/store.js';

process.env.NODE_ENV = 'test';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function fakeLlm(overrides = {}) {
  return {
    demo: true,
    async transcribeImage() {
      return 'It is a truth.\n\nA second paragraph.';
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
    ...overrides,
  };
}

async function withServer(llm, run) {
  const dataDir = mkdtempSync(join(tmpdir(), 'at-api-'));
  const config = loadConfig({ LLM_MOCK: '1', LLM_API_KEY: '' });
  const store = createStore({ dataDir, timeZone: config.timeZone });
  const app = createApp({ config, llm, store });
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

const asJson = async (response) => ({ status: response.status, body: await response.json() });

test('GET /api/config reports demo mode', async () => {
  await withServer(fakeLlm(), async (base) => {
    const { status, body } = await asJson(await fetch(`${base}/api/config`));
    assert.equal(status, 200);
    assert.equal(body.demo, true);
    assert.equal(body.textModel, 'demo');
    assert.ok(body.maxUploadMb > 0);
  });
});

test('GET / serves the app with security headers', async () => {
  await withServer(fakeLlm(), async (base) => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await response.text(), /AutoTransformation/);
  });
});

test('POST /api/ocr transcribes an uploaded page', async () => {
  await withServer(fakeLlm(), async (base) => {
    const form = new FormData();
    form.append('image', new Blob([PNG], { type: 'image/png' }), 'page.png');
    form.append('context', '19 世纪英国小说');

    const { status, body } = await asJson(await fetch(`${base}/api/ocr`, { method: 'POST', body: form }));
    assert.equal(status, 200);
    assert.match(body.text, /It is a truth/);
    assert.match(body.text, /A second paragraph/);
  });
});

test('POST /api/ocr rejects non-images and missing files', async () => {
  await withServer(fakeLlm(), async (base) => {
    const bogus = new FormData();
    bogus.append('image', new Blob([Buffer.from('not an image')], { type: 'text/plain' }), 'notes.txt');

    const rejected = await asJson(await fetch(`${base}/api/ocr`, { method: 'POST', body: bogus }));
    assert.equal(rejected.status, 415);

    const empty = await asJson(await fetch(`${base}/api/ocr`, { method: 'POST', body: new FormData() }));
    assert.equal(empty.status, 400);
    assert.match(empty.body.error.message, /书页图片/);
  });
});

test('POST /api/translate aligns source and translation', async () => {
  await withServer(fakeLlm(), async (base) => {
    const { status, body } = await asJson(
      await fetch(`${base}/api/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'One.\n\nTwo.', context: '小说' }),
      }),
    );

    assert.equal(status, 200);
    assert.equal(body.paragraphs.length, 2);
    assert.equal(body.paragraphs[0].source, 'One.');
    assert.equal(body.paragraphs[0].translation, '译：One.');
    assert.equal(body.paragraphs[1].translation, '译：Two.');
  });
});

test('POST /api/translate validates empty input', async () => {
  await withServer(fakeLlm(), async (base) => {
    const { status, body } = await asJson(
      await fetch(`${base}/api/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '   ' }),
      }),
    );

    assert.equal(status, 400);
    assert.equal(body.error.code, 'bad_request');
  });
});

test('POST /api/word returns contextual and common senses', async () => {
  await withServer(fakeLlm(), async (base) => {
    const { status, body } = await asJson(
      await fetch(`${base}/api/word`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          word: 'Want',
          sentence: 'He must be in want of a wife.',
          paragraph: 'He must be in want of a wife.',
        }),
      }),
    );

    assert.equal(status, 200);
    assert.equal(body.word, 'Want');
    assert.equal(body.contextual.meaning, '语境义');
    assert.equal(body.common.length, 1);
  });
});

test('POST /api/word validates the selected text', async () => {
  await withServer(fakeLlm(), async (base) => {
    const { status } = await asJson(
      await fetch(`${base}/api/word`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: '123', sentence: 'Numbers only.' }),
      }),
    );

    assert.equal(status, 400);
  });
});

test('LLM failures surface as 502 with a readable message', async () => {
  const llm = fakeLlm({
    async explainWord() {
      throw new LlmError('模型接口返回 500：upstream exploded');
    },
  });

  await withServer(llm, async (base) => {
    const { status, body } = await asJson(
      await fetch(`${base}/api/word`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: 'want', sentence: 'in want of a wife' }),
      }),
    );

    assert.equal(status, 502);
    assert.equal(body.error.code, 'llm_error');
    assert.match(body.error.message, /upstream exploded/);
  });
});

test('malformed JSON gets a clear 400 instead of a generic 500', async () => {
  await withServer(fakeLlm(), async (base) => {
    const { status, body } = await asJson(
      await fetch(`${base}/api/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"text": ',
      }),
    );

    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_json');
  });
});

test('unknown API routes return JSON 404', async () => {
  await withServer(fakeLlm(), async (base) => {
    const { status, body } = await asJson(await fetch(`${base}/api/nope`));
    assert.equal(status, 404);
    assert.equal(body.error.code, 'not_found');
  });
});

test('mock provider returns the sample page in demo mode', async () => {
  const llm = createLlm({ demo: true });
  const paragraphs = splitParagraphs(mockContent.text);
  const translations = await llm.translateParagraphs(paragraphs);

  assert.equal(paragraphs.length, 2);
  assert.match(translations[0], /单身汉/);
  assert.match(translations[1], /四邻八舍/);

  const sense = await llm.explainWord({ word: 'want', sentence: 'must be in want of a wife.' });
  assert.match(sense.contextual.meaning, /旧义/);
  assert.ok(sense.common.length >= 2);
});
