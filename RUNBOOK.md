# Cadence Desk — run procedure

This file is the whole job. A scheduled session starts cold, reads this, and executes it.
Working directory: `C:\Users\merto\code\stock-research`

There are two passes a weekday. **AM is cheap and narrow. PM is the real research.**

---

## Standing rules

1. **No scores, no ratings, no opinions, no trade calls.** No "the take", no tiering by
   quality, no price targets. Report facts with dates and sources. The tiers in this system
   are about *attention cadence*, never about how good a company is.
2. **Never invent a number.** If a figure cannot be established from a source, write `null`
   and set a `note`. "Shares outstanding" is not "float" — if only one was published, label
   it as the one that was published.
3. **Where sources disagree, keep both.** Put the disagreement in `conflicts` verbatim
   (e.g. `"Market cap: Yahoo 412M vs StockAnalysis 388M (2026-08-28)"`). Never average,
   never silently pick one.
4. **Negative earnings means no P/E.** Set `pe.trailing: null` with
   `note: "negative earnings"`. Do not print a negative multiple.
5. **Every catalyst needs a date.** Undated news is not a catalyst; leave it out or put it
   in `notes`.
6. **Leveraged ETFs, warrants and units are not stocks.** If a symbol turns out to be one
   (e.g. a 2x single-stock ETF, a `W`-suffixed warrant), record it with
   `theme: "Leveraged ETFs & warrants — not operating companies"` and skip the fundamentals
   rather than reporting the underlying's numbers as its own.
7. **Watch for reverse splits.** A price that looks impossible against recent history usually
   means a reverse split. Flag it in `conflicts`; don't reconcile it by guessing.

---

## AM pass (light, pre-market)

Goal: know what changed overnight. No deep research.

1. `node bin/research.js due --run am --json`
2. Web-search the day's US pre-market movers / gappers. Collect symbols with the move %
   and, where published, RVOL and the reason given.
3. For **new** symbols: create a stub entry — ticker, name, a first-guess theme, the price
   move, and the catalyst headline that is driving it, if one is stated. Fundamentals can be
   empty; PM will fill them.
4. For symbols **already tracked**: check for overnight news, a new SEC filing, or a gap.
   Update `price`, append any new dated catalyst, list any new filing in `pendingFilings`.
5. Write the batch and record it:
   ```
   node bin/research.js record runs/batch-am.json
   node bin/research.js build
   ```
6. Publish the dashboard (see *Publishing* below).

An AM pass never demotes anything — the engine enforces this. It only wakes names up.

**An AM pass may only ADD.** Do not emit `"conflicts": []` or `"pendingFilings": []` as
boilerplate on a name you have not investigated: you are glancing at overnight news, not
adjudicating a conflict a full pass established. The engine now ignores an empty list from a
delta pass, but omit the fields entirely rather than relying on that. Only a PM pass may
clear a conflict, and only when it has actually resolved it.

---

## PM pass (full, after the US close)

Goal: the real research on everything that came due.

1. `node bin/research.js due --run pm --json` — this is the work list. Respect it. Names not
   on it are deliberately not due; researching them anyway wastes the pass and breaks the
   cadence.
2. Web-search the day's closing movers to catch names that only ran intraday, and add them.
3. For **each due ticker**, research and fill in:
   - **Valuation** — market cap, trailing and forward P/E (or the "no earnings" note).
   - **EPS** — last 2 fiscal years plus the most recent quarter, each with its period label.
   - **Growth** — one headline growth figure with the metric named. Revenue YoY is the
     default; if the company does not report revenue, use whatever it *does* disclose
     (margin, cash burn, production, treasury holdings, subscriber count) and name that
     metric. Pre-revenue names get `pct: null` and a note.
   - **Catalysts** — dated headlines for the last ~6 months: earnings prints with the actual
     figures, contracts, FDA/regulatory events, guidance changes, offerings and dilution
     events, index adds, halts. Newest first. Include a source URL where you have one.
   - **Next earnings date** — and whether it is confirmed or estimated.
   - **Float, shares outstanding, short interest, cash, debt** where published.
   - **Sector / theme** — the group this name trades with. Reuse existing theme strings
     exactly (check `node bin/research.js status`) so groups don't fragment into synonyms.
