// sandbox: life of one sandbox, from an empty network to nothing left behind.
// Run: node --test src/release/sandbox/sandbox.test.mjs
// Lifecycle only. Never starts a process itself: docker is injected.
import {
  isImage,
  isRunId,
  names,
  networkCreateArgs,
  volumeCreateArgs,
  networkConnectArgs,
  startArgs,
  execArgs,
  inspectIpArgs,
  listArgs,
  listAllArgs,
  removeArgs,
  initVolumeArgs,
  createArgs,
  runArgs
} from './docker-args.mjs'

function defaultNewRunId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 10; i += 1) {
    s += chars[Math.floor(Math.random() * chars.length)]
  }
  return s
}

function firstLine(s) {
  if (typeof s !== 'string') return ''
  const line = s.split('\n')[0].trim()
  return line
}

function failWithLine(line, fallback) {
  const t = (line || '').trim()
  if (t) {
    return t.endsWith('.') ? t : t + '.'
  }
  return fallback
}

function combinedLogs(result) {
  const out = String(result && result.stdout ? result.stdout : '')
  const err = String(result && result.stderr ? result.stderr : '')
  if (out && err) return out + '\n' + err
  return out + err
}

export function cleanLog(text, max = 3000) {
  if (typeof text !== 'string') return ''
  let limit = max
  if (!Number.isInteger(limit) || limit < 0) limit = 3000
  let s = text.slice(-limit)
  // OSC sequences, then CSI sequences, then other two-character escapes (all start with the ESC character)
  s = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  s = s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
  s = s.replace(/\x1b[@-Z\\-_]/g, '')
  // remove control chars other than newline and tab
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  // redact token-looking runs
  s = s.replace(/[A-Za-z0-9\-_+/]{32,}/g, '[redacted]')
  return s
}

function isValidImage(image) {
  return isImage(image)
}

function invalidImageError() {
  return 'invalid image.'
}

