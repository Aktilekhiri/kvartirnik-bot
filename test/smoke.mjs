// Локальный тест: D1 заменён на node:sqlite, Telegram и Finik замоканы. Запуск: node test/smoke.mjs
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, sign as nsign } from 'node:crypto';
import assert from 'node:assert/strict';

// ---- мок D1 ----
const sqlite = new DatabaseSync(':memory:');
const stmt = sql => { let args = []; const o = {
  bind: (...a) => { args = a; return o; },
  run: async () => { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  first: async () => sqlite.prepare(sql).get(...args) || null,
  all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  _exec: () => sqlite.prepare(sql).run(...args),
}; return o; };
const DB = { prepare: stmt, batch: async list => { for (const s of list) await s.run(); } };

// ---- ключи Finik (наш приватный; «публичный Finik» для вебхука) ----
const ours = generateKeyPairSync('rsa', { modulusLength: 2048 });
const theirs = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = (k, t) => k.export({ type: t, format: 'pem' });

// ---- мок fetch ----
const tgCalls = []; let finikBody = null, msgId = 100;
globalThis.fetch = async (url, opt) => {
  const u = String(url), body = opt && opt.body ? JSON.parse(opt.body) : {};
  if (u.includes('api.telegram.org')) { const m = u.split('/').pop(); tgCalls.push({ m, body }); return Response.json({ ok: true, result: { message_id: ++msgId, id: 1, username: 'kv_bot' } }); }
  if (u.includes('averspay')) { finikBody = body; return new Response(null, { status: 302, headers: { location: 'https://pay.finik.test/abc' } }); }
  throw new Error('unexpected fetch ' + u);
};

const { ensure } = await import('../src/db.js');
const { handleUpdate, onPaid, adText } = await import('../src/bot.js');
const { finikWebhook, canonical } = await import('../src/finik.js');

const env = { DB, BOT_TOKEN: 't', GROUP_ID: '-1001234567890', GROUP_LINK: 'https://t.me/+x', BOT_USERNAME: 'kv_bot', ADMIN_ID: '1',
  FINIK_API_KEY: 'k', FINIK_ACCOUNT_ID: 'acc', FINIK_PRIVATE_KEY: pem(ours.privateKey, 'pkcs8'), FINIK_PUBLIC_KEY: pem(theirs.publicKey, 'spki') };
await ensure(env);

const from = { id: 777, username: 'aktilek', first_name: 'A' };
const msg = text => handleUpdate(env, { message: { text, from, chat: { id: 777, type: 'private' } } }, 'https://w.test');
const cb = data => handleUpdate(env, { callback_query: { id: 'c', data, from, message: { chat: { id: 777 }, message_id: 5 } } }, 'https://w.test');
const photoMsg = id => handleUpdate(env, { message: { photo: [{ file_id: id + '_small' }, { file_id: id + '_BIG_FILE' }], from, chat: { id: 777, type: 'private' } } }, 'https://w.test');
const lastSent = () => [...tgCalls].reverse().find(c => ['sendMessage', 'sendPhoto'].includes(c.m) && c.body.chat_id === 777).body;
const txt = b => b.text || b.caption;

// 0. /id в группе
await handleUpdate(env, { message: { text: '/id@kv_bot', from, chat: { id: -100555, type: 'supergroup' } } }, 'https://w.test');
assert.match(tgCalls.pop().body.text, /-100555/);

// 1. меню
await msg('/start');
assert.match(lastSent().text, /Добро пожаловать/);
assert.equal(lastSent().reply_markup.inline_keyboard.length, 5);

// 2. мастер «Сдать»
await cb('new:rent');
await msg('просто текст'); assert.match(lastSent().text, /Нужно фото/);   // без фото дальше нельзя
await photoMsg('AAA');
await photoMsg('EXTRA');   // лишнее фото из альбома молча игнорируется
await cb('v:city:Бишкек');
await msg('Асанбай'); await msg('2-комн., 4 этаж из 9');
await msg('abc'); assert.match(lastSent().text, /числом/);       // валидация цены
await msg('15 000'); await cb('v:gender:Девушки'); await msg('2');
await msg('Мебель есть, залог 1 месяц <b>'); await cb('v:contact:me');
const pv = [...tgCalls].reverse().find(c => c.m === 'sendPhoto' && c.body.chat_id === 777).body;
assert.equal(pv.photo, 'AAA_BIG_FILE'); assert.match(pv.reply_markup.inline_keyboard[0][0].text, /Оплатить 10 сом/); assert.match(pv.caption, /15 000 сом\/мес/);

// 3. оплата: ссылка Finik
await cb('pay');
assert.equal(finikBody.Amount, 10); assert.equal(finikBody.CardType, 'FINIK_QR');
assert.equal(finikBody.Data.webhookUrl, 'https://w.test/api/finik/webhook');
assert.equal(lastSent().reply_markup.inline_keyboard[0][0].url, 'https://pay.finik.test/abc');
const ad = sqlite.prepare('SELECT * FROM ads').get(); assert.equal(ad.status, 'pending'); assert.equal(ad.id.length, 10);
await cb('pay'); assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM ads').get().n, 1);   // повтор не плодит заказы

// 4. вебхук Finik с подписью
const payload = { status: 'SUCCEEDED', transactionId: 'tx1', amount: 10, fields: { paymentId: ad.id } };
const mkReq = (body, key) => {
  const h = { host: 'w.test', 'x-api-timestamp': '1' };
  const data = canonical({ method: 'POST', path: '/api/finik/webhook', headers: h, body });
  const signature = nsign('sha256', Buffer.from(data), key).toString('base64');
  return new Request('https://w.test/api/finik/webhook', { method: 'POST', headers: { ...h, signature, 'content-type': 'application/json' }, body: JSON.stringify(body) });
};
let r = await finikWebhook(env, mkReq(payload, ours.privateKey), onPaid); assert.equal(r.status, 401);   // чужая подпись
const before = tgCalls.length;
r = await finikWebhook(env, mkReq(payload, theirs.privateKey), onPaid); assert.equal(r.body, 'ok');
const pub = tgCalls.slice(before).find(c => c.m === 'sendPhoto' && c.body.chat_id === env.GROUP_ID);
assert.ok(pub, 'объявление не ушло в группу'); assert.equal(pub.body.photo, 'AAA_BIG_FILE'); assert.match(pub.body.caption, /СДАЮ КВАРТИРУ/);
assert.match(pub.body.caption, /&lt;b&gt;/);   // HTML экранируется
assert.equal(pub.body.reply_markup.inline_keyboard[0][0].url, 'https://t.me/aktilek');
assert.equal(sqlite.prepare('SELECT status FROM ads').get().status, 'published');
const n = tgCalls.length;
r = await finikWebhook(env, mkReq(payload, theirs.privateKey), onPaid); assert.equal(r.body, 'duplicate'); assert.equal(tgCalls.length, n);

// 5. неполная оплата не публикует
await cb('new:seek');
await photoMsg('BBB');
for (const t of ['Бишкек']) await cb('v:city:' + t);
await msg('Джал'); await msg('1-комн.'); await msg('12000'); await cb('v:gender:Парни'); await msg('1'); await cb('v:comment:'); await msg('+996700123456');
await cb('pay');
const ad2 = sqlite.prepare("SELECT * FROM ads WHERE kind='seek'").get(); assert.equal(ad2.price, 12000);
await finikWebhook(env, mkReq({ status: 'SUCCEEDED', transactionId: 'tx2', amount: 5, fields: { paymentId: ad2.id } }, theirs.privateKey), onPaid);
assert.equal(sqlite.prepare("SELECT status FROM ads WHERE kind='seek'").get().status, 'pending');

// 6. профиль, переключение актуальности, просмотр, удаление
await cb('my'); assert.match(txt(lastSent()), /последние 10|Показаны/);
await cb('tg:' + ad.id);
const edit = tgCalls.filter(c => c.m === 'editMessageCaption' && c.body.chat_id === env.GROUP_ID).pop();
assert.match(edit.body.caption, /Неактуально/); assert.equal(sqlite.prepare('SELECT active FROM ads WHERE id=?').get(ad.id).active, 0);
await cb('b:rent:0'); assert.match(txt(lastSent()), /Пока объявлений нет|ещё не всё/);   // неактуальное не показывается
await cb('tg:' + ad.id); await cb('b:rent:0');
assert.ok(tgCalls.some(c => c.m === 'sendPhoto' && /СДАЮ/.test(c.body.caption || '') && c.body.chat_id === 777 && c.body.photo === 'AAA_BIG_FILE'));
await cb('dy:' + ad.id);
assert.ok(tgCalls.some(c => c.m === 'deleteMessage')); assert.equal(sqlite.prepare('SELECT status FROM ads WHERE id=?').get(ad.id).status, 'deleted');

// 7. чужое объявление тронуть нельзя
const other = { id: 999, username: 'x', first_name: 'X' };
await handleUpdate(env, { callback_query: { id: 'c', data: 'dy:' + ad2.id, from: other, message: { chat: { id: 999 }, message_id: 1 } } }, 'https://w.test');
assert.equal(sqlite.prepare('SELECT status FROM ads WHERE id=?').get(ad2.id).status, 'pending');

console.log('OK: все проверки пройдены');
