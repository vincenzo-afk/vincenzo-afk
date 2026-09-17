#!/usr/bin/env node
/**
 * BK // DEVELOPER OS — generator
 * ================================
 * Pipeline:  GitHub REST API → metrics → SVG assets + README regions → commit.
 *
 *   node scripts/generate-os.mjs
 *   GH_USERNAME=vincenzo-afk GITHUB_TOKEN=xxx node scripts/generate-os.mjs
 *
 * Single source of truth:
 *   LIVE   numbers/dates/tables  → GitHub API (never hand-edited anywhere)
 *   MANUAL curation              → data/profile.json (identity, currently,
 *                                  quests, research, experiment, player,
 *                                  loadout, lore templates)
 *                                → data/projects.json (mission manifest:
 *                                  which repos are missions + status)
 *                                → data/achievements.json (unlock rules)
 *
 * Outputs (all committed by CI):
 *   assets/*.svg, data/telemetry.json, data/transmissions.json, README.md
 *
 * Failure contract: never emit undefined/null/NaN/API ERROR. If the API is
 * unreachable the previous telemetry.json is reused; if none exists the
 * profile renders "DATA TEMPORARILY UNAVAILABLE" instead of fake numbers.
 */
import fs from "node:fs";
import path from "node:path";

const USERNAME = process.env.GH_USERNAME || "vincenzo-afk";
const TOKEN = process.env.GITHUB_TOKEN || "";
const OUT_DIR = "assets";
const DATA_DIR = "data";
const README_PATH = "README.md";

const esc = (s) =>
  String(s ?? "—").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const mdEsc = (s) => String(s ?? "—").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const num = (v) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString("en-US") : "—");
const readJSON = (p, fb) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
};
const write = (p, c) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c, "utf8");
  console.log("wrote", p);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- HTTP with retry + rate-limit respect ----------------
async function rest(pathname, attempt = 1) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      ...(TOKEN ? { Authorization: `bearer ${TOKEN}` } : {}),
      Accept: "application/vnd.github+json",
      "User-Agent": "bk-developer-os",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (res.status === 403 || res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") || 0);
    const reset = Number(res.headers.get("x-ratelimit-reset") || 0);
    const waitMs = retryAfter
      ? retryAfter * 1000
      : reset
        ? Math.max(0, reset * 1000 - Date.now()) + 2000
        : Math.min(60000, 2000 * 2 ** attempt);
    if (attempt <= 4) {
      console.warn(`rate limited on ${pathname}, waiting ${Math.round(waitMs / 1000)}s…`);
      await sleep(waitMs);
      return rest(pathname, attempt + 1);
    }
  }
  if (res.status >= 500 && attempt <= 3) {
    await sleep(2000 * attempt);
    return rest(pathname, attempt + 1);
  }
  if (!res.ok) throw new Error(`GET ${pathname} → ${res.status}`);
  return res.json();
}

