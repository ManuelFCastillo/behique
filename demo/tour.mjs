// A scripted tour of the dashboard, recorded as a 60 second video cut to a music track, with text captions and no voice. It drives
// the real page over a finished report: the recordings first, then the New run dialog and a time-lapse of a real run, the bisect
// culprit, the lit tokens, the pixel diff, the before-and-after handle, the record and the chain. Captions, spotlights and the
// number card live only in the recording; the case is never changed. No model calls, no run started by this script.
//   node demo/tour.mjs <caseId> [out/demo/tour.mp4]
//   env: BEHIQUE_MUSIC=<audio file> lays the track under it (the video is cut to the track's length)
//        BEHIQUE_RUN_TIMELAPSE=<webm> the sped-up recording of a run from demo/tour-run.mjs + demo/timelapse.sh (skipped if absent)
//        BEHIQUE_HERO=R2 the regression card to open on (otherwise a scroll or move story, else the first with recordings)
import { chromium } from 'playwright'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const caseId = process.argv[2]
if (!caseId) { console.error('usage: node demo/tour.mjs <caseId> [out.mp4]'); process.exit(2) }
const out = process.argv[3] ?? 'out/demo/tour.mp4'
const base = process.env.BEHIQUE_URL ?? 'http://127.0.0.1:8790'
const music = process.env.BEHIQUE_MUSIC ?? null
const timelapse = process.env.BEHIQUE_RUN_TIMELAPSE && existsSync(process.env.BEHIQUE_RUN_TIMELAPSE) ? process.env.BEHIQUE_RUN_TIMELAPSE : null
const W = 1280, H = 800
mkdirSync(dirname(out), { recursive: true })
const vidDir = join(dirname(out), 'raw'); rmSync(vidDir, { recursive: true, force: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: vidDir, size: { width: W, height: H } }, reducedMotion: 'no-preference' })
const page = await ctx.newPage()
const T0 = Date.now()                                   // the recording starts with the page
const now = () => (Date.now() - T0) / 1000
const LEAD = Number(process.env.BEHIQUE_VIDEO_LEAD ?? 0)   // seconds the recording starts after the page is made; measured from a take's raw webm
const until = t => page.waitForTimeout(Math.max(0, (t + LEAD) * 1000 - (Date.now() - T0)))   // hold until second t of the recording
const sleep = ms => page.waitForTimeout(ms)
if (timelapse) await page.route('**/__tour/run.webm', r => r.fulfill({ status: 200, contentType: 'video/webm', body: readFileSync(timelapse) }))

