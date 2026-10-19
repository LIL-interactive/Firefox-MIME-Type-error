/*
 * probe.js — определяет контейнер и кодеки медиафайла по его первым (и при
 * необходимости последним) байтам. Ничего не воспроизводит и не декодирует —
 * только читает заголовки контейнера.
 *
 * Используется фоновым скриптом расширения и тестами в Node (module.exports).
 */
(function (root) {
  'use strict';

  const ascii = (b, o, n) => {
    let s = '';
    for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]);
    return s;
  };
  const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

  function indexOfAscii(b, str, from) {
    const c0 = str.charCodeAt(0);
    outer: for (let i = from || 0; i <= b.length - str.length; i++) {
      if (b[i] !== c0) continue;
      for (let j = 1; j < str.length; j++) if (b[i + j] !== str.charCodeAt(j)) continue outer;
      return i;
    }
    return -1;
  }

  // ── Сигнатуры: что вообще пришло вместо видео ──────────────────────────────
  function sniffContainer(b) {
    if (!b || b.length < 4) return 'empty';
    if (ascii(b, 4, 4) === 'ftyp' || ['moov', 'mdat', 'free', 'wide', 'skip'].includes(ascii(b, 4, 4))) return 'mp4';
    if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return 'matroska';
    if (ascii(b, 0, 4) === 'OggS') return 'ogg';
    if (ascii(b, 0, 4) === 'fLaC') return 'flac';
    if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return 'wav';
    if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'AVI ') return 'avi';
    if (ascii(b, 0, 3) === 'FLV') return 'flv';
    if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xB2 && b[3] === 0x75) return 'asf';
    if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0)) {
      if (b[0] === 0xFF && (b[1] & 0xF6) === 0xF0) return 'aac'; // ADTS
      return 'mp3';
    }
    if (b[0] === 0x47 && b.length > 376 && b[188] === 0x47 && b[376] === 0x47) return 'mpegts';
    if (ascii(b, 0, 7) === '#EXTM3U') return 'hls';
    const head = ascii(b, 0, 512).trimStart().toLowerCase();
    if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<head') ||
        head.startsWith('<?xml') || head.startsWith('<error') || head.startsWith('{')) return 'text';
    return 'unknown';
  }

  // ── MP4 / MOV ──────────────────────────────────────────────────────────────
  // Ищем бокс(ы) stsd и разбираем записи сэмплов: их fourcc и есть кодек.
  function parseMp4(b, opts = {}) {
    const out = { brand: null, codecs: [], drm: false, foundStsd: false, moovAtEnd: false };
    if (ascii(b, 4, 4) === 'ftyp') out.brand = ascii(b, 8, 4).trim();

    // Обход верхнего уровня: mdat раньше moov → moov в хвосте (нет faststart).
    let off = 0;
    while (off + 8 <= b.length) {
      let size = u32(b, off);
      const type = ascii(b, off + 4, 4);
      if (size === 1 && off + 16 <= b.length) size = u32(b, off + 12) + u32(b, off + 8) * 4294967296;
      if (type === 'moov') break;
      if (type === 'mdat') { out.moovAtEnd = true; break; }
      if (size < 8) break;
      off += size;
    }

    // mdat в начале → в этих байтах только сжатые кадры, stsd искать бессмысленно.
    if (out.moovAtEnd && opts.head) return out;
    let from = 0;
    for (;;) {
      const p = indexOfAscii(b, 'stsd', from);
      if (p < 4) break;
      from = p + 4;
      const boxStart = p - 4;
      const boxSize = u32(b, boxStart);
      const count = u32(b, p + 8);
      if (boxSize < 16 || count < 1 || count > 16) continue;
      out.foundStsd = true;
      let e = p + 12;
      const end = Math.min(b.length, boxStart + boxSize);
      for (let i = 0; i < count && e + 8 <= end; i++) {
        const eSize = u32(b, e);
        const fourcc = ascii(b, e + 4, 4);
        if (eSize < 8) break;
        const entry = b.subarray(e, Math.min(b.length, e + eSize));
        out.codecs.push(describeMp4Entry(fourcc, entry));
        if (fourcc === 'encv' || fourcc === 'enca') out.drm = true;
        e += eSize;
      }
    }
    return out;
  }

  const MP4_CODECS = {
    avc1: ['video', 'H.264 (AVC)'], avc3: ['video', 'H.264 (AVC)'],
    hvc1: ['video', 'H.265 (HEVC)'], hev1: ['video', 'H.265 (HEVC)'],
    av01: ['video', 'AV1'], vp09: ['video', 'VP9'], vp08: ['video', 'VP8'],
    mp4v: ['video', 'MPEG-4 Part 2 (DivX/Xvid)'],
    apcn: ['video', 'Apple ProRes'], apch: ['video', 'Apple ProRes'], apcs: ['video', 'Apple ProRes'],
    apco: ['video', 'Apple ProRes'], ap4h: ['video', 'Apple ProRes'],
    jpeg: ['video', 'Motion JPEG'], mjpa: ['video', 'Motion JPEG'],
    dvh1: ['video', 'Dolby Vision'], dvhe: ['video', 'Dolby Vision'],
    encv: ['video', 'зашифрованное видео (DRM)'],
    mp4a: ['audio', 'AAC'], Opus: ['audio', 'Opus'], fLaC: ['audio', 'FLAC'],
    'ac-3': ['audio', 'Dolby Digital (AC-3)'], 'ec-3': ['audio', 'Dolby Digital Plus (E-AC-3)'],
    '.mp3': ['audio', 'MP3'], alac: ['audio', 'Apple Lossless (ALAC)'],
    sowt: ['audio', 'PCM'], twos: ['audio', 'PCM'], lpcm: ['audio', 'PCM'], ipcm: ['audio', 'PCM'],
    enca: ['audio', 'зашифрованное аудио (DRM)'],
  };

  // Строка codecs="…" для canPlayType/isTypeSupported (RFC 6381).
  function describeMp4Entry(fourcc, entry) {
    const [kind, name] = MP4_CODECS[fourcc] || [/^(tmcd|text|tx3g|wvtt|c608|mp4s|rtp )$/.test(fourcc) ? 'other' : 'unknown', fourcc];
    let rfc = null, profile = null;
    if (fourcc === 'avc1' || fourcc === 'avc3') {
      const c = indexOfAscii(entry, 'avcC', 0);
      if (c > 0 && c + 8 <= entry.length) {
        const pr = entry[c + 5], cm = entry[c + 6], lv = entry[c + 7];
        rfc = fourcc + '.' + hex2(pr) + hex2(cm) + hex2(lv);
        profile = ({ 66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10',
                     122: 'High 4:2:2', 244: 'High 4:4:4' })[pr] || ('profile ' + pr);
      } else rfc = fourcc + '.640028';
    } else if (fourcc === 'hvc1' || fourcc === 'hev1') {
      const c = indexOfAscii(entry, 'hvcC', 0);
      const p = c > 0 && c + 6 <= entry.length ? (entry[c + 5] & 0x1F) : 1;
      profile = ({ 1: 'Main', 2: 'Main 10', 3: 'Main Still', 4: 'RExt' })[p] || ('profile ' + p);
      rfc = p === 2 ? fourcc + '.2.4.L120.B0' : fourcc + '.1.6.L93.B0';
    } else if (fourcc === 'av01') rfc = 'av01.0.05M.08';
    else if (fourcc === 'vp09') rfc = 'vp09.00.10.08';
    else if (fourcc === 'vp08') rfc = 'vp8';
    else if (fourcc === 'mp4v') rfc = 'mp4v.20.8';
    else if (fourcc === 'mp4a') rfc = 'mp4a.40.2';
    else if (fourcc === 'Opus') rfc = 'opus';
    else if (fourcc === 'fLaC') rfc = 'flac';
    else if (fourcc === 'ac-3' || fourcc === 'ec-3') rfc = fourcc;
    else if (fourcc === '.mp3') rfc = 'mp3';
    else if (fourcc === 'dvh1' || fourcc === 'dvhe') rfc = fourcc + '.05.06';
    return { fourcc, kind, name, rfc, profile };
  }

  // ── Matroska / WebM ────────────────────────────────────────────────────────
  function readVint(b, o) {
    const first = b[o];
    if (first === undefined || first === 0) return null;
    let len = 1, mask = 0x80;
    while (!(first & mask)) { len++; mask >>= 1; }
    let v = first & (mask - 1);
    for (let i = 1; i < len; i++) v = v * 256 + b[o + i];
    return { len, value: v };
  }

  const MKV_CODECS = {
    V_VP8: ['video', 'VP8', 'vp8'], V_VP9: ['video', 'VP9', 'vp9'], V_AV1: ['video', 'AV1', 'av01.0.05M.08'],
    'V_MPEG4/ISO/AVC': ['video', 'H.264 (AVC)', 'avc1.640028'],
    'V_MPEGH/ISO/HEVC': ['video', 'H.265 (HEVC)', 'hvc1.1.6.L93.B0'],
    'V_MPEG4/ISO/ASP': ['video', 'MPEG-4 Part 2 (DivX/Xvid)', 'mp4v.20.8'],
    V_THEORA: ['video', 'Theora', 'theora'], 'V_MS/VFW/FOURCC': ['video', 'Video for Windows', null],
    A_OPUS: ['audio', 'Opus', 'opus'], A_VORBIS: ['audio', 'Vorbis', 'vorbis'],
    A_AAC: ['audio', 'AAC', 'mp4a.40.2'], 'A_MPEG/L3': ['audio', 'MP3', 'mp3'],
    A_FLAC: ['audio', 'FLAC', 'flac'], A_AC3: ['audio', 'Dolby Digital (AC-3)', 'ac-3'],
    A_EAC3: ['audio', 'Dolby Digital Plus (E-AC-3)', 'ec-3'], A_DTS: ['audio', 'DTS', null],
    A_TRUEHD: ['audio', 'Dolby TrueHD', null], 'A_PCM/INT/LIT': ['audio', 'PCM', null],
  };

  function parseMatroska(b) {
    const out = { docType: null, codecs: [], drm: false };
    // Заголовки дорожек лежат ДО первого Cluster (ID 1F 43 B6 75); дальше — сжатые
    // кадры, где случайные байты дали бы ложные совпадения.
    let lim = b.length;
    for (let i = 0; i < b.length - 3; i++) {
      if (b[i] === 0x1F && b[i + 1] === 0x43 && b[i + 2] === 0xB6 && b[i + 3] === 0x75) { lim = i; break; }
    }
    // DocType: ID 0x4282
    for (let i = 0; i < Math.min(b.length - 3, 128); i++) {
      if (b[i] === 0x42 && b[i + 1] === 0x82) {
        const v = readVint(b, i + 2);
        if (v && v.value > 0 && v.value < 16) { out.docType = ascii(b, i + 2 + v.len, v.value); break; }
      }
    }
    // CodecID: ID 0x86, значение — ASCII вида V_… / A_… / S_…
    const seen = new Set();
    for (let i = 0; i < lim - 3; i++) {
      if (b[i] !== 0x86) continue;
      const v = readVint(b, i + 1);
      if (!v || v.value < 3 || v.value > 40) continue;
      const s = ascii(b, i + 1 + v.len, v.value);
      if (!/^[VAS]_[A-Z0-9_/.]+$/.test(s)) continue;
      if (s[0] === 'S') continue; // субтитры воспроизведению не мешают
      const known = MKV_CODECS[s] || Object.entries(MKV_CODECS).find(([k]) => s.startsWith(k + '/'))?.[1];
      const [kind, name, rfc] = known || [s[0] === 'V' ? 'video' : 'audio', s, null];
      const key = kind + name;
      if (seen.has(key)) continue;
      seen.add(key);
      out.codecs.push({ fourcc: s, kind, name, rfc, profile: null });
    }
    // ContentEncKeyID (0x47E2) есть только у зашифрованных дорожек — это DRM.
    for (let i = 0; i < lim - 1; i++) if (b[i] === 0x47 && b[i + 1] === 0xE2) { out.drm = true; break; }
    return out;
  }

  // ── Главная функция ────────────────────────────────────────────────────────
  // head — первые байты файла, tail — последние (необязательно).
  function analyze(head, tail) {
    const container = sniffContainer(head);
    const r = { container, brand: null, docType: null, codecs: [], drm: false, moovAtEnd: false, needTail: false };
    if (container === 'mp4') {
      const h = parseMp4(head, { head: true });
      Object.assign(r, { brand: h.brand, codecs: h.codecs, drm: h.drm, moovAtEnd: h.moovAtEnd });
      if (!h.foundStsd) {
        if (tail && tail.length) {
          const t = parseMp4(tail);
          r.codecs = t.codecs; r.drm = t.drm;
          r.moovAtEnd = true;
        } else r.needTail = true;
      }
    } else if (container === 'matroska') {
      const m = parseMatroska(head);
      Object.assign(r, { docType: m.docType, codecs: m.codecs, drm: m.drm });
    } else if (container === 'ogg') {
      const s = ascii(head, 0, Math.min(head.length, 4096));
      if (s.includes('OpusHead')) r.codecs.push({ fourcc: 'opus', kind: 'audio', name: 'Opus', rfc: 'opus' });
      if (s.includes('vorbis')) r.codecs.push({ fourcc: 'vorbis', kind: 'audio', name: 'Vorbis', rfc: 'vorbis' });
      if (s.includes('theora')) r.codecs.push({ fourcc: 'theora', kind: 'video', name: 'Theora', rfc: 'theora' });
      if (s.includes('FLAC')) r.codecs.push({ fourcc: 'flac', kind: 'audio', name: 'FLAC', rfc: 'flac' });
    }
    return r;
  }

  // Правильный MIME по контейнеру (для проверки canPlayType).
  function containerMime(r) {
    switch (r.container) {
      case 'mp4': return r.codecs.some((c) => c.kind === 'video') ? 'video/mp4' : 'audio/mp4';
      case 'matroska': return 'video/webm';
      case 'ogg': return r.codecs.some((c) => c.kind === 'video') ? 'video/ogg' : 'audio/ogg';
      case 'flac': return 'audio/flac';
      case 'wav': return 'audio/wav';
      case 'mp3': return 'audio/mpeg';
      case 'aac': return 'audio/aac';
      default: return null;
    }
  }

  const api = { analyze, sniffContainer, parseMp4, parseMatroska, containerMime };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LcProbe = api;
})(typeof self !== 'undefined' ? self : this);
