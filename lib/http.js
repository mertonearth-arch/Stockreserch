'use strict';
// Minimal HTTP layer for the scanner: timeouts, one polite retry on 429/5xx,
// a concurrency gate, and an honest User-Agent. Built-in fetch only (Node >= 18).
//
// Behind an HTTPS proxy (the cloud sandbox), Node's fetch only honours
// HTTPS_PROXY when started with NODE_USE_ENV_PROXY=1 — bin/scan.js re-launches
// itself with that set, so nothing here needs to know about the proxy.

const UA = 'Mozilla/5.0 (compatible; CadenceDesk/1.0; personal research script)';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Never print a query string: it can carry a session crumb.
const shortUrl = (url) => String(url).split('?')[0];

async function request(url, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'User-Agent': opts.ua || UA, Accept: opts.accept || '*/*' }, opts.headers || {});
  const retries = opts.retries === undefined ? 1 : opts.retries;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeout || 20000);
    try {
      const res = await fetch(url, {
        method: opts.method || 'GET', headers: headers, body: opts.body, signal: ctl.signal, redirect: 'follow',
      });
      clearTimeout(timer);
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await res.arrayBuffer().catch(() => null);
        await sleep(2000 * (attempt + 1));
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) { await sleep(1500 * (attempt + 1)); continue; }
    }
  }
  const err = new Error('request failed for ' + shortUrl(url) + ': ' + (lastErr && lastErr.message));
  err.cause = lastErr;
  throw err;
}

async function getText(url, opts) {
  const res = await request(url, opts);
  const text = await res.text();
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status + ' from ' + shortUrl(url) + ': ' + text.replace(/\s+/g, ' ').slice(0, 140));
    err.status = res.status;
    throw err;
  }
  return text;
}

async function getJSON(url, opts) {
  const text = await getText(url, opts);
  try { return JSON.parse(text); } catch (e) { throw new Error('unparseable JSON from ' + shortUrl(url)); }
}

// Run fn over items with at most `limit` in flight and at least `gapMs`
// between request starts. A failed item resolves to { error } instead of
// sinking the whole batch — one bad ticker must not cost the run.
async function mapLimit(items, limit, gapMs, fn) {
  const out = new Array(items.length);
  let next = 0;
  let lastStart = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      const startAt = Math.max(Date.now(), lastStart + gapMs);
      lastStart = startAt;
      const wait = startAt - Date.now();
      if (wait > 0) await sleep(wait);
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = { error: e.message }; }
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

module.exports = { UA, request, getText, getJSON, mapLimit, sleep, shortUrl };
