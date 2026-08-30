'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const P = {
  root: ROOT,
  watchlist: path.join(ROOT, 'watchlist.json'),
  sectors: path.join(ROOT, 'sectors.json'),
  data: path.join(ROOT, 'data'),
  runs: path.join(ROOT, 'runs'),
  dashboard: path.join(ROOT, 'dashboard.html'),
};

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

const loadWatchlist = () => readJSON(P.watchlist, { updated: null, tickers: {} });
const saveWatchlist = (w) => { w.updated = new Date().toISOString(); writeJSON(P.watchlist, w); };
const loadSectors = () => readJSON(P.sectors, { updated: null, themes: {} });
const saveSectors = (s) => { s.updated = new Date().toISOString(); writeJSON(P.sectors, s); };

const tickerFile = (t) => path.join(P.data, `${t.toUpperCase()}.json`);
const loadTicker = (t) => readJSON(tickerFile(t), null);
const saveTicker = (rec) => writeJSON(tickerFile(rec.ticker), rec);

function allTickers() {
  if (!fs.existsSync(P.data)) return [];
  return fs.readdirSync(P.data)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJSON(path.join(P.data, f), null))
    .filter(Boolean);
}

module.exports = { P, readJSON, writeJSON, loadWatchlist, saveWatchlist,
  loadSectors, saveSectors, tickerFile, loadTicker, saveTicker, allTickers };
