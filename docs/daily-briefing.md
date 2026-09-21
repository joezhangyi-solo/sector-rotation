# Daily Market Briefing — routine instructions

These are the standing instructions for the `daily-market-briefing` cloud
routine. The routine's own prompt is deliberately short: it clones this repo
and tells the agent to read and follow this file. That keeps the routine
version-controlled — edit this file, merge to `main`, and the next run picks
up the change without touching the API.

**Run context.** A sandboxed cloud session, ~07:00 Asia/Singapore, Mon–Fri
(23:00 UTC Sun–Thu). There is no access to Joe's Mac, no local files, and no
IBKR connector — the positions monitor runs separately as a local task.

**Output.** One page per session in the Notion database **Daily Market
Briefing**, data source `856c8131-8f3a-4737-9a8e-63c7021c2b14`.

**Connectors used.** Intrinio (prices, market caps), FMP (mover discovery,
index quotes, holidays), Notion (output), plus WebSearch for catalysts.

---

## Step 0 — Fix the session

Run `date -u` for the real current time; never infer it.

The brief covers the **most recent completed US trading session**. At 23:00
UTC on a weekday the same day's US session has already closed (16:00 ET =
20:00/21:00 UTC), so that is normally today's UTC date. On the Sunday-night
fire the answer is the preceding Friday. Skip NYSE holidays — check
`marketHours` on the FMP connector rather than guessing.

State the session date explicitly in the page. Every number in the brief must
belong to that one session.

## Data sources — what actually works

Established by a live test run on 2026-09-21. Do not rediscover this each
morning; it cost ~30 wasted calls the first time.

| Need | Use | Notes |
|---|---|---|
| Rotation | `scripts/rotation-brief.mjs` on the checkout | See Step 1 |
| S&P 500 membership | `scripts/sp500-constituents.json` in this repo | 503 names with GICS sector + sub-industry, refreshed by the data workflow |
| Session price + % change | **Intrinio** `get_stock_prices_eod_batch` | 50 tickers/call, close-over-close `percent_change` as a decimal |
| Market cap | **Intrinio** `get_company_daily_metrics_batch` | 50 tickers/call, `on_date` = session date |
| SMID mover discovery | **FMP** `marketPerformance` biggest-gainers / biggest-losers | Works on this plan |
| Sector snapshot | **FMP** `marketPerformance` sector-performance-snapshot | Works |
| Index levels | **FMP** `indexes` **index-quote** (one symbol per call) | Works |
| Holidays | **FMP** `marketHours` holidays-by-exchange | Works |
| Catalysts | **WebSearch** / WebFetch | FMP news is gated |

**FMP endpoints that are gated on this account — do not call them.** The whole
`quote` tool (including `batch-quote` and `batch-quote-short`), `indexes`
`sp-500`, the `search` tool, and the `news` tool. `chart`
`historical-price-eod-full` and `company` `batch-market-cap` are entitled for
only a small subset of tickers and deny the rest, so they are useless for a
broad screen — and `historical-price-eod-full` reports change against the
session's *open*, not the previous close, which is the wrong number anyway.

Intrinio's index-constituent endpoint is also not entitled, which is why
membership comes from this repo rather than from an API.

## Step 1 — Sector and sub-industry rotation

```bash
node scripts/rotation-brief.mjs --format both > /tmp/rotation.json
```

Read the committed payloads in `public/`. They are rebuilt and committed by
the refresh workflow at 21:35 UTC, before this routine fires at 23:00 UTC, so
the checkout is current.

**Do not pass `--remote` here.** The sandbox's egress policy blocks
sectorrotation.joezhang.co and the fetch fails with a 403 CONNECT. That flag
exists for manual runs on Joe's machine, where the checkout may be stale.

The `both` format returns the full structured report plus a rendered
`markdown` field. The script emits, on the **weekly** RRG frame vs SPY:

- all eleven sector SPDRs with quadrant, RS-Ratio, RS-Momentum, one-week
  deltas, and a state label,
- `Leading — decelerating` / `Improving — stalling` style classifications,
  which are the point of the exercise: a leading sector whose momentum is
  rolling over is the one worth naming,
- the ~74 GICS sub-industry composites with three or more members, ranked
  into leading / improving / decelerating, both vs SPY and vs parent sector,
- quadrant crossings for the week — the events, as against the drift,
- a daily-frame overlay flagging sectors whose daily point has crossed a 100
  line the weekly has not, which is the early warning.

**Check `asof` before writing anything.** If it is more than four days older
than the session date, the refresh has failed; say so plainly at the top of
the Notion page instead of presenting stale rotation as current.

Do not recompute the RRG maths. The parameters were fitted to reproduce Joe's
original chart and live in `scripts/build-data.mjs`.

## Step 2 — Large-cap movers (market cap > $10B)

Prices and market caps come from **Intrinio**, and they are the sole source of
truth for every ticker, direction, percentage and price. News never selects a
ticker; it only explains one already selected here.

1. Read `scripts/sp500-constituents.json` for the 503-name universe. Add the
   major non-S&P US-listed large caps and ADRs Joe follows: TSM, ASML, SHOP,
   SE, MELI, ARM.
2. Chunk into 50s and call `get_stock_prices_eod_batch` with `start_date` and
   `end_date` both set to the session date. Take `close` and `percent_change`
   (a decimal — `-0.0473` is −4.73%). About 11 calls.
3. Chunk into 50s again and call `get_company_daily_metrics_batch` with
   `on_date` = the session date for `market_cap`. About 11 calls.
