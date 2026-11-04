"""Local web UI for controlled traffic tests against the Pi DoS demo port.

Run on the Mac with: python3 demo_traffic_ui.py
Then open: http://127.0.0.1:8090
"""

from __future__ import annotations

import ipaddress
import json
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs


UI_HOST = "127.0.0.1"
UI_PORT = 8090
DEMO_PORT = 8088
DEFAULT_TARGET = "192.168.178.128"
MAX_REQUESTS = 200
MAX_WORKERS = 10
REQUEST_TIMEOUT = 3
COOLDOWN_SECONDS = 3

STATE_LOCK = threading.Lock()
STATE = {
    "running": False,
    "target": DEFAULT_TARGET,
    "requested": 0,
    "completed": 0,
    "successful": 0,
    "limited": 0,
    "failed": 0,
    "last_status": "Bereit",
    "started_at": None,
    "finished_at": None,
}
LAST_RUN_AT = 0.0


PAGE = """<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Sensor Campus · Traffic-Demo</title>
  <style>
    :root { color-scheme: dark; --bg:#09111d; --panel:#111e2f; --line:#263b54;
      --blue:#50a8ff; --green:#38d996; --red:#ff626d; --text:#eef5ff; --muted:#8da0b7; }
    * { box-sizing:border-box } body { margin:0; min-height:100vh; display:grid;
      place-items:center; padding:20px; color:var(--text); background:radial-gradient(circle at top,#142b46,var(--bg) 55%);
      font:15px/1.5 system-ui,sans-serif }
    main { width:min(760px,100%); padding:28px; border:1px solid var(--line);
      border-radius:20px; background:rgba(17,30,47,.94); box-shadow:0 24px 70px #0008 }
    header { display:flex; justify-content:space-between; gap:16px; align-items:center; margin-bottom:24px }
    h1 { margin:0; font-size:25px } header span { padding:7px 11px; border-radius:99px;
      color:var(--green); background:#153c35; font-size:12px; font-weight:700 }
    .notice { padding:12px 14px; margin-bottom:20px; border-left:3px solid var(--blue);
      color:#b9cbe0; background:#102943; border-radius:5px }
    form { display:grid; grid-template-columns:1fr 150px auto; gap:12px; align-items:end }
    label { display:grid; gap:6px; color:var(--muted); font-size:12px; font-weight:700 }
    input,button { min-height:45px; border-radius:9px; font:inherit }
    input { width:100%; padding:0 12px; border:1px solid var(--line); color:var(--text); background:#0a1523 }
    button { padding:0 18px; border:0; color:#041424; background:var(--blue); font-weight:800; cursor:pointer }
    button:disabled { opacity:.45; cursor:not-allowed }
    .grid { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-top:24px }
    .card { padding:15px; border:1px solid var(--line); border-radius:12px; background:#0c1827 }
    .card small { display:block; color:var(--muted) } .card strong { display:block; margin-top:5px; font-size:25px }
    .bar { height:9px; margin:20px 0 12px; overflow:hidden; border-radius:9px; background:#08111c }
    .bar i { display:block; width:0; height:100%; background:linear-gradient(90deg,var(--blue),var(--green)); transition:width .2s }
    #status { color:var(--muted) } .attack { color:var(--red)!important; font-weight:700 }
    .terminal { margin-top:22px; overflow:hidden; border:1px solid #31475f; border-radius:12px; background:#050b12 }
    .terminal header { margin:0; padding:9px 13px; justify-content:flex-start; color:#91a5bb;
      background:#101b29; font:700 11px ui-monospace,monospace; letter-spacing:.7px }
    .terminal pre { min-height:105px; margin:0; padding:15px; overflow:auto; color:#8ff0bd;
      font:13px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace; white-space:pre-wrap }
    footer { margin-top:20px; color:#71849b; font-size:12px }
    @media(max-width:650px) { form { grid-template-columns:1fr 1fr } form button { grid-column:1/-1 }
      .grid { grid-template-columns:1fr 1fr } main { padding:20px } }
  </style>
</head>
<body><main>
  <header><div><small>MAC · LABORWERKZEUG</small><h1>Kontrollierte Traffic-Demo</h1></div><span>Port 8088</span></header>
  <div class="notice">Nur für den eigenen Raspberry Pi im privaten Labornetz. Maximal 200 begrenzte HTTP-Testanfragen pro Durchlauf.</div>
  <form id="form">
    <label>Zieladresse des Pi<input id="target" name="target" value="192.168.178.128" required></label>
    <label>Anzahl Testanfragen<input id="count" name="count" type="number" min="1" max="200" value="100" required></label>
    <button id="start" type="submit">Test starten</button>
  </form>
  <div class="grid">
    <div class="card"><small>Gesendet</small><strong id="completed">0</strong></div>
    <div class="card"><small>HTTP 200</small><strong id="successful">0</strong></div>
    <div class="card"><small>HTTP 429</small><strong id="limited">0</strong></div>
    <div class="card"><small>Fehler</small><strong id="failed">0</strong></div>
  </div>
  <div class="bar"><i id="progress"></i></div>
  <div id="status">Bereit</div>
  <section class="terminal" aria-label="Angriffsbefehl">
    <header>ANGRIFFSBEFEHL · KONTROLLIERTE LABORDEMO</header>
    <pre id="command">$ seq 1 100 | xargs -n1 -P10 curl -s -o /dev/null http://192.168.178.128:8088/</pre>
  </section>
  <footer>Die Zieladresse muss privat oder lokal sein. Andere Ports und öffentliche Ziele werden vom Python-Dienst abgewiesen.</footer>
</main>
<script>
const form=document.querySelector('#form'), button=document.querySelector('#start');
form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;
  const body=new URLSearchParams(new FormData(form));
  const response=await fetch('/run',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
  const data=await response.json(); if(!response.ok){alert(data.error);button.disabled=false;}});
async function refresh(){try{const s=await fetch('/status',{cache:'no-store'}).then(r=>r.json());
  for(const key of ['completed','successful','limited','failed']) document.querySelector('#'+key).textContent=s[key];
  document.querySelector('#progress').style.width=(s.requested?s.completed/s.requested*100:0)+'%';
  const status=document.querySelector('#status'); status.textContent=s.last_status;
  status.className=(s.limited>0?'attack':''); button.disabled=s.running;
  const command=document.querySelector('#command');
  const target=document.querySelector('#target').value||'192.168.178.128';
  const count=document.querySelector('#count').value||'100';
  command.textContent='$ seq 1 '+count+' | xargs -n1 -P10 curl -s -o /dev/null http://'+target+':8088/';
}catch{} setTimeout(refresh,250)} refresh();
</script></body></html>"""


