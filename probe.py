#!/usr/bin/env python3
"""Vision probe: can a model spot planted UI bugs in a screenshot?

Usage: python3 probe.py [baseten|meta ...]   (default: every provider with a key set)
Keys come from ./.env (BASETEN_API_KEY, META_API_KEY). Stdlib only.
"""
import base64, json, os, re, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

PROVIDERS = {
    "baseten": {"url": "https://inference.baseten.co/v1/chat/completions",
                "model": "meta-models/muse-spark-open-1026", "key": "BASETEN_API_KEY"},
    "meta": {"url": "https://api.meta.ai/v1/chat/completions",
             "model": "muse-spark-1.3", "key": "META_API_KEY"},
}

PROMPT = (
    "You are a meticulous QA engineer reviewing a screenshot of a web page. "
    "List every visual or functional defect you can see. Only report things you can "
    "actually see; do not invent problems. Reply with JSON only: "
    '{"bugs":[{"title":"...","where":"...","why_it_is_a_bug":"..."}]}'
)


def load_env():
    env = dict(os.environ)
    p = ROOT / ".env"
    if p.exists():
        for line in p.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip())
                if v.strip():
                    env[k.strip()] = v.strip()
    return env


def screenshot(page: Path, out: Path):
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--window-size=1000,640", f"--screenshot={out}", page.resolve().as_uri()],
                   check=True, capture_output=True, timeout=60)


def call(prov, key, png: Path):
    b64 = base64.b64encode(png.read_bytes()).decode()
    body = {"model": prov["model"], "max_tokens": 4000,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": PROMPT},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}]}]}
    req = urllib.request.Request(prov["url"], json.dumps(body).encode(),
                                 {"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        return None, time.time() - t0, f"HTTP {e.code}: {e.read().decode()[:500]}"
    except Exception as e:  # network, timeout
        return None, time.time() - t0, repr(e)
    return data, time.time() - t0, None


def extract_bugs(text):
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0)).get("bugs", [])
    except json.JSONDecodeError:
        return None


def score(bugs, truth):
    blobs = [" ".join(str(v) for v in b.values()).lower() for b in bugs]
    found = [t for t in truth if any(all(n in blob for n in t["need"]) for blob in blobs)]
    # a reported bug is "unmatched" if it satisfies no truth entry
    unmatched = [b for b, blob in zip(bugs, blobs)
                 if not any(all(n in blob for n in t["need"]) for t in truth)]
    return found, unmatched


def main():
    env = load_env()
    names = sys.argv[1:] or [n for n, p in PROVIDERS.items() if env.get(p["key"])]
    if not names:
        sys.exit("No keys set. Put BASETEN_API_KEY / META_API_KEY in .env")
    truth = json.loads((ROOT / "fixtures/buggy.truth.json").read_text())
    png = ROOT / "out/buggy.png"
    screenshot(ROOT / "fixtures/buggy.html", png)
    print(f"screenshot: {png} ({png.stat().st_size} bytes)")
    for n in names:
        prov = PROVIDERS[n]
        key = env.get(prov["key"])
        if not key:
            print(f"[{n}] skipped: {prov['key']} empty")
            continue
        data, secs, err = call(prov, key, png)
        if err:
            print(f"[{n}] ERROR after {secs:.1f}s: {err}")
            continue
        (ROOT / f"out/{n}.raw.json").write_text(json.dumps(data, indent=2))
        msg = data["choices"][0]["message"]
        text = msg.get("content") or ""
        bugs = extract_bugs(text)
        usage = data.get("usage", {})
        print(f"\n[{n}] {prov['model']}  {secs:.1f}s  usage={usage}")
        if bugs is None:
            print("  could not parse JSON. raw content:\n", text[:1500])
            continue
        found, unmatched = score(bugs, truth)
        print(f"  reported {len(bugs)} | planted found {len(found)}/{len(truth)} | unmatched reports {len(unmatched)}")
        for t in truth:
            print(f"   {'HIT ' if t in found else 'MISS'} {t['id']}: {t['desc']}")
        for b in unmatched:
            print(f"   ?    unmatched: {b.get('title')}  (read it: could be real or invented)")


if __name__ == "__main__":
    main()
