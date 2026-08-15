#!/usr/bin/env node
/**
 * Generates every "dashboard" SVG used in README.md:
 *   assets/generated/feature-stats.svg
 *   assets/generated/animated-stats.svg
 *   assets/generated/project-cards.svg
 *   assets/generated/live-status.svg
 *   assets/generated/skill-radar.svg
 *   assets/generated/coding-timeline.svg
 *
 * Runs in GitHub Actions (.github/workflows/dashboard.yml) with the
 * default GITHUB_TOKEN — no extra secrets needed. Can also run locally:
 *   GITHUB_TOKEN=ghp_xxx GH_USERNAME=vincenzo-afk node scripts/generate-dashboard.mjs
 * If no token is present it falls back to sample data so the script
 * (and the SVG layouts) can still be exercised/previewed offline.
 */
import fs from "node:fs";
import path from "node:path";

const USERNAME = process.env.GH_USERNAME || "vincenzo-afk";
const TOKEN = process.env.GITHUB_TOKEN || "";
const OUT_DIR = "assets/generated";
const DATA_DIR = "data";
const MOCK = !TOKEN;

// ---------- small utils ----------
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function readJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  console.log("wrote", p);
}

async function ghGraphQL(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function ghREST(pathname) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      Authorization: TOKEN ? `bearer ${TOKEN}` : undefined,
      Accept: "application/vnd.github+json",
      "User-Agent": "dashboard-generator",
    },
  });
  if (!res.ok) return null;
  return res.json();
}

// ---------- 1. fetch profile + contributions ----------
const now = new Date();
const oneYearAgo = new Date(now.getTime() - 365 * 24 * 3600 * 1000);

async function fetchLiveData() {
  if (MOCK) return mockData();

  const query = `
  query($login:String!, $from:DateTime!, $to:DateTime!) {
    user(login:$login) {
      name
      followers { totalCount }
      following { totalCount }
      repositories(first:100, ownerAffiliations: OWNER, privacy: PUBLIC, isFork: false) {
        totalCount
        nodes {
          name
          stargazerCount
          forkCount
          primaryLanguage { name }
          pushedAt
        }
      }
      contributionsCollection(from:$from, to:$to) {
        totalCommitContributions
        totalPullRequestContributions
        totalIssueContributions
        totalRepositoriesWithContributedCommits
        contributionCalendar {
          totalContributions
          weeks { contributionDays { date contributionCount weekday } }
        }
        commitContributionsByRepository(maxRepositories: 20) {
          repository { name }
          contributions { totalCount }
        }
      }
    }
  }`;

  const data = await ghGraphQL(query, {
    login: USERNAME,
    from: oneYearAgo.toISOString(),
    to: now.toISOString(),
  });
  return data.user;
}

function mockData() {
  // Offline preview fixture — only used when GITHUB_TOKEN isn't set.
  const days = [];
  for (let i = 0; i < 91; i++) {
    const d = new Date(now.getTime() - (90 - i) * 86400000);
    days.push({
      date: d.toISOString().slice(0, 10),
      contributionCount: Math.max(0, Math.round(Math.sin(i / 4) * 5 + 5 + (i % 7 === 0 ? -4 : 0))),
      weekday: d.getDay(),
    });
  }
  return {
    name: "Bharani Kumar S",
    followers: { totalCount: 28 },
    following: { totalCount: 13 },
    repositories: {
      totalCount: 55,
      nodes: [
        { name: "NEXUS-ENGINE", stargazerCount: 19, forkCount: 3, primaryLanguage: { name: "Rust" }, pushedAt: now.toISOString() },
        { name: "Zen-2", stargazerCount: 19, forkCount: 1, primaryLanguage: { name: "Python" }, pushedAt: now.toISOString() },
        { name: "AgentWeb", stargazerCount: 17, forkCount: 2, primaryLanguage: { name: "TypeScript" }, pushedAt: now.toISOString() },
        { name: "KingstonConnect", stargazerCount: 19, forkCount: 1, primaryLanguage: { name: "TypeScript" }, pushedAt: now.toISOString() },
        { name: "PORTFOLIO", stargazerCount: 21, forkCount: 4, primaryLanguage: { name: "CSS" }, pushedAt: now.toISOString() },
      ],
    },
    contributionsCollection: {
      totalCommitContributions: 1421,
      totalPullRequestContributions: 42,
      totalIssueContributions: 18,
      totalRepositoriesWithContributedCommits: 32,
      contributionCalendar: { totalContributions: 1481, weeks: [{ contributionDays: days }] },
      commitContributionsByRepository: [
        { repository: { name: "NOVA" }, contributions: { totalCount: 210 } },
      ],
    },
  };
}

