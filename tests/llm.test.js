import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../server/config.js';
import { buildRequestBody } from '../server/llm.js';

test('config defaults to deepseek-flash and auto thinking', () => {
  const config = loadConfig({ LLM_API_KEY: 'sk-test' });

  assert.equal(config.text.model, 'deepseek-flash');
  assert.equal(config.text.baseUrl, 'https://api.deepseek.com');
  assert.equal(config.thinking, 'auto');
  assert.equal(config.vision.model, 'deepseek-flash');
  assert.equal(config.vision.baseUrl, 'https://api.deepseek.com');
});

test('deepseek requests disable thinking unless explicitly enabled', () => {
  const provider = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
  const base = { provider, messages: [], temperature: 0.2, maxTokens: 100 };

  assert.deepEqual(buildRequestBody({ ...base, thinking: 'auto' }).thinking, {
    type: 'disabled',
  });
  assert.deepEqual(buildRequestBody({ ...base, thinking: 'disabled' }).thinking, {
    type: 'disabled',
  });
  assert.deepEqual(buildRequestBody({ ...base, thinking: 'enabled' }).thinking, {
    type: 'enabled',
  });
});

test('other providers do not receive the thinking field', () => {
  const body = buildRequestBody({
    provider: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini' },
    messages: [],
    temperature: 0.2,
    maxTokens: 100,
    thinking: 'disabled',
  });

  assert.equal('thinking' in body, false);
  assert.equal(body.model, 'gpt-5-mini');
});
