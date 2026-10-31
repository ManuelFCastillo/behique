// cache tests: offline, pure decisions and argv builders only.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CACHE_REPO,
  cacheKey,
  cacheImage,
  isCacheKey,
  isCacheImage,
  parseCacheImage,
  committerArgs,
  commitArgs,
  cacheListArgs,
  parseCacheList,
  cacheInspectArgs,
  cacheRemoveArgs,
  prunePlan,
  hitPlan
} from './cache.mjs'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const IMAGE = 'node:22-bookworm'

function baseInput(over = {}) {
  return {
    app: 'nextjs-blog',
    sha: SHA,
    image: IMAGE,
    installs: [{ cmd: 'npm', args: ['ci'] }],
    allowScripts: false,
    root: undefined,
    services: [],
    ...over
  }
}

describe('cacheKey', () => {
  it('is stable for the same input', () => {
    const a = cacheKey(baseInput())
    const b = cacheKey(baseInput())
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    assert.equal(a.key, b.key)
    assert.equal(a.fingerprint, b.fingerprint)
    assert.match(a.key, /^[a-z0-9-]+-[0-9a-f]{12}-[0-9a-f]{8}$/)
  })

  it('changes when image, install arg, allowScripts, root or service kind changes', () => {
    const first = cacheKey(baseInput())
    assert.equal(first.ok, true)
    const variants = [
      baseInput({ image: 'node:20-bookworm' }),
      baseInput({ installs: [{ cmd: 'npm', args: ['install'] }] }),
      baseInput({ allowScripts: true }),
      baseInput({ root: 'dist' }),
      baseInput({ services: [{ kind: 'postgres' }] })
    ]
    for (const v of variants) {
      const r = cacheKey(v)
      assert.equal(r.ok, true)
      assert.notEqual(r.key, first.key, JSON.stringify(v))
    }
  })

  it('does not change when service names or install key order differ', () => {
    const a = cacheKey(baseInput({ services: [{ kind: 'postgres', name: 'db-a' }] }))
    const b = cacheKey(baseInput({ services: [{ kind: 'postgres', name: 'db-b' }] }))
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    assert.equal(a.key, b.key)
    const c = cacheKey({ ...baseInput(), installs: [{ args: ['ci'], cmd: 'npm' }] })
    const d = cacheKey(baseInput())
    assert.equal(c.ok, true)
    assert.equal(d.ok, true)
    assert.equal(c.key, d.key)
    const e = cacheKey(baseInput({ services: ['postgres'] }))
    const f = cacheKey(baseInput({ services: [{ kind: 'postgres' }] }))
    assert.equal(e.ok, true)
    assert.equal(f.ok, true)
    assert.equal(e.key, f.key)
  })

  it('keeps the {port} placeholder: substituted ports give different keys', () => {
    const withPlaceholder = cacheKey(baseInput({ installs: [{ cmd: 'npm', args: ['start --port {port}'] }] }))
    const subA = cacheKey(baseInput({ installs: [{ cmd: 'npm', args: ['start --port 8300'] }] }))
    const subB = cacheKey(baseInput({ installs: [{ cmd: 'npm', args: ['start --port 8301'] }] }))
    assert.equal(withPlaceholder.ok, true)
    assert.equal(subA.ok, true)
    assert.equal(subB.ok, true)
    assert.notEqual(subA.key, subB.key)
    assert.notEqual(withPlaceholder.key, subA.key)
  })

  it('refuses bad fields', () => {
    assert.equal(cacheKey(baseInput({ app: 'Bad App' })).ok, false)
    assert.equal(cacheKey(baseInput({ sha: 'abc' })).ok, false)
    assert.equal(cacheKey(baseInput({ image: 'node:latest' })).ok, false)
    assert.equal(cacheKey(baseInput({ installs: 'npm ci' })).ok, false)
    assert.equal(cacheKey(baseInput({ installs: [{ cmd: 42 }] })).ok, false)
    assert.equal(cacheKey(baseInput({ allowScripts: 'yes' })).ok, false)
    assert.equal(cacheKey(baseInput({ services: 'postgres' })).ok, false)
  })
})

