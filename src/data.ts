import type { Commit, ComponentDoc, Entry, PageData } from "./types.js";

// ---- mock data -------------------------------------------------------------
// Fictional PR: acme/payments #482 "feat(payments): idempotent retries"
//
// Components here are DERIVED: each one is a flood fill from a changed
// symbol over data/control-flow edges, with overlapping fills merged.
// They span folders on purpose (see "fetchUser flow" spanning api/orders/cli)
// — that's the point of correlation over structure.

const E: Record<string, Entry> = {
  "charge": {
    id: "charge",
    kind: "function",
    name: "PaymentClient.charge()",
    summary: "now generates an idempotency key and retries with backoff",
    files: [{
      path: "src/payments/client.ts", delta: "+41 \u22123",
      lines: [
        { kind: "del", old: 88, text: "async charge(intent: PaymentIntent): Promise<ChargeResult> {", stratum: 2 },
        { kind: "add", new: 88, text: "async charge(intent: PaymentIntent): Promise<ChargeResult> {", stratum: 3 },
        { kind: "add", new: 89, text: "  const key = intent.idempotencyKey ?? crypto.randomUUID();", stratum: 4 },
        { kind: "add", new: 90, text: "  return withRetry(() => stripe.charges.create(intent, { idempotencyKey: key }), {", stratum: 4 },
        { kind: "add", new: 91, text: "    attempts: 3, backoff: expJitter(200),", stratum: 4 }
      ]
    }],
    traces: [
      { relation: "calls withRetry()", component: "retry-flow", object: "withretry" },
      { relation: "requires header Idempotency-Key on POST /v1/payments" },
      { relation: "0 test assertions on retry", negative: true, component: "test-coverage", object: "tests" }
    ]
  },
  "withretry": {
    id: "withretry",
    kind: "function",
    name: "withRetry()",
    summary: "new helper: filters on err.retryable before re-attempting",
    files: [{
      path: "src/payments/retry.ts", delta: "+18 \u22120",
      lines: [
        { kind: "add", new: 44, text: "export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {", stratum: 3 },
        { kind: "add", new: 48, text: "      if (!(err as StripeError).retryable || i === opts.attempts - 1) throw err;", stratum: 4 },
        { kind: "add", new: 49, text: "      await sleep(opts.backoff(i));", stratum: 4 }
      ]
    }],
    traces: [
      { relation: "reads StripeError.retryable", component: "retry-flow", object: "stripeerror" },
      { relation: "mapping table: 2 of 11 codes are retryable", component: "retry-flow", object: "stripeerror" },
      { relation: "0 test assertions on retry", negative: true, component: "test-coverage", object: "tests" }
    ],
    comments: [{
      author: "maya",
      anchor: "withRetry@44",
      body: "Does this swallow card_declined? Retrying non-retryable errors risks a double charge."
    }]
  },
  "stripeerror": {
    id: "stripeerror",
    kind: "typeAlias",
    name: "StripeError.retryable",
    summary: "new flag; mapping table grew from 9 to 11 codes",
    files: [{
      path: "src/payments/errors.ts", delta: "+5 \u22121",
      lines: [
        { kind: "del", old: 71, text: "case \"card_velocity_exceeded\": return new StripeError(code);", stratum: 1 },
        { kind: "add", new: 71, text: "case \"card_velocity_exceeded\": return new StripeError(code, { retryable: false });", stratum: 2 },
        { kind: "add", new: 77, text: "case \"request_locked\": return new StripeError(code, { retryable: true });", stratum: 2 }
      ]
    }],
    traces: [
      { relation: "consumed by withRetry()", component: "retry-flow", object: "withretry" },
      { relation: "new code card_velocity_exceeded \u00b7 retryable=false" }
    ]
  },
  "ordertotals": {
    id: "ordertotals",
    kind: "function",
    name: "orderTotals()",
    summary: "line items are now null-guarded; throws EmptyOrderError on empty",
    files: [{
      path: "src/orders/totals.ts", delta: "+12 \u22128",
      lines: [
        { kind: "del", old: 57, text: "const total = line.price * line.qty;", stratum: 2 },
        { kind: "add", new: 57, text: "const total = (line.price ?? 0) * (line.qty ?? 0);", stratum: 4 },
        { kind: "add", new: 58, text: "if (total <= 0) throw new EmptyOrderError(order.id);", stratum: 4 }
      ]
    }],
    traces: [
      { relation: "reads LineItem.qty", component: "fetchuser-flow", object: "lineitem" },
      { relation: "not caught by 2 of 4 callers", negative: true, component: "fetchuser-flow", object: "submitorder" }
    ]
  },
  "submitorder": {
    id: "submitorder",
    kind: "function",
    name: "submitOrder()",
    summary: "call sites migrated to fetchCharge(); one catch added",
    files: [{
      path: "src/orders/submit.ts", delta: "+8 \u22124",
      lines: [
        { kind: "del", old: 118, text: "const result = await payments.charge(intent);", stratum: 2 },
        { kind: "add", new: 118, text: "const result = await payments.fetchCharge(intent);", stratum: 3 },
        { kind: "add", new: 119, text: "catch (EmptyOrderError) { return decline(\"empty_order\"); }", stratum: 4 }
      ]
    }],
    traces: [
      { relation: "calls fetchUser() after migration", component: "fetchuser-flow", object: "fetchuser" }
    ]
  },
  "refundorder": {
    id: "refundorder",
    kind: "function",
    name: "refundOrder()",
    summary: "migrated to fetchCharge(); no EmptyOrderError handling",
    files: [{
      path: "src/orders/refund.ts", delta: "+3 \u22121",
      lines: [
        { kind: "move", old: 74, new: 74, text: "const result = await payments.fetchCharge(intent);" },
        { kind: "add", new: 75, text: "// TODO: decide on EmptyOrderError here", stratum: 4 }
      ]
    }],
    traces: [
      { relation: "does not catch EmptyOrderError", negative: true, component: "fetchuser-flow", object: "ordertotals" }
    ]
  },
  "fetchuser": {
    id: "fetchuser",
    kind: "function",
    name: "fetchUser()",
    summary: "renamed from getUser(); alias kept, deprecated in v3",
    files: [{
      path: "src/api/users.ts", delta: "+2 \u22122",
      lines: [
        { kind: "del", old: 41, text: "export async function getUser(id: string): Promise<User> {", stratum: 1 },
        { kind: "add", new: 41, text: "export async function fetchUser(id: string): Promise<User> {", stratum: 2 },
        { kind: "move", old: 42, new: 42, text: "const res = await http.get(`/v1/users/${id}`);" }
      ]
    }],
    traces: [
      { relation: "9 call sites updated", component: "fetchuser-flow", object: "submitorder" },
      { relation: "3 call sites in cli/ keep the alias" }
    ]
  },
  "getuser": {
    id: "getuser",
    kind: "function",
    name: "getUser()",
    summary: "deprecated alias wrapping fetchUser()",
    files: [{
      path: "src/api/users.ts", delta: "+4 \u22120",
      lines: [
        { kind: "add", new: 46, text: "/** @deprecated use fetchUser \u2014 removed in v3 */", stratum: 2 },
        { kind: "add", new: 47, text: "export const getUser = fetchUser;", stratum: 2 }
      ]
    }],
    traces: [
      { relation: "alias of fetchUser()", component: "fetchuser-flow", object: "fetchuser" }
    ]
  },
  "lineitem": {
    id: "lineitem",
    kind: "typeAlias",
    name: "LineItem.qty",
    summary: "typed non-null, but legacy resolver can emit null",
    files: [{
      path: "src/api/types.ts", delta: "+1 \u22121",
      lines: [
        { kind: "del", old: 15, text: "  qty: number;", stratum: 1 },
        { kind: "add", new: 15, text: "  qty: number; // resolver may emit null for legacy orders", stratum: 3 }
      ]
    }],
    traces: [
      { relation: "null-guarded in orderTotals()", component: "fetchuser-flow", object: "ordertotals" }
    ],
    comments: [{
      author: "maya",
      anchor: "LineItem.qty@15",
      body: "If the resolver can emit null, fix the resolver's type \u2014 not every consumer."
    }]
  },
  "sdk": {
    id: "sdk",
    kind: "const",
    name: "stripe v13 \u2192 v14",
    summary: "dependency bump; drives error-code adaptation",
    files: [{
      path: "package.json", delta: "+1 \u22121",
      lines: [
        { kind: "del", old: 12, text: "\"stripe\": \"^13.9.0\",", stratum: 1 },
        { kind: "add", new: 12, text: "\"stripe\": \"^14.2.1\",", stratum: 1 }
      ]
    }],
    traces: [
      { relation: "drives error-code changes", component: "retry-flow", object: "stripeerror" }
    ]
  },
  "tests": {
    id: "tests",
    kind: "const",
    name: "tests/payments.spec.ts",
    summary: "untouched by this PR \u2014 0 assertions on retry behavior",
    files: [],
    traces: [
      { relation: "covers PaymentClient.charge()", component: "test-coverage", object: "charge" },
      { relation: "0 assertions on withRetry()", negative: true }
    ],
    comments: [{
      author: "maya",
      anchor: "tests/payments.spec.ts",
      body: "The retry path ships untested. Blocking until there's at least a non-retryable-error case."
    }]
  }
};

