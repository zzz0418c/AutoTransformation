import { randomUUID, createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { HttpError } from './lib/errors.js';

const SCHEMA_VERSION = 1;
const FILE_NAME = 'ebooks.json';
const IMAGE_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

function cleanText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function normalizedText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function storedImageHash(bookId, page) {
  if (page.image?.sha256) return page.image.sha256;
  if (!page.image) return '';
  try {
    return hashBuffer(readFileSync(join(imageRoot, bookId, `${page.id}.${page.image.ext}`)));
  } catch {
    return '';
  }
}

function statusOf(pages) {
  if (!pages.length) return 'empty';
  const pending = pages.filter((page) => page.status === 'pending' || page.status === 'processing').length;
  if (pending) return 'processing';
  return pages.some((page) => page.status === 'error') ? 'error' : 'done';
}

function summarize(book) {
  const pages = Array.isArray(book.pages) ? book.pages : [];
  const doneCount = pages.filter((page) => page.status === 'done').length;
  const errorCount = pages.filter((page) => page.status === 'error').length;
  const pendingCount = pages.filter(
    (page) => page.status === 'pending' || page.status === 'processing',
  ).length;
  const cover = pages.find((page) => page.image);

  return {
    id: book.id,
    title: book.title,
    author: book.author,
    context: book.context,
    pageCount: pages.length,
    doneCount,
    errorCount,
    pendingCount,
    progress: pages.length ? Math.round((doneCount / pages.length) * 100) : 0,
    status: statusOf(pages),
    coverPageId: cover?.id ?? null,
    hasCover: Boolean(book.cover),
    lastPage: Math.min(Math.max(Number(book.lastPage) || 0, 0), Math.max(pages.length - 1, 0)),
    lastPart: Math.max(Number(book.lastPart) || 0, 0),
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
  };
}

function pageSummary(page, index) {
  return {
    id: page.id,
    index,
    status: page.status,
    error: page.error || '',
    hasImage: Boolean(page.image),
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}

function publicBook(book) {
  return {
    ...summarize(book),
    pages: book.pages.map((page, index) => ({
      ...pageSummary(page, index),
      sourceText: page.sourceText || '',
      paragraphs: Array.isArray(page.paragraphs) ? page.paragraphs : [],
    })),
  };
}

export function createEbookStore({ dataDir }) {
  if (!dataDir) throw new Error('dataDir is required');

  const imageRoot = join(dataDir, 'ebooks');
  mkdirSync(imageRoot, { recursive: true });
  const file = join(dataDir, FILE_NAME);

  function read() {
    if (!existsSync(file)) return { version: SCHEMA_VERSION, books: [] };

    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return {
        version: SCHEMA_VERSION,
        books: Array.isArray(parsed.books) ? parsed.books : [],
      };
    } catch {
      try {
        renameSync(file, `${file}.broken-${Date.now()}`);
      } catch {
        // ignore
      }
      return { version: SCHEMA_VERSION, books: [] };
    }
  }

  function write(data) {
    const payload = `${JSON.stringify({ version: SCHEMA_VERSION, books: data.books }, null, 2)}\n`;
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

  function requireBook(data, id) {
    const book = data.books.find((item) => item.id === id);
    if (!book) throw new HttpError(404, '电子书不存在。', 'not_found');
    return book;
  }

  function requirePage(book, pageId) {
    const page = book.pages.find((item) => item.id === pageId);
    if (!page) throw new HttpError(404, '书页不存在。', 'not_found');
    return page;
  }

  return {
    list() {
      return read()
        .books.slice()
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .map(summarize);
    },

    get(id) {
      const book = read().books.find((item) => item.id === id);
      return book ? publicBook(book) : null;
    },

    create({ title, author = '', context = '' } = {}) {
      const data = read();
      const now = new Date().toISOString();
      const book = {
        id: newId('book'),
        title: cleanText(title, 120) || '未命名电子书',
        author: cleanText(author, 120),
        context: cleanText(context, 200),
        createdAt: now,
        updatedAt: now,
        lastPage: 0,
        lastPart: 0,
        cover: null,
        pages: [],
      };
      data.books.unshift(book);
      write(data);
      return publicBook(book);
    },

    addPage(bookId, { buffer, mime }) {
      const ext = IMAGE_EXT[mime];
      if (!ext) throw new HttpError(415, '只支持 JPG、PNG 或 WebP 图片。');

      const data = read();
      const book = requireBook(data, bookId);
      const sha256 = hashBuffer(buffer);

      for (let index = 0; index < book.pages.length; index += 1) {
        const existing = book.pages[index];
        if (!existing.image) continue;
        if (storedImageHash(book.id, existing) === sha256) {
          return {
            duplicate: true,
            page: pageSummary(existing, index),
            book: summarize(book),
          };
        }
      }

      const now = new Date().toISOString();
      const page = {
        id: newId('page'),
        status: 'pending',
        error: '',
        image: { ext, mime, bytes: buffer.length, sha256 },
        sourceText: '',
        paragraphs: [],
        createdAt: now,
        updatedAt: now,
      };

      const dir = join(imageRoot, book.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${page.id}.${ext}`), buffer);

      book.pages.push(page);
      book.updatedAt = now;
      write(data);
      return { page: pageSummary(page, book.pages.length - 1), book: summarize(book) };
    },

    deletePage(bookId, pageId) {
      const data = read();
      const book = requireBook(data, bookId);
      const page = requirePage(book, pageId);
      book.pages = book.pages.filter((item) => item.id !== pageId);
      book.lastPage = Math.min(book.lastPage, Math.max(book.pages.length - 1, 0));
      book.lastPart = Math.max(Number(book.lastPart) || 0, 0);
      book.updatedAt = new Date().toISOString();
      write(data);
      if (page.image) {
        try {
          unlinkSync(join(imageRoot, book.id, `${page.id}.${page.image.ext}`));
        } catch {
          // A missing source image must not block cleanup.
        }
      }
      return { page: pageSummary(page, 0), book: summarize(book) };
    },

    findDuplicateText(bookId, pageId, sourceText) {
      const wanted = normalizedText(sourceText);
      if (wanted.length < 20) return null;

      const book = read().books.find((item) => item.id === bookId);
      if (!book) return null;

      for (let index = 0; index < book.pages.length; index += 1) {
        const page = book.pages[index];
        if (page.id === pageId) continue;
        if (page.sourceText && normalizedText(page.sourceText) === wanted) {
          return pageSummary(page, index);
        }
      }
      return null;
    },

    updatePage(bookId, pageId, patch) {
      const data = read();
      const book = requireBook(data, bookId);
      const page = requirePage(book, pageId);
      Object.assign(page, patch, { updatedAt: new Date().toISOString() });
      book.updatedAt = page.updatedAt;
      write(data);
      return pageSummary(page, book.pages.indexOf(page));
    },

    updateBook(bookId, patch) {
      const data = read();
      const book = requireBook(data, bookId);
      if (patch.title !== undefined) book.title = cleanText(patch.title, 120) || book.title;
      if (patch.author !== undefined) book.author = cleanText(patch.author, 120);
      if (patch.context !== undefined) book.context = cleanText(patch.context, 200);
      if (patch.lastPage !== undefined) {
        book.lastPage = Math.min(
          Math.max(Number(patch.lastPage) || 0, 0),
          Math.max(book.pages.length - 1, 0),
        );
      }
      if (patch.lastPart !== undefined) {
        book.lastPart = Math.max(Number(patch.lastPart) || 0, 0);
      }
      book.updatedAt = new Date().toISOString();
      write(data);
      return publicBook(book);
    },

    delete(bookId) {
      const data = read();
      const book = requireBook(data, bookId);
      data.books = data.books.filter((item) => item.id !== bookId);
      write(data);
      rmSync(join(imageRoot, book.id), { recursive: true, force: true });
    },

    setCover(bookId, { buffer, mime, ext, source = '' }) {
      const data = read();
      const book = requireBook(data, bookId);
      const extension = ext || IMAGE_EXT[mime];
      if (!extension || !buffer?.length) {
        throw new HttpError(500, '封面图片无效。', 'cover_invalid');
      }

      const dir = join(imageRoot, book.id);
      mkdirSync(dir, { recursive: true });
      if (book.cover?.ext && book.cover.ext !== extension) {
        try {
          unlinkSync(join(dir, `cover.${book.cover.ext}`));
        } catch {
          // ignore a missing old cover
        }
      }

      writeFileSync(join(dir, `cover.${extension}`), buffer);
      book.cover = {
        ext: extension,
        mime,
        bytes: buffer.length,
        source,
        updatedAt: new Date().toISOString(),
      };
      book.updatedAt = new Date().toISOString();
      write(data);
      return publicBook(book);
    },

    readCover(bookId) {
      const data = read();
      const book = requireBook(data, bookId);
      if (!book.cover) throw new HttpError(404, '这本电子书还没有封面。', 'not_found');
      return {
        buffer: readFileSync(join(imageRoot, book.id, `cover.${book.cover.ext}`)),
        mime: book.cover.mime,
      };
    },

    readImage(bookId, pageId) {
      const data = read();
      const book = requireBook(data, bookId);
      const page = requirePage(book, pageId);
      if (!page.image) throw new HttpError(404, '这一页没有原图。', 'not_found');
      return {
        buffer: readFileSync(join(imageRoot, book.id, `${page.id}.${page.image.ext}`)),
        mime: page.image.mime,
      };
    },

    recover() {
      const data = read();
      const jobs = [];
      let changed = false;

      for (const book of data.books) {
        for (const page of book.pages) {
          if (page.status === 'processing') {
            page.status = 'pending';
            page.updatedAt = new Date().toISOString();
            changed = true;
          }
          if (page.status === 'pending') jobs.push({ bookId: book.id, pageId: page.id });
        }
      }

      if (changed) write(data);
      return jobs;
    },

    snapshot(bookId) {
      const data = read();
      return summarize(requireBook(data, bookId));
    },

    pageForWork(bookId, pageId) {
      const data = read();
      const book = requireBook(data, bookId);
      const page = requirePage(book, pageId);
      return { book, page, index: book.pages.indexOf(page) };
    },
  };
}
