#!/usr/bin/env node
'use strict';
// Small-float scanner: good news and good financials on low-float and
// micro-cap US listings. Runs at the start of both daily passes.
//
//   node bin/scan.js --run am|pm [--record] [--since <ISO time>]
//
// Writes runs/scan-YYYY-MM-DD-<run>.json — the durable record of what was
// found and why — and prints a digest. With --record, hits are written into
// the watchlist through the cadence engine as a delta-only "scan" run: new
// dated events only, never a demotion, never a "researched" stamp.
//
// A name qualifies on float <= 50M shares (shares outstanding <= 50M also
// counts, since float can only be lower) or market cap <= $300M. Thresholds
// live in scan.config.json. See RUNBOOK.md, "Small-float scan".

// Behind the sandbox's HTTPS proxy, Node's fetch only uses it when started with
// NODE_USE_ENV_PROXY=1 (Node >= 22.21), so re-launch once with it set.
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  const r = require('child_process').spawnSync(process.execPath, ['--disable-warning=UNDICI-EHPA'].concat(process.argv.slice(1)), {
    stdio: 'inherit', env: Object.assign({}, process.env, { NODE_USE_ENV_PROXY: '1' }),
  });
  process.exit(r.status === null ? 1 : r.status);
}

const fs = require('fs');
const path = require('path');
const S = require('../lib/state');
const L = require('../lib/scan');
const Y = require('../lib/yahoo');
const SEC = require('../lib/sec');
const H = require('../lib/http');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i === -1 || i === args.length - 1 ? fallback : args[i + 1];
};
const has = (name) => args.indexOf('--' + name) !== -1;

const nyHour = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(new Date()));
const run = flag('run', nyHour() < 12 ? 'am' : 'pm');
const today = L.nyDate(new Date().toISOString());
const reportFile = path.join(S.P.runs, 'scan-' + today + '-' + run + '.json');

function loadConfig() {
  const file = path.join(S.P.root, 'scan.config.json');
  const over = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  delete over._comment;
  return L.config(over);
}

// Window: from the previous scan (minus a small overlap) to now, capped so a
// long gap — a weekend, a skipped run — does not turn into a week of news.
function scanWindow(cfg) {
  const now = Date.now();
  const cap = now - cfg.lookbackHoursCap * 3600000;
  const since = flag('since', null);
  if (since) return { from: new Date(Math.max(Date.parse(since), cap)).toISOString(), to: new Date(now).toISOString(), basis: '--since' };
  const files = fs.existsSync(S.P.runs)
    ? fs.readdirSync(S.P.runs).filter((f) => /^scan-\d{4}-\d{2}-\d{2}-(am|pm)\.json$/.test(f)).sort().reverse()
    : [];
  for (let i = 0; i < files.length; i++) {
    if (path.join(S.P.runs, files[i]) === reportFile) continue; // a re-run reuses the earlier window
    try {
      const prev = JSON.parse(fs.readFileSync(path.join(S.P.runs, files[i]), 'utf8'));
      if (prev.generatedAt) {
        const from = Math.max(Date.parse(prev.generatedAt) - cfg.overlapMinutes * 60000, cap);
        return { from: new Date(from).toISOString(), to: new Date(now).toISOString(), basis: 'since ' + files[i] };
      }
    } catch (e) { /* unreadable report: try the one before */ }
  }
  return { from: new Date(now - cfg.defaultLookbackHours * 3600000).toISOString(), to: new Date(now).toISOString(), basis: 'default ' + cfg.defaultLookbackHours + 'h' };
}

async function yahooSession() {
  let last = null;
  // The crumb endpoint rate-limits per IP and the sandbox IP is shared: be patient.
  for (const wait of [0, 8000, 20000, 40000, 75000]) {
    if (wait) await H.sleep(wait);
    try { return await Y.session(); } catch (e) { last = e; }
  }
  throw last;
}

const metricsFromQuote = (q) => ({
  name: q.longName || q.shortName || null, exchange: q.exchange || null, sector: null, industry: null,
  price: q.regularMarketPrice === undefined ? null : q.regularMarketPrice, changePct: q.regularMarketChangePercent === undefined ? null : q.regularMarketChangePercent, priceTime: q.regularMarketTime ? new Date(q.regularMarketTime * 1000).toISOString() : null,
  marketCap: q.marketCap === undefined ? null : q.marketCap, sharesOutstanding: q.sharesOutstanding === undefined ? null : q.sharesOutstanding,
  floatShares: null, metricsSource: 'Yahoo Finance screener quote',
});

