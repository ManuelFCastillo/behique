// Settled pictures of an app: take a stable screenshot and compare regions against a noise floor.
// Run: node --test src/release/visual/picture.test.mjs
import { chromium } from 'playwright'
import { CANVAS_SETTLE, settle } from '../../senses/hands.mjs'
import { aboveFloor, diff, noiseFloor, scaleBox } from '../../senses/pixels.mjs'
import { canvasHeavy, measureCanvases } from '../canvas-check.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

function viewportOf(profile) {
  const v = profile?.viewport ?? {}
  return { width: v.width ?? 1280, height: v.height ?? 800, deviceScaleFactor: v.deviceScaleFactor ?? 2 }
}

function loadSettleOf(profile) {
  return { stableMs: 1500, pollMs: 300, maxMs: 40000, ...(profile?.settle ?? {}) }
}

const STEP_SETTLE = { stableMs: 1500, pollMs: 300, maxMs: 20000 }

function shouldBlock(url, profile) {
  if (profile?.blockHosts === false) return false
  if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return false
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return false
  }
  if (host === '' || host === '127.0.0.1' || host === 'localhost') return false
  return true
}

/**
 * Open a fresh context, block outside hosts, load the url, settle, run setup steps.
 * The caller closes `ctx`. `png` is the last settled picture.
 */
export async function openSettled(browser, url, profile) {
  const vp = viewportOf(profile)
  const blocked = []
  const errors = []
  const t0 = Date.now()
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
  })
  await ctx.route('**/*', route => {
    const u = route.request().url()
    if (shouldBlock(u, profile)) {
      blocked.push(u)
      return route.abort()
    }
    return route.continue()
  })
  const page = await ctx.newPage()
  page.on('pageerror', e => {
    errors.push(String(e?.message ?? e).slice(0, 120))
  })
  await page.goto(url)
  // a page that is mostly a drawn canvas gets its animation loop paused for every picture and a longer screenshot timeout
  const heavy = canvasHeavy(await page.evaluate(measureCanvases).catch(() => []), vp)
  const canvas = heavy ? CANVAS_SETTLE : {}
  let r = await settle(page, { ...loadSettleOf(profile), ...canvas })
  let ok = r.settled
  let png = r.png
  for (const s of profile?.setup ?? []) {
    if (s.type === 'click_at') await page.mouse.click(s.x, s.y)
    else if (s.type === 'wait') await sleep(s.ms)
    else if (s.type === 'press') await page.keyboard.press(s.key)
    r = await settle(page, { ...STEP_SETTLE, ...canvas })
    png = r.png
    ok = ok && r.settled
  }
  return { ctx, page, png, settled: ok, ms: Date.now() - t0, errors, blocked, canvasHeavy: heavy }
}

/** Take one settled picture, always closing the context. Launches a browser when none is given. */
export async function pictureOf(url, profile, { browser = null } = {}) {
  const own = !browser
  const b = browser ?? await chromium.launch()
  try {
    const { ctx, png, settled, ms, errors, blocked, canvasHeavy: heavy } = await openSettled(b, url, profile)
    try {
      return { png, settled, ms, errors, blocked, canvasHeavy: heavy }
    } finally {
      await ctx.close()
    }
  } finally {
    if (own) await b.close()
  }
}

/**
 * Noise floor from `loads` fresh pictures of the same url, one after another.
 * `regions` holds the worst in-region count for every region and anchor. Throws when a load never settles.
 */
export async function measureFloor(url, profile, { loads = 3, browser = null } = {}) {
  const own = !browser
  const b = browser ?? await chromium.launch()
  try {
    const pngs = []
    for (let i = 0; i < loads; i++) {
      const one = await pictureOf(url, profile, { browser: b })
      if (!one.settled) throw new Error('measureFloor: a load did not settle, the page is not stable enough for a noise floor')
      pngs.push(one.png)
    }
    const floor = noiseFloor(pngs)
    const scale = viewportOf(profile).deviceScaleFactor
    const boxes = { ...(profile?.regions ?? {}), ...(profile?.anchors ?? {}) }
    const regions = {}
    for (const [name, box] of Object.entries(boxes)) {
      const region = scaleBox(box, scale)
      let worst = 0
      for (let i = 0; i < pngs.length; i++) {
        for (let j = i + 1; j < pngs.length; j++) {
          worst = Math.max(worst, diff(pngs[i], pngs[j], { region }).inRegion)
        }
      }
      regions[name] = worst
    }
    return { n: pngs.length, changed: floor.changed, regions }
  } finally {
    if (own) await b.close()
  }
}

/** Compare one region against an optional floor. A size mismatch always counts as above. */
export function regionReport(refPng, png, name, region, { floor = null, scale = 2, tolerance = 0 } = {}) {
  const d = diff(refPng, png, { tolerance, region: scaleBox(region, scale) })
  if (d.sizeMismatch) return { name, region, changed: d.changed, inRegion: d.changed, above: true }
  const inRegion = d.inRegion
  const above = aboveFloor({ changed: inRegion }, { changed: floor?.regions?.[name] ?? 0 }, { minPixels: 4 })
  return { name, region, changed: d.changed, inRegion, above }
}

/** Anchors must not move between versions. Lists the names that are above the floor. */
export function anchorsOk(refPng, png, anchors, { floor = null, scale = 2 } = {}) {
  const failed = []
  for (const [name, region] of Object.entries(anchors ?? {})) {
    const r = regionReport(refPng, png, name, region, { floor, scale })
    if (r.above) failed.push(name)
  }
  return { ok: failed.length === 0, failed }
}
