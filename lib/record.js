'use strict';
// Applies a batch of research results to the stored records. Shared by
// `research.js record` (the AM/PM passes) and `scan.js --record` (the
// small-float scan), so both go through the same cadence rules.

const S = require('./state');
const C = require('./cadence');
const SEC = require('./sectors');
const CAL = require('./market-calendar');

function recordBatch(batch, opts) {
  opts = opts || {};
  const run = batch.run || opts.run || 'pm';
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
  // The scan is not a pass; "last run" keeps pointing at the last real one.
  if (run !== 'scan') wl.lastRun = { date: today, run: run };
  S.saveWatchlist(wl);
  return log;
}

module.exports = { recordBatch };
