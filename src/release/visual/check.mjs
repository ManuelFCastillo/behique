// Compare two versions of a profiled app by picture, optionally bisect, keep the case in the evidence store.
// node src/release/visual/check.mjs <app> <goodRef> <candRef> [--region name] [--bisect] [--propose] [--ports 8301,8302] [--runs 3] [--loads 3]
// A profile with no regions gets regions PROPOSED from where the two pictures differ (regions.mjs); --propose also lists differences outside the named ones.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBuild as realStartBuild } from '../build.mjs'
import { loadProfile as realLoadProfile, profileToAdapter as realToAdapter } from '../onboard/profile.mjs'
import { anchorsOk, measureFloor as realFloor, pictureOf as realPicture, regionReport } from './picture.mjs'
import { visualBisect as realBisect } from './visual-bisect.mjs'
import { recordVisualCase as realRecord } from './evidence.mjs'
import { drawProposals, proposeRegions as realPropose, toProfileRegions } from './regions.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = join(HERE, '../../../out/evidence')
const USAGE = 'node src/release/visual/check.mjs <app> <goodRef> <candRef> [--region name] [--bisect] [--propose] [--ports 8301,8302] [--runs 3] [--loads 3]'
const PROPOSALS_DIR = join(HERE, '../../../out/onboard')

/** Leave the proposed regions where a person can look at them and approve them into the profile. */
function writeProposals(app, proposals, png, scale) {
  mkdirSync(PROPOSALS_DIR, { recursive: true })
  writeFileSync(join(PROPOSALS_DIR, `${app}.proposed-regions.json`), JSON.stringify(toProfileRegions(proposals.regions), null, 2))
  writeFileSync(join(PROPOSALS_DIR, `${app}.proposed-regions.png`), drawProposals(png, proposals.regions, { scale }))
  return join('out/onboard', `${app}.proposed-regions.json`)
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

export function parseArgs(argv) {
  const rest = argv.slice(2)
  const opts = { region: null, bisect: false, propose: false, ports: [8301, 8302], runs: 3, loads: 3 }
  const pos = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--region') {
      const v = rest[++i]
      if (!v) return { error: 'missing value for --region' }
      opts.region = v
    } else if (a === '--bisect') {
      opts.bisect = true
    } else if (a === '--propose') {
      opts.propose = true
    } else if (a === '--ports') {
      const v = rest[++i]
      if (!v) return { error: 'missing value for --ports' }
      opts.ports = v.split(',').map(s => Number(s.trim())).filter(v => Number.isInteger(v) && v > 0)
      if (!opts.ports.length) return { error: 'bad value for --ports' }
    } else if (a === '--runs') {
      const v = Number(rest[++i])
      if (!Number.isInteger(v) || v <= 0) return { error: 'bad value for --runs' }
      opts.runs = v
    } else if (a === '--loads') {
      const v = Number(rest[++i])
      if (!Number.isInteger(v) || v <= 0) return { error: 'bad value for --loads' }
      opts.loads = v
    } else if (a.startsWith('--')) {
      return { error: `unknown flag ${a}` }
    } else {
      pos.push(a)
    }
  }
  if (pos.length < 3) return { error: 'missing <app> <goodRef> <candRef>' }
  opts.app = pos[0]
  opts.goodRef = pos[1]
  opts.candRef = pos[2]
  return { opts }
}

/**
 * Run the visual check. Returns { code, lines, caseId, outcome }.
 */
