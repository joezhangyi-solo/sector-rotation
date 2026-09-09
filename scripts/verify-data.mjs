#!/usr/bin/env node
/**
 * Guard rail for the scheduled refresh: refuses to let a malformed or stale
 * payload reach production. Exits non-zero (failing the workflow) on any
 * problem, which leaves the previously deployed data files in place.
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_SECTORS = 11;
const EXPECTED_INDUSTRIES = 20;
const MAX_AGE_DAYS = 5;   // long weekends plus a holiday

const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); };

const plausible = (x, y) =>
  Number.isFinite(x) && Number.isFinite(y) &&
  Math.abs(x - 100) <= 12 && Math.abs(y - 100) <= 12;

function checkCommon(label, data) {
  check(data.benchmark === "SPY", `${label}: benchmark is ${data.benchmark}, expected SPY`);
  check(typeof data.asof === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.asof),
        `${label}: asof is not an ISO date: ${data.asof}`);

  const ageDays = Math.floor((Date.now() - Date.parse(data.asof + "T21:00:00Z")) / 86400000);
  check(ageDays <= MAX_AGE_DAYS, `${label}: data is ${ageDays} days old (limit ${MAX_AGE_DAYS})`);
  check(ageDays >= -1, `${label}: data is dated in the future (${data.asof})`);
}

function checkFrame(label, f, mode) {
  check(!!f, `${label}/${mode}: frame missing`);
  if (!f) return false;
  check(f.dates.length >= 60, `${label}/${mode}: only ${f.dates.length} dates`);
  check(f.asof === f.dates.at(-1), `${label}/${mode}: asof does not match last date`);
  check(Number.isFinite(f.bench?.price) && f.bench.price > 0, `${label}/${mode}: bad benchmark price`);
  return true;
}

/* ------------------------------------------------------------ data.json */

const data = JSON.parse(await readFile(resolve(ROOT, "public/data.json"), "utf8"));
checkCommon("data.json", data);

for (const mode of ["weekly", "daily"]) {
  const f = data[mode];
  if (!checkFrame("data.json", f, mode)) continue;

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
    const bad = s.points.find((p) => !plausible(p.x, p.y));
    check(!bad, `${mode}/${sym}: implausible coordinate ${JSON.stringify(bad)}`);
  }
}

/* ------------------------------------------------------ industries.json */

const ind = JSON.parse(await readFile(resolve(ROOT, "public/industries.json"), "utf8"));
checkCommon("industries.json", ind);
check(ind.asof === data.asof,
      `industries.json asof ${ind.asof} does not match data.json ${data.asof}`);

for (const mode of ["weekly", "daily"]) {
  const f = ind[mode];
  if (!checkFrame("industries.json", f, mode)) continue;

  const syms = Object.keys(f.industries ?? {});
  check(syms.length === EXPECTED_INDUSTRIES,
        `industries/${mode}: ${syms.length} industries, expected ${EXPECTED_INDUSTRIES}`);

  for (const sym of syms) {
    const s = f.industries[sym];
    check(!!ind.sectors?.[s.sector], `industries/${mode}/${sym}: unknown sector ${s.sector}`);
    check(Number.isFinite(s.price) && s.price > 0, `industries/${mode}/${sym}: bad price ${s.price}`);
    for (const key of ["spy", "sec"]) {
      const pts = s[key];
      check(Array.isArray(pts) && pts.length === f.dates.length,
            `industries/${mode}/${sym}.${key}: ${pts?.length} points against ${f.dates.length} dates`);
      const bad = (pts ?? []).find((p) => !plausible(p[0], p[1]));
      check(!bad, `industries/${mode}/${sym}.${key}: implausible coordinate ${JSON.stringify(bad)}`);
    }
  }
}

if (problems.length) {
  console.error("data verification failed:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(`data.json OK — ${data.asof}, ${data.weekly.dates.length} weekly / ${data.daily.dates.length} daily points`);
console.log(`industries.json OK — ${ind.asof}, ${Object.keys(ind.daily.industries).length} industries`);
