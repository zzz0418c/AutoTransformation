import { LlmError } from './lib/errors.js';
import { extractJson } from './lib/json.js';
import { chunkParagraphs } from './lib/text.js';
import {
  transcribePrompt,
  translateOnePrompt,
  translatePrompt,
  wordPrompt,
} from './prompts.js';

const SAMPLE_TEXT = `It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.

However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered as the rightful property of some one or other of their daughters.`;

// Original translations written for this demo, so no copyrighted text is bundled.
const SAMPLE_TRANSLATIONS = {
  'It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.':
    '有钱的单身汉总想娶位太太，这已是一条举世公认的真理。',
  'However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered as the rightful property of some one or other of their daughters.':
    '这样一个男人刚搬到一个地方时，他的感情或想法旁人几乎无从得知；但这条真理在四邻八舍心里根深蒂固，以至于不论他落到谁家女儿手里，都算那姑娘理所应当的财产。',
};

const MOCK_SENSES = {
  want: {
    lemma: 'want',
    contextual: { pos: 'n.', meaning: '（旧义）缺乏，需要' },
    common: [
      { pos: 'v.', meaning: '想要，希望' },
      { pos: 'v.', meaning: '需要' },
    ],
  },
  possession: {
    lemma: 'possession',
    contextual: { pos: 'n.', meaning: '拥有，持有' },
    common: [
      { pos: 'n.', meaning: '所有物，财产' },
      { pos: 'n.', meaning: '（体育）控球权' },
    ],
  },
  fortune: {
    lemma: 'fortune',
    contextual: { pos: 'n.', meaning: '财产，一大笔钱' },
    common: [
      { pos: 'n.', meaning: '运气，命运' },
      { pos: 'n.', meaning: '财富' },
    ],
  },
  acknowledged: {
    lemma: 'acknowledge',
    contextual: { pos: 'v.', meaning: '公认，承认（此处为被动）' },
    common: [
      { pos: 'v.', meaning: '承认' },
      { pos: 'v.', meaning: '确认收到' },
    ],
  },
  property: {
    lemma: 'property',
    contextual: { pos: 'n.', meaning: '（旧义）所属物，所有物' },
    common: [
      { pos: 'n.', meaning: '财产，房产' },
      { pos: 'n.', meaning: '性质，属性' },
    ],
  },
  neighbourhood: {
    lemma: 'neighbourhood',
    contextual: { pos: 'n.', meaning: '邻近地区，街坊' },
    common: [{ pos: 'n.', meaning: '社区，街区' }],
  },
};

