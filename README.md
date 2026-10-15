# Boone Trade Calculator

Mobile-first fantasy football trade calculator built on Justin Boone's weekly
rest-of-season **Trade Value Charts** from Yahoo Sports.

Live: https://dirtyk.github.io/Boone_Trade/

## How it works

- `index.html` – the whole app (no build step). Reads `values.json` from the same folder.
- `values.json` – `{ season, week, updated, sources, players: [{ name, key, pos, half, ppr, qb1, qb2 }] }`.
  RB/WR/TE fill `half`/`ppr`; QBs fill `qb1`/`qb2`. `updated` is the newest article's publish time.
- `scripts/update-values.js` – Node 18+ scraper, no dependencies. Finds the newest week's four
  position articles on Yahoo, parses the tables, and rewrites `values.json`. Fails if any
  position has fewer than 20 players.
- `.github/workflows/update-values.yml` – runs the scraper Wed + Thu at 6pm Central and commits
  `values.json` only when it changed. Can also be run manually from the Actions tab.

## Run the scraper locally

```bash
node scripts/update-values.js
```

If auto-discovery ever fails, pass one or more article URLs directly (the other positions are
found from the article's own "Trade Value Charts" link list):

```bash
node scripts/update-values.js "https://sports.yahoo.com/fantasy/article/2026-trade-value-charts--justin-boones-fantasy-football-running-back-breakdown-for-week-6-153236455.html"
```

## Features

- Half PPR / PPR and 1QB / Superflex toggles (auto-set from your Sleeper league's settings)
- "You get" / "You give" sides with type-ahead search; tap to add or remove
- Live totals, point difference and color-coded verdict (fair = within 3 points or 8%)
- Consolidation note for uneven deals (2-for-1, 3-for-1, …)
- Sleeper import: once a league is loaded, "You get" suggests any player in the league (picking one
  sets the trade partner) and "You give" suggests only your roster; full rosters still expand/collapse
- Trade is saved in the URL hash, so you can share a link to a specific trade
- Suggestions: **Even it out** (players that close the value gap), plus **Fair** (95–107%),
  **Aggressive** (110–130%) and **Lowball** (72–90%) offers built from your roster for whatever is
  in "You get". Each extra player in a package adds a 5% consolidation premium, and players at your
  weakest position are avoided when possible.
- Trade finder: rates every team's healthy starters by YTD points per game (Sleeper season stats,
  weighted by your league's lineup slots) against the league median, pre-selects your weakest
  position, and suggests trades with teams that are deep there and thin where you're strong.
  Losing teams rank higher as likely sellers; injured players (IR/Out/Doubtful/PUP/Sus) are only
  pitched to winning teams, who can afford to wait.