const user = await fetchLiveData();

// ---------- 2. derive core numbers ----------
const repos = user.repositories.nodes;
const totalRepos = user.repositories.totalCount;
const totalStars = repos.reduce((s, r) => s + (r.stargazerCount || 0), 0);
const followers = user.followers.totalCount;
const totalCommitsThisYear = user.contributionsCollection.totalCommitContributions;

const calendarDays = user.contributionsCollection.contributionCalendar.weeks.flatMap(
  (w) => w.contributionDays
);

// current streak (consecutive days with contributions, ending today/yesterday)
function currentStreak(days) {
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].contributionCount > 0) streak++;
    else if (i === days.length - 1) continue; // today may still be 0
    else break;
  }
  return streak;
}
const streak = currentStreak(calendarDays);

// busiest month (by contribution count) in the fetched window
function busiestMonth(days) {
  const byMonth = {};
  for (const d of days) {
    const m = d.date.slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + d.contributionCount;
  }
  const entries = Object.entries(byMonth).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return "—";
  const [ym] = entries[0];
  const [y, m] = ym.split("-");
  const label = new Date(Number(y), Number(m) - 1, 1).toLocaleString("en-US", { month: "long" });
  return `${label} ${y}`;
}

// commits today / this week
const todayStr = now.toISOString().slice(0, 10);
const commitsToday = (calendarDays.find((d) => d.date === todayStr) || {}).contributionCount || 0;
const last7 = calendarDays.slice(-7);
const commitsThisWeek = last7.reduce((s, d) => s + d.contributionCount, 0);

// most active repo (by commit contributions)
const byRepo = user.contributionsCollection.commitContributionsByRepository || [];
const activeRepo = byRepo.length
  ? byRepo.reduce((a, b) => (b.contributions.totalCount > a.contributions.totalCount ? b : a)).repository.name
  : "—";

// language mix (by repo count, primaryLanguage)
const langCounts = {};
for (const r of repos) {
  const l = r.primaryLanguage?.name;
  if (l) langCounts[l] = (langCounts[l] || 0) + 1;
}

// ---------- 3. delta tracking (real "this month" deltas) ----------
const prevPath = path.join(DATA_DIR, "prev_stats.json");
const prev = readJSON(prevPath, null);
const monthKey = now.toISOString().slice(0, 7);
let baseline = prev && prev.monthKey === monthKey ? prev : null;
if (!baseline) {
  baseline = {
    monthKey,
    commits: totalCommitsThisYear,
    repos: totalRepos,
    stars: totalStars,
    followers,
  };
}
const deltas = {
  commits: totalCommitsThisYear - baseline.commits,
  repos: totalRepos - baseline.repos,
  stars: totalStars - baseline.stars,
  followers: followers - baseline.followers,
};
writeFile(
  prevPath,
  JSON.stringify(
    { monthKey, commits: totalCommitsThisYear, repos: totalRepos, stars: totalStars, followers },
    null,
    2
  )
);

// ---------- SVG theme ----------
const THEME = {
  bg: "#0d1117",
  panel: "#111826",
  border: "#1f2937",
  accent: "#00E0FF",
  accent2: "#58A6FF",
  pink: "#ff7b72",
  text: "#c9d1d9",
  dim: "#8b949e",
  green: "#7ee787",
  font: "'Segoe UI', Helvetica, Arial, sans-serif",
};

