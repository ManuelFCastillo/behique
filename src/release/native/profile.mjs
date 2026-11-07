// Command profile: how to build and run a native (non-web) program, as DATA, for Behique's native mode.
//   node --test src/release/native/profile.test.mjs
// A web profile says how to serve an app and where to click. A command profile says how to build a program from a
// checkout and which cases to run: a command, the input files it reads, and which output files to record.
//
//   {
//     "kind": "command",
//     "name": "windninja",
//     "repo": "/path/to/checkout",
//     "build": { "dir": "build", "steps": [["cmake", "{src}", "-DNINJA_GUI=OFF"], ["make", "-j4"]] },
//     "env": { "WINDNINJA_DATA": "{src}/data" },
//     "cases": [{ "id": "domavg", "command": ["{build}/src/cli/WindNinja_cli", "{run}/run.cfg"],
//                 "files": { "run.cfg": "elevation_file = {src}/data/x.tif\noutput_path = {run}\n" },
//                 "outputs": ["*.asc"], "timeoutMs": 600000 }],
//     "noise": { "lines": ["seconds\\.$"], "names": [["\\d{2}-\\d{2}-\\d{4}_\\d{4}", "<date>"]] }
//   }
//
// Placeholders: {src} the checkout, {build} the build folder, {run} a fresh folder made for each run of a case (inputs
// are written there and the command runs there). Commands are argument lists, never shell strings, so nothing in a
// profile is interpreted by a shell. Build steps may only start with a known build tool; a case's command must be a
// program inside the checkout or build folder, or one of a few interpreters. A profile is still code the person approves:
// these rules stop accidents and smuggled shell syntax, not a hostile profile, which is what the sandbox is for.
import { isAbsolute, normalize, sep } from 'node:path'

export const BUILD_TOOLS = ['cmake', 'make', 'ninja', 'meson', 'msbuild', 'devenv', 'ctest']
export const INTERPRETERS = ['node', 'python3']
const TOP = new Set(['kind', 'name', 'repo', 'build', 'env', 'cases', 'noise', 'notes'])
const CASE = new Set(['id', 'command', 'files', 'outputs', 'timeoutMs', 'probes', 'notes'])
const NAME_RE = /^[a-z0-9-]+$/
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/
const PLACEHOLDERS = ['src', 'build', 'run']
const MAX_TIMEOUT_MS = 6 * 3600e3

const isStr = s => typeof s === 'string' && s.length > 0
const isArgv = a => Array.isArray(a) && a.length > 0 && a.every(s => typeof s === 'string')
const unknown = (obj, allowed, where) => Object.keys(obj).filter(k => !allowed.has(k)).map(k => `${where}: unknown field "${k}"`)

/** Placeholders a string uses that are not known. */
function badPlaceholders(s) {
  return [...s.matchAll(/\{([a-z]+)\}/g)].map(m => m[1]).filter(p => !PLACEHOLDERS.includes(p))
}

/** A relative path that stays inside its folder: no absolute paths, no "..". */
export function safeRelative(p) {
  if (!isStr(p) || isAbsolute(p) || /^[A-Za-z]:/.test(p)) return false
  return !normalize(p).split(/[\\/]/).includes('..') && !normalize(p).startsWith(sep)
}

function checkRegex(src, where) {
  try { new RegExp(src); return [] } catch (e) { return [`${where}: not a valid pattern (${e.message})`] }
}

