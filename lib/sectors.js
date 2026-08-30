'use strict';
// Sector / theme heat. Everything here is a COUNT derived from the watchlist —
// no rating, no opinion, no forecast. "Hot" means "more names and more dated
// catalysts landed in this theme lately", nothing more.

const { daysSince, iso } = require('./cadence');

function tally(records, ctx) {
  ctx = ctx || {};
  const today = ctx.today || iso(new Date());
  const themes = {};

  records.forEach((rec) => {
    if (rec.tier === 'archived') return;
    const key = rec.theme || rec.sector || 'Unclassified';
    if (!themes[key]) {
      themes[key] = {
        theme: key, label: rec.themeLabel || null, tickers: [],
        names: 0, daily: 0, catalysts7: 0, catalysts30: 0, newNames7: 0,
        movers7: 0, earningsSoon: 0, biggestMove: null,
      };
    }
    const t = themes[key];
    t.tickers.push(rec.ticker);
    t.names++;
    if (rec.tier === 'daily') t.daily++;
    if (rec.addedOn && daysSince(rec.addedOn, today) <= 7) t.newNames7++;
    if (!t.label && rec.themeLabel) t.label = rec.themeLabel;

    (rec.catalysts || []).forEach((c) => {
      if (!c.date) return;
      const age = daysSince(c.date, today);
      if (age >= 0 && age <= 7) t.catalysts7++;
      if (age >= 0 && age <= 30) t.catalysts30++;
    });

    const px = rec.price || {};
    if (typeof px.changePct === 'number') {
      if (Math.abs(px.changePct) >= 8) t.movers7++;
      if (!t.biggestMove || Math.abs(px.changePct) > Math.abs(t.biggestMove.changePct)) {
        t.biggestMove = { ticker: rec.ticker, changePct: px.changePct };
      }
    }
    const earn = rec.fundamentals && rec.fundamentals.nextEarnings;
    if (earn && earn.date) {
      const d = daysSince(today, earn.date);
      if (d >= 0 && d <= 14) t.earningsSoon++;
    }
  });

  const list = Object.keys(themes).map((k) => themes[k]);
  list.forEach((t) => { t.tickers.sort(); });
  // Ordered by how much activity the counts show — this is a sort, not a score.
  list.sort((a, b) =>
    (b.catalysts7 - a.catalysts7) ||
    (b.newNames7 - a.newNames7) ||
    (b.names - a.names) ||
    a.theme.localeCompare(b.theme));
  return list;
}

// Append today's counts so week-over-week movement in a theme is visible.
function snapshot(store, records, ctx) {
  ctx = ctx || {};
  const today = ctx.today || iso(new Date());
  const rows = tally(records, ctx);
  store.themes = store.themes || {};
  rows.forEach((t) => {
    const hist = store.themes[t.theme] || (store.themes[t.theme] = { history: [] });
    hist.history = hist.history.filter((h) => h.date !== today);
    hist.history.unshift({ date: today, names: t.names, catalysts7: t.catalysts7, newNames7: t.newNames7 });
    hist.history = hist.history.slice(0, 180);
  });
  return rows;
}

// Change in name count vs. the reading closest to `backDays` ago.
function trend(store, theme, backDays) {
  backDays = backDays || 7;
  const hist = (store.themes && store.themes[theme] && store.themes[theme].history) || [];
  if (hist.length < 2) return null;
  const now = hist[0];
  let prev = null;
  for (let i = 1; i < hist.length; i++) {
    if (daysSince(hist[i].date, now.date) >= backDays) { prev = hist[i]; break; }
  }
  if (!prev) prev = hist[hist.length - 1];
  return { names: now.names - prev.names, catalysts7: now.catalysts7 - prev.catalysts7, from: prev.date, to: now.date };
}

module.exports = { tally, snapshot, trend };
