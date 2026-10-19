'use strict';
const DEFAULTS = { fixHeaders: true, mkvAsWebm: true, movAsMp4: true, dropNosniff: true, forceInline: false, overlay: true };

browser.storage.local.get(DEFAULTS).then((cfg) => {
  for (const box of document.querySelectorAll('input[data-k]')) {
    box.checked = !!cfg[box.dataset.k];
    box.addEventListener('change', () => browser.storage.local.set({ [box.dataset.k]: box.checked }));
  }
  syncSub();
});
function syncSub() {
  const on = document.querySelector('[data-k="fixHeaders"]').checked;
  for (const l of document.querySelectorAll('label.sub')) l.querySelector('input').disabled = !on;
}
document.querySelector('[data-k="fixHeaders"]').addEventListener('change', syncSub);

// Таблица поддержки: то же, что проверяет контент-скрипт.
const CAPS = [
  ['H.264 (MP4)', 'video/mp4; codecs="avc1.42E01E"'],
  ['H.264 High (MP4)', 'video/mp4; codecs="avc1.640028"'],
  ['H.264 High 10 (MP4)', 'video/mp4; codecs="avc1.6E0028"'],
  ['H.265 / HEVC', 'video/mp4; codecs="hvc1.1.6.L93.B0"'],
  ['H.265 / HEVC Main 10', 'video/mp4; codecs="hvc1.2.4.L120.B0"'],
  ['AV1', 'video/mp4; codecs="av01.0.05M.08"'],
  ['VP9 (WebM)', 'video/webm; codecs="vp9"'],
  ['VP8 (WebM)', 'video/webm; codecs="vp8"'],
  ['AAC', 'audio/mp4; codecs="mp4a.40.2"'],
  ['Opus', 'audio/webm; codecs="opus"'],
  ['MP3', 'audio/mpeg'],
  ['FLAC', 'audio/flac'],
  ['AC-3 (Dolby)', 'audio/mp4; codecs="ac-3"'],
];
const v = document.createElement('video');
const tbody = document.querySelector('#caps tbody');
const missing = [];
for (const [name, type] of CAPS) {
  let r = v.canPlayType(type);
  try { if (!r && MediaSource.isTypeSupported(type)) r = 'maybe'; } catch (_) {}
  const tr = document.createElement('tr');
  const a = document.createElement('td'); a.textContent = name;
  const b = document.createElement('td');
  b.textContent = r === 'probably' ? 'да' : r === 'maybe' ? 'вероятно' : 'нет';
  b.className = r === 'probably' ? 'ok' : r === 'maybe' ? 'maybe' : 'bad';
  tr.append(a, b); tbody.append(tr);
  if (!r) missing.push(name);
}
browser.runtime.getPlatformInfo().then(({ os }) => {
  const h = document.getElementById('caps-hint');
  const noH264 = missing.some((n) => n.startsWith('H.264 (MP4)')) || missing.includes('AAC');
  if (noH264 && os === 'linux') h.textContent = 'H.264/AAC не поддерживаются: установите системный ffmpeg (libavcodec). Для Flatpak — org.freedesktop.Platform.ffmpeg-full.';
  else if (noH264 && os === 'win') h.textContent = 'H.264/AAC не поддерживаются: в Windows N/KN установите «Пакет компонентов мультимедиа».';
  else if (missing.some((n) => n.startsWith('H.265'))) h.textContent = os === 'win'
    ? 'HEVC: нужны «Расширения для видео HEVC» из Microsoft Store и аппаратный декодер.'
    : 'HEVC: нужен системный ffmpeg с HEVC и аппаратное декодирование (VA-API). Иначе — mpv/VLC.';
  else h.textContent = '«Нет» у редких форматов (High 10, AC-3) — это ограничение Firefox, а не ошибка настройки.';
});
