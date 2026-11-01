'use strict';
const TZ = process.env.SHOP_TZ || 'Europe/Paris';

function offsetMs(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date);
  const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
  return asUTC - Math.floor(date.getTime() / 1000) * 1000;
}

// "2026-11-02T09:00" ou "02/11/2026 09:00" → Date (heure de la boutique), sinon null
function parseLocalDate(v) {
  const s = String(v == null ? '' : v).trim();
  let y, mo, d, h = 0, mi = 0, m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/))) {
    [y, mo, d] = [+m[1], +m[2], +m[3]]; h = +(m[4] || 0); mi = +(m[5] || 0);
  } else if ((m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/))) {
    [d, mo, y] = [+m[1], +m[2], +m[3]]; h = +(m[4] || 0); mi = +(m[5] || 0);
  } else return null;
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - offsetMs(new Date(guess));
  t = guess - offsetMs(new Date(t));
  const out = new Date(t);
  return Number.isNaN(out.getTime()) ? null : out;
}

module.exports = { parseLocalDate, TZ };
