#!/usr/bin/env node
'use strict';
// One-off (but reusable) recovery tool: reconstructs data/*.json from a
// previously-published dashboard.html when git never captured the state that
// produced it (see RUNBOOK.md "Data gap left by the outage"). Parses the
// rendered DOM rather than regexing raw HTML, since the page's own class
// names are the closest thing we have to a stable schema here.
//
// Figures that went through money()/toFixed() in lib/build.js are rounded on
// the page, so values recovered this way are approximate, not primary-source
// exact. Every reconstructed record is flagged as such via `recoveredFrom` so
// a future full pass knows to re-verify rather than trust it blindly.
//
// Usage: node bin/recover-from-dashboard.js <path-to-saved-dashboard.html>

const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_REQUIRE || 'playwright');
const S = require('../lib/state');

const file = process.argv[2];
if (!file) {
  console.error('usage: node bin/recover-from-dashboard.js <path-to-saved-dashboard.html>');
  process.exit(1);
}
const absPath = path.resolve(file);

function parseMoney(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  const m = s.match(/^(-?[\d.]+)\s*([TBMK])?$/i);
  if (!m) { const n = parseFloat(s); return Number.isNaN(n) ? null : n; }
  const n = parseFloat(m[1]);
  const mult = { T: 1e12, B: 1e9, M: 1e6, K: 1e3 }[(m[2] || '').toUpperCase()] || 1;
  return Math.round(n * mult);
}

