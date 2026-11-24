'use strict';
// SEC EDGAR access for the small-float scanner.
//
// SEC's fair-access policy requires automated clients to declare who they are
// in the User-Agent ("Name contact@example.com"); www.sec.gov answers anything
// else with "Undeclared Automated Tool". So NOTHING here sends a request unless
// SEC_USER_AGENT is set in the environment. Without it the scanner skips SEC
// and says so in its report, instead of sending undeclared requests.
//
// The variable is set on the cloud environment, never committed: this repo is
// public, and the contact is a personal address.

const H = require('./http');

const ua = () => String(process.env.SEC_USER_AGENT || '').trim();
const enabled = () => /\S+@\S+\.\S+/.test(ua());
const disabledReason = () => (enabled() ? null
  : 'SEC_USER_AGENT is not set — SEC requires a declared contact, so 8-K and dilution checks were skipped');

const opts = () => ({ ua: ua(), accept: 'application/json, application/atom+xml, */*', timeout: 25000 });

// ticker -> { cik, title } and cik -> ticker. One request per run.
let mapCache = null;
async function cikMap() {
  if (mapCache) return mapCache;
  const json = await H.getJSON('https://www.sec.gov/files/company_tickers.json', opts());
  const byTicker = {};
  const byCik = {};
  Object.keys(json).forEach((k) => {
    const c = json[k];
    const t = String(c.ticker || '').toUpperCase();
    if (!t) return;
    byTicker[t] = { cik: c.cik_str, title: c.title };
    // The first listing is the primary share class; keep it.
    if (!byCik[c.cik_str]) byCik[c.cik_str] = t;
  });
  mapCache = { byTicker: byTicker, byCik: byCik };
  return mapCache;
}

const decode = (s) => String(s || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const pick = (s, re) => { const m = re.exec(s); return m ? m[1] : null; };

// Parse EDGAR's "current events" Atom feed. Entry titles look like
//   "8-K - BIO-key International Inc (0001019034) (Filer)"
// and the summary carries "Filed: … AccNo: … Item 2.02: …".
function parseCurrentFeed(xml) {
  const entries = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml))) {
    const e = m[1];
    const title = decode(pick(e, /<title[^>]*>([\s\S]*?)<\/title>/)).trim();
    const summary = decode(pick(e, /<summary[^>]*>([\s\S]*?)<\/summary>/));
    const tm = /^(\S+(?:\/A)?)\s+-\s+(.+?)\s+\((\d{4,10})\)\s+\(([^)]+)\)\s*$/.exec(title);
    entries.push({
      form: tm ? tm[1] : pick(e, /<category[^>]*term="([^"]+)"/),
      company: tm ? tm[2] : title,
      cik: tm ? parseInt(tm[3], 10) : null,
      role: tm ? tm[4] : null,
      url: pick(e, /<link[^>]*href="([^"]+)"/),
      updated: pick(e, /<updated>([^<]+)<\/updated>/),
      accession: pick(summary, /AccNo:\s*(?:<\/b>)?\s*([\d-]{18,20})/),
      items: (summary.match(/Item\s+\d{1,2}\.\d{2}/g) || []).map((s) => s.replace(/Item\s+/, '')),
    });
  }
  return entries;
}

// 8-Ks filed since `sinceIso`, newest first, paging the feed until it passes
// the window or hits maxPages.
async function recent8Ks(sinceIso, maxPages) {
  const since = Date.parse(sinceIso);
  const out = [];
  for (let page = 0; page < (maxPages || 6); page++) {
    const url = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include' +
      '&start=' + (page * 100) + '&count=100&output=atom';
    const xml = await H.getText(url, opts());
    const entries = parseCurrentFeed(xml);
    if (!entries.length) break;
    let older = false;
    entries.forEach((en) => {
      if (Date.parse(en.updated) < since) { older = true; return; }
      if (en.role && !/filer/i.test(en.role)) return; // skip "(Subject)"/"(Reporting)" duplicates
      out.push(en);
    });
    if (older) break;
    await H.sleep(250);
  }
  return out;
}

// Recent filings for one company from data.sec.gov's submissions API.
async function submissions(cik) {
  const pad = String(cik).padStart(10, '0');
  const json = await H.getJSON('https://data.sec.gov/submissions/CIK' + pad + '.json', opts());
  return flattenRecent(json, cik);
}

function flattenRecent(json, cik) {
  const r = (json.filings || {}).recent || {};
  const rows = [];
  const n = (r.form || []).length;
  for (let i = 0; i < n; i++) {
    const acc = r.accessionNumber[i];
    rows.push({
      form: r.form[i],
      filingDate: r.filingDate[i],
      acceptance: r.acceptanceDateTime ? r.acceptanceDateTime[i] : null,
      items: r.items && r.items[i] ? String(r.items[i]).split(',').map((s) => s.trim()).filter(Boolean) : [],
      description: r.primaryDocDescription ? r.primaryDocDescription[i] : null,
      url: acc && r.primaryDocument
        ? 'https://www.sec.gov/Archives/edgar/data/' + parseInt(cik, 10) + '/' + acc.replace(/-/g, '') + '/' + r.primaryDocument[i]
        : null,
    });
  }
  return rows;
}

module.exports = { enabled, disabledReason, cikMap, recent8Ks, submissions, parseCurrentFeed, flattenRecent };
