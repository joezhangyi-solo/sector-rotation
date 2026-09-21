#!/usr/bin/env node
/**
 * Daily rotation briefing — turns the RRG payloads into a written read.
 *
 * Reads public/data.json (11 sector SPDRs) and public/industries.json (~127
 * GICS sub-industries) and answers the three questions the morning brief asks:
 * what is the weekly trend, what is improving and leading, what is decelerating.
 *
 *   node scripts/rotation-brief.mjs                 # markdown, local payloads
 *   node scripts/rotation-brief.mjs --remote        # fetch the live site instead
 *   node scripts/rotation-brief.mjs --format json   # structured, for a Notion push
 *
 * Nothing here re-derives the RRG maths — that lives in build-data.mjs and its
 * parameters are fitted (see README). This only reads the published points.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE = "https://sectorrotation.joezhang.co";

/* ----------------------------------------------------------------- reading */

async function load({ remote }) {
  if (remote) {
    const grab = async (f) => {
      const res = await fetch(`${REMOTE}/${f}`, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
      return res.json();
    };
    const [sectors, industries] = await Promise.all([grab("data.json"), grab("industries.json")]);
    return { sectors, industries, origin: REMOTE };
  }
  const grab = async (f) => JSON.parse(await readFile(resolve(ROOT, "public", f), "utf8"));
  const [sectors, industries] = await Promise.all([grab("data.json"), grab("industries.json")]);
  return { sectors, industries, origin: "public/" };
}

/* --------------------------------------------------------------- rotation */

// RRG convention: the benchmark sits at (100,100) and names rotate clockwise
// Improving -> Leading -> Weakening -> Lagging.
function quadrant(x, y) {
  if (x >= 100 && y >= 100) return "Leading";
  if (x >= 100 && y < 100) return "Weakening";
  if (x < 100 && y < 100) return "Lagging";
  return "Improving";
}

const round = (n, p = 3) => (n == null || Number.isNaN(n) ? null : Number(n.toFixed(p)));

/**
 * Everything the write-up needs about one series of [x,y] points.
 * `lookback` is in bars of whichever frame was passed in (weeks or days).
 */
function describe(points, { lookback = 4 } = {}) {
  const n = points.length;
  if (n < 2) return null;
  const at = (i) => points[Math.max(0, n - 1 - i)];

  const [x, y] = at(0);
  const [px, py] = at(1);
  const [bx, by] = at(Math.min(lookback, n - 1));

  const dx = x - px;
  const dy = y - py;
  const q = quadrant(x, y);
  const qPrev = quadrant(px, py);

  // Heading in RRG degrees: 0 = due east (gaining relative strength, flat
  // momentum), 90 = due north. Only meaningful when the tail actually moved.
  const speed = Math.hypot(dx, dy);
  const heading = speed < 1e-6 ? null : ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;

  return {
    x: round(x),
    y: round(y),
    quadrant: q,
    crossedInto: q !== qPrev ? q : null,
    crossedFrom: q !== qPrev ? qPrev : null,
    dx: round(dx),
    dy: round(dy),
    dxLookback: round(x - bx),
    dyLookback: round(y - by),
    speed: round(speed),
    heading: round(heading, 1),
    distance: round(Math.hypot(x - 100, y - 100)),
    state: classify(q, dx, dy),
  };
}

/**
 * The quadrant says where a name is; the tail says what it is doing. Joe's
 * brief turns on the second question — a Leading sector with momentum rolling
 * over is the one worth naming, not the one still climbing.
 */
function classify(q, dx, dy) {
  const rising = dy >= 0;
  if (q === "Leading") return rising ? "Leading — strengthening" : "Leading — decelerating";
  if (q === "Improving") return rising ? "Improving — gaining" : "Improving — stalling";
  if (q === "Weakening") return rising ? "Weakening — stabilising" : "Weakening — deteriorating";
  return rising ? "Lagging — bottoming" : "Lagging — deteriorating";
}

const DECELERATING = new Set([
  "Leading — decelerating",
  "Improving — stalling",
  "Weakening — deteriorating",
]);

/* ------------------------------------------------------------- assembling */

function analyseSectors(data, frame) {
  const f = data[frame];
  const rows = Object.entries(f.sectors).map(([sym, s]) => {
    const pts = s.points.map((p) => [p.x, p.y]);
    return {
      symbol: sym,
      name: s.name,
      price: s.price ?? null,
      chg: s.chg ?? null,
      ...describe(pts),
    };
  });
  rows.sort((a, b) => b.x - a.x);
  return rows;
}

function analyseIndustries(data, frame, bench) {
  const f = data[frame];
  const rows = [];
  for (const [slug, series] of Object.entries(f.industries)) {
    const meta = data.industries[slug];
    if (!meta) continue;
    const pts = series[bench];
    if (!pts || pts.length < 2) continue;
    const d = describe(pts);
    if (!d) continue;
    rows.push({
      slug,
      name: meta.name,
      sector: meta.sector,
      sectorName: data.sectors[meta.sector] ?? meta.sector,
      members: meta.members?.length ?? null,
      chg: series.chg ?? null,
      ...d,
    });
  }
  rows.sort((a, b) => b.x - a.x);
  return rows;
}

/** Thin composites are noisy; a 1-2 member "industry" is really one stock. */
const meaningful = (r) => (r.members ?? 0) >= 3;

function rank(rows, { min = 3 } = {}) {
  const pool = rows.filter((r) => (r.members ?? min) >= min);
  const inQ = (...qs) => pool.filter((r) => qs.includes(r.quadrant));

  return {
    leading: inQ("Leading")
      .slice()
      .sort((a, b) => b.distance - a.distance)
      .slice(0, 10),
    improving: inQ("Improving")
      .filter((r) => r.dy > 0)
      .sort((a, b) => b.dy - a.dy)
      .slice(0, 10),
    decelerating: pool
      .filter((r) => DECELERATING.has(r.state))
      .sort((a, b) => a.dy - b.dy)
      .slice(0, 10),
    // Quadrant changes are the events — everything else is drift.
    crossings: pool.filter((r) => r.crossedInto),
    // Biggest one-week swings in relative strength, either way.
    accelerating: pool.slice().sort((a, b) => b.dy - a.dy).slice(0, 8),
    fading: pool.slice().sort((a, b) => a.dy - b.dy).slice(0, 8),
  };
}

/* --------------------------------------------------------------- reporting */

const pct = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
const sgn = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}`);
const QUAD_MARK = { Leading: "🟢", Improving: "🔵", Weakening: "🟡", Lagging: "🔴" };

function markdown(report) {
  const L = [];
  const { asof, generated, sectors, industries, daily } = report;

  L.push(`# Sector rotation — week ending ${asof}`);
  L.push("");
  L.push(
    `Weekly RRG vs ${report.benchmark}. ${report.headline}`
  );
  L.push("");

  /* ---- sectors */
  L.push("## Sectors — the weekly frame");
  L.push("");
  L.push("| Sector | Quadrant | RS-Ratio | Momentum | Δ1w ratio | Δ1w mom | State | Wk % |");
  L.push("|---|---|---:|---:|---:|---:|---|---:|");
  for (const s of sectors.rows) {
    L.push(
      `| **${s.symbol}** ${s.name} | ${QUAD_MARK[s.quadrant]} ${s.quadrant} | ${s.x.toFixed(2)} | ${s.y.toFixed(
        2
      )} | ${sgn(s.dx)} | ${sgn(s.dy)} | ${s.state} | ${pct(s.chg)} |`
    );
  }
  L.push("");

  if (sectors.crossings.length) {
    L.push("### Quadrant changes this week");
    L.push("");
    for (const s of sectors.crossings) {
      L.push(`- **${s.symbol} ${s.name}** — ${s.crossedFrom} → ${QUAD_MARK[s.quadrant]} **${s.crossedInto}**`);
    }
    L.push("");
  }

  const lead = sectors.rows.filter((s) => s.quadrant === "Leading");
  const impr = sectors.rows.filter((s) => s.quadrant === "Improving");
  const dec = sectors.rows.filter((s) => DECELERATING.has(s.state));

  L.push("### Improving and leading");
  L.push("");
  if (lead.length)
    L.push(
      `- **Leading:** ${lead
        .map((s) => `${s.symbol} (${s.x.toFixed(2)}/${s.y.toFixed(2)}, ${s.dy >= 0 ? "still gaining" : "momentum rolling over"})`)
        .join(", ")}`
    );
  if (impr.length)
    L.push(
      `- **Improving:** ${impr
        .map((s) => `${s.symbol} (${s.x.toFixed(2)}/${s.y.toFixed(2)}, mom ${sgn(s.dy)})`)
        .join(", ")}`
    );
  if (!lead.length && !impr.length) L.push("- Nothing in the right-hand or improving quadrants this week.");
  L.push("");

  L.push("### Decelerating");
  L.push("");
  if (dec.length) {
    for (const s of dec) {
      L.push(
        `- **${s.symbol} ${s.name}** — ${s.state}. Momentum ${sgn(s.dy)} on the week, ratio ${sgn(s.dx)}.`
      );
    }
  } else {
    L.push("- No sector is losing momentum inside a constructive quadrant.");
  }
  L.push("");

  /* ---- industries */
  for (const [key, label, note] of [
    ["spy", "vs SPY", "cross-market ranking — where the money actually is"],
    ["sec", "vs parent sector", "who is carrying its own sector, and who is a drag"],
  ]) {
    const block = industries[key];
    L.push(`## Sub-industries ${label}`);
    L.push("");
    L.push(`_${note}. ${block.universe} composites with 3+ members._`);
    L.push("");

    L.push("**Leading (deepest into the leading quadrant)**");
    L.push("");
    L.push("| Industry | Sector | RS-Ratio | Momentum | Δ1w mom | State |");
    L.push("|---|---|---:|---:|---:|---|");
    for (const r of block.leading)
      L.push(
        `| ${r.name} | ${r.sector} | ${r.x.toFixed(2)} | ${r.y.toFixed(2)} | ${sgn(r.dy)} | ${r.state} |`
      );
    L.push("");

    L.push("**Improving (strongest momentum gain from below the line)**");
    L.push("");
    L.push("| Industry | Sector | RS-Ratio | Momentum | Δ1w mom |");
    L.push("|---|---|---:|---:|---:|");
    for (const r of block.improving)
      L.push(`| ${r.name} | ${r.sector} | ${r.x.toFixed(2)} | ${r.y.toFixed(2)} | ${sgn(r.dy)} |`);
    L.push("");

    L.push("**Decelerating (losing momentum, ranked by how fast)**");
    L.push("");
    L.push("| Industry | Sector | RS-Ratio | Momentum | Δ1w mom | State |");
    L.push("|---|---|---:|---:|---:|---|");
    for (const r of block.decelerating)
      L.push(
        `| ${r.name} | ${r.sector} | ${r.x.toFixed(2)} | ${r.y.toFixed(2)} | ${sgn(r.dy)} | ${r.state} |`
      );
    L.push("");

    if (block.crossings.length) {
      L.push(`**Quadrant changes** — ${block.crossings.length} this week`);
      L.push("");
      for (const r of block.crossings.slice(0, 15))
        L.push(`- ${r.name} (${r.sector}): ${r.crossedFrom} → ${r.crossedInto}`);
      L.push("");
    }
  }

  /* ---- daily overlay */
  L.push("## Daily frame — early warning");
  L.push("");
  L.push(
    `_The weekly frame is the trend; the daily frame turns first. Sectors where the two disagree are the ones to watch._`
  );
  L.push("");
  if (daily.disagreements.length) {
    L.push("| Sector | Weekly | Daily | | Read |");
    L.push("|---|---|---|:-:|---|");
    const mark = { up: "▲", down: "▼", mixed: "◆" };
    for (const d of daily.disagreements)
      L.push(
        `| **${d.symbol}** ${d.name} | ${d.weekly} (${d.weeklyPoint[0].toFixed(2)}/${d.weeklyPoint[1].toFixed(2)}) ` +
          `| ${d.daily} (${d.dailyPoint[0].toFixed(2)}/${d.dailyPoint[1].toFixed(2)}) | ${mark[d.direction]} | ${d.read} |`
      );
  } else {
    L.push("Daily and weekly quadrants agree across all eleven sectors — no divergence to flag.");
  }
  L.push("");

  L.push("---");
  L.push("");
  L.push(
    `Source: sectorrotation.joezhang.co · RRG data as of ${asof} (payload generated ${generated}) · ` +
      `RS-Ratio / RS-Momentum on dividend-adjusted closes, benchmark ${report.benchmark}. Not investment advice.`
  );

  return L.join("\n");
}

