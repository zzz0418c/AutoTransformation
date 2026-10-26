import { sentenceAround, tokenize } from './js/text.js';
import { SAMPLE_TEXT } from './js/sample.js';

const $ = (selector) => document.querySelector(selector);

const MAX_EDGE = 1600;
const MAX_CONTEXT = 200;

const state = {
  file: null,
  previewUrl: null,
  paragraphs: [],
  demo: false,
  maxUploadMb: 12,
  bookContext: '',
  activeSpan: null,
  lookupToken: 0,
  lastSelectionAt: 0,
  notebook: null,
  notebooks: [],
  due: [],
  today: '',
  remindAt: '07:30',
  drawerTab: 'current',
  ebooks: [],
  ebook: null,
  ebookPage: 0,
  ebookPart: 0,
  ebookPageViews: [],
  ebookViewsPage: -1,
  ebookViewsTranslated: false,
  ebookTurning: false,
  ebookResizeTimer: null,
  ebookShowTranslation: false,
  ebookPollTimer: null,
  ebookImporting: false,
};

const steps = {
  upload: $('#step-upload'),
  text: $('#step-text'),
  read: $('#step-read'),
};

/* ------------------------------------------------------------------ utils */

async function getJson(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error('无法连接本地服务，请确认 npm start 还在运行。');
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error?.message || `请求失败（${response.status}）`);
  }
  return data ?? {};
}

async function deleteRequest(url) {
  let response;
  try {
    response = await fetch(url, { method: 'DELETE' });
  } catch {
    throw new Error('无法连接本地服务。');
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error?.message || `请求失败（${response.status}）`);
  }
}

function contextValue() {
  return ($('#book-context').value || '').trim().slice(0, MAX_CONTEXT);
}

function showStep(name) {
  for (const [key, element] of Object.entries(steps)) {
    element.hidden = key !== name;
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.hidden = false;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => {
    element.hidden = true;
  }, 4200);
}

function updateCount() {
  const length = $('#source-text').value.length;
  $('#char-count').textContent = `${length} 字符`;
}

function readStoredContext() {
  try {
    return localStorage.getItem('at.context') || '';
  } catch {
    return '';
  }
}

function storeContext(value) {
  try {
    localStorage.setItem('at.context', value);
  } catch {
    // Private mode or storage disabled: the field still works for this session.
  }
}

function formatDateCn(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!match) return date || '';
  return `${Number(match[2])}月${Number(match[3])}日`;
}

function dayNumber(date) {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function daysBetween(from, to) {
  if (!from || !to) return 0;
  return Math.round((dayNumber(to) - dayNumber(from)) / 86_400_000);
}

function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function reviewHint(date) {
  if (!date) return '选一个日期。当天会出现在日历里，也可以推送到微信。';

  const diff = daysBetween(state.today, date);
  const when = diff === 0 ? '今天' : diff > 0 ? `还有 ${diff} 天` : `已逾期 ${-diff} 天`;
  return `${when} · ${state.remindAt} 提醒（.ics 或推送）`;
}

/* ----------------------------------------------------------------- upload */

async function shrinkImage(file) {
  if (!window.createImageBitmap) return file;

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));

  if (scale === 1 && file.size <= 2.5 * 1024 * 1024) {
    bitmap.close?.();
    return file;
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob) return file;

  return new File([blob], 'page.jpg', { type: 'image/jpeg' });
}

async function handleFile(file) {
  if (!file) return;

  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    toast('只支持 JPG、PNG 或 WebP 图片。');
    return;
  }

  if (file.size > state.maxUploadMb * 1024 * 1024) {
    toast(`图片不能超过 ${state.maxUploadMb} MB。`);
    return;
  }

  setNotebook(null);
  closeDrawer();

  let prepared = file;
  try {
    prepared = await shrinkImage(file);
  } catch {
    // Fall back to the original file; the server will reject it if unreadable.
  }

  state.file = prepared;

  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(prepared);

  $('#preview').src = state.previewUrl;
  $('#preview-name').textContent = prepared.name || 'page.jpg';
  $('#preview-wrap').hidden = false;
  $('#dropzone').classList.add('has-image');
  $('#ocr-btn').disabled = false;
}

function clearImage() {
  state.file = null;
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;

  $('#preview').removeAttribute('src');
  $('#preview-wrap').hidden = true;
  $('#file-input').value = '';
  $('#ocr-btn').disabled = true;
  $('#dropzone').classList.remove('has-image');
  setNotebook(null);
}

function gotoText(text) {
  $('#source-text').value = text;
  updateCount();
  showStep('text');
  $('#source-text').focus({ preventScroll: true });
}

async function runOcr() {
  if (!state.file) {
    toast('先选一张书页照片。');
    return;
  }

  const button = $('#ocr-btn');
  button.disabled = true;
  button.textContent = '识别中…';

  try {
    const form = new FormData();
    form.append('image', state.file);
    form.append('context', contextValue());
    const data = await getJson('/api/ocr', { method: 'POST', body: form });
    gotoText(data.text || '');
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = !state.file;
    button.textContent = '识别文字';
  }
}

/* -------------------------------------------------------------- translate */

async function runTranslate() {
  const text = $('#source-text').value.trim();

  if (!text) {
    toast('先贴一段英文，或上传一张书页。');
    return;
  }
  if (text.length > 20000) {
    toast('一次最多 20000 个字符，请分成几段。');
    return;
  }

  const button = $('#translate-btn');
  button.disabled = true;
  button.textContent = '翻译中…';

  try {
    const data = await getJson('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        context: contextValue(),
        notebookId: state.notebook?.id,
      }),
    });

    state.paragraphs = Array.isArray(data.paragraphs) ? data.paragraphs : [];
    if (!state.paragraphs.length) throw new Error('没有返回译文，请重试。');

    if (data.notebook) setNotebook(data.notebook);
    renderReading();
    showStep('read');
    await loadNotebooks();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = '翻译这段';
  }
}

function renderReading() {
  const reading = $('#reading');
  reading.replaceChildren();

  let words = 0;

  state.paragraphs.forEach((paragraph, index) => {
    const row = document.createElement('div');
    row.className = 'pair';

    const english = document.createElement('p');
    english.className = 'para en';
    english.dataset.plain = paragraph.source;
    english.dataset.index = String(index);

    for (const token of tokenize(paragraph.source)) {
      if (token.type === 'text') {
        english.appendChild(document.createTextNode(token.value));
        continue;
      }

      words += 1;
      const span = document.createElement('span');
      span.className = 'w';
      span.textContent = token.value;
      span.dataset.start = String(token.start);
      span.dataset.end = String(token.end);
      english.appendChild(span);
    }

    const chinese = document.createElement('p');
    chinese.className = 'para zh';
    chinese.textContent = paragraph.translation || '（这段没有返回译文）';

    row.append(english, chinese);
    reading.appendChild(row);
  });

  $('#read-stats').textContent = `${state.paragraphs.length} 段 · ${words} 词`;
}

/* --------------------------------------------------------------- notebook */

function setNotebook(notebook) {
  state.notebook = notebook || null;
  const count = state.notebook ? state.notebook.entries.length : 0;

  $('#notebook-count').textContent = String(count);
  $('#tab-current-count').textContent = String(count);

  if (state.notebook) {
    $('#notebook-btn').disabled = false;
  }

  if (!$('#notebook-drawer').hidden && state.drawerTab === 'current') {
    renderCurrentNotebook();
  }
}