async function fetchAllRepos() {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = await rest(`/users/${USERNAME}/repos?per_page=100&page=${page}&sort=pushed`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

// ---------------- date helpers (locale-independent) ----------------
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthYear = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d) ? "—" : `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const monthDay = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d) ? "—" : `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, "0")}`;
};
const isoDay = (iso) => String(iso || "").slice(0, 10);
function relDate(iso, now) {
  if (!iso) return "unknown";
  const ms = now.getTime() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

// ---------------- fetch ----------------
const now = new Date();
let user = null, repos = null, events = [];
try {
  user = await rest(`/users/${USERNAME}`);
  repos = await fetchAllRepos();
  try {
    events = await rest(`/users/${USERNAME}/events/public?per_page=10`);
  } catch (e) {
    console.warn("events unavailable:", String(e).slice(0, 80));
    events = [];
  }
} catch (e) {
  console.warn("API unavailable, using fallback:", String(e).slice(0, 120));
}

const prev = readJSON(path.join(DATA_DIR, "telemetry.json"), null);
let m;
if (user && Array.isArray(repos)) {
  const stars = repos.reduce((s, r) => s + (r.stargazers_count || 0), 0);
  const forks = repos.reduce((s, r) => s + (r.forks_count || 0), 0);
  const langs = {};
  for (const r of repos) if (r.language) langs[r.language] = (langs[r.language] || 0) + 1;
  const byStars = [...repos].sort((a, b) => b.stargazers_count - a.stargazers_count);
  const byPush = [...repos].sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));
  m = {
    name: user.name || USERNAME,
    created: user.created_at || null,
    repos: user.public_repos ?? repos.length,
    followers: user.followers ?? 0,
    following: user.following ?? 0,
    stars, forks, langs,
    repoMap: Object.fromEntries(repos.map((r) => [r.name.toLowerCase(), r])),
    top: byStars.slice(0, 7).map((r) => ({
      name: r.name, stars: r.stargazers_count, forks: r.forks_count,
      lang: r.language, pushed: r.pushed_at,
    })),
    fresh: byPush.slice(0, 5).map((r) => ({ name: r.name, pushed: r.pushed_at, lang: r.language })),
    lastPush: byPush.length ? byPush[0].pushed_at : null,
    fetchedAt: now.toISOString(),
    live: true,
  };
} else if (prev && Number.isFinite(prev.repos)) {
  m = { ...prev, repoMap: {}, fetchedAt: now.toISOString(), live: false };
  events = [];
} else {
  // First-ever run with no API: honest placeholder state, zero fake numbers.
  m = {
    name: USERNAME, created: null, repos: NaN, followers: NaN, following: NaN,
    stars: NaN, forks: NaN, langs: {}, repoMap: {}, top: [], fresh: [],
    lastPush: null, fetchedAt: now.toISOString(), live: false, unavailable: true,
  };
  events = [];
}

// ---------------- transmissions ----------------
function buildTransmissions() {
  const out = [];
  if (Array.isArray(events)) {
    for (const e of events.slice(0, 7)) {
      const repo = (e.repo?.name || "").replace(`${USERNAME}/`, "");
      const t = (e.created_at || "").slice(11, 16) || "--:--";
      if (e.type === "PushEvent") out.push({ t, text: `pushed to ${repo || "a repository"}` });
      else if (e.type === "PullRequestEvent")
        out.push({ t, text: `${e.payload?.action || "updated"} PR #${e.payload?.number ?? "?"} in ${repo}` });
      else if (e.type === "DeleteEvent") out.push({ t, text: `deleted ${e.payload?.ref_type || "ref"} in ${repo}` });
      else if (e.type === "CreateEvent") out.push({ t, text: `created ${e.payload?.ref_type || "something"} in ${repo}` });
      else if (e.type === "IssuesEvent") out.push({ t, text: `${e.payload?.action || "touched"} an issue in ${repo}` });
      else if (e.type === "WatchEvent") out.push({ t, text: `starred ${repo}` });
      else if (e.type === "ForkEvent") out.push({ t, text: `forked ${repo}` });
      else out.push({ t, text: `${String(e.type || "unknown").replace("Event", "").toLowerCase()} activity in ${repo}` });
    }
  }
  if (!out.length && (m.fresh || []).length) {
    for (const f of m.fresh.slice(0, 5))
      out.push({ t: (f.pushed || "").slice(5, 10), text: `repository activity in ${f.name}` });
  }
  return out.slice(0, 7);
}
const transmissions = buildTransmissions();

// ---------------- XP (custom gamification, not an official score) ----------------
const xp = Number.isFinite(m.stars) ? m.repos * 20 + m.stars * 2 + m.followers * 5 + m.forks * 10 : NaN;
const level = Number.isFinite(xp) ? Math.max(1, Math.floor(Math.sqrt(xp / 120))) : NaN;
const xpPct = Number.isFinite(xp)
  ? Math.min(99, Math.max(1, Math.round(((xp - 120 * level * level) / (120 * (level + 1) * (level + 1) - 120 * level * level)) * 100)))
  : NaN;

const profile = readJSON(path.join(DATA_DIR, "profile.json"), {});
const missionsCfg = readJSON(path.join(DATA_DIR, "projects.json"), { missions: [] });
const achievementRules = readJSON(path.join(DATA_DIR, "achievements.json"), { rules: [] }).rules || [];
const missions = (missionsCfg.missions || []).slice(0, 9);
const repoOf = (full) => m.repoMap[String(full || "").split("/")[1]?.toLowerCase() || ""];

// mission live rows shared by SVG + README
const missionRows = missions.map((ms) => {
  const r = repoOf(ms.repo);
  return {
    ...ms,
    liveStars: r ? r.stargazers_count : null,
    livePushed: r ? r.pushed_at : null,
  };
});

write(path.join(DATA_DIR, "telemetry.json"), JSON.stringify({ ...m, repoMap: undefined, xp, level, xpPct, transmissions }, null, 2));
write(path.join(DATA_DIR, "transmissions.json"), JSON.stringify({ updated: now.toISOString(), items: transmissions }, null, 2));

