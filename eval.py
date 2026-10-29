#!/usr/bin/env python3
"""Repeat-run vision eval. Usage: python3 eval.py [reps=5] [provider ...]

Suites: planted-bug pages, clean control pages, and before/after state scenarios.
Scoring is keyword based and deliberately lenient; unmatched reports are listed
so a human can audit them. Raw outputs: out/eval.json. Stdlib only.
"""
import base64, collections, concurrent.futures as cf, json, sys, time, urllib.error, urllib.request
from pathlib import Path

from probe import PROVIDERS, ROOT, load_env, screenshot, extract_bugs

FX = ROOT / "fixtures"
SCHEMA = '{"bugs":[{"title":"...","where":"...","why_it_is_a_bug":"..."}]}'
STATIC_PROMPT = ("You are a meticulous QA engineer reviewing a screenshot of a web page. List every visual, "
                 "content or data defect you can see. Only report things you can actually see; do not invent "
                 f"problems, and report nothing if the page looks correct. Reply with JSON only: {SCHEMA}")
STATE_PROMPT = ("You are a meticulous QA engineer. Two screenshots of the same web app follow: BEFORE and AFTER "
                "this user action: @@ACTION@@. Report defects in how the app responded (wrong or missing updates, "
                "incorrect numbers, lost data) and any visual defect in AFTER. Only report what you can see; do "
                f"not invent problems, and report nothing if the response is correct. Reply with JSON only: {SCHEMA}")

# need: every entry must match; an entry is a substring, or a list meaning any-of.
T = lambda i, d, need: {"id": i, "desc": d, "need": need}
SUITES = [
    {"name": "checkout", "kind": "bug", "shots": [("buggy.html", "")], "truth": json.loads((FX / "buggy.truth.json").read_text())},
    {"name": "checkout_clean", "kind": "clean", "shots": [("checkout_clean.html", "")], "truth": []},
    {"name": "dash", "kind": "bug", "shots": [("dash.html", "")], "truth": [
        T("amount-align", "Amount cell for #1047 is left-aligned", [["align"], ["amount", "column", "number", "$", "price", "1047", "54.00"]]),
        T("date-format", "#1044 date uses ISO format, others use 'Oct 12, 2026'", [["date"], ["format", "inconsisten", "iso", "2026-10-12", "differ"]]),
        T("typo", "'Pending Aproval' typo", [["aproval", "typo", "misspell", "spelling"]]),
        T("currency", "#1045 amount is in euros", [["€", "euro", "currency"]]),
        T("sort-order", "Rows not newest first (Oct 15 listed before Oct 19)", [["sort", "chronolog", "newest", "out of order", "descending"], ["oct 15", "oct 19", "1045", "1046", "15", "19", "not", "out of"]]),
        T("progress", "Fulfillment says 80% but bar is ~30% filled", [["progress", "bar", "fulfil"], ["80", "fill", "30", "mismatch", "width", "doesn", "inconsist"]]),
        T("count", "Total orders says 7 but table has 6 rows", [["total orders", "order count", "orders count", "number of orders", "7 orders"], ["6", "rows", "mismatch", "doesn", "inconsisten", "seven", "six"]]),
    ]},
    {"name": "dash_clean", "kind": "clean", "shots": [("dash_clean.html", "")], "truth": []},
    {"name": "state_a", "kind": "bug", "state": 'clicked "Add to cart" on Soy candle', "truth": [
        T("badge-stale", "Cart badge still says 2 after a third item was added", [["badge", "cart (", "counter", "count", "header"], ["update", "stale", "still", "not", "mismatch", "doesn", "2"]])]},
    {"name": "state_b", "kind": "bug", "state": 'entered coupon SAVE10 and clicked Apply', "truth": [
        T("coupon-adds", "Discount was added to the total instead of subtracted", [["total", "discount"], ["66", "increase", "higher", "added", "wrong", "incorrect", "instead", "54", "up"]])]},
    {"name": "state_c", "kind": "bug", "state": 'clicked Submit with the Email field left blank', "truth": [
        T("name-wiped", "Name field was cleared by the failed submit", [["name"], ["clear", "empt", "wipe", "reset", "lost", "erased", "blank", "removed", "disappear"]])]},
    {"name": "state_d", "kind": "clean", "state": 'clicked "+" next to Canvas tote', "truth": []},
]


def b64(p): return base64.b64encode(Path(p).read_bytes()).decode()


def build_shots():
    (ROOT / "out").mkdir(exist_ok=True)
    for s in SUITES:
        if "state" in s:
            letter = s["name"][-1]
            s["images"] = []
            for phase in ("before", "after"):
                out = ROOT / f"out/{s['name']}_{phase}.png"
                screenshot_url(f"{(FX / 'state.html').resolve().as_uri()}?s={letter}&phase={phase}", out)
                s["images"].append(out)
            s["prompt"] = STATE_PROMPT.replace("@@ACTION@@", s["state"])
        else:
            out = ROOT / f"out/{s['name']}.png"
            screenshot_url((FX / s["shots"][0][0]).resolve().as_uri(), out)
            s["images"] = [out]
            s["prompt"] = STATIC_PROMPT


def screenshot_url(url, out):
    import subprocess, tempfile
    from probe import CHROME
    for attempt in range(3):  # headless Chrome exits 2 now and then; a fresh profile dir avoids lock clashes
        with tempfile.TemporaryDirectory() as prof:
            r = subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1000,700",
                                f"--user-data-dir={prof}", "--virtual-time-budget=2000", f"--screenshot={out}", url],
                               capture_output=True, timeout=90)
        if r.returncode == 0 and Path(out).exists():
            return
        time.sleep(2)
    raise RuntimeError(f"screenshot failed for {url}: {r.stderr.decode()[-300:]}")


