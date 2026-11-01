// Tests for the approved login step: validation, actions, redaction, insert and strip.
// Run with: node --test src/release/login.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateLogin, loginActions, redactActions, withLogin, stripLogin, describeLogin } from './login.mjs'

const example = () => ({
  path: '/login',
  user: { selector: 'input[name=username]', value: 'admin' },
  password: { selector: 'input[name=password]', env: 'BEHIQUE_LOGIN_PASSWORD' },
  submit: { selector: 'button[type=submit]' },
  expect: { selector: 'nav .logout' },
  public: false,
  note: 'the demo admin account'
})

const valueLogin = () => ({
  path: '/login',
  user: { selector: 'input[name=username]', value: 'admin' },
  password: { selector: 'input[name=password]', value: 'pw-test-123' },
  submit: { selector: 'button[type=submit]' },
  public: true
})

describe('validateLogin', () => {
  it('accepts the example', () => {
    assert.deepEqual(validateLogin(example()), [])
  })

  it('refuses an unknown key', () => {
    const problems = validateLogin({ ...example(), extra: 1 })
    assert.ok(problems.some(p => p.includes('extra')))
  })

  it('refuses a bad path', () => {
    assert.ok(validateLogin({ ...example(), path: 'login' }).length > 0)
    assert.ok(validateLogin({ ...example(), path: '/a b' }).length > 0)
    assert.ok(validateLogin({ ...example(), path: '/' + 'a'.repeat(200) }).length > 0)
  })

  it('refuses a missing selector', () => {
    const bad = example()
    bad.user = { value: 'admin' }
    const problems = validateLogin(bad)
    assert.ok(problems.some(p => p.includes('login.user')))
  })

  it('refuses both env and value', () => {
    const bad = example()
    bad.password = { selector: 'input[name=password]', env: 'BEHIQUE_LOGIN_PASSWORD', value: 'pw-test-123' }
    assert.ok(validateLogin(bad).some(p => p.includes('exactly one')))
  })

  it('refuses a value without public true', () => {
    const bad = valueLogin()
    bad.public = false
    assert.deepEqual(validateLogin(bad), ['the password belongs in the environment: set password.env, or set public to true for a documented default account'])
  })

  it('also refuses a value with public missing', () => {
    const bad = valueLogin()
    delete bad.public
    assert.ok(validateLogin(bad).includes('the password belongs in the environment: set password.env, or set public to true for a documented default account'))
  })

  it('refuses a bad env name', () => {
    const bad = example()
    bad.password = { selector: 'input[name=password]', env: 'bad-name' }
    assert.ok(validateLogin(bad).some(p => p.includes('login.password.env')))
  })

  it('refuses a long note', () => {
    const bad = example()
    bad.note = 'n'.repeat(501)
    assert.ok(validateLogin(bad).some(p => p.includes('login.note')))
  })

  it('refuses a bad expect and public', () => {
    const badExpect = example()
    badExpect.expect = { selector: '' }
    assert.ok(validateLogin(badExpect).length > 0)
    const badPublic = example()
    badPublic.public = 'yes'
    assert.ok(validateLogin(badPublic).some(p => p.includes('login.public')))
  })
})

describe('loginActions', () => {
  it('builds actions from env', () => {
    const actions = loginActions(example(), { BEHIQUE_LOGIN_PASSWORD: 'pw-test-123' })
    assert.equal(actions.length, 5)
    assert.deepEqual(actions[0], { type: 'goto', path: '/login', fromLogin: true })
    assert.deepEqual(actions[1], { type: 'fill', selector: 'input[name=username]', text: 'admin', fromLogin: true })
    assert.equal(actions[2].type, 'fill')
    assert.equal(actions[2].selector, 'input[name=password]')
    assert.equal(actions[2].text, 'pw-test-123')
    assert.equal(actions[2].secret, true)
    assert.deepEqual(actions[3], { type: 'click', selector: 'button[type=submit]', fromLogin: true })
    assert.deepEqual(actions[4], { type: 'wait', ms: 800, fromLogin: true })
  })

  it('builds actions from a written value', () => {
    const actions = loginActions(valueLogin(), {})
    assert.equal(actions[2].text, 'pw-test-123')
    assert.equal(actions[2].secret, true)
  })

  it('throws when the variable is missing or empty', () => {
    assert.throws(() => loginActions(example(), {}), /the login password BEHIQUE_LOGIN_PASSWORD is not set in the environment/)
    assert.throws(() => loginActions(example(), { BEHIQUE_LOGIN_PASSWORD: '' }), /the login password BEHIQUE_LOGIN_PASSWORD is not set in the environment/)
  })

  it('throws the first problem on an invalid block', () => {
    const bad = example()
    bad.path = 'nope'
    assert.throws(() => loginActions(bad, {}), /login\.path/)
  })
})

