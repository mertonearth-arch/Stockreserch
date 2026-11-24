# Cadence Desk — run procedure

This file is the whole job. A scheduled session starts cold, reads this, and executes it.
Working directory: `C:\Users\merto\code\stock-research`

There are two passes a weekday. **AM is cheap and narrow. PM is the real research.**
Both open with the **small-float scan** (below), which is the point of this desk: good
news and good financials on stocks with **float under 50M shares or market cap under $300M**.

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

## Small-float scan (step 0 of both passes)

```
node bin/scan.js --run am --record      # or --run pm
```

A deterministic scanner, no judgement involved. It takes ~1 minute and writes
`runs/scan-YYYY-MM-DD-<run>.json` (committed: it is the record of what was found and why).

**Who qualifies** (`scan.config.json`): float ≤ 50M shares — or shares outstanding ≤ 50M,
which bounds float — with market cap ≤ $2B; **or** market cap ≤ $300M. The $2B guard exists
because NVR, AutoZone and FICO also have < 50M shares and are not low-float names. Nasdaq,
NYSE and NYSE American common stock only: no OTC, warrants, units, rights or preferreds.

**Where it looks:** names already tracked, Yahoo's screen of listed names under $2B up more
than 5%, and (when enabled) every 8-K filed in the window. For each qualifying name it reads
Yahoo's headline feed — which carries GlobeNewswire, Business Wire, PR Newswire and ACCESS
Newswire releases — keeps only stories whose headline names the company, and labels each
by keyword: `order / contract`, `regulatory / clinical`, `earnings`, `buyback / dividend`,
`offering`, `reverse split`, `listing notice`, and so on. Where a name reported, it pulls the
quarter's revenue / net income / share count and checks for revenue +25% YoY, a turn to
profit, or a loss narrowed 25%+ — and refuses to use Yahoo's numbers when they still show
the previous quarter (`stale`).

**A hit** is a qualifying name with a positive-type event from a company release, an SEC
filing or a news outlet (never commentary such as Motley Fool), or a qualifying earnings
print. Two outlets describing one print differently ("loss widens" vs "beats estimates") is
*contested* and does not count on its own. Dilution and negative events on small floats are
listed beside the hits, never hidden.

**With `--record`** the scan writes into the watchlist as a delta-only `scan` run: new
names (max 8 per run) get a seeded stub — Yahoo float, shares, cap, price, the dated
headlines — and tracked names get the new dated events only. A scan never demotes, never
stamps `lastResearched`, never touches a tracked name's prices or fundamentals. So every
name it adds is due on the next full pass.

**What the pass does with the report:**
1. Read `hits` in the report. For each hit, open the primary source (the company release or
   filing) and confirm the event and its date. The labels come from keywords and are
   sometimes wrong — e.g. an ATM *termination* is not an offering. Record a correction in
   that name's `notes`; do not re-send the catalyst with a new type (it dedupes on date +
   headline and would be ignored).
2. Skim `otherNews`: real headlines the keyword rules did not label. If one is genuinely a
   positive-type event on a qualifying name, add it as a dated catalyst in your batch.
3. Read `sources`. If `yahooSession` failed, there is no float this run (shares outstanding
   was used); if `sec.enabled` is false, there was no 8-K or dilution-filing check. Say so in
   the report — do not imply a check ran.

**The standing rules still apply to everything the scan finds.** "Positive-type" is an
event label, not a rating, not a forecast and not a reason to buy. Low-float names that put
out good news frequently follow it with an offering — that is why the dilution list and the
90-day filing check sit next to every hit.

**Sources and access.** Yahoo needs no key. SEC EDGAR requires a declared contact in the
User-Agent; the scanner sends SEC requests only when `SEC_USER_AGENT` is set (e.g.
`CadenceDesk research name@example.com`) as an environment variable on the cloud
environment. It is deliberately not in this repo: the repo is public and the contact is
personal. GlobeNewswire, ACCESS Newswire and Newsfile block automated clients outright; do
not try to get around that — their releases arrive through Yahoo's feed anyway.

---

## AM pass (light, pre-market)

Goal: know what changed overnight. No deep research.

0. Run the small-float scan: `node bin/scan.js --run am --record`, then work its report as above.
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

0. Run the small-float scan: `node bin/scan.js --run pm --record`, then work its report as
   above. Names it added are now due and get full research in step 3 like any other.
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

**Blocker RESOLVED 2026-10-22.** From 2026-08-30 to 2026-10-22, the cloud run could not write
to GitHub at all — BOTH paths returned 403 (`git push` said `Claude doesn't have GitHub access
to mertonearth-arch/Stockreserch`; the GitHub MCP `push_files` said `Resource not accessible by
integration`; `GITHUB_TOKEN`/`GH_TOKEN` also 403'd against the REST API). Root cause: the Claude
GitHub App was not installed for the account. The user installed it (or reconnected GitHub) on
2026-10-22 and `git push` now succeeds normally from a cloud run — no special handling needed
going forward. Still only ever push once per pass and stop on failure rather than hunting for a
workaround (on 2026-08-30 — 2026-09-04 an AM run burned its five-hour budget dumping changed
data files through the API trying to force a push through; don't repeat that regardless of
cause).

**Data gap left by the outage:** while the blocker was live, individual cloud sessions did real
research and published it to the dashboard artifact, but none of that ever reached git — each
session started from the same stale 2026-09-01 git snapshot and silently overwrote whatever the
previous session had published. One such snapshot (a 2026-09-22 PM pass, 41 names, full
fundamentals) was captured before being overwritten and is saved at
`runs/backups/dashboard-live-2026-09-22-pm-41names.html`. The current `data/` only has the
17 names from before the outage plus a 2026-09-23 AM delta on top. A future PM pass should
treat every name as if it's never been researched (the backup HTML is the only source for
what was learned about the other ~24 names in between) rather than trusting `quietRuns` or
`lastResearched` on file, since both predate the gap.

### Two more things the cloud environment does differently

**The checkout arrives in DETACHED HEAD.** A bare `git pull --rebase` fails with "You are not
currently on a branch". Both prompts now open with `git checkout main` then
`git pull --rebase origin main`.

**The egress proxy blocks several finance sites.** `stockanalysis.com`, `cnbc.com` and
`google.com` all return `EGRESS_BLOCKED` on WebFetch. Most existing records cite
`"source": "stockanalysis close, 4:00 PM EDT"` — that source cannot be refreshed from a cloud
run, so prices have to come from WebSearch results or a reachable site, labelled honestly as
whatever was actually used.

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
runs/scan-YYYY-MM-DD-am|pm.json   what each small-float scan found, and why
scan.config.json    small-float thresholds (float, market cap, hit rules)
dashboard.html      generated; never hand-edit
ARTIFACT.md         the published URL to redeploy to
bin/scan.js             the small-float scanner
lib/scan.js             its rules: qualification, headline labels, financial deltas
lib/yahoo.js, lib/sec.js, lib/http.js   read-only data access
lib/record.js           applies a batch (shared by record and the scan)
lib/cadence.js          tier logic
lib/market-calendar.js  NYSE trading calendar (holiday guard)
```

Tests — run all three after any change to the engine or the scanner:
```
node lib/cadence.test.js
node lib/market-calendar.test.js
node lib/scan.test.js
```

Manual controls:
```
node bin/research.js add NVDA,AMD --reason "watching into earnings"
node bin/research.js status
node bin/research.js due --run pm
```
To pin a name so it never demotes, set `"pin": true` in its `data/TICKER.json`.
