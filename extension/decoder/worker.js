/*
 * decoder/worker.js — один поток перекодирования (модульный Web Worker).
 *
 * Внутри — ffmpeg, собранный в WebAssembly (ffmpeg.wasm, vendor/). Поток умеет:
 *   probe   — прочитать длительность и дорожки файла;
 *   segment — перекодировать отрезок [start, start+dur) в WebM (VP8 + Opus).
 * VP8/Opus Firefox декодирует встроенными средствами на любой ОС, поэтому
 * результат играет даже там, где нет ни HEVC, ни H.264.
 *
 * Файл не копируется в память ffmpeg: Blob монтируется через WORKERFS и
 * читается кусками по мере надобности.
 */
import createFFmpegCore from './vendor/ffmpeg-core.js';

let core = null;
let log = [];

async function ensureCore() {
  if (core) return core;
  const coreURL = new URL('./vendor/ffmpeg-core.js', import.meta.url).href;
  const wasmURL = new URL('./vendor/ffmpeg-core.wasm', import.meta.url).href;
  core = await createFFmpegCore({
    // ffmpeg.wasm ищет .wasm по «хэшу» адреса главного скрипта — так задумано авторами.
    mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({ wasmURL, workerURL: '' }))}`,
  });
  core.setLogger((d) => { log.push(d.message); if (log.length > 400) log.splice(0, 200); });
  core.FS.mkdir('/in');
  return core;
}

function mountBlob(blob) {
  try { core.FS.unmount('/in'); } catch (_) { /* не смонтирован */ }
  core.FS.mount(core.FS.filesystems.WORKERFS, { blobs: [{ name: 'src', data: blob }] }, '/in');
}

function run(args) {
  log = [];
  core.exec(...args);
  const ret = core.ret;
  core.reset();
  return ret;
}

// Разбор вывода «ffmpeg -i»: длительность и дорожки.
function parseInfo(lines) {
  const text = lines.join('\n');
  const info = { duration: 0, video: null, audio: null, width: 0, height: 0 };
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (d) info.duration = (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]);
  const v = /Stream #\d+:\d+[^:]*: Video: ([^\n]+)/.exec(text);
  if (v) {
    info.video = v[1].split(/[ ,(]/)[0];
    const wh = /, (\d{2,5})x(\d{2,5})/.exec(v[1]);
    if (wh) { info.width = +wh[1]; info.height = +wh[2]; }
  }
  const a = /Stream #\d+:\d+[^:]*: Audio: ([^\n]+)/.exec(text);
  if (a) info.audio = a[1].split(/[ ,(]/)[0];
  return info;
}

function segmentArgs({ start, dur, height, bitrate, hasVideo, hasAudio }) {
  const args = ['-hide_banner', '-loglevel', 'info'];
  if (start > 0) args.push('-ss', start.toFixed(3));
  args.push('-i', '/in/src', '-t', dur.toFixed(3));
  if (hasVideo) {
    args.push('-map', '0:v:0');
    // Уменьшаем только то, что больше выбранной высоты; ширина — чётная.
    const vf = height ? [`scale=-2:'min(${height},ih)':flags=fast_bilinear`] : [];
    vf.push('format=yuv420p');
    args.push('-vf', vf.join(','),
      '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '16',
      '-b:v', `${bitrate}k`,
      '-g', '120', '-auto-alt-ref', '0', '-lag-in-frames', '0');
  } else args.push('-vn');
  // Без -ac/-ar: в ffmpeg.wasm 0.12 явное преобразование каналов/частоты перед
  // libopus роняет WebAssembly («index out of bounds»); нужную частоту ffmpeg выберет сам.
  if (hasAudio) args.push('-map', '0:a:0', '-c:a', 'libopus', '-b:a', '128k');
  else args.push('-an');
  args.push('-sn', '-dn', '-map_metadata', '-1', '-f', 'webm', '/out.webm');
  return args;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    await ensureCore();
    if (m.type === 'probe') {
      mountBlob(m.blob);
      run(['-hide_banner', '-i', '/in/src']); // без выхода ffmpeg «падает», но успевает напечатать сведения
      self.postMessage({ id: m.id, ok: true, info: parseInfo(log) });
      return;
    }
    if (m.type === 'segment') {
      mountBlob(m.blob);
      const t0 = performance.now();
      const ret = run(segmentArgs(m));
      let data = null;
      try { data = core.FS.readFile('/out.webm'); core.FS.unlink('/out.webm'); } catch (_) { /* нет выхода */ }
      const tail = log.slice(-8).join('\n');
      if (ret !== 0 || !data || data.length < 64) {
        self.postMessage({ id: m.id, ok: false, error: tail || 'ffmpeg ret ' + ret });
        return;
      }
      const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      self.postMessage({ id: m.id, ok: true, data: buf, ms: performance.now() - t0 }, [buf]);
    }
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) });
  }
};
