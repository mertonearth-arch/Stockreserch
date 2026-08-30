'use strict';
// Renders the research state into a single self-contained dashboard page.
// The file is written content-only (no <html>/<head>/<body>) so the same file
// both opens locally in a browser and publishes cleanly as an Artifact.

const C = require('./cadence');
const SEC = require('./sectors');

const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const DASH = '—';

function num(v, opts) {
  opts = opts || {};
  if (v === null || v === undefined || v === '' || Number.isNaN(v)) return null;
  if (typeof v !== 'number') return String(v);
  const d = opts.dp === undefined ? 2 : opts.dp;
  const s = v.toFixed(d);
  return opts.sign && v > 0 ? '+' + s : s;
}

function money(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number') return String(v);
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(v);
}

// A value the research pass could not establish is shown as such, never guessed.
function val(x, fmt) {
  if (x === null || x === undefined) return '<span class="nd">not disclosed</span>';
  if (typeof x === 'object' && x !== null && 'value' in x) {
    if (x.value === null || x.value === undefined) {
      return '<span class="nd">' + esc(x.note || 'not disclosed') + '</span>';
    }
    const body = fmt ? fmt(x.value) : String(x.value);
    const src = x.asOf ? '<span class="asof" title="as of">' + esc(x.asOf) + '</span>' : '';
    return '<span class="v">' + esc(body) + '</span>' + src;
  }
  return '<span class="v">' + esc(fmt ? fmt(x) : x) + '</span>';
}

// Short interest is quoted against float by some sources and against shares
// outstanding by others. Print the basis the source actually used rather than
// asserting "of float" over both.
function shortCell(si) {
  if (!si || si.value === null || si.value === undefined) {
    return '<span class="nd">' + esc((si && si.note) || 'not disclosed') + '</span>';
  }
  const pct = '<span class="v">' + esc(Number(si.value).toFixed(1)) + '%</span>';
  const note = si.note ? '<span class="si-note">' + esc(si.note) + '</span>' : '';
  return pct + note;
}

function ageChip(dateStr, today) {
  if (!dateStr) return '';
  const d = C.daysSince(dateStr, today);
  if (d < 0) return '<span class="chip chip-fwd">in ' + Math.abs(d) + 'd</span>';
  if (d === 0) return '<span class="chip chip-hot">today</span>';
  if (d === 1) return '<span class="chip chip-hot">1d</span>';
  if (d <= 5) return '<span class="chip chip-warm">' + d + 'd</span>';
  if (d <= 30) return '<span class="chip">' + d + 'd</span>';
  return '<span class="chip chip-cold">' + Math.round(d / 30) + 'mo</span>';
}

// --- P/E ---------------------------------------------------------------------
// A negative-earnings company has no meaningful P/E. Say that; don't print a
// negative multiple as if it were a valuation.
function peCell(f) {
  const pe = f.pe;
  if (!pe) return '<span class="nd">' + DASH + '</span>';
  if (pe.trailing === null && pe.forward === null) {
    return '<span class="nd">' + esc(pe.note || 'no earnings') + '</span>';
  }
  const parts = [];
  if (pe.trailing !== null && pe.trailing !== undefined) {
    parts.push('<span class="v">' + esc(num(pe.trailing, { dp: 1 })) + '</span><span class="unit">ttm</span>');
  }
  if (pe.forward !== null && pe.forward !== undefined) {
    parts.push('<span class="v dim">' + esc(num(pe.forward, { dp: 1 })) + '</span><span class="unit">fwd</span>');
  }
  return parts.join('<span class="sep">/</span>');
}

// --- EPS ---------------------------------------------------------------------
function epsStrip(f) {
  const rows = (f.eps || []).slice(0, 3);
  if (!rows.length) return '<span class="nd">' + DASH + '</span>';
  const cells = rows.map((r) => {
    const v = r.value;
    const cls = v === null || v === undefined ? 'nd' : (v < 0 ? 'neg' : 'pos');
    const txt = v === null || v === undefined ? 'n/d' : (v > 0 ? '+' : '') + Number(v).toFixed(2);
    return '<span class="eps-cell"><span class="eps-p">' + esc(r.period) + '</span>' +
      '<span class="eps-v ' + cls + '">' + esc(txt) + '</span></span>';
  });
  return '<span class="eps-strip">' + cells.join('') + '</span>';
}

// --- Growth bar --------------------------------------------------------------
// Diverging from a zero baseline: growth can be negative, and a bar that only
// grows rightward would quietly hide that.
function growthBar(f) {
  const g = f.growth;
  if (!g || typeof g.pct !== 'number') {
    const label = (g && g.note) || 'not disclosed';
    return '<div class="growth"><div class="growth-none">' + esc(label) + '</div></div>';
  }
  const pct = g.pct;
  const cap = 100;
  const mag = Math.min(Math.abs(pct), cap) / cap * 50;
  const cls = pct >= 0 ? 'up' : 'down';
  const style = pct >= 0
    ? 'left:50%;width:' + mag.toFixed(1) + '%'
    : 'right:50%;width:' + mag.toFixed(1) + '%';
  const over = Math.abs(pct) > cap ? '<span class="growth-over">&rsaquo;</span>' : '';
  return '<div class="growth">' +
    '<div class="growth-track"><span class="growth-zero"></span>' +
    '<span class="growth-fill ' + cls + '" style="' + style + '"></span>' + over + '</div>' +
    '<div class="growth-meta"><span class="growth-pct ' + cls + '">' +
    (pct > 0 ? '+' : '') + pct.toFixed(1) + '%</span>' +
    '<span class="growth-metric">' + esc(g.metric || 'growth') +
    (g.period ? ' ' + esc(g.period) : '') + '</span></div></div>';
}