// ---------------- achievements engine ----------------
const langCount = Object.keys(m.langs || {}).length;
const daysSincePush = m.lastPush ? (now - new Date(m.lastPush)) / 86400000 : 999;
const actx = {
  repos: m.repos, stars: m.stars, followers: m.followers, languages: langCount,
  hasRust: (m.langs || {}).Rust > 0, pushedWithinDays: daysSincePush,
};
const passRule = (t) => {
  const mm = String(t).match(/(\w+)\s*(>=|==)\s*([\w.]+)/);
  if (!mm || !Number.isFinite(actx[mm[1]])) return false;
  const [, k, op, raw] = mm;
  const want = raw === "true" ? true : Number(raw);
  return op === ">=" ? actx[k] >= want : actx[k] === want;
};
const unlocked = achievementRules.filter((r) => passRule(r.test)).length;
const firstLocked = achievementRules.find((r) => !passRule(r.test));

// ---------------- theme ----------------
const T = {
  bg: "#050508", panel: "#0b0b12", border: "#23233a", accent: "#7c6cff",
  accent2: "#22d3ee", text: "#f4f4f6", dim: "#8e8ea3",
  green: "#34d399", amber: "#fbbf24", red: "#f87171", blue: "#60a5fa",
  font: "'Segoe UI',Helvetica,Arial,sans-serif", mono: "'Cascadia Code','JetBrains Mono',Consolas,monospace",
};
const syncDay = isoDay(now.toISOString());
const syncLabel = now.toISOString().slice(0, 16).replace("T", " ") + " UTC";
const version = `${String(now.getUTCFullYear()).slice(2)}.${String(now.getUTCMonth() + 1).padStart(2, "0")}.${String(now.getUTCDate()).padStart(2, "0")}`;
const statusColor = (s) =>
  ({ OPERATIONAL: T.green, BUILDING: T.amber, RESEARCH: T.blue, EXPERIMENTAL: T.accent, MAINTENANCE: T.dim, ARCHIVED: T.red }[s] || T.dim);