async function loadNotebooks() {
  try {
    const data = await getJson('/api/notebooks');
    state.notebooks = Array.isArray(data.notebooks) ? data.notebooks : [];
    state.due = Array.isArray(data.due) ? data.due : [];
    state.today = data.today || state.today;

    $('#tab-all-count').textContent = String(state.notebooks.length);
    renderDueBanner();

    if (!$('#notebook-drawer').hidden && state.drawerTab === 'all') {
      renderAllList();
    }
  } catch {
    // Keep the reading UI usable even if the local store cannot be read.
  }
}

async function refreshCurrentNotebook() {
  if (!state.notebook) return;
  const data = await getJson(`/api/notebooks/${state.notebook.id}`);
  setNotebook(data.notebook);
}

function renderDueBanner() {
  const banner = $('#due-banner');

  if (!state.due.length) {
    banner.hidden = true;
    return;
  }

  const overdue = state.due.some((item) => item.reviewDate < state.today);
  $('#due-title').textContent = overdue
    ? `${state.due.length} 个生词本待复习`
    : `今天有 ${state.due.length} 个生词本要复习`;
  $('#due-text').textContent = state.due
    .slice(0, 3)
    .map((item) => item.title)
    .join(' · ');
  banner.hidden = false;
}

function renderCurrentNotebook() {
  const empty = $('#notebook-empty');
  const body = $('#notebook-body');
  const notebook = state.notebook;

  if (!notebook) {
    empty.hidden = false;
    body.hidden = true;
    $('#tab-current-count').textContent = '0';
    return;
  }

  empty.hidden = true;
  body.hidden = false;

  $('#notebook-title').value = notebook.title;
  $('#notebook-meta').textContent = `创建于 ${formatDateTime(notebook.createdAt)} · ${notebook.entries.length} 个词`;
  $('#review-date').value = notebook.reviewDate || '';
  $('#review-hint').textContent = reviewHint(notebook.reviewDate);
  $('#export-md').href = `/api/notebooks/${notebook.id}/export.md`;
  $('#export-ics').href = `/api/notebooks/${notebook.id}/export.ics`;

  renderEntries();
}

function renderEntries() {
  const list = $('#entry-list');
  list.replaceChildren();

  if (!state.notebook || !state.notebook.entries.length) {
    const empty = document.createElement('li');
    empty.className = 'entry-empty';
    empty.textContent = '这一篇还没有词。回文章里点几个。';
    list.appendChild(empty);
    return;
  }

  for (const entry of state.notebook.entries) {
    const item = document.createElement('li');
    item.className = 'entry';

    const head = document.createElement('div');
    head.className = 'entry-head';

    const term = document.createElement('span');
    term.className = 'entry-term';
    term.textContent = entry.term;
    head.appendChild(term);

    if (entry.lemma && entry.lemma.toLowerCase() !== entry.term.toLowerCase()) {
      const lemma = document.createElement('span');
      lemma.className = 'entry-lemma';
      lemma.textContent = `原形 ${entry.lemma}`;
      head.appendChild(lemma);
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'entry-remove';
    remove.dataset.remove = entry.id;
    remove.textContent = '移除';
    head.appendChild(remove);

    const sense = document.createElement('p');
    sense.className = 'entry-sense';
    if (entry.contextual?.pos) {
      const pos = document.createElement('span');
      pos.className = 'pos';
      pos.textContent = entry.contextual.pos;
      sense.appendChild(pos);
    }
    sense.appendChild(document.createTextNode(entry.contextual?.meaning || '—'));

    const sentence = document.createElement('p');
    sentence.className = 'entry-sentence';
    sentence.textContent = entry.sentence || '';
    sentence.hidden = !entry.sentence;

    item.append(head, sense, sentence);
    list.appendChild(item);
  }
}

function renderAllList() {
  const container = $('#all-list');
  container.replaceChildren();

  if (!state.notebooks.length) {
    const empty = document.createElement('p');
    empty.className = 'drawer-empty';
    empty.textContent = '还没有生词本。翻译一页并在文章里点几个词就会生成。';
    container.appendChild(empty);
    return;
  }

  for (const summary of state.notebooks) {
    const details = document.createElement('details');
    details.className = 'nb-item';
    details.dataset.id = summary.id;

    const header = document.createElement('summary');

    const title = document.createElement('span');
    title.className = 'nb-title';
    title.textContent = summary.title;

    const meta = document.createElement('span');
    meta.className = 'nb-meta';
    meta.textContent = summary.reviewDate
      ? `${formatDateCn(summary.reviewDate)} · ${summary.entryCount} 词`
      : `${summary.entryCount} 词`;

    header.append(title, meta);

    if (
      summary.reviewDate &&
      summary.reviewDate <= state.today &&
      summary.entryCount > 0
    ) {
      const badge = document.createElement('span');
      badge.className = 'due-badge';
      badge.textContent = '到期';
      header.appendChild(badge);
    }

    const panel = document.createElement('div');
    panel.className = 'nb-entries';
    panel.textContent = '加载中…';

    details.append(header, panel);

    details.addEventListener('toggle', async () => {
      if (!details.open || details.dataset.loaded === '1') return;
      details.dataset.loaded = '1';

      try {
        const data = await getJson(`/api/notebooks/${summary.id}`);
        const notebook = data.notebook;
        panel.replaceChildren();

        if (!notebook.entries.length) {
          const empty = document.createElement('p');
          empty.className = 'nb-empty';
          empty.textContent = '这篇还没有词。';
          panel.appendChild(empty);
          return;
        }

        for (const entry of notebook.entries) {
          const row = document.createElement('div');
          row.className = 'nb-entry';

          const term = document.createElement('strong');
          term.textContent = entry.term;

          const meaning = document.createElement('span');
          meaning.textContent = entry.contextual?.meaning || '';

          row.append(term, meaning);
          panel.appendChild(row);
        }
      } catch (error) {
        panel.textContent = error.message;
      }
    });

    container.appendChild(details);
  }
}

function openDrawer(tab = 'current') {
  closeCard();
  state.drawerTab = tab;
  $('#notebook-drawer').hidden = false;
  $('#drawer-backdrop').hidden = false;
  document.body.classList.add('drawer-open');

  if (state.notebook) {
    refreshCurrentNotebook().catch(() => {
      // Keep the last known entries if the local service blips.
    });
  }

  switchDrawerTab(tab);
  $('#drawer-close').focus({ preventScroll: true });
}

function closeDrawer() {
  $('#notebook-drawer').hidden = true;
  $('#drawer-backdrop').hidden = true;
  document.body.classList.remove('drawer-open');
}

function switchDrawerTab(tab) {
  state.drawerTab = tab;

  const current = tab === 'current';
  $('#tab-current').classList.toggle('is-active', current);
  $('#tab-all').classList.toggle('is-active', !current);
  $('#tab-current').setAttribute('aria-selected', String(current));
  $('#tab-all').setAttribute('aria-selected', String(!current));

  $('#panel-current').hidden = !current;
  $('#panel-all').hidden = current;

  if (current) renderCurrentNotebook();
  else renderAllList();
}

async function patchNotebook(patch) {
  if (!state.notebook) throw new Error('还没有生词本。');
  return getJson(`/api/notebooks/${state.notebook.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/* ------------------------------------------------------------------ lookup */

function closeCard() {
  const card = $('#word-card');
  card.hidden = true;
  card.classList.remove('sheet');

  if (state.activeSpan) {
    state.activeSpan.classList.remove('active');
    state.activeSpan = null;
  }

  state.lookupToken += 1;
}

function placeCard(rect) {
  const card = $('#word-card');
  card.hidden = false;

  if (window.innerWidth < 720) {
    card.classList.add('sheet');
    card.style.left = '';
    card.style.top = '';
    return;
  }

  card.classList.remove('sheet');
  card.style.left = '0px';
  card.style.top = '0px';

  const margin = 12;
  const gap = 10;
  const width = card.offsetWidth;
  const height = card.offsetHeight;

  const left = Math.min(
    Math.max(margin, rect.left + rect.width / 2 - width / 2),
    window.innerWidth - width - margin,
  );

  let top = rect.bottom + gap;
  if (top + height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - height - gap);
  }

  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(top)}px`;
}

function showCardLoading(term, sentence, rect) {
  $('#card-word').textContent = term;
  $('#card-lemma').textContent = '';
  $('#card-sentence').textContent = sentence;
  $('#card-demo').hidden = true;
  $('#card-notebook').hidden = true;

  const contextual = $('#card-contextual');
  contextual.textContent = '正在查这个词…';
  contextual.classList.add('loading');

  $('#card-common').replaceChildren();
  placeCard(rect);
}

function renderCard(data, term, sentence, rect) {
  $('#card-word').textContent = data.word || term;

  const lemma = String(data.lemma || '');
  const differs = lemma && lemma.toLowerCase() !== (data.word || term).toLowerCase();
  $('#card-lemma').textContent = differs ? `原形 ${lemma}` : '';
  $('#card-sentence').textContent = sentence;

  const contextual = $('#card-contextual');
  contextual.replaceChildren();
  contextual.classList.remove('loading');

  const contextualData = data.contextual || {};
  if (contextualData.pos) {
    const pos = document.createElement('span');
    pos.className = 'pos';
    pos.textContent = contextualData.pos;
    contextual.appendChild(pos);
  }
  contextual.appendChild(document.createTextNode(contextualData.meaning || '—'));

  const list = $('#card-common');
  list.replaceChildren();
  const senses = Array.isArray(data.common) && data.common.length
    ? data.common
    : [{ pos: '', meaning: '—' }];

  for (const sense of senses) {
    const item = document.createElement('li');
    if (sense.pos) {
      const pos = document.createElement('span');
      pos.className = 'pos';
      pos.textContent = sense.pos;
      item.appendChild(pos);
    }
    item.appendChild(document.createTextNode(sense.meaning || '—'));
    list.appendChild(item);
  }

  $('#card-demo').hidden = !data.demo;
  placeCard(rect);
}

function renderCardError(message, rect) {
  const contextual = $('#card-contextual');
  contextual.classList.remove('loading');
  contextual.textContent = message;
  $('#card-common').replaceChildren();
  $('#card-notebook').hidden = true;
  placeCard(rect);
}

async function lookup(term, paragraphElement, start, end, rect) {
  if (!paragraphElement) return;

  const plain = paragraphElement.dataset.plain || '';
  const sentence = sentenceAround(plain, start, end) || plain;
  const token = ++state.lookupToken;

  showCardLoading(term, sentence, rect);

  try {
    const data = await getJson('/api/word', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        word: term,
        sentence,
        paragraph: plain,
        context: contextValue(),
        notebookId: state.notebook?.id,
      }),
    });

    if (token !== state.lookupToken) return;
    renderCard(data, term, sentence, rect);

    const note = $('#card-notebook');
    if (data.notebookEntry) {
      note.hidden = false;
      note.textContent = data.notebookEntry.added ? '已加入生词本' : '已在生词本中';
      if (data.notebookEntry.added) {
        toast(`已加入生词本 · ${term}`);
      }
    }

    if (state.notebook) {
      await refreshCurrentNotebook();
      await loadNotebooks();
    }
  } catch (error) {
    if (token !== state.lookupToken) return;
    renderCardError(error.message, rect);
  }
}

