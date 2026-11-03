// A scripted tour of the dashboard, recorded as a video with text captions and no voice: it drives the real page (scrolls, drags the
// slider, plays the recordings, verifies the chain, copies a record) over a finished report. No model calls, no runs started.
//   node demo/tour.mjs <caseId> [out/demo/tour.mp4]      needs the demo server on 8790 and ffmpeg
import { chromium } from 'playwright'
import { mkdirSync, renameSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

const caseId = process.argv[2]
if (!caseId) { console.error('usage: node demo/tour.mjs <caseId> [out.mp4]'); process.exit(2) }
const out = process.argv[3] ?? 'out/demo/tour.mp4'
const base = process.env.BEHIQUE_URL ?? 'http://127.0.0.1:8790'
const W = 1280, H = 800
mkdirSync(dirname(out), { recursive: true })
const vidDir = join(dirname(out), 'raw'); rmSync(vidDir, { recursive: true, force: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: vidDir, size: { width: W, height: H } }, reducedMotion: 'no-preference' })
const page = await ctx.newPage()
const sleep = ms => page.waitForTimeout(ms)

// The caption bar: one line of large text at the bottom, faded in and out. Lives only in this recording.
const caption = (text, { ms = 3800, head = null } = {}) => page.evaluate(async ([text, head, ms]) => {
  let bar = document.getElementById('__tour')
  if (!bar) {
    bar = document.createElement('div'); bar.id = '__tour'
    bar.innerHTML = '<style>#__tour{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(12px);max-width:1040px;padding:16px 26px;border-radius:16px;background:rgba(10,12,18,.93);color:#fff;font:500 24px/1.35 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;text-align:center;box-shadow:0 14px 44px rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.14);opacity:0;transition:opacity .35s,transform .35s;z-index:2147483647;pointer-events:none}#__tour.on{opacity:1;transform:translateX(-50%) translateY(0)}#__tour b{display:block;color:#ffa63d;font-size:15px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:6px;font-family:ui-monospace,Menlo,monospace}</style><b></b><span></span>'
    document.body.appendChild(bar)
  }
  bar.classList.remove('on'); await new Promise(r => setTimeout(r, 200))
  bar.querySelector('b').textContent = head ?? ''; bar.querySelector('b').style.display = head ? '' : 'none'
  bar.querySelector('span').textContent = text
  bar.classList.add('on'); await new Promise(r => setTimeout(r, ms))
}, [text, head, ms])
const hideCaption = () => page.evaluate(() => document.getElementById('__tour')?.classList.remove('on'))
// A spotlight: the rest of the page dims, the chosen element keeps its light and gets an amber edge. Fixed, so clear it before scrolling.
const spot = (match) => page.evaluate(([match]) => {
  document.getElementById('__spot')?.remove()
  const el = match.startsWith('claim:') ? [...document.querySelectorAll('.claim')].find(k => k.textContent.includes(match.slice(6))) : document.querySelector(match)
  if (!el) return false
  const r = el.getBoundingClientRect(), d = document.createElement('div'); d.id = '__spot'
  d.style.cssText = `position:fixed;left:${r.left - 6}px;top:${r.top - 6}px;width:${r.width + 12}px;height:${r.height + 12}px;border-radius:16px;box-shadow:0 0 0 3px #ffa63d,0 0 0 200vmax rgba(6,8,12,.62);z-index:2147483600;pointer-events:none;opacity:0;transition:opacity .35s`
  document.body.appendChild(d); requestAnimationFrame(() => { d.style.opacity = '1' }); return true
}, [match])
const unspot = () => page.evaluate(() => { const d = document.getElementById('__spot'); if (d) { d.style.opacity = '0'; setTimeout(() => d.remove(), 350) } })
// The two recordings of a record, played large side by side, with the version and what each one shows under it
const lightbox = (match) => page.evaluate(async ([match]) => {
  const c = [...document.querySelectorAll('.claim')].find(k => k.textContent.includes(match))
  const figs = c ? [...c.querySelectorAll(':scope > .claim-videos figure.vid')] : []
  if (!figs.length) return 0
  const o = document.createElement('div'); o.id = '__lb'
  o.innerHTML = '<style>#__lb{position:fixed;inset:0;background:rgba(7,9,14,.97);z-index:2147483500;display:grid;grid-template-columns:1fr 1fr;gap:32px;padding:44px 44px 130px;align-content:start;opacity:0;transition:opacity .4s}#__lb.on{opacity:1}#__lb figure{margin:0}#__lb video{width:100%;aspect-ratio:16/10;border-radius:12px;border:2px solid #2a3140;background:#000}#__lb .chip{display:inline-block;font:700 16px ui-monospace,Menlo,monospace;letter-spacing:.06em;padding:7px 14px;border-radius:999px;margin-bottom:14px}#__lb .good .chip{background:#13301d;color:#6fe79e;border:1px solid #2d7a4a}#__lb .bad .chip{background:#36151a;color:#ff8d96;border:1px solid #8a2d36}#__lb figcaption{color:#d6dde9;font:500 21px/1.35 -apple-system,Helvetica,Arial,sans-serif;margin-top:16px}#__lb figcaption code{font:600 18px ui-monospace,Menlo,monospace;color:#ffd08a}</style>'
  const vids = []
  figs.forEach((f, i) => {
    const src = f.querySelector('video')?.src; const cap = f.querySelector('figcaption')
    const chip = cap?.querySelector('.chip, .ver, [class*=chip]')?.textContent?.trim() || (i === 0 ? 'GOOD' : 'CANDIDATE')
    const words = cap ? [...cap.childNodes].filter(n => !(n.nodeType === 1 && n === cap.firstElementChild)).map(n => n.textContent).join('').trim() : ''
    const fg = document.createElement('figure'); fg.className = i === 0 ? 'good' : 'bad'
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.src = src; v.preload = 'auto'
    const ch = document.createElement('span'); ch.className = 'chip'; ch.textContent = chip
    const fc = document.createElement('figcaption'); fc.textContent = words
    fg.append(ch, v, fc); o.appendChild(fg); vids.push(v)
  })
  document.body.appendChild(o); await new Promise(r => setTimeout(r, 50)); o.classList.add('on')
  await Promise.all(vids.map(v => new Promise(r => { v.addEventListener('loadeddata', r, { once: true }); v.load(); setTimeout(r, 4000) })))
  for (const v of vids) { v.currentTime = 0; try { await v.play() } catch {} }
  const longest = Math.max(...vids.map(v => isFinite(v.duration) ? v.duration : 8))
  return longest
}, [match])
const closeLightbox = () => page.evaluate(() => { const o = document.getElementById('__lb'); if (o) { o.classList.remove('on'); setTimeout(() => o.remove(), 450) } })
const scrollTo = (sel, block = 'start') => page.evaluate(([sel, block]) => { const e = document.querySelector(sel); if (e) e.scrollIntoView({ behavior: 'smooth', block }) }, [sel, block])
// A card is found by the text of its plain line or its label; returns a selector-free handle through an index on the page
const scrollToCard = (match, block = 'start') => page.evaluate(([match, block]) => { const c = [...document.querySelectorAll('.claim')].find(k => k.textContent.includes(match)); if (c) { c.scrollIntoView({ behavior: 'smooth', block }); return true } return false }, [match, block])

