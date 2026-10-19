# Video MIME Fix — «Видео в поддерживаемом формате и MIME-типе не найдено» в Firefox

Firefox показывает эту ошибку (англ. *No video with supported format and MIME type found*),
когда ни один источник `<video>`/`<audio>` ему не подошёл. Причин всего несколько, и их
легко спутать:

| Причина | Как выглядит | Кто может исправить |
|---|---|---|
| **Сервер отдаёт неверный `Content-Type`** (`application/octet-stream`, `text/plain`, `video/quicktime`, `video/x-matroska`) | файл нормальный, в Chrome играет | **расширение** (или владелец сайта) |
| **Кодек не поддерживается**: HEVC/H.265, H.264 High 10 (10 бит), AC-3/DTS, ProRes, DivX | в Chrome/Edge (Windows/Mac) играет, в Firefox нет | система (декодеры) или владелец сайта |
| **В системе нет декодера H.264/AAC** (Linux без ffmpeg, Windows N/KN, Flatpak/Snap без ffmpeg) | не играет почти ни одно MP4-видео | вы — установить декодер |
| **Неподдерживаемый контейнер**: AVI, FLV, WMV, MPEG-TS, MKV с H.264 | — | владелец сайта / внешний плеер |
| **Вместо видео приходит страница** (403, 404, капча, защита от хотлинка) | — | сайт |
| **DRM** выключен | Netflix и т.п. | вы — включить DRM в настройках |

## Расширение

`extension/` — расширение для Firefox 115+ (Manifest V2, работает и в ESR):

1. **Исправляет заголовки.** Если медиаответ пришёл с неверным `Content-Type`, расширение
   подставляет правильный по расширению файла (из адреса, параметра `?filename=` или
   `Content-Disposition`): `.mp4/.m4v/.mov → video/mp4`, `.mkv/.webm → video/webm`,
   `.ogg/.opus`, `.mp3`, `.m4a`, `.flac`, `.wav`. Если расширение неизвестно, неверный тип
   и `X-Content-Type-Options: nosniff` снимаются — Firefox сам определит формат по содержимому.
   Число исправлений на вкладке видно на значке.
2. **Объясняет, что не так.** Когда видео всё-таки не запускается, расширение скачивает
   первые 256 КБ файла (и последние 1 МБ, если индекс `moov` в конце), читает заголовки
   контейнера (MP4/MOV, MKV/WebM, Ogg, …), находит кодеки и спрашивает у браузера
   (`canPlayType` / `MediaSource.isTypeSupported`), какие из них он умеет. Внизу справа
   появляется карточка: причина, что сделать под вашу ОС, кнопки «Повторить», «Скачать»,
   «Копировать ссылку» (для mpv/VLC).
3. **Таблица поддержки** во всплывающем окне — какие кодеки умеет именно ваш Firefox.

Расширение ничего никуда не отправляет: файл читается напрямую с того же сайта, всё
остальное происходит локально.

### Установка

* **Попробовать** — `about:debugging` → «Этот Firefox» → «Загрузить временное дополнение» →
  выбрать `extension/manifest.json` (работает до перезапуска браузера).
* **Насовсем** — обычный Firefox ставит только подписанные дополнения. Соберите и подпишите
  своим ключом AMO (бесплатно, можно без публикации в каталоге):
  ```bash
  npx web-ext sign -s extension --channel=unlisted --api-key=… --api-secret=…
  ```
  В Firefox Developer Edition / Nightly / ESR можно поставить и неподписанный `.xpi`
  (`npm run build`), выключив `xpinstall.signatures.required` в `about:config`.

### Разработка

```bash
npm test        # парсер контейнеров (файлы из tests/fixtures) и логика заголовков
npm run lint    # web-ext lint
npm start       # запустить Firefox с расширением
```

## Если расширение не помогло: исправление вручную

**Проверьте `about:config`** (все должны быть `true`): `media.mp4.enabled`, `media.webm.enabled`,
`media.ffmpeg.enabled` (Linux), `media.av1.enabled`, `media.mediasource.enabled`,
`media.eme.enabled` (для DRM). После экспериментов с настройками можно сбросить их кнопкой
«сбросить» справа от строки.

**Linux** — Firefox декодирует H.264/AAC/HEVC через системный ffmpeg:
* Debian/Ubuntu: `sudo apt install ffmpeg libavcodec-extra`
* Fedora: включите RPM Fusion, затем `sudo dnf swap ffmpeg-free ffmpeg --allowerasing`
* Arch: `sudo pacman -S ffmpeg`
* Firefox из Flatpak: `flatpak install flathub org.freedesktop.Platform.ffmpeg-full`
  (версию ветки берите ту же, что у runtime Firefox).
* Аппаратное декодирование (нужно для HEVC): `media.ffmpeg.vaapi.enabled = true` + драйвер
  VA-API (`intel-media-driver` / `mesa-va-drivers`); проверка — `vainfo`.

**Windows**:
* Windows N/KN: установите «Пакет компонентов мультимедиа» (*Media Feature Pack*):
  Параметры → Приложения → Дополнительные компоненты.
* HEVC: «Расширения для видео HEVC» из Microsoft Store, аппаратный декодер в видеокарте и
  свежий Firefox; `media.wmf.hevc.enabled` не должен быть `0`.

**Что Firefox не воспроизводит вообще**: H.264 10 бит (High 10, часто в аниме-релизах),
AC-3/E-AC-3/DTS/TrueHD-звук, ProRes, DivX/Xvid, AVI/FLV/WMV. Такое — только во внешнем
плеере (mpv, VLC) или после перекодирования.

## Для владельцев сайтов

Правильные MIME-типы в nginx (обычно уже в `mime.types`, но проверьте свой `location`):

```nginx
types {
    video/mp4  mp4 m4v mov;
    video/webm webm mkv;
    audio/mp4  m4a;
    audio/mpeg mp3;
    audio/ogg  ogg opus;
}
```

Не ставьте `default_type application/octet-stream` для каталога с медиа и не отдавайте
медиа с `Content-Disposition: attachment`, если оно должно играть в браузере.

Совместимый со всеми браузерами файл:

```bash
# только перепаковать (быстро, если кодеки уже H.264/AAC): MKV/MOV → MP4, индекс в начало
ffmpeg -i in.mkv -c copy -movflags +faststart out.mp4
# перекодировать звук (AC-3/DTS → AAC), видео оставить
ffmpeg -i in.mkv -c:v copy -c:a aac -movflags +faststart out.mp4
# перекодировать всё (HEVC, 10 бит, ProRes, DivX → 8-битный H.264)
ffmpeg -i in.mov -c:v libx264 -pix_fmt yuv420p -crf 23 -c:a aac -movflags +faststart out.mp4
```

Если HEVC нужно оставить, давайте `<source>` с запасным H.264-вариантом:

```html
<video controls>
  <source src="clip.hevc.mp4" type='video/mp4; codecs="hvc1.1.6.L93.B0"'>
  <source src="clip.h264.mp4" type='video/mp4; codecs="avc1.640028"'>
</video>
```