const wrap = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="14" fill="${T.bg}"/><rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="13" fill="none" stroke="${T.border}"/>${body}</svg>`;
const bar = (x, y, w, pct, color) => `<rect x="${x}" y="${y}" width="${w}" height="8" rx="4" fill="#17171f"/><rect x="${x}" y="${y}" width="${Math.round((Math.min(100, Number(pct) || 0) / 100) * w)}" height="8" rx="4" fill="${color}"/>`;
const unavailable = m.unavailable ? `<text x="28" y="36" font-family="${T.mono}" font-size="13" fill="${T.amber}">DATA TEMPORARILY UNAVAILABLE — LAST KNOWN STATE PENDING</text>` : "";

// ---------------- 1. hero ----------------
{
  const name = esc((m.name || USERNAME).toUpperCase());
  const rows = [
    ["IDENTITY", name],
    ["AI CORE", "ONLINE"],
    ["FULL STACK ENGINE", "ONLINE"],
    ["RESEARCH MODULE", "ONLINE"],
    ["OPEN SOURCE LINK", "CONNECTED"],
  ];
  let y = 118;
  let body = `<text x="48" y="52" font-family="${T.mono}" font-size="15" fill="${T.dim}">› INITIALIZING BK.DEV …</text>
  <text x="48" y="86" font-family="${T.mono}" font-size="15" fill="${T.green}">[████████████████████] 100%</text>`;
  for (const [k, v] of rows) {
    body += `<text x="48" y="${y}" font-family="${T.mono}" font-size="14" fill="${T.dim}">${k} ${".".repeat(Math.max(2, 22 - k.length))}</text><text x="380" y="${y}" font-family="${T.mono}" font-size="14" font-weight="bold" fill="${T.text}">${v}</text>`;
    y += 30;
  }
  body += `<circle cx="48" cy="${y + 6}" r="6" fill="${m.live ? T.green : T.amber}"/><text x="62" y="${y + 7}" font-family="${T.mono}" font-size="14" fill="${T.text}">SYSTEM STATUS: ${m.live ? "● ONLINE — LIVE DATA" : "○ CACHED — LAST KNOWN STATE"}</text>`;
  write(path.join(OUT_DIR, "hero.svg"), wrap(640, y + 48, body));
}

// ---------------- 2. telemetry ----------------
{
  const rows = [
    ["REPOSITORIES", num(m.repos)],
    ["STARS EARNED", num(m.stars)],
    ["FOLLOWERS", num(m.followers)],
    ["FOLLOWING", num(m.following)],
    ["FORKS", num(m.forks)],
    ["LAST ACTIVITY", m.lastPush ? relDate(m.lastPush, now) : "—"],
  ];
  let body = `<text x="28" y="36" font-family="${T.mono}" font-size="13" fill="${T.dim}">⚡ LIVE GITHUB TELEMETRY ${m.live ? "● LIVE" : "○ CACHED"}</text>`;
  let y = 66;
  for (const [k, v] of rows) {
    body += `<text x="28" y="${y}" font-family="${T.mono}" font-size="14" fill="${T.dim}">${k}</text><text x="592" y="${y}" text-anchor="end" font-family="${T.mono}" font-size="15" font-weight="bold" fill="${T.text}">${esc(v)}</text>`;
    y += 30;
  }
  body += `<text x="28" y="${y + 8}" font-family="${T.mono}" font-size="12" fill="${T.dim}">LAST SYNC ${esc(syncLabel)} · SOURCE: api.github.com/users/${USERNAME}</text>`;
  write(path.join(OUT_DIR, "telemetry.svg"), wrap(620, y + 40, body));
}

// ---------------- 3. skill-tree (nodes derived from live top languages) ----------------
{
  const topLangs = Object.entries(m.langs || {}).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const [L1 = "—", L2 = "—", L3 = "—"] = topLangs;
  const W = 640, H = 380;
  const node = (x, y, label, sub, hot) => `<rect x="${x - 74}" y="${y - 24}" width="148" height="48" rx="10" fill="${T.panel}" stroke="${hot ? T.accent : T.border}" stroke-width="${hot ? 2 : 1}"/><text x="${x}" y="${y - 3}" text-anchor="middle" font-family="${T.font}" font-size="13" font-weight="bold" fill="${T.text}">${esc(label)}</text><text x="${x}" y="${y + 13}" text-anchor="middle" font-family="${T.mono}" font-size="10" fill="${T.dim}">${esc(sub)}</text>`;
  const edge = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${T.border}" stroke-width="2"/>`;
  const body = `
  ${edge(320, 66, 170, 130)}${edge(320, 66, 320, 130)}${edge(320, 66, 470, 130)}
  ${edge(170, 178, 170, 208)}${edge(320, 178, 320, 208)}${edge(470, 178, 470, 208)}
  ${edge(170, 256, 320, 286)}${edge(320, 256, 320, 286)}${edge(470, 256, 320, 286)}
  ${unavailable}
  ${node(320, 42, "AI SYSTEMS", "agents · llms · rag", true)}
  ${node(170, 154, "LLMs", "transformers · rag", false)}${node(320, 154, "AGENTS", "memory · tools", true)}${node(470, 154, "SYSTEMS", "rust · search", false)}
  ${node(170, 232, L1, `${m.langs?.[L1] ?? "—"} repos`, false)}${node(320, 232, L2, `${m.langs?.[L2] ?? "—"} repos`, true)}${node(470, 232, L3, `${m.langs?.[L3] ?? "—"} repos`, false)}
  ${node(320, 310, "FULL-STACK SYSTEMS", `${num(m.repos)} repos · live`, true)}
  <text x="320" y="362" text-anchor="middle" font-family="${T.mono}" font-size="11" fill="${T.dim}">language mix is live repo data — not a skill claim</text>`;
  write(path.join(OUT_DIR, "skill-tree.svg"), wrap(W, H, body));
}

