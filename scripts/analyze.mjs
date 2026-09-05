// Point strata at any GitHub PR: shallow-fetch exactly the merge commit's
// window (no full clone), run the pipeline, emit viewer JSON.
//
//   import { analyzePR } from "./analyze.mjs";
//   await analyzePR("https://github.com/honojs/hono/pull/1234");

import { execFileSync } from "node:child_process";
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

export async function analyzePR(url) {
  const { owner, repo, num } = parsePrUrl(url);
  const slug = `${owner}-${repo}`;
  const dataName = `pr-${slug}-${num}`;
  const outJson = path.join(ROOT, "data", `${dataName}.json`);
  const repoDir = path.join(ROOT, "repos", slug);

  const api = `https://api.github.com/repos/${owner}/${repo}/pulls/${num}`;
  const meta = await fetch(api, { headers: { "User-Agent": "strata" } }).then((r) => {
    if (!r.ok) throw new Error(`GitHub API ${r.status} for ${owner}/${repo}#${num}`);
    return r.json();
  });
  if (!meta.merge_commit_sha) throw new Error(`${owner}/${repo}#${num} is not merged (no merge commit)`);

  // a fetch-only workspace: init if missing (works for brand-new repos)
  if (!fs.existsSync(repoDir)) {
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", repoDir], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "remote", "add", "origin", `https://github.com/${owner}/${repo}.git`]);
    console.log(`[strata] initialized fetch workspace repos/${slug}`);
  }

  // shallow-fetch the merge commit plus enough ancestors to cover every PR
  // commit; the fetch carries full trees/blobs for that window, so the
  // pipeline's worktree checkouts and diffs are entirely local
  const depth = Math.max((meta.commits ?? 10) + 3, 5);
  const sha = meta.merge_commit_sha;
  let have = false;
  try {
    git(repoDir, ["cat-file", "-e", `${sha}^{commit}`]);
    have = true;
  } catch { /* not fetched yet */ }
  if (!have) {
    console.log(`[strata] fetching ${owner}/${repo}#${num} (merge ${sha.slice(0, 9)}, depth ${depth})...`);
    git(repoDir, ["fetch", "--depth", String(depth), "origin", sha]);
    git(repoDir, ["cat-file", "-e", `${sha}^{commit}`]); // sanity: object present
  } else {
    console.log(`[strata] merge commit already local`);
  }

  console.log("[strata] running pipeline...");
  let commentsPath = "";
  try {
    const rc = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${num}/comments?per_page=100`, {
      headers: { "User-Agent": "strata" }
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
  execFileSync(
    "node",
    [
      path.join(ROOT, "dist", "pipeline", "run.js"),
      repoDir, sha, outJson, meta.title ?? "", String(meta.number ?? ""), commentsPath,
      `${owner}/${repo}`
    ],
    { stdio: "inherit", cwd: ROOT, maxBuffer: 1024 * 1024 * 64 }
  );

  console.log(`[strata] done → data/${dataName}.json`);
  return { pr: dataName, title: meta.title, author: meta.user?.login, commits: meta.commits };
}
