'use strict';
// Run: node lib/market-calendar.test.js
const assert = require('assert');
const CAL = require('./market-calendar');
const C = require('./cadence');

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

check('Good Friday is computed from Easter across years', () => {
  assert.strictEqual(CAL.easterSunday(2026).toISOString().slice(0, 10), '2026-04-05');
  assert.strictEqual(CAL.holidayName('2026-04-03'), 'Good Friday');
  assert.strictEqual(CAL.easterSunday(2027).toISOString().slice(0, 10), '2027-03-28');
  assert.strictEqual(CAL.holidayName('2027-03-26'), 'Good Friday');
});

check('floating holidays land on the right weekday', () => {
  assert.strictEqual(CAL.holidayName('2026-01-19'), 'Martin Luther King Jr. Day');
  assert.strictEqual(CAL.holidayName('2026-02-16'), 'Washington’s Birthday');
  assert.strictEqual(CAL.holidayName('2026-05-25'), 'Memorial Day');
  assert.strictEqual(CAL.holidayName('2026-09-07'), 'Labor Day');
  assert.strictEqual(CAL.holidayName('2026-11-26'), 'Thanksgiving');
});

check('fixed holidays shift off the weekend', () => {
  // 2026-07-04 is a Saturday -> observed Friday the 3rd.
  assert.strictEqual(CAL.holidayName('2026-07-03'), 'Independence Day');
  assert.strictEqual(CAL.holidayName('2026-07-04'), null);
  // 2027-12-25 is a Saturday -> observed Friday the 24th.
  assert.strictEqual(CAL.holidayName('2027-12-24'), 'Christmas Day');
  // 2028-01-01 is a Saturday -> New Year observed Friday 2027-12-31.
  assert.strictEqual(CAL.holidayName('2027-12-31'), 'New Year’s Day');
});

check('ordinary weekdays are trading days, weekends and holidays are not', () => {
  assert.strictEqual(CAL.isTradingDay('2026-08-28'), true);
  assert.strictEqual(CAL.isTradingDay('2026-08-30'), false);
  assert.strictEqual(CAL.closedReason('2026-08-30'), 'weekend');
  assert.strictEqual(CAL.isTradingDay('2026-11-26'), false);
  assert.strictEqual(CAL.closedReason('2026-11-26'), 'Thanksgiving');
});

check('a quiet full pass on a holiday does NOT tick the quiet counter', () => {
  const r = C.newRecord('HOLLY');
  const out = C.applyPass(r, { fundamentals: {} }, { run: 'pm', today: '2026-11-26' });
  assert.strictEqual(out.quiet, true);
  assert.strictEqual(out.record.quietRuns, 0, 'counter held over the holiday');
  assert.strictEqual(out.record.tier, 'daily');
});

check('three holiday passes in a row cannot demote a live name', () => {
  let r = C.newRecord('LIVE');
  ['2026-11-26', '2026-12-25', '2027-01-01'].forEach((d) => {
    r = C.applyPass(r, { fundamentals: {} }, { run: 'pm', today: d }).record;
  });
  assert.strictEqual(r.tier, 'daily');
  assert.strictEqual(r.quietRuns, 0);
});

check('the same three passes on trading days DO demote', () => {
  let r = C.newRecord('DEMOTE');
  ['2026-11-24', '2026-11-25', '2026-11-27'].forEach((d) => {
    r = C.applyPass(r, { fundamentals: {} }, { run: 'pm', today: d }).record;
  });
  assert.strictEqual(r.tier, 'weekly');
});

check('a batch can force "no session" for an unscheduled closure', () => {
  const r = C.newRecord('CLOSED');
  const out = C.applyPass(r, { fundamentals: {} }, { run: 'pm', today: '2026-08-28', tradingDay: false });
  assert.strictEqual(out.record.quietRuns, 0);
  assert.strictEqual(out.record.lastPass.tradingDay, false);
  assert.strictEqual(out.record.history[0].closed, 'no session');
});

check('facts still update on a non-trading day', () => {
  const r = C.newRecord('FACTS');
  const out = C.applyPass(r, { fundamentals: { pe: { trailing: 12.5 } } }, { run: 'pm', today: '2026-11-26' });
  assert.strictEqual(out.record.fundamentals.pe.trailing, 12.5);
  assert.strictEqual(out.quiet, false);
});

console.log('\n' + pass + ' checks passed');
