'use strict';
// NYSE trading calendar, computed rather than hardcoded so it doesn't go stale.
// Used to stop a full pass from ticking quiet counters on a day with no session:
// three "quiet" holidays in a row would otherwise demote a perfectly live name.

const DAY_MS = 86400000;
const iso = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const dow = (y, m, d) => new Date(Date.UTC(y, m, d)).getUTCDay();

// Anonymous Gregorian algorithm.
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

// nth (1-based) `weekday` of a month; n = -1 means the last one.
function nthWeekday(year, month, weekday, n) {
  if (n > 0) {
    const first = dow(year, month, 1);
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  }
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return last - ((dow(year, month, last) - weekday + 7) % 7);
}

// A fixed-date holiday on a Saturday is observed the Friday before; on a Sunday,
// the Monday after.
function observed(year, month, day) {
  const w = dow(year, month, day);
  if (w === 6) return iso(year, month, day - 1);
  if (w === 0) return iso(year, month, day + 1);
  return iso(year, month, day);
}

function holidays(year) {
  const easter = easterSunday(year);
  const goodFriday = new Date(easter.getTime() - 2 * DAY_MS);
  const out = {};
  out[observed(year, 0, 1)] = 'New Year’s Day';
  out[iso(year, 0, nthWeekday(year, 0, 1, 3))] = 'Martin Luther King Jr. Day';
  out[iso(year, 1, nthWeekday(year, 1, 1, 3))] = 'Washington’s Birthday';
  out[goodFriday.toISOString().slice(0, 10)] = 'Good Friday';
  out[iso(year, 4, nthWeekday(year, 4, 1, -1))] = 'Memorial Day';
  out[observed(year, 5, 19)] = 'Juneteenth';
  out[observed(year, 6, 4)] = 'Independence Day';
  out[iso(year, 8, nthWeekday(year, 8, 1, 1))] = 'Labor Day';
  out[iso(year, 10, nthWeekday(year, 10, 4, 4))] = 'Thanksgiving';
  out[observed(year, 11, 25)] = 'Christmas Day';
  // A Jan 1 that falls on a Saturday is observed on Dec 31 of the year before,
  // so that date has to appear in THIS year's set to be findable.
  const nextNewYear = observed(year + 1, 0, 1);
  if (nextNewYear.slice(0, 4) === String(year)) out[nextNewYear] = 'New Year’s Day';
  return out;
}

const cache = {};
const forYear = (y) => (cache[y] || (cache[y] = holidays(y)));

function holidayName(dateStr) {
  const d = String(dateStr).slice(0, 10);
  const year = Number(d.slice(0, 4));
  if (!year) return null;
  return forYear(year)[d] || null;
}

function isWeekend(dateStr) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z').getUTCDay();
  return d === 0 || d === 6;
}

function isTradingDay(dateStr) {
  return !isWeekend(dateStr) && !holidayName(dateStr);
}

// Why there was no session — for the run log and the dashboard.
function closedReason(dateStr) {
  if (holidayName(dateStr)) return holidayName(dateStr);
  if (isWeekend(dateStr)) return 'weekend';
  return null;
}

module.exports = { easterSunday, nthWeekday, holidays, holidayName, isWeekend, isTradingDay, closedReason };
