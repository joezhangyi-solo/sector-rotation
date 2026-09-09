#!/usr/bin/env node
/**
 * Builds public/data.json for sectorrotation.joezhang.co
 *
 * Source: Yahoo Finance chart API (keyless, split/dividend-adjusted closes).
 *
 * RRG maths — JdK-style RS-Ratio / RS-Momentum. Parameters were fitted to
 * reproduce the original hand-built chart (RMSE ~0.09 on a scale where the
 * plotted range spans roughly 98-102), so history stays continuous:
 *
 *   RS         = 100 * sector / benchmark
 *   ratioRaw   = 100 * ((EMA(RS,10) - EMA(RS,26)) / EMA(RS,26) + 1)
 *   RS-Ratio   = 100 + zscore(ratioRaw, W)            W = 52 weekly / 120 daily
 *   momRaw     = 100 * ((EMA(Ratio,M1) - EMA(Ratio,M2)) / EMA(Ratio,M2) + 1)
 *   RS-Moment. = 100 + zscore(momRaw, W2)             M/W2 = (2,3)/26 weekly
 *                                                            (2,6)/60 daily
 *
 * z-score uses the population standard deviation over a trailing window.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "public/data.json");
const OUT_IND = resolve(ROOT, "public/industries.json");

const BENCHMARK = "SPY";
const SECTORS = {
  XLB:  "Materials",
  XLC:  "Communication Services",
  XLE:  "Energy",
  XLF:  "Financials",
  XLI:  "Industrials",
  XLK:  "Technology",
  XLP:  "Consumer Staples",
  XLRE: "Real Estate",
  XLU:  "Utilities",
  XLV:  "Health Care",
  XLY:  "Consumer Discretionary",
};

/**
 * GICS-aligned industry ETFs, one level below the sector SPDRs. The backbone
 * is the SPDR S&P Select Industry family (same S&P/GICS taxonomy as the
 * sector funds, modified equal weight so the industry signal isn't one
 * megacap); GDX and JETS fill industries that family doesn't cover.
 * XLP, XLRE and XLU have no clean GICS industry ETF, so they have no rows.
 */
const INDUSTRIES = {
  XME:  { name: "Metals & Mining",         sector: "XLB" },
  GDX:  { name: "Gold Miners",             sector: "XLB" },
  XTL:  { name: "Telecom",                 sector: "XLC" },
  XOP:  { name: "Oil & Gas Exploration",   sector: "XLE" },
  XES:  { name: "Oil & Gas Equipment",     sector: "XLE" },
  KBE:  { name: "Banks",                   sector: "XLF" },
  KRE:  { name: "Regional Banks",          sector: "XLF" },
  KCE:  { name: "Capital Markets",         sector: "XLF" },
  KIE:  { name: "Insurance",               sector: "XLF" },
  XAR:  { name: "Aerospace & Defense",     sector: "XLI" },
  XTN:  { name: "Transportation",          sector: "XLI" },
  JETS: { name: "Airlines",                sector: "XLI" },
  XSD:  { name: "Semiconductors",          sector: "XLK" },
  XSW:  { name: "Software & Services",     sector: "XLK" },
  XBI:  { name: "Biotech",                 sector: "XLV" },
  XPH:  { name: "Pharmaceuticals",         sector: "XLV" },
  XHE:  { name: "Health Care Equipment",   sector: "XLV" },
  XHS:  { name: "Health Care Services",    sector: "XLV" },
  XRT:  { name: "Retail",                  sector: "XLY" },
  XHB:  { name: "Homebuilders",            sector: "XLY" },
};

// How many points of each series to publish (keeps data.json small).
const KEEP = { weekly: 120, daily: 160 };

const PARAMS = {
  weekly: { n1: 10, n2: 26, w: 52,  m1: 2, m2: 3, w2: 26 },
  daily:  { n1: 10, n2: 26, w: 120, m1: 2, m2: 6, w2: 60 },
};

/* ------------------------------------------------------------------ fetch */

// Yahoo throttles requests that carry a browser-like User-Agent far harder
// than it throttles Node's default one, so we deliberately send no UA header.
const HEADERS = { Accept: "application/json" };

const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];

