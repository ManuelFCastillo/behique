// Tests for toolchain pure helpers: package managers, shims, env templates.
//   node --test src/release/onboard/toolchain.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectPackageManager,
  installItem,
  withIgnoreScripts,
  shimFile,
  shimEnv,
  parseEnvExample,
  classifyEnvKey,
  safeEnv,
  describeEnv,
} from './toolchain.mjs'
import { ALLOWED_COMMANDS } from './profile.mjs'

describe('detectPackageManager', () => {
  it('prefers packageManager field with hash stripped', () => {
    assert.deepEqual(detectPackageManager({ packageManager: 'pnpm@9.1.0+sha512.abc' }), {
      name: 'pnpm',
      version: '9.1.0',
      source: 'packageManager field',
    })
  })
  it('reads field without hash', () => {
    assert.deepEqual(detectPackageManager({ packageManager: 'yarn@1.22.22' }), {
      name: 'yarn',
      version: '1.22.22',
      source: 'packageManager field',
    })
  })
  it('ignores unknown field names and falls back to lockfile', () => {
    assert.deepEqual(detectPackageManager({ packageManager: 'bunny@1.0.0', lockfile: 'yarn.lock' }), {
      name: 'yarn',
      version: null,
      source: 'lockfile',
    })
  })
  it('ignores bad field and uses default', () => {
    assert.deepEqual(detectPackageManager({ packageManager: 'not-a-manager' }), {
      name: 'npm',
      version: null,
      source: 'default',
    })
  })
  it('maps each lockfile', () => {
    assert.deepEqual(detectPackageManager({ lockfile: 'pnpm-lock.yaml' }), { name: 'pnpm', version: null, source: 'lockfile' })
    assert.deepEqual(detectPackageManager({ lockfile: 'yarn.lock' }), { name: 'yarn', version: null, source: 'lockfile' })
    assert.deepEqual(detectPackageManager({ lockfile: 'package-lock.json' }), { name: 'npm', version: null, source: 'lockfile' })
    assert.deepEqual(detectPackageManager({ lockfile: 'bun.lockb' }), { name: 'bun', version: null, source: 'lockfile' })
    assert.deepEqual(detectPackageManager({ lockfile: 'bun.lock' }), { name: 'bun', version: null, source: 'lockfile' })
  })
  it('detects bun field', () => {
    assert.deepEqual(detectPackageManager({ packageManager: 'bun@1.1.0' }), {
      name: 'bun',
      version: '1.1.0',
      source: 'default'.replace('default', 'packageManager field'),
    })
  })
  it('returns npm default', () => {
    assert.deepEqual(detectPackageManager({}), { name: 'npm', version: null, source: 'default' })
    assert.deepEqual(detectPackageManager(), { name: 'npm', version: null, source: 'default' })
  })
  it('field wins over lockfile', () => {
    const got = detectPackageManager({ packageManager: 'npm@10.0.0', lockfile: 'yarn.lock' })
    assert.equal(got.name, 'npm')
    assert.equal(got.source, 'packageManager field')
  })
})

