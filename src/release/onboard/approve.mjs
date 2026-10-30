// A narrow standing approval for the repair loop, for runs inside a sandbox where nobody is at the keyboard.
// A person approved the first profile's commands. A corrected profile is approved here ONLY if it asks for nothing new in kind:
//   - an install or serve line whose program was already approved (new arguments, not a new program),
//   - an env line (the profile checker already refused credential-looking names),
//   - a service line (a throwaway database or cache from the catalog, sandbox only).
// Anything that downloads and runs packages (npx, dlx, exec), a new program, or turning the repository's lifecycle scripts on is NOT approved:
// the loop stops with "not approved" and a person decides. The reasons are returned so the run can print exactly what was allowed.
const WARNED = /\((downloads and runs packages|downloads and runs code)/

function program(line) {
  const m = line.match(/^(?:install|serve): (\S+)/)
  return m ? m[1] : null
}

/** `approvedLines`: every line approved so far (the loop passes its own list). Returns { ok, reasons, refused }. */
export function scopedApprove({ added = [], approvedLines = [] } = {}) {
  const programs = new Set(approvedLines.map(program).filter(Boolean))
  const reasons = [], refused = []
  for (const line of added) {
    const text = String(line)
    if (WARNED.test(text) || /lifecycle scripts/.test(text)) { refused.push(`${text}  [runs code from the internet or turns scripts on]`); continue }
    const prog = program(text)
    if (prog) {
      if (programs.has(prog)) reasons.push(`${text}  [same program as before: ${prog}]`)
      else refused.push(`${text}  [new program: ${prog}]`)
      continue
    }
    if (text.startsWith('env: ')) { reasons.push(`${text}  [environment value]`); continue }
    if (text.startsWith('service: ')) { reasons.push(`${text}  [throwaway sidecar, sandbox only]`); continue }
    refused.push(`${text}  [unknown kind of line]`)
  }
  return { ok: refused.length === 0, reasons, refused }
}
