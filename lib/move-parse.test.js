'use strict';
// node lib/move-parse.test.js
const assert = require('assert');
const { parseMove } = require('./move-parse');

const lo = (s, self) => { const v = parseMove(s, self || ['NVDA', 'NVIDIA Corporation']); return v ? v.lo : null; };
const cases = [
  // explicit sign
  ['+5.31%', 5.31],
  ['-8.23%', -8.23],
  ['premarket -19.00%', -19],
  ['+9.33%; still about 53.5% below the 52-week high of $73.87', 9.33],
  // direction word tied to the stock
  ['Shares rose 8.6% to $84.16 from $77.49', 8.6],
  ['FICO shares fell approximately 27% on the news', -27],
  ['Stock closed down 13.70% on the session; peers also weak (Coherent -11%, Lumentum -9%)', -13.7],
  ['stock up about 33% on the news', 33],
  ['one source citing an ~18% single-day decline', -18],
  // not this stock, not a session move, or not a price at all
  ['lifted the whole tech complex; XLK +3.2% on 2026-08-28', null],
  ['legacy holders retain only ~4.75% of the combined company', null],
  ['cloud revenue +39% YoY to $99M', null],
  ['-7% over the following week', null],
  ['falling a cumulative 17.2% from Oct 9-16', null],
  ['Continued incremental progress toward the 5% target', null],
  ['Shares fell sharply but sources disagree on magnitude', null],
  [null, null],
];
cases.forEach(([s, want]) => assert.strictEqual(lo(s), want, String(s)));

// ranges are kept as ranges, ordered by magnitude
assert.deepStrictEqual(parseMove('-26% to -40% premarket'), { lo: -26, hi: -40, range: true });
assert.deepStrictEqual(parseMove('shares up ~70-90% intraday on outsized volume'), { lo: 70, hi: 90, range: true });
assert.deepStrictEqual(parseMove('Stock +8-10%; Broadcom fell >5% on competitive concern', ['MRVL', 'Marvell']), { lo: 8, hi: 10, range: true });

console.log('move-parse: ' + (cases.length + 3) + ' checks passed');
