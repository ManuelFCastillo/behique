// A login step a person approves: validate the profile login block, build
// recorder actions, redact secrets, insert after every state reset.
// Run tests with: node --test src/release/login.test.mjs
const ALLOWED_KEYS = ['path', 'user', 'password', 'submit', 'expect', 'public', 'note']

const ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/

const isPlainObject = v => typeof v === 'object' && v !== null && !Array.isArray(v)

const isSelectorOk = v => typeof v === 'string' && v.length > 0 && v.length <= 200 && !v.includes('\n') && !v.includes('\r')

function checkSelector(value, where) {
  if (typeof value !== 'string' || value.length === 0) return `${where} selector must be a non-empty string`
  if (value.length > 200) return `${where} selector must be at most 200 characters`
  if (value.includes('\n') || value.includes('\r')) return `${where} selector must not contain a newline`
  return null
}

export function validateLogin(login) {
  const problems = []
  if (!isPlainObject(login)) return ['login must be an object with path, user, password and submit']
  for (const key of Object.keys(login)) {
    if (!ALLOWED_KEYS.includes(key)) problems.push(`unknown login key "${key}": allowed keys are path, user, password, submit, expect, public, note`)
  }
  if (login.path === undefined) {
    problems.push('login.path is required and must start with /')
  } else if (typeof login.path !== 'string' || !login.path.startsWith('/') || login.path.length > 200 || /\s/.test(login.path)) {
    if (typeof login.path !== 'string' || !login.path.startsWith('/')) {
      problems.push('login.path must be a string starting with /')
    } else if (login.path.length > 200) {
      problems.push('login.path must be at most 200 characters')
    } else {
      problems.push('login.path must not contain whitespace')
    }
  }
  if (!isPlainObject(login.user)) {
    problems.push('login.user is required and must be an object with selector and value')
  } else {
    const p = checkSelector(login.user.selector, 'login.user')
    if (p) problems.push(p)
    if (typeof login.user.value !== 'string') {
      problems.push('login.user.value must be a string')
    } else if (login.user.value.length > 200) {
      problems.push('login.user.value must be at most 200 characters')
    }
  }
  if (!isPlainObject(login.password)) {
    problems.push('login.password is required and must be an object with selector and env or value')
  } else {
    const p = checkSelector(login.password.selector, 'login.password')
    if (p) problems.push(p)
    const hasEnv = login.password.env !== undefined
    const hasValue = login.password.value !== undefined
    if (hasEnv && hasValue) {
      problems.push('login.password must have exactly one of env or value, not both')
    } else if (!hasEnv && !hasValue) {
      problems.push('login.password must have exactly one of env or value')
    } else if (hasEnv) {
      if (typeof login.password.env !== 'string' || !ENV_RE.test(login.password.env)) {
        problems.push('login.password.env must match /^[A-Z][A-Z0-9_]{0,63}$/')
      }
    } else {
      if (typeof login.password.value !== 'string') {
        problems.push('login.password.value must be a string')
      } else if (login.password.value.length > 200) {
        problems.push('login.password.value must be at most 200 characters')
      }
      if (login.public !== true) {
        problems.push('the password belongs in the environment: set password.env, or set public to true for a documented default account')
      }
    }
  }
  if (!isPlainObject(login.submit)) {
    problems.push('login.submit is required and must be an object with selector')
  } else {
    const p = checkSelector(login.submit.selector, 'login.submit')
    if (p) problems.push(p)
  }
  if (login.expect !== undefined) {
    if (!isPlainObject(login.expect)) {
      problems.push('login.expect must be an object with selector')
    } else {
      const p = checkSelector(login.expect.selector, 'login.expect')
      if (p) problems.push(p)
    }
  }
  if (login.public !== undefined && typeof login.public !== 'boolean') {
    problems.push('login.public must be a boolean')
  }
  if (login.note !== undefined) {
    if (typeof login.note !== 'string') {
      problems.push('login.note must be a string')
    } else if (login.note.length > 500) {
      problems.push('login.note must be at most 500 characters')
    }
  }
  return problems
}

function passwordText(login, env) {
  if (login.password.value !== undefined) return login.password.value
  const name = login.password.env
  const found = env[name]
  if (typeof found !== 'string' || found.length === 0) throw new Error(`the login password ${name} is not set in the environment`)
  return found
}

export function loginActions(login, env = {}) {
  const problems = validateLogin(login)
  if (problems.length > 0) throw new Error(problems[0])
  const source = env && typeof env === 'object' ? env : {}
  const text = passwordText(login, source)
  return [
    { type: 'goto', path: login.path, fromLogin: true },
    { type: 'fill', selector: login.user.selector, text: login.user.value, fromLogin: true },
    { type: 'fill', selector: login.password.selector, text, secret: true, fromLogin: true, ...(login.password.env ? { envName: login.password.env } : {}) }, // envName: an exported test reads the password from the environment instead of carrying it
    { type: 'click', selector: login.submit.selector, fromLogin: true },
    { type: 'wait', ms: 800, fromLogin: true }
  ]
}

export function redactActions(actions) {
  if (!Array.isArray(actions)) return []
  return actions.map(a => {
    const copy = { ...a }
    if (copy && copy.secret === true) copy.text = '[redacted]'
    return copy
  })
}

const cloneActions = actions => actions.map(a => ({ ...a }))

const isGotoRoot = a => isPlainObject(a) && a.type === 'goto' && a.path === '/'

export function withLogin(steps, login, env = {}) {
  const list = Array.isArray(steps) ? steps : []
  if (login === null || login === undefined) return list.map(s => ({ ...s }))
  const base = loginActions(login, env)
  const out = [...cloneActions(base)]
  for (const step of list) {
    if (isPlainObject(step) && step.type === 'goto' && !isGotoRoot(step) && !step.fromLogin) {
      // Every goto between flows is a fresh start and wipes the session, so a flow that starts on a page of its own logs in first, then loads that page keeping the session.
      out.push(...cloneActions(base), { ...step, keepSession: true })
      continue
    }
    out.push({ ...step })
    if (isGotoRoot(step)) out.push(...cloneActions(base))
  }
  return out
}

export function stripLogin(steps) {
  if (!Array.isArray(steps)) return []
  return steps.filter(a => !(isPlainObject(a) && a.fromLogin === true)).map(a => { if (!isPlainObject(a) || !a.keepSession) return a; const { keepSession, ...rest } = a; return rest })
}

export function describeLogin(login) {
  const path = login && typeof login.path === 'string' ? login.path : ''
  const user = login && isPlainObject(login.user) && typeof login.user.value === 'string' ? login.user.value : ''
  if (login && isPlainObject(login.password) && login.password.value !== undefined) {
    return `login: ${path} as "${user}" (password written in the profile, a public default account)`
  }
  const name = login && isPlainObject(login.password) && typeof login.password.env === 'string' ? login.password.env : ''
  return `login: ${path} as "${user}" (password from ${name})`
}
