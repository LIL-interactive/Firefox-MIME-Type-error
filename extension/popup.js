'use strict';
const DEFAULTS = { fixHeaders: true, mkvAsWebm: true, movAsMp4: true, dropNosniff: true, forceInline: false, overlay: true, decoder: 'auto', quality: 720, threads: 0 };

browser.storage.local.get(DEFAULTS).then((cfg) => {
  for (const box of document.querySelectorAll('input[data-k]')) {
    box.checked = !!cfg[box.dataset.k];
    box.addEventListener('change', () => browser.storage.local.set({ [box.dataset.k]: box.checked }));
  }
  for (const sel of document.querySelectorAll('select[data-k]')) {
    sel.value = String(cfg[sel.dataset.k]);
    sel.addEventListener('change', () => {
      const v = 'num' in sel.dataset ? Number(sel.value) : sel.value;
      browser.storage.local.set({ [sel.dataset.k]: v });
    });
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
  else h.textContent = '«Нет» не страшно: такие видео проигрывает встроенный декодер расширения.';
  // Системный кодек ставится только из Microsoft Store — даём прямую кнопку.
  const sys = document.getElementById('sys');
  if (os === 'win' && missing.some((n) => n.startsWith('H.265'))) {
    sys.hidden = false;
    document.getElementById('sys-text').textContent = 'HEVC сейчас работает только через встроенный декодер. Чтобы Firefox играл его сам (быстрее и без нагрузки на процессор), установите бесплатный кодек Microsoft и перезапустите Firefox. Нужны Firefox 134+ и видеокарта с аппаратным HEVC (Intel 6-го поколения, NVIDIA GTX 950, AMD RX 400 и новее).';
    const b = document.getElementById('sys-btn');
    b.textContent = 'Установить кодек HEVC (Microsoft Store)';
    b.addEventListener('click', () => browser.runtime.sendMessage({ type: 'openStore', what: 'hevc' }));
  } else if (os === 'win' && noH264) {
    sys.hidden = false;
    document.getElementById('sys-text').textContent = 'В Windows N/KN нет системных кодеков H.264 и AAC — установите «Пакет компонентов мультимедиа».';
    const b = document.getElementById('sys-btn');
    b.textContent = 'Открыть инструкцию Microsoft';
    b.addEventListener('click', () => browser.runtime.sendMessage({ type: 'openStore', what: 'mfp' }));
  }
});