/* ------------------------------------------------------------------- read */

function headline(sectorRows, crossings) {
  const lead = sectorRows.filter((s) => s.quadrant === "Leading");
  const impr = sectorRows.filter((s) => s.quadrant === "Improving");
  const rolling = lead.filter((s) => s.dy < 0);

  const bits = [];
  bits.push(
    lead.length
      ? `${lead.map((s) => s.symbol).join(", ")} lead`
      : "nothing holds the leading quadrant"
  );
  if (impr.length) bits.push(`${impr.map((s) => s.symbol).join(", ")} improving`);
  if (rolling.length)
    bits.push(`momentum rolling over in ${rolling.map((s) => s.symbol).join(", ")}`);
  if (crossings.length)
    bits.push(`${crossings.length} quadrant change${crossings.length > 1 ? "s" : ""}`);
  return bits.join("; ") + ".";
}

/**
 * The weekly frame is the trend, the daily frame turns first. A divergence is
 * only worth naming when an *axis* disagrees — the daily point sits on the
 * other side of a 100 line from the weekly one. Comparing quadrant names by
 * their position in the rotation cycle does not work: the cycle wraps, so
 * Leading -> Weakening and Weakening -> Improving come out backwards.
 */
function dailyOverlay(data) {
  const w = analyseSectors(data, "weekly");
  const d = analyseSectors(data, "daily");
  const bySym = Object.fromEntries(d.map((r) => [r.symbol, r]));

  const out = [];
  for (const s of w) {
    const dr = bySym[s.symbol];
    if (!dr) continue;

    const notes = [];
    // Momentum (y) is the fast axis and the one that gives the early warning.
    if (dr.y >= 100 && s.y < 100)
      notes.push({ dir: "up", text: "daily momentum has crossed back above the benchmark — a weekly turn may follow" });
    if (dr.y < 100 && s.y >= 100)
      notes.push({ dir: "down", text: "daily momentum has rolled below the benchmark while the weekly is still above — early warning" });
    // Relative strength (x) is the slow axis; a flip here is a bigger deal.
    if (dr.x >= 100 && s.x < 100)
      notes.push({ dir: "up", text: "daily relative strength has crossed above SPY ahead of the weekly" });
    if (dr.x < 100 && s.x >= 100)
      notes.push({ dir: "down", text: "daily relative strength has slipped below SPY while the weekly still leads" });

    if (!notes.length) continue;
    out.push({
      symbol: s.symbol,
      name: s.name,
      weekly: s.quadrant,
      daily: dr.quadrant,
      weeklyPoint: [s.x, s.y],
      dailyPoint: [dr.x, dr.y],
      direction: notes.every((n) => n.dir === "up")
        ? "up"
        : notes.every((n) => n.dir === "down")
        ? "down"
        : "mixed",
      read: notes.map((n) => n.text).join("; "),
    });
  }
  // Deteriorations first — they are the ones that cost money.
  const order = { down: 0, mixed: 1, up: 2 };
  out.sort((a, b) => order[a.direction] - order[b.direction]);
  return { rows: d, disagreements: out };
}

