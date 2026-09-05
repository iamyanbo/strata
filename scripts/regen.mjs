// Regenerate all cached datasets with the current pipeline, fetching real
// branch refs from the GitHub API for truthful lineage. One-off maintenance.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const prs = [
  { repoDir: "repos/zod", resolve: "18e71c7", out: "data/pr-6541.json", num: "6541", title: "Rename the JSON Schema process helper", comments: "" },
  { repoDir: "repos/zod", resolve: "18e71c7", out: "data/sample.json", num: "6541", title: "Rename the JSON Schema process helper", comments: "" },
  { repoDir: "repos/colinhacks-zod", resolve: "4a549b1", out: "data/pr-colinhacks-zod-898.json", num: "898", title: "NaN type", comments: "" },
  { repoDir: "repos/colinhacks-zod", resolve: "e17dcb6", out: "data/pr-colinhacks-zod-5534.json", num: "5534", title: "fromJSONSchema", comments: "data/pr-colinhacks-zod-5534.comments.json" },
  { repoDir: "repos/colinhacks-zod", resolve: "abbf325", out: "data/pr-colinhacks-zod-899.json", num: "899", title: "Discriminated union", comments: "data/pr-colinhacks-zod-899.comments.json" }
];

const meta = async (num) => {
  const r = await fetch(`https://api.github.com/repos/colinhacks/zod/pulls/${num}`, { headers: { "User-Agent": "strata" } });
  if (!r.ok) throw new Error(`GitHub ${r.status} for #${num}`);
  const j = await r.json();
  return { baseRef: j.base?.ref, headRef: j.head?.ref, headLabel: j.head?.label, merge: j.merge_commit_sha };
};

const run = async () => {
  for (const p of prs) {
    const repoDir = path.join(ROOT, p.repoDir);
    const sha = execFileSync("git", ["-C", repoDir, "rev-parse", p.resolve]).toString().trim();
    let refs = {};
    try { refs = await meta(p.num); } catch (e) { console.log(`  (no refs for #${p.num}: ${e.message})`); }
    if (refs.merge && !sha.startsWith(refs.merge.slice(0, 7))) {
      console.log(`  WARN: #${p.num} upstream merge ${refs.merge.slice(0, 7)} differs from local ${sha.slice(0, 7)} — using local`);
      refs = {};
    }
    const metaJson = JSON.stringify({
      title: p.title,
      number: p.num,
      repo: "colinhacks/zod",
      baseRef: refs.baseRef,
      headRef: refs.headRef,
      headLabel: refs.headLabel,
      commentsPath: p.comments ? path.join(ROOT, p.comments) : ""
    });
    execFileSync("node", [path.join(ROOT, "dist/pipeline/run.js"), repoDir, sha, path.join(ROOT, p.out), metaJson], { stdio: "inherit", cwd: ROOT, maxBuffer: 1024 * 1024 * 64 });
    console.log(`OK ${p.out}`);
  }
};

run().catch((e) => { console.error(e); process.exit(1); });
