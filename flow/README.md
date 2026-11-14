# Money Flow 3D

A 3D view of intraday money flow across the 11 US equity sectors, sampled by six
of the largest stocks in each (66 stocks plus SPY).

    node flow/server.js            # then open http://localhost:4173
    node flow/server.js --demo     # generated numbers, labelled SIMULATED DATA

Needs Node 18+. No install step. Options: `--port 5000`, `--refresh 60` (seconds),
`--provider yahoo|alpaca`.

## Data

| Provider | Setup | Limits |
|---|---|---|
| Yahoo (default) | none | Unofficial endpoint. No key, no guarantee. ~67 requests a minute; Yahoo may answer 429, in which case the server backs off and the page shows STALE. |
| Alpaca | set `ALPACA_KEY` and `ALPACA_SECRET` | Official API. The free plan is the IEX feed only, a small share of total US volume, so dollar figures are far below the consolidated tape. |

Bars are 5 minutes, regular session only (09:30–16:00 ET). Outside market hours the
page shows the last completed session and says MARKET CLOSED.

## What "money flow" means here

For each 5-minute bar: typical price = (high + low + close) / 3, dollar volume =
typical price x shares. The bar counts as inflow if the typical price rose from
the prior bar, outflow if it fell. This is the standard price-direction proxy.
It is not a measurement of cash entering or leaving a stock: every trade has a
buyer and a seller. Sector totals cover only the six sampled names.

## Reading the scene

- Tower height: dollar volume so far in the session (square-root scale).
- Tower colour: net flow as a share of dollar volume, saturating at 35%.
- Particles: net flow over the last 30 minutes, toward the sector for inflow,
  back to the core for outflow.
- Slider and Replay step through the session; Latest returns to the newest bar.

three.js 0.147 is vendored under `public/vendor/` (MIT, see `THREE-LICENSE`).