4. Batch ~5 tickers per parallel search round; do not serialize one at a time.
5. Record, build, publish:
   ```
   node bin/research.js record runs/batch-pm.json
   node bin/research.js build
   node bin/research.js status
   ```

---

## Batch file format

Write to `runs/batch-am.json` or `runs/batch-pm.json`. Only include fields you actually
established — an omitted field keeps its previous value, an explicit `null` records
"looked, not disclosed".

```json
{
  "date": "2026-08-31",
  "run": "pm",
  "movers": ["ABCD", "EFGH"],
  "results": [
    {
      "ticker": "ABCD",
      "name": "Example Industries Inc.",
      "sector": "Technology",
      "theme": "AI Datacenter Buildout",
      "themeLabel": "hot sector",
      "addedReason": "up 34% on contract award",
      "price": { "last": 12.44, "changePct": 34.2, "rvol": 8.1, "asOf": "2026-08-31" },
      "fundamentals": {
        "marketCap": { "value": 412000000, "asOf": "2026-08-31", "source": "stockanalysis" },
        "float": { "value": 18400000, "asOf": "2026-08-31" },
        "sharesOutstanding": { "value": 33100000 },
        "shortInterest": { "value": 22.4, "asOf": "2026-08-15" },
        "cash": { "value": 61000000, "asOf": "2026-06-30" },
        "debt": { "value": 0, "asOf": "2026-06-30" },
        "pe": { "trailing": null, "forward": 28.4, "note": "negative trailing earnings", "asOf": "2026-08-31" },
        "eps": [
          { "period": "FY2024", "value": -0.84, "basis": "GAAP" },
          { "period": "FY2025", "value": -0.31, "basis": "GAAP" },
          { "period": "Q2 2026", "value": 0.04, "basis": "GAAP" }
        ],
        "revenue": [
          { "period": "Q2 2025", "value": 21000000, "yoy": null },
          { "period": "Q2 2026", "value": 34800000, "yoy": 65.7 }
        ],
        "growth": { "metric": "revenue YoY", "period": "Q2 2026", "pct": 65.7 },
        "nextEarnings": { "date": "2026-11-06", "confirmed": false }
      },
      "catalysts": [
        {
          "date": "2026-08-31",
          "type": "contract",
          "headline": "Awarded $40M supply agreement with a hyperscaler",
          "impact": "+34% on 8x volume",
          "source": "https://example.com/pr"
        }
      ],
      "pendingFilings": ["8-K 2026-08-31 (contract award)"],
      "conflicts": [],
      "notes": ""
    }
  ]
}
```

Field notes:
- `growth.pct` is a percent number, and may be negative. The bar diverges from zero.
- `themeLabel` is descriptive only: `hot sector`, `hype sector`, `story stock`,
  `established`, `nano-cap`. It is not a rating.
- `pendingFilings` is *recent* filings — it is rewritten each pass, not appended.
- Re-sending a catalyst that is already on file is free; it dedupes on date + headline and
  correctly counts as "nothing new".

---

## Running in the cloud

When the pass runs as a **cloud routine** rather than on the local machine, the checkout is
fresh and throwaway. The watchlist state lives in git, so the pass MUST bookend itself:

**First thing, before reading anything:**
```
git pull --rebase
```

**Last thing, after `build` and after publishing:**
```
git add -A
git commit -m "PM pass YYYY-MM-DD: <n> names, <what moved tiers>"
git push
```

If the push is skipped, the next run clones the old state: `quietRuns` resets, nothing ever
demotes, and the entire daily → weekly → monthly ladder silently stops working. A run that
cannot push has failed even if the dashboard looks fine — say so in the report rather than
finishing quietly.

Cron for cloud routines is in **UTC**, unlike the local tasks. Stockholm is UTC+2 in summer
and UTC+1 in winter, so **the local run times shift by an hour at each DST changeover**
(next: 2026-10-25). Adjust both routines' cron then, or accept the drift.

### The two routines

They live on claude.ai, not on this machine — a Claude reinstall does not touch them, and a
closed laptop does not delay them. Manage them at https://claude.ai/code/routines

| Routine | ID | Cron (UTC) | Local |
|---|---|---|---|
| Cadence Desk — AM pass | `trig_015b9jYYNhgqDRVLPfRkGCbs` | `27 5 * * 1-5` | 07:27 |
| Cadence Desk — PM pass | `trig_01MCZjr4wTRe8jZe5TX3N948` | `7 21 * * 1-5` | 23:07 |

