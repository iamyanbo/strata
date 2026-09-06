// Point Strata at any GitHub PR: shallow-fetch exactly the merge commit's
// window (no full clone), run the pipeline, emit viewer JSON.
//
//   node scripts/analyze.mjs https://github.com/owner/repo/pull/123
//   — or import { analyzePR } and pass an onProgress callback.

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parsePrUrl(u) {
  const m =
    u.match(/github\.com\/([^/\s]+)\/([^/\s#]+)\/pull\/(\d+)/i) ||
    u.match(/^\s*([^/\s]+)\/([^/\s#]+)#(\d+)\s*$/);
  if (!m) throw new Error(`not a GitHub PR url: ${u}`);
  return { owner: m[1], repo: m[2].replace(/\.git$/, ""), num: m[3] };
}

function git(repoDir, args) {
  return execFileSync("git", ["-C", repoDir, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 64
  }).toString();
}

/** GITHUB_TOKEN (or github.token file) raises the API rate limit for reads */
function ghHeaders() {
  if (ghHeaders.token === undefined) {
    ghHeaders.token = process.env.GITHUB_TOKEN || "";
    if (!ghHeaders.token) {
      try { ghHeaders.token = fs.readFileSync(path.join(ROOT, "github.token"), "utf8").trim(); } catch { /* no token file */ }
    }
  }
  return { "User-Agent": "strata", ...(ghHeaders.token ? { Authorization: `token ${ghHeaders.token}` } : {}) };
}

/** run the pipeline as a child process, streaming its output lines to onProgress */
function runPipeline(args, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(ROOT, "dist", "pipeline", "run.js"), ...args], { cwd: ROOT });
    let stderr = "";
    child.stdout.on("data", (d) => {
      for (const line of d.toString().split("\n")) {
        const t = line.trim();
        if (t && onProgress) onProgress(t);
      }
    });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pipeline exited ${code}: ${stderr.trim().slice(-400)}`));
    });
  });
}

export async function analyzePR(url, onProgress) {
  const say = (s) => { if (onProgress) onProgress(s); };
  const { owner, repo, num } = parsePrUrl(url);
  const slug = `${owner}-${repo}`;
  const dataName = `pr-${slug}-${num}`;
  const outJson = path.join(ROOT, "data", `${dataName}.json`);
  const repoDir = path.join(ROOT, "repos", slug);
  say(`reading ${owner}/${repo}#${num} metadata`);

  const api = `https://api.github.com/repos/${owner}/${repo}/pulls/${num}`;
  const meta = await fetch(api, { headers: ghHeaders() }).then((r) => {
    if (!r.ok) throw new Error(`GitHub API ${r.status} for ${owner}/${repo}#${num}`);
    return r.json();
  });
  if (!meta.merge_commit_sha) throw new Error(`${owner}/${repo}#${num} is not merged (no merge commit)`);

  // a fetch-only workspace: init if missing (works for brand-new repos)
  if (!fs.existsSync(repoDir)) {
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", repoDir], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "remote", "add", "origin", `https://github.com/${owner}/${repo}.git`], { stdio: "ignore" });
    console.log(`[strata] initialized fetch workspace repos/${slug}`);
  }

  // shallow-fetch the merge commit plus enough ancestors to cover every PR
  // commit; the fetch carries full trees/blobs for that window, so the
  // pipeline's worktree checkouts and diffs are entirely local
  const depth = Number(process.env.STRATA_FETCH_DEPTH || Math.max((meta.commits ?? 10) + 3, 5));
  const sha = meta.merge_commit_sha;
  let have = false;
  try {
    git(repoDir, ["cat-file", "-e", `${sha}^{commit}`]);
    have = true;
  } catch { /* not fetched yet */ }
  if (!have) {
    say(`fetching ${owner}/${repo} window (depth ${depth})`);
    git(repoDir, ["fetch", "--depth", String(depth), "origin", sha]);
    git(repoDir, ["cat-file", "-e", `${sha}^{commit}`]); // sanity: object present
  } else {
    console.log(`[strata] merge commit already local`);
  }

  say("reading review comments");
  let commentsPath = "";
  try {
    const rc = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${num}/comments?per_page=100`, {
      headers: ghHeaders()
    });
    if (rc.ok) {
      const raw = await rc.json();
      const comments = raw.map((c) => ({
        id: c.id,
        path: c.path,
        line: c.line ?? c.original_line ?? null,
        created: c.created_at,
        author: c.user?.login ?? "unknown",
        body: c.body ?? "",
        inReplyTo: c.in_reply_to_id ?? undefined
      }));
      if (comments.length) {
        commentsPath = outJson.replace(/\.json$/, ".comments.json");
        fs.writeFileSync(commentsPath, JSON.stringify(comments));
        console.log(`[strata] fetched ${comments.length} review comment(s)`);
      }
    }
  } catch { /* comments are best-effort */ }

  say("analyzing: git + TypeScript AST + def-use graph");
  const metaJson = JSON.stringify({
    title: meta.title ?? "",
    number: String(meta.number ?? ""),
    repo: `${owner}/${repo}`,
    baseRef: meta.base?.ref,
    headRef: meta.head?.ref,
    headLabel: meta.head?.label,
    commentsPath
  });
  await runPipeline([repoDir, sha, outJson, metaJson], onProgress);

  console.log(`[strata] done → data/${dataName}.json`);
  return { pr: dataName, title: meta.title, author: meta.user?.login, commits: meta.commits };
}

// CLI entry
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.argv[2];
  if (!url) {
    console.error("usage: node scripts/analyze.mjs <github pr url>");
    process.exit(1);
  }
  analyzePR(url, console.log)
    .then((out) => console.log(`[strata] analyze complete: ${out.pr}`))
    .catch((e) => {
      console.error(`[strata] ${e.message}`);
      process.exit(1);
    });
}
