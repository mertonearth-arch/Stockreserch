#!/usr/bin/env node
'use strict';
// CLI for the stock research loop.
//
//   node bin/research.js due   [--run am|pm] [--movers ABC,DEF]
//   node bin/research.js add   ABC,DEF [--reason "gapper +34%"]
//   node bin/research.js record <batch.json>
//   node bin/research.js build
//   node bin/research.js status
//
// The split is deliberate: `due` and `record` are the only two touchpoints a
// research pass needs. Everything about WHICH names get worked and how often
// lives here, not in the prompt, so the cadence stays consistent run to run.

const fs = require('fs');
const path = require('path');
const S = require('../lib/state');
const C = require('../lib/cadence');
const SEC = require('../lib/sectors');
const CAL = require('../lib/market-calendar');

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name, fallback) {
  const i = args.indexOf('--' + name);
  return i === -1 || i === args.length - 1 ? fallback : args[i + 1];
}

function positional(n) {
  const rest = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) { i++; continue; }
    rest.push(args[i]);
  }
  return rest[n];
}

// --- due --------------------------------------------------------------------
function cmdDue() {
  const run = flag('run', 'pm');
  const moversToday = (flag('movers', '') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const records = S.allTickers();
  const sel = C.selectDue(records, { run: run, moversToday: moversToday });

  const byTier = {};
  records.forEach((r) => { byTier[r.tier] = (byTier[r.tier] || 0) + 1; });
  sel.watchlistSize = records.length;
  sel.byTier = byTier;
  sel.tradingDay = CAL.isTradingDay(sel.today);
  sel.closedReason = CAL.closedReason(sel.today);

  if (args.indexOf('--json') !== -1) { console.log(JSON.stringify(sel, null, 2)); return; }

  console.log('Run: ' + run.toUpperCase() + '   Date: ' + sel.today + '   Watchlist: ' + records.length +
    ' (' + C.TIERS.map((t) => t + ' ' + (byTier[t] || 0)).join(', ') + ')');
  if (!sel.tradingDay) {
    console.log('NO SESSION (' + sel.closedReason + ') — research still runs, but a quiet pass will NOT');
    console.log('count toward a demotion today. Pass "tradingDay": false in the batch to force this.');
  }
  console.log('\nDUE (' + sel.due.length + '):');
  if (!sel.due.length) console.log('  (nothing)');
  sel.due.forEach((d) => {
    const why = d.reasons.length ? d.reasons.join('; ') : (d.tier + ' cadence, ' + d.daysSince + 'd since last pass');
    console.log('  ' + d.ticker.padEnd(7) + d.tier.padEnd(9) + why);
  });
  console.log('\nSKIPPED (' + sel.skipped.length + '): ' +
    (sel.skipped.map((s) => s.ticker).join(' ') || '(none)'));
}

// --- add --------------------------------------------------------------------
function cmdAdd() {
  const list = (positional(0) || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!list.length) { console.error('usage: research.js add ABC,DEF [--reason "..."]'); process.exit(1); }
  const reason = flag('reason', 'manually added');
  const added = [];
  const already = [];
  list.forEach((t) => {
    if (S.loadTicker(t)) { already.push(t); return; }
    S.saveTicker(C.newRecord(t, { addedReason: reason }));
    added.push(t);
  });
  console.log('added: ' + (added.join(' ') || '(none)'));
  if (already.length) console.log('already tracked: ' + already.join(' '));
}

// --- record -----------------------------------------------------------------
function cmdRecord() {
  const file = positional(0);
  if (!file) { console.error('usage: research.js record <batch.json>'); process.exit(1); }
  const batch = JSON.parse(fs.readFileSync(file, 'utf8'));
  const run = batch.run || flag('run', 'pm');
  const today = batch.date || C.iso(new Date());
  const movers = (batch.movers || []).map((s) => String(s).toUpperCase());
  // The calendar decides by default; a pass that discovers an unscheduled
  // closure can override it with "tradingDay": false in the batch.
  const tradingDay = batch.tradingDay === undefined ? CAL.isTradingDay(today) : batch.tradingDay !== false;
  const closedReason = tradingDay ? null : (CAL.closedReason(today) || 'no session reported');

  const log = { date: today, run: run, movers: movers, tradingDay: tradingDay, closedReason: closedReason,
    applied: [], created: [], promoted: [], demoted: [], quiet: [] };

  (batch.results || []).forEach((result) => {
    const ticker = String(result.ticker || '').toUpperCase();
    if (!ticker) return;
    let rec = S.loadTicker(ticker);
    if (!rec) {
      rec = C.newRecord(ticker, { addedReason: result.addedReason || 'auto-sourced mover', price: result.price });
      log.created.push(ticker);
    }
    const out = C.applyPass(rec, result, { run: run, today: today, moversToday: movers, tradingDay: tradingDay });
    S.saveTicker(out.record);
    log.applied.push({ ticker: ticker, tier: out.record.tier, quiet: out.quiet, changes: out.changes });
    if (out.quiet) log.quiet.push(ticker);
    if (out.tierChanged) {
      const move = { ticker: ticker, from: out.from, to: out.to };
      (C.TIERS.indexOf(out.to) < C.TIERS.indexOf(out.from) ? log.promoted : log.demoted).push(move);
    }
  });

  const records = S.allTickers();
  const store = S.loadSectors();
  SEC.snapshot(store, records, { today: today });
  S.saveSectors(store);

  const wl = S.loadWatchlist();
  wl.tickers = {};
  records.forEach((r) => {
    wl.tickers[r.ticker] = { tier: r.tier, theme: r.theme, quietRuns: r.quietRuns, lastResearched: r.lastResearched };
  });
  wl.lastRun = { date: today, run: run };
  S.saveWatchlist(wl);

  fs.mkdirSync(S.P.runs, { recursive: true });
  fs.writeFileSync(path.join(S.P.runs, today + '-' + run + '.json'), JSON.stringify(log, null, 2) + '\n');

  console.log('recorded ' + log.applied.length + ' ticker(s) for ' + today + ' ' + run.toUpperCase());
  if (!tradingDay) console.log('  no session (' + closedReason + ') — quiet counters held, nothing demoted');
  if (log.created.length) console.log('  new to watchlist: ' + log.created.join(' '));
  if (log.promoted.length) console.log('  promoted: ' + log.promoted.map((m) => m.ticker + ' ' + m.from + '->' + m.to).join(', '));
  if (log.demoted.length) console.log('  demoted:  ' + log.demoted.map((m) => m.ticker + ' ' + m.from + '->' + m.to).join(', '));
  if (log.quiet.length) console.log('  quiet:    ' + log.quiet.join(' '));
}

// --- status -----------------------------------------------------------------
function cmdStatus() {
  const records = S.allTickers();
  const store = S.loadSectors();
  const today = C.iso(new Date());
  if (!records.length) { console.log('Watchlist is empty. Run a research pass to seed it.'); return; }

  C.TIERS.forEach((tier) => {
    const rows = records.filter((r) => r.tier === tier);
    if (!rows.length) return;
    console.log('\n' + tier.toUpperCase() + ' (' + rows.length + ')');
    rows.sort((a, b) => a.ticker.localeCompare(b.ticker)).forEach((r) => {
      const last = r.lastResearched ? C.daysSince(r.lastResearched, today) + 'd ago' : 'never';
      const cat = (r.catalysts || [])[0];
      console.log('  ' + r.ticker.padEnd(7) + String(r.theme || '-').slice(0, 26).padEnd(28) +
        ('quiet ' + (r.quietRuns || 0)).padEnd(9) + last.padEnd(10) +
        (cat ? cat.date + ' ' + String(cat.headline).slice(0, 48) : ''));
    });
  });

  console.log('\nTHEME COUNTS (names / catalysts last 7d / new names last 7d)');
  SEC.tally(records, { today: today }).forEach((t) => {
    const tr = SEC.trend(store, t.theme, 7);
    const delta = tr && tr.names ? '  (' + (tr.names > 0 ? '+' : '') + tr.names + ' names vs ' + tr.from + ')' : '';
    console.log('  ' + t.theme.slice(0, 30).padEnd(32) + String(t.names).padStart(3) +
      String(t.catalysts7).padStart(6) + String(t.newNames7).padStart(6) + delta);
  });
}

// --- build ------------------------------------------------------------------
function cmdBuild() {
  const build = require('../lib/build');
  const out = build.render({
    records: S.allTickers(),
    sectors: S.loadSectors(),
    watchlist: S.loadWatchlist(),
    // Only date-stamped run logs — the raw batch-*.json inputs live here too.
    runs: fs.existsSync(S.P.runs)
      ? fs.readdirSync(S.P.runs).filter((f) => /^\d{4}-\d{2}-\d{2}-\w+\.json$/.test(f)).sort().reverse().slice(0, 10)
          .map((f) => JSON.parse(fs.readFileSync(path.join(S.P.runs, f), 'utf8')))
      : [],
  });
  fs.writeFileSync(S.P.dashboard, out, 'utf8');
  console.log('wrote ' + S.P.dashboard + ' (' + (out.length / 1024).toFixed(1) + ' KB)');
}

const commands = { due: cmdDue, add: cmdAdd, record: cmdRecord, status: cmdStatus, build: cmdBuild };
if (!commands[cmd]) {
  console.error('usage: research.js <due|add|record|build|status> [options]');
  process.exit(1);
}
commands[cmd]();
