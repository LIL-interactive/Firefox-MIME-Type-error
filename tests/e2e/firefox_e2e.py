"""Сквозной тест встроенного декодера в настоящем Firefox.

Firefox запускается с media.ffmpeg.enabled=false — так у него нет ни HEVC, ни H.264
(как у Firefox без системных кодеков), и видео обязано проиграться через расширение.

  pip install selenium
  python3 tests/e2e/firefox_e2e.py --firefox /path/to/firefox --geckodriver /path/to/geckodriver

Тестовые ролики делает ffmpeg (нужен в PATH), сайт поднимается на 127.0.0.1:8811.
"""
import argparse, json, os, subprocess, sys, tempfile, threading, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

EXT = os.path.join(os.path.dirname(__file__), '..', '..', 'extension')
SRC = '-f lavfi -i testsrc2=size=1280x720:rate=25 -f lavfi -i sine=f=440 -t {t}'
CLIPS = {
    'hevc.mp4': '-c:v libx265 -tag:v hvc1 -x265-params log-level=none -preset ultrafast -b:v 2M -c:a aac -movflags +faststart',
    'hevc_moovend.mp4': '-c:v libx265 -tag:v hvc1 -x265-params log-level=none -preset ultrafast -b:v 2M -c:a aac',
    'hevc_ac3.mkv': '-c:v libx265 -x265-params log-level=none -preset ultrafast -b:v 2M -c:a ac3',
}
CASES = [  # (страница, что проверяем)
    ('page:hevc.mp4', 'play'), ('page:hevc.mp4', 'seek'), ('file:hevc.mp4', 'play'),
    ('page:hevc_moovend.mp4', 'play'), ('page:hevc_ac3.mkv', 'play'), ('csp:hevc.mp4', 'play'),
]


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def handle(self):
        try: super().handle()
        except (ConnectionResetError, BrokenPipeError): pass  # браузер оборвал скачивание — норма


def make_site(root):
    for name, enc in CLIPS.items():
        subprocess.run(f'ffmpeg -hide_banner -loglevel error -y {SRC.format(t=40)} {enc} {name}',
                       shell=True, check=True, cwd=root)
    for name in CLIPS:
        with open(os.path.join(root, f'page_{name}.html'), 'w') as f:
            f.write(f'<!doctype html><meta charset="utf-8"><video controls width="640" height="360" src="{name}"></video>')
        with open(os.path.join(root, f'csp_{name}.html'), 'w') as f:
            f.write('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" '
                    "content=\"default-src 'self'; frame-src 'none'\">"
                    f'<video controls width="640" height="360" src="{name}"></video>')


def state(d):
    return d.execute_script("""const v=document.getElementById('v');
      return {t:v.currentTime, err: document.getElementById('err').hidden ? null : document.getElementById('err-text').textContent,
              st: document.getElementById('st-text').textContent}""")


def run_case(args, url, mode):
    o = Options(); o.binary_location = args.firefox; o.add_argument('-headless')
    o.set_preference('media.ffmpeg.enabled', False)
    o.set_preference('media.autoplay.default', 0)
    d = webdriver.Firefox(options=o, service=Service(args.geckodriver))
    try:
        d.install_addon(os.path.abspath(EXT), temporary=True)
        d.get(url)
        frame = None
        for _ in range(60):
            frames = d.find_elements(By.CSS_SELECTOR, 'iframe')
            if frames: frame = frames[0]; break
            time.sleep(0.5)
        if not frame: return 'проигрыватель не появился'
        d.switch_to.frame(frame)
        go = d.find_elements(By.ID, 'go')
        if go and go[0].is_displayed(): go[0].click()
        seeked, target = False, (25 if mode == 'seek' else 6)
        for _ in range(120):
            s = state(d)
            if s['err']: return 'ошибка: ' + s['err']
            if mode == 'seek' and not seeked and s['t'] > 1:
                d.execute_script("document.getElementById('v').currentTime = 22"); seeked = True
            if s['t'] > target: return None
            time.sleep(1)
        return 'не дошло до %ss: %s' % (target, json.dumps(s, ensure_ascii=False))
    finally:
        d.quit()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--firefox', required=True); ap.add_argument('--geckodriver', required=True)
    args = ap.parse_args()
    root = tempfile.mkdtemp()
    make_site(root)
    srv = ThreadingHTTPServer(('127.0.0.1', 8811), partial(Quiet, directory=root))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    fails = 0
    for page, mode in CASES:
        kind, name = page.split(':')
        url = f'http://127.0.0.1:8811/{name}' if kind == 'file' else f'http://127.0.0.1:8811/{kind}_{name}.html'
        t = time.time(); err = run_case(args, url, mode)
        print(('ok  ' if not err else 'FAIL'), f'{page} {mode} ({time.time() - t:.0f} с)', err or '', flush=True)
        fails += bool(err)
    srv.shutdown()
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
