'use strict';
// Cadence engine: decides who gets researched today, and moves tickers between
// daily / weekly / monthly / archived tiers based on whether anything new showed up.

const TIERS = ['daily', 'weekly', 'monthly', 'archived'];

// How many consecutive QUIET full passes before a ticker drops a tier.
const QUIET_LIMIT = { daily: 3, weekly: 3, monthly: 3 };
// Minimum days between full research passes per tier.
const INTERVAL_DAYS = { daily: 1, weekly: 7, monthly: 28, archived: Infinity };
// Earnings inside this window pin a ticker to daily regardless of quietness.
const EARNINGS_PIN_DAYS = 14;
// A single-session move at or above this magnitude counts as an event.
const MOVE_EVENT_PCT = 8;
const RVOL_EVENT = 3;

const MATERIAL_FILINGS = ['s-1', 's-3', '424b', '8-k', 'offering', 'atm', 'registered direct', '13d', '13g'];

const CAL = require('./market-calendar');

const DAY_MS = 86400000;
const toDate = (s) => (s instanceof Date ? s : new Date(s));
// Calendar days, not elapsed hours: a timestamp from earlier today and the
// date string "today" are zero days apart, not minus one.
const dayStart = (d) => {
  const x = toDate(d);
  return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
};
const daysSince = (from, to) => Math.round((dayStart(to) - dayStart(from)) / DAY_MS);
const iso = (d) => toDate(d).toISOString().slice(0, 10);
const isWeekday = (d) => { const n = toDate(d).getUTCDay(); return n >= 1 && n <= 5; };

function nextTierDown(tier) {
  const i = TIERS.indexOf(tier);
  return i < 0 || i >= TIERS.length - 1 ? 'archived' : TIERS[i + 1];
}

// --- Promotion triggers -----------------------------------------------------
// Reasons this ticker must be treated as daily no matter what tier it sits in.
function promotionReasons(rec, ctx) {
  ctx = ctx || {};
  const today = ctx.today || iso(new Date());
  const reasons = [];

  const earn = rec.fundamentals && rec.fundamentals.nextEarnings;
  if (earn && earn.date) {
    const d = daysSince(today, earn.date);
    if (d >= -2 && d <= EARNINGS_PIN_DAYS) reasons.push('earnings ' + earn.date + ' (' + d + 'd)');
  }

  const last = (rec.catalysts || [])[0];
  if (last && last.date && daysSince(last.date, today) <= 2) {
    reasons.push('fresh catalyst ' + last.date);
  }

  const px = rec.price || {};
  if (typeof px.changePct === 'number' && Math.abs(px.changePct) >= MOVE_EVENT_PCT) {
    reasons.push('session move ' + (px.changePct > 0 ? '+' : '') + px.changePct + '%');
  }
  if (typeof px.rvol === 'number' && px.rvol >= RVOL_EVENT) reasons.push('RVOL ' + px.rvol + 'x');

  if (ctx.moversToday && ctx.moversToday.indexOf(rec.ticker) !== -1) reasons.push('on today movers list');

  const filings = rec.pendingFilings || [];
  for (let i = 0; i < filings.length; i++) {
    const s = String(filings[i]).toLowerCase();
    if (MATERIAL_FILINGS.some((k) => s.indexOf(k) !== -1)) { reasons.push('filing: ' + filings[i]); break; }
  }
  if (rec.pin === true) reasons.push('manually pinned');
  return reasons;
}

// --- Due computation --------------------------------------------------------
function isDue(rec, ctx) {
  ctx = ctx || {};
  const today = ctx.today || iso(new Date());
  const run = ctx.run || 'pm';
  const reasons = promotionReasons(rec, Object.assign({}, ctx, { today: today }));

  if (rec.tier === 'archived' && reasons.length === 0) return { due: false, reasons: reasons };

  if (run === 'am') {
    // Light pass: daily-tier names plus anything a trigger just woke up.
    return { due: rec.tier === 'daily' || reasons.length > 0, reasons: reasons, mode: 'delta' };
  }

  if (reasons.length > 0) return { due: true, reasons: reasons, mode: 'full' };

  const since = rec.lastResearched ? daysSince(rec.lastResearched, today) : Infinity;
  const need = INTERVAL_DAYS[rec.tier] === undefined ? 1 : INTERVAL_DAYS[rec.tier];
  return { due: since >= need, reasons: reasons, mode: 'full', daysSince: since };
}

function selectDue(records, ctx) {
  ctx = ctx || {};
  const today = ctx.today || iso(new Date());
  const run = ctx.run || 'pm';
  const out = { today: today, run: run, due: [], skipped: [] };
  records.forEach((rec) => {
    const r = isDue(rec, Object.assign({}, ctx, { today: today, run: run }));
    const row = {
      ticker: rec.ticker, tier: rec.tier, mode: r.mode, reasons: r.reasons,
      daysSince: r.daysSince === undefined ? null : r.daysSince,
      quietRuns: rec.quietRuns || 0,
    };
    (r.due ? out.due : out.skipped).push(row);
  });
  const order = { daily: 0, weekly: 1, monthly: 2, archived: 3 };
  out.due.sort((a, b) =>
    (b.reasons.length - a.reasons.length) ||
    (order[a.tier] - order[b.tier]) ||
    a.ticker.localeCompare(b.ticker));
  return out;
}