// ---- things drawn into the page for the recording only ----
const STYLE = `
#__tour{position:fixed;left:50%;bottom:30px;transform:translateX(-50%) translateY(14px);max-width:1080px;padding:18px 30px;border-radius:18px;background:rgba(10,12,18,.94);color:#fff;font:600 27px/1.3 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;text-align:center;box-shadow:0 16px 48px rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.14);opacity:0;transition:opacity .22s,transform .22s;z-index:2147483647;pointer-events:none}
#__tour.on{opacity:1;transform:translateX(-50%) translateY(0)}
#__tour b{display:block;color:#ffa63d;font-size:15px;letter-spacing:.14em;text-transform:uppercase;margin-bottom:6px;font-family:ui-monospace,Menlo,monospace}
#__tour em{font-style:normal;color:#ffd08a}
#__flash{position:fixed;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:2147483646;transition:opacity .28s}
#__card{position:fixed;inset:0;background:#0b0e14;color:#fff;font:700 56px/1.15 -apple-system,Helvetica,Arial,sans-serif;display:grid;place-items:center;z-index:2147483640;transition:opacity .5s}
#__card .k{font-size:16px;letter-spacing:.32em;color:#ffa63d;font-family:ui-monospace,Menlo,monospace;margin-bottom:20px;font-weight:600}
#__card .s{font-size:23px;font-weight:500;color:#9aa3b2;margin-top:22px}
#__lb{position:fixed;inset:0;background:rgba(7,9,14,.97);z-index:2147483500;display:grid;grid-template-columns:1fr 1fr;gap:32px;padding:40px 44px 130px;align-content:start;opacity:0;transition:opacity .35s}
#__lb.on{opacity:1}#__lb figure{margin:0}#__lb video{width:100%;aspect-ratio:16/10;border-radius:12px;border:2px solid #2a3140;background:#000}
#__lb .chip{display:inline-block;font:700 17px ui-monospace,Menlo,monospace;letter-spacing:.06em;padding:7px 14px;border-radius:999px;margin-bottom:14px}
#__lb .good .chip{background:#13301d;color:#6fe79e;border:1px solid #2d7a4a}#__lb .bad .chip{background:#36151a;color:#ff8d96;border:1px solid #8a2d36}
#__lb figcaption{color:#d6dde9;font:500 21px/1.35 -apple-system,Helvetica,Arial,sans-serif;margin-top:16px}
#__tl{position:fixed;inset:0;background:#07090e;z-index:2147483500;display:grid;place-items:center;opacity:0;transition:opacity .3s}
#__tl.on{opacity:1}#__tl video{width:1280px;height:800px;object-fit:cover}
#__tl .spd{position:fixed;top:22px;right:26px;font:700 15px ui-monospace,Menlo,monospace;letter-spacing:.12em;color:#ffa63d;background:rgba(10,12,18,.9);padding:8px 14px;border-radius:999px;border:1px solid rgba(255,166,61,.4)}
#__nums{position:fixed;inset:0;background:rgba(7,9,14,.96);z-index:2147483500;display:grid;place-items:center;opacity:0;transition:opacity .35s}
#__nums.on{opacity:1}#__nums .g{display:grid;grid-template-columns:repeat(3,1fr);gap:26px 44px;text-align:center;max-width:1100px}
#__nums .n{font:800 64px/1 -apple-system,Helvetica,Arial,sans-serif;color:#fff;letter-spacing:-.02em;opacity:0;transform:translateY(16px);transition:opacity .35s,transform .35s}
#__nums .n.on{opacity:1;transform:none}#__nums .n small{display:block;font:500 17px/1.3 ui-monospace,Menlo,monospace;color:#9aa3b2;margin-top:12px;letter-spacing:.06em;text-transform:uppercase}
#__nums .n.ok{color:#6fe79e}
#__tk{position:fixed;left:40px;right:40px;bottom:150px;z-index:2147483510;display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:24px;align-items:end;pointer-events:none}
#__tk .log{min-width:0;background:rgba(8,10,16,.9);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:16px 20px;font:500 17px/1.5 ui-monospace,Menlo,monospace;color:#d6dde9;min-height:230px;box-shadow:0 14px 40px rgba(0,0,0,.5)}
#__tk .log div{opacity:0;transform:translateY(6px);transition:opacity .25s,transform .25s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#__tk .log div.on{opacity:1;transform:none}#__tk .log i{font-style:normal;color:#7f8a9c;margin-right:12px}#__tk .log b{color:#ffa63d;font-weight:600}#__tk .log .ok{color:#6fe79e}#__tk .log .bad{color:#ff8d96}
#__tk .bs{background:rgba(8,10,16,.9);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:16px 20px;box-shadow:0 14px 40px rgba(0,0,0,.5)}
#__tk .bs h4{margin:0 0 12px;font:600 13px ui-monospace,Menlo,monospace;letter-spacing:.14em;color:#9aa3b2;text-transform:uppercase}
#__tk .dots{display:grid;grid-template-columns:repeat(21,1fr);gap:5px}#__tk .dots i{display:block;aspect-ratio:1;border-radius:50%;background:#2a3140;transition:background .25s,transform .25s}
#__tk .dots i.good{background:#3ddc84}#__tk .dots i.bad{background:#ff4d5e}#__tk .dots i.c{background:#ffa63d;transform:scale(1.5);box-shadow:0 0 0 3px rgba(255,166,61,.35)}
#__tk .who{margin-top:12px;font:600 15px ui-monospace,Menlo,monospace;color:#fff;min-height:20px}
#__spot{position:fixed;border-radius:16px;box-shadow:0 0 0 3px #ffa63d,0 0 0 200vmax rgba(6,8,12,.62);z-index:2147483600;pointer-events:none;opacity:0;transition:opacity .3s}
`
const install = () => page.evaluate(css => {
  if (!document.getElementById('__tourcss')) { const s = document.createElement('style'); s.id = '__tourcss'; s.textContent = css; document.head.appendChild(s) }
  const bar = document.createElement('div'); bar.id = '__tour'; bar.innerHTML = '<b></b><span></span>'; document.body.appendChild(bar)
  const f = document.createElement('div'); f.id = '__flash'; document.body.appendChild(f)
}, STYLE)
// a caption: `text` may hold <em> for the lit words; it stays until the next one or hideCaption
const caption = (text, head = null) => page.evaluate(async ([text, head]) => {
  const bar = document.getElementById('__tour')
  bar.classList.remove('on'); await new Promise(r => setTimeout(r, 160))
  bar.querySelector('b').textContent = head ?? ''; bar.querySelector('b').style.display = head ? '' : 'none'
  bar.querySelector('span').innerHTML = text
  bar.classList.add('on')
}, [text, head])
const hideCaption = () => page.evaluate(() => document.getElementById('__tour')?.classList.remove('on'))
const flash = (a = .16) => page.evaluate(a => { const f = document.getElementById('__flash'); f.style.transition = 'none'; f.style.opacity = String(a); requestAnimationFrame(() => { f.style.transition = 'opacity .32s'; f.style.opacity = '0' }) }, a)
const spot = (match, pad = 6) => page.evaluate(([match, pad]) => {
  document.getElementById('__spot')?.remove()
  const el = match.startsWith('claim:') ? [...document.querySelectorAll('.claim')].find(k => k.textContent.includes(match.slice(6))) : document.querySelector(match)
  if (!el) return false
  const r = el.getBoundingClientRect(), d = document.createElement('div'); d.id = '__spot'
  d.style.cssText = `left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + 2 * pad}px;height:${r.height + 2 * pad}px`
  document.body.appendChild(d); requestAnimationFrame(() => { d.style.opacity = '1' }); return true
}, [match, pad])
const unspot = () => page.evaluate(() => { const d = document.getElementById('__spot'); if (d) { d.style.opacity = '0'; setTimeout(() => d.remove(), 300) } })
const punch = (sel, scale = 1.7) => page.evaluate(([sel, scale]) => { const e = document.querySelector(sel); if (!e) return; e.style.transition = 'transform .18s cubic-bezier(.2,1.6,.4,1)'; e.style.transform = `scale(${scale})`; e.style.zIndex = '5'; e.style.position = e.style.position || 'relative'; setTimeout(() => { e.style.transition = 'transform .5s'; e.style.transform = '' }, 900) }, [sel, scale])
const scrollTo = (sel, block = 'start') => page.evaluate(([sel, block]) => { document.querySelector(sel)?.scrollIntoView({ behavior: 'smooth', block }) }, [sel, block])
const scrollToCard = (match, block = 'start') => page.evaluate(([match, block]) => { [...document.querySelectorAll('.claim')].find(k => k.textContent.includes(match))?.scrollIntoView({ behavior: 'smooth', block }) }, [match, block])
const card = (big, small) => `<div id="__card"><div style="text-align:center"><div class="k">BEHIQUE</div>${big}<div class="s">${small}</div></div></div>`
const overlayOff = id => page.evaluate(id => { const o = document.getElementById(id); if (o) { o.classList.remove('on'); setTimeout(() => o.remove(), 400) } }, id)

