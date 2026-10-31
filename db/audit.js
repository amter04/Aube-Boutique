'use strict';
const pool = (() => { try { return require('./pool').pool || null; } catch (e) { return null; } })();
const memory = [];
let ready = null;

function init() {
  if (!pool) return Promise.resolve();
  if (!ready) {
    ready = pool.query(`create table if not exists aube_audit (
      id bigserial primary key, at timestamptz not null default now(),
      actor text, role text, event text not null, ip text,
      details jsonb not null default '{}'::jsonb)`)
      .then(() => pool.query('alter table aube_audit enable row level security'))
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function append({ actor, role, event, ip, details }) {
  if (!pool) {
    memory.unshift({ at: new Date().toISOString(), actor, role, event, ip, details });
    memory.length = Math.min(memory.length, 500);
    return;
  }
  await init();
  await pool.query(
    'insert into aube_audit (actor, role, event, ip, details) values ($1,$2,$3,$4,$5::jsonb)',
    [actor || '', role || '', event, ip || '', JSON.stringify(details || {})]
  );
}

async function list({ limit = 200 } = {}) {
  if (!pool) return memory.slice(0, limit);
  await init();
  const r = await pool.query('select id, at, actor, role, event, ip, details from aube_audit order by id desc limit $1', [Math.min(limit, 1000)]);
  return r.rows;
}

module.exports = { append, list, init };
