// seed tests: validation, description, cp args, plan and summary. Offline only.
// Run: node --test src/release/sandbox/seed.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { SEED_FILE_EXT, validateSeeds, describeSeeds, cpArgs, seedPlan, seedSummary } from './seed.mjs'
import { resolveServices } from './services.mjs'
import { names } from './docker-args.mjs'

const RUN_ID = 'abc123'

function pgServices() {
  return [
    { kind: 'postgres', name: 'db' },
    { kind: 'redis', name: 'cache' }
  ]
}

test('SEED_FILE_EXT maps kinds to extensions', () => {
  assert.deepEqual(SEED_FILE_EXT, {
    postgres: '.sql',
    mysql: '.sql',
    mariadb: '.sql',
    mongo: '.js',
    redis: '.redis'
  })
})

test('validateSeeds accepts the example', () => {
  const list = [
    { service: 'db', file: 'db/seed.sql' },
    { service: 'cache', script: 'SET greeting hello' }
  ]
  assert.deepEqual(validateSeeds(list, pgServices()), [])
})

test('validateSeeds accepts undefined', () => {
  assert.deepEqual(validateSeeds(undefined, pgServices()), [])
})

test('validateSeeds refuses unknown key', () => {
  const problems = validateSeeds([{ service: 'db', file: 'db/seed.sql', extra: 1 }], pgServices())
  assert.ok(problems.length > 0)
})

test('validateSeeds refuses unknown service', () => {
  const problems = validateSeeds([{ service: 'nope', file: 'db/seed.sql' }], pgServices())
  assert.ok(problems.some((p) => p === 'seed 1: no service named "nope" in services'))
})

test('validateSeeds refuses both file and script', () => {
  const problems = validateSeeds([{ service: 'db', file: 'db/seed.sql', script: 'x' }], pgServices())
  assert.ok(problems.length > 0)
})

test('validateSeeds refuses neither file nor script', () => {
  const problems = validateSeeds([{ service: 'db' }], pgServices())
  assert.ok(problems.length > 0)
})

test('validateSeeds refuses .. in path', () => {
  const problems = validateSeeds([{ service: 'db', file: 'db/../seed.sql' }], pgServices())
  assert.ok(problems.length > 0)
})

test('validateSeeds refuses leading slash', () => {
  const problems = validateSeeds([{ service: 'db', file: '/db/seed.sql' }], pgServices())
  assert.ok(problems.length > 0)
})

test('validateSeeds refuses wrong extension', () => {
  const problems = validateSeeds([{ service: 'db', file: 'db/seed.js' }], pgServices())
  assert.ok(problems.includes('seed 1: a postgres seed must be a .sql file'))
})

test('validateSeeds refuses overlong script', () => {
  const problems = validateSeeds([{ service: 'db', script: 'x'.repeat(20001) }], pgServices())
  assert.ok(problems.length > 0)
})

test('validateSeeds refuses more than 10', () => {
  const list = Array.from({ length: 11 }, () => ({ service: 'db', file: 'db/seed.sql' }))
  const problems = validateSeeds(list, pgServices())
  assert.ok(problems.length > 0)
})

test('validateSeeds addresses a service without name by kind', () => {
  const services = [{ kind: 'postgres' }]
  assert.deepEqual(validateSeeds([{ service: 'postgres', file: 'db/seed.sql' }], services), [])
})

test('describeSeeds covers both forms', () => {
  const list = [
    { service: 'db', file: 'db/seed.sql' },
    { service: 'cache', script: 'SET greeting hello' }
  ]
  const lines = describeSeeds(list, pgServices())
  assert.equal(lines[0], 'seed: db (postgres) from db/seed.sql')
  assert.equal(lines[1], `seed: cache (redis) from an inline script (${'SET greeting hello'.length} characters)`)
})