async function main() {
  const cfg = loadConfig();
  const window = scanWindow(cfg);
  const sources = {};
  const errors = [];
  const err = (ticker, step, e) => errors.push({ ticker: ticker, step: step, error: String(e && e.message ? e.message : e).slice(0, 200) });

  // 1. Session ---------------------------------------------------------------------
  let sess = null;
  try { sess = await yahooSession(); sources.yahooSession = { ok: true }; }
  catch (e) { sources.yahooSession = { ok: false, error: e.message, effect: 'no float data and no custom screen this run; fell back to Yahoo predefined screens' }; }

  // 2. Universe ----------------------------------------------------------------------
  const quotes = [];
  if (sess) {
    const query = { operator: 'AND', operands: [
      { operator: 'or', operands: cfg.exchanges.map((x) => ({ operator: 'eq', operands: ['exchange', x] })) },
      { operator: 'lt', operands: ['intradaymarketcap', cfg.floatRouteMaxMarketCap] },
      { operator: 'gt', operands: ['percentchange', cfg.minChangePct] },
    ] };
    let total = 0;
    try {
      for (let page = 0; page < cfg.screenPages; page++) {
        const r = await Y.screen(sess, query, { offset: page * 250 });
        total = r.total;
        quotes.push.apply(quotes, r.quotes);
        if (r.quotes.length < 250) break;
      }
      sources.screen = { ok: true, kind: 'custom', total: total, returned: quotes.length,
        query: 'Nasdaq/NYSE/NYSE American, market cap < $' + L.short(cfg.floatRouteMaxMarketCap) + ', up > ' + cfg.minChangePct + '%' };
    } catch (e) { sources.screen = { ok: false, error: e.message }; }
  }
  if (!quotes.length) {
    try {
      const r = await Y.predefined('small_cap_gainers', 250);
      quotes.push.apply(quotes, r.quotes);
      sources.screen = Object.assign(sources.screen || {}, { fallback: 'predefined small_cap_gainers', returned: r.quotes.length });
    } catch (e) { sources.screenFallback = { ok: false, error: e.message }; }
  }

  // Candidate list, in priority order: names already tracked, SEC filers, movers.
  const cand = new Map();
  const add = (ticker, from, seed) => {
    const t = String(ticker || '').toUpperCase();
    if (!t) return;
    if (!cand.has(t)) cand.set(t, { ticker: t, from: [], quote: null, cik: null });
    const c = cand.get(t);
    if (c.from.indexOf(from) === -1) c.from.push(from);
    if (seed && seed.quote) c.quote = seed.quote;
    if (seed && seed.cik) c.cik = seed.cik;
  };

  const records = S.allTickers();
  const tracked = new Set(records.map((r) => r.ticker));
  records.forEach((r) => {
    if (r.tier === 'archived') return;
    const f = r.fundamentals || {};
    const v = (x) => (x && typeof x.value === 'number' ? x.value : null);
    const m = { floatShares: v(f.float), sharesOutstanding: v(f.sharesOutstanding), marketCap: v(f.marketCap) };
    const unknown = m.floatShares === null && m.sharesOutstanding === null && m.marketCap === null;
    if (unknown || L.qualify(m, cfg).ok) add(r.ticker, 'watchlist');
  });
  sources.watchlist = { tracked: records.length, checked: cand.size };

  let cikMap = null;
  if (SEC.enabled()) {
    try {
      cikMap = await SEC.cikMap();
      const filings = await SEC.recent8Ks(window.from, 6);
      let mapped = 0;
      filings.forEach((f) => {
        const t = f.cik !== null ? cikMap.byCik[f.cik] : null;
        if (!t) return;
        mapped++;
        add(t, 'sec 8-K', { cik: f.cik });
      });
      sources.sec = { enabled: true, filings8K: filings.length, mappedToTickers: mapped };
    } catch (e) { sources.sec = { enabled: true, ok: false, error: e.message }; }
  } else {
    sources.sec = { enabled: false, reason: SEC.disabledReason() };
  }

  let movers = 0;
  quotes.filter((q) => L.prefilter(q, cfg)).forEach((q) => { movers++; add(q.symbol, 'mover', { quote: q }); });
  sources.screen = Object.assign(sources.screen || {}, { passedPrefilter: movers });

  const universe = cand.size;
  const candidates = Array.from(cand.values()).slice(0, cfg.maxCandidates);

  // 3. Metrics: float, shares, cap ----------------------------------------------------
  await H.mapLimit(candidates, 4, 120, async (c) => {
    if (sess) {
      try { c.metrics = Object.assign(await Y.keyStats(sess, c.ticker), { metricsSource: 'Yahoo Finance key statistics' }); return; }
      catch (e) { err(c.ticker, 'key stats', e); }
    }
    if (c.quote) { c.metrics = metricsFromQuote(c.quote); return; }
    try {
      const sc = await Y.sharesAndCap(c.ticker);
      c.metrics = { name: null, exchange: null, price: null, changePct: null, floatShares: null,
        sharesOutstanding: sc.sharesOutstanding, sharesAsOf: sc.sharesAsOf, marketCap: sc.marketCap,
        metricsSource: 'Yahoo Finance fundamentals series (no key stats this run)' };
    } catch (e) { err(c.ticker, 'shares/cap', e); }
  });

  const excluded = [];
  const qualified = candidates.filter((c) => {
    if (!c.metrics) return false;
    if (c.metrics.exchange && !L.isCommonListing(c.ticker, c.metrics.exchange, cfg)) return false;
    if (c.metrics.quoteType && c.metrics.quoteType !== 'EQUITY') return false;
    const q = L.qualify(c.metrics, cfg);
    c.qualifiesBy = q.by;
    if (!q.ok && q.excluded) excluded.push({ ticker: c.ticker, reason: q.excluded });
    return q.ok;
  });

  // 4. Events: news, then SEC, then financials where there was a report ----------------
  await H.mapLimit(qualified, 4, 150, async (c) => {
    try { c.events = L.newsEvents(await Y.news(c.ticker, cfg.newsPerTicker), window, { ticker: c.ticker, name: c.metrics.name }); }
    catch (e) { c.events = []; err(c.ticker, 'news', e); }
  });

  if (SEC.enabled() && cikMap) {
    const withCik = qualified.filter((c) => {
      if (!c.cik && cikMap.byTicker[c.ticker]) c.cik = cikMap.byTicker[c.ticker].cik;
      return !!c.cik;
    });
    await H.mapLimit(withCik, 2, 150, async (c) => {
      try {
        const filings = await SEC.submissions(c.cik);
        c.events = c.events.concat(L.secEvents(filings, window));
        c.dilution = L.dilutionCheck(filings, today, cfg);
      } catch (e) { err(c.ticker, 'sec submissions', e); }
    });
  }

  const reporters = qualified.filter((c) => c.events.some((e) => e.type === 'earnings'));
  await H.mapLimit(reporters, 3, 150, async (c) => {
    const lastEarn = c.events.filter((e) => e.type === 'earnings').map((e) => e.date).sort().pop();
    try { c.financials = L.financialDeltas(await Y.financials(c.ticker), lastEarn, cfg); }
    catch (e) { err(c.ticker, 'financials', e); }
  });

  // 5. Decide -----------------------------------------------------------------------------
  qualified.forEach((c) => {
    c.events.sort((a, b) => String(b.at || b.date).localeCompare(String(a.at || a.date)));
    c.decision = L.decide(c, cfg);
    c.reaction = L.reaction(c.metrics);
  });
  const view = (c) => ({
    ticker: c.ticker, name: c.metrics.name, exchange: c.metrics.exchange, industry: c.metrics.industry || null,
    foundVia: c.from, tracked: tracked.has(c.ticker), qualifiesBy: c.qualifiesBy,
    metrics: {
      floatShares: c.metrics.floatShares, sharesOutstanding: c.metrics.sharesOutstanding, marketCap: c.metrics.marketCap,
      price: c.metrics.price, changePct: c.metrics.changePct === null || c.metrics.changePct === undefined ? null : Number(Number(c.metrics.changePct).toFixed(2)),
      preMarketChangePct: c.metrics.preMarketChangePct === undefined ? null : c.metrics.preMarketChangePct,
      postMarketChangePct: c.metrics.postMarketChangePct === undefined ? null : c.metrics.postMarketChangePct,
      shortPercentOfFloat: c.metrics.shortPercentOfFloat === undefined ? null : c.metrics.shortPercentOfFloat,
      source: c.metrics.metricsSource,
    },
    reaction: c.reaction,
    why: c.decision.why,
    events: c.events.filter((e) => e.tone !== 'noise').slice(0, 8),
    noise: c.events.filter((e) => e.tone === 'noise').length,
    financials: c.financials || null,
    dilution: c.dilution || null,
  });

  const hitList = qualified.filter((c) => c.decision.hit).sort(L.order);
  const negList = qualified.filter((c) => !c.decision.hit && c.decision.negatives.length);
  const weakList = qualified.filter((c) => c.decision.weakOnly && !c.decision.negatives.length);
  // Everything else with real (non-noise) news: the keyword rules miss some
  // good news, so the pass skims these headlines rather than trusting the rules.
  const otherNews = qualified.filter((c) => !c.decision.hit && !c.decision.negatives.length && !c.decision.weakOnly &&
    c.events.some((e) => e.tone !== 'noise'))
    .map((c) => ({ ticker: c.ticker, name: c.metrics.name, contested: c.decision.contested,
      headlines: c.events.filter((e) => e.tone !== 'noise').slice(0, 3).map((e) => ({ date: e.date, type: e.type, tone: e.tone, publisher: e.publisher, headline: e.headline, url: e.url })) }));

  // 6. Record ------------------------------------------------------------------------------
  const recorded = { created: [], updated: [], skippedCap: [] };
  if (has('record')) {
    const results = [];
    let fresh = 0;
    hitList.forEach((c) => {
      const isNew = !tracked.has(c.ticker);
      if (isNew && fresh >= cfg.maxNewPerRun) { recorded.skippedCap.push(c.ticker); return; }
      if (isNew) fresh++;
      results.push(L.toBatchResult(c, isNew, today));
      (isNew ? recorded.created : recorded.updated).push(c.ticker);
    });
    // Dilution on a name already tracked is a fact the next pass must see.
    negList.filter((c) => tracked.has(c.ticker)).forEach((c) => {
      results.push(L.toBatchResult(c, false, today));
      recorded.updated.push(c.ticker);
    });
    if (results.length) {
      const log = require('../lib/record').recordBatch({ date: today, run: 'scan', results: results });
      recorded.promoted = log.promoted;
    }
  }

  const report = {
    generatedAt: new Date().toISOString(), date: today, run: run, window: window,
    criteria: {
      maxFloatShares: cfg.maxFloatShares, maxMarketCap: cfg.maxMarketCap, floatRouteMaxMarketCap: cfg.floatRouteMaxMarketCap,
      rule: 'float <= ' + L.short(cfg.maxFloatShares) + ' shares (or shares outstanding <= ' + L.short(cfg.maxFloatShares) +
        ', which bounds float) with market cap <= $' + L.short(cfg.floatRouteMaxMarketCap) + '; OR market cap <= $' + L.short(cfg.maxMarketCap),
      hit: 'a positive-type event in the window from a company release, SEC filing or news outlet (not commentary), ' +
        'or an earnings report whose numbers show revenue +' + cfg.minRevenueYoYPct + '% YoY, a turn to profit, or a loss narrowed ' + cfg.minLossNarrowPct + '%+',
      note: 'Event types are keyword-classified from headlines. They are labels for where to look, not ratings.',
    },
    sources: sources,
    counts: { universe: universe, candidates: candidates.length, qualified: qualified.length, hits: hitList.length,
      dilutionOrNegative: negList.length, weakSignals: weakList.length, otherNews: otherNews.length, errors: errors.length },
    hits: hitList.map(view),
    dilutionOrNegative: negList.map(view),
    weakSignals: weakList.map(view),
    otherNews: otherNews.slice(0, 40),
    excludedLargeLowShareCount: excluded.slice(0, 15),
    recorded: has('record') ? recorded : null,
    errors: errors.slice(0, 40),
  };
  fs.mkdirSync(S.P.runs, { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  printDigest(report);
}

function printDigest(r) {
  const pct = (v) => (typeof v === 'number' ? (v > 0 ? '+' : '') + v.toFixed(1) + '%' : '   -  ');
  const sh = (m) => (m.floatShares !== null && m.floatShares !== undefined ? 'float ' + L.short(m.floatShares)
    : m.sharesOutstanding !== null && m.sharesOutstanding !== undefined ? 'shares ' + L.short(m.sharesOutstanding) : 'float ?');
  console.log('Small-float scan — ' + r.date + ' ' + r.run.toUpperCase() + '   window ' + r.window.from.slice(0, 16) + 'Z → ' + r.window.to.slice(0, 16) + 'Z (' + r.window.basis + ')');
  console.log('  universe ' + r.counts.universe + ' · checked ' + r.counts.candidates + ' · qualified ' + r.counts.qualified +
    ' · hits ' + r.counts.hits + ' · dilution/negative ' + r.counts.dilutionOrNegative + (r.counts.errors ? ' · errors ' + r.counts.errors : ''));
  const s = r.sources;
  console.log('  Yahoo session ' + (s.yahooSession.ok ? 'ok' : 'FAILED (' + s.yahooSession.error + ') — DEGRADED RUN: no float data, smaller universe') +
    ' · screen ' + (s.screen ? (s.screen.ok === false ? 'FAILED' : (s.screen.total || s.screen.returned || 0) + ' movers' + (s.screen.fallback ? ' (fallback ' + s.screen.fallback + ')' : '')) : 'none') +
    ' · SEC ' + (s.sec.enabled ? (s.sec.ok === false ? 'FAILED (' + s.sec.error + ')' : s.sec.filings8K + ' 8-Ks') : 'skipped: ' + s.sec.reason));
  console.log('\nHITS (' + r.hits.length + ')' + (r.hits.length ? '' : '  — nothing qualifying in this window'));
  r.hits.forEach((h) => {
    const e = h.events.find((x) => x.tone === 'positive') || h.events[0];
    console.log('  ' + h.ticker.padEnd(6) + sh(h.metrics).padEnd(14) + ('$' + L.short(h.metrics.marketCap)).padEnd(9) +
      pct(h.reaction.regular).padStart(8) + (h.tracked ? '  [tracked]' : '') + '\n         ' +
      (e ? e.type + ' — ' + String(e.headline).slice(0, 110) + ' (' + (e.publisher || e.sourceClass) + ', ' + e.date + ')' : h.why[0]) +
      (h.financials && h.financials.qualifies ? '\n         financials: ' + h.financials.reasons.join(', ') + ' — ' + h.financials.period : '') +
      (h.dilution && h.dilution.flagged ? '\n         DILUTION FILINGS (' + h.dilution.days + 'd): ' + h.dilution.filings.map((f) => f.form + ' ' + f.date).join(', ') : ''));
  });
  if (r.dilutionOrNegative.length) {
    console.log('\nDILUTION / NEGATIVE (' + r.dilutionOrNegative.length + ')');
    r.dilutionOrNegative.slice(0, 15).forEach((h) => {
      const e = h.events.find((x) => x.tone === 'dilution' || x.tone === 'negative');
      console.log('  ' + h.ticker.padEnd(6) + (e ? e.type + ' — ' + String(e.headline).slice(0, 100) : ''));
    });
  }
  if (r.weakSignals && r.weakSignals.length) {
    console.log('\nWEAK SIGNALS ONLY — analyst actions / launches, not recorded (' + r.weakSignals.length + ')');
    r.weakSignals.slice(0, 10).forEach((h) => { const e = h.events[0]; console.log('  ' + h.ticker.padEnd(6) + (e ? e.type + ' — ' + String(e.headline).slice(0, 100) : '')); });
  }
  if (r.recorded) {
    console.log('\nrecorded: new ' + (r.recorded.created.join(' ') || '-') + ' · updated ' + (r.recorded.updated.join(' ') || '-') +
      (r.recorded.skippedCap.length ? ' · over the new-name cap, report only: ' + r.recorded.skippedCap.join(' ') : ''));
  }
  console.log('\nwrote ' + path.relative(S.P.root, reportFile));
}

main().catch((e) => { console.error('scan failed: ' + (e && e.stack ? e.stack : e)); process.exit(1); });