describe('key and image helpers', () => {
  it('round-trips including dashes in the app name', () => {
    const r = cacheKey(baseInput())
    assert.equal(r.ok, true)
    assert.equal(isCacheKey(r.key), true)
    const img = cacheImage(r.key)
    assert.equal(img, CACHE_REPO + ':' + r.key)
    assert.equal(isCacheImage(img), true)
    const p = parseCacheImage(img)
    assert.deepEqual(p, { app: 'nextjs-blog', sha12: SHA.slice(0, 12), fingerprint: r.fingerprint })
  })

  it('rejects non-cache images and malformed keys', () => {
    assert.equal(isCacheImage('node:22-bookworm'), false)
    assert.equal(isCacheImage('bq-cache:latest'), false)
    const r = cacheKey(baseInput())
    assert.equal(r.ok, true)
    const upper = r.key.toUpperCase()
    assert.equal(isCacheKey(upper), false)
    assert.equal(isCacheImage(CACHE_REPO + ':' + upper), false)
    const short = r.key.slice(0, -1)
    assert.equal(isCacheKey(short), false)
    assert.equal(parseCacheImage(CACHE_REPO + ':' + short), null)
    assert.equal(parseCacheImage('node:22-bookworm'), null)
    assert.equal(cacheImage('nope'), null)
    assert.equal(cacheImage('ABC'), null)
  })
})

describe('committerArgs', () => {
  it('gives exactly the expected argv', () => {
    const runId = 'abc123'
    const r = committerArgs({ runId, image: IMAGE, volumeShort: 'work' })
    assert.equal(r.ok, true)
    assert.deepEqual(r.args, [
      'run', '--name', 'bq-abc123-commit',
      '--label', 'behique=1',
      '--label', 'behique.run=abc123',
      '--label', 'behique.role=commit',
      '--user', '0:0',
      '--cap-drop=ALL',
      '--cap-add=CHOWN',
      '--cap-add=DAC_OVERRIDE',
      '--cap-add=FOWNER',
      '--security-opt=no-new-privileges',
      '--network', 'none',
      '--volume', 'bq-abc123-work:/vol:ro',
      IMAGE,
      'sh', '-c', 'mkdir -p /work && cp -a /vol/. /work/'
    ])
  })

  it('refuses a bad runId or image', () => {
    assert.equal(committerArgs({ runId: 'bad!!', image: IMAGE, volumeShort: 'work' }).ok, false)
    assert.equal(committerArgs({ runId: 'abc123', image: 'node:latest', volumeShort: 'work' }).ok, false)
    assert.equal(committerArgs({ runId: 'abc123', image: IMAGE, volumeShort: 'Bad' }).ok, false)
  })
})

describe('commitArgs', () => {
  it('gives exactly the expected argv with pinned now', () => {
    const runId = 'abc123'
    const k = cacheKey(baseInput())
    assert.equal(k.ok, true)
    const now = Date.parse('2026-10-31T15:02:11.000Z')
    const r = commitArgs({ runId, key: k.key, app: 'nextjs-blog', sha: SHA }, { now })
    assert.equal(r.ok, true)
    assert.deepEqual(r.args, [
      'commit',
      '--change', 'USER 1000:1000',
      '--change', 'WORKDIR /work',
      '--change', 'LABEL behique=1',
      '--change', 'LABEL behique.cache=1',
      '--change', 'LABEL behique.app=nextjs-blog',
      '--change', `LABEL behique.sha=${SHA}`,
      '--change', 'LABEL behique.created=2026-10-31T15:02:11.000Z',
      'bq-abc123-commit',
      `bq-cache:${k.key}`
    ])
  })
})