function svgWrap(width, height, body, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="glow" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${THEME.accent}"/>
      <stop offset="100%" stop-color="${THEME.accent2}"/>
    </linearGradient>
    <style>
      .card-bg { fill: ${THEME.panel}; stroke: ${THEME.border}; stroke-width: 1; }
      .title { fill: ${THEME.text}; font-family: ${THEME.font}; font-weight: 700; }
      .dim { fill: ${THEME.dim}; font-family: ${THEME.font}; }
      .accent { fill: ${THEME.accent}; font-family: ${THEME.font}; font-weight: 700; }
      .num { font-family: ${THEME.font}; font-weight: 800; }
      text { dominant-baseline: middle; }
    </style>
  </defs>
  <rect width="${width}" height="${height}" fill="${THEME.bg}"/>
  ${title ? `<text x="18" y="26" class="title" font-size="15">${esc(title)}</text>` : ""}
  ${body}
</svg>`;
}

// ---------- 4. feature-stats.svg ----------
function buildFeatureStats() {
  const meta = readJSON(path.join(DATA_DIR, "feature_stats.json"), {});
  const cards = [
    ["Projects Built", meta.projects_built ?? "—"],
    ["Repositories", String(totalRepos)],
    ["Years Coding", meta.years_coding ?? "—"],
    ["AI Projects", meta.ai_projects ?? "—"],
    ["Languages", meta.languages ?? String(Object.keys(langCounts).length)],
    ["Hackathons", meta.hackathons ?? "—"],
    ["Certificates", meta.certificates ?? "—"],
    ["Models Built", meta.models_built ?? "—"],
    ["APIs Integrated", meta.apis_integrated ?? "—"],
    ["Stars Earned", String(totalStars)],
  ];
  const cols = 5;
  const cw = 190, ch = 92, gap = 12, padX = 12, padY = 12;
  const rows = Math.ceil(cards.length / cols);
  const width = padX * 2 + cols * cw + (cols - 1) * gap;
  const height = padY * 2 + rows * ch + (rows - 1) * gap;

  let body = "";
  cards.forEach(([label, value], i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = padX + col * (cw + gap), y = padY + row * (ch + gap);
    body += `
    <g transform="translate(${x},${y})">
      <rect class="card-bg" width="${cw}" height="${ch}" rx="10"/>
      <rect x="0" y="0" width="4" height="${ch}" rx="2" fill="url(#glow)"/>
      <text x="18" y="34" class="num accent" font-size="26">${esc(value)}</text>
      <text x="18" y="64" class="dim" font-size="12">${esc(label)}</text>
    </g>`;
  });
  writeFile(path.join(OUT_DIR, "feature-stats.svg"), svgWrap(width, height, body));
}

// ---------- 5. animated-stats.svg (with real month-over-month deltas) ----------
function buildAnimatedStats() {
  const items = [
    ["Total Commits (1y)", totalCommitsThisYear, deltas.commits],
    ["Repositories", totalRepos, deltas.repos],
    ["Stars Earned", totalStars, deltas.stars],
    ["Followers", followers, deltas.followers],
  ];
  const cw = 230, ch = 96, gap = 14, pad = 14;
  const width = pad * 2 + items.length * cw + (items.length - 1) * gap;
  const height = pad * 2 + ch;
  let body = "";
  items.forEach(([label, value, delta], i) => {
    const x = pad + i * (cw + gap), y = pad;
    const deltaStr = delta === 0 ? "no change this month" : `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)} this month`;
    const deltaColor = delta > 0 ? THEME.green : delta < 0 ? THEME.pink : THEME.dim;
    body += `
    <g transform="translate(${x},${y})">
      <rect class="card-bg" width="${cw}" height="${ch}" rx="12"/>
      <text x="20" y="38" class="num" font-size="30" fill="${THEME.accent}">
        ${value.toLocaleString()}
        <animate attributeName="opacity" values="0;1" dur="0.6s" begin="0s" fill="freeze"/>
      </text>
      <text x="20" y="64" class="dim" font-size="13">${esc(label)}</text>
      <text x="20" y="84" font-family="${THEME.font}" font-size="11" fill="${deltaColor}">${esc(deltaStr)}</text>
    </g>`;
  });
  writeFile(path.join(OUT_DIR, "animated-stats.svg"), svgWrap(width, height, body));
}

// ---------- 6. project-cards.svg (Steam-style dashboard cards) ----------
async function statusOf(repo) {
  if (!repo || MOCK) return null;
  const [owner, name] = repo.split("/");
  const r = await ghREST(`/repos/${owner}/${name}`);
  if (!r || r.message) return null;
  return {
    stars: r.stargazers_count,
    lastUpdate: r.pushed_at,
    openIssues: r.open_issues_count,
  };
}

function relativeDate(iso) {
  if (!iso) return "—";
  const diffMs = now.getTime() - new Date(iso).getTime();
  const days = Math.floor(diffMs / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return `${months} mo ago`;
}

async function buildProjectCards() {
  const cfg = readJSON(path.join(DATA_DIR, "projects.json"), { flagship: [], major: [], new_builds: [] });
  const groups = [
    { title: "FLAGSHIP SYSTEMS", items: cfg.flagship || [] },
    { title: "MAJOR LIVE PROJECTS", items: cfg.major || [] },
    { title: "FRESH BUILDS", items: cfg.new_builds || [] },
  ];
  const projects = groups.flatMap(g => g.items);
  if (projects.length === 0) { writeFile(path.join(OUT_DIR, "project-cards.svg", ""), ""); return; }

  const cw = 320, ch = 172, gap = 16, cols = 3, pad = 16;
  const rows = Math.ceil(projects.length / cols);
  const width = pad * 2 + cols * cw + (cols - 1) * gap;
  const height = pad * 2 + rows * ch + (rows - 1) * gap;

  let body = "";
  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    const live = await statusOf(p.repo);
    const stars = live?.stars ?? p.fallback_stars ?? 0;
    const lastUpdate = relativeDate(live?.lastUpdate);
    const progress = p.progress ?? 0;
    const statusColor = p.status === "Live" ? THEME.green : p.status === "Prototype" ? THEME.accent2 : THEME.pink;

    const col = i % cols, row = Math.floor(i / cols);
    const x = pad + col * (cw + gap), y = pad + row * (ch + gap);
    const barW = cw - 40;
    const filled = Math.round((progress / 100) * barW);

    body += `
    <g transform="translate(${x},${y})">
      <rect class="card-bg" width="${cw}" height="${ch}" rx="12"/>
      <rect x="0" y="0" width="${cw}" height="34" rx="12" fill="#0b1220"/>
      <rect x="0" y="22" width="${cw}" height="12" fill="#0b1220"/>
      <text x="16" y="18" class="title" font-size="15">${esc(p.name)}</text>
      <circle cx="${cw - 18}" cy="17" r="5" fill="${statusColor}"/>

      <rect x="20" y="48" width="${barW}" height="10" rx="5" fill="#1c2333"/>
      <rect x="20" y="48" width="${filled}" height="10" rx="5" fill="url(#glow)"/>
      <text x="${cw - 20}" y="70" text-anchor="end" class="dim" font-size="11">${progress}%</text>

      <text x="20" y="96" class="dim" font-size="11">Language</text>
      <text x="20" y="112" class="accent" font-size="12">${esc(p.language || "—")}</text>

      <text x="${cw / 2 + 10}" y="96" class="dim" font-size="11">Status</text>
      <text x="${cw / 2 + 10}" y="112" font-family="${THEME.font}" font-size="12" fill="${statusColor}">${esc(p.status)}</text>

      <text x="20" y="136" class="dim" font-size="11">Modules</text>
      <text x="20" y="152" class="title" font-size="12">${p.modules ?? "—"}</text>

      <text x="${cw / 2 + 10}" y="136" class="dim" font-size="11">Stars</text>
      <text x="${cw / 2 + 10}" y="152" class="title" font-size="12">★ ${stars}</text>

      <text x="${cw - 20}" y="152" text-anchor="end" class="dim" font-size="10">Updated ${esc(lastUpdate)}</text>
    </g>`;
  }
  writeFile(path.join(OUT_DIR, "project-cards.svg"), svgWrap(width, height, body));
}

// ---------- 7. live-status.svg ----------
function buildLiveStatus() {
  const s = readJSON(path.join(DATA_DIR, "live_status.json"), {
    project: "—", emoji: "🟢", progress: 0, current_module: "—", eta_days: 0, status_label: "In Progress",
  });
  const width = 700, height = 180;
  const barW = width - 68;
  const filled = Math.round((s.progress / 100) * barW);
  const body = `
    <rect class="card-bg" x="10" y="10" width="${width - 20}" height="${height - 20}" rx="14"/>
    <text x="34" y="40" font-family="${THEME.font}" font-weight="800" font-size="14" fill="${THEME.green}">🟢 NOW BUILDING</text>
    <text x="34" y="68" class="title" font-size="22">${esc(s.emoji || "")} ${esc(s.project)}</text>
    <text x="34" y="90" class="dim" font-size="12">${esc(s.status_label)}</text>

    <rect x="34" y="104" width="${barW}" height="14" rx="7" fill="#1c2333"/>
    <rect x="34" y="104" width="${filled}" height="14" rx="7" fill="url(#glow)"/>
    <text x="34" y="136" class="dim" font-size="11">Progress</text>
    <text x="${width - 34}" y="136" text-anchor="end" class="accent" font-size="12">${s.progress}%</text>

    <text x="34" y="160" class="dim" font-size="11">Current Module:</text>
    <text x="150" y="160" class="title" font-size="12">${esc(s.current_module)}</text>
    <text x="${width - 100}" y="160" class="dim" font-size="11">ETA:</text>
    <text x="${width - 70}" y="160" class="accent" font-size="12">${s.eta_days} days</text>
  `;
  writeFile(path.join(OUT_DIR, "live-status.svg"), svgWrap(width, height, body));
}

// ---------- 8. skill-radar.svg ----------
function buildSkillRadar() {
  const manual = readJSON(path.join(DATA_DIR, "skills.json"), { ai_ml: 80, devops: 65, systems: 70 });
  const maxLangCount = Math.max(1, ...Object.values(langCounts));
  const pct = (name) => Math.round(((langCounts[name] || 0) / maxLangCount) * 100);

  const axes = [
    ["Python", Math.max(pct("Python"), 60)],
    ["Rust", Math.max(pct("Rust"), 40)],
    ["TS / JS", Math.max(pct("TypeScript"), pct("JavaScript"), 55)],
    ["AI / ML", manual.ai_ml],
    ["DevOps", manual.devops],
    ["Systems", manual.systems],
  ];

  const size = 420, cx = size / 2, cy = size / 2 + 10, R = 140;
  const n = axes.length;
  const angle = (i) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const pt = (i, r) => [cx + r * Math.cos(angle(i)), cy + r * Math.sin(angle(i))];

  let rings = "";
  for (let ring = 1; ring <= 4; ring++) {
    const r = (R * ring) / 4;
    const points = axes.map((_, i) => pt(i, r).join(",")).join(" ");
    rings += `<polygon points="${points}" fill="none" stroke="${THEME.border}" stroke-width="1"/>`;
  }
  let spokes = "";
  let labels = "";
  axes.forEach((_, i) => {
    const [x, y] = pt(i, R);
    spokes += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="${THEME.border}" stroke-width="1"/>`;
  });
  axes.forEach(([label], i) => {
    const [x, y] = pt(i, R + 26);
    const anchor = Math.abs(x - cx) < 4 ? "middle" : x > cx ? "start" : "end";
    labels += `<text x="${x}" y="${y}" text-anchor="${anchor}" class="dim" font-size="12">${esc(label)}</text>`;
  });
  const dataPoints = axes.map(([, val], i) => pt(i, (R * Math.min(val, 100)) / 100).join(",")).join(" ");
  const shape = `<polygon points="${dataPoints}" fill="${THEME.accent}" fill-opacity="0.25" stroke="url(#glow)" stroke-width="2"/>`;
  const dots = axes
    .map(([, val], i) => {
      const [x, y] = pt(i, (R * Math.min(val, 100)) / 100);
      return `<circle cx="${x}" cy="${y}" r="3.5" fill="${THEME.accent}"/>`;
    })
    .join("");

  const body = `${rings}${spokes}${shape}${dots}${labels}`;
  writeFile(path.join(OUT_DIR, "skill-radar.svg"), svgWrap(size, size + 10, body, "🎯 Skill Radar"));
}

