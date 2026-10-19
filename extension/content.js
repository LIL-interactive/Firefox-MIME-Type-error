/*
 * content.js — ловит видео/аудио, которое Firefox не смог воспроизвести
 * («Видео в поддерживаемом формате и MIME-типе не найдено» /
 * «No video with supported format and MIME type found»), выясняет причину
 * через фоновый скрипт и показывает карточку с объяснением и действиями.
 */
(() => {
  'use strict';
  if (window.__lcMimeFix) return;
  window.__lcMimeFix = true;

  const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;
  const NETWORK_NO_SOURCE = 3;
  const reported = new WeakSet();
  const reportedUrls = new Set();
  let cfg = { overlay: true, decoder: 'auto' };
  let enabled = true;
  browser.runtime.sendMessage({ type: 'config' }).then((c) => { cfg = c; enabled = c.overlay !== false || c.decoder === 'auto'; }, () => {});
  browser.storage.onChanged.addListener((ch) => {
    for (const [k, { newValue }] of Object.entries(ch)) cfg[k] = newValue;
    enabled = cfg.overlay !== false || cfg.decoder === 'auto';
  });
  const IS_WIN = /Win/.test(navigator.platform || '');
  const IS_LINUX = /Linux/.test(navigator.platform || '') && !/Android/.test(navigator.userAgent);

  // ── Обнаружение ошибки ──────────────────────────────────────────────────
  function isWorthReporting(el) {
    if (document.body && document.body.childElementCount === 1 && document.body.firstElementChild === el) return true; // открыт сам файл
    if (el instanceof HTMLVideoElement) {
      const r = el.getBoundingClientRect();
      return el.controls || el.autoplay || (r.width >= 80 && r.height >= 60);
    }
    return el.controls; // беззвучные служебные <audio> не трогаем
  }

  function sourcesOf(el) {
    const list = [];
    if (el.getAttribute('src')) list.push({ url: el.src, type: '' });
    for (const s of el.querySelectorAll('source')) if (s.src) list.push({ url: s.src, type: s.type || '' });
    if (el.currentSrc && !list.some((x) => x.url === el.currentSrc)) list.unshift({ url: el.currentSrc, type: '' });
    return list;
  }

  function check(el) {
    if (!enabled || reported.has(el) || !isWorthReporting(el)) return;
    const failed = (el.error && el.error.code === MEDIA_ERR_SRC_NOT_SUPPORTED) || el.networkState === NETWORK_NO_SOURCE;
    if (!failed) return;
    const srcs = sourcesOf(el);
    if (!srcs.length) return;
    const key = srcs.map((s) => s.url).join(' ');
    if (reportedUrls.has(key)) return;
    reported.add(el); reportedUrls.add(key);
    report(el, srcs);
  }

  document.addEventListener('error', (e) => {
    const t = e.target;
    if (t instanceof HTMLMediaElement) check(t);
    else if (t instanceof HTMLSourceElement && t.parentElement instanceof HTMLMediaElement) {
      // Ошибка одного <source> ещё не провал: браузер пробует следующий.
      const p = t.parentElement;
      setTimeout(() => check(p), 100);
    }
  }, true);
  const scan = () => document.querySelectorAll('video, audio').forEach(check);
  document.addEventListener('DOMContentLoaded', scan);
  window.addEventListener('load', () => setTimeout(scan, 500));

  // ── Вердикт ─────────────────────────────────────────────────────────────
  const probeEl = document.createElement('video');
  function support(mime, rfc) {
    if (!mime) return '';
    const t = rfc ? `${mime}; codecs="${rfc}"` : mime;
    let v = probeEl.canPlayType(t);
    try { if (!v && window.MediaSource && MediaSource.isTypeSupported(t)) v = 'maybe'; } catch (_) {}
    return v;
  }

  const CMD_REENCODE = 'ffmpeg -i ВХОД -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart ВЫХОД.mp4';
  const CMD_REMUX = 'ffmpeg -i ВХОД -c copy -movflags +faststart ВЫХОД.mp4';
  const CMD_AUDIO = 'ffmpeg -i ВХОД -c:v copy -c:a aac -movflags +faststart ВЫХОД.mp4';

  function adviceFor(codec) {
    const os = navigator.platform || '';
    const win = /Win/.test(os), lin = /Linux/.test(os);
    switch (codec.name) {
      case 'H.265 (HEVC)':
        return [
          'Своего декодера HEVC в Firefox нет: он берёт его у системы, и только аппаратный.',
          win ? 'Windows: нужны Firefox 134 или новее, бесплатное «Расширение для видео HEVC от производителя устройства» (кнопка ниже) и видеокарта с аппаратным HEVC (примерно с 2016 года: Intel 6-го поколения, NVIDIA GTX 950, AMD RX 400). После установки перезапустите Firefox.' : '',
          lin ? 'Linux: нужен системный ffmpeg (libavcodec) с HEVC и аппаратное декодирование через VA-API (media.ffmpeg.vaapi.enabled = true).' : '',
          'Без этого видео проигрывает встроенный декодер расширения.',
        ];
      case 'H.264 (AVC)':
        if (codec.profile && /10|4:2:2|4:4:4/.test(codec.profile)) {
          return [`Профиль ${codec.profile}: Firefox не воспроизводит H.264 с глубиной цвета больше 8 бит или с субдискретизацией, отличной от 4:2:0.`,
            'Откройте файл в mpv или VLC. Владельцу сайта: перекодировать в 8-битный H.264 (yuv420p).'];
        }
        return ['H.264 у Firefox декодирует система, а не сам браузер.',
          win ? 'Windows N/KN: установите «Пакет компонентов мультимедиа» (Media Feature Pack).' : '',
          lin ? 'Linux: установите ffmpeg/libavcodec (пакеты ffmpeg, libavcodec-extra). Для Firefox из Flatpak нужен org.freedesktop.Platform.ffmpeg-full; из Snap — переустановите snap с актуальной версией.' : '',
          'Проверьте в about:config: media.ffmpeg.enabled и media.mp4.enabled должны быть true.'];
      case 'AV1':
        return ['Проверьте в about:config: media.av1.enabled = true. На очень старых процессорах AV1 может не декодироваться.'];
      case 'VP9': case 'VP8': case 'Opus': case 'Vorbis':
        return ['Проверьте в about:config: media.webm.enabled = true (и media.av1.enabled / media.ffvpx.enabled не выключены).'];
      case 'AAC':
        return ['AAC в Firefox тоже декодирует система: см. совет про H.264 (ffmpeg на Linux, Media Feature Pack на Windows N).'];
      case 'Dolby Digital (AC-3)': case 'Dolby Digital Plus (E-AC-3)': case 'DTS': case 'Dolby TrueHD':
        return [`Звук ${codec.name} браузеры почти не поддерживают. Владельцу сайта: перекодировать только звук — ${CMD_AUDIO}`];
      default:
        return [`${codec.name} браузер не воспроизводит. Откройте файл в mpv или VLC, а владельцу сайта стоит перекодировать: ${CMD_REENCODE}`];
    }
  }

  function verdict(p, declared) {
    const lines = [], tips = [], facts = [];
    let v_fixable = false, v_bad = [];
    const result = () => ({ lines, tips, facts, fixable: v_fixable && !p.drm, bad: v_bad });
    if (p.error === 'network') {
      lines.push('Не удалось скачать файл для проверки: ' + (p.message || 'ошибка сети') + '.');
      tips.push('Возможно, сервер недоступен, ссылка устарела или файл защищён от прямых ссылок.');
      return result();
    }
    facts.push(['HTTP', String(p.http)]);
    facts.push(['Content-Type', p.contentType || '(не указан)']);
    if (p.size) facts.push(['Размер', (p.size / 1048576).toFixed(1) + ' МБ']);
    if (p.error === 'http') {
      lines.push(`Сервер ответил ошибкой HTTP ${p.http} — файла по этой ссылке нет или доступ запрещён.`);
      tips.push('Это проблема сайта, а не браузера: видео удалено, требует входа или защищено от хотлинка (Referer).');
      return result();
    }
    const CNAME = { mp4: p.brand === 'qt' ? 'QuickTime (MOV)' : 'MP4', matroska: p.docType === 'webm' ? 'WebM' : 'Matroska (MKV)',
      ogg: 'Ogg', flac: 'FLAC', wav: 'WAV', mp3: 'MP3', aac: 'AAC (ADTS)', avi: 'AVI', flv: 'Flash Video (FLV)',
      asf: 'Windows Media (WMV/ASF)', mpegts: 'MPEG-TS', hls: 'HLS-плейлист (m3u8)', text: 'текст/HTML', empty: 'пусто', unknown: 'неизвестно' };
    facts.push(['Контейнер', CNAME[p.container] || p.container]);

    switch (p.container) {
      case 'empty':
        lines.push('Сервер вернул пустой ответ вместо видео.'); return result();
      case 'text':
        lines.push('Вместо видео сервер прислал веб-страницу или текст (обычно — страницу ошибки, капчу или защиту от хотлинка).');
        if (p.textSample) tips.push('Начало ответа: ' + p.textSample.replace(/\s+/g, ' ').slice(0, 160));
        return result();
      case 'hls':
        lines.push('Это HLS-плейлист (.m3u8). Firefox не проигрывает HLS сам — это делает плеер сайта (hls.js и т.п.).');
        tips.push('Откройте ссылку в mpv/VLC или отключите блокировщик, если он мешает скриптам плеера.');
        return result();
      case 'avi': case 'flv': case 'asf': case 'mpegts': case 'unknown':
        v_fixable = p.container !== 'unknown';
        lines.push(`Контейнер «${CNAME[p.container]}» Firefox не поддерживает.`);
        tips.push('Откройте файл в mpv или VLC. Владельцу сайта — перепаковать в MP4: ' + CMD_REMUX + ' (если кодеки несовместимы — ' + CMD_REENCODE + ').');
        return result();
      default: break;
    }

    if (p.drm) {
      lines.push('Видео зашифровано (DRM).');
      tips.push('Включите «Воспроизводить содержимое, защищённое DRM» в Настройках → Основные (about:config: media.eme.enabled = true) и дождитесь установки модуля Widevine.');
    }

    const bad = [];
    for (const c of p.codecs || []) {
      if (c.kind !== 'video' && c.kind !== 'audio') continue;
      const s = c.rfc ? support(p.mime, c.rfc) : '';
      facts.push([c.kind === 'video' ? 'Видео' : 'Звук', c.name + (c.profile ? ' ' + c.profile : '') + (s ? ' — поддерживается' : ' — НЕ поддерживается')]);
      if (!s) bad.push(c);
    }
    if (p.moovAtEnd) facts.push(['Индекс (moov)', 'в конце файла']);

    if (bad.length) {
      v_fixable = true; v_bad = bad;
      lines.push('Firefox не умеет декодировать: ' + bad.map((c) => c.name + (c.profile ? ' ' + c.profile : '')).join(', ') + '.');
      for (const c of bad) {
        // H.264/HEVC/AAC внутри MKV: кодек Firefox знает, мешает контейнер.
        if (p.container === 'matroska' && c.rfc && support('video/mp4', c.rfc)) {
          tips.push(`${c.name} Firefox поддерживает, но не внутри MKV — проигрывает встроенный декодер. Владельцу сайта стоит перепаковать без перекодирования: ${CMD_REMUX}`);
        } else tips.push(...adviceFor(c).filter(Boolean));
      }
    } else if (!p.codecs || !p.codecs.length) {
      // Индекс в конце файла, а сервер не отдаёт части файла — заголовки не прочитать.
      // Встроенный декодер читает файл целиком, так что пусть попробует он.
      v_fixable = p.container === 'mp4' || p.container === 'matroska';
      lines.push(p.moovAtEnd && !p.ranged
        ? 'Кодек прочитать не удалось: сведения о дорожках в конце файла, а сервер не отдаёт файл частями.'
        : 'Не удалось определить кодеки — файл повреждён или обрезан.');
      if (p.moovAtEnd && !p.ranged) tips.push('Индекс файла в конце, а сервер не поддерживает частичную загрузку (Range) — браузер не может его прочитать. Владельцу сайта: ' + CMD_REMUX);
    } else {
      const ct = (p.contentType || '').split(';')[0].trim().toLowerCase();
      const okType = ct === p.mime || (ct.startsWith('video/') && ['video/mp4', 'video/webm', 'video/ogg'].includes(ct));
      const declaredBad = declared && declared.some((t) => t && !probeEl.canPlayType(t));
      if (!okType) {
        lines.push(`Файл в порядке, но сервер отдаёт его с неверным типом «${ct || 'не указан'}» вместо ${p.mime}.`);
        tips.push('Расширение исправляет такие заголовки (если включено) — нажмите «Повторить». Владельцу сайта: прописать правильный MIME-тип (nginx: types { video/mp4 mp4; video/webm webm; }).');
      } else if (declaredBad) {
        lines.push('Файл в порядке, но страница описала его неподдерживаемым типом в атрибуте type: ' + declared.filter(Boolean).join(', ') + '.');
        tips.push('Скачайте файл или скопируйте ссылку и откройте её напрямую — так Firefox его воспроизведёт.');
      } else {
        lines.push('Формат файла Firefox поддерживает. Вероятно, ошибка временная или файл повреждён в середине.');
        tips.push('Нажмите «Повторить». Если не помогло — откройте ссылку напрямую или в mpv/VLC.');
      }
      if (p.mime === 'video/webm' && p.docType === 'matroska') {
        tips.push('Это MKV. Firefox воспроизводит его, только если внутри кодеки WebM (VP8/VP9/AV1 + Opus/Vorbis); иначе файл нужно перепаковать в MP4.');
      }
    }
    return result();
  }

  // ── Карточка ────────────────────────────────────────────────────────────
  let host, stack;
  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('lc-mime-fix');
    host.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const st = document.createElement('style');
    st.textContent = CSS;
    stack = document.createElement('div');
    stack.className = 'stack';
    root.append(st, stack);
    (document.body || document.documentElement).appendChild(host);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function button(label, fn, primary) {
    const b = el('button', primary ? 'btn btn--primary' : 'btn', label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  function report(media, srcs) {
    ensureHost();
    while (stack.childElementCount >= 3) stack.firstElementChild.remove();
    const target = srcs.find((s) => /^https?:/.test(s.url)) || srcs[0];
    const isVideo = media instanceof HTMLVideoElement;

    const card = el('section', 'card');
    card.setAttribute('role', 'alert');
    const head = el('div', 'head');
    head.append(el('strong', 'title', isVideo ? 'Видео не воспроизводится' : 'Аудио не воспроизводится'));
    const close = button('×', () => card.remove());
    close.className = 'x'; close.setAttribute('aria-label', 'Закрыть');
    head.append(close);
    const body = el('div', 'body');
    const status = el('p', 'muted', 'Проверяю файл…');
    body.append(status);
    const url = el('div', 'url', target.url);
    url.title = target.url;
    const acts = el('div', 'acts');
    const retryBtn = button('Повторить', () => { try { media.load(); media.play().catch(() => {}); } catch (_) {} card.remove(); reported.delete(media); reportedUrls.clear(); }, true);
    retryBtn.dataset.orig = '1';
    acts.append(
      retryBtn,
      button('Показать', () => media.scrollIntoView({ block: 'center', behavior: 'smooth' })),
    );
    if (/^https?:/.test(target.url)) {
      acts.append(
        button('Скачать', () => browser.runtime.sendMessage({ type: 'download', url: target.url })),
        button('Копировать ссылку', (e) => {
          navigator.clipboard.writeText(target.url).then(() => { e.target.textContent = 'Скопировано'; }, () => {});
        }),
      );
    }
    card.append(head, body, url, acts);
    stack.append(card);

    if (!/^https?:/.test(target.url)) {
      status.textContent = target.url.startsWith('blob:')
        ? 'Видео подаёт плеер сайта (MediaSource), поэтому файл проверить нельзя. Обычно причина — кодек, которого Firefox не поддерживает (чаще всего HEVC). Таблица поддержки — во всплывающем окне расширения.'
        : 'Источник видео не является ссылкой — проверить его нельзя.';
      return;
    }
    browser.runtime.sendMessage({ type: 'probe', url: target.url }).then((p) => {
      const v = verdict(p, srcs.map((s) => s.type));
      status.remove();
      const useDecoder = v.fixable && cfg.decoder !== 'off';
      if (useDecoder && cfg.decoder === 'auto') {
        startDecoder(media, target.url, p, card);
        card.querySelector('.title').textContent = 'Включён встроенный декодер';
        card.setAttribute('role', 'status');
        body.append(el('p', 'lead', v.lines[0] + ' Видео проигрывает встроенный декодер расширения.'));
      } else for (const l of v.lines) body.append(el('p', 'lead', l));
      if (useDecoder && cfg.decoder !== 'auto') {
        acts.prepend(button('Воспроизвести встроенным декодером', (e) => { e.target.remove(); startDecoder(media, target.url, p, card); }, true));
      }
      // Системный кодек — единственное, что расширение поставить само не может: ведём в Microsoft Store.
      if (IS_WIN && v.bad.some((c) => c.name === 'H.265 (HEVC)')) {
        acts.append(button('Установить кодек HEVC (Microsoft Store)', () => browser.runtime.sendMessage({ type: 'openStore', what: 'hevc' })));
      }
      if (IS_WIN && v.bad.some((c) => c.name === 'H.264 (AVC)' && !/10|4:2:2|4:4:4/.test(c.profile || ''))) {
        acts.append(button('Установить Media Feature Pack', () => browser.runtime.sendMessage({ type: 'openStore', what: 'mfp' })));
      }
      if (v.tips.length) {
        const det = el('details');
        det.append(el('summary', null, useDecoder ? 'Как включить системный декодер' : 'Что делать'));
        const ul = el('ul', 'tips');
        for (const t of [...new Set(v.tips)]) ul.append(el('li', null, t));
        det.append(ul);
        if (!useDecoder) det.open = true;
        body.append(det);
      }
      if (v.facts.length) {
        const det = el('details');
        det.append(el('summary', null, 'Подробности'));
        const dl = el('dl');
        for (const [k, val] of v.facts) dl.append(el('dt', null, k), el('dd', null, val));
        det.append(dl);
        body.append(det);
      }
      if (useDecoder && cfg.decoder === 'auto') autoHide(card);
    }, (e) => { status.textContent = 'Не удалось проверить файл: ' + e; });
  }

  // Карточка про автоматически включённый декодер не должна висеть вечно.
  function autoHide(card) {
    let t = setTimeout(() => card.remove(), 12000);
    card.addEventListener('mouseenter', () => clearTimeout(t));
    card.addEventListener('focusin', () => clearTimeout(t));
    card.addEventListener('mouseleave', () => { t = setTimeout(() => card.remove(), 6000); });
  }

  // ── Встроенный декодер ─────────────────────────────────────────────────
  // Вместо «сломанного» <video> показываем проигрыватель расширения (player.html)
  // в iframe того же размера. Исходный элемент прячем, а не удаляем — «Вернуть
  // как было» возвращает страницу в исходное состояние.
  const isMediaDocument = () => /^(video|audio)\//.test(document.contentType || '');

  async function startDecoder(media, url, probe, card) {
    if (media.__lcDecoder) return;
    const token = await browser.runtime.sendMessage({
      type: 'register', url, probe, title: document.title || '',
      loop: media.loop, muted: media.muted, autoplay: media.autoplay || isMediaDocument(),
    });
    const frame = document.createElement('iframe');
    frame.src = browser.runtime.getURL('player.html') + '#' + token;
    frame.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
    frame.setAttribute('allowfullscreen', '');
    frame.title = 'Встроенный декодер Video MIME Fix';
    if (isMediaDocument()) {
      frame.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0;margin:0;z-index:2147483646;background:#000';
      (document.body || document.documentElement).appendChild(frame);
    } else {
      const r = media.getBoundingClientRect();
      const cs = getComputedStyle(media);
      const parentW = media.parentElement ? media.parentElement.getBoundingClientRect().width : 0;
      const w = r.width > 0 ? (parentW && Math.abs(parentW - r.width) < 2 ? '100%' : r.width + 'px') : '640px';
      const h = r.height > 30 ? r.height + 'px' : (media instanceof HTMLAudioElement ? '120px' : '360px');
      frame.style.cssText = `display:block;border:0;width:${w};height:${h};max-width:100%;background:#000;`;
      if (cs.position === 'absolute' || cs.position === 'fixed') {
        for (const k of ['position', 'top', 'left', 'right', 'bottom', 'zIndex']) frame.style[k] = cs[k];
      }
      media.insertAdjacentElement('afterend', frame);
    }
    const prevDisplay = media.style.display;
    try { media.pause(); } catch (_) {}
    media.style.display = 'none';
    media.__lcDecoder = frame;

    if (card) {
      const acts = card.querySelector('.acts');
      acts.querySelectorAll('[data-orig]').forEach((b) => b.remove());
      const tab = button('Открыть во вкладке', () => browser.runtime.sendMessage({ type: 'openTab', token }));
      const undo = button('Вернуть как было', () => {
        frame.remove(); media.style.display = prevDisplay; media.__lcDecoder = null; undo.remove();
      });
      acts.prepend(tab, undo);
      // Страница может запретить чужие iframe (CSP frame-src) — тогда остаётся вкладка.
      let ok = false;
      frame.addEventListener('load', () => { ok = true; });
      setTimeout(() => {
        if (ok) return;
        frame.remove(); media.style.display = prevDisplay; media.__lcDecoder = null; undo.remove();
        const lead = card.querySelector('.lead');
        if (lead) lead.textContent = 'Сайт не разрешает встроить проигрыватель на страницу — откройте видео во вкладке.';
        tab.className = 'btn btn--primary';
      }, 5000);
    }
  }

  const CSS = `
    :host { --bg:#fff; --fg:#1f2328; --muted:#59636e; --line:#d1d9e0; --accent:#0969da; --accent-fg:#fff; --code:#f6f8fa; }
    @media (prefers-color-scheme: dark) { :host { --bg:#1c2128; --fg:#e6edf3; --muted:#9198a1; --line:#3d444d; --accent:#4493f8; --accent-fg:#0d1117; --code:#262c36; } }
    .stack { display:flex; flex-direction:column; gap:8px; width:min(420px, calc(100vw - 24px)); max-height:calc(100vh - 24px); overflow:auto; }
    .card { background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,.25);
            font:13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; padding:12px 14px; }
    .head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px; }
    .title { font-size:14px; }
    .x { all:unset; cursor:pointer; font-size:20px; line-height:1; width:28px; height:28px; text-align:center; border-radius:6px; color:var(--muted); }
    .x:hover, .x:focus-visible { background:var(--code); color:var(--fg); }
    p { margin:4px 0; } .muted { color:var(--muted); } .lead { font-weight:600; }
    .tips { margin:6px 0; padding-left:18px; } .tips li { margin:3px 0; word-break:break-word; }
    details { margin-top:6px; } summary { cursor:pointer; color:var(--muted); }
    dl { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; margin:6px 0 0; }
    dt { color:var(--muted); } dd { margin:0; word-break:break-word; }
    .url { margin:8px 0; padding:4px 6px; background:var(--code); border-radius:6px; font:11px/1.4 ui-monospace, monospace;
           white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--muted); }
    .acts { display:flex; flex-wrap:wrap; gap:6px; }
    .btn { all:unset; cursor:pointer; padding:6px 10px; border:1px solid var(--line); border-radius:6px; font-size:12px; }
    .btn:hover { background:var(--code); }
    .btn--primary { background:var(--accent); color:var(--accent-fg); border-color:var(--accent); }
    .btn--primary:hover { filter:brightness(1.08); background:var(--accent); }
    .btn:focus-visible, .x:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  `;
})();
