// Local strata server: static files + POST /api/analyze (point-at-a-PR) with
// GET /api/progress for live stage updates + POST /api/export (review push).
//   node scripts/serve.mjs   → http://localhost:4517

import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzePR, parsePrUrl } from "./analyze.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 4517);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".map": "application/json"
};

let job = null; // the current analysis: { stage, lines, done, error, result }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://local");

  // start an analysis job; progress is polled via /api/progress
  if (req.method === "POST" && u.pathname === "/api/analyze") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let url = "";
    try { url = String(JSON.parse(body).url || ""); } catch { /* handled below */ }
    try {
      if (job && !job.done) throw new Error("another PR is currently being analyzed — try again in a moment");
      parsePrUrl(url); // fail fast on a malformed url before starting the job
      job = { stage: "starting", lines: [], done: false, error: null, result: null };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      analyzePR(url, (stage) => {
        job.stage = stage;
        job.lines.push(stage);
        if (job.lines.length > 200) job.lines.shift();
      })
        .then((out) => { job.result = out; job.done = true; })
        .catch((e) => { job.error = String(e?.message ?? e); job.done = true; });
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
    return;
  }

  if (req.method === "GET" && u.pathname === "/api/progress") {
    if (!job) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ running: false, done: true }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      running: !job.done,
      done: job.done,
      stage: job.stage,
      lines: job.lines.slice(-6),
      error: job.error,
      result: job.result
    }));
    return;
  }

  // push review threads back to GitHub as one review
  if (req.method === "POST" && u.pathname === "/api/export") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const { pr, event = "COMMENT", comments = [], head } = JSON.parse(body);
      let token = process.env.GITHUB_TOKEN || "";
      if (!token) {
        try { token = (await fs.readFile(path.join(ROOT, "github.token"), "utf8")).trim(); } catch { /* no token file */ }
      }
      if (!token) throw new Error("export needs a GitHub token — set GITHUB_TOKEN or create github.token");
      const page = JSON.parse(await fs.readFile(path.join(ROOT, "data", `${pr}.json`), "utf8"));
      const [owner, repo] = String(page.pr.repo).split("/");
      const num = String(page.pr.number).replace("#", "");
      const gh = {
        "User-Agent": "strata",
        "Authorization": `token ${token}`,
        "Accept": "application/vnd.github+json"
      };

      // dedup: every export stamps the thread ids it pushed into the review body
      const listUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${num}/reviews?per_page=100`;
      const existing = await fetch(listUrl, { headers: gh }).then((r) => (r.ok ? r.json() : []));
      const exported = new Set();
      for (const rv of Array.isArray(existing) ? existing : []) {
        const m = String(rv.body ?? "").match(/strata-threads:([^\n>]*)/);
        if (m) for (const id of m[1].split(",")) if (id.trim()) exported.add(id.trim());
      }
      const fresh = comments.filter((c) => !exported.has(String(c.id)));
      if (!fresh.length) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ exported: 0, message: "all selected threads were already exported" }));
        return;
      }

      const reviewUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${num}/reviews`;
      const out = await fetch(reviewUrl, {
        method: "POST",
        headers: { ...gh, "Content-Type": "application/json" },
        body: JSON.stringify({
          commit_id: head || undefined,
          event,
          body: `exported from strata\n<!-- strata-threads: ${fresh.map((c) => c.id).join(",")} -->`,
          comments: fresh.map((c) => ({ path: c.path, side: "RIGHT", line: c.line, body: c.body }))
        })
      }).then((r) => r.json());
      if (out.errors || out.message === "Not Found") {
        throw new Error(`GitHub: ${out.message ?? "review rejected"}${out.errors ? ` (${JSON.stringify(out.errors[0])})` : ""}`);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ exported: fresh.length }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
    return;
  }

  // which PR did we analyze most recently? (landing default)
  if (u.pathname === "/api/latest") {
    try {
      const files = await fs.readdir(path.join(ROOT, "data"));
      const stats = await Promise.all(
        files.filter((f) => f.endsWith(".json") && !f.endsWith(".comments.json")).map(async (f) => ({ f, m: (await fs.stat(path.join(ROOT, "data", f))).mtimeMs }))
      );
      stats.sort((a, b) => b.m - a.m);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ pr: stats[0]?.f.replace(/\.json$/, "") ?? "sample" }));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ pr: "sample" }));
    }
    return;
  }

  let p = path.join(ROOT, decodeURIComponent(u.pathname));
  if (u.pathname === "/") p = path.join(ROOT, "index.html");
  if (!p.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await fs.readFile(p);
    res.writeHead(200, { "Content-Type": mime[path.extname(p)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

server.requestTimeout = 0; // analyses are long; progress streams via /api/progress
server.listen(PORT, () => console.log(`[strata] serving ${ROOT} on http://localhost:${PORT}`));