/* ----------------------------------------------------------------- ebooks */

const EBOOK_STATUS = {
  empty: '空书',
  processing: '翻译中',
  done: '已完成',
  error: '有错误',
};

function ebookStatusText(status) {
  return EBOOK_STATUS[status] || '未知';
}

function ebookProgressText(book) {
  if (!book.pageCount) return '还没有书页';
  const parts = [`${book.doneCount}/${book.pageCount} 页已翻译`];
  if (book.pendingCount) parts.push(`${book.pendingCount} 页处理中`);
  if (book.errorCount) parts.push(`${book.errorCount} 页失败`);
  return parts.join(' · ');
}

function stopEbookPoll() {
  if (state.ebookPollTimer) {
    window.clearTimeout(state.ebookPollTimer);
    state.ebookPollTimer = null;
  }
}

function setNativeReaderMode(enabled) {
  try {
    window.AndroidShell?.setReaderMode?.(Boolean(enabled));
  } catch {
    // The web build has no native shell; CSS already fills the viewport.
  }
}

function scheduleEbookPoll() {
  stopEbookPoll();
  if ($('#ebooks').hidden) return;

  const inReader = !$('#ebook-reader').hidden;
  const pending =
    inReader &&
    Array.isArray(state.ebook?.pages) &&
    state.ebook.pages.some(
      (page) => page.status === 'pending' || page.status === 'processing',
    );
  const processingList =
    !inReader && state.ebooks.some((book) => book.status === 'processing');

  if (!pending && !processingList) return;

  state.ebookPollTimer = window.setTimeout(async () => {
    if (state.ebookTurning) {
      scheduleEbookPoll();
      return;
    }

    try {
      if (inReader && state.ebook) {
        const data = await getJson(`/api/ebooks/${state.ebook.id}`);
        state.ebook = data.book;
        if (!$('#ebook-reader').hidden) {
          rebuildEbookPageViews({ preserveProgress: true });
          renderEbookReader();
        }
      } else if (!$('#ebooks').hidden) {
        const data = await getJson('/api/ebooks');
        state.ebooks = Array.isArray(data.books) ? data.books : [];
        renderEbookLibrary();
      }
    } catch {
      // Keep the last known state; the next poll can recover.
    }
    scheduleEbookPoll();
  }, 1800);
}

async function loadEbooks({ quiet = false } = {}) {
  try {
    const data = await getJson('/api/ebooks');
    state.ebooks = Array.isArray(data.books) ? data.books : [];
    renderEbookLibrary();
    scheduleEbookPoll();
  } catch (error) {
    if (!quiet) toast(error.message);
  }
}

function createEbookCard(book) {
  const card = document.createElement('article');
  card.className = 'ebook-card';
  card.dataset.ebookOpen = book.id;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `打开电子书 ${book.title}`);

  const cover = document.createElement('div');
  cover.className = 'ebook-cover';

  const coverUrl = book.hasCover
    ? `/api/ebooks/${encodeURIComponent(book.id)}/cover?v=${encodeURIComponent(
        book.updatedAt || '',
      )}`
    : book.coverPageId
      ? `/api/ebooks/${encodeURIComponent(book.id)}/pages/${encodeURIComponent(
          book.coverPageId,
        )}/image`
      : '';

  if (coverUrl) {
    const image = document.createElement('img');
    image.loading = 'lazy';
    image.alt = `${book.title || '电子书'} 封面`;
    image.src = coverUrl;
    image.addEventListener('error', () => {
      image.remove();
      cover.prepend(createEbookFallback(book));
    });
    cover.append(image);
  } else {
    cover.append(createEbookFallback(book));
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'ebook-card-delete';
  remove.dataset.ebookDelete = book.id;
  remove.setAttribute('aria-label', `删除 ${book.title}`);
  remove.textContent = '×';
  cover.append(remove);

  const body = document.createElement('div');
  body.className = 'ebook-card-body';

  const title = document.createElement('h3');
  title.textContent = book.title || '未命名电子书';

  const author = document.createElement('p');
  author.className = 'ebook-card-author';
  author.textContent = book.author || '未署名';

  const meta = document.createElement('div');
  meta.className = 'ebook-card-meta';

  const pages = document.createElement('span');
  pages.textContent = `${book.pageCount} 页 · ${book.doneCount}/${book.pageCount}`;

  const status = document.createElement('span');
  status.className = `ebook-status is-${book.status || 'empty'}`;
  status.textContent = ebookStatusText(book.status);

  meta.append(pages, status);

  const progress = document.createElement('div');
  progress.className = 'ebook-progress-bar';
  const fill = document.createElement('span');
  fill.style.width = `${Math.max(0, Math.min(100, Number(book.progress) || 0))}%`;
  progress.append(fill);

  const actions = document.createElement('div');
  actions.className = 'ebook-card-actions';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'ebook-card-add';
  add.dataset.ebookAdd = book.id;
  add.textContent = '＋ 书页';
  add.setAttribute('aria-label', `给 ${book.title} 添加书页`);
  actions.append(add);

  body.append(title, author, meta, progress, actions);
  card.append(cover, body);

  card.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target.closest('[data-ebook-delete]')) return;
    if (event.target.closest('[data-ebook-add]')) return;
    event.preventDefault();
    openEbook(book.id);
  });

  return card;
}

