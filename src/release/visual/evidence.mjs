// Visual check evidence: keep settled-picture comparisons region by region in the evidence store.
// Run: node --test src/release/visual/evidence.test.mjs
import { join } from 'node:path'
import { openCase } from '../evidence.mjs'
import { diffImage, scaleBox } from '../../senses/pixels.mjs'

const stampOf = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const cleanId = s => String(s).replace(/[^\w.-]/g, '_')

function shortSha(s) {
  return String(s ?? '').slice(0, 7)
}

/**
 * Record one visual comparison of two versions as a case.
 * Returns { caseId, outcome, ok }.
 */
export function recordVisualCase({
  evidenceRoot,
  profile,
  goodRef,
  candRef,
  goodSha,
  candSha,
  reference,
  candidate,
  floor,
  reports,
  bisect = null,
  region = null,
  anchors = null,
  now = new Date(),
}) {
  const name = profile?.name ?? 'app'
  const stamp = stampOf(now)
  const caseId = cleanId(`${stamp}_${name}-${goodRef}-vs-${candRef}`)
  const c = openCase(join(evidenceRoot, caseId))
  const runs = bisect?.runs ?? 3
  const above = (reports ?? []).filter(r => r.above)
  const scale = profile?.viewport?.deviceScaleFactor ?? 2
  const floorFor = n => floor?.regions?.[n] ?? 0
  const about = 'This check compares settled pictures of the two versions region by region against the measured noise of the older one. A difference means the pictures differ, not that something is a bug, and a person decides.'
  c.event('case.opened', {
    goodRef,
    candRef,
    goodSha,
    candSha,
    adapter: 'visual-' + name,
    kind: 'visual',
    steps: [],
    options: { bisect: Boolean(bisect), runs: 3 },
    scenario: { name: 'visual-' + name, label: `${name}, by picture`, about, upstream: null },
  })

  const goodH = c.artifact('good-picture.png', reference, 'image/png')
  const candH = c.artifact('candidate-picture.png', candidate, 'image/png')
  const floorH = c.artifact('floor.json', JSON.stringify(floor ?? { n: 0, changed: 0, regions: {} }), 'application/json')
  const diffH = {}
  for (const r of above) {
    const box = profile?.regions?.[r.name] ?? r.region
    const buf = box
      ? diffImage(reference, candidate, { region: scaleBox(box, scale) })
      : diffImage(reference, candidate)
    diffH[r.name] = c.artifact(`diff-${r.name}.png`, buf, 'image/png')
  }

  const n = floor?.n ?? 0
  const per = Object.entries(floor?.regions ?? {}).map(([k, v]) => `${k}: ${v}`).join(', ')
  c.claim('statistical', `Two loads of ${goodRef} differ by at most ${floor?.changed ?? 0} pixels over the whole picture (${n} loads). Per region: ${per || 'none'}.`, { evidence: [floorH] })

  for (const r of above) {
    const inRegion = r.inRegion ?? r.changed ?? 0
    c.claim('verified_fact', `Region "${r.name}" differs by ${inRegion} pixels between ${goodRef} and ${candRef} (floor for the region: ${floorFor(r.name)}).`, { evidence: [goodH, candH, diffH[r.name]] })
  }
  if (anchors && !anchors.ok && anchors.failed?.length) {
    c.claim('verified_fact', `Anchor regions also differ: ${anchors.failed.join(', ')}. The app may be broken, not only changed.`, { evidence: [goodH, candH] })
  }

  let failed = null
  if (bisect) {
    for (const e of bisect.events ?? []) c.event('bisect.' + e.type, e.data) // human addition after review: the report draws the search from these
    const log = Array.isArray(bisect.log) ? bisect.log : (Array.isArray(bisect.lines) ? bisect.lines : [])
    const bH = c.artifact('bisect.json', JSON.stringify({ result: stripBisect(bisect), log }), 'application/json')
    const bRegion = bisect.region ?? region ?? above[0]?.name ?? 'region'
    if (bisect.conclusive && bisect.verified) {
      const parentH = c.artifact('parent-picture.png', bisect.pictures.parent, 'image/png')
      const firstH = c.artifact('first-bad-picture.png', bisect.pictures.first, 'image/png')
      const commit = shortSha(bisect.commit)
      c.claim('reproduced_failure', `Region "${bRegion}": commit ${commit} (${bisect.subject ?? 'no subject'}) is the first change. The parent matched the good picture in ${runs} of ${runs} runs and the commit differed in ${runs} of ${runs} runs.`, { evidence: [bH, goodH, parentH, firstH] })
      const files = (bisect.files ?? []).slice(0, 6).join(', ') || 'no file list'
      c.claim('verified_fact', `Commit ${commit} touched: ${files}.`, { evidence: [bH] })
      failed = true
    } else if (bisect.conclusive) {
      c.claim('suspected_cause', `Region "${bRegion}": commit ${shortSha(bisect.commit)} looks first, but the runs were not clean, so it is not proven. See bisect.json.`, { evidence: [bH] })
    } else {
      const count = bisect.range?.length ?? 0
      c.claim('suspected_cause', `Region "${bRegion}": the first bad change is one of ${count} commits. See bisect.json.`, { evidence: [bH] })
    }
  }

  const outcome = failed ? 'regression proven' : above.length ? 'differences found' : 'no candidate defects'
  c.event('case.closed', { outcome, bisected: Boolean(bisect) })
  return { caseId, outcome, ok: c.verify().ok }
}

function stripBisect(b) {
  const out = {}
  for (const k of ['conclusive', 'verified', 'commit', 'parent', 'subject', 'author', 'date', 'files', 'url', 'changes', 'steps', 'seconds', 'region', 'range', 'runs']) {
    if (b[k] !== undefined) out[k] = b[k]
  }
  return out
}
