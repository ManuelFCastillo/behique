// services tests: catalog, validation, resolution, merge, describe, propose.
// Run: node --test src/release/sandbox/services.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CATALOG,
  validateServices,
  resolveServices,
  injectedEnv,
  describeServices,
  proposeServices
} from './services.mjs'

test('catalog has every field and health is an array of strings', () => {
  assert.deepEqual(Object.keys(CATALOG).sort(), ['mariadb', 'mongo', 'mysql', 'postgres', 'redis'])
  for (const kind of Object.keys(CATALOG)) {
    const c = CATALOG[kind]
    assert.equal(typeof c.image, 'string')
    assert.equal(typeof c.port, 'number')
    assert.equal(typeof c.env, 'object')
    assert.ok(Array.isArray(c.tmpfs))
    assert.ok(Array.isArray(c.caps))
    assert.ok(Array.isArray(c.health))
    assert.ok(c.health.length > 0)
    for (const h of c.health) assert.equal(typeof h, 'string')
    assert.ok(Array.isArray(c.cmd))
    for (const a of c.cmd) assert.equal(typeof a, 'string')
    assert.equal(typeof c.defaultVar, 'string')
    assert.equal(typeof c.url, 'function')
    assert.equal(typeof c.memoryMb, 'number')
    for (const cap of c.caps) {
      assert.ok(['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE', 'FOWNER'].includes(cap))
    }
  }
  assert.equal(CATALOG.postgres.image, 'postgres:16-alpine')
  assert.equal(CATALOG.mysql.image, 'mysql:8.4')
  assert.equal(CATALOG.mariadb.image, 'mariadb:11.4')
  assert.equal(CATALOG.redis.image, 'redis:7-alpine')
  assert.equal(CATALOG.mongo.image, 'mongo:7')
  assert.equal(CATALOG.postgres.port, 5432)
  assert.equal(CATALOG.redis.defaultVar, 'REDIS_URL')
  assert.equal(CATALOG.mongo.defaultVar, 'MONGODB_URI')
})

test('validateServices accepts good lists', () => {
  assert.deepEqual(validateServices([]), [])
  assert.deepEqual(validateServices([{ kind: 'postgres', name: 'db-one' }]), [])
  assert.deepEqual(validateServices([
    { kind: 'postgres', name: 'pg1', inject: { DATABASE_URL: 'url' } },
    { kind: 'redis', name: 'cache' }
  ]), [])
})

test('validateServices rejects bad cases', () => {
  assert.equal(validateServices('nope').length, 1)
  assert.ok(validateServices([
    { kind: 'postgres', name: 'a' },
    { kind: 'postgres', name: 'b' },
    { kind: 'redis', name: 'c' },
    { kind: 'mongo', name: 'd' },
    { kind: 'mysql', name: 'e' }
  ].map((x) => x)).length > 0)
  assert.ok(validateServices([{ kind: 'sqlite', name: 'a' }]).length > 0)
  assert.ok(validateServices([
    { kind: 'postgres', name: 'same' },
    { kind: 'redis', name: 'same' }
  ]).length > 0)
  assert.ok(validateServices([{ kind: 'redis', name: 'app' }]).length > 0)
  assert.ok(validateServices([{ kind: 'redis', name: 'cache', inject: { LD_PRELOAD: 'url' } }]).length > 0)
  assert.ok(validateServices([{ kind: 'redis', name: 'cache', inject: { REDIS_URL: 'nope' } }]).length > 0)
  assert.ok(validateServices([{ kind: 'redis', name: 'cache', extra: 1 }]).length > 0)
  assert.ok(validateServices('x')[0].length > 0)
  assert.ok(validateServices(null).length > 0)
})

