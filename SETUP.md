# BK // DEVELOPER OS — Setup Notes

This repo is a living, self-updating GitHub profile. No numbers are
hand-maintained: everything dynamic is regenerated from the real GitHub API.

## What runs automatically

| Workflow | Trigger | What it does |
|---|---|---|
| `.github/workflows/update-profile.yml` | every 6h, on push to `data/**` / `scripts/generate-os.mjs` / `README.md`, or manual | Runs the generator and commits back `README.md` + `assets/*.svg` + `data/telemetry.json` + `data/transmissions.json` |
| `.github/workflows/update-contributions.yml` | daily, or manual | Same generator on its own cadence for the season / XP / achievements art |
| `.github/workflows/health-check.yml` | daily, or manual | Read-only: asserts all 7 SVGs + all 16 README markers exist with no `undefined`/`NaN` leaks. Never commits |
| `.github/workflows/snake.yml` | on push to `main`, every 12h, or manual | Contribution snake on the `output` branch |
| `.github/workflows/waka.yml` | manual until enabled | Optional WakaTime stats — see the file header for setup |

All workflows use the automatic `GITHUB_TOKEN` — no secrets to create.
Commits are authored as `vincenzo-afk` so automation shows up on the graph.

## The data model

| File | Controls | By hand? |
|---|---|---|
| `data/profile.json` | Identity, currently, quests, research, experiment, player card, loadout, lore templates (`{{repos}}`, `{{stars}}`, `{{fresh3}}`, `{{created}}`) | ✅ edit freely |
| `data/projects.json` | Mission manifest: which repos are missions, plus `status` / `progress` / `objective` | ✅ edit freely |
| `data/achievements.json` | Unlock rules evaluated against live data | ✅ edit freely |
| `data/telemetry.json`, `data/transmissions.json` | Last fetched API snapshot | ❌ generated — never edit |
| `assets/*.svg` | All profile visuals | ❌ generated — never edit |
| `README.md` (inside `<!-- OS:… -->` markers) | Every number, date, table | ❌ generated — edit prose/structure only |

## Re-running locally

```bash
node scripts/generate-os.mjs
# GITHUB_TOKEN=ghp_xxx GH_USERNAME=vincenzo-afk node scripts/generate-os.mjs
```

Node 18+ only, zero dependencies. Without API access it reuses the last
snapshot; with no snapshot it renders an honest "temporarily unavailable"
state instead of fake numbers.

## One manual step after pushing

`Settings → Actions → General → Workflow permissions → Read and write
permissions`, otherwise the workflows can't push their updates back.
