# Sector Rotation

Relative rotation graph for the eleven S&P 500 sector SPDRs against SPY.
Live at **https://sectorrotation.joezhang.co**

## Layout

```
public/index.html        the whole app — no build step, no dependencies
public/data.json         generated market data (committed, deployed as-is)
scripts/build-data.mjs   fetches Yahoo Finance and recomputes data.json
scripts/verify-data.mjs  refuses to ship a stale or malformed payload
archive/                 the original one-off HTML this replaced
```

## Daily refresh

`.github/workflows/update-data.yml` runs at 21:35 UTC Tue–Sat (shortly after
each US close), rebuilds `data.json`, verifies it, commits any change, and
deploys to Firebase Hosting.

If the fetch fails or verification rejects the payload, the workflow fails and
**nothing is deployed** — the previously good `data.json` stays live. The page
shows the data's own as-of date, and flags it once it is more than four days old.

Required repository secret: `FIREBASE_SERVICE_ACCOUNT_JOEZHANG_TOOLS`
(a JSON service-account key for the `joezhang-tools` Firebase project).

## Local

```bash
npm run build:data     # refresh public/data.json
npm run serve          # http://localhost:8080
npm run deploy         # firebase deploy --only hosting:sectorrotation
```

## The maths

JdK-style RS-Ratio / RS-Momentum, on split- and dividend-adjusted closes:

```
RS       = 100 × sector / SPY
ratioRaw = 100 × ((EMA(RS,10) − EMA(RS,26)) / EMA(RS,26) + 1)
RS-Ratio = 100 + zscore(ratioRaw, 52 weekly / 120 daily)
momRaw   = 100 × ((EMA(Ratio,f) − EMA(Ratio,s)) / EMA(Ratio,s) + 1)   f,s = 2,3 weekly / 2,6 daily
Momentum = 100 + zscore(momRaw, 26 weekly / 60 daily)
```

The parameters were fitted against the original hand-built chart so history
stays continuous: RS-Ratio reproduces it to RMSE 0.004 (weekly) / 0.007 (daily),
momentum to RMSE ~0.09, and the two agree on the quadrant 98% of the time.

## Data source note

Yahoo's chart endpoint throttles requests carrying a browser-like `User-Agent`
much harder than it throttles Node's default one, so `build-data.mjs`
deliberately sends no UA header. Don't "fix" that by adding one.