describe('installItem', () => {
  it('npm uses ci with lockfile and install without', () => {
    assert.deepEqual(installItem({ name: 'npm', version: null, source: 'default' }), { cmd: 'npm', args: ['ci', '--ignore-scripts'] })
    assert.deepEqual(installItem({ name: 'npm', version: null }, { hasLockfile: false }), { cmd: 'npm', args: ['install', '--ignore-scripts'] })
    assert.deepEqual(installItem({ name: 'npm', version: null }, { ignoreScripts: false }), { cmd: 'npm', args: ['ci'] })
  })
  it('pnpm frozen lockfile handling', () => {
    assert.deepEqual(installItem({ name: 'pnpm', version: '9.1.0' }), { cmd: 'pnpm', args: ['install', '--frozen-lockfile', '--ignore-scripts'] })
    assert.deepEqual(installItem({ name: 'pnpm', version: null }, { hasLockfile: false }), { cmd: 'pnpm', args: ['install', '--ignore-scripts'] })
    assert.deepEqual(installItem({ name: 'pnpm', version: null }, { ignoreScripts: false }), { cmd: 'pnpm', args: ['install', '--frozen-lockfile'] })
  })
  it('yarn 1 uses frozen lockfile', () => {
    assert.deepEqual(installItem({ name: 'yarn', version: '1.22.22' }), { cmd: 'yarn', args: ['install', '--frozen-lockfile', '--ignore-scripts'] })
    assert.deepEqual(installItem({ name: 'yarn', version: '1.22.22' }, { ignoreScripts: false }), { cmd: 'yarn', args: ['install', '--frozen-lockfile'] })
  })
  it('yarn 3 and 4 use immutable and skip-build', () => {
    assert.deepEqual(installItem({ name: 'yarn', version: '3.6.0' }), { cmd: 'yarn', args: ['install', '--immutable', '--mode=skip-build'] })
    assert.deepEqual(installItem({ name: 'yarn', version: '4.1.0' }), { cmd: 'yarn', args: ['install', '--immutable', '--mode=skip-build'] })
    assert.deepEqual(installItem({ name: 'yarn', version: '3.6.0' }, { ignoreScripts: false }), { cmd: 'yarn', args: ['install', '--immutable'] })
  })
  it('yarn unknown version behaves like yarn 1', () => {
    assert.deepEqual(installItem({ name: 'yarn', version: null }), { cmd: 'yarn', args: ['install', '--frozen-lockfile', '--ignore-scripts'] })
    assert.deepEqual(installItem({ name: 'yarn', version: 'berry' }, { hasLockfile: false }), { cmd: 'yarn', args: ['install', '--frozen-lockfile', '--ignore-scripts'] })
  })
  it('bun gives null', () => {
    assert.equal(installItem({ name: 'bun', version: null }), null)
  })
  it('every returned command is allowed', () => {
    const pms = [
      { name: 'npm', version: null },
      { name: 'pnpm', version: '9.0.0' },
      { name: 'yarn', version: '1.22.22' },
      { name: 'yarn', version: '3.6.0' },
      { name: 'yarn', version: null },
    ]
    for (const pm of pms) {
      for (const hasLockfile of [true, false]) {
        for (const ignoreScripts of [true, false]) {
          const item = installItem(pm, { hasLockfile, ignoreScripts })
          assert.ok(item)
          assert.ok(ALLOWED_COMMANDS.includes(item.cmd), `cmd ${item.cmd} not allowed`)
          assert.ok(item.cmd !== 'bun')
        }
      }
    }
  })
})

describe('withIgnoreScripts', () => {
  it('adds flag for npm install', () => {
    const before = { cmd: 'npm', args: ['ci'] }
    const after = withIgnoreScripts(before)
    assert.deepEqual(after, { cmd: 'npm', args: ['ci', '--ignore-scripts'] })
    assert.deepEqual(before, { cmd: 'npm', args: ['ci'] })
    assert.notEqual(after, before)
    assert.notEqual(after.args, before.args)
  })
  it('adds flag for pnpm and yarn', () => {
    assert.deepEqual(withIgnoreScripts({ cmd: 'pnpm', args: ['install'] }), { cmd: 'pnpm', args: ['install', '--ignore-scripts'] })
    assert.deepEqual(withIgnoreScripts({ cmd: 'yarn', args: ['install', '--immutable'] }), { cmd: 'yarn', args: ['install', '--immutable', '--ignore-scripts'] })
  })
  it('handles i and add verbs', () => {
    assert.deepEqual(withIgnoreScripts({ cmd: 'npm', args: ['i'] }).args, ['i', '--ignore-scripts'])
    assert.deepEqual(withIgnoreScripts({ cmd: 'npm', args: ['add', 'left-pad'] }).args, ['add', 'left-pad', '--ignore-scripts'])
  })
  it('leaves items with flags unchanged but copied', () => {
    const a = { cmd: 'npm', args: ['install', '--ignore-scripts'] }
    const b = withIgnoreScripts(a)
    assert.deepEqual(b, a)
    assert.notEqual(b, a)
    assert.notEqual(b.args, a.args)
    const c = { cmd: 'yarn', args: ['install', '--immutable', '--mode=skip-build'] }
    assert.deepEqual(withIgnoreScripts(c), c)
  })
  it('leaves non install verbs and other commands alone', () => {
    const a = { cmd: 'npm', args: ['run', 'build'] }
    assert.deepEqual(withIgnoreScripts(a), a)
    assert.notEqual(withIgnoreScripts(a), a)
    const d = { cmd: 'node', args: ['install'] }
    assert.deepEqual(withIgnoreScripts(d), d)
  })
})