function createEbookFallback(book) {
  const fallback = document.createElement('div');
  fallback.className = 'ebook-cover-fallback';
  const initial = document.createElement('span');
  initial.textContent = (book.title || '书').trim().slice(0, 1) || '书';
  const title = document.createElement('strong');
  title.textContent = book.title || '未命名电子书';
  fallback.append(initial, title);
  return fallback;
}

function renderEbookLibrary() {
  const grid = $('#ebooks-grid');
  grid.replaceChildren();

  const books = state.ebooks;
  const totalPages = books.reduce((sum, book) => sum + (Number(book.pageCount) || 0), 0);
  const processing = books.filter((book) => book.status === 'processing').length;

  $('#ebooks-empty').hidden = books.length > 0;
  $('#ebooks-summary').textContent = books.length
    ? `共 ${books.length} 本 · ${totalPages} 页${processing ? ` · ${processing} 本翻译中` : ''}`
    : '';

  for (const book of books) grid.append(createEbookCard(book));
}

async function openEbooks() {
  closeCard();
  closeDrawer();
  $('#ebooks').hidden = false;
  await showEbookLibrary();
}

function closeEbooks() {
  stopEbookPoll();
  setNativeReaderMode(false);
  document.body.classList.remove('ebook-reading');
  $('#ebooks').hidden = true;
  $('#ebooks').classList.remove('is-reading');
  $('#ebook-modal').hidden = true;
  $('#ebook-import').hidden = true;
  state.ebook = null;
  state.ebookShowTranslation = false;
  state.ebookPart = 0;
  state.ebookPageViews = [];
  state.ebookViewsPage = -1;
}

async function showEbookLibrary() {
  stopEbookPoll();
  setNativeReaderMode(false);
  document.body.classList.remove('ebook-reading');
  state.ebook = null;
  state.ebookShowTranslation = false;
  state.ebookPart = 0;
  state.ebookPageViews = [];
  state.ebookViewsPage = -1;
  $('#ebooks').classList.remove('is-reading');
  $('#ebook-reader').hidden = true;
  $('#ebooks-library').hidden = false;
  $('#ebooks-title').textContent = '我的书架';
  renderEbookLibrary();
  await loadEbooks();
}

async function openEbook(bookId, pageIndex = null) {
  try {
    const data = await getJson(`/api/ebooks/${bookId}`);
    state.ebook = data.book;
    const pages = state.ebook.pages || [];
    const requested = pageIndex ?? state.ebook.lastPage ?? 0;
    state.ebookPage = Math.min(Math.max(Number(requested) || 0, 0), Math.max(pages.length - 1, 0));
    state.ebookShowTranslation = false;
    state.ebookPart = 0;
    state.ebookPageViews = [];
    state.ebookViewsPage = -1;

    $('#ebooks-library').hidden = true;
    $('#ebook-reader').hidden = false;
    $('#ebooks').classList.add('is-reading');
    document.body.classList.add('ebook-reading');
    setNativeReaderMode(true);

    state.ebookPageViews = buildEbookPageViews(pages[state.ebookPage]);
    state.ebookPart = Math.min(
      Math.max(Number(state.ebook.lastPart) || 0, 0),
      Math.max(state.ebookPageViews.length - 1, 0),
    );
    state.ebookViewsPage = state.ebookPage;
    state.ebookViewsTranslated = false;

    renderEbookReader();
    scheduleEbookPoll();
  } catch (error) {
    toast(error.message);
  }
}

function ebookPageParagraphs(page) {
  if (Array.isArray(page?.paragraphs) && page.paragraphs.length) {
    return page.paragraphs
      .map((item) => ({
        source: String(item.source || '').trim(),
        translation: String(item.translation || '').trim(),
      }))
      .filter((item) => item.source || item.translation);
  }

  return String(page?.sourceText || '')
    .split(/\n{2,}/)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((source) => ({ source, translation: '' }));
}

function appendEbookParagraph(container, text, className = '') {
  const paragraph = document.createElement('p');
  if (className) paragraph.className = className;
  paragraph.textContent = text;
  container.append(paragraph);
}

function ebookPageText(page) {
  const paragraphs = ebookPageParagraphs(page);
  const key = state.ebookShowTranslation ? 'translation' : 'source';
  return paragraphs
    .map((paragraph) => paragraph[key])
    .filter(Boolean)
    .join('\n\n');
}

function getEbookReadingBox() {
  const read = $('#ebook-read-text');
  if (!read) return { width: 600, height: 600 };
  const style = window.getComputedStyle(read);
  const width = Math.max(
    120,
    read.clientWidth -
      (Number.parseFloat(style.paddingLeft) || 0) -
      (Number.parseFloat(style.paddingRight) || 0),
  );
  const height = Math.max(
    160,
    read.clientHeight -
      (Number.parseFloat(style.paddingTop) || 0) -
      (Number.parseFloat(style.paddingBottom) || 0),
  );
  return { width, height };
}

function getEbookMeasure() {
  let measure = document.getElementById('ebook-measure');
  if (!measure) {
    measure = document.createElement('div');
    measure.id = 'ebook-measure';
    measure.className = 'ebook-measure';
    measure.setAttribute('aria-hidden', 'true');
    document.body.append(measure);
  }
  return measure;
}

function measureEbookHeight(text, fontSize, width) {
  const measure = getEbookMeasure();
  measure.style.width = `${width}px`;
  measure.style.fontSize = `${fontSize}px`;
  measure.replaceChildren();

  for (const paragraph of String(text).split(/\n{2,}/)) {
    if (!paragraph.trim()) continue;
    const item = document.createElement('p');
    item.textContent = paragraph;
    measure.append(item);
  }

  return measure.scrollHeight;
}

function chooseEbookFontSize(text, width, height) {
  const min = 17;
  const max = Math.min(54, Math.max(26, Math.round(height / 12)));
  if (!text) return max;

  if (measureEbookHeight(text, max, width) <= height) return max;
  if (measureEbookHeight(text, min, width) > height) return min;

  let low = min;
  let high = max;
  let best = min;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (measureEbookHeight(text, middle, width) <= height) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return best;
}

