// Vision (Boinayel): a model looks at ONE screenshot and PROPOSES controls and where they are. Nothing here is a fact.
// Settings come from Phase 0 (docs/canvas-senses-plan.md): screenshot at device scale 2, viewport only, coordinates as
// 0 to 1 decimals, reasoning low, "not found" allowed. `ask` is injected so tests run offline:
//   ask(text, png) -> { text, pt, ct, ... }
export const KINDS = ['button', 'toggle', 'checkbox', 'slider', 'swatch', 'icon', 'card']

export function parseJson(text) {
  const t = String(text ?? ''), fence = t.match(/```(?:json)?\s*([\s\S]*?)```/), src = fence ? fence[1] : t, start = src.indexOf('{')
  if (start < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true; else if (c === '{') depth++
    else if (c === '}' && --depth === 0) { try { return JSON.parse(src.slice(start, i + 1)) } catch { return null } }
  }
  return null
}

export function discoverPrompt({ W, H }) {
  return [
    `You are shown a screenshot of a web app. It is ${W} pixels wide and ${H} pixels tall. The origin (0,0) is its top-left corner.`,
    'List every control a person could operate with a mouse in the app: buttons, switches, checkboxes, sliders, colour swatches, small icons, and objects that can be dragged.',
    'All coordinates are decimals from 0 to 1: x is the fraction of the image width, y is the fraction of the image height. (0,0) is the top-left corner, (1,1) the bottom-right.',
    'Reply with ONE JSON object and nothing else, in this shape:',
    '{"controls":[{"label":"<visible text, or a short description if it has none>","kind":"button|toggle|checkbox|slider|swatch|icon|card","point":[x,y]}]}',
    '"point" is the CENTER of the control itself (for a slider, the round knob; for a switch, the pill; for a checkbox, the square, not its label).',
    'For a slider add "drag_to":[x,y], the point at the far end of its track. For a draggable object add "drag_to":[x,y], the center of a different empty spot where it could be dropped.',
    'List only what you can see. Never guess a position for something you cannot see. Do not describe anything that is not a control.',
  ].join('\n')
}

const unit = p => Array.isArray(p) && p.length >= 2 && p.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)

/** Validate a model answer. Bad entries are dropped and counted, never repaired. */
export function parseControls(text) {
  const parsed = parseJson(text)
  if (!parsed || !Array.isArray(parsed.controls)) return { controls: [], dropped: 0, parseFailed: true }
  const controls = []; let dropped = 0
  for (const c of parsed.controls) {
    if (!c || typeof c.label !== 'string' || !KINDS.includes(c.kind) || !unit(c.point)) { dropped++; continue }
    const needsDrag = c.kind === 'slider' || c.kind === 'card'
    if (needsDrag && !unit(c.drag_to)) { dropped++; continue }
    controls.push({ label: c.label.slice(0, 60), kind: c.kind, point: [c.point[0], c.point[1]], ...(needsDrag ? { dragTo: [c.drag_to[0], c.drag_to[1]] } : {}) })
  }
  return { controls, dropped, parseFailed: false }
}

/** One model call. Returns the proposals, the raw answer and token usage. */
export async function discover(png, size, ask) {
  const r = await ask(discoverPrompt(size), png)
  return { ...parseControls(r.text), raw: r.text, usage: { pt: r.pt, ct: r.ct, rt: r.rt ?? 0, ms: r.ms ?? 0, finish: r.finish ?? null } }
}

/** A proposal in unit coordinates to CSS pixels of the viewport, for the hands. */
export const toCss = (p, vp) => ({ x: p[0] * vp.w, y: p[1] * vp.h })
