// Find the first commit where a region stops matching the good version.
// Run: node --test src/release/visual/visual-bisect.test.mjs
import { startBuild as defaultStartBuild } from '../build.mjs'
import { bisect as defaultBisect } from '../bisect.mjs'
import { anchorsOk, measureFloor as defaultFloor, pictureOf as defaultPicture, regionReport } from './picture.mjs'

const firstLine = s => String(s ?? '').split('\n').find(l => l.trim())?.trim().slice(0, 100) ?? ''

/**
 * Bisect a visual difference in one named region.
 * Returns the bisect result plus the noise floor, the reference picture and evidence pictures.
 */
export async function visualBisect({
  adapter,
  profile,
  goodRef,
  badRef,
  region,
  port = 8300,
  runs = 3,
  loads = 3,
  log = () => {},
  onEvent = () => {},
  deps = {},
}) {
  const startBuildFn = deps.startBuildFn ?? defaultStartBuild
  const pictureFn = deps.pictureFn ?? defaultPicture
  const floorFn = deps.floorFn ?? defaultFloor
  const bisectFn = deps.bisectFn ?? defaultBisect
  const box = profile?.regions?.[region]
  if (!box) throw new Error(`unknown region "${region}": profile has regions ${Object.keys(profile?.regions ?? {}).join(', ') || '(none)'}`)
  const scale = profile?.viewport?.deviceScaleFactor ?? 2
  const anchors = profile?.anchors ?? {}

  // Reference: build goodRef, picture it, measure the noise floor, then stop the build.
  let reference
  {
    const build = await startBuildFn({ adapter, ref: goodRef, port })
    try {
      const pic = await pictureFn(build.base, profile)
      if (!pic.settled) throw new Error(`good version ${goodRef} did not settle, cannot use it as a reference`)
      const floor = await floorFn(build.base, profile, { loads })
      reference = { png: pic.png, floor }
    } finally {
      await build.stop()
    }
  }
  const { png: refPng, floor } = reference

  // Is there anything to find? Build and picture badRef.
  let badPng
  {
    const build = await startBuildFn({ adapter, ref: badRef, port })
    try {
      const pic = await pictureFn(build.base, profile)
      if (!pic.settled) throw new Error(`candidate ${badRef} did not settle, cannot tell if it changed`)
      badPng = pic.png
    } finally {
      await build.stop()
    }
  }
  const anchorCheck = anchorsOk(refPng, badPng, anchors, { floor, scale })
  if (!anchorCheck.ok) {
    throw new Error(`candidate ${badRef} looks broken, not changed in region "${region}" (anchor ${anchorCheck.failed[0]} differs), so there is nothing to bisect in that region`)
  }
  const badReport = regionReport(refPng, badPng, region, box, { floor, scale: profile?.viewport?.deviceScaleFactor })
  if (!badReport.above) {
    throw new Error(`there is no difference in region "${region}" between ${goodRef} and ${badRef} beyond the noise, so there is nothing to bisect`)
  }

  async function test({ ref }) {
    let build
    try {
      build = await startBuildFn({ adapter, ref, port })
    } catch (e) {
      return { verdict: 'skip', why: 'build failed: ' + firstLine(e.message) }
    }
    try {
      const pic = await pictureFn(build.base, profile)
      if (!pic.settled) return { verdict: 'skip', why: 'page did not settle' }
      const a = anchorsOk(refPng, pic.png, anchors, { floor, scale })
      if (!a.ok) return { verdict: 'skip', why: `app looks broken (anchor ${a.failed[0]} differs)` }
      const r = regionReport(refPng, pic.png, region, box, { floor, scale })
      return r.above ? { verdict: 'bad', why: `region ${region} differs` } : { verdict: 'good' }
    } finally {
      await build.stop()
    }
  }

  const result = await bisectFn({ adapter, goodRef, badRef, dir: '', id: region, port, runs, log, onEvent, test })
  if (!result.conclusive) {
    return { ...result, region, floor, reference: refPng, pictures: null, reports: null }
  }

  async function pictureRef(ref) {
    const build = await startBuildFn({ adapter, ref, port })
    try {
      const pic = await pictureFn(build.base, profile)
      return pic.png
    } finally {
      await build.stop()
    }
  }
  const parentPng = await pictureRef(result.parent)
  const firstPng = await pictureRef(result.commit)
  const parentReport = regionReport(refPng, parentPng, region, box, { floor, scale })
  const firstReport = regionReport(refPng, firstPng, region, box, { floor, scale })
  return {
    ...result,
    region,
    floor,
    reference: refPng,
    pictures: { parent: parentPng, first: firstPng },
    reports: { parent: parentReport, first: firstReport },
  }
}
