#!/usr/bin/env node
// Builds jarvis-data.json: a compact copy of data/*.json that the Jarvis page (jarvis.html)
// reads so it can answer questions about the tracked names. Run after every pass, then
// publish jarvis.html with this file alongside it (see RUNBOOK.md, Publishing).
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const cut = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n - 1) + '…' : s);
const val = f => (f && f.value != null ? { value: f.value, asOf: f.asOf || null } : null);

const names = fs.readdirSync(path.join(root, 'data')).filter(f => f.endsWith('.json')).sort();
const tickers = {};
let latest = null;

for (const file of names) {
  const d = JSON.parse(fs.readFileSync(path.join(root, 'data', file), 'utf8'));
  if (!d.ticker) continue;
  const f = d.fundamentals || {};
  const lp = d.lastPass || {};
  if (lp.date && (!latest || lp.date + lp.run > latest.date + latest.run)) latest = { date: lp.date, run: lp.run };
  tickers[d.ticker] = {
    ticker: d.ticker,
    name: d.name || null,
    sector: d.sector || null,
    theme: d.theme || null,
    tier: d.tier || null,
    lastResearched: d.lastResearched || null,
    price: d.price ? { last: d.price.last, changePct: d.price.changePct, rvol: d.price.rvol, asOf: d.price.asOf, note: cut(d.price.note, 240) } : null,
    marketCap: val(f.marketCap),
    sharesOutstanding: val(f.sharesOutstanding),
    float: val(f.float),
    cash: val(f.cash),
    debt: val(f.debt),
    pe: f.pe ? { trailing: f.pe.trailing, forward: f.pe.forward } : null,
    nextEarnings: f.nextEarnings || null,
    catalysts: (d.catalysts || [])
      .slice()
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, 8)
      .map(c => ({ date: c.date, type: c.type, headline: cut(c.headline, 420), source: c.source || undefined })),
    conflicts: (d.conflicts || []).slice(0, 6).map(c => cut(typeof c === 'string' ? c : JSON.stringify(c), 300)),
    pendingFilings: (d.pendingFilings || []).slice(0, 6).map(c => cut(typeof c === 'string' ? c : JSON.stringify(c), 200)),
    notes: cut(d.notes, 600),
    lastPass: lp.date ? { date: lp.date, run: lp.run, quiet: !!lp.quiet, changes: (lp.changes || []).slice(0, 8).map(c => cut(typeof c === 'string' ? c : JSON.stringify(c), 200)) } : null
  };
}

const out = { builtAt: new Date().toISOString(), latestPass: latest, count: Object.keys(tickers).length, tickers };
fs.writeFileSync(path.join(root, 'jarvis-data.json'), JSON.stringify(out));
console.log(`jarvis-data.json: ${out.count} names, latest pass ${latest ? latest.date + ' ' + latest.run : 'unknown'}, ${fs.statSync(path.join(root, 'jarvis-data.json')).size} bytes`);
