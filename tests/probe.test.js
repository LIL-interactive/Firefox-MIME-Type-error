// Запуск: npm test
// Фикстуры — крошечные файлы, сделанные ffmpeg (см. tests/fixtures/README.md).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../extension/probe.js');

const fx = (n) => new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', n)));
const HEAD = 4096;
const names = (r) => r.codecs.map((c) => c.name);

test('H.264 High + AAC, moov в начале', () => {
  const r = P.analyze(fx('h264_faststart.mp4').subarray(0, HEAD));
  assert.equal(r.container, 'mp4');
  assert.deepEqual(names(r), ['H.264 (AVC)', 'AAC']);
  assert.equal(r.codecs[0].profile, 'High');
  assert.match(r.codecs[0].rfc, /^avc1\.64/);
  assert.equal(r.moovAtEnd, false);
});

test('H.264 High 10, moov в конце: сначала просит хвост, потом находит кодек', () => {
  const b = fx('h264_hi10_moov_end.mp4');
  const first = P.analyze(b.subarray(0, HEAD));
  assert.equal(first.needTail, true);
  assert.equal(first.moovAtEnd, true);
  const r = P.analyze(b.subarray(0, HEAD), b.subarray(Math.max(0, b.length - 8192)));
  assert.equal(r.codecs[0].profile, 'High 10');
  assert.match(r.codecs[0].rfc, /^avc1\.6E/);
  assert.equal(r.moovAtEnd, true);
});

test('HEVC в MP4', () => {
  const r = P.analyze(fx('hevc.mp4').subarray(0, HEAD));
  assert.equal(r.codecs[0].fourcc, 'hvc1');
  assert.equal(r.codecs[0].name, 'H.265 (HEVC)');
});

test('HEVC в MKV', () => {
  const r = P.analyze(fx('hevc.mkv').subarray(0, HEAD));
  assert.equal(r.container, 'matroska');
  assert.equal(r.docType, 'matroska');
  assert.deepEqual(names(r), ['H.265 (HEVC)', 'AAC']);
  assert.equal(r.drm, false);
});

test('VP9 + Opus в WebM', () => {
  const r = P.analyze(fx('vp9.webm').subarray(0, HEAD));
  assert.equal(r.docType, 'webm');
  assert.deepEqual(names(r), ['VP9', 'Opus']);
  assert.equal(P.containerMime(r), 'video/webm');
});

test('MOV (QuickTime) распознаётся как MP4-семейство', () => {
  const r = P.analyze(fx('h264.mov').subarray(0, HEAD));
  assert.equal(r.container, 'mp4');
  assert.equal(r.brand, 'qt');
});

test('HTML вместо видео', () => {
  const html = new TextEncoder().encode('\n<!DOCTYPE html><html><body>403 Forbidden</body></html>');
  assert.equal(P.analyze(html).container, 'text');
});

test('пустой ответ', () => {
  assert.equal(P.analyze(new Uint8Array(0)).container, 'empty');
});
