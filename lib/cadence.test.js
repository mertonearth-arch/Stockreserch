'use strict';
// Minimal assertions for the tier ladder. Run: node lib/cadence.test.js
const assert = require('assert');
const c = require('./cadence');

// Pin passes to a known trading day: the holiday guard deliberately refuses to
// bank a quiet pass on a day with no session, and the suite must not depend on
// whatever weekday it happens to be run.
const TRADING = '2026-08-28';

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

check('new ticker starts daily and is due immediately', () => {
  const r = c.newRecord('TEST');
  assert.strictEqual(r.tier, 'daily');
  assert.strictEqual(c.isDue(r, { run: 'pm', today: TRADING }).due, true);
});

check('three quiet full passes demote daily -> weekly', () => {
  let r = c.newRecord('QUIET');
  for (let i = 0; i < 3; i++) r = c.applyPass(r, { fundamentals: {} }, { run: 'pm', today: TRADING }).record;
  assert.strictEqual(r.tier, 'weekly');
  assert.strictEqual(r.quietRuns, 0);
});

check('nine quiet full passes walk daily -> weekly -> monthly -> archived', () => {
  let r = c.newRecord('DEAD');
  const seen = [];
  for (let i = 0; i < 9; i++) { r = c.applyPass(r, { fundamentals: {} }, { run: 'pm', today: TRADING }).record; seen.push(r.tier); }
  assert.deepStrictEqual(seen, ['daily', 'daily', 'weekly', 'weekly', 'weekly', 'monthly', 'monthly', 'monthly', 'archived']);
});

check('a new catalyst promotes straight back to daily', () => {
  let r = c.newRecord('WAKE');
  for (let i = 0; i < 6; i++) r = c.applyPass(r, { fundamentals: {} }, { run: 'pm', today: TRADING }).record;
  assert.strictEqual(r.tier, 'monthly');
  const today = TRADING;
  const out = c.applyPass(r, { catalysts: [{ date: today, headline: 'Signs $40M contract', type: 'contract' }] }, { run: 'pm', today: TRADING });
  assert.strictEqual(out.record.tier, 'daily');
  assert.strictEqual(out.quiet, false);
  assert.strictEqual(out.record.quietRuns, 0);
});

check('an AM delta pass never demotes', () => {
  let r = c.newRecord('AMONLY');
  for (let i = 0; i < 20; i++) r = c.applyPass(r, { fundamentals: {} }, { run: 'am', today: TRADING }).record;
  assert.strictEqual(r.tier, 'daily');
  assert.strictEqual(r.quietRuns, 0);
});

check('upcoming earnings pin a monthly ticker to the due list', () => {
  let r = c.newRecord('EARN');
  for (let i = 0; i < 6; i++) r = c.applyPass(r, { fundamentals: {} }, { run: 'pm', today: TRADING }).record;
  assert.strictEqual(r.tier, 'monthly');
  const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  r.fundamentals.nextEarnings = { date: soon, confirmed: true };
  const d = c.isDue(r, { run: 'pm', today: TRADING });
  assert.strictEqual(d.due, true);
  assert.ok(d.reasons.some((x) => x.indexOf('earnings') === 0), 'earnings reason present');
});

check('weekly ticker is not due 3 days after its last pass', () => {
  const back = (n) => new Date(Date.parse(TRADING + 'T12:00:00Z') - n * 86400000).toISOString();
  const r = c.newRecord('WEEKLY');
  r.tier = 'weekly';
  r.lastResearched = back(3);
  assert.strictEqual(c.isDue(r, { run: 'pm', today: TRADING }).due, false);
  r.lastResearched = back(8);
  assert.strictEqual(c.isDue(r, { run: 'pm', today: TRADING }).due, true);
});

check('an 8%+ session move counts as an event, 4% does not', () => {
  const r = c.newRecord('MOVE');
  assert.strictEqual(c.classifyPass(r, { price: { changePct: 12.4 } }).quiet, false);
  assert.strictEqual(c.classifyPass(r, { price: { changePct: 4.1 } }).quiet, true);
});

check('re-reporting the same catalyst is quiet, not a new event', () => {
  let r = c.newRecord('DUPE');
  const cat = [{ date: '2026-08-20', headline: 'Same old news', type: 'pr' }];
  r = c.applyPass(r, { catalysts: cat }, { run: 'pm', today: TRADING }).record;
  assert.strictEqual(r.catalysts.length, 1);
  const second = c.applyPass(r, { catalysts: cat }, { run: 'pm', today: TRADING });
  assert.strictEqual(second.quiet, true);
  assert.strictEqual(second.record.catalysts.length, 1);
});

// Regression: on 2026-08-31 a light AM pass emitted empty conflicts/filings
// arrays as boilerplate and erased five researched conflicts and a pending
// filing across eight tickers. A delta pass must only ever add.
check('an AM pass cannot erase conflicts or filings it never investigated', () => {
  const r = c.newRecord('DELTA');
  r.conflicts = ['Move size: +34% per one source, +14.75% on the close'];
  r.pendingFilings = ['Private placement — closing 2026-08-31'];

  const out = c.applyPass(r, { conflicts: [], pendingFilings: [] }, { run: 'am', today: TRADING });
  assert.deepStrictEqual(out.record.conflicts, r.conflicts, 'conflicts survive an AM pass');
  assert.deepStrictEqual(out.record.pendingFilings, r.pendingFilings, 'filings survive an AM pass');
  assert.ok(!out.changes.some((x) => x.indexOf('conflict') !== -1), 'no phantom "conflict resolved"');

  // Omitting the fields entirely must also be safe.
  const out2 = c.applyPass(r, { fundamentals: {} }, { run: 'am', today: TRADING });
  assert.deepStrictEqual(out2.record.conflicts, r.conflicts);
  assert.deepStrictEqual(out2.record.pendingFilings, r.pendingFilings);
});

check('an AM pass can still ADD a conflict or filing', () => {
  const r = c.newRecord('ADDING');
  r.conflicts = ['old one'];
  const out = c.applyPass(r, { conflicts: ['old one', 'new one'], pendingFilings: ['8-K'] },
    { run: 'am', today: TRADING });
  assert.deepStrictEqual(out.record.conflicts, ['old one', 'new one']);
  assert.deepStrictEqual(out.record.pendingFilings, ['8-K']);
});

check('a full PM pass CAN clear a genuinely resolved conflict', () => {
  const r = c.newRecord('RESOLVED');
  r.conflicts = ['beat and raise but sold off, unexplained'];
  const out = c.applyPass(r, { conflicts: [] }, { run: 'pm', today: TRADING });
  assert.deepStrictEqual(out.record.conflicts, []);
  assert.ok(out.changes.indexOf('conflict resolved') !== -1);
});

check('archived tickers stay off the due list until something wakes them', () => {
  const r = c.newRecord('GONE');
  r.tier = 'archived';
  r.lastResearched = new Date(Date.now() - 400 * 86400000).toISOString();
  assert.strictEqual(c.isDue(r, { run: 'pm', today: TRADING }).due, false);
  assert.strictEqual(c.isDue(r, { run: 'pm', moversToday: ['GONE'] }).due, true);
});

console.log('\n' + pass + ' checks passed');
