import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpError, LlmError } from './lib/errors.js';
import { normalizeText, splitParagraphs } from './lib/text.js';

const defaultPublicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

function readString(value, field, { required = true, max = 2000 } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw new HttpError(400, `${field}不能为空。`);
  if (text.length > max) throw new HttpError(400, `${field}太长（最多 ${max} 个字符）。`);
  return text;
}

/** Trust the bytes, not the browser-supplied MIME type. */
function detectImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.subarray(0, 8).equals(png)) return 'image/png';

  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }

  return null;
}

export function createApp({ config, llm, publicDir = defaultPublicDir }) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'",
        "font-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    next();
  });

  app.use(express.json({ limit: '256kb' }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
  });

  app.get('/api/config', (req, res) => {
    res.json({
      demo: config.demo,
      textModel: config.demo ? 'demo' : config.text.model,
      visionModel: config.demo ? 'demo' : config.vision.model,
      bookContext: config.bookContext,
      maxUploadMb: config.maxUploadMb,
    });
  });

  app.post(
    '/api/ocr',
    upload.single('image'),
    asyncHandler(async (req, res) => {
      if (!req.file) throw new HttpError(400, '请上传一张书页图片。');

      const mime = detectImageType(req.file.buffer);
      if (!mime) throw new HttpError(415, '只支持 JPG、PNG 或 WebP 图片。');

      const context = readString(req.body?.context, '书籍背景', { required: false, max: 200 });
      const text = normalizeText(
        await llm.transcribeImage({
          base64: req.file.buffer.toString('base64'),
          mime,
          context: context || config.bookContext,
        }),
      );

      if (!text) {
        throw new HttpError(422, '没有从图片里识别出文字，请换一张更清晰的照片。');
      }

      res.json({ text, demo: config.demo });
    }),
  );

  app.post(
    '/api/translate',
    asyncHandler(async (req, res) => {
      const text = readString(req.body?.text, '原文', { max: 20000 });
      const context =
        readString(req.body?.context, '书籍背景', { required: false, max: 200 }) || config.bookContext;

      const paragraphs = splitParagraphs(text);
      if (!paragraphs.length) throw new HttpError(400, '没有可翻译的段落。');

      const translations = await llm.translateParagraphs(paragraphs, context);

      res.json({
        demo: config.demo,
        paragraphs: paragraphs.map((source, index) => ({
          id: index + 1,
          source,
          translation: translations[index] ?? '',
        })),
      });
    }),
  );

  app.post(
    '/api/word',
    asyncHandler(async (req, res) => {
      const word = readString(req.body?.word, '单词', { max: 120 });
      if (!/[A-Za-z]/.test(word)) throw new HttpError(400, '请选择一个英文单词或短语。');

      const sentence = readString(req.body?.sentence, '句子', { max: 800 });
      const paragraph = readString(req.body?.paragraph, '段落', { required: false, max: 4000 });
      const context =
        readString(req.body?.context, '书籍背景', { required: false, max: 200 }) || config.bookContext;

      const sense = await llm.explainWord({ word, sentence, paragraph, context });
      res.json({ ...sense, demo: config.demo });
    }),
  );

  app.use(express.static(publicDir, { extensions: ['html'] }));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: '接口不存在。' } });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);

    if (error instanceof multer.MulterError) {
      const message =
        error.code === 'LIMIT_FILE_SIZE'
          ? `图片太大（上限 ${config.maxUploadMb} MB）。`
          : '图片上传失败。';
      return res.status(413).json({ error: { code: 'upload_error', message } });
    }

    if (error.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'payload_too_large', message: '请求内容太大。' } });
    }

    if (error.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'invalid_json', message: '请求不是合法的 JSON。' } });
    }

    const status = Number(error.status) || 500;
    if (status >= 500 && process.env.NODE_ENV !== 'test') {
      console.error('[auto-transformation]', error);
    }

    const isPublic = error instanceof HttpError || error instanceof LlmError;
    const message = isPublic ? error.message : '服务器内部错误。';

    return res.status(status).json({
      error: { code: error.code || 'internal_error', message },
    });
  });

  return app;
}
