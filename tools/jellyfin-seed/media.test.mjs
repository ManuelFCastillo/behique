import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateCatalog,
  escapeXml,
  movieNfo,
  showNfo,
  episodeNfo,
  planTree,
  ffmpegArgs,
  creditsMarkdown,
  applyPlan,
} from "./media.mjs";

function baseMovie(over = {}) {
  return {
    kind: "movie",
    title: "Big Buck Bunny",
    year: 2008,
    plot: "A rabbit plot.",
    genres: ["Animation", "Comedy"],
    runtimeMin: 10,
    rating: 7.2,
    director: "Sacha Goedegebure",
    studio: "Blender Institute",
    poster: "bbb-poster.jpg",
    fanart: "bbb-fanart.jpg",
    credit: "Blender Foundation",
    license: "CC BY 3.0",
    source: "https://example.test/bbb",
    ...over,
  };
}

function baseShow(over = {}) {
  return {
    kind: "show",
    title: "Tears of Steel",
    year: 2012,
    plot: "Show plot.",
    genres: ["Sci-Fi"],
    studio: "Blender Institute",
    poster: "tos-poster.jpg",
    fanart: "tos-fanart.jpg",
    credit: "Blender Foundation",
    license: "CC BY 3.0",
    source: "https://example.test/tos",
    seasons: [
      {
        number: 1,
        episodes: [
          { number: 1, title: "Pilot", plot: "Pilot plot." },
          { number: 2, title: "Second", plot: "Second plot." },
        ],
      },
      {
        number: 2,
        episodes: [{ number: 1, title: "Return", plot: "Return plot." }],
      },
    ],
    ...over,
  };
}

function sampleCatalog() {
  return {
    items: [
      baseMovie(),
      baseMovie({
        title: "Sintel & Roses",
        year: 2010,
        plot: "A <bold> tale & more.",
        genres: ["Fantasy"],
        poster: "sintel-poster.jpg",
        fanart: "sintel-fanart.jpg",
        source: "https://example.test/sintel",
      }),
      baseShow(),
    ],
  };
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : null;
}

function allTags(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]);
}

test("validateCatalog accepts good catalog", () => {
  assert.deepEqual(validateCatalog(sampleCatalog()), []);
});

test("validateCatalog: required fields", () => {
  const c = { items: [baseMovie({ title: "", plot: "", studio: "" })] };
  const p = validateCatalog(c);
  assert.ok(p.some((x) => x.includes("title is required")));
  assert.ok(p.some((x) => x.includes("plot is required")));
  assert.ok(p.some((x) => x.includes("studio is required")));
  const c2 = { items: [baseMovie({ credit: "", license: "", source: "" })] };
  const p2 = validateCatalog(c2);
  assert.ok(p2.some((x) => x.includes("credit")));
  assert.ok(p2.some((x) => x.includes("license")));
  assert.ok(p2.some((x) => x.includes("source")));
  const c3 = { items: [baseMovie({ director: "" })] };
  assert.ok(validateCatalog(c3).some((x) => x.includes("director")));
  const c4 = { items: [baseMovie({ runtimeMin: 0 })] };
  assert.ok(validateCatalog(c4).some((x) => x.includes("runtimeMin")));
  const c5 = { items: [baseMovie({ poster: "" })] };
  assert.ok(validateCatalog(c5).some((x) => x.includes("poster")));
});

test("validateCatalog: year four-digit integer", () => {
  for (const year of [99, 999, 10000, 201.5, "2010", NaN]) {
    const p = validateCatalog({ items: [baseMovie({ year })] });
    assert.ok(p.some((x) => x.includes("year")), `year ${year} should fail`);
  }
});

test("validateCatalog: genres non-empty", () => {
  assert.ok(validateCatalog({ items: [baseMovie({ genres: [] })] }).some((x) => x.includes("genres")));
  assert.ok(validateCatalog({ items: [baseMovie({ genres: "x" })] }).some((x) => x.includes("genres")));
});

test("validateCatalog: bad title characters", () => {
  for (const ch of ["/", "\\", ":", "*", "?", '"', "<", ">", "|"]) {
    const p = validateCatalog({ items: [baseMovie({ title: `A${ch}B` })] });
    assert.ok(p.some((x) => x.includes("title")), `char ${ch} should fail`);
  }
});

test("validateCatalog: duplicate title plus year", () => {
  const m = baseMovie();
  const p = validateCatalog({ items: [m, { ...m }] });
  assert.ok(p.some((x) => x.includes("duplicate")));
  // same title different year is fine
  assert.deepEqual(validateCatalog({ items: [m, { ...m, year: 2009 }] }), []);
});

