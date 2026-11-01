// What the dashboard shows for a visual check. Pure reader over an evidence case.
// Run: node --test src/release/ui/visual-view.test.mjs
import { readFileSync } from 'node:fs'

const HASH_RE = /^[0-9a-f]{64}$/

function lastArtifactByName(events, name) {
  let found = null
  for (const e of events) {
    if (e?.type === 'artifact' && e?.data?.name === name) found = e.data
  }
  return found
}

function urlFor(caseId, art) {
  if (!art) return null
  if (art.mediaType !== 'image/png') return null
  if (!HASH_RE.test(String(art.hash ?? ''))) return null
  return `/api/artifact-image?id=${encodeURIComponent(caseId)}&hash=${art.hash}`
}

function readJson(c, art) {
  if (!art) return null
  let path = null
  try {
    path = c.artifactPath(art.hash)
  } catch {
    return null
  }
  if (!path) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** 'left-edge' gives 'Left edge'. Anything that is not a string gives ''. */
export function regionLabel(name) {
  if (typeof name !== 'string') return ''
  if (!name) return ''
  const spaced = name.replace(/-/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** Plain dashboard data for a visual case. Null when the case is not a visual one. Never throws. */
export function visualView(c, { caseId } = {}) {
  try {
    const events = c.read()
    if (!Array.isArray(events) || events.length === 0) return null
    const opened = events.find(e => e?.type === 'case.opened')?.data ?? null
    if (!opened || opened.kind !== 'visual') return null

    const regionsEv = events.find(e => e?.type === 'visual.regions')?.data ?? null
    const regionsKnown = Boolean(regionsEv && Array.isArray(regionsEv.regions))
    const rawRegions = regionsKnown ? regionsEv.regions : []
    const anchorsFailed = Array.isArray(regionsEv?.anchorsFailed)
      ? regionsEv.anchorsFailed.filter(v => typeof v === 'string')
      : []

    const artOf = name => lastArtifactByName(events, name)
    const goodArt = artOf('good-picture.png')
    const candArt = artOf('candidate-picture.png')
    const parentArt = artOf('parent-picture.png')
    const firstArt = artOf('first-bad-picture.png')
    const pictures = {
      good: urlFor(caseId, goodArt),
      candidate: urlFor(caseId, candArt),
      parent: urlFor(caseId, parentArt),
      first: urlFor(caseId, firstArt),
    }

    const diffArts = []
    const regions = rawRegions.map(r => {
      const name = r?.name ?? ''
      const diffArt = typeof name === 'string' && name ? artOf(`diff-${name}.png`) : null
      if (diffArt) diffArts.push(diffArt)
      return {
        name,
        box: r?.box ?? null,
        changed: r?.inRegion ?? 0,
        floor: r?.floor ?? 0,
        differs: r?.above === true,
        diff: urlFor(caseId, diffArt),
      }
    })
    // The check draws ONE whole-picture diff and saves it once per region under the region's name, so the per-region
    // pictures are the same file. The page shows it once, with the regions outlined; `scale` maps a region box (CSS
    // pixels) onto that picture (device pixels).
    const diff = diffArts.length ? urlFor(caseId, diffArts[0]) : null
    const diffShared = diffArts.length > 0 && diffArts.every(a => a.hash === diffArts[0].hash)
    const scale = typeof regionsEv?.scale === 'number' && regionsEv.scale > 0 ? regionsEv.scale : 1

    const floorRaw = readJson(c, artOf('floor.json'))
    let floor = null
    if (floorRaw && typeof floorRaw === 'object') {
      if (typeof floorRaw.n === 'number' && typeof floorRaw.changed === 'number') {
        floor = { loads: floorRaw.n, changed: floorRaw.changed }
      } else if (floorRaw.n !== undefined || floorRaw.changed !== undefined) {
        floor = { loads: floorRaw.n ?? null, changed: floorRaw.changed ?? null }
      }
    }

    let summary = ''
    if (!regionsKnown) {
      summary = 'This report predates the region data; see the claims for the details.'
    } else {
      const differing = regions.filter(r => r.differs)
      if (differing.length > 0) {
        summary = `${differing.length} of ${regions.length} regions differ by more than the noise: ${differing.map(r => r.name).join(', ')}.`
      } else {
        summary = 'No region differs by more than the noise.'
      }
    }
    if (anchorsFailed.length > 0) {
      summary += ` The anchor regions ${anchorsFailed.join(', ')} also differ, so the app may be broken, not only changed.`
    }

    let search = null
    const bisectArt = artOf('bisect.json')
    if (bisectArt) {
      const parsed = readJson(c, bisectArt)
      const result = parsed && typeof parsed === 'object' ? parsed.result : null
      if (result && typeof result === 'object') {
        const found = result.conclusive === true
        let proven = false
        if (found && result.verified === true) {
          const claims = events.filter(e => e?.type === 'claim' && e?.data?.label === 'reproduced_failure')
          proven = claims.some(k => Array.isArray(k?.data?.evidence) && k.data.evidence.includes(bisectArt.hash))
        }
        search = {
          found,
          proven,
          commit: typeof result.commit === 'string' && result.commit ? result.commit : null,
          subject: result.subject ?? null,
          author: result.author ?? null,
          date: result.date ?? null,
          files: result.files ?? null,
          url: result.url ?? null,
          changes: result.changes ?? null,
          steps: result.steps ?? null,
        }
      } else {
        search = null
      }
    }

    return { kind: 'visual', regionsKnown, regions, anchorsFailed, pictures, diff, diffShared, scale, floor, summary, search }
  } catch {
    return null
  }
}
