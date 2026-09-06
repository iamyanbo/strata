// Stage 2: Index — TypeScript AST over both trees.
// Produces declarations (defs) and identifier occurrences (uses),
// with import/export resolution so cross-file edges are real.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

export interface Def {
  id: string;            // stable symbol key: file#name#kind#i
  name: string;
  kind: string;          // function | class | method | interface | typeAlias | const | property | enum | enumMember
  file: string;          // head-relative posix path
  start: number;
  /** start including leading trivia — the doc comment belongs to the symbol */
  full: number;
  end: number;
  /** module-scope declaration (graph node); locals attach to enclosing */
  topLevel: boolean;
  /** identifier occurrence ranges that reference this def (head tree) */
  uses: { file: string; start: number; end: number }[];
}

export interface Index {
  root: string;          // temp workdir root (HEAD checkout)
  defs: Def[];
  /** def id -> def (by id) */
  byId: Map<string, Def>;
  /** usage points: file -> spans -> def ids (multiple via overloads/shadowing);
      prop = the identifier is a property-access name (obj.member) */
  fileUses: Map<string, { start: number; end: number; defId: string; prop?: boolean }[]>;
  /** collapsed-mirror map: any indexed-relative path → its canonical file */
  canonical: Map<string, string>;
}

function listTsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        walk(p);
      } else if (/\.tsx?$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

export function checkout(repoDir: string, ref: string, workdir: string): void {
  // worktree handles symlinks on Windows correctly (unlike tar extraction).
  // A killed or interrupted run leaves stale admin entries that block re-add,
  // so prune both before and after clearing the directory — a registration
  // only becomes prunable once the folder it points at is gone.
  try { execFileSync("git", ["-C", repoDir, "worktree", "prune"]); } catch { /* best effort */ }
  try { execFileSync("git", ["-C", repoDir, "worktree", "remove", "--force", workdir]); } catch { /* not registered */ }
  fs.rmSync(workdir, { recursive: true, force: true });
  try { execFileSync("git", ["-C", repoDir, "worktree", "prune"]); } catch { /* best effort */ }
  fs.mkdirSync(path.dirname(workdir), { recursive: true });
  execFileSync("git", ["-C", repoDir, "worktree", "add", "--detach", workdir, ref], {
    maxBuffer: 1024 * 1024 * 64
  });
}

function defKind(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "typeAlias";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isMethodDeclaration(node)) return "method";
  if (ts.isPropertyDeclaration(node)) return "property";
  if (ts.isPropertySignature(node)) return "property";
  if (ts.isEnumMember(node)) return "enumMember";
  if (ts.isVariableStatement(node)) {
    const decl = node.declarationList.declarations[0];
    if (decl && ts.isIdentifier(decl.name)) return "const";
  }
  return null;
}

function defName(node: ts.Node): string | null {
  const n = node as { name?: ts.Node };
  if (n.name && ts.isIdentifier(n.name)) {
    const t = n.name.text;
    if (t && t !== "undefined" && t.length >= 2) return t;
  }
  if (ts.isVariableStatement(node)) {
    const decl = node.declarationList.declarations[0];
    if (decl && ts.isIdentifier(decl.name)) {
      const t = decl.name.text;
      if (t && t !== "undefined" && t.length >= 2) return t;
    }
  }
  return null;
}

/** deno-style mirrors are byte-identical except relative import specifiers
    carry ".ts"/".tsx"; normalize them so mirrors hash equal. */