test('resolveServices for each kind uses alias and default var', () => {
  const kinds = ['postgres', 'mysql', 'mariadb', 'redis', 'mongo']
  for (const kind of kinds) {
    const out = resolveServices([{ kind, name: kind + 'x' }], { runId: 'r1' })
    assert.equal(out.length, 1)
    const one = out[0]
    assert.equal(one.alias, kind + 'x')
    assert.equal(one.name, kind + 'x')
    assert.equal(one.kind, kind)
    assert.equal(one.image, CATALOG[kind].image)
    assert.equal(one.port, CATALOG[kind].port)
    const expectedUrl = CATALOG[kind].url(kind + 'x')
    assert.deepEqual(one.injected, { [CATALOG[kind].defaultVar]: expectedUrl })
  }
})

test('resolveServices inject for each value kind', () => {
  const out = resolveServices([{
    kind: 'postgres',
    name: 'pg1',
    inject: { A_URL: 'url', A_HOST: 'host', A_PORT: 'port', A_USER: 'user', A_PASS: 'password', A_DB: 'database' }
  }], { runId: 'abc' })
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].injected, {
    A_URL: CATALOG.postgres.url('pg1'),
    A_HOST: 'pg1',
    A_PORT: '5432',
    A_USER: 'behique',
    A_PASS: 'behique',
    A_DB: 'app'
  })
  const mysql = resolveServices([{ kind: 'mysql', name: 'm1', inject: { U: 'user', P: 'password' } }], { runId: 'abc' })
  assert.deepEqual(mysql[0].injected, { U: 'root', P: 'behique' })
  const redis = resolveServices([{ kind: 'redis', name: 'r1', inject: { U: 'user', P: 'password' } }], { runId: 'abc' })
  assert.deepEqual(redis[0].injected, { U: '', P: '' })
})

test('resolveServices is deterministic and rejects bad input', () => {
  const list = [{ kind: 'redis', name: 'c1' }]
  const a = resolveServices(list, { runId: 'r1' })
  const b = resolveServices([{ kind: 'redis', name: 'c1' }], { runId: 'r1' })
  assert.deepEqual(a, b)
  assert.deepEqual(resolveServices([{ kind: 'nope', name: 'x' }], { runId: 'r1' }), [])
  assert.deepEqual(resolveServices([{ kind: 'redis', name: 'x' }], { runId: '' }), [])
  assert.deepEqual(resolveServices([{ kind: 'redis', name: 'x' }], {}), [])
})

test('injectedEnv merges with later winning and does not mutate', () => {
  const resolved = resolveServices([
    { kind: 'postgres', name: 'pg1' },
    { kind: 'redis', name: 'r1', inject: { DATABASE_URL: 'url' } }
  ], { runId: 'r1' })
  const before = JSON.stringify(resolved)
  const merged = injectedEnv(resolved)
  assert.equal(merged.DATABASE_URL, CATALOG.redis.url('r1'))
  assert.equal(merged.REDIS_URL, undefined)
  assert.equal(JSON.stringify(resolved), before)
  const m2 = injectedEnv([
    { injected: { A: '1', B: '1' } },
    { injected: { B: '2', C: '3' } }
  ])
  assert.deepEqual(m2, { A: '1', B: '2', C: '3' })
})

test('describeServices lines', () => {
  const lines = describeServices([
    { kind: 'postgres', name: 'pg1' },
    { kind: 'redis', name: 'c1', inject: { B_URL: 'url', A_URL: 'host' } },
    { kind: 'nope', name: 'x' }
  ])
  assert.equal(lines.length, 2)
  assert.equal(lines[0], 'service: postgres (postgres:16-alpine) as pg1, injects DATABASE_URL')
  assert.equal(lines[1], 'service: redis (redis:7-alpine) as c1, injects A_URL, B_URL')
})

test('proposeServices finds DATABASE_URL postgres in env example', () => {
  const { services, evidence } = proposeServices({
    envExample: { file: '.env.example', lines: ['DATABASE_URL=postgresql://user:pass@localhost:5432/db'] },
    compose: null,
    packageJson: null
  })
  assert.equal(services.length, 1)
  assert.equal(services[0].kind, 'postgres')
  assert.deepEqual(services[0].inject, { DATABASE_URL: 'url' })
  assert.equal(evidence.length, 1)
  assert.ok(evidence[0].includes('.env.example'))
  assert.ok(evidence[0].includes('DATABASE_URL'))
  assert.deepEqual(validateServices(services), [])
})

