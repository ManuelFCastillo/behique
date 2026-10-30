// inspectRepo: collect read-only facts about a repo so a model can propose a profile.
//   node --test src/release/onboard/inspect.test.mjs
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'

function runGit(repoPath, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repoPath, ...args], (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout).trim())
    })
  })
}

// Placeholder default so the signature matches the spec. The real runner
// is bound to repoPath inside inspectRepo when this exact function is used.
export function defaultGit() {
  throw new Error('defaultGit is a placeholder, inspectRepo binds the repo path')
}

async function tryRun(run, args) {
  try {
    return await run(args)
  } catch {
    return null
  }
}

async function exists(path) {
  try {
    await fs.stat(path)
    return true
  } catch {
    return false
  }
}

export async function inspectRepo(repoPath, { git = defaultGit } = {}) {
  const run = git === defaultGit ? (args) => runGit(repoPath, args) : git

  let isGit = false
  try {
    await run(['rev-parse', '--is-inside-work-tree'])
    isGit = true
  } catch {
    isGit = false
  }

  let tags = []
  if (isGit) {
    const out = await tryRun(run, ['tag', '--sort=-version:refname'])
    if (out !== null && out !== '') {
      tags = out.split('\n').map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 10)
    }
  }

  let branch = null
  if (isGit) {
    const out = await tryRun(run, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (out !== null && out !== '' && out !== 'HEAD') branch = out
  }

  let headSubject = null
  if (isGit) {
    const out = await tryRun(run, ['log', '-1', '--format=%s'])
    if (out !== null && out !== '') headSubject = out
  }

  let topLevel = []
  try {
    const entries = await fs.readdir(repoPath)
    topLevel = entries.filter((e) => e !== '.git' && e !== 'node_modules').sort().slice(0, 60)
  } catch {
    topLevel = []
  }

  let packageJson = null
  try {
    const raw = await fs.readFile(join(repoPath, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const name = typeof parsed.name === 'string' ? parsed.name : null
      let scripts = {}
      if (parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)) {
        for (const [k, v] of Object.entries(parsed.scripts)) {
          if (typeof v === 'string') scripts[k] = v
        }
      }
      const deps = parsed.dependencies && typeof parsed.dependencies === 'object' && !Array.isArray(parsed.dependencies)
        ? Object.keys(parsed.dependencies)
        : []
      const devDeps = parsed.devDependencies && typeof parsed.devDependencies === 'object' && !Array.isArray(parsed.devDependencies)
        ? Object.keys(parsed.devDependencies)
        : []
      packageJson = { name, scripts, dependencies: deps, devDependencies: devDeps }
    }
  } catch {
    packageJson = null
  }

  let lockfile = null
  for (const cand of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
    try {
      if (await exists(join(repoPath, cand))) {
        lockfile = cand
        break
      }
    } catch {
      continue
    }
  }

  let hasIndexHtml = false
  let hasDockerfile = false
  let hasMakefile = false
  try {
    hasIndexHtml = await exists(join(repoPath, 'index.html'))
  } catch {
    hasIndexHtml = false
  }
  try {
    hasDockerfile = await exists(join(repoPath, 'Dockerfile'))
  } catch {
    hasDockerfile = false
  }
  try {
    hasMakefile = await exists(join(repoPath, 'Makefile'))
  } catch {
    hasMakefile = false
  }

  let readme = null
  for (const cand of ['README.md', 'README', 'readme.md']) {
    try {
      const raw = await fs.readFile(join(repoPath, cand), 'utf8')
      readme = raw.slice(0, 3000)
      break
    } catch {
      continue
    }
  }

  return {
    path: repoPath,
    isGit,
    tags,
    branch,
    headSubject,
    topLevel,
    packageJson,
    lockfile,
    hasIndexHtml,
    hasDockerfile,
    hasMakefile,
    readme
  }
}