test("validateCatalog: show seasons and episodes", () => {
  assert.ok(
    validateCatalog({ items: [baseShow({ seasons: [] })] }).some((x) => x.includes("at least one season"))
  );
  assert.ok(
    validateCatalog({ items: [baseShow({ seasons: [{ number: 1, episodes: [] }] })] }).some((x) =>
      x.includes("at least one episode")
    )
  );
  // season number positive int without repeats
  assert.ok(
    validateCatalog({ items: [baseShow({ seasons: [{ number: 0, episodes: [{ number: 1, title: "A", plot: "B" }] }] })] }).some((x) =>
      x.includes("season number")
    )
  );
  const dupSeason = baseShow({
    seasons: [
      { number: 1, episodes: [{ number: 1, title: "A", plot: "B" }] },
      { number: 1, episodes: [{ number: 1, title: "A", plot: "B" }] },
    ],
  });
  assert.ok(validateCatalog({ items: [dupSeason] }).some((x) => x.includes("duplicate season")));
  // episode numbers
  const badEp = baseShow({
    seasons: [{ number: 1, episodes: [{ number: -2, title: "A", plot: "B" }] }],
  });
  assert.ok(validateCatalog({ items: [badEp] }).some((x) => x.includes("episode number")));
  const dupEp = baseShow({
    seasons: [
      {
        number: 1,
        episodes: [
          { number: 1, title: "A", plot: "B" },
          { number: 1, title: "C", plot: "D" },
        ],
      },
    ],
  });
  assert.ok(validateCatalog({ items: [dupEp] }).some((x) => x.includes("duplicate episode")));
});

test("validateCatalog: asset names", () => {
  assert.ok(
    validateCatalog({ items: [baseMovie({ poster: "a/b.jpg" })] }).some((x) => x.includes("poster"))
  );
  assert.ok(
    validateCatalog({ items: [baseMovie({ poster: "..\\evil.jpg" })] }).some((x) => x.includes("poster"))
  );
  assert.ok(
    validateCatalog({ items: [baseMovie({ fanart: "../evil.jpg" })] }).some((x) => x.includes("fanart"))
  );
});

test("escapeXml escapes all", () => {
  assert.equal(escapeXml(`&<>"'`), "&amp;&lt;&gt;&quot;&apos;");
  assert.equal(escapeXml("Sintel & Roses"), "Sintel &amp; Roses");
});

test("movieNfo structure and escaping", () => {
  const item = baseMovie({ title: "Sintel & Roses", plot: "a <b> & c" });
  const xml = movieNfo(item);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'));
  assert.ok(xml.includes("<movie>"));
  assert.equal(tag(xml, "title"), "Sintel &amp; Roses");
  assert.equal(tag(xml, "originaltitle"), "Sintel &amp; Roses");
  assert.equal(tag(xml, "year"), "2008");
  assert.equal(tag(xml, "premiered"), "2008-01-01");
  assert.equal(tag(xml, "runtime"), "10");
  assert.equal(tag(xml, "rating"), "7.2");
  assert.equal(tag(xml, "director"), escapeXml(item.director));
  assert.equal(tag(xml, "studio"), escapeXml(item.studio));
  const genres = allTags(xml, "genre");
  assert.deepEqual(genres, item.genres.map(escapeXml));
  assert.equal(tag(xml, "lockdata"), "true");
  // rating omitted when absent
  const xml2 = movieNfo(baseMovie({ rating: undefined }));
  assert.equal(tag(xml2, "rating"), null);
});

test("showNfo and episodeNfo parse back", () => {
  const show = baseShow();
  const xml = showNfo(show);
  assert.ok(xml.includes("<tvshow>"));
  assert.equal(tag(xml, "title"), escapeXml(show.title));
  assert.equal(tag(xml, "year"), String(show.year));
  assert.equal(tag(xml, "premiered"), `${show.year}-01-01`);
  assert.deepEqual(allTags(xml, "genre"), show.genres);
  assert.equal(tag(xml, "lockdata"), "true");
  const ep = show.seasons[0].episodes[1];
  const exml = episodeNfo(show, show.seasons[0], ep);
  assert.ok(exml.includes("<episodedetails>"));
  assert.equal(tag(exml, "title"), escapeXml(ep.title));
  assert.equal(tag(exml, "season"), "1");
  assert.equal(tag(exml, "episode"), "2");
  assert.equal(tag(exml, "showtitle"), escapeXml(show.title));
  assert.equal(tag(exml, "aired"), `${show.year}-01-02`);
  assert.equal(tag(exml, "lockdata"), "true");
});

