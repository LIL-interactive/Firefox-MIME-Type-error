# ffmpeg.wasm

`ffmpeg-core.js` и `ffmpeg-core.wasm` — однопоточная сборка ffmpeg для WebAssembly из пакета
[`@ffmpeg/core@0.12.10`](https://www.npmjs.com/package/@ffmpeg/core) (ESM-вариант, `dist/esm`).
Исходники и сборка: https://github.com/ffmpegwasm/ffmpeg.wasm. Лицензия — GPL-2.0-or-later
(в сборке libx264, libvpx, libopus и др.).

Обновить: `scripts/update-ffmpeg.sh <версия>`.

Почему однопоточная: многопоточной сборке нужен SharedArrayBuffer, а он доступен только
странице с cross-origin isolation, которую страницы расширений Firefox не получают.
Параллельность расширение делает само — несколько потоков перекодируют разные отрезки видео.