test('proposeServices handles quoted value, export prefix, redis and mongosrv urls', () => {
  const q = proposeServices({
    envExample: { file: '.env.example', lines: ['DATABASE_URL="postgresql://u:p@localhost:5432/db"'] },
    compose: null,
    packageJson: null
  })
  assert.equal(q.services[0].kind, 'postgres')
  const e = proposeServices({
    envExample: { file: '.env.example', lines: ['export REDIS_URL=redis://localhost:6379'] },
    compose: null,
    packageJson: null
  })
  assert.equal(e.services[0].kind, 'redis')
  const m = proposeServices({
    envExample: { file: '.env.example', lines: ["MONGODB_URI='mongodb+srv://u:p@host/db'"] },
    compose: null,
    packageJson: null
  })
  assert.equal(m.services[0].kind, 'mongo')
  assert.deepEqual(validateServices(m.services), [])
})

test('proposeServices keeps two postgres keys', () => {
  const { services } = proposeServices({
    envExample: { file: '.env.example', lines: ['A_URL=postgresql://a@localhost/db', 'B_URL=postgres://b@localhost/db'] },
    compose: null,
    packageJson: null
  })
  assert.equal(services.length, 1)
  assert.deepEqual(services[0].inject, { A_URL: 'url', B_URL: 'url' })
})

test('proposeServices compose postgres and redis, db alone proposes nothing', () => {
  const { services, evidence } = proposeServices({
    envExample: null,
    compose: { file: 'compose.yml', services: ['postgres', 'redis'] },
    packageJson: null
  })
  assert.deepEqual(services.map((s) => s.kind), ['postgres', 'redis'])
  assert.equal(evidence.length, 2)
  assert.deepEqual(validateServices(services), [])
  const none = proposeServices({
    envExample: null,
    compose: { file: 'compose.yml', services: ['db'] },
    packageJson: null
  })
  assert.deepEqual(none, { services: [], evidence: [] })
  const none2 = proposeServices({
    envExample: null,
    compose: { file: 'compose.yml', services: ['database'] },
    packageJson: null
  })
  assert.deepEqual(none2.services, [])
})

test('proposeServices dependencies give low confidence and env wins over compose and deps', () => {
  const dep = proposeServices({
    envExample: null,
    compose: null,
    packageJson: { dependencies: { pg: '^8.0.0' }, devDependencies: null }
  })
  assert.equal(dep.services.length, 1)
  assert.equal(dep.services[0].kind, 'postgres')
  assert.ok(dep.evidence[0].includes('package.json'))
  assert.ok(dep.evidence[0].includes('low'))
  const both = proposeServices({
    envExample: { file: '.env.example', lines: ['DATABASE_URL=postgresql://u@localhost/db'] },
    compose: { file: 'compose.yml', services: ['postgres'] },
    packageJson: { dependencies: { pg: '1' }, devDependencies: {} }
  })
  assert.equal(both.services.length, 1)
  assert.equal(both.evidence.length, 1)
  assert.ok(both.evidence[0].includes('.env.example'))
})

test('proposeServices empty or malformed facts give empty result and every proposal validates', () => {
  assert.deepEqual(proposeServices(null), { services: [], evidence: [] })
  assert.deepEqual(proposeServices('str'), { services: [], evidence: [] })
  assert.deepEqual(proposeServices(42), { services: [], evidence: [] })
  assert.deepEqual(proposeServices({}), { services: [], evidence: [] })
  assert.deepEqual(proposeServices({ envExample: 'x', compose: 7, packageJson: 'y' }), { services: [], evidence: [] })
  const combo = proposeServices({
    envExample: { file: '.env.example', lines: ['REDIS_URL=redis://localhost:6379', 'MONGODB_URI=mongodb://localhost:27017/app'] },
    compose: { file: 'compose.yml', services: ['MyRedis', 'irrelevant'] },
    packageJson: { dependencies: { mongoose: '1' }, devDependencies: { mysql2: '1' } }
  })
  assert.deepEqual(validateServices(combo.services), [])
})