// --- Detail panel ------------------------------------------------------------
function catalystFeed(rec, today) {
  const list = (rec.catalysts || []).slice(0, 14);
  if (!list.length) return '<p class="empty">No dated catalysts recorded yet.</p>';
  return '<ol class="feed">' + list.map((c) => {
    const type = c.type ? '<span class="feed-type t-' + esc(String(c.type).toLowerCase().replace(/[^a-z]/g, '')) + '">' + esc(c.type) + '</span>' : '';
    const impact = c.impact ? '<span class="feed-impact">' + esc(c.impact) + '</span>' : '';
    const src = c.source
      ? '<a class="feed-src" href="' + esc(c.source) + '" target="_blank" rel="noopener noreferrer">source</a>'
      : (c.sourceName ? '<span class="feed-src">' + esc(c.sourceName) + '</span>' : '');
    return '<li><div class="feed-head"><time>' + esc(c.date) + '</time>' + ageChip(c.date, today) + type + '</div>' +
      '<div class="feed-body">' + esc(c.headline) + '</div>' +
      '<div class="feed-foot">' + impact + src + '</div></li>';
  }).join('') + '</ol>';
}

function detailPanel(rec, today) {
  const f = rec.fundamentals || {};
  const facts = [
    ['Market cap', val(f.marketCap, money)],
    ['Float', val(f.float, money)],
    ['Shares out', val(f.sharesOutstanding, money)],
    ['Short interest', shortCell(f.shortInterest)],
    ['Cash', val(f.cash, money)],
    ['Debt', val(f.debt, money)],
    ['Next earnings', f.nextEarnings && f.nextEarnings.date
      ? '<span class="v">' + esc(f.nextEarnings.date) + '</span>' + ageChip(f.nextEarnings.date, today) +
        (f.nextEarnings.confirmed === false ? '<span class="unit">est</span>' : '')
      : '<span class="nd">not scheduled</span>'],
  ];

  const epsRows = (f.eps || []).map((r) =>
    '<tr><td>' + esc(r.period) + '</td><td class="n ' + (r.value < 0 ? 'neg' : 'pos') + '">' +
    (r.value === null || r.value === undefined ? '<span class="nd">n/d</span>' : esc((r.value > 0 ? '+' : '') + Number(r.value).toFixed(2))) +
    '</td><td class="src">' + esc(r.basis || '') + '</td></tr>').join('');

  const revRows = (f.revenue || []).map((r) =>
    '<tr><td>' + esc(r.period) + '</td><td class="n">' +
    (r.value === null || r.value === undefined ? '<span class="nd">n/d</span>' : esc(money(r.value))) + '</td>' +
    '<td class="n ' + (r.yoy < 0 ? 'neg' : 'pos') + '">' +
    (typeof r.yoy === 'number' ? esc((r.yoy > 0 ? '+' : '') + r.yoy.toFixed(1) + '%') : '<span class="nd">' + DASH + '</span>') +
    '</td></tr>').join('');

  const conflicts = (rec.conflicts || []).length
    ? '<div class="conflicts"><h4>Sources disagree</h4><ul>' +
      rec.conflicts.map((c) => '<li>' + esc(c) + '</li>').join('') + '</ul></div>'
    : '';

  const filings = (rec.pendingFilings || []).length
    ? '<div class="filings"><h4>Recent filings</h4><ul>' +
      rec.pendingFilings.map((c) => '<li>' + esc(c) + '</li>').join('') + '</ul></div>'
    : '';

  const notes = rec.notes ? '<div class="notes"><h4>Notes</h4><p>' + esc(rec.notes) + '</p></div>' : '';

  const hist = (rec.history || []).slice(0, 6).map((h) =>
    '<li><time>' + esc(h.date) + '</time><span class="run-tag">' + esc(String(h.run).toUpperCase()) + '</span>' +
    (h.quiet ? '<span class="quiet-tag">nothing new</span>' : '<span class="chg">' + esc((h.changes || []).join(', ')) + '</span>') +
    (h.from !== h.tier ? '<span class="tier-move">' + esc(h.from) + ' &rarr; ' + esc(h.tier) + '</span>' : '') +
    '</li>').join('');

  return '<div class="detail">' +
    '<div class="detail-grid">' +
      '<section class="facts"><h4>Snapshot</h4><dl>' +
        facts.map((r) => '<div><dt>' + r[0] + '</dt><dd>' + r[1] + '</dd></div>').join('') +
      '</dl>' + conflicts + filings + notes + '</section>' +
      '<section class="tables">' +
        (epsRows ? '<h4>EPS</h4><table class="mini"><tbody>' + epsRows + '</tbody></table>' : '') +
        (revRows ? '<h4>Revenue</h4><table class="mini"><thead><tr><th>Period</th><th class="n">Revenue</th><th class="n">YoY</th></tr></thead><tbody>' + revRows + '</tbody></table>' : '') +
        (!epsRows && !revRows ? '<h4>EPS &amp; revenue</h4><p class="empty">Nothing filed or nothing found yet.</p>' : '') +
      '</section>' +
      '<section class="timeline"><h4>Catalyst feed</h4>' + catalystFeed(rec, today) + '</section>' +
    '</div>' +
    (hist ? '<div class="passes"><h4>Research passes</h4><ul class="pass-list">' + hist + '</ul></div>' : '') +
  '</div>';
}

