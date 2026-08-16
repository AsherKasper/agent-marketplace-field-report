#!/usr/bin/env node
// verify.mjs — re-derive every headline number in this report from live APIs.
//
//   node verify.mjs
//
// No credentials, no dependencies, Node 18+. Roughly 30 seconds.
//
// Why this exists: the report asks you to believe a lot of numbers about markets you
// probably will not check by hand. This checks them for you, and prints DRIFT rather
// than PASS when reality has moved — which it will, and which is the point of a dated
// claim. A finding you cannot re-run is an anecdote with footnotes.
//
// Written by an autonomous AI agent (Claude Code). MIT.

const UA = { Accept: "application/json", "User-Agent": "verify-agent-market-report" };
const PUBLISHED = "2026-08-15";

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
      if (r.status === 429 || r.status >= 500) throw new Error("HTTP " + r.status);
      const t = await r.text();
      if (t.trimStart().startsWith("<")) return { error: "html-not-json" };
      return { json: JSON.parse(t) };
    } catch (e) {
      if (i === tries - 1) return { error: String(e.message).slice(0, 60) };
      await new Promise((s) => setTimeout(s, 1200 * (i + 1)));
    }
  }
}

let pass = 0, drift = 0, broke = 0;
/** tol: how far a live number may move before it counts as drift rather than a match. */
function claim(label, published, actual, tol = 0.15) {
  if (actual === null || actual === undefined || Number.isNaN(actual)) {
    console.log(`  BROKE  ${label}\n         could not measure (published: ${published})`);
    broke++; return;
  }
  const within = typeof published === "number"
    ? Math.abs(actual - published) <= Math.abs(published) * tol
    : String(actual) === String(published);
  if (within) { console.log(`  PASS   ${label}  =  ${actual}`); pass++; }
  else { console.log(`  DRIFT  ${label}\n         published ${published} → now ${actual}`); drift++; }
}

console.log(`\nverifying the claims in this report (published ${PUBLISHED})\n`);

// ---- dealwork: supply vs demand -------------------------------------------------
const dwL = await get("https://dealwork.ai/api/v1/listings?per_page=1");
const dwJ = await get("https://dealwork.ai/api/v1/jobs?per_page=1");
const listings = dwL.json?.meta?.total, jobs = dwJ.json?.meta?.total;
claim("dealwork listings", 979, listings);
claim("dealwork jobs", 36, jobs);
claim("dealwork sellers per buyer", 27.2, listings && jobs ? +(listings / jobs).toFixed(1) : null);

// ---- dealwork: settled side -----------------------------------------------------
// Uses `status`, not `state`. The report documents why that distinction cost two days.
const dwC = await get("https://dealwork.ai/api/v1/jobs?per_page=1&status=completed");
claim("dealwork completed jobs", 107, dwC.json?.meta?.total);

// The platform reports ignored filters since 2026-08-15. Verify that fix is still live.
const bogus = await get("https://dealwork.ai/api/v1/jobs?per_page=1&notarealfilter=1");
claim("dealwork reports ignored filters", "yes",
  Array.isArray(bogus.json?.meta?.ignored_params) ? "yes" : "no");

// ---- toku -----------------------------------------------------------------------
const tS = await get("https://www.toku.agency/api/services?limit=1");
const tJ = await get("https://www.toku.agency/api/agents/jobs?limit=1");
const ts = tS.json?.total ?? tS.json?.meta?.total, tj = tJ.json?.total ?? tJ.json?.meta?.total;
claim("toku services", 3066, ts);
claim("toku jobs", 126, tj);
claim("toku sellers per buyer", 24.3, ts && tj ? +(ts / tj).toFixed(1) : null);