// A title card drawn over the dashboard from its first paint, lifted once the case is on screen: nothing else is ever seen loading
const card = (big, small) => `<div id="__card" style="position:fixed;inset:0;background:#0b0e14;color:#fff;font:600 54px/1.2 -apple-system,Helvetica,Arial,sans-serif;display:grid;place-items:center;z-index:2147483640;transition:opacity .6s"><div style="text-align:center"><div style="font-size:16px;letter-spacing:.3em;color:#ffa63d;font-family:ui-monospace,Menlo,monospace;margin-bottom:18px">BEHIQUE</div>${big}<div style="font-size:22px;font-weight:500;color:#9aa3b2;margin-top:22px">${small}</div></div></div>`
const title = card('Release verification<br>with evidence', 'Two versions of an app. What changed, proven, bisected, recorded.')
await page.addInitScript(html => { document.addEventListener('DOMContentLoaded', () => document.body.insertAdjacentHTML('beforeend', html)) }, title)
await page.goto(`${base}/dashboard?case=${encodeURIComponent(caseId)}`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => [...document.querySelectorAll('.claim')].some(k => k.textContent.includes('Regression R3 in plain words')), null, { timeout: 30000 })
await sleep(2600)
await page.evaluate(() => { const c = document.getElementById('__card'); c.style.opacity = '0'; setTimeout(() => c.remove(), 650) })
await sleep(1400)
await caption('Behique compared Hoppscotch 2025.10.1 (good) with 2025.11.2 (candidate) and recommends HOLD.', { head: 'The verdict' })
await caption('5 behaviour changes were reproduced on fresh builds, 3 of 3 runs each way. A person decides; the record keeps the reason.', { ms: 4200 })

await scrollTo('#bisectCard'); await sleep(900)
await spot('#bisectCard')
await caption('41 commits between the versions, bisected in 5 steps to the one that broke it: d67a85b.', { head: 'Bisect timeline' })
await unspot(); await sleep(400)