// --- Applying a research pass ----------------------------------------------
// "Quiet" is derived from the diff, never asserted by the caller: a pass is
// quiet only if nothing new landed in any watched field.
function classifyPass(rec, result, run) {
  const changes = [];
  const before = rec.fundamentals || {};
  const after = result.fundamentals || {};

  const existing = rec.catalysts || [];
  const newCatalysts = (result.catalysts || []).filter((c) =>
    !existing.some((old) => old.date === c.date && old.headline === c.headline));
  if (newCatalysts.length) changes.push(newCatalysts.length + ' new catalyst(s)');

  ['pe', 'eps', 'revenue', 'growth', 'nextEarnings', 'guidance', 'marketCap', 'float',
    'sharesOutstanding', 'shortInterest', 'cash', 'debt']
    .forEach((k) => {
      if (after[k] === undefined) return;
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changes.push(k + ' updated');
    });

  const px = result.price || {};
  if (typeof px.changePct === 'number' && Math.abs(px.changePct) >= MOVE_EVENT_PCT) changes.push('move ' + px.changePct + '%');
  if (typeof px.rvol === 'number' && px.rvol >= RVOL_EVENT) changes.push('RVOL ' + px.rvol + 'x');
  if ((result.pendingFilings || []).length) changes.push('new filing(s)');

  // A delta pass emptying the list is a no-op, not a resolution — see applyPass.
  const clearedByDelta = run === 'am' && Array.isArray(result.conflicts) && result.conflicts.length === 0;
  if (Array.isArray(result.conflicts) && !clearedByDelta &&
      JSON.stringify(result.conflicts) !== JSON.stringify(rec.conflicts || [])) {
    changes.push(result.conflicts.length ? 'conflicts updated' : 'conflict resolved');
  }

  return { quiet: changes.length === 0, changes: changes, newCatalysts: newCatalysts };
}

function applyPass(rec, result, ctx) {
  ctx = ctx || {};
  const today = ctx.today || iso(new Date());
  const run = ctx.run || 'pm';
  const cls = classifyPass(rec, result, run);

  const next = Object.assign({}, rec);
  next.name = result.name || rec.name;
  next.sector = result.sector || rec.sector;
  next.theme = result.theme || rec.theme;
  next.themeLabel = result.themeLabel || rec.themeLabel;
  next.fundamentals = Object.assign({}, rec.fundamentals || {}, result.fundamentals || {});
  next.price = result.price || rec.price;
  // A delta (AM) pass has only glanced at the name, so it may ADD to these lists
  // but must never empty one — otherwise a light pass silently discards research
  // a full pass did. On a full pass an explicit [] does mean "resolved".
  const isDelta = run === 'am';
  const keepUnlessTold = (incoming, existing) =>
    (!Array.isArray(incoming) || incoming.length === 0) ? (existing || []) : incoming;

  next.conflicts = isDelta
    ? keepUnlessTold(result.conflicts, rec.conflicts)
    : (Array.isArray(result.conflicts) ? result.conflicts : (rec.conflicts || []));

  next.pendingFilings = isDelta
    ? keepUnlessTold(result.pendingFilings, rec.pendingFilings)
    : (result.pendingFilings || []);
  if (result.notes) next.notes = result.notes;

  next.catalysts = cls.newCatalysts.concat(rec.catalysts || [])
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  // A delta (AM) pass updates facts but never demotes: only a full pass is
  // allowed to conclude "nothing is happening here".
  const oldTier = rec.tier;
  let tier = rec.tier;
  let quietRuns = rec.quietRuns || 0;
  const pins = promotionReasons(next, Object.assign({}, ctx, { today: today }));

  // On a day with no session there was nothing for a name to do, so "quiet"
  // carries no information — banking it would demote live names over a holiday
  // week. Facts still update; only the counter is held.
  const tradingDay = ctx.tradingDay === undefined ? CAL.isTradingDay(today) : ctx.tradingDay !== false;

  if (!cls.quiet || pins.length) {
    quietRuns = 0;
    if (tier !== 'daily') tier = 'daily';
  } else if ((run === 'pm' || run === 'full') && tradingDay) {
    quietRuns += 1;
    const limit = QUIET_LIMIT[tier] || 3;
    if (quietRuns >= limit) { tier = nextTierDown(tier); quietRuns = 0; }
  }

  next.tier = tier;
  next.quietRuns = quietRuns;
  next.lastResearched = new Date().toISOString();
  next.lastPass = { date: today, run: run, quiet: cls.quiet, changes: cls.changes, tradingDay: tradingDay };
  next.history = [{ date: today, run: run, quiet: cls.quiet, changes: cls.changes, tier: tier, from: oldTier,
    closed: tradingDay ? undefined : (CAL.closedReason(today) || 'no session') }]
    .concat(rec.history || []).slice(0, 120);

  return { record: next, quiet: cls.quiet, changes: cls.changes, tierChanged: oldTier !== tier, from: oldTier, to: tier };
}

function newRecord(ticker, seed) {
  seed = seed || {};
  return {
    ticker: ticker.toUpperCase(),
    name: seed.name || null,
    sector: seed.sector || null,
    theme: seed.theme || null,
    themeLabel: seed.themeLabel || null,
    tier: 'daily',
    addedOn: seed.addedOn || iso(new Date()),
    addedReason: seed.addedReason || 'auto-sourced mover',
    quietRuns: 0,
    lastResearched: null,
    fundamentals: {},
    price: seed.price || null,
    catalysts: [],
    conflicts: [],
    pendingFilings: [],
    history: [],
  };
}

module.exports = {
  TIERS, QUIET_LIMIT, INTERVAL_DAYS, EARNINGS_PIN_DAYS, MOVE_EVENT_PCT, RVOL_EVENT, MATERIAL_FILINGS,
  iso, daysSince, isWeekday, promotionReasons, isDue, selectDue, classifyPass, applyPass, newRecord, nextTierDown,
};
