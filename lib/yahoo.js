'use strict';
// Yahoo Finance endpoints the small-float scanner reads. Read-only.
//
//   session()            one cookie + crumb per run; needed by screen() and keyStats()
//   screen(sess, query)  custom equity screen (the whole listed universe, filtered server-side)
//   keyStats(sess, t)    float, shares outstanding, short interest, market cap, pre/post move
//   news(t)              recent headlines for one ticker: publisher, timestamp, link (no crumb)
//   financials(t)        quarterly revenue / net income / EPS / shares / cash (no crumb)
//
// Yahoo is an aggregator: every figure taken from here is labelled as Yahoo
// with its as-of date, never passed off as the company's own filing.

const H = require('./http');

const Q1 = 'https://query1.finance.yahoo.com';
const Q2 = 'https://query2.finance.yahoo.com';
const raw = (x) => (x && typeof x === 'object' ? (x.raw === undefined ? null : x.raw) : (x === undefined ? null : x));
const isoDay = (sec) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : null);

async function session() {
  const res = await H.request('https://fc.yahoo.com/', { retries: 0 });
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  await res.arrayBuffer().catch(() => null);
  const cookie = set.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('fc.yahoo.com set no cookie');
  const r2 = await H.request(Q2 + '/v1/test/getcrumb', { headers: { Cookie: cookie }, retries: 0 });
  const crumb = (await r2.text()).trim();
  // A real crumb is a short token; anything with spaces is an error message
  // ("Too Many Requests", "Invalid Cookie") sent with a 200 or a 4xx.
  if (!r2.ok || !crumb || /\s/.test(crumb) || crumb.length > 24) {
    throw new Error('crumb refused (HTTP ' + r2.status + ': ' + crumb.slice(0, 40) + ')');
  }
  return { cookie: cookie, crumb: crumb };
}

// query: Yahoo screener operand tree. Returns { total, quotes }.
async function screen(sess, query, opts) {
  opts = opts || {};
  const body = {
    size: opts.size || 250, offset: opts.offset || 0,
    sortField: opts.sortField || 'percentchange', sortType: opts.sortType || 'DESC',
    quoteType: 'EQUITY', query: query, userId: '', userIdType: 'guid',
  };
  const res = await H.request(Q2 + '/v1/finance/screener?crumb=' + encodeURIComponent(sess.crumb), {
    method: 'POST', body: JSON.stringify(body),
    headers: { Cookie: sess.cookie, 'Content-Type': 'application/json' }, accept: 'application/json',
  });
  const text = await res.text();
  if (!res.ok) throw new Error('screener HTTP ' + res.status + ': ' + text.slice(0, 120));
  const r = ((JSON.parse(text).finance || {}).result || [])[0];
  if (!r) throw new Error('screener returned no result');
  return { total: r.total || 0, quotes: r.quotes || [] };
}

async function keyStats(sess, ticker) {
  const url = Q2 + '/v10/finance/quoteSummary/' + encodeURIComponent(ticker) +
    '?modules=defaultKeyStatistics,price,assetProfile&crumb=' + encodeURIComponent(sess.crumb);
  const json = await H.getJSON(url, { headers: { Cookie: sess.cookie }, accept: 'application/json' });
  const r = ((json.quoteSummary || {}).result || [])[0];
  if (!r) throw new Error('quoteSummary empty for ' + ticker);
  const k = r.defaultKeyStatistics || {};
  const p = r.price || {};
  const a = r.assetProfile || {};
  return {
    ticker: ticker,
    name: p.longName || p.shortName || null,
    exchange: p.exchange || null,
    quoteType: p.quoteType || null,
    sector: a.sector || null,
    industry: a.industry || null,
    price: raw(p.regularMarketPrice),
    changePct: raw(p.regularMarketChangePercent) === null ? null : raw(p.regularMarketChangePercent) * 100,
    priceTime: p.regularMarketTime ? new Date(p.regularMarketTime * 1000).toISOString() : null,
    preMarketChangePct: raw(p.preMarketChangePercent) === null ? null : raw(p.preMarketChangePercent) * 100,
    preMarketPrice: raw(p.preMarketPrice),
    postMarketChangePct: raw(p.postMarketChangePercent) === null ? null : raw(p.postMarketChangePercent) * 100,
    postMarketPrice: raw(p.postMarketPrice),
    marketCap: raw(p.marketCap),
    volume: raw(p.regularMarketVolume),
    floatShares: raw(k.floatShares),
    sharesOutstanding: raw(k.sharesOutstanding),
    impliedSharesOutstanding: raw(k.impliedSharesOutstanding),
    sharesShort: raw(k.sharesShort),
    shortPercentOfFloat: raw(k.shortPercentOfFloat) === null ? null : raw(k.shortPercentOfFloat) * 100,
    dateShortInterest: isoDay(raw(k.dateShortInterest)),
    heldPercentInsiders: raw(k.heldPercentInsiders) === null ? null : raw(k.heldPercentInsiders) * 100,
  };
}

