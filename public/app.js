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
        await refreshCurrentNotebook();
        await loadNotebooks();
      }
    }
  } catch (error) {
    if (token !== state.lookupToken) return;
    renderCardError(error.message, rect);
  }
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
    if (event.key !== 'Escape') return;

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

init();