// ---------------- 4. mission-control ----------------
{
  const cw = 300, ch = 196, gap = 14, cols = 3, pad = 16;
  const rowsN = Math.max(1, Math.ceil(missionRows.length / cols));
  const W = pad * 2 + cols * cw + (cols - 1) * gap;
  const H = pad * 2 + 34 + rowsN * ch + (rowsN - 1) * gap;
  let body = `<text x="${pad}" y="${pad + 12}" font-family="${T.mono}" font-size="13" fill="${T.dim}">🚀 MISSION CONTROL — ${missionRows.length} ACTIVE · STARS ARE LIVE</text>`;
  missionRows.forEach((ms, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = pad + col * (cw + gap), y = pad + 30 + row * (ch + gap);
    const stars = ms.liveStars ?? "·";
    const upd = ms.livePushed ? relDate(ms.livePushed, now) : "cached";
    const c = statusColor(ms.status);
    body += `<g transform="translate(${x},${y})"><rect width="${cw}" height="${ch}" rx="12" fill="${T.panel}" stroke="${T.border}"/>
    <text x="16" y="26" font-family="${T.mono}" font-size="11" fill="${T.dim}">MISSION ${esc(ms.id)} · ★ ${stars} · ${esc(upd)}</text>
    <text x="16" y="52" font-family="${T.font}" font-size="17" font-weight="bold" fill="${T.text}">${esc(ms.name)}</text>
    <circle cx="${cw - 20}" cy="48" r="6" fill="${c}"/>
    <text x="16" y="74" font-family="${T.mono}" font-size="11" fill="${c}">● ${esc(ms.status)}</text>
    <text x="16" y="92" font-family="${T.mono}" font-size="10" fill="${T.dim}">${esc(ms.type || "")}</text>
    <text x="16" y="112" font-family="${T.font}" font-size="11" fill="${T.dim}">${esc((ms.objective || "").slice(0, 62))}</text>
    <text x="16" y="128" font-family="${T.font}" font-size="11" fill="${T.dim}">${esc((ms.objective || "").slice(62, 120))}</text>
    ${bar(16, 142, cw - 32, ms.progress || 0, c)}
    <text x="16" y="168" font-family="${T.mono}" font-size="10" fill="${T.dim}">${esc(ms.stack || "")}</text>
    <text x="${cw - 16}" y="168" text-anchor="end" font-family="${T.mono}" font-size="11" fill="${T.text}">${ms.progress || 0}%</text></g>`;
  });
  write(path.join(OUT_DIR, "mission-control.svg"), wrap(W, H, body));
}

// ---------------- 5. contribution-game ----------------
{
  const W = 640, H = 300;
  const fuel = Number.isFinite(xp) ? Math.min(99, Math.max(8, Math.round((Math.log10(xp) / 5) * 100))) : 8;
  const segs = [
    ["LAUNCH", "first systems online", Math.min(99, fuel + 20), T.green],
    ["ORBIT", "shipping cadence", fuel, T.accent2],
    ["DEEP SPACE", "research frontier", Math.max(8, fuel - 20), T.accent],
    ["UNKNOWN", "next experiments", Math.max(8, fuel - 40), T.amber],
  ];
  let body = `<text x="28" y="36" font-family="${T.mono}" font-size="13" fill="${T.dim}">🚀 SPACE MISSION — SEASON ${now.getUTCFullYear()} · FUEL = REAL REPOS + STARS + FOLLOWERS</text>
  <text x="28" y="60" font-family="${T.mono}" font-size="12" fill="${T.dim}">${num(m.repos)} REPOS · ${num(m.stars)} STARS · ${num(m.followers)} FOLLOWERS · LVL ${Number.isFinite(level) ? level : "—"}</text>`;
  let y = 92;
  for (const [name, sub, pct, c] of segs) {
    body += `<text x="28" y="${y}" font-family="${T.mono}" font-size="13" fill="${T.text}">${name}</text><text x="200" y="${y}" font-family="${T.mono}" font-size="11" fill="${T.dim}">${sub}</text>${bar(28, y + 12, W - 56, pct, c)}`;
    y += 52;
  }
  body += `<text x="28" y="${H - 18}" font-family="${T.mono}" font-size="11" fill="${T.dim}">NEXT SEASON: 🐍 SNAKE RUN · THEN 👾 PAC-MAN · progression is illustrative, inputs are real</text>`;
  write(path.join(OUT_DIR, "contribution-game.svg"), wrap(W, H, body));
}

// ---------------- 6. achievements ----------------
{
  const W = 640, per = 2, bw = (W - 48) / 2, bh = 44;
  const rowsN = Math.max(1, Math.ceil(achievementRules.length / per));
  const H = 56 + rowsN * (bh + 8) + 34;
  let body = `<text x="24" y="34" font-family="${T.mono}" font-size="13" fill="${T.dim}">🏆 ACHIEVEMENTS — UNLOCKED FROM LIVE DATA (${m.live ? "LIVE" : "CACHED"})</text>`;
  achievementRules.forEach((r, i) => {
    const ok = passRule(r.test);
    const x = 24 + (i % per) * (bw + 8), y = 48 + Math.floor(i / per) * (bh + 8);
    body += `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="9" fill="${T.panel}" stroke="${ok ? T.green : T.border}"/><text x="${x + 14}" y="${y + 23}" font-family="${T.mono}" font-size="13" fill="${ok ? T.green : T.dim}">${ok ? "[✓]" : "[ ]"}</text><text x="${x + 48}" y="${y + 23}" font-family="${T.mono}" font-size="12" font-weight="bold" fill="${ok ? T.text : T.dim}">${esc(r.label)}</text>`;
  });
  body += `<text x="24" y="${H - 14}" font-family="${T.mono}" font-size="11" fill="${T.dim}">${unlocked}/${achievementRules.length} UNLOCKED · evaluated ${esc(syncLabel)}</text>`;
  write(path.join(OUT_DIR, "achievements.svg"), wrap(W, H, body));
}