describe('cache list', () => {
  it('parses two good lines and skips junk', () => {
    const k1 = cacheKey(baseInput())
    const k2 = cacheKey(baseInput({ app: 'umami' }))
    assert.equal(k1.ok, true)
    assert.equal(k2.ok, true)
    const img1 = CACHE_REPO + ':' + k1.key
    const img2 = CACHE_REPO + ':' + k2.key
    const stdout = [
      `${img1}\t2026-10-31 10:02:11 -0500 CDT\t1.24GB`,
      'this is a junk line',
      `node:22-bookworm\t2026-10-31 10:02:11 -0500 CDT\t100MB`,
      `${img2}\t2026-10-30 09:00:00 +0000 UTC\t900MB`
    ].join('\n') + '\n'
    const rows = parseCacheList(stdout)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].image, img1)
    assert.equal(rows[0].key, k1.key)
    assert.equal(rows[0].app, 'nextjs-blog')
    assert.equal(rows[0].size, '1.24GB')
    assert.equal(typeof rows[0].createdAt, 'number')
    assert.equal(rows[0].createdAt, Date.parse('2026-10-31 10:02:11 -0500'))
    assert.equal(rows[1].image, img2)
    assert.equal(typeof rows[1].createdAt, 'number')
  })

  it('sets createdAt null when the date does not parse', () => {
    const k = cacheKey(baseInput())
    const rows = parseCacheList(`${CACHE_REPO}:${k.key}\tnot a date\t10MB`)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].createdAt, null)
  })

  it('cacheListArgs shape', () => {
    assert.deepEqual(cacheListArgs(), {
      ok: true,
      args: ['image', 'ls', '--filter', 'label=behique.cache=1', '--format', '{{.Repository}}:{{.Tag}}\t{{.CreatedAt}}\t{{.Size}}']
    })
  })
})

describe('cacheInspectArgs and cacheRemoveArgs', () => {
  it('inspect accepts only cache images', () => {
    const k = cacheKey(baseInput())
    const img = CACHE_REPO + ':' + k.key
    assert.deepEqual(cacheInspectArgs(img), { ok: true, args: ['image', 'inspect', '--format', '{{.Id}}', img] })
    assert.equal(cacheInspectArgs('node:22-bookworm').ok, false)
  })

  it('remove refuses empty, plain and too many images', () => {
    const k = cacheKey(baseInput())
    const img = CACHE_REPO + ':' + k.key
    assert.equal(cacheRemoveArgs([]).ok, false)
    assert.equal(cacheRemoveArgs(['node:22-bookworm']).ok, false)
    assert.equal(cacheRemoveArgs([img, 'node:22-bookworm']).ok, false)
    const many = Array.from({ length: 51 }, (_, i) => `${CACHE_REPO}:app-0123456789ab-0000000${i % 10}`)
    assert.equal(many.length, 51)
    assert.equal(cacheRemoveArgs(many).ok, false)
    assert.deepEqual(cacheRemoveArgs([img]), { ok: true, args: ['image', 'rm', img] })
  })
})