function paginateEbookText(text, fontSize, width, height) {
  const pages = [];
  let offset = 0;

  while (offset < text.length) {
    let low = offset + 1;
    let high = text.length;
    let best = 0;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (measureEbookHeight(text.slice(offset, middle), fontSize, width) <= height) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    if (best <= offset) best = Math.min(text.length, offset + 1);

    let end = best;
    const slice = text.slice(offset, end);

    const paragraphBreak = slice.lastIndexOf('\n\n');
    if (paragraphBreak > slice.length * 0.6) {
      end = offset + paragraphBreak;
    } else {
      const whitespace = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\n'));
      if (whitespace > slice.length * 0.6) {
        end = offset + whitespace;
      } else {
        let punctuation = -1;
        for (const mark of '。！？；，.!?;') {
          punctuation = Math.max(punctuation, slice.lastIndexOf(mark));
        }
        if (punctuation > slice.length * 0.6) end = offset + punctuation + 1;
      }
    }

    if (end <= offset) end = best;

    const chunk = text.slice(offset, end).trim();
    if (chunk) pages.push({ text: chunk, start: offset, end });

    offset = end;
    while (offset < text.length && /\s/.test(text[offset])) offset += 1;
  }

  return pages;
}

function looksLikeChapterStart(text) {
  const head = String(text || '').trimStart().slice(0, 80);
  return (
    /^(chapter|part|book|section|prologue|epilogue|contents|table of contents)\b/i.test(head) ||
    /^第[一二三四五六七八九十百千万0-9]+[章节篇部]/.test(head)
  );
}

function buildEbookPageViews(page) {
  if (!page) return [];

  const text = ebookPageText(page);
  if (!text.trim()) {
    return [{ text: '', start: 0, end: 0, pageLength: 0, fontSize: 24, empty: true }];
  }

  const { width, height } = getEbookReadingBox();
  let fontSize = chooseEbookFontSize(text, width, height);
  let chunks = paginateEbookText(text, fontSize, width, height);

  // A normal book page should not leave one word on a second screen. If the
  // page is short enough, step the type down until the whole page fits once.
  if (chunks.length > 1 && text.length <= 1400) {
    for (let size = fontSize; size >= 16; size -= 1) {
      if (measureEbookHeight(text, size, width) <= height) {
        fontSize = size;
        chunks = [{ text: text.trim(), start: 0, end: text.length }];
        break;
      }
    }
  }

  // Avoid leaving a single orphaned word on its own page: step the type down
  // a little and use the first size whose final chunk is substantial.
  if (chunks.length > 1) {
    const minimumTail = Math.max(16, Math.floor(text.length * 0.04));
    const tail = chunks[chunks.length - 1].text.length;
    if (tail < minimumTail) {
      const floor = Math.max(17, fontSize - 8);
      for (let size = fontSize - 1; size >= floor; size -= 1) {
        const candidate = paginateEbookText(text, size, width, height);
        const candidateTail = candidate[candidate.length - 1]?.text.length || 0;
        if (candidate.length < chunks.length || candidateTail >= minimumTail) {
          fontSize = size;
          chunks = candidate;
          break;
        }
      }
    }
  }

  const safeChunks = chunks.length
    ? chunks
    : [{ text: text.trim(), start: 0, end: text.length }];

  return safeChunks.map((chunk) => ({
    ...chunk,
    pageLength: text.length,
    fontSize,
  }));
}

function findEbookPartForProgress(views, progress) {
  if (!views.length) return 0;
  const pageLength = views[0].pageLength || 0;
  const target = Math.max(0, Math.min(1, progress)) * pageLength;
  const index = views.findIndex((view) => view.end >= target);
  return index < 0 ? views.length - 1 : index;
}

function rebuildEbookPageViews({ preserveProgress = true } = {}) {
  if (!state.ebook) {
    state.ebookPageViews = [];
    state.ebookViewsPage = -1;
    return;
  }

  const pages = state.ebook.pages || [];
  state.ebookPage = Math.min(Math.max(state.ebookPage, 0), Math.max(pages.length - 1, 0));
  const page = pages[state.ebookPage];
  const previous = state.ebookPageViews[state.ebookPart];
  const progress =
    preserveProgress && previous?.pageLength
      ? previous.start / previous.pageLength
      : 0;

  state.ebookPageViews = buildEbookPageViews(page);
  state.ebookPart = preserveProgress
    ? findEbookPartForProgress(state.ebookPageViews, progress)
    : 0;
  state.ebookPart = Math.min(
    Math.max(state.ebookPart, 0),
    Math.max(state.ebookPageViews.length - 1, 0),
  );
  state.ebookViewsPage = state.ebookPage;
  state.ebookViewsTranslated = state.ebookShowTranslation;
}

function renderEbookReader() {
  const book = state.ebook;
  if (!book) return;

  const pages = Array.isArray(book.pages) ? book.pages : [];
  state.ebookPage = Math.min(Math.max(state.ebookPage, 0), Math.max(pages.length - 1, 0));

  if (
    state.ebookViewsPage !== state.ebookPage ||
    state.ebookViewsTranslated !== state.ebookShowTranslation
  ) {
    rebuildEbookPageViews({ preserveProgress: true });
  }

  const page = pages[state.ebookPage] || null;
  const container = $('#ebook-read-text');
  const toggle = $('#ebook-lang-toggle');
  const surface = $('#ebook-read-surface');

  container.replaceChildren();
  container.style.fontSize = '';
  toggle.textContent = state.ebookShowTranslation ? 'English' : '中文';
  toggle.setAttribute(
    'aria-label',
    state.ebookShowTranslation ? '显示英文原文' : '显示中文翻译',
  );
  toggle.setAttribute('aria-pressed', String(state.ebookShowTranslation));

  if (!page) {
    container.style.fontSize = '24px';
    appendEbookParagraph(container, '还没有书页。', 'ebook-read-status');
    appendEbookParagraph(container, '先回到书架，给这本书添加书页。', 'ebook-read-status');
    return;
  }

  if (page.status === 'error') {
    container.style.fontSize = '22px';
    appendEbookParagraph(
      container,
      state.ebookShowTranslation ? '这一页翻译失败。' : '这一页处理失败。',
      'ebook-read-status',
    );
    if (page.error) {
      appendEbookParagraph(container, page.error, 'ebook-read-error');
    }
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'ebook-inline-retry';
    retry.dataset.ebookRetry = page.id;
    retry.textContent = '重试这一页';
    container.append(retry);
    return;
  }

  const view = state.ebookPageViews[state.ebookPart];

  if (!view || !view.text) {
    container.style.fontSize = '22px';
    const statusText =
      page.status === 'pending'
        ? '这一页已排队，前面处理完就开始。'
        : page.status === 'processing'
          ? '正在识别并翻译这一页…'
          : state.ebookShowTranslation
            ? '这一页还没有译文。'
            : '这一页没有识别出英文。';
    appendEbookParagraph(container, statusText, 'ebook-read-status');
    return;
  }

  container.style.fontSize = `${view.fontSize}px`;
  for (const paragraph of view.text.split(/\n{2,}/)) {
    const text = paragraph.trim();
    if (text) appendEbookParagraph(container, text);
  }

  if (surface) surface.scrollTop = 0;
}

function ebookTarget(direction) {
  if (!state.ebook) return null;
  const pages = state.ebook.pages || [];
  if (!pages.length) return null;

  if (direction > 0) {
    if (state.ebookPart + 1 < state.ebookPageViews.length) {
      return {
        page: state.ebookPage,
        part: state.ebookPart + 1,
        views: state.ebookPageViews,
      };
    }
    if (state.ebookPage + 1 < pages.length) {
      const views = buildEbookPageViews(pages[state.ebookPage + 1]);
      return { page: state.ebookPage + 1, part: 0, views };
    }
    return null;
  }

  if (state.ebookPart > 0) {
    return {
      page: state.ebookPage,
      part: state.ebookPart - 1,
      views: state.ebookPageViews,
    };
  }
  if (state.ebookPage > 0) {
    const views = buildEbookPageViews(pages[state.ebookPage - 1]);
    return {
      page: state.ebookPage - 1,
      part: Math.max(views.length - 1, 0),
      views,
    };
  }
  return null;
}