function cleanTranscription(raw) {
  return raw
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```$/, '')
    .replace(/^(transcription|text|ocr result)\s*:\s*/i, '')
    .trim();
}

function normalizeSense(raw, fallbackWord) {
  const data = extractJson(raw);
  const contextual = data?.contextual;
  const contextualMeaning = typeof contextual?.meaning === 'string' ? contextual.meaning.trim() : '';

  if (!contextualMeaning) throw new Error('missing contextual meaning');

  const common = (Array.isArray(data.common) ? data.common : [])
    .map((item) => ({
      pos: String(item?.pos ?? '').trim(),
      meaning: String(item?.meaning ?? '').trim(),
    }))
    .filter((item) => item.meaning)
    .slice(0, 4);

  if (!common.length) throw new Error('missing common meanings');

  return {
    word: fallbackWord,
    lemma: String(data.lemma ?? fallbackWord).trim() || fallbackWord,
    contextual: {
      pos: String(contextual.pos ?? '').trim(),
      meaning: contextualMeaning,
    },
    common,
  };
}

/**
 * DeepSeek enables thinking mode by default, which is wasted latency and money
 * for OCR, translation, and short dictionary answers. Other providers do not
 * understand this field, so it is only attached for DeepSeek endpoints.
 */
export function buildRequestBody({ provider, messages, temperature, maxTokens, thinking = 'auto' }) {
  const body = {
    model: provider.model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  if (String(provider.baseUrl).toLowerCase().includes('deepseek.com')) {
    body.thinking = { type: thinking === 'enabled' ? 'enabled' : 'disabled' };
  }

  return body;
}

function createMockLlm() {
  return {
    demo: true,

    async transcribeImage() {
      return SAMPLE_TEXT;
    },

    async translateParagraphs(paragraphs) {
      return paragraphs.map((paragraph) => {
        const known = SAMPLE_TRANSLATIONS[paragraph.trim()];
        return known ?? '（演示模式）这里会显示这一段的中文译文。配置 API Key 后即可得到真实翻译。';
      });
    },

    async explainWord({ word }) {
      const key = word.toLowerCase().replace(/[^a-z' -]/g, '').trim();
      const known = MOCK_SENSES[key];
      if (known) return { word, ...known };

      return {
        word,
        lemma: key || word,
        contextual: {
          pos: '—',
          meaning: '（演示模式）配置 API Key 后，这里会给出这个词在本句中的具体含义。',
        },
        common: [{ pos: '—', meaning: '（演示模式）这里会列出它最常用的几个义项。' }],
      };
    },
  };
}

function createRemoteLlm(config) {
  async function chat(provider, messages, options = {}) {
    const { temperature = 0.2, maxTokens = 2000 } = options;

    if (!provider.key) {
      throw new LlmError('没有配置模型 API Key，请检查 .env。');
    }

    let response;
    try {
      response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.key}`,
        },
        body: JSON.stringify(
          buildRequestBody({
            provider,
            messages,
            temperature,
            maxTokens,
            thinking: config.thinking,
          }),
        ),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      const reason = error?.name === 'TimeoutError' ? '请求超时' : '网络连接失败';
      throw new LlmError(`${reason}，请检查 LLM_BASE_URL 和网络。`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const detail = body.replace(/\s+/g, ' ').slice(0, 240);
      throw new LlmError(`模型接口返回 ${response.status}${detail ? `：${detail}` : ''}`);
    }

    const data = await response.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new LlmError('模型没有返回内容。');
    }
    return content;
  }

  async function translateChunk(chunk, context) {
    const expected = chunk.map((item) => item.id);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const raw = await chat(
        config.text,
        [{ role: 'user', content: translatePrompt(context, chunk, attempt > 0) }],
        { temperature: 0.2, maxTokens: 4000 },
      );

      let parsed;
      try {
        parsed = extractJson(raw);
      } catch {
        continue;
      }

      const items = Array.isArray(parsed?.translations) ? parsed.translations : [];
      const translated = new Map();
      for (const item of items) {
        const id = Number(item?.id);
        const value = typeof item?.text === 'string' ? item.text.trim() : '';
        if (Number.isInteger(id) && value && expected.includes(id)) translated.set(id, value);
      }
      if (translated.size === expected.length) return translated;
    }

    // Last resort: translate one paragraph at a time so a formatting failure
    // never loses the whole page.
    const translated = new Map();
    for (const item of chunk) {
      const raw = await chat(
        config.text,
        [{ role: 'user', content: translateOnePrompt(context, item.text) }],
        { temperature: 0.2, maxTokens: 1500 },
      );
      translated.set(item.id, raw.trim().replace(/^["“]|["”]$/g, ''));
    }
    return translated;
  }

  return {
    demo: false,

    async transcribeImage({ base64, mime, context }) {
      const raw = await chat(
        config.vision,
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: transcribePrompt(context || config.bookContext) },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
            ],
          },
        ],
        { temperature: 0, maxTokens: 2500 },
      );
      return cleanTranscription(raw);
    },

    async translateParagraphs(paragraphs, context) {
      const translations = new Array(paragraphs.length).fill('');
      for (const chunk of chunkParagraphs(paragraphs)) {
        const translated = await translateChunk(chunk, context || config.bookContext);
        for (const [id, value] of translated) translations[id - 1] = value;
      }
      return translations;
    },

    async explainWord({ word, sentence, paragraph, context }) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const raw = await chat(
          config.text,
          [
            {
              role: 'user',
              content: wordPrompt({
                context: context || config.bookContext,
                word,
                sentence,
                paragraph,
                strict: attempt > 0,
              }),
            },
          ],
          { temperature: 0.2, maxTokens: 900 },
        );

        try {
          return normalizeSense(raw, word);
        } catch {
          // retry once with a stricter instruction
        }
      }
      throw new LlmError('模型返回的词义格式无法解析，请再点一次。');
    },
  };
}

export function createLlm(config) {
  return config.demo ? createMockLlm() : createRemoteLlm(config);
}

export const mockContent = {
  text: SAMPLE_TEXT,
  translations: SAMPLE_TRANSLATIONS,
};
