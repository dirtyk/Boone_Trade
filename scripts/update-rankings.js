#!/usr/bin/env node
// Pulls Justin Boone's current-week Start/Sit rankings (FLEX, QB, K, D/ST)
// and writes rankings.json at the repo root, with every player already
// matched to his Sleeper player id so the page can join them onto rosters
// without any name matching.
//
// Usage:
//   node scripts/update-rankings.js
//
// Source: Boone's weekly rankings articles ("FLEX Rankings for Week N") have
// no rankings in their HTML - the table is filled in client-side from
// Yahoo's /api/fanPro JSON feed (expert 1663). That feed sends no CORS
// headers, so the page can't call it from github.io; this script calls it
// instead. The week comes from Sleeper's /state/nfl, so there's no article
// to find each week.
//
// `updated` is Boone's own last-published time, not the scrape time, so the
// file only changes (and the Action only commits) when he updates.
// If he hasn't published the current week yet, the existing file is left
// alone and the script exits 0.

const fs = require('fs');
const path = require('path');

const OUT_FILE = path.join(__dirname, '..', 'rankings.json');
const SL = 'https://api.sleeper.app/v1';
const FEED = 'https://sports.yahoo.com/api/fanPro/';
const BOONE = '317';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// rankings.json list name -> [feed position, scoring]. QB/K/DST don't change
// with reception scoring; FLEX has separate Half and Full PPR lists.
const LISTS = {
  FLEX_HALF: ['FLX', 'HALF'],
  FLEX_PPR: ['FLX', 'PPR'],
  QB: ['QB', 'HALF'],
  K: ['K', 'HALF'],
  DEF: ['DST', 'HALF'],
};

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function fetchList(feedPos, scoring, week, season) {
  const params = new URLSearchParams({
    sport: 'NFL', position: feedPos, filters: BOONE, experts: 'show', expert: '1663',
    scoring, type: 'ST', week: String(week), wtype: 'ST', year: String(season),
  });
  return getJson(`${FEED}?${params}`);
}

// --- Matching Boone's names to Sleeper ids --------------------------------

function normalizeName(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv|v)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildIndex(players) {
  const byNamePos = new Map();
  const byLastTeamPos = new Map();
  const defByTeam = new Map();
  const add = (map, key, id) => map.set(key, [...(map.get(key) || []), id]);
  for (const [id, p] of Object.entries(players)) {
    if (!p || !p.position) continue;
    if (p.position === 'DEF') { defByTeam.set(id, id); continue; }
    const full = p.full_name || `${p.first_name || ''} ${p.last_name || ''}`;
    add(byNamePos, `${normalizeName(full)}|${p.position}`, id);
    if (p.team && p.last_name) add(byLastTeamPos, `${normalizeName(p.last_name)}|${p.team}|${p.position}`, id);
  }
  return { byNamePos, byLastTeamPos, defByTeam, players };
}

// Name + position, then team to break ties; falls back to last name + team +
// position for nicknames (Boone's "Bam Knight" is Sleeper's "Zonovan Knight").
function matchId(row, idx) {
  if (row.pos === 'DEF') return idx.defByTeam.get(row.team) || null;
  const n = normalizeName(row.name);
  const cands = idx.byNamePos.get(`${n}|${row.pos}`) || [];
  if (cands.length === 1) return cands[0];
  if (cands.length > 1) return cands.find((id) => idx.players[id].team === row.team) || cands[0];
  const byLast = idx.byLastTeamPos.get(`${n.split(' ').pop()}|${row.team}|${row.pos}`) || [];
  return byLast.length === 1 ? byLast[0] : null;
}

async function main() {
  const state = await getJson(`${SL}/state/nfl`);
  const week = state.week;
  const season = Number(state.season);
  if (!week || state.season_type === 'off') {
    console.log(`No NFL week in progress (season_type=${state.season_type}) - leaving rankings.json alone.`);
    return;
  }

  const names = Object.keys(LISTS);
  const results = await Promise.all(names.map((n) => fetchList(LISTS[n][0], LISTS[n][1], week, season)));
  if (!(results[0].players || []).length) {
    console.log(`Boone hasn't published Week ${week} rankings yet - leaving rankings.json alone.`);
    return;
  }

  const idx = buildIndex(await getJson(`${SL}/players/nfl`));
  const lists = {};
  const unmatched = [];
  let updated = null;
  results.forEach((data, i) => {
    const pub = data.expertPubDates && data.expertPubDates[BOONE];
    if (pub && (!updated || pub > updated)) updated = pub;
    lists[names[i]] = (data.players || []).map((p) => {
      const row = { name: p.name, pos: p.position === 'DST' ? 'DEF' : p.position, team: p.team || '', rank: p.rank, opp: p.opponent || '' };
      const id = matchId(row, idx);
      if (!id) unmatched.push(`${row.name} (${row.pos} ${row.team})`);
      return { id, ...row };
    });
    console.log(`${names[i]}: ${lists[names[i]].length} players`);
  });
  if (unmatched.length) console.warn(`warn: no Sleeper match for ${unmatched.join(', ')}`);

  const out = { season, week, updated, lists };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out) + '\n');
  console.log(`Wrote Week ${week} rankings (Boone updated ${updated}) -> ${path.relative(process.cwd(), OUT_FILE)}`);
}

main().catch((e) => {
  console.error(`::error::${e.message}`);
  process.exit(1);
});
