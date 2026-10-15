#!/usr/bin/env node
// Scrapes Justin Boone's weekly rest-of-season Trade Value Charts from Yahoo
// Sports (one article per position) and writes values.json at the repo root.
//
// Usage:
//   node scripts/update-values.js              # auto-discover the latest week
//   node scripts/update-values.js <url> ...    # use specific article URL(s)
//
// Discovery: Yahoo's article slugs end in a numeric id that changes every
// week, so we scan a few index pages (Boone's author page, fantasy news) for
// links shaped like
//   /fantasy/article/<year>-trade-value-charts--justin-boones-fantasy-football-
//     <position>-breakdown-for-week-<N>-<id>.html
// keep the highest week, then also read the "Trade Value Charts" link list on
// one of those articles to fill in any position the index pages missed.
//
// Exits non-zero (failing the GitHub Action) if a position can't be found or
// any position parses fewer than MIN_PLAYERS rows - that almost always means
// Yahoo changed its markup.

const fs = require('fs');
const path = require('path');

const MIN_PLAYERS = 20;
const OUT_FILE = path.join(__dirname, '..', 'values.json');
const BASE = 'https://sports.yahoo.com';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const INDEX_PAGES = [
  `${BASE}/author/justin-boone/`,
  `${BASE}/fantasy/news/`,
  `${BASE}/fantasy/rss/`,
];

const SLUG_TO_POS = {
  quarterback: 'QB',
  'running-back': 'RB',
  'wide-receiver': 'WR',
  'tight-end': 'TE',
};
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

const LINK_RE =
  /\/fantasy\/article\/(\d{4})-trade-value-charts--justin-boones-fantasy-football-(quarterback|running-back|wide-receiver|tight-end)-breakdown-for-week-(\d+)-(\d+)\.html/g;

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// -> [{ pos, year, week, url }]
function findChartLinks(html) {
  const found = [];
  for (const m of html.matchAll(LINK_RE)) {
    found.push({
      pos: SLUG_TO_POS[m[2]],
      year: Number(m[1]),
      week: Number(m[3]),
      url: BASE + m[0],
    });
  }
  return found;
}

function linkFromUrl(url) {
  const [link] = findChartLinks(url);
  if (!link) throw new Error(`Not a recognised Trade Value Chart URL: ${url}`);
  return link;
}

// Keep only the newest (year, week) and one URL per position.
function pickLatest(links) {
  if (!links.length) return { year: null, week: null, byPos: {} };
  const rank = (l) => l.year * 100 + l.week;
  const best = Math.max(...links.map(rank));
  const byPos = {};
  for (const l of links) if (rank(l) === best) byPos[l.pos] = l.url;
  const sample = links.find((l) => rank(l) === best);
  return { year: sample.year, week: sample.week, byPos };
}

async function discover() {
  const links = [];
  for (const url of INDEX_PAGES) {
    try {
      links.push(...findChartLinks(await fetchHtml(url)));
    } catch (e) {
      console.warn(`warn: ${e.message}`);
    }
  }
  let latest = pickLatest(links);
  if (!latest.week) throw new Error('Could not find any Trade Value Chart links on Yahoo index pages.');

  // Fill gaps from the article's own "Trade Value Charts" link list.
  const missing = POSITIONS.filter((p) => !latest.byPos[p]);
  if (missing.length) {
    const html = await fetchHtml(Object.values(latest.byPos)[0]);
    latest = pickLatest([...links, ...findChartLinks(html)]);
  }
  return latest;
}

// --- HTML table parsing (no dependencies) ---------------------------------

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function cellText(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Returns rows as arrays of cell strings from the first content table.
function parseTable(html) {
  const tableMatch =
    html.match(/<table[^>]*class="[^"]*content-table[^"]*"[^>]*>([\s\S]*?)<\/table>/i) ||
    html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return [];
  const rows = [];
  for (const tr of tableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => cellText(c[1]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function publishedAt(html) {
  const m = html.match(/<time[^>]*dateTime="([^"]+)"/i);
  return m ? m[1] : null;
}

function normalizeKey(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’`,]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/g, '')
    .trim();
}

function toNum(s) {
  const n = Number(String(s).replace(/[^\d.-]/g, ''));
  return s !== '' && Number.isFinite(n) ? n : null;
}

// RB/WR/TE: Rk | Player | HALF | PPR      QB: Rk | Player | 1QB | 2QB
function parsePosition(pos, html) {
  const rows = parseTable(html);
  const headerIdx = rows.findIndex((r) => r.some((c) => /^player$/i.test(c)));
  if (headerIdx === -1) throw new Error(`${pos}: no header row with a "Player" column`);
  const header = rows[headerIdx].map((c) => c.toLowerCase().replace(/\s+/g, ''));
  const col = (name) => header.indexOf(name);
  const iName = col('player');
  const [iA, iB] = pos === 'QB' ? [col('1qb'), col('2qb')] : [col('half'), col('ppr')];
  if (iA === -1 || iB === -1) {
    throw new Error(`${pos}: unexpected columns [${rows[headerIdx].join(' | ')}]`);
  }

  const players = [];
  for (const r of rows.slice(headerIdx + 1)) {
    const name = r[iName];
    const a = toNum(r[iA] ?? '');
    const b = toNum(r[iB] ?? '');
    if (!name || (a === null && b === null)) continue;
    players.push({
      name,
      key: normalizeKey(name),
      pos,
      half: pos === 'QB' ? null : a,
      ppr: pos === 'QB' ? null : b,
      qb1: pos === 'QB' ? a : null,
      qb2: pos === 'QB' ? b : null,
    });
  }
  return players;
}

async function main() {
  const args = process.argv.slice(2);
  let latest;
  if (args.length) {
    latest = pickLatest(args.map(linkFromUrl));
    if (POSITIONS.some((p) => !latest.byPos[p])) {
      // Let the article's own link list supply the other positions.
      const html = await fetchHtml(Object.values(latest.byPos)[0]);
      latest = pickLatest([...args.map(linkFromUrl), ...findChartLinks(html)]);
    }
  } else {
    latest = await discover();
  }

  const missing = POSITIONS.filter((p) => !latest.byPos[p]);
  if (missing.length) throw new Error(`Week ${latest.week}: no article found for ${missing.join(', ')}`);

  const players = [];
  const dates = [];
  const problems = [];
  for (const pos of POSITIONS) {
    const url = latest.byPos[pos];
    const html = await fetchHtml(url);
    const rows = parsePosition(pos, html);
    console.log(`${pos}: ${rows.length} players  (${url})`);
    if (rows.length < MIN_PLAYERS) problems.push(`${pos} returned only ${rows.length} players`);
    const d = publishedAt(html);
    if (d) dates.push(d);
    players.push(...rows);
  }
  if (problems.length) {
    throw new Error(`${problems.join('; ')} (expected >= ${MIN_PLAYERS}). Yahoo may have changed its markup.`);
  }

  // "updated" is the newest article publish time, not the scrape time, so
  // re-running against the same week produces an identical file and the
  // Action only commits when Boone actually publishes something new.
  const updated = dates.sort().pop() || null;
  const out = {
    season: latest.year,
    week: latest.week,
    updated,
    sources: latest.byPos,
    players,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote ${players.length} players for ${latest.year} week ${latest.week} -> ${path.relative(process.cwd(), OUT_FILE)}`);
}

main().catch((e) => {
  console.error(`::error::${e.message}`);
  process.exit(1);
});
