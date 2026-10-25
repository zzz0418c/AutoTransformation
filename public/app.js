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
      body: JSON.stringify({ text, context: contextValue() }),
    });

    state.paragraphs = Array.isArray(data.paragraphs) ? data.paragraphs : [];
    if (!state.paragraphs.length) throw new Error('没有返回译文，请重试。');

    renderReading();
    showStep('read');
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
      }),
    });

    if (token !== state.lookupToken) return;
    renderCard(data, term, sentence, rect);
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
  $('#skip-ocr').addEventListener('click', () => gotoText(''));
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

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeCard();
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
  showStep('upload');
}

async function init() {
  bindEvents();

  try {
    const config = await getJson('/api/config');

    state.demo = Boolean(config.demo);
    state.maxUploadMb = Number(config.maxUploadMb) || 12;
    state.bookContext = config.bookContext || '';

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

  if (new URLSearchParams(window.location.search).get('sample') === '1') {
    await loadSample();
  }
}

init();
