#!/usr/bin/env node
'use strict';
// Builds riskmap.html from lib/riskmap.template.html.
//
//   node bin/build-riskmap.js
//
// The map's three axes (risk, reward, chance) are the user's own estimates and
// are never stored in this repo. The only thing embedded here is facts already
// in data/*.json (name, theme, tier, last price, newest dated catalyst), shown
// as context when a scenario is named after a tracked ticker.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');
const watch = {};
let asOf = '';

for (const f of fs.readdirSync(dataDir).filter(n => n.endsWith('.json')).sort()) {
  const d = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
  if (!d.ticker) continue;
  const cat = (d.catalysts || []).filter(c => c && c.date && c.headline)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  const e = { n: d.name || null, th: d.theme || null, t: d.tier || null };
  if (d.price && d.price.last != null) { e.p = d.price.last; e.pd = d.price.asOf || null; }
  if (cat) { e.cd = cat.date; e.c = cat.headline.length > 220 ? cat.headline.slice(0, 217) + '...' : cat.headline; }
  watch[d.ticker.toUpperCase()] = e;
  const day = String(d.lastResearched || '').slice(0, 10);
  if (day > asOf) asOf = day;
}

const json = JSON.stringify(watch).replace(/</g, '\\u003c');
const tpl = fs.readFileSync(path.join(root, 'lib', 'riskmap.template.html'), 'utf8');
const out = tpl.replace('/*__DATA__*/{}', () => json).replace('/*__ASOF__*/', () => asOf);
fs.writeFileSync(path.join(root, 'riskmap.html'), out);
console.log(`riskmap.html: ${Object.keys(watch).length} tickers, as of ${asOf}`);
