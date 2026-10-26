import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { createStore } from '../server/store.js';

process.env.NODE_ENV = 'test';

const TOKEN = 'test-access-token';

function fakeLlm() {
  return {
    demo: true,
    async transcribeImage() {
      return 'It is a truth.';
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
  const dataDir = mkdtempSync(join(tmpdir(), 'at-auth-'));
  const config = loadConfig({
    LLM_MOCK: '1',
    LLM_API_KEY: '',
    ACCESS_TOKEN: TOKEN,
  });
  const store = createStore({ dataDir, timeZone: config.timeZone });
  const app = createApp({ config, llm: fakeLlm(), store });
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

function accessCookie(response) {
  const header = response.headers.get('set-cookie') || '';
  const match = header.match(/at_access=([^;]+)/);
  assert.ok(match, `missing access cookie: ${header}`);
  return `at_access=${match[1]}`;
}

test('access token gates the page and API', async () => {
  await withServer(async (base) => {
    const blockedPage = await fetch(`${base}/`);
    assert.equal(blockedPage.status, 401);

    const blockedApi = await fetch(`${base}/api/config`);
    assert.equal(blockedApi.status, 401);

    const redirect = await fetch(`${base}/?token=${TOKEN}`, { redirect: 'manual' });
    assert.equal(redirect.status, 303);
    const cookie = accessCookie(redirect);

    const page = await fetch(`${base}/`, { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /AutoTransformation/);

    const api = await fetch(`${base}/api/config`, { headers: { cookie } });
    assert.equal(api.status, 200);
    assert.equal((await api.json()).demo, true);
  });
});

test('wrong access token is rejected', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/?token=wrong-token`, { redirect: 'manual' });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('set-cookie'), null);
  });
});