describe('redactActions', () => {
  it('hides only the secret text and keeps the flag', () => {
    const actions = loginActions(example(), { BEHIQUE_LOGIN_PASSWORD: 'pw-test-123' })
    const redacted = redactActions(actions)
    assert.equal(redacted[2].text, '[redacted]')
    assert.equal(redacted[2].secret, true)
    assert.equal(redacted[1].text, 'admin')
    assert.deepEqual(redacted[0], actions[0])
    assert.deepEqual(redacted[3], actions[3])
  })

  it('does not mutate its input and handles non-arrays', () => {
    const actions = loginActions(example(), { BEHIQUE_LOGIN_PASSWORD: 'pw-test-123' })
    const before = JSON.parse(JSON.stringify(actions))
    redactActions(actions)
    assert.deepEqual(actions, before)
    assert.deepEqual(redactActions(null), [])
    assert.deepEqual(redactActions('x'), [])
  })
})

describe('withLogin', () => {
  it('prepends and repeats after each goto / and nowhere else', () => {
    const login = example()
    const env = { BEHIQUE_LOGIN_PASSWORD: 'pw-test-123' }
    const steps = [
      { type: 'goto', path: '/' },
      { type: 'click', selector: 'a' },
      { type: 'goto', path: '/other' },
      { type: 'goto', path: '/' },
      { type: 'click', selector: 'b' }
    ]
    const out = withLogin(steps, login, env)
    assert.equal(out.length, steps.length + 5 * 3)
    assert.equal(out[0].type, 'goto')
    assert.equal(out[0].path, '/login')
    assert.deepEqual(out.slice(0, 5), loginActions(login, env))
    const gotoRootIndexes = out
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => a.type === 'goto' && a.path === '/' && a.fromLogin !== true)
      .map(({ i }) => i)
    assert.deepEqual(gotoRootIndexes, [5, 13]) // 5 login actions, goto /, 5 more, click a, goto /other, goto /
    for (const i of gotoRootIndexes) {
      assert.deepEqual(out.slice(i + 1, i + 6), loginActions(login, env))
    }
    const otherIdx = out.findIndex(a => a.type === 'goto' && a.path === '/other')
    assert.equal(out[otherIdx + 1].fromLogin, undefined, 'a goto to another path does not trigger a login')
  })

  it('leaves the input untouched and copies when there is no login', () => {
    const steps = [{ type: 'click', selector: 'a' }, { type: 'goto', path: '/' }]
    const before = JSON.parse(JSON.stringify(steps))
    const out = withLogin(steps, example(), { BEHIQUE_LOGIN_PASSWORD: 'pw-test-123' })
    assert.deepEqual(steps, before)
    assert.notEqual(out, steps)
    const copied = withLogin(steps, null)
    assert.deepEqual(copied, steps)
    assert.notEqual(copied, steps)
    const copied2 = withLogin(steps, undefined)
    assert.deepEqual(copied2, steps)
    assert.notEqual(copied2, steps)
  })
})

describe('stripLogin', () => {
  it('removes exactly the inserted actions', () => {
    const login = example()
    const env = { BEHIQUE_LOGIN_PASSWORD: 'pw-test-123' }
    const steps = [
      { type: 'goto', path: '/' },
      { type: 'click', selector: 'a' },
      { type: 'goto', path: '/other' }
    ]
    assert.deepEqual(stripLogin(withLogin(steps, login, env)), steps)
  })

  it('keeps user steps that look similar but lack the flag', () => {
    const steps = [{ type: 'goto', path: '/login' }, { type: 'wait', ms: 800 }]
    assert.deepEqual(stripLogin(steps), steps)
  })
})

describe('describeLogin', () => {
  it('describes a password from the environment', () => {
    assert.equal(describeLogin(example()), 'login: /login as "admin" (password from BEHIQUE_LOGIN_PASSWORD)')
  })

  it('describes a written public password', () => {
    assert.equal(describeLogin(valueLogin()), 'login: /login as "admin" (password written in the profile, a public default account)')
  })
})