def validate_target(value: str) -> str:
    try:
        address = ipaddress.ip_address(value.strip())
    except ValueError as error:
        raise ValueError("Bitte eine gültige IP-Adresse eingeben") from error
    if address.is_unspecified or address.is_multicast or address.is_reserved:
        raise ValueError("Diese Zieladresse ist nicht zulässig")
    if not (address.is_private or address.is_loopback or address.is_link_local):
        raise ValueError("Nur private oder lokale Zieladressen sind erlaubt")
    return str(address)


def send_one(target: str) -> int:
    request = urllib.request.Request(
        f"http://{target}:{DEMO_PORT}/",
        headers={"User-Agent": "Sensor-Campus-Controlled-Demo/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except (OSError, urllib.error.URLError):
        return 0


def run_test(target: str, count: int) -> None:
    with STATE_LOCK:
        STATE.update({
            "running": True, "target": target, "requested": count,
            "completed": 0, "successful": 0, "limited": 0, "failed": 0,
            "last_status": f"Test läuft gegen {target}:{DEMO_PORT} …",
            "started_at": time.time(), "finished_at": None,
        })
    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, count)) as executor:
        futures = [executor.submit(send_one, target) for _ in range(count)]
        for future in as_completed(futures):
            status = future.result()
            with STATE_LOCK:
                STATE["completed"] += 1
                if status == 200:
                    STATE["successful"] += 1
                elif status == 429:
                    STATE["limited"] += 1
                else:
                    STATE["failed"] += 1
    with STATE_LOCK:
        detected = STATE["limited"] > 0
        STATE["running"] = False
        STATE["finished_at"] = time.time()
        STATE["last_status"] = (
            "Erkennung ausgelöst: Pi meldet HTTP 429."
            if detected else "Test abgeschlossen."
        )


class Handler(BaseHTTPRequestHandler):
    def send_json(self, data: dict, status: int = 200) -> None:
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        if self.path == "/":
            payload = PAGE.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        elif self.path == "/status":
            with STATE_LOCK:
                self.send_json(dict(STATE))
        else:
            self.send_error(404)

    def do_POST(self) -> None:
        global LAST_RUN_AT
        if self.path != "/run":
            self.send_error(404)
            return
        try:
            length = min(int(self.headers.get("Content-Length", "0")), 4096)
            form = parse_qs(self.rfile.read(length).decode())
            target = validate_target(form.get("target", [""])[0])
            count = int(form.get("count", ["0"])[0])
            if not 1 <= count <= MAX_REQUESTS:
                raise ValueError(f"Erlaubt sind 1 bis {MAX_REQUESTS} Testanfragen")
            with STATE_LOCK:
                if STATE["running"]:
                    raise ValueError("Es läuft bereits ein Test")
                if time.monotonic() - LAST_RUN_AT < COOLDOWN_SECONDS:
                    raise ValueError("Bitte kurz bis zum nächsten Test warten")
                LAST_RUN_AT = time.monotonic()
            threading.Thread(target=run_test, args=(target, count), daemon=True).start()
            self.send_json({"ok": True}, 202)
        except (ValueError, UnicodeError) as error:
            self.send_json({"error": str(error)}, 400)

    def log_message(self, format_string: str, *args: object) -> None:
        return


if __name__ == "__main__":
    print(f"Traffic-Demo: http://{UI_HOST}:{UI_PORT}")
    ThreadingHTTPServer((UI_HOST, UI_PORT), Handler).serve_forever()