def call(prov, key, prompt, images):
    content = [{"type": "text", "text": prompt}]
    for label, img in zip(("BEFORE", "AFTER") if len(images) == 2 else [None] * len(images), images):
        if label:
            content.append({"type": "text", "text": label + ":"})
        content.append({"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64(img)}})
    body = {"model": prov["model"], "max_tokens": 8000, "messages": [{"role": "user", "content": content}]}
    req = urllib.request.Request(prov["url"], json.dumps(body).encode(),
                                 {"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=240) as r:
                return json.load(r), None
        except urllib.error.HTTPError as e:
            msg = f"HTTP {e.code}: {e.read().decode()[:300]}"
            if e.code in (429, 500, 502, 503) and attempt < 3:
                time.sleep(3 * (attempt + 1)); continue
            return None, msg
        except Exception as e:
            if attempt < 3:
                time.sleep(3); continue
            return None, repr(e)


def blob_of(b):
    return (str(b.get("title", "")) + " " + str(b.get("why_it_is_a_bug", ""))).lower()


def matches(blob, t):
    return all((n in blob) if isinstance(n, str) else any(x in blob for x in n) for n in t["need"])


def run_one(model, suite, rep, key):
    data, err = call(PROVIDERS[model], key, suite["prompt"], suite["images"])
    rec = {"model": model, "suite": suite["name"], "rep": rep, "error": err, "bugs": None, "finish": None}
    if data:
        ch = data["choices"][0]
        rec["finish"] = ch.get("finish_reason")
        rec["bugs"] = extract_bugs(ch["message"].get("content") or "")
        u = data.get("usage", {})
        rec["pt"], rec["ct"] = u.get("prompt_tokens", 0), u.get("completion_tokens", 0)
    return rec


def main():
    args = sys.argv[1:]
    if args and args[0] == "rescore":
        res = json.loads((ROOT / "out/eval.json").read_text())
        return report(res, sorted({r["model"] for r in res}))
    reps = int(args[0]) if args and args[0].isdigit() else 5
    models = [a for a in args if a in PROVIDERS] or list(PROVIDERS)
    env = load_env()
    models = [m for m in models if env.get(PROVIDERS[m]["key"])]
    build_shots()
    jobs = [(m, s, r) for m in models for s in SUITES for r in range(reps)]
    print(f"{len(jobs)} calls, models={models}, reps={reps}", flush=True)
    results = []
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        futs = [ex.submit(run_one, m, s, r, env[PROVIDERS[m]["key"]]) for m, s, r in jobs]
        for i, f in enumerate(cf.as_completed(futs), 1):
            results.append(f.result())
            if i % 10 == 0:
                print(f"  {i}/{len(jobs)}", flush=True)
    (ROOT / "out/eval.json").write_text(json.dumps(results, indent=1))
    report(results, models)


def report(results, models):
    by = collections.defaultdict(list)
    for r in results:
        by[(r["model"], r["suite"])].append(r)
    for m in models:
        print(f"\n=== {PROVIDERS[m]['model']} ===")
        print(f"{'suite':16}{'planted found':>16}{'reports':>9}{'unmatched':>11}{'runs w/ FP':>12}{'bad calls':>11}")
        tot_hit = tot_poss = clean_runs = clean_fp_runs = clean_reports = 0
        unmatched_titles = collections.Counter()
        for s in SUITES:
            runs = by[(m, s["name"])]
            ok = [r for r in runs if r["bugs"] is not None]
            bad = len(runs) - len(ok)
            hit = unm = nrep = fp_runs = 0
            for r in ok:
                blobs = [blob_of(b) for b in r["bugs"]]
                found = [t for t in s["truth"] if any(matches(b, t) for b in blobs)]
                un = [(b, bl) for b, bl in zip(r["bugs"], blobs) if not any(matches(bl, t) for t in s["truth"])]
                hit += len(found); nrep += len(r["bugs"]); unm += len(un); fp_runs += bool(un)
                for b, _ in un:
                    unmatched_titles[(s["name"], str(b.get("title"))[:90])] += 1
            poss = len(s["truth"]) * len(ok)
            tot_hit += hit; tot_poss += poss
            if s["kind"] == "clean":
                clean_runs += len(ok); clean_fp_runs += fp_runs; clean_reports += nrep
            found_s = f"{hit}/{poss}" if poss else "n/a"
            print(f"{s['name']:16}{found_s:>16}{nrep:>9}{unm:>11}{fp_runs:>6}/{len(ok):<5}{bad:>11}")
        mine = [r for r in results if r["model"] == m]
        pt, ct = sum(r.get("pt", 0) for r in mine), sum(r.get("ct", 0) for r in mine)
        est = f" (~${pt * 1.25e-6 + ct * 4.25e-6:.2f} at $1.25/$4.25 per M, third-party price, unverified)" if m == "meta" else ""
        print(f"TOKENS USED: {len(mine)} calls, {pt:,} prompt + {ct:,} completion{est}")
        print(f"HIT RATE (bug suites): {tot_hit}/{tot_poss} = {100 * tot_hit / max(tot_poss, 1):.0f}%")
        print(f"CLEAN PAGES: {clean_fp_runs}/{clean_runs} runs invented something ({clean_reports} reports)")
        print("Unmatched reports (audit these):")
        for (suite, title), n in unmatched_titles.most_common(25):
            print(f"  x{n} [{suite}] {title}")


if __name__ == "__main__":
    main()