// ---------------- 7. constellation (nodes from mission manifest) ----------------
{
  const W = 640, H = 330;
  const pts = [[320, 50], [150, 120], [490, 120], [210, 195], [430, 195], [320, 275]];
  const names = missions.slice(0, 6).map((ms) => `${ms.name} · ${(ms.type || "").split("/")[0].trim().toLowerCase()}`);
  let body = `<text x="28" y="36" font-family="${T.mono}" font-size="13" fill="${T.dim}">🌌 PROJECT CONSTELLATION — ONE ENGINEERING JOURNEY</text>`;
  for (const [x, y] of pts) body += `<line x1="320" y1="165" x2="${x}" y2="${y}" stroke="${T.border}" stroke-width="1.5"/>`;
  pts.forEach(([x, y], i) => {
    body += `<circle cx="${x}" cy="${y}" r="5" fill="${T.accent}"/><text x="${x}" y="${y - 14}" text-anchor="middle" font-family="${T.mono}" font-size="11" fill="${T.text}">✦ ${esc(names[i] || "—")}</text>`;
  });
  body += `<text x="320" y="${H - 22}" text-anchor="middle" font-family="${T.mono}" font-size="11" fill="${T.dim}">AI SYSTEMS → AGENTS → AUTOMATION → FULL-STACK → EXPERIMENTS</text>`;
  write(path.join(OUT_DIR, "constellation.svg"), wrap(W, H, body));
}

// ---------------- README regions ----------------
// Every dynamic value in README.md lives between OS markers and is
// regenerated here. Static prose/structure stays hand-written.
const P = profile.profile || {};
const R = (v) => (m.unavailable ? "DATA TEMPORARILY UNAVAILABLE" : v);
const freshNames = (m.fresh || []).map((f) => f.name);
const langMix = Object.entries(m.langs || {}).sort((a, b) => b[1] - a[1]);
const starsRounded = Number.isFinite(m.stars) ? `${Math.floor(m.stars / 100) * 100}+` : "—";