async function fetchSeries(symbol, attempt = 1) {
  const host = HOSTS[(attempt - 1) % HOSTS.length];
  const url =
    `${host}/v8/finance/chart/${symbol}` +
    `?range=5y&interval=1d&events=div%2Csplit`;
  try {
    const res = await fetch(url, { headers: HEADERS });
    // Yahoo throttles bursts; back off hard rather than failing the whole run.
    if (res.status === 429) throw new Error("HTTP 429 (rate limited)");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const r = json?.chart?.result?.[0];
    if (!r?.timestamp) throw new Error("no timestamps in payload");

    const adj = r.indicators?.adjclose?.[0]?.adjclose;
    const close = r.indicators?.quote?.[0]?.close;
    if (!adj || !close) throw new Error("no price arrays in payload");

    const rows = [];
    for (let i = 0; i < r.timestamp.length; i++) {
      if (adj[i] == null || close[i] == null) continue;
      rows.push({ d: isoDateET(r.timestamp[i]), adj: adj[i], close: close[i] });
    }
    if (rows.length < 400) throw new Error(`only ${rows.length} bars returned`);
    return rows;
  } catch (err) {
    if (attempt >= 6) throw new Error(`${symbol}: ${err.message}`);
    const wait = Math.min(60000, 3000 * 2 ** (attempt - 1));
    console.log(`  ${symbol}: ${err.message} — retrying in ${wait / 1000}s`);
    await sleep(wait);
    return fetchSeries(symbol, attempt + 1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Yahoo stamps each daily bar at the exchange open; shift into ET before dating it. */
function isoDateET(unixSeconds) {
  return new Date((unixSeconds + 4 * 3600) * 1000).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------- math */

function ema(values, period) {
  const k = 2 / (period + 1);
  let prev = null;
  return values.map((v) => (prev = prev === null ? v : v * k + prev * (1 - k)));
}

/** 100 + (x - mean) / population stdev, over a trailing window of `w`. */
function zNorm(values, w) {
  return values.map((_, i) => {
    if (i < w - 1) return null;
    const win = values.slice(i - w + 1, i + 1);
    const mean = win.reduce((a, b) => a + b, 0) / w;
    const varc = win.reduce((a, b) => a + (b - mean) ** 2, 0) / w;
    const sd = Math.sqrt(varc);
    return sd > 1e-12 ? 100 + (values[i] - mean) / sd : 100;
  });
}

function crossRaw(values, fast, slow) {
  const f = ema(values, fast);
  const s = ema(values, slow);
  return values.map((_, i) => 100 * ((f[i] - s[i]) / s[i] + 1));
}

function rrg(rs, p) {
  const ratio = zNorm(crossRaw(rs, p.n1, p.n2), p.w);

  // Momentum is derived from the *normalised* ratio, so it only exists where
  // the ratio does. Compact first, then expand back to the full-length array.
  const idx = [];
  const seq = [];
  ratio.forEach((v, i) => { if (v !== null) { idx.push(i); seq.push(v); } });

  const mom = new Array(ratio.length).fill(null);
  if (seq.length) {
    const mz = zNorm(crossRaw(seq, p.m1, p.m2), p.w2);
    idx.forEach((i, j) => { mom[i] = mz[j]; });
  }
  return { ratio, mom };
}

const round3 = (n) => Math.round(n * 1000) / 1000;
const round2 = (n) => Math.round(n * 100) / 100;

/* -------------------------------------------------------------- resampling */

function isoWeekKey(iso) {
  const d = new Date(iso + "T00:00:00Z");
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = t.getUTCFullYear();
  const week = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-${String(week).padStart(2, "0")}`;
}

/** Last trading day of each ISO week; the final (partial) week is included. */
function weeklyDates(dates) {
  const out = [];
  for (let i = 0; i < dates.length; i++) {
    const isLast = i === dates.length - 1;
    if (isLast || isoWeekKey(dates[i]) !== isoWeekKey(dates[i + 1])) out.push(dates[i]);
  }
  return out;
}

/* ------------------------------------------------------------------ build */

function buildFrame(mode, dates, priceBy, adjBy) {
  const p = PARAMS[mode];
  const keep = KEEP[mode];
  const benchAdj = dates.map((d) => adjBy[BENCHMARK][d]);

  const sectors = {};
  let firstUsable = 0;

  for (const [sym, name] of Object.entries(SECTORS)) {
    const rs = dates.map((d, i) => (100 * adjBy[sym][d]) / benchAdj[i]);
    const { ratio, mom } = rrg(rs, p);
    const points = [];
    for (let i = 0; i < dates.length; i++) {
      if (ratio[i] === null || mom[i] === null) continue;
      points.push({ d: dates[i], x: round3(ratio[i]), y: round3(mom[i]) });
    }
    if (!points.length) throw new Error(`${sym}: not enough history for ${mode} RRG`);
    firstUsable = Math.max(firstUsable, dates.indexOf(points[0].d));
    sectors[sym] = { name, points };
  }

  // Every sector must share the same date axis, and only the tail is published.
  const axis = dates.slice(Math.max(firstUsable, dates.length - keep));
  const axisSet = new Set(axis);
  for (const sym of Object.keys(sectors)) {
    sectors[sym].points = sectors[sym].points.filter((pt) => axisSet.has(pt.d));
    sectors[sym].price = round2(priceBy[sym][axis.at(-1)]);
    sectors[sym].chg = round2(pctChange(priceBy[sym], axis));
  }

  return {
    dates: axis,
    asof: axis.at(-1),
    bench: {
      price: round2(priceBy[BENCHMARK][axis.at(-1)]),
      chg: round2(pctChange(priceBy[BENCHMARK], axis)),
    },
    sectors,
  };
}

/**
 * Like buildFrame, but for industry ETFs, each measured against BOTH the
 * broad benchmark and its parent sector ETF. Points are published as
 * [x, y] pairs aligned 1:1 with the frame's date axis (the dates would
 * otherwise dominate the payload at 20 industries x 2 benchmarks).
 */
function buildIndustryFrame(mode, dates, priceBy, adjBy) {
  const p = PARAMS[mode];
  const keep = KEEP[mode];

  const computed = {};
  let firstUsable = 0;

  for (const [sym, meta] of Object.entries(INDUSTRIES)) {
    computed[sym] = {};
    for (const [key, bench] of [["spy", BENCHMARK], ["sec", meta.sector]]) {
      const rs = dates.map((d) => (100 * adjBy[sym][d]) / adjBy[bench][d]);
      const { ratio, mom } = rrg(rs, p);
      const first = ratio.findIndex((v, i) => v !== null && mom[i] !== null);
      if (first < 0) throw new Error(`${sym}: not enough history for ${mode} industry RRG`);
      firstUsable = Math.max(firstUsable, first);
      computed[sym][key] = { ratio, mom };
    }
  }

  const start = Math.max(firstUsable, dates.length - keep);
  const axis = dates.slice(start);

  const industries = {};
  for (const [sym, meta] of Object.entries(INDUSTRIES)) {
    const ind = { name: meta.name, sector: meta.sector };
    for (const key of ["spy", "sec"]) {
      const { ratio, mom } = computed[sym][key];
      ind[key] = axis.map((_, j) => [round3(ratio[start + j]), round3(mom[start + j])]);
    }
    ind.price = round2(priceBy[sym][axis.at(-1)]);
    ind.chg = round2(pctChange(priceBy[sym], axis));
    industries[sym] = ind;
  }

  return {
    dates: axis,
    asof: axis.at(-1),
    bench: {
      price: round2(priceBy[BENCHMARK][axis.at(-1)]),
      chg: round2(pctChange(priceBy[BENCHMARK], axis)),
    },
    industries,
  };
}

/** Percent change across the final period of the axis (week-over-week or day-over-day). */
function pctChange(prices, axis) {
  const last = prices[axis.at(-1)];
  const prev = prices[axis.at(-2)];
  if (prev == null || !isFinite(prev) || prev === 0) return 0;
  return (100 * (last - prev)) / prev;
}

/** Dates every listed symbol traded on — guards against a single ETF's gap
 *  silently shifting one series against the others. */
function commonDates(series, symbols) {
  let common = series[BENCHMARK].map((r) => r.d);
  for (const s of symbols) {
    const have = new Set(series[s].map((r) => r.d));
    common = common.filter((d) => have.has(d));
  }
  return common.sort();
}

async function main() {
  const sectorSyms = [BENCHMARK, ...Object.keys(SECTORS)];
  const industrySyms = Object.keys(INDUSTRIES);
  const symbols = [...sectorSyms, ...industrySyms];
  console.log(`Fetching ${symbols.length} symbols from Yahoo Finance…`);

  const series = {};
  for (const s of symbols) {
    series[s] = await fetchSeries(s);
    process.stdout.write(`  ${s} ${series[s].length} bars\n`);
    await sleep(250);
  }

  // The sector axis intersects only sector symbols, so the existing product
  // never shrinks because one industry ETF skipped a day; the industry axis
  // intersects everything it plots (industries plus their benchmarks).
  const common = commonDates(series, sectorSyms);
  const commonInd = commonDates(series, symbols);
  console.log(`${common.length} common trading days: ${common[0]} → ${common.at(-1)}`);
  console.log(`${commonInd.length} shared with industry ETFs`);

  const adjBy = {};
  const priceBy = {};
  for (const s of symbols) {
    adjBy[s] = Object.fromEntries(series[s].map((r) => [r.d, r.adj]));
    priceBy[s] = Object.fromEntries(series[s].map((r) => [r.d, r.close]));
  }

  const weekly = buildFrame("weekly", weeklyDates(common), priceBy, adjBy);
  const daily = buildFrame("daily", common, priceBy, adjBy);

  const payload = {
    benchmark: BENCHMARK,
    generated: new Date().toISOString(),
    asof: daily.asof,
    source: "Yahoo Finance · adjusted closes",
    weekly,
    daily,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload));
  const kb = (JSON.stringify(payload).length / 1024).toFixed(0);
  console.log(`Wrote ${OUT} (${kb} KB) — as of ${payload.asof}`);

  const weeklyInd = buildIndustryFrame("weekly", weeklyDates(commonInd), priceBy, adjBy);
  const dailyInd = buildIndustryFrame("daily", commonInd, priceBy, adjBy);

  const indPayload = {
    benchmark: BENCHMARK,
    generated: payload.generated,
    asof: dailyInd.asof,
    source: payload.source,
    sectors: SECTORS,
    weekly: weeklyInd,
    daily: dailyInd,
  };

  await writeFile(OUT_IND, JSON.stringify(indPayload));
  const kbInd = (JSON.stringify(indPayload).length / 1024).toFixed(0);
  console.log(`Wrote ${OUT_IND} (${kbInd} KB) — as of ${indPayload.asof}`);
}

main().catch((err) => {
  console.error("build-data failed:", err.message);
  process.exit(1);
});