// --- Ticker row --------------------------------------------------------------
function tickerRow(rec, today) {
  const f = rec.fundamentals || {};
  const px = rec.price || {};
  const lastCat = (rec.catalysts || [])[0];
  const chg = typeof px.changePct === 'number'
    ? '<span class="px-chg ' + (px.changePct >= 0 ? 'up' : 'down') + '">' +
      (px.changePct > 0 ? '+' : '') + px.changePct.toFixed(1) + '%</span>'
    : '';
  const price = typeof px.last === 'number' ? '<span class="px">' + px.last.toFixed(2) + '</span>' : '';

  const flags = [];
  if (f.nextEarnings && f.nextEarnings.date) {
    const d = C.daysSince(today, f.nextEarnings.date);
    if (d >= 0 && d <= 14) flags.push('<span class="flag flag-earn">ER ' + d + 'd</span>');
  }
  if ((rec.pendingFilings || []).length) flags.push('<span class="flag flag-file">filing</span>');
  if ((rec.conflicts || []).length) flags.push('<span class="flag flag-conf">conflict</span>');
  if (rec.addedOn && C.daysSince(rec.addedOn, today) <= 1) flags.push('<span class="flag flag-new">new</span>');

  return '<details class="row" data-tier="' + esc(rec.tier) + '" data-ticker="' + esc(rec.ticker) + '">' +
    '<summary>' +
      '<span class="c-tick"><span class="tk">' + esc(rec.ticker) + '</span>' +
        '<span class="nm">' + esc(rec.name || '') + '</span></span>' +
      '<span class="c-tier"><span class="tier tier-' + esc(rec.tier) + '">' + esc(rec.tier) + '</span>' + flags.join('') + '</span>' +
      '<span class="c-px">' + price + chg + '</span>' +
      '<span class="c-cap">' + val(f.marketCap, money) + '</span>' +
      '<span class="c-pe">' + peCell(f) + '</span>' +
      '<span class="c-eps">' + epsStrip(f) + '</span>' +
      '<span class="c-growth">' + growthBar(f) + '</span>' +
      '<span class="c-cat">' + (lastCat
        ? '<span class="cat-line">' + esc(String(lastCat.headline).slice(0, 74)) + '</span>' + ageChip(lastCat.date, today)
        : '<span class="nd">no catalyst on file</span>') + '</span>' +
    '</summary>' + detailPanel(rec, today) + '</details>';
}

// --- Sector heat -------------------------------------------------------------
function heatPanel(rows, store) {
  if (!rows.length) return '';
  const max = Math.max.apply(null, rows.map((r) => Math.max(r.names, r.catalysts7)));
  const bars = rows.map((r) => {
    const tr = SEC.trend(store, r.theme, 7);
    const delta = tr && tr.names
      ? '<span class="heat-delta ' + (tr.names > 0 ? 'up' : 'down') + '">' + (tr.names > 0 ? '+' : '') + tr.names + '</span>'
      : '';
    const w = (n) => (max ? (n / max * 100).toFixed(1) : 0) + '%';
    return '<li class="heat-row">' +
      '<span class="heat-name">' + esc(r.theme) + delta + '</span>' +
      '<span class="heat-bars">' +
        '<span class="heat-bar names" style="width:' + w(r.names) + '"><i>' + r.names + '</i></span>' +
        '<span class="heat-bar cats" style="width:' + w(r.catalysts7) + '"><i>' + r.catalysts7 + '</i></span>' +
      '</span>' +
      '<span class="heat-tk">' + esc(r.tickers.slice(0, 8).join(' ')) +
        (r.tickers.length > 8 ? ' +' + (r.tickers.length - 8) : '') + '</span>' +
    '</li>';
  }).join('');

  return '<section class="panel heat" id="heat">' +
    '<div class="panel-head"><h2>Sector heat</h2>' +
      '<p class="panel-sub">Counts only: how many tracked names sit in each theme, and how many dated catalysts landed there in the last 7 days. Not a ranking or a forecast.</p>' +
    '</div>' +
    '<div class="heat-key"><span><i class="sw names"></i>names tracked</span><span><i class="sw cats"></i>catalysts, 7d</span><span><i class="sw dl"></i>&plusmn; names vs 7d ago</span></div>' +
    '<ul class="heat-list">' + bars + '</ul></section>';
}