4. Screen `market_cap > 10e9`, rank by `|percent_change|`, and split into
   gainers and decliners.

Do the chunking, screening and ranking in a script, not by eye. Target 15+
gainers and 15+ decliners when the session supports it.

If a handful of tickers come back empty, drop them and note the count. If more
than about 10% fail, say so in the page rather than presenting a thin screen
as complete.

## Step 3 — SMID movers (market cap < $10B)

Discovery from **FMP**, market caps from **Intrinio**.

1. Pull `marketPerformance` biggest-gainers and biggest-losers.
2. Filter out warrants, rights, units, SPAC shells, leveraged and inverse
   single-stock ETFs, and anything that is not common stock; require price
   ≥ $1.
3. Batch the survivors through Intrinio `get_company_daily_metrics_batch`
   (`on_date` = session date) for market cap, and split:
   - **Tier 2** — $1–10B
   - **Tier 3** — under $1B, floor $25M
4. Sub-floor and illiquid micro-caps go in a short "flagged exceptions" note,
   not the ranked tables.

If Intrinio has no market cap for a name — common for recent listings and
foreign small caps — put it in the flagged exceptions note rather than
guessing its tier.

## Step 4 — Catalysts and the Bucket A/B split

Only now does news enter, and only to explain tickers already selected from
FMP data. Research each carded mover and classify:

- **Bucket A — substance.** Earnings, guidance, a bid, a contract, an
  FDA or regulatory decision, a capital-allocation action.
- **Bucket B — story.** Sympathy moves, rotation, read-across, an
  upgrade or downgrade, positioning.

Cite the article behind every Bucket A claim. If no catalyst can be found,
say so — "no identifiable catalyst" is an honest and useful answer, and is
itself a Bucket B signal.

Index backdrop comes from FMP `indexes` / `index-quote`, one call each for
`^GSPC`, `^IXIC`, `^DJI` and `^RUT`, plus `sector-performance-snapshot`. The
multi-symbol form is gated, so call them singly.

## Step 5 — Write the Notion page

Create **one page** in data source `856c8131-8f3a-4737-9a8e-63c7021c2b14`.

Properties:

| Property | Value |
|---|---|
| `Brief` (title) | `Sep 18, 2026 — XLV/XLE lead, momentum rolling over` — session date, then the rotation read in a few words |
| `Session Date` | the completed session |
| `Prepared` | run timestamp, as a datetime |
| `Tape` | one line: S&P / Nasdaq / Dow / Russell moves |
| `S&P 500 %` | the session's S&P change, as a decimal fraction (`-0.0043` for −0.43%) |
| `Rotation Read` | the script's `headline` field |
| `Leading` | sector symbols in the leading quadrant, with a note on any whose momentum is falling |
| `Improving` | sector symbols in the improving quadrant |
| `Decelerating` | sectors carrying a `— decelerating` or `— stalling` state |
| `Quadrant Changes` | sector crossings + sub-industry crossings vs SPY |
| `Top Sub-Industry` | the strongest improving sub-industry vs SPY, with its momentum delta |
| `Substance Move` | the standout Bucket A mover — ticker, move, one clause of why |
| `Story Move` | the standout Bucket B mover, same shape |
| `RRG As Of` | the payload's `asof` |

Page body, in this order:

1. **Rotation — the weekly trend.** Lead with it; this is the frame the rest
   of the brief sits inside. Use the script's rendered markdown, trimmed to
   the sector table, the improving/leading/decelerating read, the top
   sub-industry tables, quadrant changes, and the daily-frame divergences.
   Add two or three sentences of interpretation tying rotation to the day's
   tape — whether the day's movers confirm or contradict the weekly trend is
   the single most useful thing this brief can say.
2. **Large-cap movers.** Bucket A first, then Bucket B, then a ranked
   remainder table.
3. **SMID movers.** Tier 2 then Tier 3, same bucket ordering, plus the
   flagged exceptions note.
4. **Takeaway.** Three or four sentences: the standout substance move, the
   standout story move, and what the rotation says about where to look next.
5. **Sources.** Hyperlinked catalyst articles, plus a line recording that
   mover data came from FMP and rotation data from sectorrotation.joezhang.co
   as of the payload date.
6. **Disclaimer.** "Not investment advice. No orders placed."

Notion has block limits — if the page is rejected as too large, trim the
ranked remainder tables to the top 20 a side rather than dropping sections.

## Step 6 — Verify before finishing

- The page exists and every property above is set.
- Mover tickers and percentages trace to Intrinio (large-cap) or the FMP
  mover lists (SMID), never to a news article.
- Percent changes are close-over-close for the session, not close-vs-open.
- The session date is consistent everywhere in the page.
- Rotation `asof` is stated, and flagged if stale.
- 15+ gainers and 15+ decliners where the session supported it.
- Every Bucket A claim has a source link.

Then report back in two or three sentences: the rotation headline, the
standout substance move, and the standout story move.

## Guardrails

This is analysis, not advice or execution. Never place, modify or cancel an
order. Never write to any Notion database other than the one named above.
Never edit the repository — the routine reads it, the refresh workflow writes
it.

Degrade honestly. If a data source is unavailable, write the page with the
sections you could build and name what is missing and why — a partial brief
that says what it lacks beats no brief, and beats a complete-looking brief
built from a worse source. In particular, do not silently substitute a gated
FMP endpoint's partial coverage for the full Intrinio screen: a "top movers"
table built from whichever tickers happened to be entitled is not a screen.
