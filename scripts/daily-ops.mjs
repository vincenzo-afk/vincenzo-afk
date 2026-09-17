#!/usr/bin/env node
/**
 * BK // DAILY OPS — real work, real commits.
 * ------------------------------------------
 * Performs genuine daily maintenance and commits the results:
 *   1. HTTP health check of the portfolio/blog URL (real network request).
 *   2. GitHub API status check of every mission repo (exists? stars?
 *      last push? open issues?) — catches renames, deletions, transfers.
 *   3. Writes data/ops-report.json + refreshes the <!-- OS:ops --> README
 *      region with the outcome (green or red — whatever is true).
 *
 * No empty commits: if nothing changed, the workflow commits nothing.
 * Nothing is backdated or fabricated; the report timestamp is the actual
 * run time.
 *
 *   node scripts/daily-ops.mjs
 */
import fs from "node:fs";
import path from "node:path";

const USERNAME = process.env.GH_USERNAME || "vincenzo-afk";
const TOKEN = process.env.GITHUB_TOKEN || "";
const DATA_DIR = "data";
const README_PATH = "README.md";
const TIMEOUT_MS = 15000;

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

async function timedFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return { ok: res.ok, status: res.status, ms: Date.now() - start };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - start, error: String(e.cause || e).slice(0, 100) };
  } finally {
    clearTimeout(t);
  }
}

const now = new Date();
const profile = readJSON(path.join(DATA_DIR, "profile.json"), {});
const missions = readJSON(path.join(DATA_DIR, "projects.json"), { missions: [] }).missions || [];

// 1. blog / portfolio check (real HTTP request)
const blogUrl = profile.profile?.blog || "";
const blog = blogUrl
  ? { url: blogUrl, ...(await timedFetch(blogUrl, { method: "HEAD" })) }
  : { url: "", ok: false, status: 0, error: "no URL configured" };

// 2. mission repo checks (real API reads — paced + retried so unauthenticated
// runs don't trip secondary rate limits; CI always has GITHUB_TOKEN anyway)
const apiHeaders = {
  ...(TOKEN ? { Authorization: `bearer ${TOKEN}` } : {}),
  Accept: "application/vnd.github+json",
  "User-Agent": "bk-daily-ops",
};
async function checkRepo(full) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const start = Date.now();
    try {
      const res = await fetch(`https://api.github.com/repos/${full}`, {
        headers: apiHeaders,
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if ((res.status === 403 || res.status === 429) && attempt < 3) {
        await sleep(3000 * attempt);
        continue;
      }
      const ms = Date.now() - start;
      if (!res.ok) return { ok: false, http: res.status, ms, rateLimited: res.status === 403 || res.status === 429 };
      const d = await res.json();
      if (d.message) return { ok: false, http: res.status, ms, rateLimited: false };
      return {
        ok: true, http: 200, ms,
        stars: d.stargazers_count ?? null,
        lastPush: d.pushed_at?.slice(0, 10) ?? null,
        openIssues: d.open_issues_count ?? null,
        archived: d.archived ?? null,
      };
    } catch (e) {
      clearTimeout(t);
      if (attempt < 3) {
        await sleep(2000 * attempt);
        continue;
      }
      return { ok: false, http: 0, ms: Date.now() - start, error: String(e.cause || e).slice(0, 100) };
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const missionResults = [];
for (const ms of missions) {
  const r = await checkRepo(ms.repo);
  missionResults.push({
    mission: ms.name,
    repo: ms.repo,
    ok: r.ok,
    http: r.http,
    stars: r.stars ?? null,
    lastPush: r.lastPush ?? null,
    openIssues: r.openIssues ?? null,
    archived: r.archived ?? null,
    ms: r.ms,
    note: !r.ok && r.rateLimited ? "rate-limited; will recheck next run" : (r.error || null),
  });
  await sleep(TOKEN ? 200 : 1200); // pace unauthenticated calls
}

const failed = missionResults.filter((x) => !x.ok);
const deferred = failed.filter((x) => x.note && x.note.startsWith("rate-limited"));
const down = failed.filter((x) => !(x.note && x.note.startsWith("rate-limited")));
const report = {
  checkedAt: now.toISOString(),
  day: now.toISOString().slice(0, 10),
  blog: { url: blog.url, ok: blog.ok, http: blog.status, ms: blog.ms, error: blog.error || null },
  summary: {
    missions: missionResults.length,
    ok: missionResults.length - failed.length,
    failed: failed.length,
    blogOk: blog.ok,
  },
  missions: missionResults,
};
write(path.join(DATA_DIR, "ops-report.json"), JSON.stringify(report, null, 2));

// 3. README region (honest: green, red, or "deferred" — whatever is true)
const allGreen = blog.ok && down.length === 0 && deferred.length === 0;
const verdict = down.length || !blog.ok
  ? "● ATTENTION — SEE FAILURES ABOVE"
  : deferred.length
    ? "● CHECKS DEFERRED (RATE-LIMITED) — RETRY NEXT RUN"
    : "● ALL SYSTEMS NOMINAL";
const lines = [
  `LAST OPS CHECK .... ${report.day} UTC`,
  `PORTFOLIO ......... ${blog.ok ? `● ONLINE (HTTP ${blog.status}, ${blog.ms}ms)` : `● OFFLINE (HTTP ${blog.status || "ERR"})`}`,
  `MISSIONS .......... ${report.summary.ok}/${report.summary.missions} reachable via API`,
  ...down.map((f) => `  ✗ ${f.mission} (${f.repo}) → HTTP ${f.http}`),
  ...deferred.map((f) => `  … ${f.mission} (${f.repo}) → deferred (rate-limited)`),
  `VERDICT ........... ${verdict}`,
];
{
  const block = `<!-- OS:ops -->\n\`\`\`text\n${lines.join("\n")}\n\`\`\`\n<!-- /OS:ops -->`;
  let readme = fs.readFileSync(README_PATH, "utf8");
  const re = /<!-- OS:ops -->[\s\S]*?<!-- \/OS:ops -->/m;
  if (!re.test(readme)) {
    console.warn("marker OS:ops missing in README — skipped");
  } else {
    readme = readme.replace(re, () => block);
    write(README_PATH, readme);
  }
}

console.log(`\nOPS done: blog ${blog.ok ? "UP" : "DOWN"} · missions ${report.summary.ok}/${report.summary.missions} ok`);
if (!allGreen) console.log("note: failures recorded honestly in data/ops-report.json");
