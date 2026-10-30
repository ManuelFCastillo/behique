// docker-args: build every docker command Behique runs against untrusted code.
//   node --test src/release/sandbox/docker-args.test.mjs
// Pure functions only. No process is started, no file is read. Nothing here trusts
// repository, model or web content: values become single argv items, never flags.
export const LABEL = 'behique'

export const ALLOWED_CAPS = ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE', 'FOWNER']

const RUN_ID_RE = /^[a-z0-9]{6,16}$/
const SHORT_RE = /^[a-z0-9][a-z0-9-]{0,30}$/
const IMAGE_RE = /^[a-z0-9][a-z0-9._/-]{0,80}:[A-Za-z0-9._-]{1,64}$/
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/
const PATH_RE = /^\/(?!.*\.\.)[A-Za-z0-9_./-]{1,100}$/
// container-side paths that must never appear on a command, so a mistake cannot point at system or host-looking locations
const BAD_PATH_PREFIXES = ['/etc', '/var/run', '/run', '/root', '/Users', '/proc', '/sys', '/dev']
function isPath(p) {
  if (typeof p !== 'string' || !PATH_RE.test(p)) return false
  return !BAD_PATH_PREFIXES.some(pre => p === pre || p.startsWith(pre + '/'))
}
const USER_RE = /^[0-9]+:[0-9]+$/
const ID_HEX_RE = /^[0-9a-f]{12,64}$/
const ID_NAME_RE = /^bq-[A-Za-z0-9_.-]{1,100}$/
const ROLES = ['install', 'app', 'service', 'seed']

const PLAN_KEYS = new Set([
  'runId', 'short', 'role', 'image', 'networks', 'aliases', 'volume',
  'workdir', 'user', 'cmd', 'env', 'tmpfs', 'caps', 'limits',
  'interactive', 'detach', 'rm', 'readOnly'
])

export function isRunId(s) {
  return typeof s === 'string' && RUN_ID_RE.test(s)
}

export function isShortName(s) {
  return typeof s === 'string' && SHORT_RE.test(s)
}

export function isImage(s) {
  if (typeof s !== 'string') return false
  if (!IMAGE_RE.test(s)) return false
  if (s.includes('@')) return false
  const idx = s.lastIndexOf(':')
  const namePart = s.slice(0, idx)
  const tag = s.slice(idx + 1)
  if (tag === 'latest') return false
  const first = namePart.split('/')[0]
  if (first.includes('.') || first.includes(':')) return false
  return true
}

export function isEnvKey(s) {
  if (typeof s !== 'string') return false
  if (!ENV_KEY_RE.test(s)) return false
  if (s.startsWith('LD_')) return false
  if (s.startsWith('DOCKER_')) return false
  return true
}

export function isEnvValue(s) {
  if (typeof s !== 'string') return false
  if (s.length > 2000) return false
  if (s.includes('\n') || s.includes('\r') || s.includes('\0')) return false
  return true
}

export function names(runId, short) {
  if (!isRunId(runId)) return null
  if (!isShortName(short)) return null
  return `bq-${runId}-${short}`
}

function fail(error) {
  return { ok: false, error }
}

function isObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function checkCmd(cmd) {
  if (!Array.isArray(cmd)) return 'cmd must be an array of 1 to 50 strings.'
  if (cmd.length < 1 || cmd.length > 50) return 'cmd must be an array of 1 to 50 strings.'
  for (const part of cmd) {
    if (typeof part !== 'string') return 'cmd must be an array of 1 to 50 strings.'
    if (part.length > 4000) return 'cmd entry is too long.'
    if (part.includes('\0')) return 'cmd entry must not contain NUL.'
  }
  if (cmd[0].startsWith('-')) return 'cmd must not start with a flag.'
  return null
}

function checkEnv(env) {
  if (!isObj(env)) return 'env must be an object.'
  const keys = Object.keys(env)
  if (keys.length > 60) return 'env has too many entries (at most 60).'
  for (const k of keys) {
    if (!isEnvKey(k)) return `invalid env key: ${k}.`
    if (!isEnvValue(env[k])) return `invalid env value for ${k}.`
  }
  return null
}