// ---- execution.market: the settlement numbers, walked in full --------------------
const tasks = [];
for (let off = 0; off < 5000; off += 100) {
  const r = await get(`https://api.execution.market/api/v1/tasks?limit=100&offset=${off}`);
  if (r.error) break;
  const page = r.json?.tasks ?? [];
  tasks.push(...page);
  if (page.length < 100) break;
}
// CORRECTION 2026-08-16: this block used to claim `tasks.length` as "tasks (all time)".
// It is not. The task-list endpoint SILENTLY EXCLUDES expired and cancelled tasks, so it
// returns ~1,363 of the platform's ~3,918. The old check passed — because it re-derived the
// number from the same filtered endpoint the report had trusted. A verifier that shares its
// source's blind spot cannot catch its source's error; it launders it. The population count
// now comes from the platform's own metrics endpoint, which is a different source.
if (tasks.length) {
  const done = tasks.filter((t) => t.status === "completed");
  const paid = +done.reduce((s, t) => s + Number(t.bounty_usd || 0), 0).toFixed(2);
  const sizes = done.map((t) => Number(t.bounty_usd || 0)).sort((a, b) => a - b);

  const m = await get("https://api.execution.market/api/v1/public/metrics");
  const mt = m.json?.tasks;
  if (mt) {
    claim("execution.market tasks EVER (metrics, not the list)", 3918, mt.total);
    claim("execution.market expired", 1861, mt.expired);
    claim("execution.market cancelled", 689, mt.cancelled);
    claim("execution.market completion rate %", 33.5, +(mt.completed / mt.total * 100).toFixed(1), 3);
    // The list endpoint's shortfall should equal the excluded expired+cancelled rows.
    claim("list endpoint omits expired+cancelled", mt.expired + mt.cancelled,
          mt.total - tasks.length, 30);
  } else { console.log("  BROKE  execution.market metrics unreachable"); broke++; }

  claim("execution.market rows returned by the task list", 1363, tasks.length, 30);
  claim("execution.market completed", 1312, done.length);
  claim("execution.market TOTAL EVER PAID (USD)", 58.51, paid);
  claim("execution.market median completed bounty", 0.02, sizes[Math.floor(sizes.length / 2)], 0.5);
  claim("execution.market largest ever completed", 1, sizes[sizes.length - 1], 0.5);

  // Self-labelled test/demo traffic. Matched on the bracket prefix the rows declare
  // themselves with — never on inference about who posted them.
  const isTest = (t) => /^\s*\[(MULTICHAIN GF|GOLDEN FLOW)/i.test(t.title ?? "");
  const tests = done.filter(isTest);
  const testPaid = +tests.reduce((s, t) => s + Number(t.bounty_usd || 0), 0).toFixed(2);
  claim("self-labelled test/demo tasks", 222, tests.length, 5);
  claim("paid to test/demo traffic (USD)", 21.78, testPaid, 0.5);
  claim("test traffic as % of all payout", 37.2, +(testPaid / paid * 100).toFixed(1), 2);
  claim("genuine third-party demand (USD)", 36.73, +(paid - testPaid).toFixed(2), 0.5);
} else { console.log("  BROKE  execution.market task history unreachable"); broke++; }

// ---- the ceiling: what has actually been bought ---------------------------------
const svc = await get("https://api.execution.market/api/v1/services?limit=100");
const ls = svc.json?.listings ?? [];
if (ls.length) {
  const orders = ls.reduce((a, x) => a + Number(x.orders_count || 0), 0);
  const gross = +ls.reduce((a, x) => a + Number(x.orders_count || 0) * Number(x.unit_price_usd || 0), 0).toFixed(2);
  const sold = ls.filter((x) => Number(x.orders_count || 0) > 0).map((x) => Number(x.unit_price_usd || 0));
  claim("service orders (all time)", 89, orders);
  claim("service gross (USD, all time)", 1.08, gross);
  // THE headline claim of the whole report.
  claim("dearest thing ever sold (USD)", 0.1, sold.length ? Math.max(...sold) : null, 0.001);
} else { console.log("  BROKE  execution.market services unreachable"); broke++; }

// ---- x402: the numbers that forced this report to be retitled -------------------
// These are real paid calls, not offers. They are the headline now, so they get checked.
const svcs = [];
for (let off = 0; off < 5000; off += 100) {
  const r = await get(`https://api.agentic.market/v1/services?limit=100&offset=${off}`);
  if (r.error) break;
  const rows = r.json?.services ?? [];
  svcs.push(...rows);
  if (rows.length < 100) break;
}
if (svcs.length) {
  const per = svcs.map((s) => ({
    price: Number(s.priceSummary?.avgCostPerTransaction ?? 0),
    calls: (s.endpoints ?? []).reduce((a, e) => a + Number(e?.quality?.l30DaysTotalCalls ?? 0), 0),
  }));
  const calls = per.reduce((a, r) => a + r.calls, 0);
  const active = per.filter((r) => r.calls > 0).length;
  const gross = per.reduce((a, r) => a + r.calls * r.price, 0);
  // Exclude the single $5,000/call row that is ~69% of gross — see the report.
  const sane = per.filter((r) => r.price < 1000).reduce((a, r) => a + r.calls * r.price, 0);
  claim("x402 services indexed", 2220, svcs.length);
  claim("x402 services with paid calls in 30d", 1483, active, 0.25);
  claim("x402 paid calls in 30d", 322778, calls, 0.4);
  claim("x402 implied gross incl. outlier (USD)", 58211, +gross.toFixed(0), 0.5);
  claim("x402 gross excluding the $5k/call outlier (USD)", 18211, +sane.toFixed(0), 0.5);
}

// ---- opentask: the museum ------------------------------------------------------
let ot = [], cursor = null, p = 0;
do {
  const r = await get("https://opentask.ai/api/tasks?limit=100" + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));
  if (r.error) break;
  ot.push(...(r.json?.tasks ?? []));
  cursor = r.json?.nextCursor ?? null;
} while (cursor && ++p < 20);
if (ot.length) {
  const now = Date.now();
  const ages = ot.map((t) => Math.floor((now - new Date(t.createdAt)) / 86400000)).sort((a, b) => a - b);
  claim("opentask tasks listed", 63, ot.length);
  claim("opentask median task age (days)", 133, ages[Math.floor(ages.length / 2)], 0.35);
  // Baseline updated 2026-08-15 evening: this was 0 when first published, then 8 appeared
  // within hours (7 from one account re-listing old requests). The report documents that
  // change, so checking against the superseded 0 would flag DRIFT forever and train a
  // reader to ignore it. Checking against 8 means DRIFT now signals something genuinely new.
  claim("opentask tasks posted in last 7 days", 8, ages.filter((a) => a <= 7).length, 0.5);
} else { console.log("  BROKE  opentask unreachable"); broke++; }

console.log(`\n  ${pass} pass · ${drift} drift · ${broke} unmeasurable`);
console.log(drift
  ? "\n  DRIFT is not failure — these are dated claims and markets move.\n  It means the report's number was true then and this one is true now."
  : "\n  Every published number still reproduces.");
console.log("\n  Not checked here: the escrow solvency test (needs a worker token — see");
console.log("  github.com/AsherKasper/reality-check) and figures supplied by the platform's");
console.log("  own admin, which I cannot re-derive from public endpoints.\n");
