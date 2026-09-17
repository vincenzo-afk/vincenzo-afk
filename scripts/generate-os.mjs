#!/usr/bin/env node
/**
 * BK // DEVELOPER OS — generator
 * ================================
 * Pipeline: GitHub REST + profile contributions graph → metrics → animated
 * SVG arcade + README regions → commit. Zero dependencies (Node 18+).
 *
 *   node scripts/generate-os.mjs
 *   GH_USERNAME=vincenzo-afk GITHUB_TOKEN=xxx node scripts/generate-os.mjs
 *
 * Single source of truth:
 *   LIVE   numbers/dates/tables/contribution days → GitHub (never hand-edited)
 *   MANUAL curation → data/profile.json, data/projects.json, data/achievements.json
 *
 * Outputs (committed by CI): assets/*.svg, data/telemetry.json,
 * data/transmissions.json, README.md (inside <!-- OS:… --> markers only).
 *
 * Failure contract: never emit undefined/null/NaN/API ERROR. API down →
 * reuse last snapshot; no snapshot → honest "temporarily unavailable" state.
 *
 * Animation: all motion is declarative SMIL (<animate>/<animateMotion>/…)
 * which GitHub renders in README images. No JavaScript, no third parties.
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
  console.log("wrote", p, `(${(Buffer.byteLength(c, "utf8") / 1024).toFixed(1)}kb)`);
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

// ---------------- real contribution calendar (public graph, no auth) ----------------
async function fetchContributions() {
  const res = await fetch(`https://github.com/users/${USERNAME}/contributions`, {
    headers: { "User-Agent": "bk-developer-os" },
  });
  if (!res.ok) throw new Error(`contributions graph → ${res.status}`);
  const html = await res.text();
  const totalMatch = html.match(/([\d,]+)\s+contributions\s+in the last year/);
  const total = totalMatch ? Number(totalMatch[1].replace(/,/g, "")) : NaN;
  const cells = [...html.matchAll(/data-date="([^"]+)"[^>]*?data-level="([^"]+)"/g)];
  const tips = [...html.matchAll(/<tool-tip[^>]*>(.*?)<\/tool-tip>/gs)].map((m) => m[1].trim());
  const days = cells.map((c, i) => {
    const tip = tips[i] || "";
    const cm = tip.match(/([\d,]+)\s+contributions?\s+on/);
    return { d: c[1], l: Number(c[2]) || 0, c: cm ? Number(cm[1].replace(/,/g, "")) : 0 };
  });
  if (!days.length) throw new Error("no contribution cells parsed");
  return { total: Number.isFinite(total) ? total : days.reduce((s, x) => s + x.c, 0), days };
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
const weekday = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
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
let user = null, repos = null, events = [], cal = null;
try {
  [user, repos, cal] = await Promise.all([
    rest(`/users/${USERNAME}`),
    fetchAllRepos(),
    fetchContributions().catch((e) => {
      console.warn("contrib graph unavailable:", String(e).slice(0, 80));
      return null;
    }),
  ]);
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
    cal: cal || prev?.cal || null,
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
  m = {
    name: USERNAME, created: null, repos: NaN, followers: NaN, following: NaN,
    stars: NaN, forks: NaN, langs: {}, cal: null, repoMap: {}, top: [], fresh: [],
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
const calDaysEarly = m.cal?.days || [];
const calTotalEarly = m.cal?.total ?? NaN;
const xp = Number.isFinite(m.stars)
  ? m.repos * 20 + m.stars * 2 + m.followers * 5 + m.forks * 10 + (Number.isFinite(calTotalEarly) ? calTotalEarly : 0)
  : NaN;
const level = Number.isFinite(xp) ? Math.max(1, Math.floor(Math.sqrt(xp / 120))) : NaN;
const xpPct = Number.isFinite(xp)
  ? Math.min(99, Math.max(1, Math.round(((xp - 120 * level * level) / (120 * (level + 1) * (level + 1) - 120 * level * level)) * 100)))
  : NaN;

const profile = readJSON(path.join(DATA_DIR, "profile.json"), {});
const missionsCfg = readJSON(path.join(DATA_DIR, "projects.json"), { missions: [] });
const achievementRules = readJSON(path.join(DATA_DIR, "achievements.json"), { rules: [] }).rules || [];
const missions = (missionsCfg.missions || []).slice(0, 9);
const repoOf = (full) => m.repoMap[String(full || "").split("/")[1]?.toLowerCase() || ""];
const missionRows = missions.map((ms) => {
  const r = repoOf(ms.repo);
  return { ...ms, liveStars: r ? r.stargazers_count : null, livePushed: r ? r.pushed_at : null };
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

// ---------------- season rotation (weekly, deterministic) ----------------
const SEASONS = [
  { id: "space", icon: "🚀", name: "SPACE MISSION" },
  { id: "snake", icon: "🐍", name: "SNAKE RUN" },
  { id: "pacman", icon: "👾", name: "PAC-MAN" },
  { id: "racing", icon: "🏎️", name: "CODE RACING" },
  { id: "galaxy", icon: "🌌", name: "GALAXY" },
];
const forced = (process.env.OS_SEASON || "").toLowerCase();
const seasonIdx = forced
  ? Math.max(0, SEASONS.findIndex((s) => s.id === forced))
  : Math.floor(Date.now() / (7 * 86400000)) % SEASONS.length;
const season = SEASONS[seasonIdx];
const nextSeason = SEASONS[(seasonIdx + 1) % SEASONS.length];
const calDays = m.cal?.days || [];
const calTotal = m.cal?.total ?? NaN;
const calActive = calDays.filter((d) => d.c > 0).length;

// ---------------- theme + SVG helpers ----------------
const T = {
  bg: "#050508", panel: "#0b0b12", border: "#23233a", accent: "#7c6cff",
  accent2: "#22d3ee", text: "#f4f4f6", dim: "#8e8ea3",
  green: "#34d399", amber: "#fbbf24", red: "#f87171", blue: "#60a5fa",
  font: "'Segoe UI',Helvetica,Arial,sans-serif", mono: "'Cascadia Code','JetBrains Mono',Consolas,monospace",
};
const LVL = ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"]; // GitHub greens
const syncDay = isoDay(now.toISOString());
const syncLabel = now.toISOString().slice(0, 16).replace("T", " ") + " UTC";
const version = `${String(now.getUTCFullYear()).slice(2)}.${String(now.getUTCMonth() + 1).padStart(2, "0")}.${String(now.getUTCDate()).padStart(2, "0")}`;
const statusColor = (s) =>
  ({ OPERATIONAL: T.green, BUILDING: T.amber, RESEARCH: T.blue, EXPERIMENTAL: T.accent, MAINTENANCE: T.dim, ARCHIVED: T.red }[s] || T.dim);
const wrap = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="14" fill="${T.bg}"/><rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="13" fill="none" stroke="${T.border}"/>${body}</svg>`;
const bar = (x, y, w, pct, color) => `<rect x="${x}" y="${y}" width="${w}" height="8" rx="4" fill="#17171f"/><rect x="${x}" y="${y}" width="${Math.round((Math.min(100, Number(pct) || 0) / 100) * w)}" height="8" rx="4" fill="${color}"/>`;
const growBar = (x, y, w, pct, color, begin) => {
  const fw = Math.round((Math.min(100, Number(pct) || 0) / 100) * w);
  return `<rect x="${x}" y="${y}" width="${w}" height="8" rx="4" fill="#17171f"/><rect x="${x}" y="${y}" width="${fw}" height="8" rx="4" fill="${color}"><animate attributeName="width" from="0" to="${fw}" dur="1.2s" begin="${begin}" fill="freeze"/></rect>`;
};
const pulseDot = (cx, cy, r, color, begin = "0s") =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"><animate attributeName="opacity" values="1;.35;1" dur="2s" begin="${begin}" repeatCount="indefinite"/></circle>`;
const twinkle = (cx, cy, r, color, i, max = 14) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"><animate attributeName="opacity" values="1;.15;1" dur="${(1.6 + (i % 5) * 0.5).toFixed(1)}s" begin="${((i % max) * 0.28).toFixed(2)}s" repeatCount="indefinite"/></circle>`;

// ---------------- 1. hero (animated boot + cycling roles) ----------------
{
  const name = esc((m.name || USERNAME).toUpperCase());
  const roles = ["Full Stack Developer", "AI Systems Builder", "AI Engineer · Researcher"];
  const cyc = roles.map((r, i) =>
    `<text x="48" y="268" font-family="${T.mono}" font-size="14" fill="${T.accent2}" opacity="0">${esc("› " + r)}<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.08;.9;1" dur="9s" begin="${i * 3}s" repeatCount="indefinite"/></text>`).join("");
  const rows = [
    ["IDENTITY", name],
    ["AI CORE", "ONLINE"],
    ["FULL STACK ENGINE", "ONLINE"],
    ["RESEARCH MODULE", "ONLINE"],
    ["OPEN SOURCE LINK", "CONNECTED"],
  ];
  let y = 118;
  let body = `<text x="48" y="52" font-family="${T.mono}" font-size="15" fill="${T.dim}">› INITIALIZING BK.DEV …</text>
  <text x="48" y="86" font-family="${T.mono}" font-size="15" fill="${T.green}">[████████████████████] 100%<animate attributeName="opacity" values="1;.6;1" dur="2.4s" repeatCount="indefinite"/></text>`;
  for (const [k, v] of rows) {
    body += `<text x="48" y="${y}" font-family="${T.mono}" font-size="14" fill="${T.dim}">${k} ${".".repeat(Math.max(2, 22 - k.length))}</text><text x="380" y="${y}" font-family="${T.mono}" font-size="14" font-weight="bold" fill="${T.text}">${v}</text>`;
    y += 30;
  }
  body += `${pulseDot(48, y + 6, 6, m.live ? T.green : T.amber)}<text x="62" y="${y + 7}" font-family="${T.mono}" font-size="14" fill="${T.text}">SYSTEM STATUS: ${m.live ? "● ONLINE — LIVE DATA" : "○ CACHED — LAST KNOWN STATE"}</text>${cyc}<rect x="52" y="278" width="10" height="16" fill="${T.accent2}"><animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/></rect>`;
  write(path.join(OUT_DIR, "hero.svg"), wrap(640, y + 52, body));
}

// ---------------- 2. telemetry (pop-in rows + pulsing LIVE) ----------------
{
  const rows = [
    ["REPOSITORIES", num(m.repos)],
    ["STARS EARNED", num(m.stars)],
    ["FOLLOWERS", num(m.followers)],
    ["FOLLOWING", num(m.following)],
    ["FORKS", num(m.forks)],
    ["CONTRIBUTIONS (1Y)", num(calTotal)],
    ["LAST ACTIVITY", m.lastPush ? relDate(m.lastPush, now) : "—"],
  ];
  let body = `${pulseDot(596, 32, 5, m.live ? T.green : T.amber)}<text x="28" y="36" font-family="${T.mono}" font-size="13" fill="${T.dim}">⚡ LIVE GITHUB TELEMETRY ${m.live ? "● LIVE" : "○ CACHED"}</text>`;
  let y = 66;
  rows.forEach(([k, v], i) => {
    body += `<g opacity="0"><animate attributeName="opacity" from="0" to="1" dur=".5s" begin="${(i * 0.12).toFixed(2)}s" fill="freeze"/><text x="28" y="${y}" font-family="${T.mono}" font-size="14" fill="${T.dim}">${k}</text><text x="592" y="${y}" text-anchor="end" font-family="${T.mono}" font-size="15" font-weight="bold" fill="${T.text}">${esc(v)}</text></g>`;
    y += 30;
  });
  body += `<text x="28" y="${y + 8}" font-family="${T.mono}" font-size="12" fill="${T.dim}">LAST SYNC ${esc(syncLabel)} · SOURCE: api.github.com/users/${USERNAME}</text>`;
  write(path.join(OUT_DIR, "telemetry.svg"), wrap(620, y + 40, body));
}

// ---------------- 3. skill-tree (orbit ring + live language nodes) ----------------
{
  const topLangs = Object.entries(m.langs || {}).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const [L1 = "—", L2 = "—", L3 = "—"] = topLangs;
  const W = 640, H = 380;
  const node = (x, y, label, sub, hot, bi) => `<rect x="${x - 74}" y="${y - 24}" width="148" height="48" rx="10" fill="${T.panel}" stroke="${hot ? T.accent : T.border}" stroke-width="${hot ? 2 : 1}"><animate attributeName="stroke-opacity" values="1;.4;1" dur="3s" begin="${bi}s" repeatCount="indefinite"/></rect><text x="${x}" y="${y - 3}" text-anchor="middle" font-family="${T.font}" font-size="13" font-weight="bold" fill="${T.text}">${esc(label)}</text><text x="${x}" y="${y + 13}" text-anchor="middle" font-family="${T.mono}" font-size="10" fill="${T.dim}">${esc(sub)}</text>`;
  const edge = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${T.border}" stroke-width="2"/>`;
  const body = `
  ${edge(320, 66, 170, 130)}${edge(320, 66, 320, 130)}${edge(320, 66, 470, 130)}
  ${edge(170, 178, 170, 208)}${edge(320, 178, 320, 208)}${edge(470, 178, 470, 208)}
  ${edge(170, 256, 320, 286)}${edge(320, 256, 320, 286)}${edge(470, 256, 320, 286)}
  <ellipse cx="320" cy="176" rx="215" ry="120" fill="none" stroke="${T.accent}" stroke-width="1.5" stroke-dasharray="8 10" opacity=".45"><animateTransform attributeName="transform" type="rotate" from="0 320 176" to="360 320 176" dur="26s" repeatCount="indefinite"/></ellipse>
  ${node(320, 42, "AI SYSTEMS", "agents · llms · rag", true, "0")}
  ${node(170, 154, "LLMs", "transformers · rag", false, ".4")}${node(320, 154, "AGENTS", "memory · tools", true, ".8")}${node(470, 154, "SYSTEMS", "rust · search", false, "1.2")}
  ${node(170, 232, L1, `${m.langs?.[L1] ?? "—"} repos · live`, false, "1.6")}${node(320, 232, L2, `${m.langs?.[L2] ?? "—"} repos · live`, true, "2")}${node(470, 232, L3, `${m.langs?.[L3] ?? "—"} repos · live`, false, "2.4")}
  ${node(320, 310, "FULL-STACK SYSTEMS", `${num(m.repos)} repos · live`, true, "2.8")}
  <text x="320" y="362" text-anchor="middle" font-family="${T.mono}" font-size="11" fill="${T.dim}">language mix is live repo data — not a skill claim</text>`;
  write(path.join(OUT_DIR, "skill-tree.svg"), wrap(W, H, body));
}

// ---------------- 4. mission-control (pulsing dots + growing bars) ----------------
{
  const cw = 300, ch = 196, gap = 14, cols = 3, pad = 16;
  const rowsN = Math.max(1, Math.ceil(missionRows.length / cols));
  const W = pad * 2 + cols * cw + (cols - 1) * gap;
  const H = pad * 2 + 34 + rowsN * ch + (rowsN - 1) * gap;
  let body = `<text x="${pad}" y="${pad + 12}" font-family="${T.mono}" font-size="13" fill="${T.dim}">🚀 MISSION CONTROL — ${missionRows.length} ACTIVE · STARS ARE LIVE · CLICK TABLE BELOW ↓</text>`;
  missionRows.forEach((ms, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = pad + col * (cw + gap), y = pad + 30 + row * (ch + gap);
    const stars = ms.liveStars ?? "·";
    const upd = ms.livePushed ? relDate(ms.livePushed, now) : "cached";
    const c = statusColor(ms.status);
    const filled = Math.round(((ms.progress || 0) / 100) * (cw - 32));
    body += `<g transform="translate(${x},${y})"><rect width="${cw}" height="${ch}" rx="12" fill="${T.panel}" stroke="${T.border}"/>
    <text x="16" y="26" font-family="${T.mono}" font-size="11" fill="${T.dim}">MISSION ${esc(ms.id)} · ★ ${stars} · ${esc(upd)}</text>
    <text x="16" y="52" font-family="${T.font}" font-size="17" font-weight="bold" fill="${T.text}">${esc(ms.name)}</text>
    <circle cx="${cw - 20}" cy="48" r="6" fill="${c}"><animate attributeName="opacity" values="1;.3;1" dur="2s" begin="${(i * 0.25).toFixed(2)}s" repeatCount="indefinite"/></circle>
    <text x="16" y="74" font-family="${T.mono}" font-size="11" fill="${c}">● ${esc(ms.status)}</text>
    <text x="16" y="92" font-family="${T.mono}" font-size="10" fill="${T.dim}">${esc(ms.type || "")}</text>
    <text x="16" y="112" font-family="${T.font}" font-size="11" fill="${T.dim}">${esc((ms.objective || "").slice(0, 62))}</text>
    <text x="16" y="128" font-family="${T.font}" font-size="11" fill="${T.dim}">${esc((ms.objective || "").slice(62, 120))}</text>
    <rect x="16" y="142" width="${cw - 32}" height="8" rx="4" fill="#17171f"/><rect x="16" y="142" width="${filled}" height="8" rx="4" fill="${c}"><animate attributeName="width" from="0" to="${filled}" dur="1.2s" begin="${(i * 0.1).toFixed(2)}s" fill="freeze"/></rect>
    <text x="16" y="168" font-family="${T.mono}" font-size="10" fill="${T.dim}">${esc(ms.stack || "")}</text>
    <text x="${cw - 16}" y="168" text-anchor="end" font-family="${T.mono}" font-size="11" fill="${T.text}">${ms.progress || 0}%</text></g>`;
  });
  write(path.join(OUT_DIR, "mission-control.svg"), wrap(W, H, body));
}

// ---------------- 5. contribution arcade (rotates weekly, real day data) ----------------
function seasonHead(sub) {
  return `<text x="28" y="36" font-family="${T.mono}" font-size="13" fill="${T.dim}">${season.icon} ${season.name} — ${esc(sub)}</text>
  <text x="612" y="36" text-anchor="end" font-family="${T.mono}" font-size="11" fill="${T.amber}">◉ SEASON ${seasonIdx + 1}/5</text>
  <text x="28" y="58" font-family="${T.mono}" font-size="12" fill="${T.text}">${num(calTotal)} CONTRIBUTIONS · ${num(calActive)} ACTIVE DAYS · NEXT: ${nextSeason.icon} ${nextSeason.name}</text>`;
}
function seasonFoot(y, hint) {
  return `<text x="28" y="${y}" font-family="${T.mono}" font-size="11" fill="${T.dim}">${esc(hint)} · SEASON ROTATES WEEKLY: 🚀 → 🐍 → 👾 → 🏎️ → 🌌 · EVERY PIXEL = REAL DATA</text>`;
}
function unavailableScene(label) {
  return wrap(640, 200, `<text x="28" y="60" font-family="${T.mono}" font-size="13" fill="${T.dim}">${label}</text><text x="28" y="100" font-family="${T.mono}" font-size="15" fill="${T.amber}">DATA TEMPORARILY UNAVAILABLE</text><text x="28" y="130" font-family="${T.mono}" font-size="12" fill="${T.dim}">LAST KNOWN STATE PENDING — CHECK BACK NEXT SYNC</text>`);
}

let arcadeSVG;
if (!calDays.length) {
  arcadeSVG = unavailableScene(`${season.icon} ${season.name}`);
} else if (season.id === "space") {
  const W = 640, H = 320;
  const fuel = Math.min(99, Math.max(8, Math.round((Math.log10(Math.max(10, calTotal)) / 5) * 100)));
  const segs = [
    ["LAUNCH", `${num(calActive)} active days`, Math.min(99, fuel + 20), T.green],
    ["ORBIT", `${num(calTotal)} contributions`, fuel, T.accent2],
    ["DEEP SPACE", "research frontier", Math.max(8, fuel - 20), T.accent],
    ["UNKNOWN", "next experiments", Math.max(8, fuel - 40), T.amber],
  ];
  let body = seasonHead(`FUEL = REAL COMMITS`);
  const tops = [...calDays].sort((a, b) => b.c - a.c).slice(0, 12);
  tops.forEach((d, i) => {
    const sx = 60 + ((i * 173) % 520), sy = 96 + ((i * 97) % 190);
    body += twinkle(sx, sy, 1.5 + Math.min(3, d.l), "#ffffff", i);
  });
  let y = 100;
  segs.forEach(([sname, sub, pct, c], i) => {
    body += `<text x="28" y="${y}" font-family="${T.mono}" font-size="13" fill="${T.text}">${sname}</text><text x="200" y="${y}" font-family="${T.mono}" font-size="11" fill="${T.dim}">${sub}</text>${growBar(28, y + 12, W - 56, pct, c, `${(i * 0.25).toFixed(2)}s`)}`;
    y += 50;
  }
  );
  body += `<g><polygon points="0,-11 20,7 6,4 3,14 -3,14 -6,4 -20,7" fill="${T.text}"/><circle cx="0" cy="-2" r="3.4" fill="${T.accent2}"/><polygon points="-3,14 0,24 3,14" fill="${T.amber}"><animate attributeName="opacity" values=".5;1;.5" dur=".35s" repeatCount="indefinite"/></polygon><animateMotion path="M 40,300 C 200,290 320,210 590,70" dur="9s" repeatCount="indefinite"/></g>`;
  body += seasonFoot(H - 14, "ROCKET = SHIPPING CADENCE");
  arcadeSVG = wrap(W, H, body);
} else if (season.id === "snake") {
  // last 20 weeks as grid; snake eats through every cell in order
  const W = 640, H = 360, cell = 22, gap = 4, step = cell + gap;
  const tail = calDays.slice(-140);
  const x0 = 70, y0 = 78;
  const pos = (k) => {
    const col = Math.floor(k / 7), row = k % 7;
    const rr = col % 2 === 0 ? row : 6 - row; // boustrophedon
    return [x0 + col * step + cell / 2, y0 + rr * step + cell / 2];
  };
  let body = seasonHead(`SCORE = ${num(calTotal)} REAL POINTS`);
  tail.forEach((d, k) => {
    const col = Math.floor(k / 7), row = k % 7;
    const rr = col % 2 === 0 ? row : 6 - row;
    const x = x0 + col * step, y = y0 + rr * step;
    body += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="5" fill="${LVL[Math.min(4, d.l)]}" opacity="${d.c ? 1 : 0.55}"/>`;
  });
  const top5 = tail.map((d, k) => ({ ...d, k })).filter((d) => d.c > 0).sort((a, b) => b.c - a.c).slice(0, 5);
  top5.forEach((d, i) => {
    const [ax, ay] = pos(d.k);
    body += `<circle cx="${ax}" cy="${ay}" r="6" fill="${T.red}"><animate attributeName="r" values="6;7.5;6" dur="1.2s" begin="${(i * 0.2).toFixed(1)}s" repeatCount="indefinite"/></circle>`;
  });
  const dPath = tail.map((_, k) => `${k ? "L" : "M"}${pos(k)[0]},${pos(k)[1]}`).join(" ");
  for (let s = 5; s >= 1; s--) {
    body += `<circle r="${11 - s}" fill="${T.green}" opacity="${0.25 + (5 - s) * 0.12}"><animateMotion path="${dPath}" dur="30s" begin="-${(s * 0.35).toFixed(2)}s" repeatCount="indefinite"/></circle>`;
  }
  body += `<g><circle r="11" fill="${T.green}" stroke="#052e16" stroke-width="2"/><circle cx="4" cy="-3" r="2.2" fill="#052e16"/><animateMotion path="${dPath}" dur="30s" repeatCount="indefinite"/></g>`;
  body += `<text x="28" y="316" font-family="${T.mono}" font-size="12" fill="${T.text}">SCORE ${num(calTotal)} · ${tail.filter((d) => d.c > 0).length}/140 CELLS EATEN · EAT = SHIP</text>`;
  body += seasonFoot(H - 14, "SNAKE FOLLOWS YOUR REAL 20-WEEK TRAIL");
  arcadeSVG = wrap(W, H, body);
} else if (season.id === "pacman") {
  // last 12 weeks: pellets on days you shipped
  const W = 640, H = 360, cell = 40, gapX = 8;
  const tail = calDays.slice(-84);
  const x0 = 80, y0 = 92;
  const px = (k) => x0 + (k % 12) * cell;
  const py = (k) => y0 + Math.floor(k / 12) * 34;
  let body = seasonHead(`PELLETS = REAL SHIPPED DAYS`);
  let pellets = 0;
  tail.forEach((d, k) => {
    if (d.c > 0) {
      pellets++;
      body += `<circle cx="${px(k)}" cy="${py(k)}" r="5" fill="${T.amber}"><animate attributeName="opacity" values="1;.4;1" dur="1.6s" begin="${(k % 10 * 0.16).toFixed(2)}s" repeatCount="indefinite"/></circle>`;
    } else {
      body += `<circle cx="${px(k)}" cy="${py(k)}" r="1.6" fill="${T.border}"/>`;
    }
  });
  const rows = [];
  for (let r = 0; r < 7; r++) {
    const idx = [];
    for (let c = 0; c < 12; c++) idx.push(r * 12 + c);
    if (r % 2) idx.reverse();
    rows.push(idx);
  }
  const order = rows.flat();
  const mPath = order.map((k, j) => `${j ? "L" : "M"}${px(k)},${py(k)}`).join(" ");
  body += `<g><circle r="12" fill="#facc15"/><polygon points="0,0 12,-8 12,8" fill="${T.bg}"><animateTransform attributeName="transform" type="rotate" values="-28 0 0;0 0 0;-28 0 0" dur=".38s" repeatCount="indefinite"/></polygon><animateMotion path="${mPath}" dur="22s" repeatCount="indefinite"/></g>`;
  body += `<g opacity=".92"><circle r="10" fill="${T.red}"/><rect x="-10" y="0" width="20" height="9" fill="${T.red}"/><circle cx="-3.5" cy="-2" r="2.4" fill="#fff"/><circle cx="3.5" cy="-2" r="2.4" fill="#fff"/><animateMotion path="${mPath}" dur="22s" begin="-6s" repeatCount="indefinite"/></g>`;
  body += `<text x="28" y="316" font-family="${T.mono}" font-size="12" fill="${T.text}">PELLETS ${pellets} EATEN / 84 · WAKA-WAKA = SHIPPING STREAK</text>`;
  body += seasonFoot(H - 14, "MAZE = YOUR LAST 12 WEEKS");
  arcadeSVG = wrap(W, H, body);
} else if (season.id === "racing") {
  // top repos by stars race; horsepower = live stars
  const W = 640, H = 360;
  const racers = [...(m.top || [])].slice(0, 6);
  const maxS = Math.max(1, ...racers.map((r) => r.stars));
  const palette = [T.green, T.accent2, T.accent, T.amber, T.blue, T.red];
  let body = seasonHead(`HORSEPOWER = LIVE STARS`);
  racers.forEach((r, i) => {
    const y = 96 + i * 38;
    const dist = 130 + Math.round((r.stars / maxS) * 360);
    const nm = r.name.length > 20 ? r.name.slice(0, 19) + "…" : r.name;
    body += `<text x="28" y="${y + 5}" font-family="${T.mono}" font-size="11" fill="${T.dim}">${esc(nm)}</text><text x="28" y="${y + 19}" font-family="${T.mono}" font-size="10" fill="${T.text}">★ ${r.stars}</text>`;
    body += `<line x1="170" y1="${y + 8}" x2="600" y2="${y + 8}" stroke="${T.border}" stroke-width="2" stroke-dasharray="10 8"/>`;
    body += `<g><rect x="0" y="-9" width="36" height="18" rx="6" fill="${palette[i % 6]}"/><rect x="6" y="-5" width="12" height="10" rx="2" fill="#050508" opacity=".7"/><text x="26" y="4" font-family="${T.mono}" font-size="10" font-weight="bold" fill="#050508">${i + 1}</text><animateTransform attributeName="transform" type="translate" from="170 ${y + 8}" to="${170 + dist} ${y + 8}" dur="${(3.2 + i * 0.45).toFixed(2)}s" repeatCount="indefinite"/></g>`;
  });
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 2; c++)
      body += `<rect x="${600 + c * 8}" y="${88 + r * 8}" width="8" height="8" fill="${(r + c) % 2 ? "#fff" : "#050508"}" stroke="#333"/>`;
  body += `<text x="28" y="336" font-family="${T.mono}" font-size="12" fill="${T.text}">🏁 STAR PRIX · LEADER: ${esc(racers[0]?.name || "—")} (${racers[0]?.stars ?? "—"}★)</text>`;
  body += seasonFoot(H - 14, "CARS LOOP FOREVER — LIKE THE GRIND");
  arcadeSVG = wrap(W, H, body);
} else {
  // galaxy — every active day a twinkling star
  const W = 640, H = 360;
  const weeks = Math.ceil(calDays.length / 7) || 1;
  const gx = (i) => 40 + (Math.floor(i / 7) / Math.max(1, weeks - 1)) * 560;
  const gy = (i, c) => 84 + weekday(calDays[i].d) * 34 + ((c * 13) % 14);
  let body = seasonHead(`EVERY STAR = A REAL SHIPPED DAY`);
  const active = calDays.map((d, i) => ({ ...d, i })).filter((d) => d.c > 0);
  active.forEach((d, k) => {
    const cols = ["#ffffff", T.accent2, T.accent, T.blue, T.amber];
    body += twinkle(gx(d.i), gy(d.i, d.c), 1.4 + Math.min(3.2, d.l * 1.1), cols[k % cols.length], k, 18);
  });
  const topStars = [...active].sort((a, b) => b.c - a.c).slice(0, 9);
  for (let k = 1; k < topStars.length; k++) {
    body += `<line x1="${gx(topStars[k - 1].i)}" y1="${gy(topStars[k - 1].i, topStars[k - 1].c)}" x2="${gx(topStars[k].i)}" y2="${gy(topStars[k].i, topStars[k].c)}" stroke="${T.accent}" stroke-width="1" opacity=".5"/>`;
  }
  body += `<line x1="0" y1="0" x2="70" y2="26" stroke="#fff" stroke-width="2" opacity=".8"><animateMotion path="M 560,40 L 80,300" dur="7s" begin="1s" repeatCount="indefinite"/></line>`;
  body += `<text x="28" y="336" font-family="${T.mono}" font-size="12" fill="${T.text}">🌌 GALAXY OF ${num(calTotal)} COMMITS · BRIGHTEST: ${topStars[0] ? `${monthDay(topStars[0].d)} (${num(topStars[0].c)})` : "—"}</text>`;
  body += seasonFoot(H - 14, "CONSTELLATION = YOUR TOP 9 GRIND DAYS");
  arcadeSVG = wrap(W, H, body);
}
write(path.join(OUT_DIR, "contribution-game.svg"), arcadeSVG);

// ---------------- 6. achievements (glow pulse on unlocked) ----------------
{
  const W = 640, per = 2, bw = (W - 48) / 2, bh = 44;
  const rowsN = Math.max(1, Math.ceil(achievementRules.length / per));
  const H = 56 + rowsN * (bh + 8) + 34;
  let body = `<text x="24" y="34" font-family="${T.mono}" font-size="13" fill="${T.dim}">🏆 ACHIEVEMENTS — UNLOCKED FROM LIVE DATA (${m.live ? "LIVE" : "CACHED"})</text>`;
  achievementRules.forEach((r, i) => {
    const ok = passRule(r.test);
    const x = 24 + (i % per) * (bw + 8), y = 48 + Math.floor(i / per) * (bh + 8);
    body += `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="9" fill="${T.panel}" stroke="${ok ? T.green : T.border}">${ok ? `<animate attributeName="stroke-opacity" values="1;.45;1" dur="2.6s" begin="${(i * 0.2).toFixed(1)}s" repeatCount="indefinite"/>` : ""}</rect><text x="${x + 14}" y="${y + 23}" font-family="${T.mono}" font-size="13" fill="${ok ? T.green : T.dim}">${ok ? "[✓]" : "[ ]"}</text><text x="${x + 48}" y="${y + 23}" font-family="${T.mono}" font-size="12" font-weight="bold" fill="${ok ? T.text : T.dim}">${esc(r.label)}</text>`;
  });
  body += `<text x="24" y="${H - 14}" font-family="${T.mono}" font-size="11" fill="${T.dim}">${unlocked}/${achievementRules.length} UNLOCKED · evaluated ${esc(syncLabel)}</text>`;
  write(path.join(OUT_DIR, "achievements.svg"), wrap(W, H, body));
}

// ---------------- 7. constellation (twinkle + orbiter) ----------------
{
  const W = 640, H = 330;
  const pts = [[320, 50], [150, 120], [490, 120], [210, 195], [430, 195], [320, 275]];
  const names = missions.slice(0, 6).map((ms) => `${ms.name} · ${(ms.type || "").split("/")[0].trim().toLowerCase()}`);
  let body = `<text x="28" y="36" font-family="${T.mono}" font-size="13" fill="${T.dim}">🌌 PROJECT CONSTELLATION — ONE ENGINEERING JOURNEY · NODES LINKED IN TABLE ↓</text>`;
  for (const [x, y] of pts) body += `<line x1="320" y1="165" x2="${x}" y2="${y}" stroke="${T.border}" stroke-width="1.5"/>`;
  pts.forEach(([x, y], i) => {
    body += twinkle(x, y, 5, T.accent, i, 6);
    body += `<text x="${x}" y="${y - 14}" text-anchor="middle" font-family="${T.mono}" font-size="11" fill="${T.text}">✦ ${esc(names[i] || "—")}</text>`;
  });
  body += `<circle r="4" fill="${T.amber}"><animateMotion path="M 90,165 a 230,110 0 1,0 460,0 a 230,110 0 1,0 -460,0" dur="14s" repeatCount="indefinite"/></circle>`;
  body += `<text x="320" y="${H - 22}" text-anchor="middle" font-family="${T.mono}" font-size="11" fill="${T.dim}">AI SYSTEMS → AGENTS → AUTOMATION → FULL-STACK → EXPERIMENTS</text>`;
  write(path.join(OUT_DIR, "constellation.svg"), wrap(W, H, body));
}

// ---------------- README regions ----------------
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
    `| Contributions (1y) | **${R(num(calTotal))}** | public contribution graph (parsed, no auth) |`,
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
  "season-note": () => m.unavailable || !calDays.length
    ? "Season data temporarily unavailable — showing last rendered season."
    : `**${season.icon} NOW PLAYING: ${season.name}** — fueled by **${num(calTotal)} real contributions** across **${num(calActive)} active days**. Season rotates automatically every week: 🚀 SPACE MISSION → 🐍 SNAKE RUN → 👾 PAC-MAN → 🏎️ CODE RACING → 🌌 GALAXY. Next up: **${nextSeason.icon} ${nextSeason.name}**. The game changes; the grind data never lies.`,
  level: () => {
    if (m.unavailable) return "```text\nBK // LEVEL —\n\nXP data temporarily unavailable.\n```";
    const filled = Math.round((xpPct / 100) * 22);
    return ["```text",
      `BK // LEVEL ${level}`, "",
      `XP  ${"█".repeat(filled)}${"░".repeat(22 - filled)}  ${xpPct}%  (${num(xp)} XP)`, "",
      `REPOS ×${num(m.repos)} ............ +20 XP each`,
      `STARS ×${num(m.stars)} ......... +2 XP each`,
      `FOLLOWERS ×${num(m.followers)} ....... +5 XP each`,
      `GRIND ×${num(calTotal)} .... +1 XP each`,
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
    : [`Top repositories by stars (live, ${syncDay}) — click any row to warp in:`, "",
      "| Repo | ★ | Lang | Last push |", "|---|---|---|---|",
      ...m.top.map((r) => `| [${r.name}](https://github.com/${USERNAME}/${r.name}) | ${r.stars} | ${r.lang || "—"} | ${monthDay(r.pushed)} |`)].join("\n"),
  footer: () => ["```", "────────────────────────────────────────",
    `BK.DEV SYSTEM · VERSION ${version}`,
    `LAST SYNCHRONIZED ${syncDay} UTC · SOURCE api.github.com/users/${USERNAME}`,
    "Built with: GitHub API · GitHub Actions · Node · SVG · SMIL",
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

console.log(`\nBK // OS done (${m.live ? "LIVE" : "CACHED"}): ${num(m.repos)} repos · ${num(m.stars)} stars · ${num(m.followers)} followers · ${num(calTotal)} contributions · ${season.icon} ${season.name}${Number.isFinite(level) ? ` · LVL ${level} ${xpPct}%` : ""}`);
