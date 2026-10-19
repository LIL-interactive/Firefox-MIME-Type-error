/*
 * player.js — проигрыватель встроенного декодера.
 *
 * Скачивает исходный файл, режет его на отрезки и перекодирует их параллельно
 * в нескольких потоках (decoder/worker.js) в WebM VP8 + Opus. Готовые отрезки
 * по одному добавляются в MediaSource, поэтому смотреть можно почти сразу:
 * первый отрезок короткий, остальные догоняют, пока идёт просмотр. Если файл
 * читается по порядку (MP4 с индексом в начале, MKV/WebM), перекодирование
 * начинается ещё до конца скачивания.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const video = $('v');
const stEl = $('st'), stText = $('st-text');

const FIRST_SEG = 4;        // первый отрезок короткий — быстрее старт
const SEG = 10;             // остальные
const LOOKAHEAD = 240;      // не перекодировать дальше, чем на 4 мин вперёд
const KEEP_BEHIND = 60;     // сколько секунд держать в буфере позади
const QUALITY = { 480: 1200, 720: 2500, 1080: 4500, 0: 6000 }; // высота → кбит/с

let job, blobParts = [], loaded = 0, total = 0, done = false;
let info = null, segs = [], workers = [], ms, sb, mime, failed = false;
let probing = false, probeTriedAt = 0;

function status(text, { idle = false, quiet = false } = {}) {
  stText.textContent = text;
  stEl.classList.toggle('is-idle', idle);
  stEl.classList.toggle('is-quiet', quiet);
}
function fail(text) {
  if (failed) return;
  failed = true;
  stEl.hidden = true;
  $('err-text').textContent = text;
  $('err-dl').href = job ? job.url : '#';
  $('err').hidden = false;
  workers.forEach((w) => w.w.terminate());
}
const fmt = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
};

// ── Потоки декодера ──────────────────────────────────────────────────────────
let reqId = 0;
function makeWorker() {
  const w = new Worker(new URL('decoder/worker.js', location.href), { type: 'module' });
  const slot = { w, busy: false, pending: new Map() };
  w.onmessage = (e) => { const cb = slot.pending.get(e.data.id); slot.pending.delete(e.data.id); cb && cb(e.data); };
  w.onerror = (e) => fail('Встроенный декодер не запустился: ' + (e.message || 'ошибка потока'));
  workers.push(slot);
  return slot;
}
function call(slot, msg) {
  return new Promise((resolve) => { const id = ++reqId; slot.pending.set(id, resolve); slot.w.postMessage({ ...msg, id }); });
}
const snapshot = () => new Blob(blobParts);

// Можно ли работать с недокачанным файлом.
function streamable() {
  const p = job.probe || {};
  return (p.container === 'mp4' && !p.moovAtEnd) || p.container === 'matroska';
}
function bytesReady(seg) {
  if (done) return true;
  if (!streamable() || !total || !info || !info.duration) return false;
  const need = total * Math.min(1, (seg.start + seg.dur) / info.duration) * 1.08 + 1.5e6;
  return loaded >= need;
}

// ── Скачивание ───────────────────────────────────────────────────────────────
async function download() {
  const res = await fetch(job.url, { credentials: 'include', cache: 'force-cache' });
  if (!res.ok) throw new Error(`сервер ответил HTTP ${res.status}`);
  total = Number(res.headers.get('content-length')) || job.probe?.size || 0;
  const reader = res.body.getReader();
  let last = 0;
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    blobParts.push(value);
    loaded += value.length;
    if (loaded - last > 512 * 1024) { last = loaded; tick(); }
  }
  done = true;
  if (!total) total = loaded;
  tick();
}

// ── Сведения о файле ────────────────────────────────────────────────────────
async function tryProbe() {
  if (info || probing) return;
  if (!done && (!streamable() || loaded < Math.min(total || Infinity, 2e6) || loaded - probeTriedAt < 2e6)) return;
  probing = true; probeTriedAt = loaded;
  const r = await call(workers[0], { type: 'probe', blob: snapshot() });
  probing = false;
  if (r.ok && (r.info.video || r.info.audio) && (r.info.duration || done)) {
    info = r.info;
    setupPlan();
  } else if (done) {
    fail('Не удалось прочитать файл: он повреждён или это не видео.');
    return;
  }
  tick();
}

function setupPlan() {
  const d = info.duration || 0;
  if (!d) segs = [{ start: 0, dur: 1e6, state: 'todo' }];
  else {
    let t = 0;
    while (t < d - 0.05) {
      const len = t === 0 ? FIRST_SEG : SEG;
      // хвост короче 3 с прилепляем к последнему отрезку
      const dur = d - (t + len) < 3 ? d - t : len;
      segs.push({ start: t, dur, state: 'todo', tries: 0 });
      t += dur;
    }
  }
  const hasVideo = !!info.video, hasAudio = !!info.audio;
  mime = hasVideo ? `video/webm; codecs="${hasAudio ? 'vp8, opus' : 'vp8'}"` : 'audio/webm; codecs="opus"';
  if (!MediaSource.isTypeSupported(mime)) { fail('Этот Firefox не поддерживает даже WebM VP8 — проверьте about:config: media.webm.enabled.'); return; }
  const n = Math.max(1, Math.min(job.cfg.threads || (navigator.hardwareConcurrency || 2) - 1, 6));
  while (workers.length < n) makeWorker();
  ms = new MediaSource();
  video.src = URL.createObjectURL(ms);
  ms.addEventListener('sourceopen', () => {
    sb = ms.addSourceBuffer(mime);
    sb.mode = 'segments';
    if (info.duration) ms.duration = info.duration;
    sb.addEventListener('updateend', () => { appendNext(); tick(); });
    tick();
  }, { once: true });
}

// ── Планировщик ─────────────────────────────────────────────────────────────
const segAt = (t) => Math.max(0, segs.findIndex((s) => t >= s.start && t < s.start + s.dur));

function pickSegment() {
  const from = segAt(video.currentTime);
  for (let i = from; i < segs.length; i++) {
    const s = segs[i];
    if (s.start > video.currentTime + LOOKAHEAD) break;
    if (s.state === 'todo' && bytesReady(s)) return s;
  }
  return null;
}

async function runSegment(slot, s) {
  slot.busy = true; s.state = 'work';
  const q = job.cfg.quality ?? 720;
  const r = await call(slot, {
    type: 'segment', blob: snapshot(), start: s.start, dur: s.dur, height: q, bitrate: QUALITY[q] || 2500,
    hasVideo: !!info.video, hasAudio: !!info.audio,
  });
  slot.busy = false;
  if (r.ok) { s.state = 'ready'; s.data = r.data; s.speed = (s.dur * 1000) / r.ms; }
  else {
    s.state = 'todo'; s.tries++;
    // на недокачанном файле ошибка ожидаема — повторим, когда данных станет больше
    if (done && s.tries >= 2) { fail('Не удалось перекодировать видео.\n' + r.error.split('\n').slice(-3).join('\n')); return; }
    if (!done) s.waitBytes = loaded + 4e6;
  }
  tick();
}

function appendNext() {
  if (!sb || sb.updating || failed) return;
  // По порядку от текущей позиции — чтобы буфер рос непрерывно.
  const from = segAt(video.currentTime);
  const order = segs.slice(from).concat(segs.slice(0, from));
  const s = order.find((x) => x.state === 'ready');
  if (!s) {
    if (segs.length && segs.every((x) => x.state === 'appended') && ms.readyState === 'open') { try { ms.endOfStream(); } catch (_) {} }
    return;
  }
  try {
    sb.timestampOffset = s.start;
    sb.appendBuffer(s.data);
    s.state = 'appended'; s.data = null;
  } catch (e) {
    if (e.name === 'QuotaExceededError') evict(true);
    else fail('Ошибка проигрывателя: ' + e.message);
  }
}

// Освобождаем буфер позади текущей позиции (у MediaSource ограниченный объём).
function evict(force) {
  if (!sb || sb.updating) return;
  const until = video.currentTime - (force ? 10 : KEEP_BEHIND);
  if (until <= 1) return;
  const b = sb.buffered;
  if (!b.length || b.start(0) >= until) return;
  sb.remove(0, until);
  for (const s of segs) if (s.state === 'appended' && s.start + s.dur <= until) s.state = 'todo';
}

function tick() {
  if (failed || !job) return;
  if (!info) { tryProbe(); }
  else if (sb) {
    for (const slot of workers) {
      if (slot.busy) continue;
      const s = pickSegment();
      if (!s || (s.waitBytes && !done && loaded < s.waitBytes)) break;
      runSegment(slot, s);
    }
    appendNext();
  }
  renderStatus();
}

function bufferedAhead() {
  const b = video.buffered, t = video.currentTime;
  for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.3 && t <= b.end(i)) return b.end(i);
  return t;
}

function renderStatus() {
  if (failed) return;
  const dl = total ? Math.min(100, Math.round(loaded / total * 100)) : 0;
  if (!info) { status(done ? 'Читаю файл…' : `Скачиваю видео${total ? ' — ' + dl + '%' : '…'}`); return; }
  const end = bufferedAhead();
  const all = segs.length && segs.every((s) => s.state === 'appended');
  const speeds = segs.filter((s) => s.speed).map((s) => s.speed);
  const x = speeds.length ? (speeds.reduce((a, b) => a + b, 0) / speeds.length) * Math.max(1, workers.length) : 0;
  const parts = [];
  if (!done) parts.push(`скачано ${dl}%`);
  if (all) parts.push('видео готово');
  else parts.push(end > video.currentTime + 0.5 ? `готово до ${fmt(end)}` : 'перекодирую…');
  if (x) parts.push(`скорость ×${x.toFixed(1)}`);
  const waiting = video.readyState < 3 && !video.paused;
  const quiet = (all && done) || (!waiting && end - video.currentTime > 20 && !video.paused);
  status('Встроенный декодер · ' + parts.join(' · '), { idle: !waiting && end > video.currentTime + 0.5, quiet });
}

video.addEventListener('seeking', tick);
video.addEventListener('waiting', tick);
video.addEventListener('timeupdate', () => { evict(false); tick(); });
video.addEventListener('playing', renderStatus);
video.addEventListener('error', () => {
  const e = video.error;
  if (e && !failed) fail('Ошибка воспроизведения: ' + (e.message || 'код ' + e.code));
});
stEl.addEventListener('mouseenter', () => stEl.classList.remove('is-quiet'));

// ── Запуск ──────────────────────────────────────────────────────────────────
(async () => {
  const token = location.hash.slice(1);
  job = await browser.runtime.sendMessage({ type: 'job', token }).catch(() => null);
  if (!job) { stEl.hidden = true; $('err-text').textContent = 'Ссылка на видео устарела — обновите страницу.'; $('err').hidden = false; return; }
  document.title = (job.title ? job.title + ' — ' : '') + 'Встроенный декодер';
  video.loop = !!job.loop;
  video.muted = !!job.muted;
  // На странице может быть много таких видео — без автозапуска ничего не качаем
  // и не перекодируем, пока человек не нажмёт «Воспроизвести».
  const start = (play) => {
    $('go').hidden = true; stEl.hidden = false;
    makeWorker();
    let started = false;
    video.addEventListener('canplay', () => {
      if (started) return;
      started = true;
      if (play) video.play().catch(() => { /* автозапуск со звуком запрещён — ждём нажатия */ });
    });
    download().catch((e) => fail('Не удалось скачать видео: ' + e.message));
    tick();
  };
  if (job.autoplay) start(true);
  else {
    stEl.hidden = true;
    video.controls = false;
    $('go').hidden = false;
    $('go').addEventListener('click', () => { video.controls = true; start(true); }, { once: true });
  }
})();