describe('shimFile and shimEnv', () => {
  it('shimFile for yarn and pnpm only', () => {
    assert.deepEqual(shimFile('yarn'), { name: 'yarn', content: '#!/bin/sh\nexec corepack yarn "$@"\n' })
    assert.deepEqual(shimFile('pnpm'), { name: 'pnpm', content: '#!/bin/sh\nexec corepack pnpm "$@"\n' })
    assert.equal(shimFile('npm'), null)
    assert.equal(shimFile('bun'), null)
    assert.equal(shimFile('node'), null)
  })
  it('shimEnv with old PATH', () => {
    const base = { PATH: '/usr/bin', FOO: '1' }
    const got = shimEnv('/shims', base)
    assert.equal(got.PATH, '/shims:/usr/bin')
    assert.equal(got.COREPACK_ENABLE_DOWNLOAD_PROMPT, '0')
    assert.equal(got.FOO, '1')
    assert.deepEqual(base, { PATH: '/usr/bin', FOO: '1' })
  })
  it('shimEnv without old PATH', () => {
    const base = {}
    const got = shimEnv('/shims', base)
    assert.equal(got.PATH, '/shims')
    assert.equal(got.COREPACK_ENABLE_DOWNLOAD_PROMPT, '0')
    assert.deepEqual(base, {})
  })
})

describe('parseEnvExample', () => {
  it('parses comments, export, quotes, trailing comments, duplicates, bad keys', () => {
    const text = [
      '# a comment',
      '',
      'PORT=3000',
      'export HOST_NAME=example # trailing comment',
      'QUOTED="hello world"',
      "SINGLE='hi # not a comment'",
      'SPACED=val # comment here',
      'EMPTY=',
      'PORT=4000',
      '9BAD=oops',
      'NOEQUALS',
      '   # indented comment',
    ].join('\n')
    const got = parseEnvExample(text)
    assert.deepEqual(got, [
      { key: 'PORT', example: '3000' },
      { key: 'HOST_NAME', example: 'example' },
      { key: 'QUOTED', example: 'hello world' },
      { key: 'SINGLE', example: 'hi # not a comment' },
      { key: 'SPACED', example: 'val' },
      { key: 'EMPTY', example: '' },
    ])
  })
  it('accepts an array of lines', () => {
    const got = parseEnvExample(['A=1', '# skip', '', 'B=2'])
    assert.deepEqual(got, [{ key: 'A', example: '1' }, { key: 'B', example: '2' }])
  })
})

describe('classifyEnvKey', () => {
  const table = [
    ['DATABASE_URL', 'postgres://x', 'database'],
    ['POSTGRES_PASSWORD', 'x', 'secret'],
    ['MYSQL_HOST', 'x', 'database'],
    ['MARIADB_URL', 'x', 'database'],
    ['MONGO_URI', 'x', 'database'],
    ['REDIS_URL', 'redis://x', 'database'],
    ['DB_PATH', '/tmp/x', 'database'],
    ['STRIPE_SECRET_KEY', 'x', 'secret'],
    ['NEXTAUTH_SECRET', 'x', 'secret'],
    ['GITHUB_TOKEN', 'x', 'secret'],
    ['AWS_ACCESS_KEY', 'x', 'secret'],
    ['SENTRY_DSN', 'x', 'secret'],
    ['APIKEY_VALUE', 'x', 'secret'],
    ['CLIENT_ID', 'x', 'secret'],
    ['WEBHOOK_URL', 'x', 'secret'],
    ['PRIVATE_KEY', 'x', 'secret'],
    ['MY_PASSWD', 'x', 'secret'],
    ['PORT', '3000', 'port'],
    ['ADMIN_PORT', '3001', 'port'],
    ['NEXT_PUBLIC_BASE_URL', 'http://x', 'url'],
    ['APP_ORIGIN', 'http://x', 'url'],
    ['API_ENDPOINT', 'http://x', 'url'],
    ['CDN_HOST', 'example.com', 'url'],
    ['SERVICE_URI', 'http://x', 'url'],
    ['DEBUG', 'true', 'flag'],
    ['VERBOSE', 'OFF', 'flag'],
    ['COUNT', '1', 'flag'],
    ['NODE_ENV', 'development', 'plain'],
    ['LOG_LEVEL', 'info', 'plain'],
    ['SQLITE_PATH', '/tmp/db.sqlite', 'plain'],
  ]
  for (const [key, example, want] of table) {
    it(`${key}=${example} is ${want}`, () => {
      assert.equal(classifyEnvKey(key, example), want)
    })
  }
  it('a database password is a credential, not just a database', () => {
      assert.equal(classifyEnvKey('POSTGRES_PASSWORD', 'x'), 'secret')
      assert.equal(classifyEnvKey('DATABASE_URL', 'postgres://x'), 'database')
    })
  it('sqlite falls through', () => {
    assert.equal(classifyEnvKey('SQLITE_PATH', '/tmp/a'), 'plain')
  })
})

