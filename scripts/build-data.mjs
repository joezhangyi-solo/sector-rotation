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

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
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
 * Industries are GICS sub-industries, computed bottom-up from the S&P 500
 * constituents: every member's official GICS classification comes from the
 * Wikipedia constituent list (with a committed snapshot as fallback), and
 * each sub-industry becomes an equal-weight composite of its members'
 * adjusted-close returns. That yields ~127 industries at Finviz-like
 * granularity while staying on the standard taxonomy.
 */
const SECTOR_BY_NAME = {
  "Materials":              "XLB",
  "Communication Services": "XLC",
  "Energy":                 "XLE",
  "Financials":             "XLF",
  "Industrials":            "XLI",
  "Information Technology": "XLK",
  "Consumer Staples":       "XLP",
  "Real Estate":            "XLRE",
  "Utilities":              "XLU",
  "Health Care":            "XLV",
  "Consumer Discretionary": "XLY",
};

const CONSTITUENTS_SNAPSHOT = resolve(ROOT, "scripts/sp500-constituents.json");
const CONSTITUENTS_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies";

// A handful of members are recent listings or flaky fetches; dropping a few
// barely moves an equal-weight composite, but a wide failure means the data
// source is broken and the run must die rather than ship thin composites.
const MAX_SKIPPED_STOCKS = 10;
const MIN_STOCK_BARS = 60;

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

async function fetchSeries(symbol, { minBars = 400, maxAttempts = 6 } = {}, attempt = 1) {
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
    if (rows.length < minBars) throw new Error(`only ${rows.length} bars returned`);
    return rows;
  } catch (err) {
    if (attempt >= maxAttempts) throw new Error(`${symbol}: ${err.message}`);
    const wait = Math.min(60000, 3000 * 2 ** (attempt - 1));
    console.log(`  ${symbol}: ${err.message} — retrying in ${wait / 1000}s`);
    await sleep(wait);
    return fetchSeries(symbol, { minBars, maxAttempts }, attempt + 1);
  }
}

/** Dev convenience: SR_CACHE=<dir> caches raw Yahoo responses between runs. */
async function getSeries(symbol, o) {
  const dir = process.env.SR_CACHE;
  if (dir) {
    try { return JSON.parse(await readFile(join(dir, symbol + ".json"), "utf8")); }
    catch { /* not cached yet */ }
  }
  const rows = await fetchSeries(symbol, o);
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, symbol + ".json"), JSON.stringify(rows));
  }
  return rows;
}

/* ----------------------------------------------------------- constituents */

/**
 * The S&P 500 membership with each stock's GICS sector and sub-industry,
 * parsed from Wikipedia's constituent table. On success the parsed list is
 * snapshotted next to the scripts; if the fetch or parse fails, the last
 * good snapshot is used so a Wikipedia hiccup can't kill the refresh.
 */