function checkLimits(limits) {
  if (!isObj(limits)) return 'limits is required with memoryMb, cpus and pids.'
  const { memoryMb, cpus, pids } = limits
  if (!Number.isInteger(memoryMb) || memoryMb < 64 || memoryMb > 16384) {
    return 'limits.memoryMb must be an integer from 64 to 16384.'
  }
  if (typeof cpus !== 'number' || !Number.isFinite(cpus) || cpus < 0.25 || cpus > 16) {
    return 'limits.cpus must be a number from 0.25 to 16.'
  }
  if (!Number.isInteger(pids) || pids < 16 || pids > 4096) {
    return 'limits.pids must be an integer from 16 to 4096.'
  }
  return null
}

export function networkCreateArgs(input) {
  if (!isObj(input)) return fail('runId, short and internal are required.')
  const { runId, short, internal } = input
  if (!isRunId(runId)) return fail('invalid runId.')
  if (!isShortName(short)) return fail('invalid short name.')
  const name = names(runId, short)
  const args = ['network', 'create', '--driver', 'bridge']
  if (internal === true) args.push('--internal')
  else if (internal !== false && internal !== undefined) return fail('internal must be true or false.')
  args.push('--label', 'behique=1', '--label', `behique.run=${runId}`, name)
  return { ok: true, args }
}

export function volumeCreateArgs(input) {
  if (!isObj(input)) return fail('runId and short are required.')
  const { runId, short } = input
  if (!isRunId(runId)) return fail('invalid runId.')
  if (!isShortName(short)) return fail('invalid short name.')
  const name = names(runId, short)
  return { ok: true, args: ['volume', 'create', '--label', 'behique=1', '--label', `behique.run=${runId}`, name] }
}

export function networkConnectArgs(input) {
  if (!isObj(input)) return fail('runId, networkShort and containerShort are required.')
  const { runId, networkShort, containerShort, aliases = [] } = input
  if (!isRunId(runId)) return fail('invalid runId.')
  if (!isShortName(networkShort)) return fail('invalid networkShort.')
  if (!isShortName(containerShort)) return fail('invalid containerShort.')
  if (!Array.isArray(aliases)) return fail('aliases must be an array.')
  for (const a of aliases) {
    if (!isShortName(a)) return fail(`invalid alias: ${a}.`)
  }
  const net = names(runId, networkShort)
  const cont = names(runId, containerShort)
  const args = ['network', 'connect']
  for (const a of aliases) args.push('--alias', a)
  args.push(net, cont)
  return { ok: true, args }
}

export function startArgs(input) {
  if (!isObj(input)) return fail('runId and short are required.')
  const { runId, short, attach = false } = input
  if (!isRunId(runId)) return fail('invalid runId.')
  if (!isShortName(short)) return fail('invalid short name.')
  if (attach !== true && attach !== false) return fail('attach must be true or false.')
  const name = names(runId, short)
  const args = ['start']
  if (attach === true) args.push('-a')
  args.push(name)
  return { ok: true, args }
}

export function execArgs(input) {
  if (!isObj(input)) return fail('runId, short and cmd are required.')
  const { runId, short, cmd, env = {}, workdir } = input
  if (!isRunId(runId)) return fail('invalid runId.')
  if (!isShortName(short)) return fail('invalid short name.')
  const cmdErr = checkCmd(cmd)
  if (cmdErr) return fail(cmdErr)
  if (!isObj(env)) return fail('env must be an object.')
  const envErr = checkEnv(env)
  if (envErr) return fail(envErr)
  if (workdir !== undefined && !(isPath(workdir))) {
    return fail('invalid workdir.')
  }
  const name = names(runId, short)
  const args = ['exec']
  if (workdir !== undefined) args.push('--workdir', workdir)
  for (const k of Object.keys(env).sort()) args.push('--env', `${k}=${env[k]}`)
  args.push(name, ...cmd)
  return { ok: true, args }
}

export function inspectIpArgs(input) {
  if (!isObj(input)) return fail('runId, short and networkShort are required.')
  const { runId, short, networkShort } = input
  if (!isRunId(runId)) return fail('invalid runId.')
  if (!isShortName(short)) return fail('invalid short name.')
  if (!isShortName(networkShort)) return fail('invalid networkShort.')
  const net = names(runId, networkShort)
  const cont = names(runId, short)
  const fmt = `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`
  return { ok: true, args: ['inspect', '--format', fmt, cont] }
}