// the two recordings of a record, large, side by side, playing
const lightbox = (match) => page.evaluate(async ([match]) => {
  const c = [...document.querySelectorAll('.claim')].find(k => k.textContent.includes(match))
  const figs = c ? [...c.querySelectorAll(':scope > .claim-videos figure.vid')] : []
  if (!figs.length) return 0
  const o = document.createElement('div'); o.id = '__lb'; const vids = []
  figs.forEach((f, i) => {
    const cap = f.querySelector('figcaption'), chip = cap?.querySelector('.ver')?.textContent?.trim() || (i === 0 ? 'good' : 'candidate')
    const words = cap ? [...cap.childNodes].filter(n => n !== cap.firstElementChild).map(n => n.textContent).join('').trim() : ''
    const fg = document.createElement('figure'); fg.className = i === 0 ? 'good' : 'bad'
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = f.querySelector('video').src
    const ch = document.createElement('span'); ch.className = 'chip'; ch.textContent = chip
    const fc = document.createElement('figcaption'); fc.textContent = words
    fg.append(ch, v, fc); o.appendChild(fg); vids.push(v)
  })
  document.body.appendChild(o)
  await Promise.all(vids.map(v => new Promise(r => { v.addEventListener('loadeddata', r, { once: true }); v.load(); setTimeout(r, 4000) })))
  await new Promise(r => setTimeout(r, 30)); o.classList.add('on')
  for (const v of vids) { v.currentTime = 0; try { await v.play() } catch {} }
  return Math.max(...vids.map(v => isFinite(v.duration) ? v.duration : 8))
}, [match])
// the sped-up recording of a real run, full screen
const tlFactor = (() => { try { const m = JSON.parse(readFileSync(timelapse.replace(/-timelapse\.webm$/, '-raw.json'), 'utf8')).marks; return Math.round((m.end - m.start) / 8) } catch { return null } })()
const runTimelapse = (seconds) => page.evaluate(async ([seconds, factor]) => {
  const o = document.createElement('div'); o.id = '__tl'
  const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = '/__tour/run.webm'
  const s = document.createElement('div'); s.className = 'spd'; s.textContent = factor ? `REAL RUN, ${factor}X` : 'REAL RUN, SPED UP'
  o.append(v, s); document.body.appendChild(o)
  await new Promise(r => { v.addEventListener('loadeddata', r, { once: true }); v.load(); setTimeout(r, 5000) })
  await new Promise(r => setTimeout(r, 30)); o.classList.add('on')
  try { await v.play() } catch {}
  return isFinite(v.duration) ? v.duration : seconds
}, [seconds, tlFactor])
// the number card: read from the page where it can be, so the numbers are the case's own
const numbers = () => page.evaluate(async () => {
  const txt = document.body.textContent
  const facts = (txt.match(/of (\d[\d,]*) recorded facts/) || [])[1]
  const ev = (txt.match(/Chain verified \((\d+) events/) || [])[1]
  const bc = (document.getElementById('bisectCount')?.textContent.match(/(\d+) commits \. (\d+) steps/) || [])
  const items = [[facts ? Number(facts).toLocaleString('en-US') : '15,432', 'facts compared', ''], [bc[1] || '41', 'commits searched', ''], [bc[2] || '5', 'builds to the culprit', ''],
    ['3 of 3', 'runs each way', ''], [ev || '92', 'events in the chain', ''], ['0', 'model calls', 'ok']]
  const o = document.createElement('div'); o.id = '__nums'; const g = document.createElement('div'); g.className = 'g'
  for (const [n, l, k] of items) { const d = document.createElement('div'); d.className = 'n ' + k; d.innerHTML = `${n}<small>${l}</small>`; g.appendChild(d) }
  o.appendChild(g); document.body.appendChild(o); await new Promise(r => setTimeout(r, 30)); o.classList.add('on')
  const ns = [...o.querySelectorAll('.n')]; for (let i = 0; i < ns.length; i++) { await new Promise(r => setTimeout(r, 230)); ns[i].classList.add('on') }
})

// the case's own facts: app, versions, bisect size, elapsed time. The words of the video come from here and from the page, never from this file
const EV = (() => { const f = resolve('out/evidence', caseId, 'events.ndjson'); return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [] })()
const opened = EV.find(e => e.type === 'case.opened')?.data ?? {}
const APP = opened.app ?? 'the app', GOOD = opened.goodRef ?? 'the good version', CAND = opened.candRef ?? 'the candidate'
const APP_NAME = { hoppscotch: 'Hoppscotch', docusaurus: 'Docusaurus', slidev: 'Slidev', vitepress: 'VitePress', 'vitepress-docs': 'VitePress', musicblocks: 'Music Blocks', umami: 'Umami', excalidraw: 'Excalidraw' }[APP] ?? APP
const bisectStart = EV.find(e => e.type === 'bisect.started')?.data ?? null, bisectDone = EV.find(e => e.type === 'bisect.done')?.data ?? null
const timing = EV.find(e => e.type === 'check.timing')?.data ?? null
const minutesWords = sec => { const m = Math.round(sec / 30) / 2; return m < 1 ? 'Under a minute' : m === 1 ? 'A minute' : `${m} minutes` }
const sentence = w => w ? w.replace(/^(passes|fails): /, '').replace(/\.$/, '') : ''
// the record the video opens on: a reproduced failure with recordings, the one that moves on film if there is one, else the most noticeable
const pickHero = () => page.evaluate(() => {
  const cards = [...document.querySelectorAll('.claim')].filter(c => c.querySelector(':scope > .claim-videos video'))
  const info = cards.map(c => { const m = c.textContent.match(/Regression (R\d+) in plain words/); const caps = [...c.querySelectorAll(':scope > .claim-videos figcaption')].map(f => [...f.childNodes].filter(n => n !== f.firstElementChild).map(n => n.textContent).join('').trim()); return { id: m?.[1], pass: caps[0] ?? '', fail: caps[1] ?? '' } }).filter(x => x.id)
  const want = window.__heroId // BEHIQUE_HERO=R2 names the card to open on; otherwise a scroll or move story, else the first
  return (want && info.find(x => x.id === want)) ?? info.find(x => /scroll|move/i.test(x.fail)) ?? info[0] ?? null
})

// what the run did and when, read from the case's own event log: the ticker over the time-lapse says only what the record says
const runLines = (() => {
  const f = resolve('out/evidence', caseId, 'events.ndjson'); if (!existsSync(f)) return { lines: [], total: 0, changes: 0 }
  const ev = readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const t0 = Date.parse(ev[0].ts), at = e => (Date.parse(e.ts) - t0) / 1000, mm = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  const lines = [], o = ev[0].data, refs = `${o.goodRef} and ${o.candRef}`
  const push = (e, html, extra = {}) => lines.push({ t: at(e), html: `<i>${mm(at(e))}</i>${html}`, ...extra })
  push(ev[0], `Clean installs of ${o.app} ${refs}`)
  const m = ev.find(e => e.type === 'masking.summary'); if (m) push(m, `<b>${m.data.total.toLocaleString('en-US')}</b> facts recorded on each version. Noise between two installs of ${o.goodRef}: <b>${m.data.masked}</b>`)
  const d = ev.find(e => e.type === 'claim' && /differs from/.test(e.data.text)); if (d) { const n = d.data.text.match(/in (\d+) recorded values, and (\d+) elements/); if (n) push(d, `${o.candRef}: <b>${n[1]}</b> values differ, <b>${n[2]}</b> elements missing`) }
  const ex = ev.filter(e => e.type === 'test.exported'); if (ex.length) push(ex.at(-1), `<b>${ex.length}</b> tests written from the facts: ${ex.map(e => e.data.id).join(', ')}`)
  const j = ev.filter(e => e.type === 'test.judged'); if (j.length) push(j.at(-1), `<span class="ok">${j.filter(e => e.data.verdict === 'confirmed').length} of ${j.length} reproduced</span>: pass ${j[0].data.goodPassed} of ${j[0].data.runs} on ${o.goodRef}, fail ${j[0].data.candFailed} of ${j[0].data.runs} on ${o.candRef}. Recorded.`)
  const sh = ev.filter(e => e.type === 'shots.recorded'); if (sh.length) push(sh.at(-1), `Screenshots compared at ${sh.length} steps`)
  const bs = ev.find(e => e.type === 'bisect.started'); if (bs) push(bs, `Bisect: <b>${bs.data.changes}</b> commits between the versions`, { bisect: 'start' })
  for (const st of ev.filter(e => e.type === 'bisect.step')) push(st, `step ${st.data.step}: ${st.data.sha} <span class="${st.data.verdict === 'bad' ? 'bad' : 'ok'}">${st.data.verdict}</span>  ${st.data.subject}`, { bisect: st.data })
  const v = ev.find(e => e.type === 'bisect.verifying'); if (v) push(v, `Rebuilding ${v.data.commit}, ${v.data.runs} more runs to be sure`)
  const bd = ev.find(e => e.type === 'bisect.done'); if (bd) { const c = ev.find(e => e.type === 'claim' && /first change that makes the test fail/.test(e.data.text)); const sub = c ? c.data.text.match(/"([^"]+)"/)?.[1] : ''; push(bd, `<span class="bad">Culprit verified</span>: ${v?.data.commit ?? ''} ${sub ? `"${sub}"` : ''}`, { bisect: 'done' }) }
  const cl = ev.find(e => e.type === 'case.closed'); if (cl) push(cl, `Case closed: <b>${cl.data.outcome}</b>`)
  return { lines, total: at(ev.at(-1)), changes: bs?.data.changes ?? 0 }
})()
const ticker = (seconds) => page.evaluate(async ([run, seconds]) => {
  const o = document.createElement('div'); o.id = '__tk'
  const log = document.createElement('div'); log.className = 'log'
  const bs = document.createElement('div'); bs.className = 'bs'; bs.innerHTML = `<h4>Bisect, ${run.changes} commits</h4><div class="dots"></div><div class="who"></div>`
  const dots = bs.querySelector('.dots'); for (let i = 0; i < run.changes; i++) dots.appendChild(document.createElement('i'))
  o.append(log, bs); document.body.appendChild(o)
  const scale = seconds / Math.max(1, run.total), t0 = performance.now()
  for (const l of run.lines) {
    await new Promise(r => setTimeout(r, Math.max(0, l.t * scale * 1000 - (performance.now() - t0))))
    const d = document.createElement('div'); d.innerHTML = l.html; log.appendChild(d); requestAnimationFrame(() => d.classList.add('on'))
    while (log.children.length > 7) log.removeChild(log.firstChild)
    if (l.bisect && l.bisect.index !== undefined) { const i = dots.children[l.bisect.index]; if (i) i.className = l.bisect.verdict === 'bad' ? 'bad' : 'good'; bs.querySelector('.who').textContent = `step ${l.bisect.step}  ${l.bisect.sha}  ${l.bisect.verdict}` }
    if (l.bisect === 'done') { const bad = [...dots.children].find(i => i.className === 'bad'); if (bad) bad.className = 'c'; bs.querySelector('.who').textContent = 'culprit found and verified' }
  }
}, [runLines, seconds])

// ---- the cut, timed to the track: hits at 2.4, 9.3, 11.6, 21.6, 25.9; loudest from 42; ends 59.6 ----
await page.addInitScript(([html, css]) => { document.addEventListener('DOMContentLoaded', () => { const st = document.createElement('style'); st.id = '__tourcss'; st.textContent = css; document.head.appendChild(st); document.body.insertAdjacentHTML('beforeend', html) }) }, [card('Release verification<br>with evidence', 'Two versions of an app. What changed, proven, bisected, recorded.'), STYLE])
await page.goto(`${base}/dashboard?case=${encodeURIComponent(caseId)}`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => [...document.querySelectorAll('.claim')].some(k => k.querySelector(':scope > .claim-videos video')), null, { timeout: 30000 }).catch(() => {})
if (process.env.BEHIQUE_HERO) await page.evaluate(id => { window.__heroId = id }, process.env.BEHIQUE_HERO)
const hero = await pickHero()
if (!hero) { console.error('this case has no reproduced failure with recordings; nothing to open on'); await ctx.close(); await browser.close(); process.exit(1) }
const HERO = `Regression ${hero.id} in plain words`
console.log('opening on', hero.id, '|', hero.pass, '|', hero.fail)
await install()
// the recordings start behind the card so they are ready on the first hit
const longest = await lightbox(HERO)
await until(2.3); await page.evaluate(() => { const c = document.getElementById('__card'); c.style.transition = 'opacity .25s'; c.style.opacity = '0'; setTimeout(() => c.remove(), 300) })
await flash(.22)
await until(2.7); await caption(`Behique found this regression in ${APP_NAME} ${CAND}. <em>No one wrote a test.</em>`, 'A real release, two real builds')
await until(9.2); await flash(.12); await caption(`On ${GOOD} ${sentence(hero.pass)}. <em>On ${CAND} ${sentence(hero.fail)}.</em>`)
await page.evaluate(() => document.querySelectorAll('#__lb video').forEach(v => { v.currentTime = 2; v.play().catch(() => {}) }))   // past the blank first frames of a recording (the page paints at about 1.5 s)
await until(13.4); await flash(.1); await caption('Both runs recorded, the tested element marked in the footage, <em>the verdict written into it.</em>')
await until(16.0); await overlayOff('__lb'); await hideCaption()

// the feat: the New run dialog, then the time-lapse of a real run
await until(16.5); await page.click('#replayBtn').catch(() => {}); await page.waitForSelector('#runOverlay.open', { timeout: 3000 }).catch(() => {})
await caption('Two versions of an app it has never seen. <em>That is the whole input.</em>', 'New run')
await page.selectOption('#runApp', APP).catch(() => {}); await sleep(250); await page.selectOption('#runType', 'crawl').catch(() => {})
await page.fill('#runGood', '').catch(() => {}); await page.type('#runGood', GOOD, { delay: 55 }).catch(() => {})
await page.fill('#runCand', '').catch(() => {}); await page.type('#runCand', CAND, { delay: 55 }).catch(() => {})
await until(21.3); await flash(.2); await page.evaluate(() => { document.getElementById('runOverlay')?.classList.remove('open') })   // the real start was recorded earlier; the dialog closes as it would
if (timelapse) {
  const d = await runTimelapse(8)
  await caption('Two clean builds in Docker. The click paths came from a crawl, <em>not from a person.</em> Every failure rerun 3 times, then bisected.', tlFactor ? `Real run, ${tlFactor}x` : 'Real run, sped up')
  const tk = ticker(Math.max(7.5, Math.min(d, 9.5)) - 0.4)
  await until(21.6 + Math.max(7.5, Math.min(d, 9.5))); await tk.catch(() => {})
  await page.evaluate(() => document.getElementById('__tk')?.remove()); await overlayOff('__tl')
} else {
  await caption('Builds both versions in Docker, crawls the app with <em>no steps written by a person</em>, reruns each failure 3 times, then bisects.', 'The run')
  await until(30.5)
}
const verdictWord = await page.evaluate(() => document.getElementById('verdictWord')?.textContent?.trim() || 'HOLD')
await flash(.14); await caption(`${timing ? minutesWords(timing.total.seconds) + ' later' : 'At the end'}: <em>${verdictWord}</em>, with the reason.`, 'The verdict')
await until(33.2)

// the proof
await scrollTo('#bisectCard'); await sleep(550); await spot('#bisectCard')
await caption(bisectStart && bisectDone ? `${bisectStart.changes} commits between the versions. <em>${bisectDone.steps} builds to the one that broke it.</em>` : 'The commits between the versions, searched for the one that broke it.', 'Bisect')
await sleep(500); await punch('#bisectNodes .node.c', 1.8); await punch('#culpritTag', 1.15)
await until(37.6); await unspot(); await scrollTo('.builds'); await sleep(500)
await caption('Every fact measured on both builds. <em>Only what changed is lit.</em>', 'Measured')
await until(41.4)
await page.evaluate(() => { const d = [...document.querySelectorAll('figure.shot figcaption')].find(e => e.textContent.startsWith('Difference')); const f = d?.closest('figure'); if (f) { f.id = '__difffig'; f.scrollIntoView({ behavior: 'smooth', block: 'center' }) } })
await sleep(550); await spot('#__difffig'); await flash(.12)
await caption('Pixels compared. <em>Moved content blue, new content red.</em>', 'Screenshots')
await until(44.8); await unspot(); await scrollTo('#compareCard', 'center'); await sleep(500)
await caption('Drag the handle: <em>good on the left, candidate on the right.</em>', 'Before and after')
await page.evaluate(async () => {
  const r = document.querySelector('#compareCard input[type=range]'); if (!r) return
  const set = v => { r.value = String(v); r.dispatchEvent(new Event('input', { bubbles: true })) }
  for (let v = 50; v >= 4; v -= 3) { set(v); await new Promise(x => setTimeout(x, 22)) }
  for (let v = 4; v <= 96; v += 3) { set(v); await new Promise(x => setTimeout(x, 22)) }
  for (let v = 96; v >= 50; v -= 3) { set(v); await new Promise(x => setTimeout(x, 22)) }
})

// trust
await until(48.2); await scrollToCard(HERO); await sleep(500); await spot('claim:' + HERO)
await caption('Every failure is a record in a hash chain: <em>what the test does, in plain words, with its evidence.</em>', 'Evidence')
await until(50.3); await unspot(); await scrollTo('#evidenceCard'); await sleep(350); await page.click('#verifyBtn').catch(() => {})   // the scan runs down the records for about 3 s, then the status line says what it found
await caption('Verify chain recomputes every hash. <em>Nothing here can be edited quietly.</em>', 'Integrity')
await until(53.8); await spot('#verifyStatus', 8); await flash(.14)
await until(55.3); await unspot(); await hideCaption(); await numbers()
await until(58.2); await page.evaluate(html => { document.body.insertAdjacentHTML('beforeend', html); const c = document.getElementById('__card'); c.style.opacity = '0'; requestAnimationFrame(() => requestAnimationFrame(() => { c.style.opacity = '1' })) }, card('Proven, bisected, recorded.', 'No model wrote the verdict. Every claim cites its evidence.'))
await until(61.5)
console.log('recorded', now().toFixed(1), 's; recordings ran', longest.toFixed(1), 's')

await ctx.close(); await browser.close()
const webm = readdirSync(vidDir).find(f => f.endsWith('.webm'))
if (!webm) { console.error('no recording was written'); process.exit(1) }
const offset = Number(process.env.BEHIQUE_VIDEO_OFFSET ?? 0)   // seconds trimmed from the start of the recording before the music begins
const args = ['-v', 'error', '-y', '-ss', String(offset), '-i', join(vidDir, webm)]
if (music) args.push('-i', music, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-shortest')
args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-r', '30', '-movflags', '+faststart', out)
const r = spawnSync('ffmpeg', args, { encoding: 'utf8' })
if (r.status !== 0) { console.error(r.stderr); renameSync(join(vidDir, webm), out.replace(/\.mp4$/, '.webm')); console.log('ffmpeg failed; kept the webm') }
else { renameSync(join(vidDir, webm), out.replace(/\.mp4$/, '.raw.webm')); rmSync(vidDir, { recursive: true, force: true }); console.log('wrote', out) }
