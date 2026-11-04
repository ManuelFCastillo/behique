import nodeFs from "node:fs";
import path from "node:path";

const BAD_TITLE_CHARS = ["/", "\\", ":", "*", "?", "\"", "<", ">", "|"];

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

function hasPathSeparatorOrDotDot(name) {
  if (typeof name !== "string" || name.length === 0) return true;
  if (name.includes("/") || name.includes("\\")) return true;
  if (name.includes("..")) return true;
  return false;
}

export function validateCatalog(catalog) {
  const problems = [];
  if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.items)) {
    return ["catalog must have an items array"];
  }
  const seenTitleYear = new Map();
  catalog.items.forEach((item, index) => {
    const where = `item ${index}`;
    if (!item || typeof item !== "object") {
      problems.push(`${where}: must be an object`);
      return;
    }
    if (item.kind !== "movie" && item.kind !== "show") {
      problems.push(`${where}: kind must be "movie" or "show"`);
      return;
    }
    // title
    if (!isNonEmptyString(item.title)) {
      problems.push(`${where}: title is required`);
    } else {
      for (const ch of BAD_TITLE_CHARS) {
        if (item.title.includes(ch)) {
          problems.push(`${where}: title contains invalid character "${ch}"`);
          break;
        }
      }
    }
    // year
    if (!Number.isInteger(item.year) || item.year < 1000 || item.year > 9999) {
      problems.push(`${where}: year must be a four-digit integer`);
    }
    // plot
    if (!isNonEmptyString(item.plot)) {
      problems.push(`${where}: plot is required`);
    }
    // genres
    if (!Array.isArray(item.genres) || item.genres.length === 0) {
      problems.push(`${where}: genres must be non-empty`);
    } else {
      item.genres.forEach((g) => {
        if (!isNonEmptyString(g)) {
          problems.push(`${where}: genres must be non-empty strings`);
        }
      });
    }
    // studio
    if (!isNonEmptyString(item.studio)) {
      problems.push(`${where}: studio is required`);
    }
    // credit, license, source
    if (!isNonEmptyString(item.credit)) {
      problems.push(`${where}: credit is required`);
    }
    if (!isNonEmptyString(item.license)) {
      problems.push(`${where}: license is required`);
    }
    if (!isNonEmptyString(item.source)) {
      problems.push(`${where}: source is required`);
    }
    // poster
    if (!isNonEmptyString(item.poster)) {
      problems.push(`${where}: poster is required`);
    } else if (hasPathSeparatorOrDotDot(item.poster)) {
      problems.push(`${where}: poster must not contain path separators or ".."`);
    }
    // fanart optional
    if (item.fanart !== undefined) {
      if (!isNonEmptyString(item.fanart)) {
        problems.push(`${where}: fanart must be a non-empty string`);
      } else if (hasPathSeparatorOrDotDot(item.fanart)) {
        problems.push(`${where}: fanart must not contain path separators or ".."`);
      }
    }
    // duplicate title plus year
    if (isNonEmptyString(item.title) && Number.isInteger(item.year)) {
      const key = `${item.title}\0${item.year}`;
      if (seenTitleYear.has(key)) {
        problems.push(`${where}: duplicate title and year "${item.title} (${item.year})"`);
      } else {
        seenTitleYear.set(key, index);
      }
    }
    if (item.kind === "movie") {
      if (!isPositiveInt(item.runtimeMin)) {
        problems.push(`${where}: runtimeMin is required and must be a positive integer`);
      }
      if (!isNonEmptyString(item.director)) {
        problems.push(`${where}: director is required`);
      }
      if (item.rating !== undefined && typeof item.rating !== "number") {
        problems.push(`${where}: rating must be a number`);
      }
    } else {
      // show
      if (!Array.isArray(item.seasons) || item.seasons.length === 0) {
        problems.push(`${where}: show must have at least one season`);
      } else {
        const seenSeasons = new Set();
        item.seasons.forEach((season, si) => {
          const swhere = `${where} season ${si}`;
          if (!season || typeof season !== "object") {
            problems.push(`${swhere}: must be an object`);
            return;
          }
          if (!isPositiveInt(season.number)) {
            problems.push(`${swhere}: season number must be a positive integer`);
          } else {
            if (seenSeasons.has(season.number)) {
              problems.push(`${swhere}: duplicate season number ${season.number}`);
            } else {
              seenSeasons.add(season.number);
            }
          }
          if (!Array.isArray(season.episodes) || season.episodes.length === 0) {
            problems.push(`${swhere}: season must have at least one episode`);
          } else {
            const seenEpisodes = new Set();
            season.episodes.forEach((ep, ei) => {
              const ewhere = `${swhere} episode ${ei}`;
              if (!ep || typeof ep !== "object") {
                problems.push(`${ewhere}: must be an object`);
                return;
              }
              if (!isPositiveInt(ep.number)) {
                problems.push(`${ewhere}: episode number must be a positive integer`);
              } else {
                if (seenEpisodes.has(ep.number)) {
                  problems.push(`${ewhere}: duplicate episode number ${ep.number}`);
                } else {
                  seenEpisodes.add(ep.number);
                }
              }
              if (!isNonEmptyString(ep.title)) {
                problems.push(`${ewhere}: title is required`);
              }
              if (!isNonEmptyString(ep.plot)) {
                problems.push(`${ewhere}: plot is required`);
              }
            });
          }
        });
      }
    }
  });
  return problems;
}