// ---------- 9. top-repos.svg (top repositories by stars, live data) ----------
function buildTopRepos() {
  const top = [...repos].sort((a, b) => b.stargazerCount - a.stargazerCount).slice(0, 8);
  const cw = 420, ch = 44, gap = 10, pad = 16;
  const width = pad * 2 + cw;
  const height = pad * 2 + top.length * (ch + gap) - gap;

  let body = "";
  top.forEach((r, i) => {
    const y = pad + i * (ch + gap);
    const pct = top[0].stargazerCount > 0 ? (r.stargazerCount / top[0].stargazerCount) * 100 : 0;
    const barW = 160;
    const filled = Math.round((pct / 100) * barW);
    const name = r.name.length > 26 ? r.name.slice(0, 25) + "…" : r.name;
    const lang = r.primaryLanguage?.name ?? "—";
    const forks = r.forkCount ?? 0;
    const stars = r.stargazerCount ?? 0;
    const updated = relativeDate(r.pushedAt);
    body += `
    <g transform="translate(${pad},${y})">
      <rect class="card-bg" width="${cw}" height="${ch}" rx="8"/>
      <rect x="0" y="0" width="4" height="${ch}" rx="2" fill="url(#glow)"/>
      <text x="16" y="22" class="title" font-size="13">${esc(name)}</text>
      <text x="${cw - 34}" y="22" text-anchor="end" class="accent" font-size="12">★ ${stars} · forks ${forks}</text>
      <rect x="16" y="30" width="${barW}" height="5" rx="2.5" fill="#1c2333"/>
      <rect x="16" y="30" width="${filled}" height="5" rx="2.5" fill="url(#glow)"/>
      <text x="${16 + barW + 8}" y="34" class="dim" font-size="10">${esc(lang)} · ${esc(updated)}</text>
    </g>`;
  });
  writeFile(path.join(OUT_DIR, "top-repos.svg"), svgWrap(width, height, body, "⭐ Top Repositories by Stars"));
}