export function listArgs(input) {
  if (!isObj(input)) return fail('runId and kind are required.')
  const { runId, kind } = input
  if (!isRunId(runId)) return fail('invalid runId.')
  if (kind === 'container') return { ok: true, args: ['ps', '-aq', '--filter', `label=behique.run=${runId}`] }
  if (kind === 'network') return { ok: true, args: ['network', 'ls', '-q', '--filter', `label=behique.run=${runId}`] }
  if (kind === 'volume') return { ok: true, args: ['volume', 'ls', '-q', '--filter', `label=behique.run=${runId}`] }
  return fail('kind must be container, network or volume.')
}

export function listAllArgs(input) {
  if (!isObj(input)) return fail('kind is required.')
  const { kind } = input
  if (kind === 'container') return { ok: true, args: ['ps', '-aq', '--filter', 'label=behique=1'] }
  if (kind === 'network') return { ok: true, args: ['network', 'ls', '-q', '--filter', 'label=behique=1'] }
  if (kind === 'volume') return { ok: true, args: ['volume', 'ls', '-q', '--filter', 'label=behique=1'] }
  return fail('kind must be container, network or volume.')
}

export function removeArgs(input) {
  if (!isObj(input)) return fail('kind and ids are required.')
  const { kind, ids } = input
  if (kind !== 'container' && kind !== 'network' && kind !== 'volume') {
    return fail('kind must be container, network or volume.')
  }
  if (!Array.isArray(ids) || ids.length < 1) return fail('ids must be a non-empty array.')
  for (const id of ids) {
    if (typeof id !== 'string') return fail(`invalid id: ${String(id)}.`)
    if (!ID_HEX_RE.test(id) && !ID_NAME_RE.test(id)) return fail(`invalid id: ${id}.`)
  }
  if (kind === 'container') return { ok: true, args: ['rm', '-f', '-v', ...ids] }
  if (kind === 'network') return { ok: true, args: ['network', 'rm', ...ids] }
  return { ok: true, args: ['volume', 'rm', '-f', ...ids] }
}

export function initVolumeArgs(input) {
  if (!isObj(input)) return fail('runId, short and image are required.')
  const { runId, short, image, uid = 1000, gid = 1000 } = input
  if (!isRunId(runId)) return fail('invalid runId.')
  if (!isShortName(short)) return fail('invalid short name.')
  if (!isImage(image)) return fail('invalid image.')
  if (!Number.isInteger(uid) || uid < 0 || uid > 65535) return fail('uid must be an integer from 0 to 65535.')
  if (!Number.isInteger(gid) || gid < 0 || gid > 65535) return fail('gid must be an integer from 0 to 65535.')
  const vname = names(runId, short)
  return {
    ok: true,
    args: [
      'run', '--rm',
      '--label', 'behique=1',
      '--label', `behique.run=${runId}`,
      '--user', '0:0',
      '--cap-drop=ALL',
      '--cap-add=CHOWN',
      '--security-opt=no-new-privileges',
      '--network', 'none',
      '--volume', `${vname}:/work`,
      image,
      'chown', `${uid}:${gid}`, '/work'
    ]
  }
}

