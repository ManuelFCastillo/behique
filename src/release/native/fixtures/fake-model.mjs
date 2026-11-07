// A tiny stand-in for a native program, for native-mode tests. It reads a "key = value" config file and behaves like a
// small grid model: it writes an ASCII grid, prints progress with a timing that changes every run, and can fail.
//   node fake-model.mjs run.cfg
// Config keys: speed (number, default 5), fail ("none" | "clear" | "generic"), stamp ("yes" puts the time in the file name).
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const cfgPath = process.argv[2]
const cfg = Object.fromEntries(readFileSync(cfgPath, 'utf8').split('\n').filter(l => l.includes('='))
  .map(l => l.split('=').map(s => s.trim())))
const speed = Number(cfg.speed ?? 5)
const out = dirname(cfgPath)

console.log('Run 0: Reading elevation file...')
if (cfg.fail === 'clear') { console.error('Exception caught: The grid does not contain any values.'); process.exit(255) }
if (cfg.fail === 'generic') { console.error('Exception caught: std::exception'); process.exit(255) }

const rows = 3, cols = 4
const lines = [`ncols ${cols}`, `nrows ${rows}`, 'xllcorner 100', 'yllcorner 200', 'cellsize 10', 'NODATA_value -9999']
for (let r = 0; r < rows; r++) lines.push(Array.from({ length: cols }, (_, c) => (speed + r * 0.5 + c * 0.25).toFixed(2)).join(' '))
const stamp = cfg.stamp === 'yes' ? `_${Date.now()}` : ''
writeFileSync(join(out, `grid${stamp}_vel.asc`), lines.join('\n') + '\n')
console.log(`Run 0: Total simulation time was ${(Math.random() + 0.1).toFixed(6)} seconds.`)
console.log('Run 0: Run number 0 done!')