export function createSandbox({ docker, pack, sleep, now, log, newRunId, image, limits } = {}) {
  const runId = typeof newRunId === 'function' ? newRunId() : defaultNewRunId()
  const lim = limits !== undefined ? limits : { memoryMb: 4096, cpus: 4, pids: 1024 }
  const dockerFn = docker
  const packFn = pack
  const sleepFn = typeof sleep === 'function' ? sleep : (ms) => new Promise((r) => setTimeout(r, ms))
  const nowFn = typeof now === 'function' ? now : Date.now
  const logFn = typeof log === 'function' ? log : () => {}

  function imageOk() {
    return isValidImage(image)
  }

  async function callDocker(args, opts) {
    try {
      const res = await dockerFn(args, opts)
      return { ok: true, res }
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e)
      if (msg.toLowerCase().includes('timed out')) {
        return { ok: false, error: 'Docker command timed out.' }
      }
      return { ok: false, error: failWithLine(firstLine(msg), 'Docker command failed.') }
    }
  }

  async function prepare({ dir } = {}) {
    if (!imageOk()) return { ok: false, error: invalidImageError() }
    // 1: network open
    let built = networkCreateArgs({ runId, short: 'open', internal: false })
    if (!built.ok) return { ok: false, error: built.error }
    let r = await callDocker(built.args)
    if (!r.ok) return { ok: false, error: r.error }
    if (r.res.code !== 0) {
      return { ok: false, error: failWithLine(firstLine(r.res.stderr), 'Could not create the network.'), logs: cleanLog(combinedLogs(r.res)) }
    }
    // 2: network int
    built = networkCreateArgs({ runId, short: 'int', internal: true })
    if (!built.ok) return { ok: false, error: built.error }
    r = await callDocker(built.args)
    if (!r.ok) return { ok: false, error: r.error }
    if (r.res.code !== 0) {
      return { ok: false, error: failWithLine(firstLine(r.res.stderr), 'Could not create the network.'), logs: cleanLog(combinedLogs(r.res)) }
    }
    // 3: volume
    built = volumeCreateArgs({ runId, short: 'work' })
    if (!built.ok) return { ok: false, error: built.error }
    r = await callDocker(built.args)
    if (!r.ok) return { ok: false, error: r.error }
    if (r.res.code !== 0) {
      return { ok: false, error: failWithLine(firstLine(r.res.stderr), 'Could not create the volume.'), logs: cleanLog(combinedLogs(r.res)) }
    }
    // 4: init volume
    built = initVolumeArgs({ runId, short: 'work', image })
    if (!built.ok) return { ok: false, error: built.error }
    r = await callDocker(built.args)
    if (!r.ok) return { ok: false, error: r.error }
    if (r.res.code !== 0) {
      return { ok: false, error: failWithLine(firstLine(r.res.stderr), 'Could not prepare the volume.'), logs: cleanLog(combinedLogs(r.res)) }
    }
    // 5: seed
    let archive
    try {
      archive = await packFn(dir)
    } catch {
      return { ok: false, error: 'Could not pack the directory.' }
    }
    built = runArgs({
      runId,
      short: 'seed',
      role: 'seed',
      image,
      networks: ['int'],
      volume: { short: 'work', path: '/work' },
      workdir: '/work',
      user: '1000:1000',
      cmd: ['tar', '-xf', '-', '-C', '/work'],
      env: {},
      tmpfs: [],
      caps: [],
      limits: lim,
      interactive: true,
      rm: true,
      detach: false,
      readOnly: true
    })
    if (!built.ok) return { ok: false, error: built.error }
    r = await callDocker(built.args, { input: archive })
    if (!r.ok) return { ok: false, error: r.error }
    if (r.res.code !== 0) {
      return { ok: false, error: failWithLine(firstLine(r.res.stderr), 'Could not seed the volume.'), logs: cleanLog(combinedLogs(r.res)) }
    }
    logFn('prepared ' + runId)
    return { ok: true }
  }

  async function startServices(resolved, { timeoutMs = 90000 } = {}) {
    if (!imageOk()) return { ok: false, error: invalidImageError() }
    const list = Array.isArray(resolved) ? resolved : []
    const secs = Math.round(timeoutMs / 1000)
    for (const svc of list) {
      const name = svc && svc.name ? String(svc.name) : 'unknown'
      if (!svc || !Array.isArray(svc.cmd)) {
        return { ok: false, error: 'Service ' + name + ' has no start command.' }
      }
      const built = runArgs({
        runId,
        short: 'svc-' + name,
        role: 'service',
        image: svc.image,
        networks: ['int'],
        aliases: [svc.alias || name],
        volume: null,
        user: null,
        cmd: [...svc.cmd],
        env: { ...(svc.env || {}) },
        tmpfs: [...(svc.tmpfs || [])],
        caps: [...(svc.caps || [])],
        limits: lim,
        interactive: false,
        detach: true,
        rm: false,
        readOnly: false
      })
      if (!built.ok) return { ok: false, error: built.error }
      const started = await callDocker(built.args)
      if (!started.ok) return { ok: false, error: started.error }
      if (started.res.code !== 0) {
        return { ok: false, error: failWithLine(firstLine(started.res.stderr), 'Service ' + name + ' failed to start.'), logs: cleanLog(combinedLogs(started.res)) }
      }
      // health loop
      const begin = nowFn()
      for (;;) {
        const hb = execArgs({ runId, short: 'svc-' + name, cmd: [...svc.health] })
        if (!hb.ok) return { ok: false, error: hb.error }
        let hr
        try {
          hr = await dockerFn(hb.args)
        } catch (e) {
          const msg = e && e.message ? String(e.message) : String(e)
          if (msg.toLowerCase().includes('timed out')) return { ok: false, error: 'Docker command timed out.' }
          return { ok: false, error: failWithLine(firstLine(msg), 'Docker command failed.') }
        }
        if (hr.code === 0) break
        if (nowFn() - begin >= timeoutMs) {
          const cname = names(runId, 'svc-' + name)
          let text = ''
          try {
            const lr = await dockerFn(['logs', '--tail', '200', cname])
            text = cleanLog(combinedLogs(lr))
          } catch {
            text = ''
          }
          return { ok: false, error: 'Service ' + name + ' did not become ready within ' + secs + ' seconds.', logs: text }
        }
        await sleepFn(1000)
        if (nowFn() - begin >= timeoutMs) {
          const cname = names(runId, 'svc-' + name)
          let text = ''
          try {
            const lr = await dockerFn(['logs', '--tail', '200', cname])
            text = cleanLog(combinedLogs(lr))
          } catch {
            text = ''
          }
          return { ok: false, error: 'Service ' + name + ' did not become ready within ' + secs + ' seconds.', logs: text }
        }
      }
    }
    return { ok: true }
  }

  async function install(steps, { env = {}, timeoutMs = 900000 } = {}) {
    if (!imageOk()) return { ok: false, error: invalidImageError() }
    const list = Array.isArray(steps) ? steps : []
    const done = []
    let n = 0
    for (const step of list) {
      n += 1
      const cmd = [step.cmd, ...(step.args || [])]
      const short = 'install-' + n
      const cname = names(runId, short)
      const built = createArgs({
        runId,
        short,
        role: 'install',
        image,
        networks: ['open'],
        volume: { short: 'work', path: '/work' },
        workdir: '/work',
        user: '1000:1000',
        cmd,
        env: { ...env, HOME: '/work/.home', CI: '1' },
        tmpfs: [],
        caps: [],
        limits: lim,
        interactive: false,
        detach: false,
        rm: false,
        readOnly: true
      })
      if (!built.ok) return { ok: false, error: built.error }
      const label = step.cmd + (step.args && step.args.length > 0 ? ' ' + step.args[0] : '')
      const failStep = async (code, resLogs) => {
        try {
          const rb = removeArgs({ kind: 'container', ids: [cname] })
          if (rb.ok) await callDocker(rb.args)
        } catch {}
        return { ok: false, error: 'Step ' + n + ' (' + label + ') exited with code ' + code + '.', logs: resLogs }
      }
      let cr = await callDocker(built.args)
      if (!cr.ok) return { ok: false, error: cr.error }
      if (cr.res.code !== 0) {
        return await failStep(cr.res.code, cleanLog(combinedLogs(cr.res)))
      }
      const conn = networkConnectArgs({ runId, networkShort: 'int', containerShort: short })
      if (!conn.ok) return { ok: false, error: conn.error }
      const nr = await callDocker(conn.args)
      if (!nr.ok) return { ok: false, error: nr.error }
      if (nr.res.code !== 0) {
        return await failStep(nr.res.code, cleanLog(combinedLogs(nr.res)))
      }
      const st = startArgs({ runId, short, attach: true })
      if (!st.ok) return { ok: false, error: st.error }
      const sr = await callDocker(st.args, { timeoutMs })
      if (!sr.ok) return { ok: false, error: sr.error }
      const tail = cleanLog(combinedLogs(sr.res))
      if (sr.res.code !== 0) {
        return await failStep(sr.res.code, tail)
      }
      try {
        const rb = removeArgs({ kind: 'container', ids: [cname] })
        if (rb.ok) await callDocker(rb.args)
      } catch {}
      done.push({ n, cmd: step.cmd, code: 0, tail })
    }
    return { ok: true, steps: done }
  }

  async function startApp({ cmd, args, env = {}, port } = {}) {
    if (!imageOk()) return { ok: false, error: invalidImageError() }
    const argv = [cmd, ...(args || [])]
    const built = runArgs({
      runId,
      short: 'app',
      role: 'app',
      image,
      networks: ['int'],
      volume: { short: 'work', path: '/work' },
      workdir: '/work',
      user: '1000:1000',
      cmd: argv,
      env: { ...env, HOME: '/work/.home', PORT: String(port) },
      tmpfs: [],
      caps: [],
      limits: lim,
      interactive: false,
      detach: true,
      rm: false,
      readOnly: true
    })
    if (!built.ok) return { ok: false, error: built.error }
    const r = await callDocker(built.args)
    if (!r.ok) return { ok: false, error: r.error }
    if (r.res.code !== 0) {
      return { ok: false, error: failWithLine(firstLine(r.res.stderr), 'Could not start the app.'), logs: cleanLog(combinedLogs(r.res)) }
    }
    const insp = inspectIpArgs({ runId, short: 'app', networkShort: 'int' })
    if (!insp.ok) return { ok: false, error: insp.error }
    const ir = await callDocker(insp.args)
    if (!ir.ok) return { ok: false, error: ir.error }
    if (ir.res.code !== 0) {
      return { ok: false, error: 'Could not find the app address.' }
    }
    const ip = String(ir.res.stdout || '').trim()
    const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    let valid = false
    if (m) {
      valid = m.slice(1).every((p) => Number(p) >= 0 && Number(p) <= 255)
    }
    if (!valid) return { ok: false, error: 'Could not find the app address.' }
    return { ok: true, host: ip, port }
  }

  async function logs(lines = 200) {
    if (!imageOk()) return { ok: false, error: invalidImageError() }
    if (!Number.isInteger(lines) || lines < 1 || lines > 1000) {
      return { ok: false, error: 'lines must be an integer from 1 to 1000.' }
    }
    const cname = names(runId, 'app')
    if (!cname) return { ok: false, error: 'invalid runId.' }
    const r = await callDocker(['logs', '--tail', String(lines), cname])
    if (!r.ok) return { ok: false, error: r.error }
    if (r.res.code !== 0) {
      return { ok: false, error: failWithLine(firstLine(r.res.stderr), 'Could not read the logs.'), logs: cleanLog(combinedLogs(r.res)) }
    }
    return { ok: true, text: cleanLog(combinedLogs(r.res)) }
  }

  async function running() {
    if (!imageOk()) return { ok: false, error: invalidImageError() }
    const cname = names(runId, 'app')
    if (!cname) return { ok: false, error: 'invalid runId.' }
    const r = await callDocker(['inspect', '--format', '{{.State.Running}}', cname])
    if (!r.ok) return { ok: false, error: r.error }
    if (r.res.code !== 0) {
      return { ok: false, error: failWithLine(firstLine(r.res.stderr), 'Could not inspect the app.'), logs: cleanLog(combinedLogs(r.res)) }
    }
    const v = String(r.res.stdout || '').trim()
    return { ok: true, running: v === 'true' }
  }

  function parseList(res) {
    const s = String((res && res.stdout ? res.stdout : '') || '')
    return s.split(/[\s]+/).map((x) => x.trim()).filter((x) => x.length > 0)
  }

  async function destroy() {
    const counts = { containers: 0, networks: 0, volumes: 0 }
    try {
      let cids = []
      let nids = []
      let vids = []
      try {
        const b = listArgs({ runId, kind: 'container' })
        if (b.ok) {
          const r = await callDocker(b.args)
          if (r.ok && r.res.code === 0) cids = parseList(r.res)
        }
      } catch {}
      try {
        const b = listArgs({ runId, kind: 'network' })
        if (b.ok) {
          const r = await callDocker(b.args)
          if (r.ok && r.res.code === 0) nids = parseList(r.res)
        }
      } catch {}
      try {
        const b = listArgs({ runId, kind: 'volume' })
        if (b.ok) {
          const r = await callDocker(b.args)
          if (r.ok && r.res.code === 0) vids = parseList(r.res)
        }
      } catch {}
      counts.containers = cids.length
      counts.networks = nids.length
      counts.volumes = vids.length
      if (cids.length > 0) {
        try {
          const b = removeArgs({ kind: 'container', ids: cids })
          if (b.ok) await callDocker(b.args)
        } catch {}
      }
      if (nids.length > 0) {
        try {
          const b = removeArgs({ kind: 'network', ids: nids })
          if (b.ok) await callDocker(b.args)
        } catch {}
      }
      if (vids.length > 0) {
        try {
          const b = removeArgs({ kind: 'volume', ids: vids })
          if (b.ok) await callDocker(b.args)
        } catch {}
      }
    } catch {}
    return { ok: true, removed: counts }
  }

  return { runId, prepare, startServices, install, startApp, logs, running, destroy }
}