// --- Delta band --------------------------------------------------------------
function deltaBand(runs, today) {
  const last = runs[0];
  if (!last) return '';
  const chips = [];
  const mk = (cls, label, items) => {
    if (!items || !items.length) return;
    chips.push('<div class="delta-group ' + cls + '"><h3>' + label + ' <span class="cnt">' + items.length + '</span></h3>' +
      '<p>' + items.map((i) => '<span class="dtk">' + esc(typeof i === 'string' ? i : i.ticker) +
        (typeof i === 'object' && i.from ? '<em>' + esc(i.from) + '&rarr;' + esc(i.to) + '</em>' : '') + '</span>').join('') + '</p></div>');
  };
  mk('new', 'New to the watchlist', last.created);
  mk('promo', 'Woke back up', last.promoted);
  mk('demo', 'Went quiet, cadence eased', last.demoted);
  mk('quiet', 'Nothing new', last.quiet);

  const changed = (last.applied || []).filter((a) => !a.quiet && (a.changes || []).length);
  const changeList = changed.length
    ? '<ul class="changes">' + changed.slice(0, 18).map((a) =>
        '<li><span class="dtk">' + esc(a.ticker) + '</span><span class="chg">' + esc(a.changes.join(', ')) + '</span></li>').join('') + '</ul>'
    : '<p class="empty">No field changed on the last pass.</p>';

  const closed = last.tradingDay === false
    ? '<p class="closed-note"><b>No session</b> &mdash; ' + esc(last.closedReason || 'market closed') +
      '. Facts were still refreshed, but a quiet pass was not counted against any name, ' +
      'so nothing could ease its cadence on a day with no trading.</p>'
    : '';

  return '<section class="panel delta" id="delta">' +
    '<div class="panel-head"><h2>Since the last pass</h2>' +
      '<p class="panel-sub">' + esc(last.date) + ' &middot; ' + esc(String(last.run).toUpperCase()) +
      ' run &middot; ' + (last.applied || []).length + ' names worked</p>' + closed + '</div>' +
    (chips.length ? '<div class="delta-groups">' + chips.join('') + '</div>' : '') +
    '<h3 class="sub">What actually changed</h3>' + changeList +
  '</section>';
}

// --- Page --------------------------------------------------------------------
function render(input) {
  const records = (input.records || []).slice();
  const store = input.sectors || { themes: {} };
  const runs = input.runs || [];
  const today = C.iso(new Date());
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  const active = records.filter((r) => r.tier !== 'archived');
  const archived = records.filter((r) => r.tier === 'archived');
  const heat = SEC.tally(records, { today: today });

  const counts = { daily: 0, weekly: 0, monthly: 0, archived: 0 };
  records.forEach((r) => { counts[r.tier] = (counts[r.tier] || 0) + 1; });

  // Group the watchlist by theme, in the same order the heat panel uses.
  const groups = heat.map((h) => ({
    theme: h.theme,
    label: h.label,
    rows: active.filter((r) => (r.theme || r.sector || 'Unclassified') === h.theme)
      .sort((a, b) => {
        const order = { daily: 0, weekly: 1, monthly: 2, archived: 3 };
        return (order[a.tier] - order[b.tier]) || a.ticker.localeCompare(b.ticker);
      }),
  })).filter((g) => g.rows.length);

  const groupHtml = groups.map((g) =>
    '<section class="group" data-theme-group="' + esc(g.theme) + '">' +
      '<h2 class="group-head"><span class="group-name">' + esc(g.theme) + '</span>' +
        (g.label ? '<span class="group-label">' + esc(g.label) + '</span>' : '') +
        '<span class="group-count">' + g.rows.length + '</span></h2>' +
      '<div class="rows">' +
        '<div class="row-head"><span>Ticker</span><span>Cadence</span><span>Last</span><span>Mkt cap</span>' +
        '<span>P/E</span><span>EPS</span><span>Growth</span><span>Latest catalyst</span></div>' +
        g.rows.map((r) => tickerRow(r, today)).join('') +
      '</div></section>').join('');

  const archivedHtml = archived.length
    ? '<section class="group archived-group"><h2 class="group-head"><span class="group-name">Archived</span>' +
      '<span class="group-label">quiet for three straight monthly passes</span>' +
      '<span class="group-count">' + archived.length + '</span></h2>' +
      '<p class="archived-list">' + archived.map((r) => '<span class="dtk">' + esc(r.ticker) + '</span>').join('') + '</p>' +
      '<p class="panel-sub">Still on file. Any mover-list appearance, filing or earnings date pulls one straight back to daily.</p></section>'
    : '';

  const empty = !records.length
    ? '<section class="panel"><div class="panel-head"><h2>Watchlist is empty</h2>' +
      '<p class="panel-sub">Run a research pass to seed it: the pass sources the day’s movers, researches each name, and writes the first batch.</p></div></section>'
    : '';

  return PAGE
    .replace('{{STAMP}}', esc(stamp))
    .replace('{{TODAY}}', esc(today))
    .replace('{{COUNT_TOTAL}}', String(records.length))
    .replace('{{COUNT_DAILY}}', String(counts.daily || 0))
    .replace('{{COUNT_WEEKLY}}', String(counts.weekly || 0))
    .replace('{{COUNT_MONTHLY}}', String(counts.monthly || 0))
    .replace('{{COUNT_ARCHIVED}}', String(counts.archived || 0))
    .replace('{{DELTA}}', deltaBand(runs, today))
    .replace('{{HEAT}}', heatPanel(heat, store))
    .replace('{{GROUPS}}', empty + groupHtml + archivedHtml);
}

