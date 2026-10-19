/*
 * background.js — две задачи:
 *  1) исправляет заголовок Content-Type у медиаответов, если сервер прислал
 *     неправильный (application/octet-stream, text/plain, video/quicktime …);
 *  2) по запросу контент-скрипта скачивает первые/последние байты файла и
 *     определяет контейнер и кодеки (probe.js), чтобы объяснить, почему
 *     Firefox не может воспроизвести видео.
 */
'use strict';

const DEFAULTS = {
  fixHeaders: true,     // подставлять правильный Content-Type
  mkvAsWebm: true,      // .mkv отдавать как video/webm (WebM — подмножество Matroska)
  movAsMp4: true,       // .mov отдавать как video/mp4 (тот же контейнер ISO BMFF)
  dropNosniff: true,    // при неизвестном типе снимать nosniff, чтобы Firefox распознал сам
  forceInline: false,   // Content-Disposition: attachment → inline для прямых ссылок на видео
  overlay: true,        // показывать подсказку у невоспроизводимого видео
};
let cfg = { ...DEFAULTS };
browser.storage.local.get(DEFAULTS).then((v) => { cfg = v; });
browser.storage.onChanged.addListener((ch) => {
  for (const [k, { newValue }] of Object.entries(ch)) cfg[k] = newValue;
});

const EXT_MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', mkv: 'video/webm',
  ogv: 'video/ogg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg',
  m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav',
};
// Типы, которые Firefox не принимает за воспроизводимое медиа, хотя файл может быть нормальным.
const BAD_TYPE = /^(|application\/(octet-stream|x-download|force-download|download|binary|unknown|x-unknown)|binary\/octet-stream|text\/plain|video\/quicktime|video\/x-matroska|video\/x-m4v|audio\/x-m4a|audio\/x-matroska|video\/mpeg4|video\/x-mp4)$/i;

function extOf(url, headers) {
  let name = '';
  try {
    const u = new URL(url);
    name = decodeURIComponent(u.pathname.split('/').pop() || '');
    // Часто имя файла спрятано в параметре (?filename=, ?fn=, ?name=).
    if (!/\.\w{2,4}$/.test(name)) {
      for (const k of ['filename', 'fn', 'name', 'file', 'title']) {
        const v = u.searchParams.get(k);
        if (v && /\.\w{2,4}$/.test(v)) { name = v; break; }
      }
    }
  } catch (_) { /* не URL */ }
  if (!/\.\w{2,4}$/.test(name)) {
    const cd = headers.find((h) => h.name.toLowerCase() === 'content-disposition');
    const m = cd && /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(cd.value || '');
    if (m) name = decodeURIComponent(m[1]);
  }
  const m = /\.(\w{2,4})$/.exec(name.toLowerCase());
  return m ? m[1] : '';
}

const fixedPerTab = new Map();
function countFix(tabId) {
  if (tabId < 0) return;
  const n = (fixedPerTab.get(tabId) || 0) + 1;
  fixedPerTab.set(tabId, n);
  browser.browserAction.setBadgeText({ tabId, text: String(n) }).catch(() => {});
}
browser.tabs.onRemoved.addListener((id) => fixedPerTab.delete(id));
browser.tabs.onUpdated.addListener((id, info) => {
  if (info.status === 'loading' && info.url) fixedPerTab.delete(id);
});