export function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function movieNfo(item) {
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  lines.push("<movie>");
  lines.push(`  <title>${escapeXml(item.title)}</title>`);
  lines.push(`  <originaltitle>${escapeXml(item.title)}</originaltitle>`);
  lines.push(`  <plot>${escapeXml(item.plot)}</plot>`);
  lines.push(`  <year>${escapeXml(String(item.year))}</year>`);
  lines.push(`  <premiered>${escapeXml(String(item.year))}-01-01</premiered>`);
  lines.push(`  <runtime>${escapeXml(String(item.runtimeMin))}</runtime>`);
  if (item.rating !== undefined && item.rating !== null) {
    lines.push(`  <rating>${escapeXml(String(item.rating))}</rating>`);
  }
  lines.push(`  <director>${escapeXml(item.director)}</director>`);
  lines.push(`  <studio>${escapeXml(item.studio)}</studio>`);
  for (const g of item.genres) {
    lines.push(`  <genre>${escapeXml(g)}</genre>`);
  }
  lines.push("  <lockdata>true</lockdata>");
  lines.push("</movie>");
  return lines.join("\n") + "\n";
}

export function showNfo(item) {
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  lines.push("<tvshow>");
  lines.push(`  <title>${escapeXml(item.title)}</title>`);
  lines.push(`  <plot>${escapeXml(item.plot)}</plot>`);
  lines.push(`  <year>${escapeXml(String(item.year))}</year>`);
  lines.push(`  <premiered>${escapeXml(String(item.year))}-01-01</premiered>`);
  lines.push(`  <studio>${escapeXml(item.studio)}</studio>`);
  for (const g of item.genres) {
    lines.push(`  <genre>${escapeXml(g)}</genre>`);
  }
  lines.push("  <lockdata>true</lockdata>");
  lines.push("</tvshow>");
  return lines.join("\n") + "\n";
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

export function episodeNfo(show, season, episode) {
  const aired = `${show.year}-01-${pad2(episode.number)}`;
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  lines.push("<episodedetails>");
  lines.push(`  <title>${escapeXml(episode.title)}</title>`);
  lines.push(`  <plot>${escapeXml(episode.plot)}</plot>`);
  lines.push(`  <season>${escapeXml(String(season.number))}</season>`);
  lines.push(`  <episode>${escapeXml(String(episode.number))}</episode>`);
  lines.push(`  <showtitle>${escapeXml(show.title)}</showtitle>`);
  lines.push(`  <aired>${escapeXml(aired)}</aired>`);
  lines.push("  <lockdata>true</lockdata>");
  lines.push("</episodedetails>");
  return lines.join("\n") + "\n";
}

export function planTree(catalog, { mediaRoot, assetsDir }) {
  const problems = validateCatalog(catalog);
  if (problems.length > 0) {
    throw new Error(`invalid catalog: ${problems.join("; ")}`);
  }
  const dirsSet = new Set();
  const writes = [];
  const copies = [];
  const clips = [];

  for (const item of catalog.items) {
    const folder = `${item.title} (${item.year})`;
    if (item.kind === "movie") {
      const dir = path.join(mediaRoot, "Movies", folder);
      dirsSet.add(path.join(mediaRoot, "Movies"));
      dirsSet.add(dir);
      writes.push({ path: path.join(dir, "movie.nfo"), content: movieNfo(item) });
      copies.push({ from: path.join(assetsDir, item.poster), to: path.join(dir, "poster.jpg") });
      if (item.fanart) {
        copies.push({ from: path.join(assetsDir, item.fanart), to: path.join(dir, "fanart.jpg") });
      }
      clips.push({ path: path.join(dir, `${folder}.mkv`), seconds: 6 });
    } else {
      const dir = path.join(mediaRoot, "Shows", folder);
      dirsSet.add(path.join(mediaRoot, "Shows"));
      dirsSet.add(dir);
      writes.push({ path: path.join(dir, "tvshow.nfo"), content: showNfo(item) });
      copies.push({ from: path.join(assetsDir, item.poster), to: path.join(dir, "poster.jpg") });
      if (item.fanart) {
        copies.push({ from: path.join(assetsDir, item.fanart), to: path.join(dir, "fanart.jpg") });
      }
      for (const season of item.seasons) {
        const seasonDir = path.join(dir, `Season ${pad2(season.number)}`);
        dirsSet.add(seasonDir);
        const tag = `S${pad2(season.number)}`;
        for (const ep of season.episodes) {
          const base = `${item.title} ${tag}E${pad2(ep.number)}`;
          writes.push({
            path: path.join(seasonDir, `${base}.nfo`),
            content: episodeNfo(item, season, ep),
          });
          clips.push({ path: path.join(seasonDir, `${base}.mkv`), seconds: 6 });
        }
      }
    }
  }

  const dirs = [...dirsSet].sort();
  writes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  copies.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  clips.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { dirs, writes, copies, clips };
}

export function ffmpegArgs(clip, { title }) {
  const seconds = String(clip.seconds);
  return [
    "-nostdin",
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x101820:s=640x360:r=12:d=${seconds}`,
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=44100:cl=stereo",
    "-t",
    seconds,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "stillimage",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "32k",
    "-metadata",
    `title=${title}`,
    "-fflags",
    "+bitexact",
    "-flags:v",
    "+bitexact",
    "-flags:a",
    "+bitexact",
    "-f",
    "matroska",
    clip.path,
  ];
}

export function creditsMarkdown(catalog) {
  const lines = [];
  lines.push("# Media credits");
  lines.push("");
  const items = [...(catalog.items || [])].sort((a, b) =>
    a.title < b.title ? -1 : a.title > b.title ? 1 : 0
  );
  for (const item of items) {
    lines.push(
      `- **${item.title}** (${item.year}) - ${item.credit}. License: ${item.license}. Source: ${item.source}`
    );
  }
  lines.push("");
  lines.push(
    "Video files are placeholder clips made with ffmpeg, not the films."
  );
  return lines.join("\n") + "\n";
}

export function applyPlan(plan, { fs = nodeFs } = {}) {
  let dirCount = 0;
  let writeCount = 0;
  let copyCount = 0;
  for (const dir of plan.dirs) {
    fs.mkdirSync(dir, { recursive: true });
    dirCount += 1;
  }
  for (const w of plan.writes) {
    fs.mkdirSync(path.dirname(w.path), { recursive: true });
    fs.writeFileSync(w.path, w.content, "utf8");
    writeCount += 1;
  }
  for (const c of plan.copies) {
    fs.mkdirSync(path.dirname(c.to), { recursive: true });
    fs.copyFileSync(c.from, c.to);
    copyCount += 1;
  }
  return { dirs: dirCount, writes: writeCount, copies: copyCount };
}