async function main() {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  await page.goto('file://' + absPath);

  const extracted = await page.evaluate(() => {
    function text(el) { return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; }

    function parseFactValue(dd) {
      if (!dd) return undefined;
      const nd = dd.querySelector('.nd');
      if (nd) return { value: null, note: text(nd) };
      const v = dd.querySelector('.v');
      const asof = dd.querySelector('.asof');
      const out = { value: v ? text(v) : null };
      if (asof) out.asOf = text(asof);
      return out;
    }

    function parseShortInterest(dd) {
      if (!dd) return undefined;
      const nd = dd.querySelector('.nd');
      if (nd) return { value: null, note: text(nd) };
      const v = dd.querySelector('.v');
      const out = { value: v ? text(v).replace('%', '') : null };
      const note = dd.querySelector('.si-note');
      if (note) out.note = text(note);
      return out;
    }

    const rows = Array.from(document.querySelectorAll('details.row'));
    const records = rows.map((row) => {
      const ticker = row.dataset.ticker;
      const tier = row.dataset.tier;
      const group = row.closest('.group');
      const theme = group ? group.dataset.themeGroup : null;
      const themeLabel = group ? text(group.querySelector('.group-label')) : null;
      const name = text(row.querySelector('.c-tick .nm'));

      // --- price (summary row only; asOf/rvol/source are not rendered) ---
      const pxWrap = row.querySelector(':scope > summary > .c-px');
      const pxText = pxWrap ? text(pxWrap.querySelector('.px')) : null;
      const chgText = pxWrap ? text(pxWrap.querySelector('.px-chg')) : null;
      const price = (pxText || chgText) ? {
        last: pxText ? pxText : null,
        changePct: chgText ? chgText.replace('%', '').replace('+', '') : null,
      } : null;

      // --- snapshot facts ---
      const factMap = {};
      row.querySelectorAll('.facts dl > div').forEach((d) => {
        const dt = text(d.querySelector('dt'));
        if (dt) factMap[dt] = d.querySelector('dd');
      });

      const peWrap = row.querySelector(':scope > summary > .c-pe');
      let pe;
      if (peWrap) {
        const peNd = peWrap.querySelector('.nd');
        if (peNd) {
          pe = { trailing: null, forward: null, note: text(peNd) };
        } else {
          pe = { trailing: null, forward: null };
          peWrap.querySelectorAll('.v').forEach((v) => {
            const val = text(v);
            if (v.classList.contains('dim')) pe.forward = val; else pe.trailing = val;
          });
        }
      }

      const neDD = factMap['Next earnings'];
      let nextEarnings;
      if (neDD) {
        const nd = neDD.querySelector('.nd');
        if (nd) {
          nextEarnings = null;
        } else {
          const v = text(neDD.querySelector('.v'));
          const confirmed = !neDD.querySelector('.unit');
          nextEarnings = { date: v, confirmed: confirmed };
        }
      }

      const growthWrap = row.querySelector(':scope > summary > .c-growth .growth, :scope > summary > .c-growth');
      let growth = null;
      if (growthWrap) {
        const none = growthWrap.querySelector('.growth-none');
        if (none) {
          growth = { metric: null, period: null, pct: null, note: text(none) };
        } else {
          const pctText = text(growthWrap.querySelector('.growth-pct'));
          const metricText = text(growthWrap.querySelector('.growth-metric'));
          growth = { metric: metricText, period: null, pct: pctText ? pctText.replace('%', '').replace('+', '') : null };
        }
      }

      // EPS / revenue tables in the detail panel (fuller than the 3-wide summary strip)
      const eps = [];
      const revenue = [];
      row.querySelectorAll('.tables h4').forEach((h4) => {
        const label = text(h4);
        const table = h4.nextElementSibling;
        if (!table || table.tagName !== 'TABLE') return;
        const trs = Array.from(table.querySelectorAll('tbody tr'));
        if (/^EPS$/i.test(label)) {
          trs.forEach((tr) => {
            const tds = tr.querySelectorAll('td');
            eps.push({ period: text(tds[0]), value: text(tds[1]), basis: text(tds[2]) || undefined });
          });
        } else if (/^Revenue$/i.test(label)) {
          trs.forEach((tr) => {
            const tds = tr.querySelectorAll('td');
            revenue.push({ period: text(tds[0]), value: text(tds[1]), yoy: text(tds[2]) });
          });
        }
      });

      // Catalysts
      const catalysts = [];
      row.querySelectorAll('.feed > li').forEach((li) => {
        const date = text(li.querySelector('.feed-head time'));
        const type = text(li.querySelector('.feed-type')) || undefined;
        const headline = text(li.querySelector('.feed-body'));
        const impact = text(li.querySelector('.feed-impact')) || undefined;
        const srcA = li.querySelector('a.feed-src[href]');
        const srcSpan = li.querySelector('span.feed-src');
        const source = srcA ? srcA.getAttribute('href') : undefined;
        const sourceName = !srcA && srcSpan ? text(srcSpan) : undefined;
        catalysts.push({ date, type, headline, impact, source, sourceName });
      });

      const pendingFilings = Array.from(row.querySelectorAll('.filings ul li')).map(text);
      const conflicts = Array.from(row.querySelectorAll('.conflicts ul li')).map(text);
      const notes = text(row.querySelector('.notes p'));

      const history = [];
      row.querySelectorAll('.pass-list li').forEach((li) => {
        const date = text(li.querySelector('time'));
        const run = (text(li.querySelector('.run-tag')) || '').toLowerCase();
        const quiet = !!li.querySelector('.quiet-tag');
        const chgEl = li.querySelector('.chg');
        const changes = chgEl ? text(chgEl).split(',').map((s) => s.trim()).filter(Boolean) : [];
        const moveEl = li.querySelector('.tier-move');
        let histTier, histFrom;
        if (moveEl) {
          const parts = text(moveEl).split('→').map((s) => s.trim());
          histFrom = parts[0]; histTier = parts[1];
        }
        history.push({ date, run, quiet, changes, tier: histTier, from: histFrom });
      });

      return {
        ticker, tier, theme, themeLabel, name, price,
        marketCap: parseFactValue(factMap['Market cap']),
        float: parseFactValue(factMap['Float']),
        sharesOutstanding: parseFactValue(factMap['Shares out']),
        shortInterest: parseShortInterest(factMap['Short interest']),
        cash: parseFactValue(factMap['Cash']),
        debt: parseFactValue(factMap['Debt']),
        pe, nextEarnings, growth, eps, revenue,
        catalysts, pendingFilings, conflicts, notes, history,
      };
    });

    const archivedTickers = Array.from(document.querySelectorAll('.archived-group .archived-list .dtk')).map((el) => el.textContent.trim());

    return { records, archivedTickers, builtStamp: text(document.querySelector('.mast .stamp')) };
  });

  await browser.close();
  return extracted;
}