function buildContainerArgs(plan, verb) {
  if (!isObj(plan)) return fail('plan must be an object.')
  for (const k of Object.keys(plan)) {
    if (!PLAN_KEYS.has(k)) return fail(`Unknown option: ${k}.`)
  }
  const {
    runId, short, role, image, networks, aliases = [], volume,
    workdir, user = '1000:1000', cmd, env = {}, tmpfs = [],
    caps = [], limits, interactive = false, detach = false, rm = false,
    readOnly = true
  } = plan
  if (!isRunId(runId)) return fail('invalid runId.')
  if (!isShortName(short)) return fail('invalid short name.')
  if (!ROLES.includes(role)) return fail('role must be install, app, service or seed.')
  if (!isImage(image)) return fail('invalid image.')
  if (!Array.isArray(networks) || networks.length < 1) return fail('networks must be a non-empty array.')
  for (const n of networks) {
    if (!isShortName(n)) return fail(`invalid network: ${n}.`)
  }
  if (!Array.isArray(aliases)) return fail('aliases must be an array.')
  for (const a of aliases) {
    if (!isShortName(a)) return fail(`invalid alias: ${a}.`)
  }
  if (volume !== null && volume !== undefined) {
    if (!isObj(volume)) return fail('volume must be { short, path } or null.')
    if (!isShortName(volume.short)) return fail('invalid volume short name.')
    if (!isPath(volume.path)) return fail('invalid volume path.')
  }
  if (workdir !== undefined && !(isPath(workdir))) {
    return fail('invalid workdir.')
  }
  // a service may keep the image's own user (official database images start as root, fix ownership, then drop to their own user)
  if (user === null) {
    if (role !== 'service') return fail('user null is only allowed for the service role.')
  } else {
    if (typeof user !== 'string' || !USER_RE.test(user)) return fail('invalid user.')
    const [uid, gid] = user.split(':').map(Number)
    if (uid === 0 || gid === 0) return fail('user must not be root.')
  }
  const cmdErr = checkCmd(cmd)
  if (cmdErr) return fail(cmdErr)
  const envErr = checkEnv(env)
  if (envErr) return fail(envErr)
  if (!Array.isArray(tmpfs)) return fail('tmpfs must be an array.')
  for (const t of tmpfs) {
    if (!isPath(t)) return fail(`invalid tmpfs path: ${t}.`)
  }
  if (!Array.isArray(caps)) return fail('caps must be an array.')
  for (const c of caps) {
    if (!ALLOWED_CAPS.includes(c)) return fail(`invalid cap: ${c}.`)
  }
  if (caps.length > 0 && role !== 'service') return fail('caps are only allowed for the service role.')
  const limErr = checkLimits(limits)
  if (limErr) return fail(limErr)
  if (typeof interactive !== 'boolean') return fail('interactive must be true or false.')
  if (typeof detach !== 'boolean') return fail('detach must be true or false.')
  if (typeof rm !== 'boolean') return fail('rm must be true or false.')
  if (typeof readOnly !== 'boolean') return fail('readOnly must be true or false.')
  if (readOnly === false && role !== 'service') return fail('readOnly false is only allowed for the service role.')

  const name = names(runId, short)
  const firstNet = names(runId, networks[0])
  const args = [verb]
  args.push('--name', name)
  args.push('--label', 'behique=1', '--label', `behique.run=${runId}`, '--label', `behique.role=${role}`)
  args.push('--network', firstNet)
  for (const a of aliases) args.push('--network-alias', a)
  if (volume !== null && volume !== undefined) {
    // nocopy: Docker otherwise copies the owner of the image's folder (root) onto a still-empty volume at its first mount, undoing the init step
    args.push('--volume', `${names(runId, volume.short)}:${volume.path}:nocopy`)
  }
  if (workdir !== undefined) args.push('--workdir', workdir)
  if (user !== null) args.push('--user', user)
  if (readOnly === true) args.push('--read-only')
  const listed = new Set(tmpfs)
  for (const t of tmpfs) args.push('--tmpfs', `${t}:rw,nosuid,size=512m`)
  // /tmp must allow exec: yarn Berry and many native modules write small launchers there and run them
  if (!listed.has('/tmp')) args.push('--tmpfs', '/tmp:rw,exec,nosuid,size=1g')
  args.push('--cap-drop=ALL')
  for (const c of caps) args.push(`--cap-add=${c}`)
  args.push('--security-opt=no-new-privileges')
  args.push('--pids-limit', String(limits.pids))
  args.push('--memory', `${limits.memoryMb}m`)
  args.push('--memory-swap', `${limits.memoryMb}m`)
  args.push('--cpus', String(limits.cpus))
  args.push('--init')
  if (interactive === true) args.push('-i')
  if (verb === 'run') {
    if (detach === true) args.push('-d')
    if (rm === true) args.push('--rm')
  }
  for (const k of Object.keys(env).sort()) args.push('--env', `${k}=${env[k]}`)
  args.push(image, ...cmd)
  return { ok: true, args }
}

export function createArgs(plan) {
  try {
    return buildContainerArgs(plan, 'create')
  } catch {
    return fail('invalid plan.')
  }
}

export function runArgs(plan) {
  try {
    return buildContainerArgs(plan, 'run')
  } catch {
    return fail('invalid plan.')
  }
}
