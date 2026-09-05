// Runner: analyze a merged PR (squash or merge commit) and emit PageData JSON.
//
//   node dist/pipeline/run.js <repoDir> <mergeCommitSha> <outJson>
//
// base = first parent of the merge/squash commit; head = the commit itself.

import * as fs from "node:fs";
import * as path from "node:path";
import { loadPR } from "./git.js";
import { buildIndex, resolveUses, checkout } from "./index.js";
import { findSeeds, buildAdjacency, floodFill } from "./flow.js";
import { emit } from "./emit.js";
import type { RawComment } from "../src/types.js";

const [repoDirRaw, mergeCommit, outJson, titleArg, numArg, commentsPath, repoArg] = process.argv.slice(2);
if (!repoDirRaw || !mergeCommit || !outJson) {
  console.error("usage: run.js <repoDir> <mergeCommit> <outJson> [title] [prNumber] [commentsPath] [owner/repo]");
  process.exit(1);
}
const repoDir = path.resolve(repoDirRaw);

const workRoot = path.join(repoDir, "..", ".work");
const headDir = path.join(workRoot, "head");

console.log("checkout head tree...");
checkout(repoDir, mergeCommit, headDir);

console.log("loading PR shape...");
let pr = loadPR(repoDir, mergeCommit);
if (titleArg) pr = { ...pr, title: titleArg };
console.log(`  ${pr.commits.length} commit(s), ${pr.files.length} file(s)`);

// head-tree paths referenced by diff (rename-aware: new paths)
const fileNameMap = new Map<string, string>();
for (const f of pr.files) fileNameMap.set(f.path, f.path);

console.log("indexing head tree (TS AST)...");
const index = buildIndex(headDir, new Set(fileNameMap.values()));
resolveUses(index);
console.log(`  ${index.defs.length} defs`);

console.log("indexing base tree...");
const baseDir = path.join(workRoot, "base");
checkout(repoDir, pr.base, baseDir);
const baseIndex = buildIndex(baseDir);
console.log(`  ${baseIndex.defs.length} defs`);

console.log("seeding from diff...");
const seeds = findSeeds(pr, index, fileNameMap);
console.log(`  ${seeds.size} seed(s): ${[...seeds].map((s) => index.byId.get(s)?.name ?? s).join(", ")}`);

console.log("building adjacency...");
const adj = buildAdjacency(index);

console.log("flood fill...");
const flow = floodFill(seeds, adj, index, pr);
console.log(`  ${flow.components.length} component(s)`);

let comments: RawComment[] | undefined;
if (commentsPath) {
  try { comments = JSON.parse(fs.readFileSync(commentsPath, "utf8")); } catch { /* best effort */ }
}

emit(pr, index, baseIndex, flow, fileNameMap, outJson, {
  number: numArg,
  repo: repoArg,
  comments
});
