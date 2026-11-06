// Таблицы создаются при первом обращении (как в воркере diamond.kg).
let ready = false;
export async function ensure(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      tg_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, state TEXT, draft TEXT, created_at INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS ads (
      id TEXT PRIMARY KEY, tg_id INTEGER NOT NULL, username TEXT, kind TEXT NOT NULL,
      city TEXT, district TEXT, type TEXT, price INTEGER, gender TEXT, people INTEGER, comment TEXT, contact TEXT,
      status TEXT NOT NULL DEFAULT 'pending',   -- pending (ждёт оплаты) | publishing | published | expired | deleted
      active INTEGER NOT NULL DEFAULT 1, group_msg_id INTEGER, pay_url TEXT, pay_exp INTEGER,
      created_at INTEGER NOT NULL, paid_at INTEGER)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS ads_feed ON ads (status, active, kind, created_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS ads_owner ON ads (tg_id, status)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS finik_payments (
      tx_id TEXT PRIMARY KEY, ad_id TEXT NOT NULL, amount REAL NOT NULL, created_at INTEGER NOT NULL)`),
  ]);
  ready = true;
}
