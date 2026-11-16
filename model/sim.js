// Compounding model — pure simulation core. Runs in the browser (window.Sim) and in node.
// No opinions about any stock: it models account behaviour under a regime-dependent edge.
(function (root) {
  'use strict';

  const TRADING_DAYS = 252;
  const GAP_PROB = 0.10;   // share of losers that gap through the stop
  const GAP_R = -2;        // ...and cost 2R instead of 1R
  const FILTER_WINDOW = 10; // regime filter looks at the last 10 tracked setups
  const FILTER_OFF_MULT = 0.25;
  const PAUSE_DAYS = 5;
  const SWEEP_TRIGGER = 0.25; // sweep when the account is +25% over its base
  const SWEEP_SHARE = 0.5;    // move half the gain out
  const BANK_YEARLY = 0.07;   // swept money sits in an index fund

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Expected R per trade in one regime.
  function expectancy(winRate, avgWin) {
    return winRate * avgWin + (1 - winRate) * ((1 - GAP_PROB) * -1 + GAP_PROB * GAP_R);
  }

  // The market: a hot/cold regime per day and the R outcome of every setup that day.
  // Outcomes do not depend on the trader, so both traders face the identical tape.
  function genWorld(m, days, rng) {
    const hot = new Uint8Array(days);
    const R = new Float32Array(days * m.tradesPerDay);
    const pLeaveHot = 1 / m.hotDays;
    const pLeaveCold = 1 / m.coldDays;
    let isHot = rng() < m.hotDays / (m.hotDays + m.coldDays);
    for (let d = 0; d < days; d++) {
      if (d > 0 && rng() < (isHot ? pLeaveHot : pLeaveCold)) isHot = !isHot;
      hot[d] = isHot ? 1 : 0;
      const wr = isHot ? m.hotWin : m.coldWin;
      const aw = isHot ? m.hotAvgWin : m.coldAvgWin;
      for (let k = 0; k < m.tradesPerDay; k++) {
        const u = rng();
        let r;
        if (u < wr) r = aw * Math.min(-Math.log(1 - rng()), 6); // exponential winners, capped
        else r = rng() < GAP_PROB ? GAP_R : -1;
        R[d * m.tradesPerDay + k] = r;
      }
    }
    return { hot, R, days, tradesPerDay: m.tradesPerDay };
  }

  // One trader on one tape. s = { risk, filter, brakes, sweep }.
  // Returns total wealth per day (trading account + swept bank), start = 1.
  function runTrader(world, s) {
    const { R, days, tradesPerDay } = world;
    const wealth = new Float64Array(days + 1);
    const size = new Float32Array(days); // size multiplier actually used that day
    let acct = 1, bank = 0, peak = 1, base = 1, pause = 0;
    const recent = new Float32Array(FILTER_WINDOW);
    let recentSum = 0, recentN = 0, recentI = 0;
    const bankDaily = Math.pow(1 + BANK_YEARLY, 1 / TRADING_DAYS);
    wealth[0] = 1;

    for (let d = 0; d < days; d++) {
      bank *= bankDaily;
      let mult = 1;
      if (s.brakes) {
        if (pause > 0) {
          mult = 0;
          pause--;
          if (pause === 0) peak = acct; // restart the drawdown clock after the time-out
        } else {
          const dd = 1 - acct / peak;
          if (dd >= 0.15) { mult = 0; pause = PAUSE_DAYS - 1; }
          else if (dd >= 0.10) mult = 0.25;
          else if (dd >= 0.05) mult = 0.5;
        }
      }
      let dayMult = mult;
      for (let k = 0; k < tradesPerDay; k++) {
        const r = R[d * tradesPerDay + k];
        let m = mult;
        // Regime filter: are the last 10 setups (traded or only tracked) net positive?
        if (s.filter && recentN === FILTER_WINDOW && recentSum <= 0) m *= FILTER_OFF_MULT;
        if (k === 0) dayMult = m;
        if (m > 0) acct *= 1 + s.risk * m * r;
        if (recentN === FILTER_WINDOW) recentSum -= recent[recentI]; else recentN++;
        recent[recentI] = r;
        recentSum += r;
        recentI = (recentI + 1) % FILTER_WINDOW;
      }
      if (acct > peak) peak = acct;
      if (s.sweep && acct >= base * (1 + SWEEP_TRIGGER)) {
        const out = (acct - base) * SWEEP_SHARE;
        acct -= out;
        bank += out;
        base = acct;
        peak = acct; // a withdrawal is not a drawdown
      }
      size[d] = dayMult;
      wealth[d + 1] = acct + bank;
    }
    return { wealth, size };
  }

  function pathStats(w) {
    let peak = w[0], maxDD = 0, top = w[0];
    for (let i = 1; i < w.length; i++) {
      if (w[i] > peak) peak = w[i];
      const dd = 1 - w[i] / peak;
      if (dd > maxDD) maxDD = dd;
      if (w[i] > top) top = w[i];
    }
    // best 15-trading-day run
    let best = 0;
    for (let i = 15; i < w.length; i++) {
      const g = w[i] / w[i - 15] - 1;
      if (g > best) best = g;
    }
    return { final: w[w.length - 1], maxDD, top, best15: best };
  }

  function quantile(sorted, q) {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  // Many tapes, both traders on each. Returns percentile bands and summary stats.
  function monteCarlo(m, traders, days, nPaths, seed, step) {
    step = step || 4;
    const nPts = Math.floor(days / step) + 1;
    const out = traders.map(() => ({
      cols: Array.from({ length: nPts }, () => new Float64Array(nPaths)),
      final: new Float64Array(nPaths), maxDD: new Float64Array(nPaths),
      best15: new Float64Array(nPaths), top: new Float64Array(nPaths)
    }));
    for (let p = 0; p < nPaths; p++) {
      const world = genWorld(m, days, mulberry32(seed + p * 7919));
      traders.forEach((s, ti) => {
        const w = runTrader(world, s).wealth;
        const st = pathStats(w);
        const o = out[ti];
        o.final[p] = st.final; o.maxDD[p] = st.maxDD; o.best15[p] = st.best15; o.top[p] = st.top;
        for (let j = 0; j < nPts; j++) o.cols[j][p] = w[j * step];
      });
    }
    return out.map(o => {
      const band = { p10: [], p50: [], p90: [] };
      o.cols.forEach(c => {
        const s = Float64Array.from(c).sort();
        band.p10.push(quantile(s, 0.1)); band.p50.push(quantile(s, 0.5)); band.p90.push(quantile(s, 0.9));
      });
      const med = a => quantile(Float64Array.from(a).sort(), 0.5);
      let below = 0, halved = 0;
      for (let p = 0; p < nPaths; p++) {
        if (o.final[p] < 1) below++;
        if (o.maxDD[p] >= 0.5) halved++;
      }
      return {
        band, step,
        medFinal: med(o.final), medMaxDD: med(o.maxDD), medBest15: med(o.best15), medTop: med(o.top),
        pBelow: below / nPaths, pHalved: halved / nPaths
      };
    });
  }

  // Expected log growth per trade at risk fraction f (the Kelly curve), by quadrature
  // over the exponential winner distribution.
  function logGrowth(f, winRate, avgWin) {
    const N = 400;
    let eWin = 0;
    for (let i = 0; i < N; i++) {
      const x = Math.min(-Math.log(1 - (i + 0.5) / N), 6);
      eWin += Math.log(1 + f * avgWin * x);
    }
    eWin /= N;
    const eLoss = (1 - GAP_PROB) * Math.log(1 - f) + GAP_PROB * Math.log(1 + f * GAP_R);
    return winRate * eWin + (1 - winRate) * eLoss;
  }

  function kellyCurves(m, fMax, n) {
    const hotShare = m.hotDays / (m.hotDays + m.coldDays);
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const f = (fMax * i) / n;
      const gh = logGrowth(f, m.hotWin, m.hotAvgWin);
      const gc = logGrowth(f, m.coldWin, m.coldAvgWin);
      pts.push({ f, always: hotShare * gh + (1 - hotShare) * gc, hotOnly: hotShare * gh });
    }
    return pts;
  }

  const api = {
    mulberry32, expectancy, genWorld, runTrader, pathStats, monteCarlo, kellyCurves, logGrowth,
    constants: { TRADING_DAYS, FILTER_WINDOW, FILTER_OFF_MULT, PAUSE_DAYS, SWEEP_TRIGGER, SWEEP_SHARE, BANK_YEARLY, GAP_PROB }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Sim = api;
})(typeof window !== 'undefined' ? window : globalThis);
