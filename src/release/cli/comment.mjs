// Post a check's result as one comment on a pull request, through `gh api`, and update that same comment on later runs.
// The body is marked so the comment can be found again; it is passed to gh as a file, never as an argument.
//   node --test src/release/cli/comment.test.mjs
import { markdownOf } from './result.mjs'

export const MARKER = '<!-- behique-check -->'
const REPO_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$/
const num = v => Number.isInteger(v) && v > 0 && v < 1e12

export function commentBody(result) {
  return `${MARKER}\n${markdownOf(result)}`
}

/** The fixed gh arguments. Every value is validated here, so none can become a flag. */
export function listArgs({ repo, pr }) {
  if (!REPO_RE.test(String(repo))) throw new Error('repo must be owner/name')
  if (!num(pr)) throw new Error('pr must be a positive whole number')
  return ['api', `repos/${repo}/issues/${pr}/comments`, '--paginate', '--jq', `.[] | select(.body | startswith("${MARKER}")) | .id`]
}
export function createArgs({ repo, pr, bodyFile }) {
  if (!REPO_RE.test(String(repo))) throw new Error('repo must be owner/name')
  if (!num(pr)) throw new Error('pr must be a positive whole number')
  if (typeof bodyFile !== 'string' || !bodyFile || bodyFile.startsWith('-')) throw new Error('bodyFile must be a path')
  return ['api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '-F', `body=@${bodyFile}`]
}
export function updateArgs({ repo, id, bodyFile }) {
  if (!REPO_RE.test(String(repo))) throw new Error('repo must be owner/name')
  if (!num(id)) throw new Error('id must be a positive whole number')
  if (typeof bodyFile !== 'string' || !bodyFile || bodyFile.startsWith('-')) throw new Error('bodyFile must be a path')
  return ['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${id}`, '-F', `body=@${bodyFile}`]
}

/**
 * Create or update the Behique comment on a pull request. `run(args)` runs gh and resolves { code, stdout, stderr };
 * `writeBody(text)` saves the body and returns its path. Resolves { ok, action, id } or { ok: false, error }. Never throws.
 */
export async function postComment({ repo, pr, result, run, writeBody }) {
  let args
  try { args = listArgs({ repo, pr }) } catch (e) { return { ok: false, error: e.message } }
  const bodyFile = await writeBody(commentBody(result))
  const found = await run(args)
  if (found.code !== 0) return { ok: false, error: `could not list the pull request's comments: ${String(found.stderr || found.stdout).trim().slice(0, 200)}` }
  const ids = String(found.stdout).split(/\s+/).map(s => Number(s)).filter(n => num(n))
  const res = ids.length ? await run(updateArgs({ repo, id: ids[0], bodyFile })) : await run(createArgs({ repo, pr, bodyFile }))
  if (res.code !== 0) return { ok: false, error: `could not ${ids.length ? 'update' : 'create'} the comment: ${String(res.stderr || res.stdout).trim().slice(0, 200)}` }
  let id = ids[0] ?? null
  if (!id) { try { id = JSON.parse(res.stdout).id ?? null } catch {} }
  return { ok: true, action: ids.length ? 'updated' : 'created', id }
}
