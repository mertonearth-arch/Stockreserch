'use strict';
// Builds model3d.html: an interactive 3D model per ticker.
//   time  x  news category  x  stated share-price move, with the sparse price
//   snapshots the passes recorded on the back wall and the fundamentals on file
//   as a block of bars beside it.
//
// Same standing rules as the dashboard: nothing is invented. A catalyst only
// gets a height when its own text states a move for this stock (see
// move-parse.js); otherwise it is drawn flat. Price points are the snapshots the
// research passes actually recorded, not a daily series.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('./state');
const { parseMove } = require('./move-parse');

const OUT = path.join(S.P.root, 'model3d.html');
const PRICE_FILE = path.join(S.P.root, 'price-history.json');
const TEMPLATE = path.join(__dirname, 'model3d.template.html');

const ISO = /^\d{4}-\d{2}-\d{2}/;

// Free-text catalyst types (~100 spellings) folded into seven lanes.
const LANES = [
  { id: 'earn', label: 'Resultat & prognos', re: /earn|guidance|results|investor day/ },
  { id: 'legal', label: 'Juridik & styrning', re: /legal|litig|govern|executive|shareholder|disclosure|filing|insider/ },
  { id: 'reg', label: 'Regulatoriskt & kliniskt', re: /clinic|regulat|fda|medical|conference|data|legislat|listing/ },
  { id: 'cap', label: 'Kapital & struktur', re: /offering|dilut|financ|capital|split|dividend|treasury|buyback|bankrupt|restruct|corporate/ },
  { id: 'deal', label: 'Affärer & avtal', re: /m&a|contract|partner|investment|monetiz|product|operational|ipo/ },
  { id: 'analyst', label: 'Analytiker & index', re: /analyst|index/ },
  { id: 'price', label: 'Kursrörelse & övrigt', re: /./ },
];
const laneOf = (type) => {
  const t = String(type || '').toLowerCase();
  return LANES.findIndex((l) => l.re.test(t));
};

