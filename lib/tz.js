'use strict';
// Dates dans le fuseau de la boutique (Europe/Paris par défaut, réglable avec SHOP_TZ).
// Le serveur (Render) tourne en UTC : sans ça, « aujourd'hui » et les courbes de vente seraient décalés
// de 1 à 2 h, et une date tapée à la main serait mal interprétée.

const TZ = process.env.SHOP_TZ || 'Europe/Paris';

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
});

function parts(ts) {
  const o = {};
  for (const p of partsFmt.formatToParts(new Date(ts))) if (p.type !== 'literal') o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second };
}

// "2026-10-22" : le jour (dans le fuseau de la boutique) d'un instant.
function dayKey(ts) {
  const p = parts(ts);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

function offsetAt(ts) {
  const p = parts(ts);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
}

// Heure « murale » du fuseau de la boutique → instant UTC.
function zonedToUtc(y, m, d, h = 0, mi = 0) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let ts = guess - offsetAt(guess);
  ts = guess - offsetAt(ts);
  return new Date(ts);
}

// "22/10/2026 18:30", "22/10/2026" ou "2026-10-22T18:30" (sans fuseau) → Date, sinon null.
function parseLocalDate(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T]+(\d{1,2})[:h](\d{2}))?$/.exec(t);
  if (m) return zonedToUtc(+m[3], +m[2], +m[1], +(m[4] || 0), +(m[5] || 0));
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(t);
  if (m) return zonedToUtc(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0));
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatLocal(ts) {
  if (!ts) return '';
  const p = parts(new Date(ts).getTime());
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(p.d)}/${pad(p.m)}/${p.y} ${pad(p.h)}:${pad(p.mi)}`;
}

module.exports = { TZ, dayKey, zonedToUtc, parseLocalDate, formatLocal };
