#!/usr/bin/env node
'use strict';
/*
 * Money Flow 3D — local server.
 *
 *   node flow/server.js            live data (Alpaca if keys are set, else Yahoo)
 *   node flow/server.js --demo     synthetic data, clearly labelled as simulated
 *   node flow/server.js --port 5000
 *
 * Zero dependencies. Needs Node 18+ (built-in fetch).
 *
 * "Money flow" here is the standard price-direction proxy, not a measurement of
 * capital entering or leaving anything: for each 5-minute bar,
 *   typical price = (high + low + close) / 3
 *   dollar volume = typical price x share volume
 *   signed flow   = +dollar volume if typical price rose vs the prior bar,
 *                   -dollar volume if it fell, 0 if unchanged.
 * Every trade has a buyer and a seller, so this measures which side was moving
 * the price, weighted by how much traded.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const PORT = Number(opt('port', process.env.PORT || 4173));
const DEMO = flag('demo');
const HAS_ALPACA = !!(process.env.ALPACA_KEY && process.env.ALPACA_SECRET);
const PROVIDER = DEMO ? 'demo' : opt('provider', HAS_ALPACA ? 'alpaca' : 'yahoo');
const REFRESH_MS = Math.max(30, Number(opt('refresh', 60))) * 1000;
const BAR = 300; // seconds
const UA = process.env.FLOW_USER_AGENT || 'money-flow-3d/1.0 (local personal use)';

// Six of the largest names per GICS sector. A static, hand-kept list: it is a
// sample of each sector, not the whole sector.
const SECTORS = [
  { id: 'tech', name: 'Technology', symbols: ['AAPL', 'MSFT', 'NVDA', 'AVGO', 'ORCL', 'AMD'] },
  { id: 'comm', name: 'Communication', symbols: ['GOOGL', 'META', 'NFLX', 'DIS', 'TMUS', 'VZ'] },
  { id: 'disc', name: 'Consumer Discretionary', symbols: ['AMZN', 'TSLA', 'HD', 'MCD', 'BKNG', 'LOW'] },
  { id: 'fin', name: 'Financials', symbols: ['BRK-B', 'JPM', 'V', 'MA', 'BAC', 'WFC'] },
  { id: 'health', name: 'Health Care', symbols: ['LLY', 'UNH', 'JNJ', 'ABBV', 'MRK', 'TMO'] },
  { id: 'indu', name: 'Industrials', symbols: ['GE', 'CAT', 'RTX', 'UBER', 'BA', 'HON'] },
  { id: 'stap', name: 'Consumer Staples', symbols: ['WMT', 'COST', 'PG', 'KO', 'PEP', 'PM'] },
  { id: 'energy', name: 'Energy', symbols: ['XOM', 'CVX', 'COP', 'WMB', 'EOG', 'SLB'] },
  { id: 'util', name: 'Utilities', symbols: ['NEE', 'SO', 'DUK', 'CEG', 'AEP', 'VST'] },
  { id: 'reit', name: 'Real Estate', symbols: ['PLD', 'AMT', 'EQIX', 'WELL', 'SPG', 'O'] },
  { id: 'mat', name: 'Materials', symbols: ['LIN', 'SHW', 'ECL', 'NEM', 'FCX', 'APD'] },
];
const INDEX = 'SPY';
const ALL = SECTORS.flatMap((s) => s.symbols).concat(INDEX);

// ---------------------------------------------------------------- time (ET)
const etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
function et(epochSec) {
  const p = {};
  for (const x of etFmt.formatToParts(new Date(epochSec * 1000))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}
const inRegular = (t) => { const m = et(t).min; return m >= 570 && m < 960; }; // 09:30–16:00

// ---------------------------------------------------------------- state
// store[symbol] = { prev: number|null, bars: [{t,h,l,c,v}] }  (t = bar start, epoch seconds)
const store = {};
const status = { provider: PROVIDER, lastAttempt: null, lastSuccess: null, errors: [], backoff: 1 };
let snapshot = null;

// ---------------------------------------------------------------- providers
async function getJson(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}

async function pool(items, n, fn) {
  let i = 0, stop = false;
  const out = [];
  await Promise.all(Array.from({ length: n }, async () => {
    while (!stop && i < items.length) {
      const it = items[i++];
      try { await fn(it); } catch (e) {
        out.push({ symbol: it, message: e.message });
        if (e.status === 429) stop = true; // rate limited: abandon this cycle
      }
    }
  }));
  return { errors: out, rateLimited: stop };
}

// Yahoo Finance chart endpoint. Unofficial and unsupported: no key, no SLA,
// may rate-limit (429) or change shape without notice.
async function refreshYahoo() {
  const res = await pool(ALL, 2, async (sym) => {
    await new Promise((r) => setTimeout(r, 150));
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}` +
      `?range=1d&interval=5m&includePrePost=false`;
    const j = await getJson(url, { 'User-Agent': UA, Accept: 'application/json' });
    const r = j && j.chart && j.chart.result && j.chart.result[0];
    if (!r) throw new Error('no chart result');
    const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
    const ts = r.timestamp || [];
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      const c = q.close && q.close[i], v = q.volume && q.volume[i];
      if (c == null || v == null) continue;
      bars.push({ t: ts[i], h: q.high[i] ?? c, l: q.low[i] ?? c, c, v });
    }
    const m = r.meta || {};
    store[sym] = { prev: m.chartPreviousClose ?? m.previousClose ?? null, bars };
  });
  if (res.rateLimited) { const e = new Error('rate limited by Yahoo (HTTP 429)'); e.status = 429; e.partial = res.errors; throw e; }
  return res.errors;
}

// Alpaca market data, free plan = IEX feed only (a small share of US volume).
async function refreshAlpaca() {
  const H = { 'APCA-API-KEY-ID': process.env.ALPACA_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET };
  const toA = (s) => s.replace('-', '.');
  const fromA = (s) => s.replace('.', '-');
  const syms = ALL.map(toA).join(',');
  const base = 'https://data.alpaca.markets/v2/stocks';
  const snaps = await getJson(`${base}/snapshots?symbols=${encodeURIComponent(syms)}&feed=iex`, H);
  let start = null;
  const prev = {};
  for (const [a, s] of Object.entries(snaps || {})) {
    if (s && s.dailyBar && (!start || s.dailyBar.t > start)) start = s.dailyBar.t;
    prev[fromA(a)] = s && s.prevDailyBar ? s.prevDailyBar.c : null;
  }
  if (!start) throw new Error('Alpaca returned no daily bars');
  const got = {};
  let token = null, pages = 0;
  do {
    const url = `${base}/bars?symbols=${encodeURIComponent(syms)}&timeframe=5Min&start=${encodeURIComponent(start)}` +
      `&limit=10000&feed=iex&adjustment=raw` + (token ? `&page_token=${encodeURIComponent(token)}` : '');
    const j = await getJson(url, H);
    for (const [a, list] of Object.entries(j.bars || {})) {
      const k = fromA(a);
      (got[k] = got[k] || []).push(...list.map((b) => ({ t: Math.floor(Date.parse(b.t) / 1000), h: b.h, l: b.l, c: b.c, v: b.v })));
    }
    token = j.next_page_token;
  } while (token && ++pages < 10);
  const errors = [];
  for (const sym of ALL) {
    if (got[sym] && got[sym].length) store[sym] = { prev: prev[sym] ?? null, bars: got[sym] };
    else errors.push({ symbol: sym, message: 'no bars returned' });
  }
  return errors;
}

// Synthetic session for offline use. Not market data.
function fillDemo() {
  let seed = 20261113;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const now = Math.floor(Date.now() / 1000);
  let t0 = Math.floor(now / 86400) * 86400 + 14 * 3600 + 1800;
  t0 += (570 - et(t0).min) * 60; // snap to 09:30 ET on this date
  const N = 78;
  const mkt = Array.from({ length: N }, () => gauss() * 0.0004);
  for (const sec of SECTORS.concat({ symbols: [INDEX] })) {
    const drift = gauss() * 0.00008;
    const wave = Array.from({ length: N }, (_, i) => Math.sin(i / 9 + rnd() * 6) * 0.0005);
    for (const sym of sec.symbols) {
      const prev = 40 + rnd() * 560;
      const baseVol = (3e8 + rnd() * 4e9) / prev / N;
      let c = prev * (1 + gauss() * 0.006);
      const bars = [];
      for (let i = 0; i < N; i++) {
        const o = c;
        c = o * (1 + mkt[i] + drift + wave[i] + gauss() * 0.0012);
        const u = 1 + 2.2 * Math.pow(Math.abs(i - (N - 1) / 2) / ((N - 1) / 2), 2.2); // U-shaped volume
        const spread = Math.abs(gauss()) * 0.0008 * c;
        bars.push({ t: t0 + i * BAR, h: Math.max(o, c) + spread, l: Math.min(o, c) - spread, c, v: Math.round(baseVol * u * (0.6 + rnd() * 0.8)) });
      }
      store[sym] = { prev, bars };
    }
  }
}

// ---------------------------------------------------------------- snapshot
function build() {
  // Latest session date present, regular hours only, snapped to the 5-minute grid.
  let latest = '';
  for (const sym of ALL) for (const b of (store[sym] ? store[sym].bars : [])) {
    const d = et(b.t).date; if (d > latest) latest = d;
  }
  if (!latest) return null;
  const grid = new Set();
  const clean = {};
  for (const sym of ALL) {
    const m = new Map();
    for (const b of (store[sym] ? store[sym].bars : [])) {
      if (et(b.t).date !== latest || !inRegular(b.t)) continue;
      const t = Math.floor(b.t / BAR) * BAR;
      const x = m.get(t);
      if (x) { x.h = Math.max(x.h, b.h); x.l = Math.min(x.l, b.l); x.c = b.c; x.v += b.v; }
      else m.set(t, { h: b.h, l: b.l, c: b.c, v: b.v });
      grid.add(t);
    }
    clean[sym] = m;
  }
  const times = [...grid].sort((a, b) => a - b);
  if (!times.length) return null;

  const series = (sym) => {
    const m = clean[sym], prev = store[sym] ? store[sym].prev : null;
    if (!m || !m.size) return null;
    const px = [], dv = [], mf = [];
    let lastTp = prev, lastC = null;
    for (const t of times) {
      const b = m.get(t);
      if (!b) { px.push(lastC); dv.push(0); mf.push(0); continue; }
      const tp = (b.h + b.l + b.c) / 3;
      const d = tp * b.v;
      const sign = lastTp == null ? 0 : Math.sign(tp - lastTp);
      px.push(+b.c.toFixed(4)); dv.push(Math.round(d)); mf.push(Math.round(sign * d));
      lastTp = tp; lastC = +b.c.toFixed(4);
    }
    return { prev, px, dv, mf };
  };

  const missing = [];
  const sectors = SECTORS.map((s) => ({
    id: s.id, name: s.name,
    stocks: s.symbols.map((sym) => { const x = series(sym); if (!x) { missing.push(sym); return null; } return { symbol: sym, ...x }; }).filter(Boolean),
  }));
  const idx = series(INDEX);
  const lastBar = times[times.length - 1];
  const now = Math.floor(Date.now() / 1000);
  return {
    provider: PROVIDER,
    simulated: PROVIDER === 'demo',
    sessionDate: latest,
    barSeconds: BAR,
    times,
    // "live" = the newest bar is recent. Otherwise this is the last completed session.
    live: PROVIDER !== 'demo' && now - lastBar < 15 * 60,
    index: idx ? { symbol: INDEX, ...idx } : null,
    sectors,
    missing,
    lastSuccess: status.lastSuccess,
    lastAttempt: status.lastAttempt,
    errors: status.errors.slice(0, 12),
    serverTime: now,
  };
}

async function cycle() {
  status.lastAttempt = Math.floor(Date.now() / 1000);
  try {
    const errs = PROVIDER === 'alpaca' ? await refreshAlpaca() : await refreshYahoo();
    status.errors = errs;
    if (errs.length < ALL.length) { status.lastSuccess = status.lastAttempt; status.backoff = 1; }
    if (errs.length) console.warn(`[flow] ${errs.length}/${ALL.length} symbols failed, e.g. ${errs[0].symbol}: ${errs[0].message}`);
  } catch (e) {
    status.errors = [{ symbol: '*', message: e.message }].concat(e.partial || []);
    status.backoff = Math.min(status.backoff * 2, 10);
    console.warn(`[flow] refresh failed: ${e.message}. Next try in ${(REFRESH_MS * status.backoff) / 1000}s`);
  }
  snapshot = build() || snapshot;
  setTimeout(cycle, REFRESH_MS * status.backoff);
}

// ---------------------------------------------------------------- http
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/flow') {
    if (!snapshot) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'No data yet', provider: PROVIDER, errors: status.errors.slice(0, 12) }));
    }
    snapshot.serverTime = Math.floor(Date.now() / 1000);
    snapshot.errors = status.errors.slice(0, 12);
    snapshot.lastAttempt = status.lastAttempt;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(snapshot));
  }
  const rel = path.normalize(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.join(PUB, rel);
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[flow] Money Flow 3D on http://localhost:${PORT}  (data: ${PROVIDER})`);
  if (PROVIDER === 'demo') { fillDemo(); status.lastSuccess = Math.floor(Date.now() / 1000); snapshot = build(); }
  else cycle();
});