describe('safeEnv', () => {
  it('blocks database, secret and remote urls and never leaks values', () => {
    const entries = [
      { key: 'DATABASE_URL', example: 'postgres://db.example.com:5432/app' },
      { key: 'STRIPE_SECRET_KEY', example: 'sk-live-123' },
      { key: 'API_URL', example: 'https://api.example.com/v1' },
      { key: 'PORT', example: '3000' },
      { key: 'LOCAL_URL', example: 'http://localhost:3000/api' },
      { key: 'DEBUG', example: 'true' },
      { key: 'APP_NAME', example: 'demo' },
    ]
    const { env, blockers } = safeEnv(entries, { port: 4321 })
    assert.equal(env.PORT, '4321')
    assert.equal(env.DEBUG, 'true')
    assert.equal(env.APP_NAME, 'demo')
    assert.equal(env.LOCAL_URL, 'http://localhost:4321/api')
    const dumped = JSON.stringify(env)
    assert.ok(!dumped.includes('postgres://db.example.com'))
    assert.ok(!dumped.includes('sk-live-123'))
    assert.ok(!dumped.includes('api.example.com'))
    const keys = blockers.map((b) => b.key)
    assert.deepEqual(keys, ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'API_URL'])
    assert.deepEqual(blockers[0], { key: 'DATABASE_URL', kind: 'database', needs: 'a database or other service' })
    assert.deepEqual(blockers[1], { key: 'STRIPE_SECRET_KEY', kind: 'secret', needs: 'a secret or credential' })
    assert.equal(blockers[2].kind, 'service')
  })
  it('leaves other port keys out and keeps localhost without port option', () => {
    const { env } = safeEnv(
      [
        { key: 'ADMIN_PORT', example: '9000' },
        { key: 'CALLBACK_URL', example: 'http://127.0.0.1:8080/hook' },
      ],
      {}
    )
    assert.ok(!('ADMIN_PORT' in env))
    assert.equal(env.CALLBACK_URL, 'http://127.0.0.1:8080/hook')
  })
  it('skips empty and long values and strips newlines', () => {
    const { env } = safeEnv([
      { key: 'EMPTY_ONE', example: '' },
      { key: 'LONG_ONE', example: 'x'.repeat(100) },
      { key: 'NICE', example: 'ok' },
      { key: 'SNEAKY', example: 'a\nb' },
    ])
    assert.ok(!('EMPTY_ONE' in env))
    assert.ok(!('LONG_ONE' in env))
    assert.equal(env.NICE, 'ok')
    assert.ok(!env.SNEAKY.includes('\n'))
  })
})

describe('describeEnv', () => {
  it('sorts keys and cuts values at 80 chars', () => {
    const lines = describeEnv({ ZEBRA: 'z', APPLE: 'a', LONG: 'x'.repeat(200) })
    assert.deepEqual(lines, [`env: APPLE=a`, `env: LONG=${'x'.repeat(80)}`, 'env: ZEBRA=z'])
  })
})

describe('credential-looking keys', () => {
  it('generic keys, salts and JWT settings are treated as credentials, never copied', () => {
  for (const k of ['ENCRYPTION_KEY', 'SESSION_KEY', 'KEY', 'PASSWORD_SALT', 'JWT_EXPIRES', 'AWS_CREDENTIALS']) assert.equal(classifyEnvKey(k, 'abc'), 'secret', k)
  const { env, blockers } = safeEnv([{ key: 'ENCRYPTION_KEY', example: 'changeme-changeme' }, { key: 'DEBUG', example: 'true' }], { port: 4000 })
  assert.deepEqual(env, { DEBUG: 'true' }); assert.equal(blockers[0].key, 'ENCRYPTION_KEY')
})
})