function saveEbookPosition() {
  if (!state.ebook) return;
  fetch(`/api/ebooks/${encodeURIComponent(state.ebook.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lastPage: state.ebookPage,
      lastPart: state.ebookPart,
    }),
  }).catch(() => {
    // Reading progress is a convenience; a failed save should not interrupt.
  });
}

async function turnEbookView(direction) {
  if (state.ebookTurning || !state.ebook) return;
  const target = ebookTarget(direction);
  if (!target) return;

  state.ebookTurning = true;
  const text = $('#ebook-read-text');
  const outClass = direction > 0 ? 'is-out-next' : 'is-out-prev';
  const inClass = direction > 0 ? 'is-in-next' : 'is-in-prev';

  text.classList.remove('is-out-next', 'is-out-prev', 'is-in-next', 'is-in-prev');
  void text.offsetWidth;
  text.classList.add(outClass);

  await new Promise((resolve) => window.setTimeout(resolve, 150));

  state.ebookPage = target.page;
  state.ebookPart = target.part;
  state.ebookPageViews = target.views;
  state.ebookViewsPage = target.page;
  state.ebookViewsTranslated = state.ebookShowTranslation;
  renderEbookReader();

  text.classList.remove(outClass);
  void text.offsetWidth;
  text.classList.add(inClass);

  await new Promise((resolve) => window.setTimeout(resolve, 220));
  text.classList.remove(inClass);
  state.ebookTurning = false;
  saveEbookPosition();
}

function splitEbookViewsAtTarget(views, target) {
  if (!views.length) return { views, index: 0 };

  const index = views.findIndex((view) => view.end >= target);
  if (index < 0) return { views, index: views.length - 1 };

  const view = views[index];
  const relative = Math.max(0, Math.min(view.text.length, target - view.start));
  if (relative < 12 || relative > view.text.length - 12) {
    return { views, index };
  }

  let split = view.text.indexOf('\n\n', relative);
  if (split < 0) split = view.text.lastIndexOf('\n\n', relative);
  if (split < 0) split = view.text.indexOf(' ', relative);
  if (split < 0) split = view.text.lastIndexOf(' ', relative);
  if (split <= 0 || split >= view.text.length - 2) {
    return { views, index };
  }

  const firstText = view.text.slice(0, split).trimEnd();
  const secondText = view.text.slice(split).trimStart();
  if (!firstText || !secondText) return { views, index };

  const first = {
    ...view,
    text: firstText,
    end: view.start + firstText.length,
  };

  // Re-flow everything from the split point onward at this type size, so the
  // page the reader lands on is full instead of being the short tail of the
  // old layout.
  const tailText = views
    .slice(index + 1)
    .map((item) => item.text)
    .join('\n\n');
  const restText = [secondText, tailText].filter(Boolean).join('\n\n');
  const { width, height } = getEbookReadingBox();
  const restChunks = paginateEbookText(
    restText,
    view.fontSize || 24,
    width,
    height,
  );
  const restViews = restChunks.map((chunk) => ({
    ...view,
    text: chunk.text,
    start: view.start + split + chunk.start,
    end: view.start + split + chunk.end,
    pageLength: view.pageLength,
  }));

  const next = [...views.slice(0, index), first, ...restViews];
  return { views: next, index: index + 1 };
}

function toggleEbookLanguage() {
  if (!state.ebook || state.ebookTurning) return;

  const previous = state.ebookPageViews[state.ebookPart];
  const progress = previous?.pageLength ? previous.start / previous.pageLength : 0;

  state.ebookShowTranslation = !state.ebookShowTranslation;
  const page = state.ebook.pages?.[state.ebookPage];
  const views = buildEbookPageViews(page);
  const pageLength = views[0]?.pageLength || 0;
  const split = splitEbookViewsAtTarget(views, progress * pageLength);
  state.ebookPageViews = split.views;
  state.ebookPart = split.index;
  state.ebookViewsPage = state.ebookPage;
  state.ebookViewsTranslated = state.ebookShowTranslation;

  renderEbookReader();
  saveEbookPosition();
}
function openEbookModal() {
  $('#ebook-form').reset();
  $('#ebook-context-input').value = state.bookContext || contextValue();
  updateEbookFileNote();
  $('#ebook-modal').hidden = false;
  window.setTimeout(() => $('#ebook-title-input').focus(), 30);
}

function closeEbookModal() {
  $('#ebook-modal').hidden = true;
}

function updateEbookFileNote() {
  const files = Array.from($('#ebook-file-input').files || []);
  $('#ebook-file-note').textContent = files.length
    ? `${files.length} 张图片 · 将按选择顺序逐页识别和翻译`
    : '未选择图片，也可以先创建空书。';
}

async function createEbookFromForm(event) {
  event.preventDefault();

  const title = $('#ebook-title-input').value.trim();
  if (!title) {
    toast('先给这本电子书起个名字。');
    return;
  }

  const files = Array.from($('#ebook-file-input').files || []);
  const button = $('#ebook-create');
  button.disabled = true;
  button.textContent = '创建中…';

  try {
    const data = await getJson('/api/ebooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        author: $('#ebook-author-input').value.trim(),
        context: $('#ebook-context-input').value.trim(),
      }),
    });

    const book = data.book;
    closeEbookModal();
    state.ebook = book;
    state.ebookPage = 0;
    state.ebookPart = 0;
    state.ebookShowTranslation = false;
    state.ebookPageViews = [];
    state.ebookViewsPage = -1;
    $('#ebooks-library').hidden = true;
    $('#ebook-reader').hidden = false;
    $('#ebooks').classList.add('is-reading');
    document.body.classList.add('ebook-reading');
    setNativeReaderMode(true);
    state.ebookPageViews = buildEbookPageViews(book.pages?.[0]);
    state.ebookViewsPage = 0;
    state.ebookViewsTranslated = false;
    renderEbookReader();

    if (files.length) {
      await importEbookFiles(book.id, files);
    } else {
      toast('已创建空书。回到书架，用卡片上的「＋ 书页」导入图片。');
      await showEbookLibrary();
    }
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = '创建并导入';
  }
}

async function refreshEbookDetail(bookId, { keepPage = false } = {}) {
  const previousPage = state.ebookPage;
  const previousPart = state.ebookPart;
  const data = await getJson(`/api/ebooks/${bookId}`);
  state.ebook = data.book;
  const pages = state.ebook.pages || [];
  state.ebookPage = keepPage
    ? Math.min(Math.max(previousPage, 0), Math.max(pages.length - 1, 0))
    : 0;
  state.ebookPageViews = buildEbookPageViews(pages[state.ebookPage]);
  state.ebookPart = keepPage
    ? Math.min(Math.max(previousPart, 0), Math.max(state.ebookPageViews.length - 1, 0))
    : 0;
  state.ebookViewsPage = state.ebookPage;
  state.ebookViewsTranslated = state.ebookShowTranslation;
  renderEbookReader();
  scheduleEbookPoll();
}

async function importEbookFiles(bookId, files, { keepPage = false } = {}) {
  if (state.ebookImporting) return;
  if (!files.length) return;

  const valid = [];
  for (const file of files) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) continue;
    if (file.size > state.maxUploadMb * 1024 * 1024) continue;
    valid.push(file);
  }

  if (!valid.length) {
    toast(`没有可导入的图片（仅支持 JPG/PNG/WebP，单张不超过 ${state.maxUploadMb} MB）。`);
    return;
  }

  state.ebookImporting = true;
  $('#ebook-import').hidden = false;
  $('#ebook-import-fill').style.width = '0%';
  $('#ebook-import-label').textContent = `正在导入 0 / ${valid.length} 页`;
  $('#ebook-import-detail').textContent = '按选择顺序逐页上传…';

  let failed = 0;
  let lastError = '';

  for (let index = 0; index < valid.length; index += 1) {
    const file = valid[index];
    $('#ebook-import-label').textContent = `正在导入 ${index + 1} / ${valid.length} 页`;
    $('#ebook-import-detail').textContent = file.name || `第 ${index + 1} 页`;

    try {
      let prepared = file;
      try {
        prepared = await shrinkImage(file);
      } catch {
        // Fall back to the original image.
      }

      const form = new FormData();
      form.append('image', prepared, prepared.name || `page-${index + 1}.jpg`);
      await getJson(`/api/ebooks/${bookId}/pages`, { method: 'POST', body: form });
    } catch (error) {
      failed += 1;
      lastError = error.message;
    }

    $('#ebook-import-fill').style.width = `${Math.round(((index + 1) / valid.length) * 100)}%`;
  }

  $('#ebook-import').hidden = true;
  state.ebookImporting = false;

  try {
    await refreshEbookDetail(bookId, { keepPage });
  } catch (error) {
    toast(error.message);
  }

  if (failed) {
    toast(`导入完成：${valid.length - failed} 页成功，${failed} 页失败。${lastError ? ` ${lastError}` : ''}`);
  } else {
    toast(`已导入 ${valid.length} 页，正在逐页翻译。`);
  }
}

async function startAddPages(bookId) {
  try {
    const data = await getJson(`/api/ebooks/${bookId}`);
    state.ebook = data.book;
    const pages = state.ebook.pages || [];
    state.ebookPage = Math.min(
      Math.max(Number(state.ebook.lastPage) || 0, 0),
      Math.max(pages.length - 1, 0),
    );
    state.ebookPart = 0;
    state.ebookShowTranslation = false;
    state.ebookPageViews = [];
    state.ebookViewsPage = -1;

    $('#ebooks-library').hidden = true;
    $('#ebook-reader').hidden = false;
    $('#ebooks').classList.add('is-reading');
    document.body.classList.add('ebook-reading');
    setNativeReaderMode(true);
    state.ebookPageViews = buildEbookPageViews(pages[state.ebookPage]);
    state.ebookPart = Math.min(
      Math.max(Number(state.ebook.lastPart) || 0, 0),
      Math.max(state.ebookPageViews.length - 1, 0),
    );
    state.ebookViewsPage = state.ebookPage;
    state.ebookViewsTranslated = false;
    renderEbookReader();
    $('#ebook-add-input').click();
  } catch (error) {
    toast(error.message);
  }
}

async function addEbookPages(files) {
  if (!state.ebook || !files.length) return;
  await importEbookFiles(state.ebook.id, files, { keepPage: true });
}

async function retryEbookPage() {
  if (!state.ebook) return;
  const page = state.ebook.pages?.[state.ebookPage];
  if (!page) return;

  const button = document.querySelector(`[data-ebook-retry="${page.id}"]`);
  if (button) button.disabled = true;
  try {
    await getJson(`/api/ebooks/${encodeURIComponent(state.ebook.id)}/pages/${encodeURIComponent(
      page.id,
    )}/retry`, { method: 'POST' });
    await refreshEbookDetail(state.ebook.id, { keepPage: true });
    toast('已重新排队，处理完会自动刷新。');
  } catch (error) {
    toast(error.message);
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

async function deleteEbook(bookId) {
  if (!bookId) return;
  if (!window.confirm('删除这本电子书和它的所有书页？此操作不能撤销。')) return;

  try {
    await deleteRequest(`/api/ebooks/${encodeURIComponent(bookId)}`);
    toast('电子书已删除');
    await showEbookLibrary();
  } catch (error) {
    toast(error.message);
  }
}

function bindEbookSwipe() {
  const surface = $('#ebook-read-surface');
  if (!surface) return;

  let start = null;

  function begin(x, y, target) {
    if (!(target instanceof Element) || target.closest('button')) {
      start = null;
      return;
    }
    start = { x, y };
  }

  function finish(x, y) {
    if (!start) return;
    const dx = x - start.x;
    const dy = y - start.y;
    start = null;

    if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    turnEbookView(dx < 0 ? 1 : -1);
  }

  surface.addEventListener(
    'touchstart',
    (event) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      begin(touch.clientX, touch.clientY, event.target);
    },
    { passive: true },
  );

  surface.addEventListener(
    'touchend',
    (event) => {
      const touch = event.changedTouches[0];
      if (touch) finish(touch.clientX, touch.clientY);
    },
    { passive: true },
  );

  surface.addEventListener('touchcancel', () => {
    start = null;
  });

  surface.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse') return;
    begin(event.clientX, event.clientY, event.target);
  });

  surface.addEventListener('pointerup', (event) => {
    if (event.pointerType !== 'mouse') return;
    finish(event.clientX, event.clientY);
  });
}

/* ------------------------------------------------------------------ events */

function bindEvents() {
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');

  fileInput.addEventListener('change', () => {
    handleFile(fileInput.files?.[0]);
  });

  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });

  dropzone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dropzone.classList.add('dragging');
  });

  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('dragging');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragging');
  });

  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragging');
    handleFile(event.dataTransfer?.files?.[0]);
  });

  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());

  document.addEventListener('paste', (event) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;

    const item = Array.from(event.clipboardData?.items || []).find((entry) =>
      entry.type.startsWith('image/'),
    );
    if (!item) return;

    const file = item.getAsFile();
    if (file) {
      event.preventDefault();
      handleFile(file);
    }
  });

  $('#clear-image').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearImage();
  });

  $('#ocr-btn').addEventListener('click', runOcr);
  $('#skip-ocr').addEventListener('click', () => {
    setNotebook(null);
    gotoText('');
  });
  $('#sample-btn').addEventListener('click', loadSample);
  $('#back-upload').addEventListener('click', () => showStep('upload'));
  $('#translate-btn').addEventListener('click', runTranslate);

  $('#source-text').addEventListener('input', updateCount);

  $('#book-context').addEventListener('change', () => {
    storeContext(contextValue());
  });

  window.addEventListener('resize', () => {
    if (!$('#word-card').hidden) closeCard();

    if (!$('#ebooks').hidden && !$('#ebook-reader').hidden) {
      window.clearTimeout(state.ebookResizeTimer);
      state.ebookResizeTimer = window.setTimeout(() => {
        if ($('#ebook-reader').hidden || !state.ebook) return;
        rebuildEbookPageViews({ preserveProgress: true });
        renderEbookReader();
      }, 180);
    }
  });

  $('#edit-text').addEventListener('click', () => {
    closeCard();
    showStep('text');
    updateCount();
  });

  $('#restart').addEventListener('click', restart);
  $('#card-close').addEventListener('click', closeCard);

  $('#notebook-btn').addEventListener('click', () => {
    openDrawer(state.notebook ? 'current' : 'all');
  });
  $('#due-open').addEventListener('click', () => openDrawer('all'));
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-backdrop').addEventListener('click', closeDrawer);

  $('#tab-current').addEventListener('click', () => switchDrawerTab('current'));
  $('#tab-all').addEventListener('click', () => switchDrawerTab('all'));

  $('#notebook-title').addEventListener('change', async () => {
    if (!state.notebook) return;

    const title = $('#notebook-title').value.trim();
    if (!title) {
      $('#notebook-title').value = state.notebook.title;
      return;
    }
    if (title === state.notebook.title) return;

    try {
      const data = await patchNotebook({ title });
      setNotebook(data.notebook);
      await loadNotebooks();
      toast('标题已更新');
    } catch (error) {
      toast(error.message);
      $('#notebook-title').value = state.notebook.title;
    }
  });

  $('#review-date').addEventListener('change', async () => {
    if (!state.notebook) return;

    const value = $('#review-date').value || null;

    try {
      const data = await patchNotebook({ reviewDate: value });
      setNotebook(data.notebook);
      await loadNotebooks();
      toast(value ? `复习日期已设为 ${formatDateCn(value)}` : '已清除复习日期');
    } catch (error) {
      toast(error.message);
      $('#review-date').value = state.notebook.reviewDate || '';
    }
  });

  $('#entry-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-remove]');
    if (!button || !state.notebook) return;

    try {
      await deleteRequest(
        `/api/notebooks/${state.notebook.id}/entries/${button.dataset.remove}`,
      );
      await refreshCurrentNotebook();
      await loadNotebooks();
      toast('已从生词本移除');
    } catch (error) {
      toast(error.message);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (
      !$('#ebooks').hidden &&
      !$('#ebook-reader').hidden &&
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
    ) {
      const tag = event.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      event.preventDefault();
      turnEbookView(event.key === 'ArrowRight' ? 1 : -1);
      return;
    }

    if (event.key !== 'Escape') return;

    if (!$('#ebook-modal').hidden) {
      closeEbookModal();
      return;
    }

    if (!$('#ebooks').hidden) {
      if (state.ebookImporting) return;
      if (!$('#ebook-reader').hidden) {
        showEbookLibrary();
        return;
      }
      closeEbooks();
      return;
    }

    if (!$('#notebook-drawer').hidden) {
      closeDrawer();
      return;
    }
    closeCard();
  });

  document.addEventListener('click', (event) => {
    const card = $('#word-card');
    if (card.hidden) return;
    if (!(event.target instanceof Element)) return;
    if (card.contains(event.target) || event.target.closest('.w')) return;
    closeCard();
  });

  const reading = $('#reading');

  reading.addEventListener('click', (event) => {
    if (Date.now() - state.lastSelectionAt < 250) return;
    if (!(event.target instanceof Element)) return;

    const span = event.target.closest('.w');
    if (!span) return;

    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return;

    const paragraphElement = span.closest('.en');
    const start = Number(span.dataset.start);
    const end = Number(span.dataset.end);
    if (!paragraphElement || !Number.isFinite(start) || !Number.isFinite(end)) return;

    if (state.activeSpan) state.activeSpan.classList.remove('active');
    state.activeSpan = span;
    span.classList.add('active');

    lookup(span.textContent, paragraphElement, start, end, span.getBoundingClientRect());
  });

  reading.addEventListener('mouseup', () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const raw = selection.toString();
    const term = raw.trim().replace(/\s+/g, ' ');
    if (!term || term.length > 80) return;

    const range = selection.getRangeAt(0);
    const startNode = range.startContainer;
    const startElement =
      startNode.nodeType === Node.ELEMENT_NODE ? startNode : startNode.parentElement;
    const english = startElement?.closest('.en');
    if (!english || !reading.contains(english)) return;
    if (!english.contains(range.endContainer)) return;

    const prefix = document.createRange();
    prefix.selectNodeContents(english);
    try {
      prefix.setEnd(range.startContainer, range.startOffset);
    } catch {
      return;
    }

    const start = prefix.toString().length;
    const end = start + raw.length;
    const rect = range.getBoundingClientRect();

    state.lastSelectionAt = Date.now();
    selection.removeAllRanges();

    if (state.activeSpan) state.activeSpan.classList.remove('active');
    state.activeSpan = null;

    lookup(term, english, start, end, rect);
  });

  $('#ebooks-open').addEventListener('click', openEbooks);
  $('#ebooks-close').addEventListener('click', closeEbooks);
  $('#ebooks-close-2').addEventListener('click', closeEbooks);
  $('#ebooks-new').addEventListener('click', openEbookModal);
  $('#ebooks-empty-new').addEventListener('click', openEbookModal);
  $('#ebooks-refresh').addEventListener('click', () => loadEbooks());

  $('#ebook-modal-close').addEventListener('click', closeEbookModal);
  $('#ebook-cancel').addEventListener('click', closeEbookModal);
  $('#ebook-modal').addEventListener('click', (event) => {
    if (event.target === $('#ebook-modal')) closeEbookModal();
  });
  $('#ebook-form').addEventListener('submit', createEbookFromForm);
  $('#ebook-file-input').addEventListener('change', updateEbookFileNote);

  $('#ebook-add-input').addEventListener('change', async () => {
    const input = $('#ebook-add-input');
    const files = Array.from(input.files || []);
    input.value = '';
    await addEbookPages(files);
  });

  $('#ebook-lang-toggle').addEventListener('click', toggleEbookLanguage);

  $('#ebook-read-text').addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('[data-ebook-retry]')) retryEbookPage();
  });

  bindEbookSwipe();

  $('#ebooks-grid').addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;

    const remove = event.target.closest('[data-ebook-delete]');
    if (remove) {
      event.stopPropagation();
      deleteEbook(remove.dataset.ebookDelete);
      return;
    }

    const add = event.target.closest('[data-ebook-add]');
    if (add) {
      event.stopPropagation();
      startAddPages(add.dataset.ebookAdd);
      return;
    }

    const card = event.target.closest('[data-ebook-open]');
    if (card) openEbook(card.dataset.ebookOpen);
  });
}

/* ------------------------------------------------------------------- flow */

async function loadSample() {
  setNotebook(null);
  closeDrawer();
  $('#source-text').value = SAMPLE_TEXT;
  updateCount();
  showStep('text');
  await runTranslate();
}

function restart() {
  state.paragraphs = [];
  state.file = null;

  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;

  $('#preview').removeAttribute('src');
  $('#preview-wrap').hidden = true;
  $('#file-input').value = '';
  $('#ocr-btn').disabled = true;
  $('#dropzone').classList.remove('has-image');
  $('#source-text').value = '';
  $('#reading').replaceChildren();
  updateCount();
  closeCard();
  closeDrawer();
  setNotebook(null);
  showStep('upload');
}

async function init() {
  bindEvents();

  try {
    const config = await getJson('/api/config');

    state.demo = Boolean(config.demo);
    state.maxUploadMb = Number(config.maxUploadMb) || 12;
    state.bookContext = config.bookContext || '';
    state.remindAt = config.remindAt || '07:30';
    state.today = config.today || '';

    $('#book-context').value = readStoredContext() || state.bookContext;

    const pill = $('#mode-pill');
    pill.textContent = state.demo ? '演示模式' : `模型 · ${config.textModel}`;
    pill.classList.toggle('demo', state.demo);
    $('#demo-note').hidden = !state.demo;
  } catch (error) {
    $('#mode-pill').textContent = '服务未连接';
    toast(error.message);
    return;
  }

  await loadNotebooks();

  if (new URLSearchParams(window.location.search).get('sample') === '1') {
    await loadSample();
  }
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // The app still works without the offline shell.
    });
  });
}

window.openEbooks = openEbooks;
window.closeEbooks = closeEbooks;
window.exitEbookReader = () => {
  if ($('#ebooks').hidden || $('#ebook-reader').hidden) return false;
  showEbookLibrary();
  return true;
};

init();
