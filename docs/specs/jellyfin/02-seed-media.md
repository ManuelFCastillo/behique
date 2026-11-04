---
part: jellyfin-seed-media
owns:
  - tools/jellyfin-seed/media.mjs
  - tools/jellyfin-seed/media.test.mjs
test: node --test tools/jellyfin-seed/media.test.mjs
---
# Part 02: turn a catalog of open films into a Jellyfin media folder

Behique's demo needs a media server that looks full and real, with no network and no copyrighted media. A catalog lists open-licensed films and shows. This part plans the files. Video files are tiny placeholder clips, because playback is never tested; posters and backdrops are real open-licensed images. All metadata comes from local NFO files, so the server needs no internet.

## Interface

`tools/jellyfin-seed/media.mjs`, ESM, `node:fs` and `node:path` only. Everything except `applyPlan` is pure.

A catalog is `{ items: [...] }`. A movie item: `{ kind: 'movie', title, year, plot, genres: [string], runtimeMin, rating, director, studio, poster, fanart, credit, license, source }`. A show item has `kind: 'show'`, no `runtimeMin` or `director`, and `seasons: [{ number, episodes: [{ number, title, plot }] }]`. `poster` and `fanart` are file names relative to an assets folder; `fanart` is optional. `credit`, `license` and `source` are required strings on every item.

Exports:

- `validateCatalog(catalog)` returns a list of problems in plain words, empty when fine. Check required fields, year is a four-digit integer, genres non-empty, a title has none of `/ \ : * ? " < > |`, duplicate title plus year, a show has at least one season with at least one episode, season and episode numbers are positive integers without repeats, and asset names have no path separators or `..`.
- `escapeXml(text)` escapes `& < > " '`.
- `movieNfo(item)` returns XML: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`, then `<movie>` with `title`, `originaltitle`, `plot`, `year`, `premiered` as `<year>-01-01`, `runtime`, `rating` when present, `director`, `studio`, and one `genre` per genre. Add `<lockdata>true</lockdata>`.
- `showNfo(item)` returns `<tvshow>` with `title`, `plot`, `year`, `premiered`, `studio`, `genre` and `lockdata`.
- `episodeNfo(show, season, episode)` returns `<episodedetails>` with `title`, `plot`, `season`, `episode`, `showtitle`, `aired` as `<year>-01-<two-digit episode>`, `lockdata`.
- `planTree(catalog, { mediaRoot, assetsDir })` throws if the catalog is invalid, otherwise returns `{ dirs, writes, copies, clips }`, each sorted by path for a stable order:
  - A movie goes in `<mediaRoot>/Movies/<Title> (<Year>)/`: writes `movie.nfo`, copies `poster.jpg` and `fanart.jpg` from the assets folder, and a clip `<Title> (<Year>).mkv`.
  - A show goes in `<mediaRoot>/Shows/<Title> (<Year>)/`: writes `tvshow.nfo`, copies `poster.jpg` and `fanart.jpg`, and for each season a folder `Season 01`, with a clip `<Title> S01E02.mkv` and a sibling `<Title> S01E02.nfo`.
  - `writes` is `{ path, content }`, `copies` is `{ from, to }`, `clips` is `{ path, seconds }`. `seconds` is 6 for every clip.
- `ffmpegArgs(clip, { title })` returns the argument array (no `ffmpeg` itself) for a small deterministic clip: `-nostdin -y -v error -f lavfi -i color=c=0x101820:s=640x360:r=12:d=<seconds> -f lavfi -i anullsrc=r=44100:cl=stereo -t <seconds> -c:v libx264 -preset veryfast -tune stillimage -pix_fmt yuv420p -c:a aac -b:a 32k -metadata title=<title> -fflags +bitexact -flags:v +bitexact -flags:a +bitexact -f matroska <path>`.
- `creditsMarkdown(catalog)` returns a markdown document headed `# Media credits`, one line per item with its title, year, credit, license and source URL, sorted by title, ending with a sentence saying the video files are placeholder clips made with ffmpeg, not the films.
- `applyPlan(plan, { fs = node:fs })` creates directories recursively, writes the files and copies the assets. It does not run ffmpeg. It returns counts `{ dirs, writes, copies }`.

## Tests

`node:test`, a temp folder and a small catalog of two movies and one show with two seasons. Cover every rule of `validateCatalog`; XML escaping, including a title containing `&`; exact folder and file names; that NFOs parse back with a simple regex for title, year, every genre, season and episode; `lockdata`; sorted stable output, by calling `planTree` twice and comparing with `deepEqual`; `ffmpegArgs` contains the bitexact flags, `matroska` and the path as the last argument, and is an array of strings with the title as one element even if it has spaces; `creditsMarkdown` has every source URL and the placeholder sentence; `applyPlan` writes real files and copies real assets from a temp assets folder; an invalid catalog throws with its problems in the message.
