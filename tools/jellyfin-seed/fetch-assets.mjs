// Fetches the posters and backdrops named in catalog.json from Wikimedia Commons, refuses anything that is not CC BY or CC0, and writes
// the licence Commons reports for each file into out/jellyfin-seed/catalog.resolved.json. Nothing here touches the media server.
//   node tools/jellyfin-seed/fetch-assets.mjs
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', '..', 'out', 'jellyfin-seed'), ASSETS = join(OUT, 'assets')
const UA = 'behique-seed/1.0 (open film catalog for a release verification demo)'
const API = 'https://commons.wikimedia.org/w/api.php?'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const OK_LICENSE = /^(CC BY( \d(\.\d)?)?|CC0)$/
const slug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-')

async function get(url) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA } })
    if (r.ok) return r
    if (r.status !== 429 && r.status < 500) throw new Error(`${r.status} for ${url}`)
    await sleep(15000 * (i + 1))
  }
  throw new Error(`gave up on ${url}`)
}
const api = async params => (await get(API + new URLSearchParams({ format: 'json', ...params }))).json()

async function info(title) {
  const d = await api({ action: 'query', titles: title, prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '960', iiextmetadatafilter: 'LicenseShortName|Artist' })
  const p = Object.values(d.query.pages)[0]
  const i = p?.imageinfo?.[0]
  if (!i) throw new Error(`Commons has no file ${title}`)
  const license = i.extmetadata?.LicenseShortName?.value ?? ''
  if (!OK_LICENSE.test(license)) throw new Error(`${title} is ${license}, not CC BY or CC0`)
  return { title, license, page: i.descriptionurl, url: i.thumburl ?? i.url }
}

async function save(meta, name) {
  const f = join(ASSETS, name)
  if (!existsSync(f)) { writeFileSync(f, Buffer.from(await (await get(meta.url)).arrayBuffer())); await sleep(4000) }
  return name
}

mkdirSync(ASSETS, { recursive: true })
const catalog = JSON.parse(readFileSync(join(HERE, 'catalog.json'), 'utf8'))
for (const item of catalog.items) {
  let names = item.commons
  if (!names) {
    const s = await api({ action: 'query', list: 'search', srsearch: `${item.commonsSearch} filetype:bitmap`, srnamespace: '6', srlimit: '2' })
    names = { poster: s.query.search[0].title, fanart: s.query.search[1]?.title }
    await sleep(4000)
  }
  const poster = await info(names.poster); await sleep(4000)
  item.poster = await save(poster, `${slug(item.title)}-poster.jpg`)
  const used = [poster]
  if (names.fanart) { const fan = await info(names.fanart); await sleep(4000); item.fanart = await save(fan, `${slug(item.title)}-fanart.jpg`); used.push(fan) }
  item.license = [...new Set(used.map(u => u.license))].join(', ')
  item.source = used.map(u => u.page).join(' ')
  item.credit = `(c) ${item.studio}, ${item.license}`
  delete item.commons; delete item.commonsSearch
  console.log(item.title, '|', item.license, '|', used.map(u => u.title).join(', '))
}
writeFileSync(join(OUT, 'catalog.resolved.json'), JSON.stringify(catalog, null, 2) + '\n')
console.log('wrote', join(OUT, 'catalog.resolved.json'))