// ---------- 10. coding-timeline.svg (last 7 days, real data) ----------
function buildCodingTimeline() {
  const days = calendarDays.slice(-7);
  const width = 700, height = 250;
  const pad = 40, chartW = width - pad * 2, chartH = 130;
  const max = Math.max(1, ...days.map((d) => d.contributionCount));
  const barGap = 18;
  const barW = (chartW - barGap * (days.length - 1)) / days.length;

  let bars = "";
  days.forEach((d, i) => {
    const h = Math.round((d.contributionCount / max) * chartH);
    const x = pad + i * (barW + barGap);
    const y = pad + 20 + (chartH - h);
    const dow = new Date(d.date + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "short" });
    bars += `
      <rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="6" fill="url(#glow)"/>
      <text x="${x + barW / 2}" y="${pad + 20 + chartH + 20}" text-anchor="middle" class="dim" font-size="12">${dow}</text>
      <text x="${x + barW / 2}" y="${y - 8}" text-anchor="middle" class="accent" font-size="12">${d.contributionCount}</text>
    `;
  });
  const summary = `<text x="${pad}" y="${height - 16}" class="dim" font-size="12">Today: ${commitsToday} · This week: ${commitsThisWeek} · Streak: ${streak} day${streak === 1 ? "" : "s"} · Busiest month: ${esc(busiestMonth(calendarDays))} · Most active repo: ${esc(activeRepo)}</text>`;
  writeFile(path.join(OUT_DIR, "coding-timeline.svg"), svgWrap(width, height, bars + summary, "💻 Coding Activity — Last 7 Days"));
}

// ---------- run ----------
await buildFeatureStats();
buildAnimatedStats();
await buildProjectCards();
buildLiveStatus();
buildSkillRadar();
await buildTopRepos();
buildCodingTimeline();

console.log(MOCK ? "\nDone (mock data — set GITHUB_TOKEN for live data)." : "\nDone (live GitHub data).");
