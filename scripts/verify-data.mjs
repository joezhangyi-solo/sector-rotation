#!/usr/bin/env node
/**
 * Guard rail for the scheduled refresh: refuses to let a malformed or stale
 * payload reach production. Exits non-zero (failing the workflow) on any
 * problem, which leaves the previously deployed data.json in place.
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../public/data.json");
const EXPECTED_SECTORS = 11;
const MAX_AGE_DAYS = 5;   // long weekends plus a holiday

const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); };

const data = JSON.parse(await readFile(FILE, "utf8"));

check(data.benchmark === "SPY", `benchmark is ${data.benchmark}, expected SPY`);
check(typeof data.asof === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.asof),
      `asof is not an ISO date: ${data.asof}`);

const ageDays = Math.floor((Date.now() - Date.parse(data.asof + "T21:00:00Z")) / 86400000);
check(ageDays <= MAX_AGE_DAYS, `data is ${ageDays} days old (limit ${MAX_AGE_DAYS})`);
check(ageDays >= -1, `data is dated in the future (${data.asof})`);

for (const mode of ["weekly", "daily"]) {
  const f = data[mode];
  check(!!f, `${mode} frame missing`);
  if (!f) continue;

  check(f.dates.length >= 60, `${mode}: only ${f.dates.length} dates`);
  check(f.asof === f.dates.at(-1), `${mode}: asof does not match last date`);
  check(Number.isFinite(f.bench?.price) && f.bench.price > 0, `${mode}: bad benchmark price`);

  const syms = Object.keys(f.sectors ?? {});
  check(syms.length === EXPECTED_SECTORS,
        `${mode}: ${syms.length} sectors, expected ${EXPECTED_SECTORS}`);

  for (const sym of syms) {
    const s = f.sectors[sym];
    check(s.points.length === f.dates.length,
          `${mode}/${sym}: ${s.points.length} points against ${f.dates.length} dates`);
    check(s.points.at(-1)?.d === f.asof, `${mode}/${sym}: last point is not asof`);
    check(Number.isFinite(s.price) && s.price > 0, `${mode}/${sym}: bad price ${s.price}`);
    // RRG coordinates are z-scores around 100; anything far outside means the
    // normalisation went wrong rather than the market doing something dramatic.
    const bad = s.points.find(
      (p) => !Number.isFinite(p.x) || !Number.isFinite(p.y) ||
             Math.abs(p.x - 100) > 12 || Math.abs(p.y - 100) > 12
    );
    check(!bad, `${mode}/${sym}: implausible coordinate ${JSON.stringify(bad)}`);
  }
}

if (problems.length) {
  console.error("data.json failed verification:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(`data.json OK — ${data.asof}, ${data.weekly.dates.length} weekly / ${data.daily.dates.length} daily points`);