/** Problems with a command profile, as plain sentences. An empty list means it is valid. */
export function validateCommandProfile(p) {
  const out = []
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['the profile must be an object']
  out.push(...unknown(p, TOP, 'profile'))
  if (p.kind !== 'command') out.push('profile: "kind" must be "command"')
  if (!isStr(p.name) || !NAME_RE.test(p.name)) out.push('profile: "name" must be lowercase letters, digits and dashes')
  if (!isStr(p.repo)) out.push('profile: "repo" must be the path of a git checkout')

  const b = p.build
  if (!b || typeof b !== 'object') out.push('build: required, with "dir" and "steps"')
  else {
    if (!safeRelative(b.dir)) out.push('build.dir: must be a relative folder inside the checkout, such as "build"')
    if (!Array.isArray(b.steps) || !b.steps.length) out.push('build.steps: at least one step is required')
    else b.steps.forEach((s, i) => {
      if (!isArgv(s)) return out.push(`build.steps[${i}]: must be a list of strings, such as ["make", "-j4"]`)
      if (!BUILD_TOOLS.includes(s[0])) out.push(`build.steps[${i}]: "${s[0]}" is not a known build tool (${BUILD_TOOLS.join(', ')})`)
      s.forEach(a => badPlaceholders(a).forEach(x => out.push(`build.steps[${i}]: unknown placeholder {${x}}`)))
    })
  }

  if (p.env !== undefined) {
    if (!p.env || typeof p.env !== 'object' || Array.isArray(p.env)) out.push('env: must map names to strings')
    else for (const [k, v] of Object.entries(p.env)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) out.push(`env: "${k}" is not a valid variable name`)
      if (typeof v !== 'string') out.push(`env.${k}: must be a string`)
      else badPlaceholders(v).forEach(x => out.push(`env.${k}: unknown placeholder {${x}}`))
    }
  }

  if (!Array.isArray(p.cases) || !p.cases.length) out.push('cases: at least one case is required')
  else {
    const ids = new Set()
    p.cases.forEach((c, i) => {
      const at = `cases[${i}]`
      if (!c || typeof c !== 'object') return out.push(`${at}: must be an object`)
      out.push(...unknown(c, CASE, at))
      if (!isStr(c.id) || !ID_RE.test(c.id)) out.push(`${at}.id: lowercase letters, digits, "_" and "-"`)
      else if (ids.has(c.id)) out.push(`${at}.id: "${c.id}" is used twice`)
      else ids.add(c.id)
      if (!isArgv(c.command)) out.push(`${at}.command: must be a list of strings`)
      else {
        const prog = c.command[0]
        if (!INTERPRETERS.includes(prog) && !/^\{(src|build)\}\//.test(prog)) {
          out.push(`${at}.command: the program must start with {build}/ or {src}/, or be one of ${INTERPRETERS.join(', ')}`)
        }
        if (/\.\.[\\/]/.test(prog)) out.push(`${at}.command: the program path may not contain ".."`)
        c.command.forEach(a => badPlaceholders(a).forEach(x => out.push(`${at}.command: unknown placeholder {${x}}`)))
      }
      if (c.files !== undefined) {
        if (!c.files || typeof c.files !== 'object' || Array.isArray(c.files)) out.push(`${at}.files: must map file names to text`)
        else for (const [name, text] of Object.entries(c.files)) {
          if (!safeRelative(name)) out.push(`${at}.files: "${name}" must be a relative path inside the run folder`)
          if (typeof text !== 'string') out.push(`${at}.files.${name}: must be text`)
          else badPlaceholders(text).forEach(x => out.push(`${at}.files.${name}: unknown placeholder {${x}}`))
        }
      }
      if (c.outputs !== undefined && !(Array.isArray(c.outputs) && c.outputs.every(isStr))) out.push(`${at}.outputs: must be a list of file patterns, such as ["*.asc"]`)
      if (c.timeoutMs !== undefined && !(Number.isInteger(c.timeoutMs) && c.timeoutMs > 0 && c.timeoutMs <= MAX_TIMEOUT_MS)) out.push(`${at}.timeoutMs: a whole number of milliseconds, at most 6 hours`)
      if (c.probes !== undefined) {
        if (!Array.isArray(c.probes)) out.push(`${at}.probes: must be a list`)
        else c.probes.forEach((pr, j) => {
          const pa = `${at}.probes[${j}]`
          if (!pr || !isStr(pr.name) || !ID_RE.test(pr.name)) out.push(`${pa}.name: lowercase letters, digits, "_" and "-"`)
          if (!pr || !isStr(pr.file)) out.push(`${pa}.file: a pattern naming one output grid, such as "*_ang.asc"`)
          if (!pr || !Number.isFinite(pr.x) || !Number.isFinite(pr.y)) out.push(`${pa}: "x" and "y" must be numbers in the grid's own coordinates`)
        })
      }
    })
  }

  if (p.noise !== undefined) {
    const n = p.noise
    if (!n || typeof n !== 'object') out.push('noise: must be an object')
    else {
      if (n.lines !== undefined) {
        if (!Array.isArray(n.lines)) out.push('noise.lines: must be a list of patterns')
        else n.lines.forEach((r, i) => out.push(...checkRegex(r, `noise.lines[${i}]`)))
      }
      if (n.names !== undefined) {
        if (!Array.isArray(n.names)) out.push('noise.names: must be a list of [pattern, replacement] pairs')
        else n.names.forEach((pair, i) => {
          if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(s => typeof s === 'string')) out.push(`noise.names[${i}]: must be [pattern, replacement]`)
          else out.push(...checkRegex(pair[0], `noise.names[${i}]`))
        })
      }
    }
  }
  return out
}

/** Replace {src}, {build} and {run} in a string. Unknown placeholders were refused by validation. */
export function expand(s, vars) {
  return s.replace(/\{(src|build|run)\}/g, (m, k) => (vars[k] === undefined ? m : vars[k]))
}