main().then((extracted) => {
  const { records, archivedTickers, builtStamp } = extracted;
  console.log('parsed ' + records.length + ' detailed rows + ' + archivedTickers.length + ' archived-only tickers from ' + absPath);
  console.log('page stamp: ' + builtStamp);

  const out = records.map((r) => {
    const moneyVal = (f) => (f === undefined ? undefined : (f.value === null ? { value: null, note: f.note } :
      Object.assign({}, f, { value: parseMoney(f.value) })));
    const numVal = (f) => (f === undefined ? undefined : (f.value === null ? { value: null, note: f.note } :
      Object.assign({}, f, { value: f.value === null ? null : parseFloat(f.value) })));

    const lastHistDate = r.history.length ? r.history[0].date : null;

    const rec = {
      ticker: r.ticker,
      name: r.name,
      sector: null,
      theme: r.theme,
      themeLabel: r.themeLabel,
      tier: r.tier,
      addedOn: null,
      addedReason: null,
      quietRuns: 0,
      lastResearched: lastHistDate ? lastHistDate + 'T12:00:00.000Z' : null,
      fundamentals: {
        marketCap: moneyVal(r.marketCap),
        float: moneyVal(r.float),
        sharesOutstanding: moneyVal(r.sharesOutstanding),
        shortInterest: numVal(r.shortInterest),
        cash: moneyVal(r.cash),
        debt: moneyVal(r.debt),
        pe: r.pe ? {
          trailing: r.pe.trailing != null ? parseFloat(r.pe.trailing) : null,
          forward: r.pe.forward != null ? parseFloat(r.pe.forward) : null,
          note: r.pe.note,
        } : undefined,
        eps: r.eps.map((e) => ({ period: e.period, value: e.value === 'n/d' ? null : parseFloat(e.value), basis: e.basis })),
        revenue: r.revenue.map((rv) => ({
          period: rv.period,
          value: rv.value === 'n/d' ? null : parseMoney(rv.value),
          yoy: rv.yoy && rv.yoy !== '—' ? parseFloat(rv.yoy) : null,
        })),
        growth: r.growth ? {
          metric: r.growth.metric, period: r.growth.period,
          pct: r.growth.pct != null ? parseFloat(r.growth.pct) : null,
          note: r.growth.note,
        } : undefined,
        nextEarnings: r.nextEarnings,
      },
      price: r.price ? {
        last: r.price.last != null ? parseFloat(r.price.last) : null,
        changePct: r.price.changePct != null ? parseFloat(r.price.changePct) : null,
      } : null,
      catalysts: r.catalysts,
      conflicts: r.conflicts,
      pendingFilings: r.pendingFilings,
      notes: r.notes || undefined,
      history: r.history,
      recoveredFrom: {
        source: path.basename(absPath),
        pageStamp: builtStamp,
        recoveredOn: new Date().toISOString(),
        caveat: 'Reconstructed by parsing a previously-published dashboard page, not re-researched from primary sources. Monetary figures are back-converted from the page\'s rounded K/M/B/T display and are approximate. Re-verify on this ticker\'s next due full pass.',
      },
    };
    // Drop undefined fundamentals keys so val()/peCell() in build.js see
    // "missing" rather than an explicit null where the page had nothing.
    Object.keys(rec.fundamentals).forEach((k) => { if (rec.fundamentals[k] === undefined) delete rec.fundamentals[k]; });
    return rec;
  });

  fs.mkdirSync(S.P.data, { recursive: true });
  out.forEach((rec) => S.saveTicker(rec));
  console.log('wrote ' + out.length + ' file(s) to ' + S.P.data);

  if (archivedTickers.length) {
    console.log('archived-only tickers (ticker symbol only, no detail available — writing stubs): ' + archivedTickers.join(' '));
    archivedTickers.forEach((t) => {
      if (S.loadTicker(t)) return; // already covered by a detailed row somehow
      S.saveTicker({
        ticker: t, name: null, sector: null, theme: null, themeLabel: null, tier: 'archived',
        addedOn: null, addedReason: null, quietRuns: 0, lastResearched: null,
        fundamentals: {}, price: null, catalysts: [], conflicts: [], pendingFilings: [],
        history: [],
        recoveredFrom: {
          source: path.basename(absPath), pageStamp: builtStamp, recoveredOn: new Date().toISOString(),
          caveat: 'Archived tickers only list a symbol on the dashboard, no detail panel. This is a bare stub; re-research fully if this name ever wakes back up.',
        },
      });
    });
  }
}).catch((e) => { console.error(e); process.exit(1); });
