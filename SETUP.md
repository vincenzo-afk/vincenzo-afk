# Profile Dashboard — Setup Notes

This repo now drives a live, self-updating GitHub profile README. Everything
below is genuinely runnable — no external accounts required beyond GitHub
itself (WakaTime is optional, see `waka.yml`).

## What runs automatically

| Workflow | Trigger | What it does |
|---|---|---|
| `.github/workflows/dashboard.yml` | every 6h, on push to `data/**`/scripts, or manual | Regenerates all 6 live SVG cards in `assets/generated/` from real GitHub data and commits them back to `main` |
| `.github/workflows/snake.yml` | on push to `main`, every 12h, or manual | Regenerates the neon contribution snake, pushes to the `output` branch |
| `.github/workflows/activity.yml` | daily, or manual | Updates the recent-activity feed section in README.md |
| `.github/workflows/waka.yml` | manual only until you enable it | Optional WakaTime coding-time stats — see the comment block at the top of the file for the 4 setup steps |

No workflow needs a token you have to create — they all use the
automatically-provided `GITHUB_TOKEN`, which already has the permissions
needed to read public GitHub data and push back to this repo.

## What to edit by hand

| File | Controls |
|---|---|
| `data/live_status.json` | The "🔥 NOW BUILDING" card — current project, module, ETA, progress |
| `data/projects.json` | The Steam-style project cards — add a `"repo": "owner/name"` to pull live stars/last-update, or leave `null` and it'll fall back to the numbers you set |
| `data/feature_stats.json` | The feature-stat cards GitHub's API can't derive (years coding, certificates, etc.) — repositories/stars/followers are always pulled live regardless of this file |
| `data/skills.json` | The non-language axes of the skill radar (AI/ML, DevOps, Systems) — the language axes (Python/Rust/TS-JS) are computed automatically from your repos |

Commit a change to any of those and the dashboard workflow picks it up on
the next push (or within 6 hours via the schedule).

## Re-running things locally (optional)

```bash
npm install -g node   # Node 18+ has global fetch, nothing else needed
GITHUB_TOKEN=ghp_xxx GH_USERNAME=vincenzo-afk node scripts/generate-dashboard.mjs
node scripts/generate-icons.mjs   # only needed if you add/change a tech badge
```

Without a token the script falls back to sample data so you can still
sanity-check layout changes offline.

## One manual step after you upload this repo

GitHub Actions needs **Workflow permissions → Read and write** enabled for
`dashboard.yml`'s `git push` to succeed:
`Settings → Actions → General → Workflow permissions → Read and write permissions`.
Everything else works out of the box.