browser.webRequest.onHeadersReceived.addListener((d) => {
  if (!cfg.fixHeaders) return {};
  const headers = d.responseHeaders || [];
  const ctIdx = headers.findIndex((h) => h.name.toLowerCase() === 'content-type');
  const ct = ctIdx >= 0 ? (headers[ctIdx].value || '').split(';')[0].trim() : '';
  if (!BAD_TYPE.test(ct)) return {};

  const ext = extOf(d.url, headers);
  if (ext === 'mkv' && !cfg.mkvAsWebm) return {};
  if (ext === 'mov' && !cfg.movAsMp4) return {};
  let target = EXT_MIME[ext];
  // video/quicktime и video/x-matroska без расширения в адресе: тип и так известен.
  if (!target && /quicktime|x-m4v|x-mp4|mpeg4/i.test(ct) && cfg.movAsMp4) target = 'video/mp4';
  if (!target && /matroska/i.test(ct) && cfg.mkvAsWebm) target = 'video/webm';

  // На прямой переход (main_frame) трогаем только то, что точно медиа по расширению,
  // иначе любой скачиваемый .bin стал бы «видео».
  if (d.type === 'main_frame' && !target) return {};

  let changed = false;
  if (target) {
    if (ctIdx >= 0) headers[ctIdx].value = target; else headers.push({ name: 'Content-Type', value: target });
    changed = true;
  } else if (d.type === 'media' && cfg.dropNosniff) {
    // Расширение неизвестно: убираем неверный тип и nosniff — Firefox сам определит
    // формат по содержимому (для <video>/<audio> он это умеет).
    if (ctIdx >= 0) headers.splice(ctIdx, 1);
    changed = true;
  }
  if (!changed) return {};

  if (cfg.dropNosniff) {
    for (let i = headers.length - 1; i >= 0; i--) {
      if (headers[i].name.toLowerCase() === 'x-content-type-options') headers.splice(i, 1);
    }
  }
  if (d.type === 'main_frame' && cfg.forceInline) {
    const cd = headers.find((h) => h.name.toLowerCase() === 'content-disposition');
    if (cd) cd.value = cd.value.replace(/^\s*attachment/i, 'inline');
  }
  countFix(d.tabId);
  return { responseHeaders: headers };
}, { urls: ['<all_urls>'], types: ['media', 'main_frame', 'sub_frame', 'object'] },
['blocking', 'responseHeaders']);

// ── Диагностика файла ────────────────────────────────────────────────────────
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15000;

async function fetchRange(url, range) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Range: range }, credentials: 'include', signal: ctl.signal, cache: 'no-store' });
    const info = {
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      length: Number((res.headers.get('content-range') || '').split('/')[1]) || Number(res.headers.get('content-length')) || 0,
      ranged: res.status === 206,
    };
    // Читаем не больше нужного, даже если сервер проигнорировал Range и шлёт весь файл.
    const want = range.startsWith('bytes=-') ? TAIL_BYTES : HEAD_BYTES;
    const reader = res.body.getReader();
    const chunks = []; let got = 0;
    while (got < want) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
    }
    reader.cancel().catch(() => {});
    const buf = new Uint8Array(got); let o = 0;
    for (const c of chunks) { buf.set(c.subarray(0, Math.min(c.length, got - o)), o); o += c.length; if (o >= got) break; }
    return { info, bytes: buf };
  } finally { clearTimeout(t); }
}

async function probe(url) {
  const { info, bytes } = await fetchRange(url, `bytes=0-${HEAD_BYTES - 1}`);
  const out = { url, http: info.status, contentType: info.contentType, size: info.length, ranged: info.ranged };
  if (info.status >= 400) return { ...out, error: 'http' };
  let r = LcProbe.analyze(bytes);
  if (r.needTail && info.ranged) {
    try {
      const tail = await fetchRange(url, `bytes=-${TAIL_BYTES}`);
      r = LcProbe.analyze(bytes, tail.bytes);
    } catch (_) { /* хвост не обязателен */ }
  }
  if (r.container === 'text') out.textSample = new TextDecoder().decode(bytes.subarray(0, 300));
  return { ...out, ...r, mime: LcProbe.containerMime(r) };
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'probe') {
    return probe(msg.url).catch((e) => ({ url: msg.url, error: 'network', message: String(e && e.message || e) }));
  }
  if (msg && msg.type === 'download') {
    return browser.downloads.download({ url: msg.url, saveAs: true }).then(() => true, () => false);
  }
  if (msg && msg.type === 'config') return Promise.resolve(cfg);
  return undefined;
});