test('cpArgs builds the argument list', () => {
  const container = names(RUN_ID, 'svc-db')
  const res = cpArgs({ runId: RUN_ID, short: 'svc-db', from: '/repo/db/seed.sql', to: '/seed/1.sql' })
  assert.equal(res.ok, true)
  assert.deepEqual(res.args, ['cp', '/repo/db/seed.sql', `${container}:/seed/1.sql`])
})

test('cpArgs refuses relative from', () => {
  const res = cpArgs({ runId: RUN_ID, short: 'svc-db', from: 'repo/db.sql', to: '/seed/1.sql' })
  assert.equal(res.ok, false)
  assert.ok(typeof res.error === 'string')
})

test('cpArgs refuses a to outside /seed/', () => {
  const res = cpArgs({ runId: RUN_ID, short: 'svc-db', from: '/repo/db.sql', to: '/tmp/1.sql' })
  assert.equal(res.ok, false)
})

test('cpArgs refuses a bad run id', () => {
  const res = cpArgs({ runId: 'BAD!!', short: 'svc-db', from: '/repo/db.sql', to: '/seed/1.sql' })
  assert.equal(res.ok, false)
})

test('seedPlan for a postgres file seed', () => {
  const services = [{ kind: 'postgres', name: 'db' }]
  const resolved = resolveServices(services, { runId: RUN_ID })
  const list = [{ service: 'db', file: 'db/seed.sql' }]
  const plan = seedPlan(list, resolved, { runId: RUN_ID, checkoutDir: '/repo' })
  assert.equal(plan.ok, true)
  assert.equal(plan.steps.length, 1)
  const step = plan.steps[0]
  assert.equal(step.service, 'db')
  assert.equal(step.kind, 'postgres')
  assert.equal(step.to, '/seed/1.sql')
  assert.equal(step.short, 'svc-db')
  assert.deepEqual(step.source, { file: 'db/seed.sql' })
  const container = `bq-${RUN_ID}-svc-db`
  assert.deepEqual(step.cp.args, ['cp', '/repo/db/seed.sql', `${container}:/seed/1.sql`])
  assert.deepEqual(step.exec.args, ['exec', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'behique', '-d', 'app', '-f', '/seed/1.sql'])
})

test('seedPlan for an inline mongo script', () => {
  const services = [{ kind: 'mongo', name: 'm' }]
  const resolved = resolveServices(services, { runId: RUN_ID })
  const list = [{ service: 'm', script: 'db.foo.insertOne({})' }]
  const plan = seedPlan(list, resolved, { runId: RUN_ID, checkoutDir: '/repo' })
  assert.equal(plan.ok, true)
  const step = plan.steps[0]
  assert.equal(step.to, '/seed/1.js')
  assert.deepEqual(step.source, { script: 'db.foo.insertOne({})' })
  assert.deepEqual(step.cp, { ok: true, args: null, inline: true })
  const container = `bq-${RUN_ID}-svc-m`
  assert.deepEqual(step.exec.args, ['exec', container, 'mongosh', '--quiet', 'app', '/seed/1.js'])
})

test('seedPlan numbers to paths across seeds', () => {
  const services = [{ kind: 'postgres', name: 'db' }, { kind: 'redis', name: 'cache' }]
  const resolved = resolveServices(services, { runId: RUN_ID })
  const list = [
    { service: 'db', file: 'db/a.sql' },
    { service: 'cache', script: 'PING' }
  ]
  const plan = seedPlan(list, resolved, { runId: RUN_ID, checkoutDir: '/repo' })
  assert.equal(plan.ok, true)
  assert.equal(plan.steps[0].to, '/seed/1.sql')
  assert.equal(plan.steps[1].to, '/seed/2.redis')
})