describe('prunePlan', () => {
  function entry(app, day, fp) {
    const sha12 = '0123456789ab'
    const key = `${app}-${sha12}-${fp}`
    return { image: `${CACHE_REPO}:${key}`, key, app, sha12, fingerprint: fp, createdAt: Date.parse(day), size: '1GB' }
  }

  it('keeps newest 4 per app and removes older ones', () => {
    const now = Date.parse('2026-10-31T12:00:00Z')
    const entries = [
      entry('blog', '2026-10-30T12:00:00Z', '00000001'),
      entry('blog', '2026-10-29T12:00:00Z', '00000002'),
      entry('blog', '2026-10-28T12:00:00Z', '00000003'),
      entry('blog', '2026-10-27T12:00:00Z', '00000004'),
      entry('blog', '2026-10-26T12:00:00Z', '00000005'),
      entry('blog', '2026-10-25T12:00:00Z', '00000006')
    ]
    const p = prunePlan(entries, { keepPerApp: 4, maxAgeDays: 14, now })
    assert.equal(p.keep.length, 4)
    assert.equal(p.remove.length, 2)
    assert.ok(p.keep.includes(`${CACHE_REPO}:blog-0123456789ab-00000001`))
    assert.ok(p.remove.includes(`${CACHE_REPO}:blog-0123456789ab-00000006`))
  })

  it('removes an old entry inside the top 4 but keeps the single newest even when old', () => {
    const now = Date.parse('2026-10-31T12:00:00Z')
    const entries = [
      entry('blog', '2026-10-30T12:00:00Z', '00000001'),
      entry('blog', '2026-09-01T12:00:00Z', '00000002'),
      entry('solo', '2026-08-01T12:00:00Z', '00000003')
    ]
    const p = prunePlan(entries, { keepPerApp: 4, maxAgeDays: 14, now })
    assert.ok(p.remove.includes(`${CACHE_REPO}:blog-0123456789ab-00000002`))
    assert.ok(p.keep.includes(`${CACHE_REPO}:blog-0123456789ab-00000001`))
    assert.ok(p.keep.includes(`${CACHE_REPO}:solo-0123456789ab-00000003`))
    assert.ok(!p.remove.includes(`${CACHE_REPO}:solo-0123456789ab-00000003`))
  })

  it('handles null createdAt as oldest', () => {
    const now = Date.parse('2026-10-31T12:00:00Z')
    const fresh = entry('blog', '2026-10-30T12:00:00Z', '00000001')
    const nul = { image: `${CACHE_REPO}:blog-0123456789ab-00000009`, key: 'blog-0123456789ab-00000009', app: 'blog', sha12: '0123456789ab', fingerprint: '00000009', createdAt: null, size: '1GB' }
    const p = prunePlan([fresh, nul], { keepPerApp: 1, maxAgeDays: 14, now })
    assert.deepEqual(p.keep, [fresh.image])
    assert.deepEqual(p.remove, [nul.image])
  })
})

describe('hitPlan', () => {
  it('returns the expected plan', () => {
    const k = cacheKey(baseInput())
    assert.equal(k.ok, true)
    const limits = { memoryMb: 4096, cpus: 4, pids: 1024 }
    const r = hitPlan({ runId: 'abc123', key: k.key, limits, env: { FOO: 'bar' }, cmd: ['node', 'server.mjs'], port: 8300 })
    assert.equal(r.ok, true)
    assert.deepEqual(r.plan, {
      runId: 'abc123',
      short: 'app',
      role: 'app',
      image: `bq-cache:${k.key}`,
      networks: ['int'],
      volume: null,
      workdir: '/work',
      user: '1000:1000',
      cmd: ['node', 'server.mjs'],
      env: { FOO: 'bar', HOME: '/work/.home', PORT: '8300' },
      tmpfs: [],
      caps: [],
      limits,
      interactive: false,
      detach: true,
      rm: false,
      readOnly: false
    })
  })

  it('refuses a bad port or empty cmd', () => {
    const k = cacheKey(baseInput())
    const limits = { memoryMb: 4096, cpus: 4, pids: 1024 }
    assert.equal(hitPlan({ runId: 'abc123', key: k.key, limits, env: {}, cmd: ['node'], port: 80 }).ok, false)
    assert.equal(hitPlan({ runId: 'abc123', key: k.key, limits, env: {}, cmd: [], port: 8300 }).ok, false)
    assert.equal(hitPlan({ runId: 'abc123', key: k.key, limits, env: {}, cmd: ['-bad'], port: 8300 }).ok, false)
    assert.equal(hitPlan({ runId: 'bad!!', key: k.key, limits, env: {}, cmd: ['node'], port: 8300 }).ok, false)
  })
})