await scrollTo('.builds'); await sleep(900)
await caption('Both versions are measured the same way. R1, R2... are the regression tests, most noticeable first.', { head: 'Measured on both versions' })
await caption('Only what differs is lit: amber where a class is lost, red where one is new.', { ms: 3600 })
await page.evaluate(() => { const d = [...document.querySelectorAll('figure.shot figcaption')].find(e => e.textContent.startsWith('Difference')); d?.closest('figure')?.scrollIntoView({ behavior: 'smooth', block: 'center' }) })
await sleep(900)
await page.evaluate(() => { const d = [...document.querySelectorAll('figure.shot figcaption')].find(e => e.textContent.startsWith('Difference')); d?.closest('figure')?.setAttribute('id', '__difffig') })
await spot('#__difffig')
await caption('Screenshots are compared pixel by pixel. Content that only moved is blue; what is new or changed is red.', { head: 'Moved, or new?' })
await unspot(); await sleep(300)
await page.evaluate(() => { const a = document.querySelector('figure.shot .dl'); if (a) { a.style.transform = 'scale(1.25)'; a.style.transition = 'transform .3s' } })
await caption('Every picture has a download control in its corner.', { ms: 2600 })
await page.evaluate(() => { const a = document.querySelector('figure.shot .dl'); if (a) a.style.transform = '' })

// Before and after: drag the handle
await scrollTo('#compareCard', 'center'); await sleep(900)
await caption('Before and after: drag the handle. The good version is on the left of it, the candidate on the right.', { head: 'Before and after', ms: 2400 })
const dragged = await page.evaluate(async () => {
  const r = document.querySelector('#compareCard input[type=range]'); if (!r) return false
  const set = v => { r.value = String(v); r.dispatchEvent(new Event('input', { bubbles: true })) }
  for (let v = 50; v >= 2; v -= 2) { set(v); await new Promise(x => setTimeout(x, 28)) }
  await new Promise(x => setTimeout(x, 700))
  for (let v = 2; v <= 98; v += 2) { set(v); await new Promise(x => setTimeout(x, 28)) }
  await new Promise(x => setTimeout(x, 700))
  for (let v = 98; v >= 50; v -= 2) { set(v); await new Promise(x => setTimeout(x, 28)) }
  return true
})
if (dragged) await caption('A new row pushed everything below it down, and the pane stopped scrolling.', { ms: 3200 })

// The record of a reproduced failure
await scrollToCard('Regression R3 in plain words'); await sleep(1000)
await spot('claim:Regression R3 in plain words')
await caption('Each reproduced failure is a record in a hash chain: what the test does, and the regression in plain words.', { head: 'Evidence chain' })
await caption('R3: after a click, a pane cannot be scrolled on the candidate. On the good version it scrolls.', { ms: 3600 })
await unspot(); await sleep(300)
await caption('Both runs were recorded. The mouse wheel is marked in the footage, and the verdict is written into it.', { head: 'Recorded on both versions', ms: 1200 })
const longest = await lightbox('Regression R3 in plain words')
if (longest) { await sleep(Math.min(14000, longest * 1000 + 1200)) }
await caption('Green: it scrolled on 2025.10.1. Red: it did not move on 2025.11.2.', { ms: 3200 })
await closeLightbox(); await sleep(500)

// Copy and verify
await page.evaluate(() => { const c = [...document.querySelectorAll('.claim')].find(k => k.textContent.includes('Regression R3 in plain words')); c?.scrollIntoView({ behavior: 'smooth', block: 'start' }) })
await sleep(800)
const copied = await page.evaluate(() => { const c = [...document.querySelectorAll('.claim')].find(k => k.textContent.includes('Regression R3 in plain words')); const b = c?.querySelector('.copy-btn'); if (b) { b.click(); return true } return false })
if (copied) await caption('Every record copies to the clipboard as text, hash and all, for a ticket or a message.', { head: 'Copy', ms: 3200 })
await scrollTo('#evidenceCard'); await sleep(900)
await page.click('#verifyBtn').catch(() => {})
await sleep(1400)
await spot('#verifyStatus')
await caption('Verify chain recomputes every hash. A changed record breaks the chain; nothing here can be edited quietly.', { head: 'Integrity', ms: 4200 })
await unspot()

await hideCaption(); await sleep(400)
await page.evaluate(html => { document.body.insertAdjacentHTML('beforeend', html); const c = document.getElementById('__card'); c.style.opacity = '0'; requestAnimationFrame(() => requestAnimationFrame(() => { c.style.opacity = '1' })) }, card('Proven, bisected, recorded.', 'No model wrote the verdict. Every claim cites its evidence.'))
await sleep(3600)

await ctx.close(); await browser.close()
const webm = readdirSync(vidDir).find(f => f.endsWith('.webm'))
if (!webm) { console.error('no recording was written'); process.exit(1) }
const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', join(vidDir, webm), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', out], { encoding: 'utf8' })
if (r.status !== 0) { console.error(r.stderr); renameSync(join(vidDir, webm), out.replace(/\.mp4$/, '.webm')); console.log('ffmpeg failed; kept the webm') }
else { rmSync(vidDir, { recursive: true, force: true }); console.log('wrote', out) }
