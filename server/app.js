import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { HttpError, LlmError } from './lib/errors.js';
import { isDateOnly, todayInZone } from './lib/time.js';
import { normalizeText, splitParagraphs } from './lib/text.js';
import { buildIcs } from './ics.js';
import { findBookCover } from './book-cover.js';
import { createEbookStore } from './ebook-store.js';
import { createEbookWorker } from './ebook-worker.js';
import { dueNotebooks } from './reminders.js';
import { createStore, summarizeNotebook } from './store.js';

const defaultPublicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

function tokensMatch(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

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

function notebookMarkdown(notebook) {
  const lines = [
    `# ${notebook.title}`,
    '',
    `- 创建：${notebook.createdAt}`,
    `- 下次复习：${notebook.reviewDate ?? '未设置'}`,
    `- 词数：${notebook.entries.length}`,
    '',
  ];

  for (const entry of notebook.entries) {
    lines.push(`## ${entry.term}`);
    if (entry.lemma && entry.lemma.toLowerCase() !== entry.term.toLowerCase()) {
      lines.push(`- 原形：${entry.lemma}`);
    }
    lines.push(
      `- 语境义：${[entry.contextual?.pos, entry.contextual?.meaning].filter(Boolean).join(' ')}`,
    );
    if (entry.common?.length) {
      lines.push(
        `- 常用义：${entry.common
          .map((item) => [item.pos, item.meaning].filter(Boolean).join(' '))
          .join('；')}`,
      );
    }
    if (entry.sentence) lines.push(`- 原句：${entry.sentence}`);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** Text format understood by `vocabcurve import`. */
function vocabcurveText(notebooks) {
  const lists = notebooks.filter((notebook) => notebook.entries.length);
  const lines = [];

  lists.forEach((notebook, index) => {
    lines.push(`第${index + 1}篇 ${notebook.title.replace(/\s+/g, ' ')}`);
    for (const entry of notebook.entries) {
      const meaning =
        entry.contextual?.meaning || entry.common?.[0]?.meaning || '—';
      lines.push(`${entry.term}  ${meaning}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}

function sendDownload(res, filename, contentType, body) {
  res.setHeader('Content-Type', `${contentType}; charset=utf-8`);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

export function createApp({
  config,
  llm,
  store,
  ebookStore,
  ebookWorker,
  coverFinder = findBookCover,
  publicDir = defaultPublicDir,
}) {
  const app = express();
  const notebooks =
    store ?? createStore({ dataDir: config.dataDir, timeZone: config.timeZone });
  const ebooks = ebookStore ?? createEbookStore({ dataDir: config.dataDir });
  const ebookJobs =
    ebookWorker ?? createEbookWorker({ store: ebooks, llm, config });

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

  if (config.accessToken) {
    app.use((req, res, next) => {
      const queryToken = typeof req.query?.token === 'string' ? req.query.token : '';
      const cookieToken = readCookie(req.headers.cookie, 'at_access');
      const headerToken =
        req.get('x-access-token') ||
        String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const provided = queryToken || headerToken || cookieToken;

      if (provided && tokensMatch(provided, config.accessToken)) {
        if (queryToken && req.method === 'GET' && !req.path.startsWith('/api/')) {
          res.cookie('at_access', config.accessToken, {
            httpOnly: true,
            sameSite: 'lax',
            secure: req.secure || req.get('x-forwarded-proto') === 'https',
            maxAge: 365 * 24 * 60 * 60 * 1000,
            path: '/',
          });
          const target = new URL(req.originalUrl, 'http://localhost');
          target.searchParams.delete('token');
          return res.redirect(303, `${target.pathname}${target.search}`);
        }
        return next();
      }

      if (req.path.startsWith('/api/')) {
        return res.status(401).json({
          error: { code: 'unauthorized', message: '需要访问令牌。' },
        });
      }

      return res
        .status(401)
        .type('html')
        .send(
          '<!doctype html><meta charset="utf-8"><title>需要访问令牌</title>' +
            '<body style="font-family:serif;max-width:32rem;margin:12vh auto;padding:0 1.5rem;color:#2b2118">' +
            '<h1 style="font-weight:500">需要访问令牌</h1>' +
            '<p style="line-height:1.8;color:#6b5a49">请使用带访问令牌的完整地址打开这个页面。</p>' +
            '</body>',
        );
    });
  }

  app.use(express.json({ limit: '256kb' }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
  });

  const today = () => todayInZone(config.timeZone);

  function requireNotebook(id) {
    const notebook = notebooks.get(id);
    if (!notebook) throw new HttpError(404, '生词本不存在。', 'not_found');
    return notebook;
  }

  app.get('/api/config', (req, res) => {
    res.json({
      demo: config.demo,
      textModel: config.demo ? 'demo' : config.text.model,
      visionModel: config.demo ? 'demo' : config.vision.model,
      bookContext: config.bookContext,
      maxUploadMb: config.maxUploadMb,
      remindAt: config.remindAt,
      timeZone: config.timeZone,
      today: today(),
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
      const requestedId = readString(req.body?.notebookId, '生词本', { required: false, max: 80 });

      const paragraphs = splitParagraphs(text);
      if (!paragraphs.length) throw new HttpError(400, '没有可翻译的段落。');

      const translations = await llm.translateParagraphs(paragraphs, context);

      const existing = requestedId ? notebooks.get(requestedId) : null;
      const notebook = existing
        ? notebooks.updateSource(existing.id, text)
        : notebooks.create({ source: text });

      res.json({
        demo: config.demo,
        paragraphs: paragraphs.map((source, index) => ({
          id: index + 1,
          source,
          translation: translations[index] ?? '',
        })),
        notebook,
      });
    }),
  );

  app.get('/api/ebooks', (req, res) => {
    res.json({ books: ebooks.list() });
  });

  app.post(
    '/api/ebooks',
    asyncHandler(async (req, res) => {
      const title = readString(req.body?.title, '书名', { required: false, max: 120 });
      const author = readString(req.body?.author, '作者', { required: false, max: 120 });
      const context = readString(req.body?.context, '书籍背景', { required: false, max: 200 });
      let book = ebooks.create({ title, author, context });

      if (title) {
        try {
          const cover = await coverFinder({ title, author });
          if (cover) book = ebooks.setCover(book.id, cover);
        } catch {
          // A missing cover must never block creating the book.
        }
      }

      res.status(201).json({ book });
    }),
  );

  app.post(
    '/api/ebooks/:id/cover',
    asyncHandler(async (req, res) => {
      const existing = ebooks.get(req.params.id);
      if (!existing) throw new HttpError(404, '电子书不存在。', 'not_found');

      const cover = await coverFinder({ title: existing.title, author: existing.author });
      const book = cover ? ebooks.setCover(existing.id, cover) : existing;
      res.json({ book });
    }),
  );

  app.get('/api/ebooks/:id/cover', (req, res, next) => {
    try {
      const image = ebooks.readCover(req.params.id);
      res
        .type(image.mime)
        .set('Cache-Control', 'private, max-age=31536000, immutable')
        .send(image.buffer);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/ebooks/:id/pages/:pageId/image', (req, res, next) => {
    try {
      const book = ebooks.get(req.params.id);
      const page = book?.pages.find((item) => item.id === req.params.pageId);
      if (!book || !page) throw new HttpError(404, '书页不存在。', 'not_found');
      if (!page.hasImage) throw new HttpError(404, '这一页没有原图。', 'not_found');

      const image = ebooks.readImage(book.id, page.id);
      res
        .type(image.mime)
        .set('Cache-Control', 'private, max-age=31536000, immutable')
        .send(image.buffer);
    } catch (error) {
      next(error);
    }
  });

  app.get(
    '/api/ebooks/:id',
    asyncHandler(async (req, res) => {
      const book = ebooks.get(req.params.id);
      if (!book) throw new HttpError(404, '电子书不存在。', 'not_found');
      res.json({ book });
    }),
  );

  app.post(
    '/api/ebooks/:id/pages',
    upload.single('image'),
    asyncHandler(async (req, res) => {
      if (!req.file) throw new HttpError(400, '请选择一张书页图片。');

      const mime = detectImageType(req.file.buffer);
      if (!mime) throw new HttpError(415, '只支持 JPG、PNG 或 WebP 图片。');

      const result = ebooks.addPage(req.params.id, { buffer: req.file.buffer, mime });
      ebookJobs.enqueue(req.params.id, result.page.id);
      res.status(201).json(result);
    }),
  );

  app.patch(
    '/api/ebooks/:id',
    asyncHandler(async (req, res) => {
      const patch = {};
      if (req.body?.title !== undefined) {
        patch.title = readString(req.body.title, '书名', { required: false, max: 120 });
      }
      if (req.body?.author !== undefined) {
        patch.author = readString(req.body.author, '作者', { required: false, max: 120 });
      }
      if (req.body?.context !== undefined) {
        patch.context = readString(req.body.context, '书籍背景', { required: false, max: 200 });
      }
      if (req.body?.lastPage !== undefined) {
        patch.lastPage = Number(req.body.lastPage) || 0;
      }
      if (req.body?.lastPart !== undefined) {
        patch.lastPart = Number(req.body.lastPart) || 0;
      }

      const book = ebooks.updateBook(req.params.id, patch);
      res.json({ book });
    }),
  );

  app.delete('/api/ebooks/:id', (req, res) => {
    ebooks.delete(req.params.id);
    res.status(204).end();
  });

  app.post(
    '/api/ebooks/:id/pages/:pageId/retry',
    asyncHandler(async (req, res) => {
      const { page } = ebooks.pageForWork(req.params.id, req.params.pageId);
      ebooks.updatePage(req.params.id, req.params.pageId, { status: 'pending', error: '' });
      ebookJobs.enqueue(req.params.id, req.params.pageId);
      res.json({ page: { ...page, status: 'pending', error: '' } });
    }),
  );

  app.post(
    '/api/word',
    asyncHandler(async (req, res) => {      const word = readString(req.body?.word, '单词', { max: 120 });
      if (!/[A-Za-z]/.test(word)) throw new HttpError(400, '请选择一个英文单词或短语。');

      const sentence = readString(req.body?.sentence, '句子', { max: 800 });
      const paragraph = readString(req.body?.paragraph, '段落', { required: false, max: 4000 });
      const context =
        readString(req.body?.context, '书籍背景', { required: false, max: 200 }) || config.bookContext;
      const notebookId = readString(req.body?.notebookId, '生词本', {
        required: false,
        max: 80,
      });

      const sense = await llm.explainWord({ word, sentence, paragraph, context });

      let notebookEntry = null;
      if (notebookId) {
        const result = notebooks.addEntry(notebookId, {
          term: word,
          lemma: sense.lemma,
          contextual: sense.contextual,
          common: sense.common,
          sentence,
        });
        if (result) notebookEntry = { id: result.entry.id, added: result.added };
      }

      res.json({ ...sense, demo: config.demo, notebookEntry });
    }),
  );

  app.get('/api/notebooks', (req, res) => {
    const all = notebooks.list();
    const date = today();

    res.json({
      today: date,
      notebooks: all.map(summarizeNotebook),
      due: dueNotebooks(all, date, { includeNotified: true }).map(summarizeNotebook),
    });
  });

  app.post('/api/notebooks', (req, res) => {
    const title = readString(req.body?.title, '标题', { required: false, max: 120 });
    const source = readString(req.body?.source, '原文', { required: false, max: 20000 });
    const notebook = notebooks.create({ title, source });

    res.status(201).json({ notebook });
  });

  app.get('/api/notebooks/export.ics', (req, res) => {
    const ics = buildIcs(notebooks.list(), {
      timeZone: config.timeZone,
      remindAt: config.remindAt,
    });
    sendDownload(res, 'auto-transformation-reviews.ics', 'text/calendar', ics);
  });

  app.get('/api/notebooks/export/vocabcurve.txt', (req, res) => {
    sendDownload(
      res,
      'auto-transformation-vocabcurve.txt',
      'text/plain',
      vocabcurveText(notebooks.list()),
    );
  });

  app.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json');
    res.sendFile(path.join(publicDir, 'manifest.webmanifest'));
  });

  app.get('/api/notebooks/:id/export.ics', (req, res) => {
    const notebook = requireNotebook(req.params.id);
    const ics = buildIcs([notebook], {
      timeZone: config.timeZone,
      remindAt: config.remindAt,
    });
    sendDownload(res, `auto-transformation-${notebook.id}.ics`, 'text/calendar', ics);
  });

  app.get('/api/notebooks/:id/export.md', (req, res) => {
    const notebook = requireNotebook(req.params.id);
    sendDownload(
      res,
      `auto-transformation-${notebook.id}.md`,
      'text/markdown',
      notebookMarkdown(notebook),
    );
  });

  app.get('/api/notebooks/:id', (req, res) => {
    res.json({ notebook: requireNotebook(req.params.id) });
  });

  app.patch('/api/notebooks/:id', (req, res) => {
    const notebook = requireNotebook(req.params.id);
    const body = req.body ?? {};
    const patch = {};

    if (Object.hasOwn(body, 'title')) {
      patch.title = readString(body.title, '标题', { max: 120 });
    }

    if (Object.hasOwn(body, 'reviewDate')) {
      if (body.reviewDate === null || body.reviewDate === '') {
        patch.reviewDate = null;
      } else {
        const value = readString(body.reviewDate, '复习日期', { max: 10 });
        if (!isDateOnly(value)) throw new HttpError(400, '复习日期格式应为 YYYY-MM-DD。');
        patch.reviewDate = value;
      }
    }

    res.json({ notebook: notebooks.update(notebook.id, patch) });
  });

  app.delete('/api/notebooks/:id', (req, res) => {
    requireNotebook(req.params.id);
    notebooks.remove(req.params.id);
    res.status(204).end();
  });

  app.post('/api/notebooks/:id/entries', (req, res) => {
    const notebook = requireNotebook(req.params.id);
    const term = readString(req.body?.term ?? req.body?.word, '单词', { max: 120 });
    if (!/[A-Za-z]/.test(term)) throw new HttpError(400, '请选择一个英文单词或短语。');

    const result = notebooks.addEntry(notebook.id, {
      term,
      lemma: req.body?.lemma,
      contextual: req.body?.contextual,
      common: req.body?.common,
      sentence: req.body?.sentence,
    });

    res.status(result.added ? 201 : 200).json({ entry: result.entry, added: result.added });
  });

  app.delete('/api/notebooks/:id/entries/:entryId', (req, res) => {
    const notebook = requireNotebook(req.params.id);
    if (!notebooks.removeEntry(notebook.id, req.params.entryId)) {
      throw new HttpError(404, '这个词不在生词本里。', 'not_found');
    }
    res.status(204).end();
  });

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

  ebookJobs.recover?.();

  return app;
}