Both run `claude-sonnet-5` against `https://github.com/mertonearth-arch/Stockreserch` with
`Bash Read Write Edit Glob Grep WebSearch WebFetch Artifact PushNotification` and the
`Claude_Code_Remote` connector. Each prompt is self-contained — it does not read this table.

**Open blocker (found 2026-08-30, still open 2026-09-04):** the cloud push returns HTTP 403,
`Claude doesn't have GitHub access to mertonearth-arch/Stockreserch`. The Claude GitHub App is
not installed for that account: https://github.com/apps/claude/installations/select_target
Until it is, every cloud pass publishes a correct dashboard and then loses its state — the
exact failure the bookends above exist to prevent. Both routine prompts are written to report
this loudly and send a push notification rather than finish quietly.

## Publishing

The dashboard is one Artifact at a stable URL — the same link every day. The URL is stored
in `ARTIFACT.md`.

- Build first: `node bin/research.js build` writes `dashboard.html`.
- **From a cloud run, read the live artifact before publishing.** A fresh session has never
  viewed it, so the first publish is refused to stop it clobbering a newer version:
  ```
  Artifact  action: "read"   url: <the url from ARTIFACT.md>
  ```
  Read the saved file it hands back, then publish. Do not resend identical content after a
  refusal — that is refused a second time. (Verified 2026-08-30: this costs three wasted
  attempts if skipped.) A local run that published earlier in the same session can skip this.
- Publish with the Artifact tool, passing **both** `file_path: dashboard.html` and the `url`
  from `ARTIFACT.md`, so it redeploys to the same link instead of creating a new one.
  `dashboard.html` is fully regenerated from `data/`, so there is never real content to merge
  from the live version — but the read is still required before the publish is accepted.
- Title stays `Cadence Desk`. Favicon stays the same.
- If `ARTIFACT.md` has no URL, publish fresh and write the returned URL into it.

---

## Cadence rules (enforced in code, not in the prompt)

| Tier | Researched | Drops a tier after |
|---|---|---|
| `daily` | every full pass | 3 straight quiet passes |
| `weekly` | every 7 days | 3 quiet weekly passes |
| `monthly` | every 28 days | 3 quiet monthly passes → archived |
| `archived` | never, until woken | — |

Anything on this list jumps straight back to `daily`:
new dated catalyst · earnings within 14 days · session move ≥ 8% · RVOL ≥ 3x ·
appearance on the movers list · a material filing (S-1, S-3, 424B, 8-K, ATM,
registered direct, 13D/G) · `"pin": true` set by hand on the record.

"Quiet" is computed from the diff, never asserted. A pass is quiet only when no catalyst,
no fundamentals field, no filing and no qualifying price move changed. So an honest
"I researched it and found nothing" is what eases the cadence — which is the point.

### Days with no session

On a weekend or a US market holiday there was nothing for a name to *do*, so a quiet pass
carries no information. `lib/market-calendar.js` computes the NYSE calendar (including Good
Friday from the Easter date, and the weekend-shift rules for fixed holidays), and on a
non-trading day the engine still records every fact but **holds the quiet counters** — no
name can be demoted. `due` prints a NO SESSION banner when this applies.

For an *unscheduled* closure the calendar cannot know about — a national day of mourning, a
market-wide outage — put `"tradingDay": false` at the top level of the batch file and the
same protection applies.

---

## Files

```
watchlist.json      roll-up index: ticker -> tier, theme, last pass
sectors.json        per-theme count history, for the week-over-week deltas
data/TICKER.json    the full record per name (fundamentals, catalysts, pass history)
runs/YYYY-MM-DD-*.json   what each pass did
dashboard.html      generated; never hand-edit
ARTIFACT.md         the published URL to redeploy to
lib/cadence.js          tier logic
lib/market-calendar.js  NYSE trading calendar (holiday guard)
```

Tests — run both after any change to the engine:
```
node lib/cadence.test.js
node lib/market-calendar.test.js
```

Manual controls:
```
node bin/research.js add NVDA,AMD --reason "watching into earnings"
node bin/research.js status
node bin/research.js due --run pm
```
To pin a name so it never demotes, set `"pin": true` in its `data/TICKER.json`.
