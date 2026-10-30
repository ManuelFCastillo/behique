// Spec files for the Muse builder: a markdown file with a small header, then the spec text.
//   ---
//   part: short-name
//   owns:            files the model may create or overwrite (nothing else is ever written)
//     - src/x/a.mjs
//   context:         existing files shown to the model
//     - src/y/b.mjs
//   test: node --test src/x/a.test.mjs     the acceptance command (must start with "node ")
//   allow: [child_process]                 risky patterns this part is expected to use (see scan())
//   ---
import { isAbsolute, normalize } from 'node:path'

export function parseSpec(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) throw new Error('a spec must start with a --- header')
  const head = { owns: [], context: [], allow: [] }
  let list = null
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue
    const item = line.match(/^\s+-\s+(.+)$/)
    if (item && list) { head[list].push(item[1].trim()); continue }
    const kv = line.match(/^(\w+):\s*(.*)$/)
    if (!kv) throw new Error('cannot read header line: ' + line)
    const [, k, v] = kv
    if (['owns', 'context', 'allow'].includes(k)) {
      list = k
      if (v.trim().startsWith('[')) { head[k] = v.trim().slice(1, -1).split(',').map(s => s.trim()).filter(Boolean); list = null }
      else if (v.trim()) throw new Error(`${k} must be a list`)
    } else { head[k] = v.trim(); list = null }
  }
  return { ...head, body: m[2].trim() }
}

const OK_ROOTS = ['src/', 'docs/', 'bench/', 'tools/']
/** Why a path may not be written or shown, or null. Never .env, never outside the repo, never above it. */
export function pathProblem(p) {
  if (typeof p !== 'string' || !p || isAbsolute(p)) return 'must be a relative path'
  const n = normalize(p)
  if (n.startsWith('..') || n.includes('/../')) return 'must stay inside the repository'
  if (/(^|\/)\.env/.test(n)) return 'environment files are never touched'
  if (/(^|\/)(node_modules|\.git)(\/|$)/.test(n)) return 'not node_modules or .git'
  if (!OK_ROOTS.some(r => n.startsWith(r))) return `must be under ${OK_ROOTS.join(' ')}`
  return null
}

export function validateSpec(s) {
  const bad = []
  if (!s.part) bad.push('part is required')
  if (!s.owns.length) bad.push('owns must list at least one file')
  for (const p of s.owns) { const e = pathProblem(p); if (e) bad.push(`owns ${p}: ${e}`) }
  for (const p of s.context) { const e = pathProblem(p); if (e) bad.push(`context ${p}: ${e}`) }
  if (!/^node /.test(s.test ?? '')) bad.push('test must be a command that starts with "node "')
  if (/[;&|`$<>]/.test(s.test ?? '')) bad.push('test must be a plain command: no shell operators')
  return bad
}

/** Files in a model answer: blocks of "=== FILE: path ===" ... "=== END FILE ===". A wrapping code fence is tolerated. */
export function parseFiles(answer) {
  const out = []
  const re = /^=== FILE: (.+?) ===\n([\s\S]*?)\n=== END FILE ===[ \t]*$/gm
  for (const m of String(answer).matchAll(re)) {
    let body = m[2]
    const fence = body.match(/^```[\w-]*\n([\s\S]*?)\n```\s*$/)
    if (fence) body = fence[1]
    out.push({ path: m[1].trim(), content: body.endsWith('\n') ? body : body + '\n' })
  }
  return out
}

// Patterns a generated file is not expected to contain unless the spec allows them. The scan is a tripwire, not a sandbox:
// a human reads the files too. Each pattern has a name the spec's `allow` list can use.
const RISKY = {
  env_files: /\.env\b|process\.env/,
  deletes: /\b(rmSync|rmdirSync|unlinkSync|rimraf)\b|\brm\s+-/,
  child_process: /node:child_process|from 'child_process'|require\('child_process'\)/,
  external_network: /https?:\/\/(?!127\.0\.0\.1|localhost|github\.com\/[\w.-]+\/[\w.-]+\/commit)/,
  dynamic_code: /\beval\(|new Function\(/,
}
export function scan(files, allow = []) {
  const flagged = []
  for (const f of files) for (const [name, re] of Object.entries(RISKY)) if (!allow.includes(name) && re.test(f.content)) flagged.push({ path: f.path, pattern: name })
  return flagged
}