// --- price snapshots ---------------------------------------------------------
// The passes overwrite `price` on every run, so the only record of earlier
// quotes is git history. Harvest it once into price-history.json and keep that
// file committed: cloud checkouts are shallow, so history ages out otherwise.
function git(args) {
  return execFileSync('git', args, { cwd: S.P.root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

function addPoint(store, ticker, price) {
  if (!price || typeof price.last !== 'number' || !ISO.test(String(price.asOf || ''))) return;
  const d = String(price.asOf).slice(0, 10);
  const pt = { last: price.last };
  if (typeof price.changePct === 'number') pt.changePct = price.changePct;
  (store.tickers[ticker] = store.tickers[ticker] || {})[d] = pt;
}

function collectPrices(records) {
  const store = S.readJSON(PRICE_FILE, { lastCommit: null, tickers: {} });
  try {
    const head = git(['rev-parse', 'HEAD']).trim();
    if (head !== store.lastCommit) {
      let range = 'HEAD';
      if (store.lastCommit) {
        try { git(['cat-file', '-e', store.lastCommit + '^{commit}']); range = store.lastCommit + '..HEAD'; } catch (e) { /* aged out of a shallow clone */ }
      }
      const log = git(['log', '--reverse', '--format=@%H', '--name-only', range, '--', 'data/']);
      let commit = null;
      log.split('\n').forEach((line) => {
        if (line[0] === '@') { commit = line.slice(1); return; }
        if (!commit || !/^data\/[A-Z0-9.]+\.json$/.test(line)) return;
        try {
          const rec = JSON.parse(git(['show', commit + ':' + line]));
          addPoint(store, rec.ticker, rec.price);
        } catch (e) { /* file deleted in that commit, or unparsable */ }
      });
      store.lastCommit = head;
    }
  } catch (e) { /* not a git checkout: fall back to current records only */ }
  records.forEach((r) => addPoint(store, r.ticker, r.price));
  const sorted = { lastCommit: store.lastCommit, tickers: {} };
  Object.keys(store.tickers).sort().forEach((t) => {
    sorted.tickers[t] = {};
    Object.keys(store.tickers[t]).sort().forEach((d) => { sorted.tickers[t][d] = store.tickers[t][d]; });
  });
  S.writeJSON(PRICE_FILE, sorted);
  return sorted.tickers;
}

// --- per-ticker payload ------------------------------------------------------
const fv = (x) => (x && typeof x.value === 'number' ? { v: x.value, asOf: x.asOf || null, note: x.note || null } : { v: null, note: (x && x.note) || null });

function periodKey(p) {
  const s = String(p || '');
  const y = (s.match(/(?:FY)?\s?(20\d{2})/) || [])[1];
  const q = (s.match(/Q([1-4])/) || [])[1];
  return (y ? Number(y) : 0) * 10 + (q ? Number(q) : 5); // a full year sorts after its quarters
}

function shape(rec, prices) {
  const f = rec.fundamentals || {};
  const self = [rec.ticker, rec.name];
  const cats = (rec.catalysts || []).map((c) => {
    const raw = String(c.date || '');
    let d = null, approx = false;
    if (ISO.test(raw)) d = raw.slice(0, 10);
    else if (/^\d{4}-\d{2}$/.test(raw)) { d = raw + '-15'; approx = true; } // month known, day not
    let mv = parseMove(c.impact, self), from = 'impact';
    if (!mv && /price|move/i.test(c.type || '')) { mv = parseMove(c.headline, self); from = 'headline'; }
    const o = { d, raw, lane: laneOf(c.type), type: c.type || null, h: c.headline || '', imp: c.impact || null, src: c.source || null };
    if (approx) o.approx = true;
    if (mv) { o.mv = mv; o.from = from; }
    return o;
  }).sort((a, b) => String(b.d || b.raw).localeCompare(String(a.d || a.raw)));

  const px = Object.keys(prices || {}).map((d) => Object.assign({ d }, prices[d]));
  const series = (arr, extra) => (arr || []).filter((e) => e && typeof e.value === 'number')
    .map((e) => Object.assign({ p: e.period || '?', v: e.value }, extra(e)))
    .sort((a, b) => periodKey(a.p) - periodKey(b.p));

  return {
    t: rec.ticker, name: rec.name || rec.ticker, theme: rec.theme || 'Unsorted', sector: rec.sector || null,
    tier: rec.tier || null, asOf: rec.lastResearched ? String(rec.lastResearched).slice(0, 10) : null,
    price: rec.price ? { last: rec.price.last == null ? null : rec.price.last, asOf: rec.price.asOf || null, chg: rec.price.changePct == null ? null : rec.price.changePct, note: rec.price.note || null } : null,
    f: {
      mcap: fv(f.marketCap), shares: fv(f.sharesOutstanding), float: fv(f.float), si: fv(f.shortInterest),
      cash: fv(f.cash), debt: fv(f.debt),
      growth: f.growth ? { metric: f.growth.metric || null, period: f.growth.period || null, pct: typeof f.growth.pct === 'number' ? f.growth.pct : null, note: f.growth.note || null } : null,
      pe: f.pe ? { trailing: f.pe.trailing == null ? null : f.pe.trailing, forward: f.pe.forward == null ? null : f.pe.forward, note: f.pe.note || null } : null,
      next: f.nextEarnings && ISO.test(String(f.nextEarnings.date || '')) ? { d: String(f.nextEarnings.date).slice(0, 10), confirmed: !!f.nextEarnings.confirmed } : null,
      eps: series(f.eps, (e) => ({ basis: e.basis || null })),
      rev: series(f.revenue, (e) => ({ yoy: typeof e.yoy === 'number' ? e.yoy : null })),
    },
    c: cats, px, conflicts: rec.conflicts || [],
  };
}

function render(opts) {
  const records = opts.records.slice().sort((a, b) => a.ticker.localeCompare(b.ticker));
  const prices = opts.prices || {};
  const tickers = records.map((r) => shape(r, prices[r.ticker]));
  const asOf = tickers.map((t) => t.asOf).filter(Boolean).sort().pop() || null;
  const payload = { asOf, lanes: LANES.map((l) => l.label), tickers };
  const json = JSON.stringify(payload).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, '');
  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  return tpl.replace('/*{{DATA}}*/null', () => json);
}

function build() {
  const records = S.allTickers();
  const prices = collectPrices(records);
  const out = render({ records, prices });
  fs.writeFileSync(OUT, out, 'utf8');
  return { file: OUT, bytes: out.length, tickers: records.length };
}

module.exports = { build, render, shape, collectPrices, laneOf, LANES, OUT, PRICE_FILE };