function normalizeForHash(text: string): string {
  return text.replace(/(\bfrom\s*|\bimport\s*\(\s*)(["'])(\.[^"']*?)\.tsx?\2/g, (_m, p1, q, p3) => `${p1}${q}${p3}${q}`);
}

/** Extract defs and identifier uses from one tree.
    Files with identical normalized content (generated mirrors, e.g. zod's
    deno/lib) are collapsed onto a canonical copy — preferring paths the PR
    diff references, else the lexicographically shortest — so defs, uses and
    edges are indexed once and diffs seed real code, not its mirror. */
function scan(root: string, prefer?: Set<string>): {
  defs: Def[];
  fileUses: Index["fileUses"];
  canonical: Index["canonical"];
} {
  const defs: Def[] = [];
  const fileUses: Index["fileUses"] = new Map();
  const files = listTsFiles(root);

  // group files by normalized content; pick the canonical copy
  // (preference is expressed in repo-relative paths — normalize before comparing)
  const relOf = new Map<string, string>();
  for (const file of files) relOf.set(file, path.relative(root, file).split(path.sep).join("/"));
  const byHash = new Map<string, string>();
  const canonical = new Map<string, string>(); // file -> file (identity when canonical)
  for (const file of files) {
    const h = createHash("sha1").update(normalizeForHash(fs.readFileSync(file, "utf8"))).digest("hex");
    const seen = byHash.get(h);
    if (seen === undefined) {
      byHash.set(h, file);
      canonical.set(file, file);
      continue;
    }
    const better = (a: string, b: string): string => {
      const ap = prefer?.has(relOf.get(a)!), bp = prefer?.has(relOf.get(b)!);
      if (ap && !bp) return a;
      if (bp && !ap) return b;
      // generated mirrors usually live in deeper trees; source of truth is shallower
      const sa = relOf.get(a)!.split("/").length, sb = relOf.get(b)!.split("/").length;
      if (sa !== sb) return sa < sb ? a : b;
      return a < b ? a : b;
    };
    const best = better(seen, file);
    byHash.set(h, best);
    canonical.set(file, best);
    if (best !== seen) for (const [f, c] of canonical) if (c === seen) canonical.set(f, best);
  }
  const mirrors = files.filter((f) => canonical.get(f) !== f).length;
  if (mirrors) console.log(`  index: ${files.length} ts files, ${mirrors} mirror file(s) collapsed`);

  for (const file of files) {
    if (canonical.get(file) !== file) continue;
    const rel = path.relative(root, file).split(path.sep).join("/");
    const text = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

    // collect def candidate nodes
    const visitDefs = (node: ts.Node) => {
      const kind = defKind(node);
      if (kind) {
        const name = defName(node);
        if (name) {
          const topLevel = node.parent === sf || node.parent.kind === ts.SyntaxKind.ModuleBlock;
          defs.push({
            id: `${rel}#${name}#${kind}#${defs.length}`,
            name, kind, file: rel,
            start: node.getStart(sf), full: node.getFullStart(), end: node.getEnd(),
            topLevel,
            uses: []
          });
        }
      }
      ts.forEachChild(node, visitDefs);
    };
    visitDefs(sf);

    // identifier occurrences (potential uses); flag property-access names
    // (z.foo, NS.bar) so the resolver can chase them through namespace imports
    const uses: { start: number; end: number; defId: string; prop?: boolean }[] = [];
    const visitIds = (node: ts.Node) => {
      if (ts.isIdentifier(node)) {
        const prop =
          ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
        uses.push({ start: node.getStart(sf), end: node.getEnd(), defId: node.text, prop });
      }
      ts.forEachChild(node, visitIds);
    };
    visitIds(sf);
    fileUses.set(rel, uses);
  }

  return { defs, fileUses, canonical };
}

export function buildIndex(root: string, prefer?: Set<string>): Index {
  const { defs, fileUses, canonical } = scan(root, prefer);
  return { root, defs, byId: new Map(defs.map((d) => [d.id, d])), fileUses, canonical };
}

/** Resolve a relative module specifier ("./foo", "../core/bar") to a repo file.
    Falls back through the canonical-mirror map so imports inside mirror files
    still reach the one indexed copy. */
function resolveSpec(fromFile: string, spec: string, files: Set<string>, canonical: Map<string, string>): string | null {
  if (!spec.startsWith(".")) return null; // bare specifier → package, outside the repo
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  for (const c of candidates) {
    if (files.has(c)) return c;
    const canon = canonical.get(c);
    if (canon && files.has(canon)) return canon;
  }
  return null;
}

interface ImportEntry { local: string; module: string; imported: string | null; kind: "named" | "namespace" | "default"; }
interface ReExport { exported: string; imported: string | null; module: string; } // exported "*" = export * from

/** Parse import declarations and re-exports for every file. */
function moduleGraph(index: Index): { imports: Map<string, ImportEntry[]>; reExps: Map<string, ReExport[]> } {
  const files = new Set(index.fileUses.keys());
  const canonical = index.canonical;
  const imports = new Map<string, ImportEntry[]>();
  const reExps = new Map<string, ReExport[]>();
  for (const file of files) {
    let text: string;
    try { text = fs.readFileSync(path.join(index.root, file), "utf8"); } catch { continue; }
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const imps: ImportEntry[] = [];
    const rex: ReExport[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = resolveSpec(file, (node.moduleSpecifier as ts.StringLiteral).text, files, canonical);
        const clause = node.importClause;
        if (target && clause) {
          if (clause.name) imps.push({ local: clause.name.text, module: target, imported: null, kind: "default" });
          const nb = clause.namedBindings;
          if (nb && ts.isNamespaceImport(nb)) {
            imps.push({ local: nb.name.text, module: target, imported: null, kind: "namespace" });
          } else if (nb && ts.isNamedImports(nb)) {
            for (const e of nb.elements) {
              imps.push({ local: e.name.text, module: target, imported: e.propertyName ? e.propertyName.text : e.name.text, kind: "named" });
            }
          }
        }
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = resolveSpec(file, (node.moduleSpecifier as ts.StringLiteral).text, files, canonical);
        if (target) {
          if (node.exportClause && ts.isNamedExports(node.exportClause)) {
            for (const e of node.exportClause.elements) {
              rex.push({ exported: e.name.text, imported: e.propertyName ? e.propertyName.text : e.name.text, module: target });
            }
          } else if (!node.exportClause) {
            rex.push({ exported: "*", imported: null, module: target });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    imports.set(file, imps);
    reExps.set(file, rex);
  }
  return { imports, reExps };
}

/** Resolve (module file, exported name) → def, following re-export chains. */
function makeExportResolver(index: Index, reExps: Map<string, ReExport[]>) {
  const byFile = new Map<string, Map<string, Def>>();
  for (const d of index.defs) {
    if (!d.topLevel) continue;
    let m = byFile.get(d.file);
    if (!m) { m = new Map(); byFile.set(d.file, m); }
    if (!m.has(d.name)) m.set(d.name, d);
  }
  const memo = new Map<string, Def | null>();
  const lookup = (file: string, name: string, seen: Set<string>): Def | null => {
    const key = `${file}::${name}`;
    if (memo.has(key)) return memo.get(key)!;
    if (seen.has(key)) return null;
    seen.add(key);
    let out = byFile.get(file)?.get(name) ?? null;
    if (!out) {
      for (const r of reExps.get(file) ?? []) {
        if (r.exported !== "*" && r.exported !== name) continue;
        out = lookup(r.module, r.imported ?? name, seen);
        if (out) break;
      }
    }
    memo.set(key, out);
    return out;
  };
  return { lookup, moduleLocal: (file: string, name: string): Def | null => byFile.get(file)?.get(name) ?? null };
}

/** resolve identifier-name uses to def ids via scope-aware rules:
    1. def in the same file (lexically closest match wins)
    2. the exact def the file imports that name from (named/default imports,
       following re-export chains through barrel files)
    3. a globally unique name (unambiguous anywhere in the repo)
    namespace-import member uses are dropped (under-approximation). */
export function resolveUses(index: Index): void {
  const byName = new Map<string, Def[]>();
  for (const d of index.defs) {
    const arr = byName.get(d.name) ?? [];
    arr.push(d);
    byName.set(d.name, arr);
  }

  const { imports, reExps } = moduleGraph(index);
  const { lookup, moduleLocal } = makeExportResolver(index, reExps);

  for (const [file, uses] of index.fileUses) {
    const resolved: { start: number; end: number; defId: string; prop?: boolean }[] = [];
    const local = index.defs.filter((d) => d.file === file);
    const importByLocal = new Map<string, ImportEntry>();
    for (const im of imports.get(file) ?? []) {
      if (!importByLocal.has(im.local)) importByLocal.set(im.local, im);
    }
    const nsImports = (imports.get(file) ?? []).filter((im) => im.kind === "namespace");
    for (const u of uses) {
      const localMatch = local.find((d) => d.name === u.defId);
      if (localMatch) {
        resolved.push({ start: u.start, end: u.end, defId: localMatch.id });
        continue;
      }
      const im = importByLocal.get(u.defId);
      if (im) {
        let def: Def | null = null;
        if (im.kind === "named") def = lookup(im.module, im.imported!, new Set());
        else if (im.kind === "default") def = lookup(im.module, "default", new Set()) ?? moduleLocal(im.module, u.defId);
        if (def) resolved.push({ start: u.start, end: u.end, defId: def.id, prop: u.prop });
        continue;
      }
      // namespace member access (z.foo): resolve through the file's namespace
      // imports — this is how test files and consumer code reach the exports
      if (u.prop && nsImports.length) {
        let nsDef: Def | null = null;
        for (const ns of nsImports) {
          nsDef = lookup(ns.module, u.defId, new Set());
          if (nsDef) break;
        }
        if (nsDef) resolved.push({ start: u.start, end: u.end, defId: nsDef.id, prop: u.prop });
        continue;
      }
      const globalMatches = byName.get(u.defId);
      if (globalMatches && globalMatches.length === 1) {
        resolved.push({ start: u.start, end: u.end, defId: globalMatches[0].id });
      }
      // ambiguous or unresolved: dropped (deterministic under-approximation)
    }
    index.fileUses.set(file, resolved);
  }

  // attach uses to defs
  for (const [file, uses] of index.fileUses) {
    for (const u of uses) {
      const def = index.byId.get(u.defId);
      if (def) {
        def.uses.push({ file, start: u.start, end: u.end });
      }
    }
  }
}