test('seedPlan covers every kind', () => {
  // a profile may declare at most 4 services, so mariadb is checked on its own below
  const services = [
    { kind: 'postgres', name: 'pg' },
    { kind: 'mysql', name: 'my' },
    { kind: 'mongo', name: 'mo' },
    { kind: 'redis', name: 're' }
  ]
  const resolved = resolveServices(services, { runId: RUN_ID })
  assert.equal(resolved.length, 4)
  const exts = { pg: '/seed/1.sql', my: '/seed/2.sql', mo: '/seed/3.js', re: '/seed/4.redis' }
  const list = [
    { service: 'pg', file: 'a.sql' },
    { service: 'my', file: 'b.sql' },
    { service: 'mo', file: 'd.js' },
    { service: 're', file: 'e.redis' }
  ]
  const plan = seedPlan(list, resolved, { runId: RUN_ID, checkoutDir: '/repo' })
  assert.equal(plan.ok, true, plan.error)
  assert.equal(plan.steps[0].to, exts.pg)
  assert.equal(plan.steps[1].to, exts.my)
  assert.equal(plan.steps[2].to, exts.mo)
  assert.equal(plan.steps[3].to, exts.re)
  const byName = Object.fromEntries(plan.steps.map((s) => [s.service, s]))
  assert.ok(byName.pg.exec.args.includes('psql'))
  assert.ok(byName.my.exec.args.includes('mysql'))
  assert.ok(byName.my.exec.args.includes('-pbehique'))
  assert.ok(byName.mo.exec.args.includes('mongosh'))
  assert.ok(byName.re.exec.args.includes('sh'))
  const ma = seedPlan([{ service: 'ma', file: 'c.sql' }], resolveServices([{ kind: 'mariadb', name: 'ma' }], { runId: RUN_ID }), { runId: RUN_ID, checkoutDir: '/repo' })
  assert.equal(ma.ok, true, ma.error)
  assert.equal(ma.steps[0].to, '/seed/1.sql')
  assert.ok(ma.steps[0].exec.args.includes('mariadb'))
})

test('seedPlan reports a failing execArgs', () => {
  const services = [{ kind: 'postgres', name: 'db' }]
  const resolved = resolveServices(services, { runId: RUN_ID })
  const list = [{ service: 'db', file: 'db/seed.sql' }]
  const plan = seedPlan(list, resolved, { runId: 'BAD!!', checkoutDir: '/repo' })
  assert.equal(plan.ok, false)
  assert.ok(plan.error.includes('seed 1:'))
})

test('seedPlan reports an invalid list', () => {
  const services = [{ kind: 'postgres', name: 'db' }]
  const resolved = resolveServices(services, { runId: RUN_ID })
  const plan = seedPlan([{ service: 'missing', file: 'db/seed.sql' }], resolved, { runId: RUN_ID, checkoutDir: '/repo' })
  assert.equal(plan.ok, false)
  assert.ok(plan.error.includes('no service named'))
})

test('seedPlan uses resolved short when present', () => {
  const resolved = [{ kind: 'postgres', name: 'db', short: 'svc-db', env: { POSTGRES_USER: 'behique', POSTGRES_DB: 'app' } }]
  const plan = seedPlan([{ service: 'db', file: 'db/seed.sql' }], resolved, { runId: RUN_ID, checkoutDir: '/repo' })
  assert.equal(plan.ok, true)
  assert.equal(plan.steps[0].short, 'svc-db')
})

test('seedSummary for all ok', () => {
  const steps = [{ service: 'db' }, { service: 'cache' }]
  const out = seedSummary(steps, [{ ok: true }, { ok: true }])
  assert.equal(out, 'seeded 2 of 2: db ok, cache ok')
})

test('seedSummary for one failure uses first line', () => {
  const steps = [{ service: 'db' }, { service: 'cache' }]
  const out = seedSummary(steps, [{ ok: true }, { ok: false, error: 'boom\nsecond line' }])
  assert.equal(out, 'seeded 1 of 2: db ok, cache FAILED (boom)')
})

test('seedSummary for no steps', () => {
  assert.equal(seedSummary([], []), 'nothing to seed')
})