async function loadConstituents() {
  try {
    const res = await fetch(CONSTITUENTS_URL, {
      headers: { "User-Agent": "sectorrotation.joezhang.co data builder (joe.zhangyi@gmail.com)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const table = html.split(/<table[^>]*wikitable[^>]*>/)[1]?.split("</table>")[0];
    if (!table) throw new Error("constituent table not found");
    const strip = (s) =>
      s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").trim();

    const list = [];
    for (const row of table.split("<tr").slice(2)) {
      const cells = row.split(/<td[^>]*>/).slice(1).map((c) => strip(c.split(/<\/td>/)[0]));
      if (cells.length < 4) continue;
      const sector = SECTOR_BY_NAME[cells[2]];
      if (!sector) throw new Error(`unknown GICS sector "${cells[2]}" for ${cells[0]}`);
      // Yahoo uses dashes where the index uses dots (BRK.B -> BRK-B).
      list.push({ ticker: cells[0].replace(/\./g, "-"), sector, sub: cells[3] });
    }
    if (list.length < 480 || list.length > 530)
      throw new Error(`parsed ${list.length} constituents — page layout changed?`);

    await writeFile(CONSTITUENTS_SNAPSHOT, JSON.stringify(list, null, 1));
    console.log(`Constituents: ${list.length} from Wikipedia (snapshot refreshed)`);
    return list;
  } catch (err) {
    console.log(`Constituents: Wikipedia failed (${err.message}) — using snapshot`);
    const list = JSON.parse(await readFile(CONSTITUENTS_SNAPSHOT, "utf8"));
    console.log(`Constituents: ${list.length} from snapshot`);
    return list;
  }
}

const slugify = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

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
 * Groups constituents by GICS sub-industry and builds each group's
 * equal-weight composite level on the daily date axis: each day's composite
 * return is the mean adjusted-close return of the members that traded both
 * that day and the previous one, so a recent listing simply joins the mean
 * once its history begins.
 */
function buildComposites(constituents, adjByStock, dates) {
  const groups = {};
  for (const c of constituents) {
    if (!adjByStock[c.ticker]) continue; // fetch was skipped
    const slug = slugify(c.sub);
    (groups[slug] ??= { name: c.sub, sector: c.sector, members: [] }).members.push(c.ticker);
  }

  const levels = {};
  for (const [slug, g] of Object.entries(groups)) {
    const adjs = g.members.map((t) => adjByStock[t]);
    const map = {};
    let level = 100;
    for (let i = 0; i < dates.length; i++) {
      if (i > 0) {
        const d = dates[i], prev = dates[i - 1];
        let sum = 0, n = 0;
        for (const a of adjs) {
          const p0 = a[prev], p1 = a[d];
          if (p0 != null && p1 != null && p0 > 0) { sum += p1 / p0 - 1; n++; }
        }
        if (n > 0) level *= 1 + sum / n; // flat while no member has history yet
      }
      map[dates[i]] = level;
    }
    levels[slug] = map;
    g.members.sort();
  }
  return { groups, levels };
}

/**
 * Like buildFrame, but for the sub-industry composites, each measured
 * against BOTH the broad benchmark and its parent sector ETF. Points are
 * published as [x, y] pairs aligned 1:1 with the frame's date axis (the
 * dates would otherwise dominate the payload at ~127 industries x 2
 * benchmarks), and per-industry metadata lives once at the payload's top
 * level rather than in each frame.
 */
function buildIndustryFrame(mode, dates, groups, levels, adjBy, priceBy) {
  const p = PARAMS[mode];
  const keep = KEEP[mode];

  const computed = {};
  let firstUsable = 0;

  for (const [slug, g] of Object.entries(groups)) {
    computed[slug] = {};
    for (const [key, bench] of [["spy", BENCHMARK], ["sec", g.sector]]) {
      const rs = dates.map((d) => (100 * levels[slug][d]) / adjBy[bench][d]);
      const { ratio, mom } = rrg(rs, p);
      const first = ratio.findIndex((v, i) => v !== null && mom[i] !== null);
      if (first < 0) throw new Error(`${slug}: not enough history for ${mode} industry RRG`);
      firstUsable = Math.max(firstUsable, first);
      computed[slug][key] = { ratio, mom };
    }
  }

  const start = Math.max(firstUsable, dates.length - keep);
  const axis = dates.slice(start);

  const industries = {};
  for (const slug of Object.keys(groups)) {
    const ind = {};
    for (const key of ["spy", "sec"]) {
      const { ratio, mom } = computed[slug][key];
      ind[key] = axis.map((_, j) => [round3(ratio[start + j]), round3(mom[start + j])]);
    }
    ind.chg = round2(pctChange(levels[slug], axis));
    industries[slug] = ind;
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
  console.log(`Fetching ${sectorSyms.length} ETFs from Yahoo Finance…`);

  const series = {};
  for (const s of sectorSyms) {
    series[s] = await getSeries(s);
    process.stdout.write(`  ${s} ${series[s].length} bars\n`);
    await sleep(250);
  }

  const common = commonDates(series, sectorSyms);
  console.log(`${common.length} common trading days: ${common[0]} → ${common.at(-1)}`);

  const adjBy = {};
  const priceBy = {};
  for (const s of sectorSyms) {
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

  /* ---- industries: equal-weight GICS sub-industry composites ---- */

  const constituents = await loadConstituents();
  console.log(`Fetching ${constituents.length} constituents from Yahoo Finance…`);

  const adjByStock = {};
  const skipped = [];
  let done = 0;
  for (const c of constituents) {
    try {
      const rows = await getSeries(c.ticker, { minBars: MIN_STOCK_BARS, maxAttempts: 4 });
      adjByStock[c.ticker] = Object.fromEntries(rows.map((r) => [r.d, r.adj]));
    } catch (err) {
      skipped.push(c.ticker);
      console.log(`  skipping ${c.ticker}: ${err.message}`);
      if (skipped.length > MAX_SKIPPED_STOCKS)
        throw new Error(`${skipped.length} constituents unfetchable (${skipped.join(", ")}) — aborting`);
    }
    if (++done % 50 === 0) console.log(`  …${done}/${constituents.length}`);
    await sleep(150);
  }
  if (skipped.length) console.log(`Skipped ${skipped.length}: ${skipped.join(", ")}`);

  const { groups, levels } = buildComposites(constituents, adjByStock, common);
  console.log(`${Object.keys(groups).length} sub-industry composites from ${done - skipped.length} stocks`);

  const weeklyInd = buildIndustryFrame("weekly", weeklyDates(common), groups, levels, adjBy, priceBy);
  const dailyInd = buildIndustryFrame("daily", common, groups, levels, adjBy, priceBy);

  const industriesMeta = {};
  for (const [slug, g] of Object.entries(groups))
    industriesMeta[slug] = { name: g.name, sector: g.sector, members: g.members };

  const indPayload = {
    benchmark: BENCHMARK,
    generated: payload.generated,
    asof: dailyInd.asof,
    source: "Yahoo Finance · adjusted closes · GICS sub-industries via S&P 500 constituents",
    sectors: SECTORS,
    industries: industriesMeta,
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
