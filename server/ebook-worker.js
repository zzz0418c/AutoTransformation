import { normalizeText, splitParagraphs } from './lib/text.js';

/**
 * One page at a time, in the order pages were uploaded. OCR and translation
 * are both remote calls, so serializing them keeps a 200-page import from
 * opening 200 concurrent requests (and burning the rate limit).
 */
export function createEbookWorker({ store, llm, config, logger = console }) {
  const queue = [];
  const queued = new Set();
  let running = false;

  function keyOf(bookId, pageId) {
    return `${bookId}:${pageId}`;
  }

  function enqueue(bookId, pageId) {
    const key = keyOf(bookId, pageId);
    if (queued.has(key)) return;

    try {
      const { page } = store.pageForWork(bookId, pageId);
      if (page.status === 'done') return;
    } catch {
      return;
    }

    queued.add(key);
    queue.push({ bookId, pageId, key });
    void pump();
  }

  async function processPage({ bookId, pageId }) {
    const { book, page } = store.pageForWork(bookId, pageId);
    if (page.status === 'done') return;

    store.updatePage(bookId, pageId, { status: 'processing', error: '' });

    try {
      const image = store.readImage(bookId, pageId);
      const context = book.context || config.bookContext;
      const text = normalizeText(
        await llm.transcribeImage({
          base64: image.buffer.toString('base64'),
          mime: image.mime,
          context,
        }),
      );

      if (!text) throw new Error('没有从图片里识别出文字。');

      const paragraphs = splitParagraphs(text);
      if (!paragraphs.length) throw new Error('没有可翻译的段落。');

      const translations = await llm.translateParagraphs(paragraphs, context);
      store.updatePage(bookId, pageId, {
        status: 'done',
        error: '',
        sourceText: text,
        paragraphs: paragraphs.map((source, index) => ({
          id: index + 1,
          source,
          translation: translations[index] ?? '',
        })),
      });
    } catch (error) {
      if (error?.code === 'not_found') return;
      const message = error?.message || '这一页处理失败。';
      store.updatePage(bookId, pageId, { status: 'error', error: message });
      logger.error?.(`[ebook] ${bookId}/${pageId}: ${message}`);
    }
  }

  async function pump() {
    if (running) return;
    running = true;

    try {
      while (queue.length) {
        const job = queue.shift();
        try {
          await processPage(job);
        } catch (error) {
          if (error?.code !== 'not_found') {
            logger.error?.(`[ebook] ${job.bookId}/${job.pageId}: ${error?.message || error}`);
          }
        } finally {
          queued.delete(job.key);
        }
      }
    } finally {
      running = false;
    }
  }

  function recover() {
    for (const job of store.recover()) enqueue(job.bookId, job.pageId);
  }

  return {
    enqueue,
    recover,
    get pending() {
      return queue.length;
    },
  };
}