test("planTree exact names and sorted stable output", () => {
  const catalog = sampleCatalog();
  const mediaRoot = path.join("m");
  const assetsDir = path.join("a");
  const p1 = planTree(catalog, { mediaRoot, assetsDir });
  const p2 = planTree(catalog, { mediaRoot, assetsDir });
  assert.deepEqual(p1, p2);
  const byPath = (arr) => arr.map((x) => x.path || x.to || x);
  const sorted = [...byPath(p1.writes)].sort();
  assert.deepEqual(byPath(p1.writes), sorted);
  assert.deepEqual(byPath(p1.copies), [...byPath(p1.copies)].sort());
  assert.deepEqual(byPath(p1.clips), [...byPath(p1.clips)].sort());
  // movie paths
  const movieDir = path.join(mediaRoot, "Movies", "Big Buck Bunny (2008)");
  assert.ok(p1.writes.some((w) => w.path === path.join(movieDir, "movie.nfo")));
  assert.ok(p1.copies.some((c) => c.to === path.join(movieDir, "poster.jpg")));
  assert.ok(p1.copies.some((c) => c.to === path.join(movieDir, "fanart.jpg")));
  assert.ok(p1.clips.some((c) => c.path === path.join(movieDir, "Big Buck Bunny (2008).mkv")));
  // show paths
  const showDir = path.join(mediaRoot, "Shows", "Tears of Steel (2012)");
  assert.ok(p1.writes.some((w) => w.path === path.join(showDir, "tvshow.nfo")));
  const s1e2nfo = path.join(showDir, "Season 01", "Tears of Steel S01E02.nfo");
  const s1e2mkv = path.join(showDir, "Season 01", "Tears of Steel S01E02.mkv");
  assert.ok(p1.writes.some((w) => w.path === s1e2nfo));
  assert.ok(p1.clips.some((c) => c.path === s1e2mkv));
  assert.ok(p1.clips.every((c) => c.seconds === 6));
  // copies from assets dir
  const posterCopy = p1.copies.find((c) => c.to === path.join(movieDir, "poster.jpg"));
  assert.equal(posterCopy.from, path.join(assetsDir, "bbb-poster.jpg"));
  // every NFO parses back
  for (const w of p1.writes) {
    assert.ok(tag(w.content, "title") !== null, w.path);
    assert.ok(tag(w.content, "lockdata") === "true", w.path);
  }
});

test("ffmpegArgs shape", () => {
  const clip = { path: path.join("m", "My Film (2020).mkv"), seconds: 6 };
  const args = ffmpegArgs(clip, { title: "My Film" });
  assert.ok(Array.isArray(args));
  assert.ok(args.every((a) => typeof a === "string"));
  assert.ok(args.includes("+bitexact"));
  assert.ok(args.includes("matroska"));
  assert.equal(args[args.length - 1], clip.path);
  assert.ok(args.includes("title=My Film"));
  // string with spaces is one element
  const withSpaces = ffmpegArgs(clip, { title: "Tears of Steel" });
  assert.ok(withSpaces.includes("title=Tears of Steel"));
  const joined = withSpaces.join("\n");
  assert.ok(joined.includes("title=Tears of Steel"));
  // bitexact flags
  assert.ok(args.includes("-flags:v"));
  assert.ok(args.includes("-flags:a"));
  assert.ok(args.includes("-fflags"));
});

test("creditsMarkdown has urls and placeholder sentence", () => {
  const md = creditsMarkdown(sampleCatalog());
  assert.ok(md.startsWith("# Media credits"));
  for (const item of sampleCatalog().items) {
    assert.ok(md.includes(item.source));
    assert.ok(md.includes(item.title));
    assert.ok(md.includes(item.license));
    assert.ok(md.includes(item.credit));
  }
  assert.ok(md.toLowerCase().includes("placeholder"));
  assert.ok(md.includes("ffmpeg"));
  // sorted by title
  const idxBBB = md.indexOf("Big Buck Bunny");
  const idxSintel = md.indexOf("Sintel");
  const idxTears = md.indexOf("Tears of Steel");
  assert.ok(idxBBB < idxSintel && idxSintel < idxTears);
});

test("applyPlan writes real files and copies assets", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jellyfin-"));
  const assetsDir = path.join(tmp, "assets");
  const mediaRoot = path.join(tmp, "media");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "bbb-poster.jpg"), "poster-bytes");
  fs.writeFileSync(path.join(assetsDir, "bbb-fanart.jpg"), "fanart-bytes");
  fs.writeFileSync(path.join(assetsDir, "sintel-poster.jpg"), "p2");
  fs.writeFileSync(path.join(assetsDir, "sintel-fanart.jpg"), "f2");
  fs.writeFileSync(path.join(assetsDir, "tos-poster.jpg"), "p3");
  fs.writeFileSync(path.join(assetsDir, "tos-fanart.jpg"), "f3");
  const plan = planTree(sampleCatalog(), { mediaRoot, assetsDir });
  const counts = applyPlan(plan, {});
  assert.equal(counts.writes, plan.writes.length);
  assert.equal(counts.copies, plan.copies.length);
  assert.equal(counts.dirs, plan.dirs.length);
  for (const w of plan.writes) {
    assert.equal(fs.readFileSync(w.path, "utf8"), w.content);
  }
  for (const c of plan.copies) {
    assert.ok(fs.existsSync(c.to));
    assert.equal(fs.readFileSync(c.to, "utf8"), fs.readFileSync(c.from, "utf8"));
  }
});

test("planTree throws with problems in message", () => {
  const bad = { items: [baseMovie({ title: "Bad/Name", year: 99, genres: [] })] };
  assert.throws(() => planTree(bad, { mediaRoot: "m", assetsDir: "a" }), /title|year|genres/);
});