// ---- components: derived by flood fill -------------------------------------
// origin documents HOW the fill was formed (seeds + edge kinds + merge).

const COMPONENTS: ComponentDoc[] = [
  {
    id: "fetchuser-flow",
    name: "fetchUser flow",
    origin: "fill from fetchUser \u00b7 def\u2212use + call edges \u00b7 merged with orderTotals fill (share LineItem.qty)",
    stats: "6 objects \u00b7 3 folders",
    entryIds: ["fetchuser", "getuser", "lineitem", "ordertotals", "submitorder", "refundorder"]
  },
  {
    id: "retry-flow",
    name: "charge retry flow",
    origin: "fill from withRetry \u00b7 call + type-ref edges \u00b7 merged with SDK bump fill (stripe.errorCodes)",
    stats: "4 objects \u00b7 2 folders",
    entryIds: ["charge", "withretry", "stripeerror", "sdk"]
  },
  {
    id: "test-coverage",
    name: "test coverage gaps",
    origin: "fill from untouched test files \u00b7 coverage edges (inverted: what they should see)",
    stats: "3 objects \u00b7 1 folder",
    entryIds: ["tests", "charge", "withretry"]
  }
];

// ---- commits: the time axis -------------------------------------------------

const COMMITS: Commit[] = [
  {
    id: "c1", sha: "e7f2a9c", author: "you", day: "Mon", time: "09:14",
    message: "build: bump stripe to v14",
    stratum: 1,
    touches: ["sdk", "stripeerror"],
    files: [{
      path: "package.json", delta: "+1 \u22121",
      lines: [
        { kind: "del", old: 12, text: "\"stripe\": \"^13.9.0\",", stratum: 1 },
        { kind: "add", new: 12, text: "\"stripe\": \"^14.2.1\",", stratum: 1 }
      ]
    }]
  },
  {
    id: "c2", sha: "b91c04e", author: "maintainer", day: "Tue", time: "11:02",
    message: "feat: retryable flag + 2 new stripe error codes",
    stratum: 2,
    touches: ["stripeerror"],
    files: [{
      path: "src/payments/errors.ts", delta: "+5 \u22121",
      lines: [
        { kind: "add", new: 77, text: "case \"request_locked\": return new StripeError(code, { retryable: true });", stratum: 2 }
      ]
    }]
  },
  {
    id: "c3", sha: "5d0e1b2", author: "you", day: "Tue", time: "16:40",
    message: "refactor: rename getUser \u2192 fetchUser, update call sites",
    stratum: 2,
    touches: ["fetchuser", "getuser", "submitorder", "refundorder"],
    files: [{
      path: "src/api/users.ts", delta: "+2 \u22122",
      lines: [
        { kind: "del", old: 41, text: "export async function getUser(id: string): Promise<User> {", stratum: 1 },
        { kind: "add", new: 41, text: "export async function fetchUser(id: string): Promise<User> {", stratum: 2 }
      ]
    }]
  },
  {
    id: "c4", sha: "a3f7719", author: "maintainer", day: "Wed", time: "10:21",
    message: "feat: withRetry helper with exponential backoff",
    stratum: 3,
    touches: ["withretry", "charge", "lineitem"],
    files: [{
      path: "src/payments/retry.ts", delta: "+18 \u22120",
      lines: [
        { kind: "add", new: 44, text: "export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {", stratum: 3 }
      ]
    }]
  },
  {
    id: "c5", sha: "c8e93d1", author: "reviewer-bot", day: "Thu", time: "08:47",
    message: "fix: null-guard line items in order totals",
    stratum: 4,
    touches: ["ordertotals", "lineitem"],
    files: [{
      path: "src/orders/totals.ts", delta: "+12 \u22128",
      lines: [
        { kind: "add", new: 57, text: "const total = (line.price ?? 0) * (line.qty ?? 0);", stratum: 4 }
      ]
    }]
  },
  {
    id: "c6", sha: "d4a20b8", author: "reviewer-bot", day: "Thu", time: "09:02",
    message: "fix: catch EmptyOrderError in submitOrder",
    stratum: 4,
    touches: ["submitorder"],
    files: [{
      path: "src/orders/submit.ts", delta: "+1 \u22120",
      lines: [
        { kind: "add", new: 119, text: "catch (EmptyOrderError) { return decline(\"empty_order\"); }", stratum: 4 }
      ]
    }]
  }
];

export const PAGE: PageData = {
  pr: {
    repo: "acme/payments",
    number: "#482",
    title: "feat(payments): idempotent retries",
    author: "maya"
  },
  banner: "Force-pushed 2h ago — 3 hunks changed since your last look. Your comments moved with their symbols.",
  initialComponent: "fetchuser-flow",
  components: COMPONENTS,
  commits: COMMITS,
  entries: E
};