export async function runCheck(options = {}, deps = {}) {
  const lines = []
  const loadProfile = deps.loadProfile ?? realLoadProfile
  const toAdapter = deps.profileToAdapter ?? realToAdapter
  const startBuildFn = deps.startBuildFn ?? realStartBuild
  const pictureFn = deps.pictureFn ?? realPicture
  const floorFn = deps.floorFn ?? realFloor
  const bisectFn = deps.visualBisectFn ?? realBisect
  const recordFn = deps.recordVisualCase ?? realRecord
  const proposeFn = deps.proposeRegions ?? realPropose
  const saveProposals = deps.writeProposals ?? writeProposals
  const evidenceRoot = deps.evidenceRoot ?? DEFAULT_ROOT
  const now = deps.now ?? new Date()
  const { app, goodRef, candRef } = options
  if (!app || !goodRef || !candRef) {
    return { code: 2, lines: [`usage: ${USAGE}`, 'missing <app> <goodRef> <candRef>'], caseId: null, outcome: null }
  }
  const regionOpt = options.region ?? null
  const wantBisect = Boolean(options.bisect)
  const ports = options.ports ?? [8301, 8302]
  const runs = options.runs ?? 3
  const loads = options.loads ?? 3

  let profile
  try {
    profile = loadProfile(app)
  } catch (e) {
    return { code: 2, lines: [`usage: ${USAGE}`, String(e.message)], caseId: null, outcome: null }
  }
  const adapter = toAdapter(profile)
  const scale = profile?.viewport?.deviceScaleFactor ?? 2

  const hasRegions = Object.keys(profile?.regions ?? {}).length > 0
  const wantProposals = !hasRegions || Boolean(options.propose)
  let goodBuild = null
  let candBuild = null
  let goodPng = null
  let candPng = null
  let floor = null
  let proposals = null
  let effProfile = profile
  try {
    goodBuild = await startBuildFn({ adapter, ref: goodRef, port: ports[0] ?? 8301 })
    candBuild = await startBuildFn({ adapter, ref: candRef, port: ports[1] ?? 8302 })
    const goodPic = await pictureFn(goodBuild.base, profile)
    if (!goodPic.settled) {
      lines.push(`good version ${goodRef} did not settle, cannot compare`)
      return { code: 1, lines, caseId: null, outcome: null }
    }
    const candPic = await pictureFn(candBuild.base, profile)
    if (!candPic.settled) {
      lines.push(`candidate ${candRef} did not settle, cannot compare`)
      return { code: 1, lines, caseId: null, outcome: null }
    }
    goodPng = goodPic.png
    candPng = candPic.png
    if (wantProposals) {
      // a second picture of the GOOD version: pixels that differ between the two are noise, never a difference to propose
      let noise = null
      try { const again = await pictureFn(goodBuild.base, profile); if (again.settled) noise = again.png } catch {}
      proposals = proposeFn(goodPng, candPng, { scale, noisePngs: noise ? [noise] : [] })
      if (!hasRegions && proposals.regions.length) effProfile = { ...profile, regions: toProfileRegions(proposals.regions) }
    }
    floor = await floorFn(goodBuild.base, effProfile, { loads })
  } finally {
    if (goodBuild) await goodBuild.stop().catch(() => {})
    if (candBuild) await candBuild.stop().catch(() => {})
  }
  if (!goodPng || !candPng || !floor) {
    lines.push('could not take settled pictures')
    return { code: 1, lines, caseId: null, outcome: null }
  }

  const reports = []
  // human addition after review: with no regions in the profile nothing would be compared and the case would say "no candidate defects",
  // which is false assurance. Compare proposed regions, or the whole picture when the two pictures do not differ anywhere.
  const vp = profile?.viewport ?? { width: 1280, height: 800 }
  let regionsToCompare = effProfile.regions
  if (!hasRegions) {
    if (proposals?.regions.length) {
      lines.push(`the profile has no regions, so ${proposals.regions.length} were proposed from where the two pictures differ (not approved by a person): ${proposals.regions.map(r => r.name).join(', ')}`)
    } else {
      regionsToCompare = { 'whole picture': { x: 0, y: 0, w: vp.width, h: vp.height } }
      lines.push('the profile has no regions, so the whole picture is compared')
    }
  }
  if (proposals?.regions.length && (!hasRegions || options.propose)) {
    if (hasRegions) {
      const outside = proposals.regions.filter(r => !Object.values(profile.regions).some(b => overlaps(r.box, b)))
      lines.push(outside.length ? `also differs outside the named regions: ${outside.map(r => `${r.name} (${r.changed} pixels)`).join(', ')}` : 'no difference outside the named regions')
    }
    try { lines.push(`proposed regions saved for a person to review: ${saveProposals(app, proposals, candPng, scale)}`) } catch (e) { lines.push(`could not save the proposed regions: ${String(e.message).split('\n')[0]}`) }
  }
  for (const [rname, box] of Object.entries(regionsToCompare)) {
    const r = regionReport(goodPng, candPng, rname, box, { floor, scale })
    reports.push(r)
    lines.push(`region ${rname}: ${r.inRegion} pixels (floor ${floor?.regions?.[rname] ?? 0}) ${r.above ? 'above' : 'within noise'}`)
  }
  let anchorRes = null
  if (profile?.anchors && Object.keys(profile.anchors).length) {
    anchorRes = anchorsOk(goodPng, candPng, profile.anchors, { floor, scale })
    if (!anchorRes.ok) lines.push(`anchors differ: ${anchorRes.failed.join(', ')}`)
  }

  let bisect = null
  const bisectLog = [], bisectEvents = []
  let bisectRegion = regionOpt
  let code = 0
  if (wantBisect) {
    if (!bisectRegion) {
      bisectRegion = reports.find(r => r.above)?.name ?? null
      if (!bisectRegion) {
        lines.push('nothing to bisect: no region is above the floor')
      }
    }
    if (bisectRegion) {
      try {
        bisect = await bisectFn({
          adapter,
          profile: effProfile,
          goodRef,
          badRef: candRef,
          region: bisectRegion,
          port: ports[0] ?? 8301,
          runs,
          loads,
          log: l => { lines.push(String(l)); bisectLog.push(String(l)) },
          onEvent: (type, data) => bisectEvents.push({ type, data }),
        })
        bisect = { ...bisect, log: bisectLog, events: bisectEvents } // human addition after review: the record needs the search steps
      } catch (e) {
        lines.push(`bisect failed: ${String(e.message).split('\n')[0]}`)
        bisect = null
        code = 1
      }
    }
  }

  const rec = recordFn({
    evidenceRoot,
    profile: effProfile,
    goodRef,
    candRef,
    goodSha: goodBuild?.sha ?? goodRef,
    candSha: candBuild?.sha ?? candRef,
    reference: goodPng,
    candidate: candPng,
    floor,
    reports,
    bisect,
    region: bisectRegion,
    anchors: anchorRes,
    now,
  })
  lines.push(`case ${rec.caseId}`)
  lines.push(`outcome: ${rec.outcome}`)
  lines.push(`See it at /report?case=${rec.caseId} on the demo server.`)
  return { code, lines, caseId: rec.caseId, outcome: rec.outcome }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  const parsed = parseArgs(process.argv)
  if (parsed.error) {
    console.log(`usage: ${USAGE}`)
    console.log(parsed.error)
    process.exitCode = 2
  } else {
    const out = await runCheck(parsed.opts, {})
    for (const l of out.lines) console.log(l)
    process.exitCode = out.code
  }
}