const REGIONS = {
  player: () => {
    const status = freshNames.length
      ? `● BUILDING (${freshNames[0]} pushed ${relDate(m.lastPush, now)})` : "● STANDBY";
    const pl = profile.player || {};
    return ["```text",
      `PLAYER ............ ${P.name || m.name} (@${USERNAME})`,
      `CLASS ............. ${pl.class || "—"}`,
      `SPECIALIZATION .... ${pl.specialization || "—"}`,
      `LOCATION .......... ${P.location || "—"}`,
      `OBJECTIVE ......... ${pl.objective || "—"}`,
      `STATUS ............ ${R(status)}`, "",
      `PRIMARY ........... ${pl.primary || "—"}`,
      `ACTIVE ............ ${pl.active || "—"}`,
      `EXPLORING ......... ${pl.exploring || "—"}`,
      `EXPERIMENTAL ...... ${pl.experimental || "—"}`,
      "```"].join("\n");
  },
  "skill-mix": () => m.unavailable
    ? "Language data temporarily unavailable — showing last rendered tree."
    : `Live language mix behind this tree (real repo data, ${monthYear(now.toISOString())}): **${langMix.map(([k, v]) => `${k} ${v}`).join(" · ")}** — ${num(m.repos)} public repos. Language counts describe the repos, not skill claims.`,
  "telemetry-table": () => [
    `| Metric | Live value (${syncDay}) | Source |`,
    "|---|---|---|",
    `| Public repositories | **${R(num(m.repos))}** | \`api.github.com/users/${USERNAME}\` |`,
    `| Stars earned | **${R(num(m.stars))}** | sum of \`stargazers_count\` over all repos |`,
    `| Followers / Following | **${R(`${num(m.followers)} / ${num(m.following)}`)}** | user profile |`,
    `| Forks | **${R(num(m.forks))}** | sum of \`forks_count\` |`,
    `| Last push | **${m.lastPush ? `${freshNames[0] || "—"}, ${relDate(m.lastPush, now)}` : "—"}** | repos sorted by \`pushed_at\` |`,
    `| Fresh builds | ${R(freshNames.slice(0, 3).join(" · ") || "—")} | last 3 pushes |`,
    "",
    "Regenerated every 6h by `.github/workflows/update-profile.yml`. If the API is unreachable the cards show the last known state instead of an error.",
  ].join("\n"),
  "missions-table": () => [
    "| # | Mission | Status | Live repo |",
    "|---|---|---|---|",
    ...missionRows.map((ms) => {
      const star = ms.liveStars ?? "·";
      const upd = ms.livePushed ? relDate(ms.livePushed, now) : "cached";
      return `| ${ms.id} | **${mdEsc(ms.name)}** — ${mdEsc(ms.objective)} | ● ${ms.status} | [${ms.repo}](https://github.com/${ms.repo}) · ${star}★ · ${upd} |`;
    }),
    "",
    "Progress bars are manual build estimates; stars + last-push are live from the API. Edit `data/projects.json` to change the manifest.",
  ].join("\n"),
  level: () => {
    if (m.unavailable) return "```text\nBK // LEVEL —\n\nXP data temporarily unavailable.\n```";
    const filled = Math.round((xpPct / 100) * 22);
    return ["```text",
      `BK // LEVEL ${level}`, "",
      `XP  ${"█".repeat(filled)}${"░".repeat(22 - filled)}  ${xpPct}%  (${num(xp)} XP)`, "",
      `REPOS ×${num(m.repos)} ............ +20 XP each`,
      `STARS ×${num(m.stars)} ......... +2 XP each`,
      `FOLLOWERS ×${num(m.followers)} ....... +5 XP each`,
      "```"].join("\n");
  },
  "achievements-note": () => m.unavailable
    ? "Achievement data temporarily unavailable."
    : `Rules live in \`data/achievements.json\` and are evaluated against live data — ${unlocked}/${achievementRules.length} unlocked${firstLocked ? `, \`${firstLocked.label}\` still locked` : ""}. No invented unlocks.`,
  research: () => {
    const rs = profile.research || {};
    const list = (arr) => (arr || []).join(" · ");
    return ["```text", "INVESTIGATING", `  ${list(rs.investigating)}`, "",
      "EXPERIMENTING", `  ${list(rs.experimenting)}`, "",
      "UNDERSTANDING", `  ${list(rs.understanding)}`, "```", "",
      `> **CURRENT RESEARCH:** ${rs.current_question || "—"}`].join("\n");
  },
  loadout: () => {
    const lo = profile.loadout || {};
    const j = (arr) => (arr || []).join(" · ");
    return ["```text", "EQUIPPED", `  ${j(lo.equipped)}`, "",
      "CURRENTLY LEARNING", `  ${j(lo.learning)}`, "",
      "EXPERIMENTAL", `  ${j(lo.experimental)}`, "```"].join("\n");
  },
  currently: () => {
    const c = profile.currently || {};
    return ["```text",
      `🔨 BUILDING ...... ${c.building || "—"}`,
      `🧪 EXPERIMENTING  ${c.experimenting || "—"}`,
      `📚 LEARNING ...... ${c.learning || "—"}`,
      `🔍 RESEARCHING ... ${c.researching || "—"}`,
      `🎯 NEXT .......... ${c.next || "—"}`,
      "```", "", "Controlled by `data/profile.json` — no code changes needed."].join("\n");
  },
  quests: () => {
    const q = profile.quests || {};
    const side = (q.side || []).map((s) => `${s.done ? "☑" : "□"} ${s.title}`).join("\n");
    return ["```text", "MAIN QUEST", "━━━━━━━━━━━━━━━━━━━━━━",
      q.main?.title || "—", `STATUS: ${q.main?.status || "—"}`, "",
      "SIDE QUESTS", "━━━━━━━━━━━━━━━━━━━━━━", side, "```"].join("\n");
  },
  experiment: () => {
    const e = profile.experiment_of_the_week || {};
    const wrapLines = (s, w) => {
      const words = String(s || "—").split(" ");
      const lines = [];
      let cur = "";
      for (const word of words) {
        if ((`${cur} ${word}`.trim().length) > w) { lines.push(cur.trim()); cur = word; }
        else cur = `${cur} ${word}`;
      }
      if (cur.trim()) lines.push(cur.trim());
      return lines;
    };
    const title = wrapLines(e.title, 40);
    const pad = (s) => s + " ".repeat(Math.max(0, 40 - s.length));
    return ["```text", "┌──────────────────────────────────────────┐",
      "│ 🧪 EXPERIMENT OF THE WEEK                │",
      "│                                          │",
      ...title.map((l) => `│ ${pad(l)} │`),
      "│                                          │",
      `│ VEHICLE: ${pad((e.vehicle || "—").slice(0, 30))} │`,
      `│ STATUS: ${pad(e.status || "—")} │`,
      "└──────────────────────────────────────────┘", "```"].join("\n");
  },
  transmissions: () => m.unavailable || !transmissions.length
    ? ["```text", "DATA TEMPORARILY UNAVAILABLE", `LAST KNOWN STATE: ${syncDay}`, "```"].join("\n")
    : ["```text", ...transmissions.map((x) => `${x.t}  ${x.text}`), "```"].join("\n"),
  sysstatus: () => {
    const dev = missionRows.filter((x) => x.status === "BUILDING").slice(0, 3);
    const padRow = (k, v) => `│ ${k.padEnd(18)}${v.padEnd(18)}│`;
    return ["```text",
      "┌─────────────────────────────────────┐",
      "│ SYSTEM STATUS                       │",
      "├─────────────────────────────────────┤",
      padRow("GitHub", m.live ? "● CONNECTED" : "○ CACHED"),
      padRow("Profile pipeline", "● ONLINE"),
      ...dev.map((d) => padRow(d.name.slice(0, 18), "● DEVELOPMENT")),
      "│                                     │",
      padRow("LAST SYNC", `${syncDay} UTC`),
      "└─────────────────────────────────────┘", "```", "",
      "Health is verified read-only by `.github/workflows/health-check.yml` — it fails the run rather than ever rendering `undefined`/`NaN` to visitors."].join("\n");
  },
  lore: () => {
    const lore = (profile.lore || []).map((e) => ({
      year: e.year,
      text: e.text
        .replaceAll("{{repos}}", String(m.repos ?? "—"))
        .replaceAll("{{stars}}", starsRounded)
        .replaceAll("{{fresh3}}", freshNames.slice(0, 3).join(", ") || "—")
        .replaceAll("{{created}}", m.created ? monthYear(m.created) : "—"),
    }));
    return ["```text", ...lore.flatMap((e, i) => [
      ...(i ? [""] : []), e.year, `└── ${e.text}`,
    ]), "```"].join("\n");
  },
  "top-repos": () => m.unavailable || !m.top.length
    ? "Top-repository data temporarily unavailable."
    : [`Top repositories by stars (live, ${syncDay}):`, "",
      "| Repo | ★ | Lang | Last push |", "|---|---|---|---|",
      ...m.top.map((r) => `| [${r.name}](https://github.com/${USERNAME}/${r.name}) | ${r.stars} | ${r.lang || "—"} | ${monthDay(r.pushed)} |`)].join("\n"),
  footer: () => ["```", "────────────────────────────────────────",
    `BK.DEV SYSTEM · VERSION ${version}`,
    `LAST SYNCHRONIZED ${syncDay} UTC · SOURCE api.github.com/users/${USERNAME}`,
    "Built with: GitHub API · GitHub Actions · Node · SVG",
    `[ SOURCE ] [ PROJECTS ] [ CONTACT: ${P.email || "—"} ]`,
    "────────────────────────────────────────", "```"].join("\n"),
};

{
  let readme = fs.readFileSync(README_PATH, "utf8");
  let touched = 0;
  for (const [name, build] of Object.entries(REGIONS)) {
    const re = new RegExp(`<!-- OS:${name} -->[\\s\\S]*?<!-- /OS:${name} -->`, "m");
    const block = `<!-- OS:${name} -->\n${build()}\n<!-- /OS:${name} -->`;
    if (!re.test(readme)) {
      console.warn(`marker OS:${name} missing in README — skipped`);
      continue;
    }
    readme = readme.replace(re, () => block);
    touched++;
  }
  write(README_PATH, readme);
  console.log(`README regions updated: ${touched}/${Object.keys(REGIONS).length}`);
}

console.log(`\nBK // OS done (${m.live ? "LIVE" : "CACHED"}): ${num(m.repos)} repos · ${num(m.stars)} stars · ${num(m.followers)} followers${Number.isFinite(level) ? ` · LVL ${level} ${xpPct}%` : ""}`);
