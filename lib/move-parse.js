'use strict';
// Pulls a share-price move (%) out of a catalyst's free-text `impact` field.
// Conservative on purpose: a figure is only returned when the text ties it to
// this stock's own session move (explicit sign, or a direction word next to
// the number). Business percentages (revenue, stakes, premiums), peers' moves
// and multi-week moves are skipped. Anything ambiguous returns null -- the 3D
// model then draws the item flat rather than inventing a height for it.
//
// A stated range ("-26% to -40%", "up 70-90%") is kept as a range {lo, hi}
// (by magnitude), never collapsed to one number -- RUNBOOK rule 3.

const DOWN = ['fell', 'fall', 'falls', 'fallen', 'falling', 'drop', 'dropped', 'drops', 'down', 'decline', 'declined',
  'slid', 'sank', 'plunge', 'plunged', 'tumbled', 'lost', 'slump', 'slumped', 'crashed', 'collapsed', 'selloff',
  'sell-off', 'lower'];
const UP = ['rose', 'rise', 'up', 'jumped', 'jump', 'surged', 'surge', 'gain', 'gained', 'rallied', 'rally',
  'climbed', 'soared', 'spiked', 'pop', 'popped', 'higher', 'advanced', 'recovered'];
const DOWN_NOUN = /^\s*(?:single-day|single-session|one-day|intraday|session|share-price|stock|premarket|after-hours)?\s*(decline|drop|fall|slide|loss|plunge|selloff|sell-off)\b/i;
const UP_NOUN = /^\s*(?:single-day|single-session|one-day|intraday|session|share-price|stock|premarket|after-hours)?\s*(?:stock\s)?(gain|jump|surge|rise|rally|pop|spike)\b/i;
const STOCK = /(share|stock|premarket|pre-market|after-hours|afterhours|session|intraday|single-day|close|closing|trading|the day|that day|same-day)/i;
// Percentages that describe the business or a longer window, not the session move.
const NOT_PRICE_BEFORE = /\b(revenue|sales|eps|margin|owns?|retain|holds?|stake|guidance|growth|yoy|rate|estimate|consensus|ebitda|income|backlog|volume|dilut\w*|interest|premium|discount|yield|coupon|workforce|headcount|weekly|week|month|year|ytd|target|orr|cumulative)\b[^.;,(]{0,22}$/i;
const NOT_PRICE_AFTER = /^\+?\s*(yoy|y\/y|qoq|year[- ]over|of (the|combined|float|shares|supply|total|outstanding)|stake|ownership|premium|discount|weekly|week|month|ytd|year|annual|above|below|over the|since|two-day|multi|for the week|confirmed orr|7-day)/i;
const SUBJECT_OK = ['stock', 'shares', 'share', 'closed', 'close', 'premarket', 'session', 'intraday', 'reported', 'reportedly',
  'approximately', 'approx', 'about', 'roughly', 'despite', 'the', 'a', 'on', 'of', 'to', 'at', 'and', 'or', 'was', 'were', 'is',
  'had', 'has', 'already', 'initially', 'then', 'only', 'severe', 'negative', 'positive', 'from', 'between', 'move', 'cites',
  'sharply', 'day', 'thursday', 'monday', 'tuesday', 'wednesday', 'friday', 'yahoo', 'marketbeat', 'tikr', 'nasdaq', 'unconfirmed'];

function parseMove(text, self) {
  if (!text || typeof text !== 'string') return null;
  const own = (self || []).filter(Boolean).map((s) => String(s).toLowerCase().split(/[^a-z0-9]+/)[0]);
  const foreign = (w) => /^[A-Z][A-Za-z]+$/.test(w) && !SUBJECT_OK.includes(w.toLowerCase()) && !own.includes(w.toLowerCase());
  const t = text.replace(/[−–—]/g, '-');
  const re = /([+-]?)\s?[~>]?\s?(\d+(?:\.\d+)?)\s?%?\+?(?:\s?(?:-|to|and)\s?(?:as much as\s)?([+-]?)\s?[~>]?\s?(\d+(?:\.\d+)?))?\s?%/g;
  let m;
  while ((m = re.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 48), m.index);
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 34);
    let sign = 0;
    if (m[1] === '+') sign = 1;
    else if (m[1] === '-' && !/\d\s?$/.test(before)) sign = -1; // "12-18%" is a range, not a minus
    if (NOT_PRICE_BEFORE.test(before) || NOT_PRICE_AFTER.test(after)) continue;
    const toks = before.trim().split(/\s+/);
    if (sign) {
      // "Coherent -11%" / "XLK +3.2%" is somebody else's move.
      const prev = (toks[toks.length - 1] || '').replace(/[^A-Za-z]/g, '');
      if (foreign(prev)) continue;
    } else {
      const words = before.split(/[^A-Za-z-]+/).filter(Boolean);
      let at = -1;
      for (let i = words.length - 1; i >= Math.max(0, words.length - 6) && !sign; i--) {
        const w = words[i].toLowerCase();
        if (DOWN.includes(w)) { sign = -1; at = i; } else if (UP.includes(w)) { sign = 1; at = i; }
      }
      if (sign) {
        if (at > 0 && foreign(words[at - 1])) continue; // "Broadcom fell >5%"
      } else if (DOWN_NOUN.test(after) || /\bdecline of\b[^.;,]{0,16}$/i.test(before)) sign = -1;
      else if (UP_NOUN.test(after)) sign = 1;
      if (!sign) continue;
      if (!STOCK.test(t) && !own.some((o) => t.toLowerCase().includes(o))) continue;
    }
    const a = parseFloat(m[2]);
    const b = m[4] !== undefined ? parseFloat(m[4]) : a;
    if (m[4] !== undefined && m[3] && m[1] && m[3] !== m[1]) continue; // "-2% to +3%": no single direction
    const lo = Math.min(a, b), hi = Math.max(a, b);
    if (!isFinite(lo) || hi > 2000) continue;
    return { lo: sign * lo, hi: sign * hi, range: hi !== lo };
  }
  return null;
}

module.exports = { parseMove };
