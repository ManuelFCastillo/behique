// Verify a proposed profile with real builds, settled pictures and a noise floor.
//   node --test src/release/onboard/verify.test.mjs
import { startBuild } from '../build.mjs'
import { pictureOf, measureFloor } from '../visual/picture.mjs'
import { profileToAdapter } from './profile.mjs'
import { decode, emptiness } from '../../senses/pixels.mjs'

/** The visible text length of the page the app serves (tags, scripts and styles removed); 0 when it cannot be fetched. */
async function pageTextLength(fetchFn, base, path) {
  try {
    const res = await fetchFn(base + (path && path !== '/' ? path : '/'))
    const html = await res.text()
    return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().length
  } catch { return 0 }
}

function pngSize(png) {
  const buf = Buffer.from(png)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

export async function verifyProfile(profile, {
  good,
  cand,
  startBuildFn = startBuild,
  pictureFn = pictureOf,
  floorFn = measureFloor,
  ports = [8301, 8302],
  loads = 3,
  log = () => {},
  fetchFn = fetch,
} = {}) {
  const adapter = profileToAdapter(profile)
  const checks = []
  const push = (name, ok, detail, logs) => {
    checks.push({ name, ok, detail, ...(logs ? { logs: String(logs).slice(-4000) } : {}) }) // logs: the end of the app's own output, for a person or the repair loop
    try {
      log(`${ok ? 'ok' : 'FAILED'} ${name}: ${detail}`)
    } catch {}
  }
  const skipRest = (names, why) => {
    for (const name of names) push(name, true, `skipped: ${why}`)
  }
  const AFTER_GOOD = [
    'builds the candidate version',
    'pictures settle',
    'pictures are the same size',
    'the app is alive',
    'no page errors on the good version',
    'no blocked requests',
    'noise floor'
  ]
  const AFTER_CAND = AFTER_GOOD.slice(1)

  let goodBuild = null
  let candBuild = null
  let floor = null
  let goodPic = null
  let candPic = null

  const stopAll = async () => {
    for (const b of [goodBuild, candBuild]) {
      if (!b) continue
      try {
        await b.stop()
      } catch {}
    }
  }

  try {
    try {
      goodBuild = await startBuildFn({ adapter, ref: good, port: ports[0] })
      const sha12 = String(goodBuild.sha).slice(0, 12)
      const secs = (Number(goodBuild.buildMs ?? 0) / 1000).toFixed(1)
      push('builds the good version', true, `${sha12} in ${secs}s`)
    } catch (err) {
      push('builds the good version', false, String((err && err.message) || err), err && err.logs)
      skipRest(AFTER_GOOD, 'good build failed')
      return { ok: false, checks, floor }
    }

    try {
      candBuild = await startBuildFn({ adapter, ref: cand, port: ports[1] })
      const sha12 = String(candBuild.sha).slice(0, 12)
      const secs = (Number(candBuild.buildMs ?? 0) / 1000).toFixed(1)
      push('builds the candidate version', true, `${sha12} in ${secs}s`)
    } catch (err) {
      push('builds the candidate version', false, String((err && err.message) || err), err && err.logs)
      skipRest(AFTER_CAND, 'candidate build failed')
      return { ok: checks.every((c) => c.ok), checks, floor }
    }

    try {
      goodPic = await pictureFn(goodBuild.base, profile)
    } catch (err) {
      goodPic = null
      push('pictures settle', false, `good picture failed: ${String((err && err.message) || err)}`)
      try {
        candPic = await pictureFn(candBuild.base, profile)
      } catch {
        candPic = null
      }
      await rest()
      return { ok: checks.every((c) => c.ok), checks, floor }
    }
    try {
      candPic = await pictureFn(candBuild.base, profile)
    } catch (err) {
      push('pictures settle', false, `candidate picture failed: ${String((err && err.message) || err)}`)
      await rest()
      return { ok: checks.every((c) => c.ok), checks, floor }
    }
    {
      const settled = Boolean(goodPic.settled) && Boolean(candPic.settled)
      const canvas = goodPic.canvasHeavy || candPic.canvasHeavy ? ' (mostly a drawn canvas: the animation loop was paused for each picture)' : ''
      const detail = `good ${Number(goodPic.ms ?? 0)}ms, candidate ${Number(candPic.ms ?? 0)}ms${canvas}`
      push('pictures settle', settled, settled ? detail : `${detail} (did not settle)`)
    }

    await rest()
    return { ok: checks.every((c) => c.ok), checks, floor }
  } finally {
    await stopAll()
  }

  async function rest() {
    try {
      if (!goodPic || !candPic || !goodPic.png || !candPic.png) {
        push('pictures are the same size', false, 'missing picture')
      } else {
        const g = pngSize(goodPic.png)
        const c = pngSize(candPic.png)
        const same = g.width === c.width && g.height === c.height
        push('pictures are the same size', same, `${g.width}x${g.height} vs ${c.width}x${c.height}`)
      }
    } catch (err) {
      push('pictures are the same size', false, String((err && err.message) || err))
    }

    try {
      if (!goodPic || !goodPic.png) {
        push('the app is alive', false, 'missing good picture')
      } else {
        const image = decode(goodPic.png)
        const box = { x: 0, y: 0, w: image.width, h: image.height }
        const empty = emptiness(image, box)
        let alive = empty < 0.99
        let detail = `emptiness ${Number(empty).toFixed(3)}`
        if (!alive) {
          // a page that is mostly white but says something (a minimal boilerplate page) is a page, not a failure: look at its text
          const chars = await pageTextLength(fetchFn, goodBuild.base, profile?.ready?.path)
          if (chars >= 12) { alive = true; detail += `, mostly white but the page has ${chars} characters of text` }
        }
        push('the app is alive', alive, alive ? detail : `blank (${detail})`, alive ? null : goodBuild?.logTail?.())
      }
    } catch (err) {
      push('the app is alive', false, String((err && err.message) || err))
    }

    try { // human addition after review: a page that throws while loading is not an app we understand how to run, even if it draws something
      const ge = Array.isArray(goodPic?.errors) ? goodPic.errors : [], ce = Array.isArray(candPic?.errors) ? candPic.errors : []
      push('no page errors on the good version', ge.length === 0, ge.length ? `${ge.length} uncaught errors while loading, first: ${ge[0]}` : `none (candidate: ${ce.length})`)
    } catch (err) {
      push('no page errors on the good version', false, String((err && err.message) || err))
    }

    try {
      const g = Array.isArray(goodPic?.blocked) ? goodPic.blocked.length : 0
      const c = Array.isArray(candPic?.blocked) ? candPic.blocked.length : 0
      push('no blocked requests', true, `blocked good ${g}, candidate ${c}`)
    } catch (err) {
      push('no blocked requests', true, String((err && err.message) || err))
    }

    try {
      const res = await floorFn(goodBuild.base, profile, { loads })
      floor = res
      const changed = Number(res?.changed ?? 0)
      push('noise floor', true, `${changed} pixels differ between loads`)
    } catch (err) {
      floor = null
      push('noise floor', false, String((err && err.message) || err))
    }
  }
}