async function news(ticker, count) {
  const url = Q1 + '/v1/finance/search?q=' + encodeURIComponent(ticker) +
    '&quotesCount=0&newsCount=' + (count || 12) + '&enableFuzzyQuery=false';
  const json = await H.getJSON(url, { accept: 'application/json' });
  return (json.news || [])
    // Search is fuzzy; keep only stories Yahoo itself tags with this ticker.
    .filter((n) => (n.relatedTickers || []).map((s) => String(s).toUpperCase()).indexOf(ticker.toUpperCase()) !== -1)
    .map((n) => ({
      title: n.title,
      publisher: n.publisher || null,
      url: n.link || null,
      publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
      relatedTickers: n.relatedTickers || [],
    }));
}

// Yahoo's own saved screens — no crumb needed. The fallback universe when
// the crumb is refused (it is rate-limited per IP and fails intermittently).
async function predefined(id, count) {
  const url = Q1 + '/v1/finance/screener/predefined/saved?scrIds=' + encodeURIComponent(id) + '&count=' + (count || 250);
  const json = await H.getJSON(url, { accept: 'application/json' });
  const r = ((json.finance || {}).result || [])[0];
  return { total: r ? r.total || 0 : 0, quotes: r ? r.quotes || [] : [] };
}

// Shares outstanding and market cap without a crumb, from the fundamentals
// series. Used only when key stats are unavailable; float is not in it.
async function sharesAndCap(ticker) {
  const now = Math.floor(Date.now() / 1000);
  const url = Q2 + '/ws/fundamentals-timeseries/v1/finance/timeseries/' + encodeURIComponent(ticker) +
    '?type=quarterlyOrdinarySharesNumber,trailingMarketCap&period1=' + (now - 400 * 86400) + '&period2=' + now;
  const json = await H.getJSON(url, { accept: 'application/json' });
  const out = { sharesOutstanding: null, sharesAsOf: null, marketCap: null, marketCapAsOf: null };
  (((json.timeseries || {}).result) || []).forEach((r) => {
    const type = ((r.meta || {}).type || [])[0];
    const vals = (r[type] || []).filter((v) => v && v.reportedValue).sort((a, b) => a.asOfDate.localeCompare(b.asOfDate));
    const last = vals[vals.length - 1];
    if (!last) return;
    if (type === 'quarterlyOrdinarySharesNumber') { out.sharesOutstanding = raw(last.reportedValue); out.sharesAsOf = last.asOfDate; }
    if (type === 'trailingMarketCap') { out.marketCap = raw(last.reportedValue); out.marketCapAsOf = last.asOfDate; }
  });
  return out;
}

const FIN_TYPES = ['quarterlyTotalRevenue', 'quarterlyNetIncome', 'quarterlyDilutedEPS',
  'quarterlyOrdinarySharesNumber', 'quarterlyCashAndCashEquivalents'];

async function financials(ticker) {
  const now = Math.floor(Date.now() / 1000);
  const url = Q2 + '/ws/fundamentals-timeseries/v1/finance/timeseries/' + encodeURIComponent(ticker) +
    '?type=' + FIN_TYPES.join(',') + '&period1=' + (now - 2 * 366 * 86400) + '&period2=' + now;
  const json = await H.getJSON(url, { accept: 'application/json' });
  const out = {};
  (((json.timeseries || {}).result) || []).forEach((r) => {
    const type = ((r.meta || {}).type || [])[0];
    if (!type) return;
    const key = type.replace(/^quarterly/, '');
    out[key] = (r[type] || []).filter(Boolean)
      .map((v) => ({ asOfDate: v.asOfDate, value: raw(v.reportedValue) }))
      .filter((v) => v.asOfDate && typeof v.value === 'number')
      .sort((a, b) => a.asOfDate.localeCompare(b.asOfDate));
  });
  return out;
}

module.exports = { session, screen, predefined, keyStats, sharesAndCap, news, financials, raw };