/* ------------------------------------------------------------------- main */

async function main() {
  const argv = process.argv.slice(2);
  const remote = argv.includes("--remote");
  const fmtArg = argv.indexOf("--format");
  const format = fmtArg >= 0 ? argv[fmtArg + 1] : "markdown";

  const { sectors: sData, industries: iData, origin } = await load({ remote });

  if (sData.asof !== iData.asof) {
    console.error(
      `warning: sector payload is ${sData.asof} but industry payload is ${iData.asof} — they were built from different runs`
    );
  }

  const sectorRows = analyseSectors(sData, "weekly");
  const sectorCross = sectorRows.filter((r) => r.crossedInto);

  const indSpy = analyseIndustries(iData, "weekly", "spy");
  const indSec = analyseIndustries(iData, "weekly", "sec");
  const universe = indSpy.filter(meaningful).length;

  const report = {
    asof: sData.asof,
    generated: sData.generated,
    benchmark: sData.benchmark,
    origin,
    frame: "weekly",
    headline: headline(sectorRows, sectorCross),
    bench: sData.weekly.bench,
    sectors: { rows: sectorRows, crossings: sectorCross, ...rank(sectorRows, { min: 0 }) },
    industries: {
      spy: { universe, ...rank(indSpy), rows: indSpy },
      sec: { universe, ...rank(indSec), rows: indSec },
    },
    daily: dailyOverlay(sData),
  };

  if (format === "json") {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else if (format === "both") {
    process.stdout.write(JSON.stringify({ ...report, markdown: markdown(report) }, null, 2) + "\n");
  } else {
    process.stdout.write(markdown(report) + "\n");
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
