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

## Step 1 — Sector and sub-industry rotation

```bash
node scripts/rotation-brief.mjs --remote --format both > /tmp/rotation.json
```

`--remote` reads the live payloads from sectorrotation.joezhang.co, so the
analysis reflects the most recent successful data refresh rather than
whatever the checkout happens to contain. The `both` format returns the full
structured report plus a rendered `markdown` field.

The script emits, on the **weekly** RRG frame vs SPY:

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

## Step 2 — Large-cap movers (FMP is the sole source of truth)

Use the **FMP connector** for every ticker, direction, percentage, price and
market cap. Never assemble the mover universe from news or web search.

FMP's raw biggest-gainers/losers lists are micro-cap dominated and will not
contain large caps. Instead:

1. Pull S&P 500 constituents (`indexes` endpoint, `sp-500`).
2. Batch-quote them in chunks for `changesPercentage` and `marketCap`.
3. Optionally add major non-S&P US-listed large caps and ADRs — TSM, ASML,
   SHOP, SE, MELI, ARM — via batch quote.
4. Screen `marketCap > $10B`, rank by `|changesPercentage|`.

Do the screening and ranking programmatically in a script, not by eye.

Target 15+ gainers and 15+ decliners when the session supports it.

## Step 3 — SMID movers (FMP, market cap < $10B)

Pull `marketPerformance` biggest-gainers and biggest-losers, then filter out
warrants, rights, units, SPAC shells, leveraged and inverse single-stock ETFs
and anything that is not common stock; require price ≥ $1. Batch-quote the
survivors for market cap and split:

- **Tier 2** — $1–10B
- **Tier 3** — under $1B, floor $25M

Sub-floor and illiquid micro-caps go in a short "flagged exceptions" note,
not the ranked tables. If the raw lists run thin, supplement Tier 2 from
most-active screened to $1–10B.

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

Index backdrop comes from FMP index quotes (S&P 500, Nasdaq, Dow, Russell)
plus `sector-performance-snapshot`.

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
- Mover tickers and percentages trace to FMP, not to a news article.
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
it. If the FMP connector is unavailable, still write the page with the
rotation section and a clear note that mover data could not be retrieved; a
partial brief that says what is missing beats no brief.
