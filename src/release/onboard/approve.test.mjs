// Run: node --test src/release/onboard/approve.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scopedApprove } from './approve.mjs'

const before = ['install: pnpm install', 'install: pnpm run build', 'serve: pnpm run start -- -p {port}']

describe('scopedApprove', () => {
  it('allows new arguments for a program that was already approved', () => {
    const r = scopedApprove({ added: ['serve: pnpm run start'], approvedLines: before })
    assert.equal(r.ok, true); assert.equal(r.refused.length, 0); assert.match(r.reasons[0], /same program/)
  })
  it('allows env and service lines', () => {
    const r = scopedApprove({ added: ['env: PORT={port}', 'service: postgres (postgres:16-alpine) as db, injects DATABASE_URL'], approvedLines: before })
    assert.equal(r.ok, true); assert.equal(r.reasons.length, 2)
  })
  it('refuses a new program', () => {
    const r = scopedApprove({ added: ['install: yarn install'], approvedLines: before })
    assert.equal(r.ok, false); assert.match(r.refused[0], /new program: yarn/)
  })
  it('refuses anything that downloads and runs packages or turns scripts on, even for an approved program', () => {
    assert.equal(scopedApprove({ added: ['serve: pnpm dlx http-server (downloads and runs packages from the internet)'], approvedLines: before }).ok, false)
    assert.equal(scopedApprove({ added: ["installs run the repository's own lifecycle scripts (downloads and runs code from the internet)"], approvedLines: before }).ok, false)
  })
  it('refuses a line it does not recognise, and one refusal refuses the lot', () => {
    assert.equal(scopedApprove({ added: ['rm -rf /'], approvedLines: before }).ok, false)
    const r = scopedApprove({ added: ['serve: pnpm run dev', 'install: bun install'], approvedLines: before })
    assert.equal(r.ok, false); assert.equal(r.reasons.length, 1); assert.equal(r.refused.length, 1)
  })
  it('never throws on odd input', () => {
    assert.equal(scopedApprove().ok, true)
    assert.equal(scopedApprove({ added: [null, 5] }).ok, false)
  })
})
