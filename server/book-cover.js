const IMAGE_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120 Safari/537.36';

function normalized(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapTitle(title, maxChars) {
  const words = String(title || '未命名电子书').trim().split(/\s+/);
  const lines = [];
  let current = '';

  for (const word of words) {
    if (!current) {
      current = word;
    } else if ((current + ' ' + word).length <= maxChars) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);

  if (lines.length > 4) {
    const kept = lines.slice(0, 4);
    kept[3] = `${kept[3].slice(0, Math.max(1, maxChars - 1))}…`;
    return kept;
  }
  return lines;
}

function generatedCover(title, author) {
  const safeTitle = title || '未命名电子书';
  const lines = wrapTitle(safeTitle, 17);
  const fontSize = lines.length <= 2 ? 64 : lines.length === 3 ? 55 : 48;
  const startY = 350 - (lines.length - 1) * (fontSize * 0.62);
  const titleMarkup = lines
    .map(
      (line, index) =>
        `<text x="400" y="${Math.round(startY + index * fontSize * 1.18)}" ` +
        `text-anchor="middle" fill="#f3e7d0" font-family="Georgia, 'Songti SC', serif" ` +
        `font-size="${fontSize}" font-weight="600">${escapeXml(line)}</text>`,
    )
    .join('');
  const authorLine = author
    ? `<text x="400" y="690" text-anchor="middle" fill="#d8c6aa" ` +
      `font-family="Georgia, 'Songti SC', serif" font-size="28">${escapeXml(author)}</text>`
    : '';

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000" viewBox="0 0 800 1000">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3f3429"/>
      <stop offset="0.55" stop-color="#6d4b36"/>
      <stop offset="1" stop-color="#2a241e"/>
    </linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.14"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="800" height="1000" fill="url(#bg)"/>
  <rect x="0" y="0" width="800" height="1000" fill="url(#glow)"/>
  <rect x="42" y="42" width="716" height="916" fill="none" stroke="#cdb995" stroke-opacity="0.35" stroke-width="2"/>
  <text x="400" y="145" text-anchor="middle" fill="#cdb995" font-family="Georgia, serif" font-size="22" letter-spacing="8">AUTO TRANSFORMATION</text>
  ${titleMarkup}
  <line x1="270" y1="570" x2="530" y2="570" stroke="#cdb995" stroke-opacity="0.55" stroke-width="2"/>
  ${authorLine}
  <text x="400" y="905" text-anchor="middle" fill="#b9a68b" font-family="Georgia, serif" font-size="18" letter-spacing="5">EBOOK EDITION</text>
</svg>`;

  return {
    buffer: Buffer.from(svg, 'utf8'),
    mime: 'image/svg+xml',
    ext: 'svg',
    source: 'generated',
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function downloadImage(url, referer) {
  if (!url || !/^https?:\/\//i.test(url)) return null;

  try {
    const response = await fetchWithTimeout(
      url,
      {
        headers: {
          'User-Agent': UA,
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          ...(referer ? { Referer: referer } : {}),
        },
      },
      7000,
    );
    if (!response.ok) return null;

    const type = String(response.headers.get('content-type') || '').split(';')[0].trim();
    if (!IMAGE_MIME[type] || type === 'image/svg+xml') return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1024 || buffer.length > 12 * 1024 * 1024) return null;

    return { buffer, mime: type, ext: IMAGE_MIME[type], source: 'douban' };
  } catch {
    return null;
  }
}

function titleScore(item, title, author) {
  const wanted = normalized(title);
  const found = normalized(item.title);
  let score = 0;

  if (wanted && found === wanted) score += 8;
  else if (wanted && (found.includes(wanted) || wanted.includes(found))) score += 4;
  else if (wanted && found.split(' ').some((word) => word.length > 2 && wanted.includes(word))) {
    score += 1;
  }

  if (author) {
    const authorWords = normalized(author).split(' ').filter((word) => word.length > 2);
    const itemAuthor = normalized(
      Array.isArray(item.author_name) ? item.author_name.join(' ') : item.author_name,
    );
    if (authorWords.some((word) => itemAuthor.includes(word))) score += 2;
  }

  if (item.pic) score += 1;
  if (item.type === 'b') score += 2;
  return score;
}

async function fromDouban(title, author) {
  const response = await fetchWithTimeout(
    `https://book.douban.com/j/subject_suggest?q=${encodeURIComponent(title)}`,
    {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://book.douban.com/',
      },
    },
    4500,
  );
  if (!response.ok) return null;

  const data = await response.json().catch(() => null);
  if (!Array.isArray(data) || !data.length) return null;

  const candidates = data
    .filter((item) => item && item.pic && (!item.type || item.type === 'b'))
    .map((item) => ({ item, score: titleScore(item, title, author) }))
    .sort((a, b) => b.score - a.score);

  for (const { item } of candidates.slice(0, 2)) {
    const large = String(item.pic)
      .replace('/view/subject/s/', '/view/subject/l/')
      .replace('/view/subject/m/', '/view/subject/l/');
    const image =
      (await downloadImage(large, 'https://book.douban.com/')) ||
      (await downloadImage(item.pic, 'https://book.douban.com/'));
    if (image) return image;
  }

  return null;
}

export async function findBookCover({ title, author = '' } = {}) {
  const cleanTitle = String(title ?? '').trim();
  if (!cleanTitle) return generatedCover('未命名电子书', author);

  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve(null), 7000);
  });

  try {
    const cover = await Promise.race([
      fromDouban(cleanTitle, author).catch(() => null),
      timeout,
    ]);
    if (cover) return cover;
  } catch {
    // Fall through to the generated typographic cover.
  }

  return generatedCover(cleanTitle, author);
}
