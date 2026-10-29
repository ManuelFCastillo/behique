// Category of a replayed finding. See rescore.mjs for what each category means.
export function categorize(f) {
  if (f.verdict !== 'wrong_expectation') return { cat: f.verdict }
  const a = f.assert ?? {}
  const blob = JSON.stringify(a)
  if (a.kind === 'text' && /1 tasks? remaining/.test(blob)) return { cat: 'real_unplanted' }
  const last = a.steps?.at(-1)
  let why = 'bad expectation'
  if (a.kind === 'api' && last) {
    if (/^\/api\/login/.test(last.path)) why = 'guessed a login route'
    else if ((last.method ?? 'GET').toUpperCase() === 'GET' && /^\/api\/todos\/\d+/.test(last.path)) why = 'guessed a GET-one route'
    else if (last.body && 'title' in last.body && !('text' in last.body)) why = 'guessed the field name "title"'
    else if ((last.method ?? '').toUpperCase() === 'PATCH' && last.body && 'text' in last.body) why = 'assumed PATCH edits text'
  }
  return { cat: 'false_alarm', why }
}