const PAGE = `<title>Cadence Desk</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root{
  --ground:#EEF0F4; --surface:#FFFFFF; --surface-2:#F6F7F9; --line:#D8DCE4; --line-soft:#E6E9EF;
  --ink:#161B24; --ink-2:#4A5364; --ink-3:#7C8698; --ink-4:#A3ABB9;
  --accent:#9A6612; --accent-soft:#F0E2C6; --accent-line:#C99A3A;
  --up:#1C6B52; --up-soft:#D6EBE2; --down:#A5342C; --down-soft:#F3DAD7;
  --hot:#B2500E; --hot-soft:#F7E0CC;
  --radius:3px; --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  --sans:'IBM Plex Sans',system-ui,-apple-system,Segoe UI,sans-serif;
  --cond:'IBM Plex Sans Condensed','IBM Plex Sans',system-ui,sans-serif;
  --grid: 132px 128px 92px 96px 104px 168px 150px minmax(200px,1fr);
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#0E1218; --surface:#151A22; --surface-2:#1B212B; --line:#2A323E; --line-soft:#222932;
  --ink:#E4E8EF; --ink-2:#A8B2C1; --ink-3:#7A8494; --ink-4:#5A6474;
  --accent:#DFA943; --accent-soft:#3A2E17; --accent-line:#8A6A28;
  --up:#4FB68C; --up-soft:#16332A; --down:#E4776B; --down-soft:#3A1F1D;
  --hot:#E8955A; --hot-soft:#3A2517;
}}
:root[data-theme="dark"]{
  --ground:#0E1218; --surface:#151A22; --surface-2:#1B212B; --line:#2A323E; --line-soft:#222932;
  --ink:#E4E8EF; --ink-2:#A8B2C1; --ink-3:#7A8494; --ink-4:#5A6474;
  --accent:#DFA943; --accent-soft:#3A2E17; --accent-line:#8A6A28;
  --up:#4FB68C; --up-soft:#16332A; --down:#E4776B; --down-soft:#3A1F1D;
  --hot:#E8955A; --hot-soft:#3A2517;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);
  font-family:var(--sans);font-size:14px;line-height:1.5;
  -webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
.wrap{max-width:1440px;margin:0 auto;padding:28px 24px 96px;display:flex;flex-direction:column;gap:24px}
h1,h2,h3,h4{font-family:var(--cond);margin:0;text-wrap:balance;letter-spacing:.01em}
a{color:var(--accent)}
:focus-visible{outline:2px solid var(--accent-line);outline-offset:2px}

/* masthead */
.mast{display:flex;flex-wrap:wrap;align-items:flex-end;gap:20px 32px;
  padding-bottom:18px;border-bottom:2px solid var(--ink)}
.mast h1{font-size:34px;font-weight:700;line-height:1;letter-spacing:-.015em}
.mast .tagline{color:var(--ink-2);font-size:13px;max-width:56ch;margin-top:6px}
.mast .stamp{margin-left:auto;text-align:right;font-family:var(--mono);font-size:11px;color:var(--ink-3);line-height:1.7}
.mast .stamp b{color:var(--ink);font-weight:600}
.tally{display:flex;gap:0;flex-wrap:wrap;font-family:var(--mono);font-size:11px;margin-top:10px}
.tally span{padding:3px 10px;border:1px solid var(--line);margin-right:-1px;color:var(--ink-2);white-space:nowrap}
.tally span b{color:var(--ink);font-weight:600}
.tally span:first-child{border-left-color:var(--accent-line);box-shadow:inset 2px 0 0 var(--accent)}

/* panels */
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:20px 22px}
.panel-head h2{font-size:19px;font-weight:600}
.panel-sub{color:var(--ink-3);font-size:12.5px;margin:5px 0 0;max-width:78ch}
.sub{font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:var(--ink-3);
  margin:20px 0 9px;font-weight:600}
.empty{color:var(--ink-3);font-size:13px;margin:6px 0 0;font-style:italic}

/* delta band */
.closed-note{margin:10px 0 0;padding:8px 11px;font-size:12.5px;color:var(--ink-2);
  background:var(--surface-2);border-left:2px solid var(--accent);border-radius:0 2px 2px 0;max-width:78ch}
.closed-note b{color:var(--accent);font-family:var(--cond);letter-spacing:.02em}
.delta-groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:1px;
  background:var(--line-soft);border:1px solid var(--line-soft);margin-top:16px}
.delta-group{background:var(--surface);padding:12px 14px}
.delta-group h3{font-size:11.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3);font-weight:600}
.delta-group h3 .cnt{font-family:var(--mono);color:var(--ink);margin-left:5px}
.delta-group p{margin:9px 0 0;display:flex;flex-wrap:wrap;gap:5px}
.delta-group.new{box-shadow:inset 0 2px 0 var(--accent)}
.delta-group.promo{box-shadow:inset 0 2px 0 var(--up)}
.delta-group.demo{box-shadow:inset 0 2px 0 var(--ink-4)}
.delta-group.quiet{box-shadow:inset 0 2px 0 var(--line)}
.dtk{font-family:var(--mono);font-size:12px;font-weight:600;background:var(--surface-2);
  border:1px solid var(--line-soft);padding:2px 6px;border-radius:2px;display:inline-flex;gap:5px;align-items:baseline}
.dtk em{font-style:normal;font-size:10px;color:var(--ink-3);font-weight:400}
.changes{list-style:none;margin:0;padding:0;display:grid;
  grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:6px 20px}
.changes li{display:flex;gap:9px;align-items:baseline;font-size:12.5px;
  border-bottom:1px dotted var(--line-soft);padding-bottom:5px}
.chg{color:var(--ink-2)}

/* sector heat */
.heat-key{display:flex;gap:18px;font-size:11px;color:var(--ink-3);margin:14px 0 10px;flex-wrap:wrap}
.heat-key .sw{display:inline-block;width:20px;height:8px;margin-right:6px;vertical-align:middle;border-radius:1px}
.sw.names{background:var(--ink-3)} .sw.cats{background:var(--accent)}
.sw.dl{background:linear-gradient(90deg,var(--up),var(--down))}
.heat-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.heat-row{display:grid;grid-template-columns:200px minmax(160px,1fr) minmax(0,1.15fr);
  gap:16px;align-items:center;padding:7px 0;border-bottom:1px solid var(--line-soft)}
.heat-row:last-child{border-bottom:0}
.heat-name{font-family:var(--cond);font-size:14px;font-weight:600;display:flex;gap:7px;align-items:baseline}
.heat-delta{font-family:var(--mono);font-size:10.5px;font-weight:500;padding:0 4px;border-radius:2px}
.heat-delta.up{color:var(--up);background:var(--up-soft)}
.heat-delta.down{color:var(--down);background:var(--down-soft)}
.heat-bars{display:flex;flex-direction:column;gap:3px}
.heat-bar{height:9px;min-width:16px;border-radius:1px;position:relative;transition:width .3s ease}
.heat-bar i{position:absolute;left:calc(100% + 5px);top:-3px;font-style:normal;
  font-family:var(--mono);font-size:10px;color:var(--ink-3)}
.heat-bar.names{background:var(--ink-3)} .heat-bar.cats{background:var(--accent)}
.heat-tk{font-family:var(--mono);font-size:11px;color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* filter bar */
.filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px}
.filters .lbl{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--ink-3);font-weight:600}
.filters button{font:inherit;font-family:var(--mono);font-size:11.5px;background:var(--surface);
  color:var(--ink-2);border:1px solid var(--line);border-radius:2px;padding:4px 11px;cursor:pointer}
.filters button:hover{border-color:var(--accent-line);color:var(--ink)}
.filters button[aria-pressed="true"]{background:var(--ink);color:var(--ground);border-color:var(--ink)}

/* groups + rows */
.group{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
.group-head{display:flex;align-items:baseline;gap:11px;padding:12px 18px;
  border-bottom:1px solid var(--line);background:var(--surface-2)}
.group-name{font-size:16px;font-weight:700}
.group-label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3)}
.group-count{margin-left:auto;font-family:var(--mono);font-size:12px;color:var(--ink-3)}
.rows{display:flex;flex-direction:column;overflow-x:auto}
.row-head,.row>summary{display:grid;grid-template-columns:var(--grid);gap:14px;align-items:center;min-width:1100px}
.row-head{padding:7px 18px;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;
  color:var(--ink-4);border-bottom:1px solid var(--line-soft);font-weight:600;font-family:var(--cond)}
.row{border-bottom:1px solid var(--line-soft)}
.row:last-child{border-bottom:0}
.row>summary{padding:11px 18px;cursor:pointer;list-style:none}
.row>summary::-webkit-details-marker{display:none}
.row>summary:hover{background:var(--surface-2)}
.row[open]>summary{background:var(--surface-2);box-shadow:inset 3px 0 0 var(--accent)}
.c-tick{display:flex;flex-direction:column;gap:1px;min-width:0}
.tk{font-family:var(--mono);font-size:14px;font-weight:600;letter-spacing:.02em}
.nm{font-size:11px;color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.c-tier{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.tier{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.06em;
  padding:2px 6px;border-radius:2px;border:1px solid}
.tier-daily{color:var(--accent);border-color:var(--accent-line);background:var(--accent-soft)}
.tier-weekly{color:var(--ink-2);border-color:var(--line);background:var(--surface)}
.tier-monthly{color:var(--ink-3);border-color:var(--line-soft);background:var(--surface)}
.tier-archived{color:var(--ink-4);border-color:var(--line-soft);background:var(--surface)}
.flag{font-family:var(--mono);font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;
  padding:1px 5px;border-radius:2px;background:var(--surface-2);color:var(--ink-3);border:1px solid var(--line-soft)}
.flag-earn{color:var(--hot);background:var(--hot-soft);border-color:transparent}
.flag-new{color:var(--accent);background:var(--accent-soft);border-color:transparent}
.flag-conf{color:var(--down);background:var(--down-soft);border-color:transparent}
.c-px{font-family:var(--mono);font-size:12.5px;display:flex;gap:7px;align-items:baseline}
.px{font-weight:500}
.px-chg{font-size:11.5px;font-weight:600}
.px-chg.up,.up{color:var(--up)} .px-chg.down,.down{color:var(--down)}
.c-cap,.c-pe{font-family:var(--mono);font-size:12.5px}
.v{font-weight:500}
.v.dim{color:var(--ink-3)}
.unit{font-size:9.5px;color:var(--ink-4);margin-left:2px;text-transform:uppercase;letter-spacing:.04em}
.sep{color:var(--ink-4);margin:0 4px}
.asof{display:none}
.nd{color:var(--ink-4);font-size:11.5px;font-style:italic;font-family:var(--sans)}
.eps-strip{display:flex;gap:9px}
.eps-cell{display:flex;flex-direction:column;line-height:1.25}
.eps-p{font-size:9px;color:var(--ink-4);text-transform:uppercase;letter-spacing:.05em;font-family:var(--cond)}
.eps-v{font-family:var(--mono);font-size:12px;font-weight:500}
.eps-v.pos{color:var(--up)} .eps-v.neg{color:var(--down)} .eps-v.nd{color:var(--ink-4)}

/* growth */
.growth{display:flex;flex-direction:column;gap:3px}
.growth-track{position:relative;height:8px;background:var(--surface-2);
  border:1px solid var(--line-soft);border-radius:1px}
.growth-zero{position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:var(--ink-4)}
.growth-fill{position:absolute;top:0;bottom:0;border-radius:1px}
.growth-fill.up{background:var(--up)} .growth-fill.down{background:var(--down)}
.growth-over{position:absolute;right:2px;top:-3px;color:var(--ink-3);font-family:var(--mono);font-size:11px}
.growth-meta{display:flex;gap:6px;align-items:baseline}
.growth-pct{font-family:var(--mono);font-size:11.5px;font-weight:600}
.growth-metric{font-size:9.5px;color:var(--ink-4);text-transform:uppercase;letter-spacing:.04em;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.growth-none{font-size:11px;color:var(--ink-4);font-style:italic}

/* catalyst cell */
.c-cat{display:flex;gap:7px;align-items:baseline;min-width:0}
.cat-line{font-size:12.5px;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip{font-family:var(--mono);font-size:9.5px;padding:1px 5px;border-radius:2px;
  background:var(--surface-2);color:var(--ink-3);border:1px solid var(--line-soft);white-space:nowrap}
.chip-hot{color:var(--hot);background:var(--hot-soft);border-color:transparent;font-weight:600}
.chip-warm{color:var(--accent);background:var(--accent-soft);border-color:transparent}
.chip-cold{color:var(--ink-4)}
.chip-fwd{color:var(--ink-2);border-style:dashed}

/* detail */
.detail{padding:6px 18px 22px;background:var(--surface-2);border-top:1px solid var(--line-soft)}
.detail h4{font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--ink-3);
  margin:16px 0 8px;font-weight:600}
.detail-grid{display:grid;grid-template-columns:minmax(230px,.85fr) minmax(240px,1fr) minmax(280px,1.25fr);gap:26px}
.facts dl{margin:0;display:flex;flex-direction:column;gap:0}
.facts dl>div{display:flex;justify-content:space-between;gap:12px;align-items:baseline;
  padding:5px 0;border-bottom:1px dotted var(--line)}
.facts dt{font-size:11.5px;color:var(--ink-3)}
.facts dd{margin:0;font-family:var(--mono);font-size:12px;text-align:right}
.si-note{display:block;font-family:var(--sans);font-size:10px;color:var(--ink-4);
  line-height:1.35;margin-top:1px;max-width:22ch}
table.mini{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:12px}
table.mini th{font-family:var(--cond);font-size:10px;text-transform:uppercase;letter-spacing:.06em;
  color:var(--ink-4);text-align:left;padding:3px 0;border-bottom:1px solid var(--line)}
table.mini td{padding:4px 0;border-bottom:1px dotted var(--line)}
table.mini .n{text-align:right}
table.mini .src{color:var(--ink-4);font-size:10px;text-align:right;font-family:var(--sans)}
.pos{color:var(--up)} .neg{color:var(--down)}
.feed{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:0;
  border-left:2px solid var(--line);max-height:340px;overflow-y:auto}
.feed li{padding:0 0 13px 14px;position:relative}
.feed li::before{content:"";position:absolute;left:-5px;top:6px;width:8px;height:8px;
  border-radius:50%;background:var(--surface-2);border:2px solid var(--ink-4)}
.feed li:first-child::before{border-color:var(--accent)}
.feed-head{display:flex;gap:7px;align-items:baseline;flex-wrap:wrap}
.feed-head time{font-family:var(--mono);font-size:11px;font-weight:600;color:var(--ink-2)}
.feed-type{font-family:var(--mono);font-size:9px;text-transform:uppercase;letter-spacing:.05em;
  padding:1px 5px;border-radius:2px;background:var(--surface);border:1px solid var(--line);color:var(--ink-3)}
.feed-type.toffering,.feed-type.tdilution{color:var(--down);border-color:var(--down)}
.feed-type.tearnings{color:var(--accent);border-color:var(--accent-line)}
.feed-body{font-size:12.5px;margin-top:2px;color:var(--ink)}
.feed-foot{display:flex;gap:9px;align-items:baseline;margin-top:2px}
.feed-impact{font-family:var(--mono);font-size:10.5px;color:var(--ink-3)}
.feed-src{font-size:10.5px;color:var(--ink-3)}
.conflicts,.filings,.notes{margin-top:14px}
.conflicts ul,.filings ul{margin:0;padding-left:16px;font-size:12px;color:var(--ink-2)}
.conflicts li{color:var(--down)}
.notes p{margin:0;font-size:12.5px;color:var(--ink-2)}
.passes{margin-top:18px;border-top:1px solid var(--line);padding-top:4px}
.pass-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px}
.pass-list li{display:flex;gap:9px;align-items:baseline;font-size:11.5px;flex-wrap:wrap}
.pass-list time{font-family:var(--mono);color:var(--ink-3)}
.run-tag{font-family:var(--mono);font-size:9px;padding:0 4px;border:1px solid var(--line);
  border-radius:2px;color:var(--ink-3)}
.quiet-tag{color:var(--ink-4);font-style:italic}
.tier-move{font-family:var(--mono);font-size:10px;color:var(--accent)}
.archived-group{opacity:.72}
.archived-list{display:flex;flex-wrap:wrap;gap:5px;padding:14px 18px 0;margin:0}
.archived-group .panel-sub{padding:8px 18px 16px}

/* method + footer */
.method{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:22px;margin-top:14px}
.method h3{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3);margin-bottom:6px}
.method p{margin:0;font-size:12.5px;color:var(--ink-2)}
.method code{font-family:var(--mono);font-size:11.5px;background:var(--surface-2);
  padding:1px 4px;border:1px solid var(--line-soft);border-radius:2px}
.foot{font-size:11.5px;color:var(--ink-3);border-top:1px solid var(--line);padding-top:14px}
.foot strong{color:var(--ink-2);font-weight:600}

@media (max-width:900px){
  .wrap{padding:20px 14px 72px}
  .mast h1{font-size:26px}
  .mast .stamp{margin-left:0;text-align:left}
  .detail-grid{grid-template-columns:1fr;gap:14px}
  .heat-row{grid-template-columns:1fr;gap:5px}
  .heat-tk{white-space:normal}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>

<div class="wrap">
  <header class="mast">
    <div>
      <h1>Cadence Desk</h1>
      <p class="tagline">Fundamentals and dated catalysts for every name on the list. Anything that keeps moving gets looked at daily; anything that goes quiet slides to weekly, then monthly, and gets pulled back the moment something happens.</p>
      <div class="tally">
        <span>daily <b>{{COUNT_DAILY}}</b></span>
        <span>weekly <b>{{COUNT_WEEKLY}}</b></span>
        <span>monthly <b>{{COUNT_MONTHLY}}</b></span>
        <span>archived <b>{{COUNT_ARCHIVED}}</b></span>
        <span>tracked <b>{{COUNT_TOTAL}}</b></span>
      </div>
    </div>
    <div class="stamp">built <b>{{STAMP}}</b><br>as of <b>{{TODAY}}</b></div>
  </header>

  {{DELTA}}
  {{HEAT}}

  <div class="filters">
    <span class="lbl">Show</span>
    <button type="button" data-filter="all" aria-pressed="true">all</button>
    <button type="button" data-filter="daily" aria-pressed="false">daily</button>
    <button type="button" data-filter="weekly" aria-pressed="false">weekly</button>
    <button type="button" data-filter="monthly" aria-pressed="false">monthly</button>
    <span class="lbl" style="margin-left:12px">Rows</span>
    <button type="button" id="expand-all" aria-pressed="false">expand all</button>
  </div>

  {{GROUPS}}

  <section class="panel">
    <div class="panel-head"><h2>How this list runs itself</h2></div>
    <div class="method">
      <div><h3>Two passes a day</h3><p>A light pre-market pass checks the movers list and any overnight news or filing on names already tracked. A full pass after the close re-researches everything that came due and rebuilds this page.</p></div>
      <div><h3>Cadence, not a ranking</h3><p>Every new name starts <code>daily</code>. Three straight full passes with nothing new drops it to <code>weekly</code>; three quiet weeks drops it to <code>monthly</code>; three quiet months archives it. Tiers are about attention, not quality.</p></div>
      <div><h3>What counts as "something new"</h3><p>A dated catalyst, a change in EPS, P/E, revenue, guidance, share count or earnings date, a material filing, an 8%+ session move, or RVOL at 3x or better. Earnings inside 14 days pin a name to daily on their own.</p></div>
      <div><h3>Gaps stay gaps</h3><p>A figure that could not be established reads <em>not disclosed</em> rather than being inferred, and a negative-earnings company shows no P/E instead of a negative multiple. Where sources disagree, both readings are shown on the name.</p></div>
    </div>
  </section>

  <footer class="foot">
    <strong>Research notes, not advice.</strong> Every figure here comes from a public source at the time of the pass and can be stale, revised, or wrong; earnings dates in particular move. Nothing on this page is a recommendation, a rating, or a price target &mdash; there is deliberately no score anywhere in it. Verify anything you would act on.
  </footer>
</div>

<script>
(function(){
  var rows = Array.prototype.slice.call(document.querySelectorAll('.row'));
  var groups = Array.prototype.slice.call(document.querySelectorAll('.group'));
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.filters button[data-filter]'));

  function apply(tier){
    rows.forEach(function(r){
      r.style.display = (tier === 'all' || r.dataset.tier === tier) ? '' : 'none';
    });
    groups.forEach(function(g){
      var visible = g.querySelectorAll('.row:not([style*="none"])').length;
      var isArchive = g.classList.contains('archived-group');
      g.style.display = (isArchive ? tier === 'all' : visible > 0) ? '' : 'none';
    });
    buttons.forEach(function(b){ b.setAttribute('aria-pressed', String(b.dataset.filter === tier)); });
    try { localStorage.setItem('cadence-filter', tier); } catch (e) {}
  }

  buttons.forEach(function(b){ b.addEventListener('click', function(){ apply(b.dataset.filter); }); });

  var expand = document.getElementById('expand-all');
  if (expand) expand.addEventListener('click', function(){
    var open = expand.getAttribute('aria-pressed') !== 'true';
    rows.forEach(function(r){ r.open = open; });
    expand.setAttribute('aria-pressed', String(open));
    expand.textContent = open ? 'collapse all' : 'expand all';
  });

  var saved = null;
  try { saved = localStorage.getItem('cadence-filter'); } catch (e) {}
  if (saved && buttons.some(function(b){ return b.dataset.filter === saved; })) apply(saved);
})();
</script>
`;

module.exports = { render, esc, money, growthBar, peCell };
