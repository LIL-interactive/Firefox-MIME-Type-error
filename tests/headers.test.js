// Логика исправления Content-Type из background.js на подставном browser API.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function load() {
  let listener;
  const noop = { addListener() {} };
  const browser = {
    storage: { local: { get: async (d) => d }, onChanged: noop },
    webRequest: { onHeadersReceived: { addListener(fn) { listener = fn; } } },
    browserAction: { setBadgeText: async () => {} },
    tabs: { onRemoved: noop, onUpdated: noop },
    runtime: { onMessage: noop },
    downloads: {},
  };
  const ctx = vm.createContext({ browser, URL, TextDecoder, setTimeout, clearTimeout, AbortController });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), ctx);
  return (url, type, headers) => listener({ url, type, tabId: 1, responseHeaders: headers });
}
const ct = (r) => r.responseHeaders && r.responseHeaders.find((h) => h.name.toLowerCase() === 'content-type')?.value;
const H = (t, extra = []) => [{ name: 'Content-Type', value: t }, ...extra];

test('octet-stream у .mp4 → video/mp4, nosniff снят', () => {
  const r = load()('https://cdn.example/v/a.mp4?x=1', 'media', H('application/octet-stream', [{ name: 'X-Content-Type-Options', value: 'nosniff' }]));
  assert.equal(ct(r), 'video/mp4');
  assert.ok(!r.responseHeaders.some((h) => /x-content-type-options/i.test(h.name)));
});

test('video/quicktime → video/mp4 даже без расширения', () => {
  assert.equal(ct(load()('https://x.example/stream/123', 'media', H('video/quicktime'))), 'video/mp4');
});

test('.mkv → video/webm', () => {
  assert.equal(ct(load()('https://x.example/a.mkv', 'media', H('video/x-matroska'))), 'video/webm');
});

test('имя файла из Content-Disposition', () => {
  const r = load()('https://x.example/dl/42', 'media', H('application/octet-stream', [{ name: 'Content-Disposition', value: 'attachment; filename="clip.webm"' }]));
  assert.equal(ct(r), 'video/webm');
});

test('неизвестное расширение в <video> → тип убран, Firefox определит сам', () => {
  const r = load()('https://x.example/get?id=5', 'media', H('application/octet-stream'));
  assert.equal(ct(r), undefined);
  assert.ok(r.responseHeaders);
});

test('правильный тип не трогаем', () => {
  assert.deepEqual(load()('https://x.example/a.mp4', 'media', H('video/mp4')), {});
});

test('прямой переход на непонятный бинарник не трогаем', () => {
  assert.deepEqual(load()('https://x.example/file.bin', 'main_frame', H('application/octet-stream')), {});
});