export async function cleanStale({ docker, olderThanMinutes = 120, now = Date.now } = {}) {
  const removed = { containers: 0, networks: 0, volumes: 0 }
  const cutoff = olderThanMinutes * 60 * 1000
  // how to ask each kind for its creation time and run label (fixed arrays: the only variable part is an id we listed ourselves)
  const kinds = [
    { kind: 'container', key: 'containers', inspect: id => ['inspect', '--format', '{{.Created}} {{index .Config.Labels "behique.run"}}', id] },
    { kind: 'network', key: 'networks', inspect: id => ['network', 'inspect', '--format', '{{.Created}} {{index .Labels "behique.run"}}', id] },
    { kind: 'volume', key: 'volumes', inspect: id => ['volume', 'inspect', '--format', '{{.CreatedAt}} {{index .Labels "behique.run"}}', id] }
  ]
  const words = r => String((r && r.stdout) || '').split(/\s+/).map(x => x.trim()).filter(Boolean)
  try {
    for (const k of kinds) {
      const listed = listAllArgs({ kind: k.kind })
      if (!listed.ok) continue
      let ids = []
      try { const r = await docker(listed.args); if (r && r.code === 0) ids = words(r) } catch { continue }
      const old = []
      for (const id of ids) {
        try {
          const r = await docker(k.inspect(id))
          if (!r || r.code !== 0) continue
          const ms = Date.parse(String(r.stdout || '').trim().split(' ')[0])
          if (!Number.isNaN(ms) && now() - ms > cutoff) old.push(id)
        } catch { /* skip what cannot be inspected */ }
      }
      if (old.length === 0) continue
      const rm = removeArgs({ kind: k.kind, ids: old })
      if (!rm.ok) continue
      try { await docker(rm.args); removed[k.key] = old.length } catch { /* counted only when the call went through */ }
    }
  } catch { /* never throws */ }
  return { ok: true, removed }
}
