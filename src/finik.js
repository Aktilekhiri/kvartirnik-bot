// Оплата объявления через Finik (QR / банковские приложения), так же как на diamond.kg.
// Клиент платит на странице Finik, Finik присылает подписанный вебхук, и бот сам публикует объявление.
// Секреты Cloudflare: FINIK_API_KEY, FINIK_PRIVATE_KEY (PEM), FINIK_PUBLIC_KEY (PEM от Finik, для проверки вебхуков), FINIK_ACCOUNT_ID.
// Необязательно: FINIK_QR_NAME (имя QR в банковском приложении), FINIK_BASE (адрес API, по умолчанию боевой).

const PROD_BASE = 'https://api.acquiring.averspay.kg';
export const PAY_MIN = 30;   // сколько минут действует ссылка на оплату
export const finikReady = env => !!(env.FINIK_API_KEY && env.FINIK_PRIVATE_KEY && env.FINIK_ACCOUNT_ID && env.FINIK_PUBLIC_KEY);
const enc = new TextEncoder();

// ---------- подпись (RSA-SHA256, base64) ----------
// Подписываемая строка: метод (в нижнем регистре), путь, "host:<Host>&x-api-*:<значения по алфавиту>", query (если есть), тело JSON с отсортированными ключами верхнего уровня
export function canonical({ method, path, headers, query, body }) {
  const h = {}; for (const k of Object.keys(headers)) h[k.toLowerCase()] = headers[k];
  if (!h.host) throw new Error('Host required');
  const hs = ['host:' + h.host, ...Object.keys(h).filter(k => k.startsWith('x-api-')).sort().map(k => k + ':' + h[k])].join('&');
  const parts = [String(method).toLowerCase(), decodeURI(path || ''), hs];
  const qk = Object.keys(query || {}).sort();
  if (qk.length) parts.push(qk.map(k => encodeURI(decodeURI(k)) + '=' + encodeURI(decodeURI(query[k] == null ? '' : query[k]))).join('&'));
  let b = '';
  if (body) { const sorted = {}; Object.entries(body).sort((x, y) => x[0].localeCompare(y[0])).forEach(([k, v]) => { sorted[k] = v; }); b = JSON.stringify(sorted); }
  parts.push(b);
  return parts.join('\n');
}
const lenBytes = n => n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
const der = (tag, bytes) => { const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes); return Uint8Array.from([tag, ...lenBytes(b.length), ...b]); };
const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; a.forEach(x => { o.set(x, p); p += x.length; }); return o; };
const ALG = Uint8Array.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]); // rsaEncryption + NULL
function pemBytes(pem) { const m = String(pem).replace(/\\n/g, '\n'); const body = m.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''); return { bytes: Uint8Array.from(atob(body), c => c.charCodeAt(0)), pkcs1: /BEGIN RSA/.test(m) }; }
const pkcs8 = pkcs1 => der(0x30, cat(Uint8Array.from([2, 1, 0]), ALG, der(0x04, pkcs1)));
const spki = pkcs1 => der(0x30, cat(ALG, der(0x03, cat(Uint8Array.from([0]), pkcs1))));
async function importPriv(pem) { const { bytes, pkcs1 } = pemBytes(pem); return crypto.subtle.importKey('pkcs8', pkcs1 ? pkcs8(bytes) : bytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']); }
async function importPub(pem) { const { bytes, pkcs1 } = pemBytes(pem); return crypto.subtle.importKey('spki', pkcs1 ? spki(bytes) : bytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']); }
const b64 = u8 => { let s = ''; u8.forEach(b => { s += String.fromCharCode(b); }); return btoa(s); };
export async function signData(privPem, data) { return b64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await importPriv(privPem), enc.encode(data)))); }
export async function verifyData(pubPem, data, sig) {
  try { return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', await importPub(pubPem), Uint8Array.from(atob(String(sig)), c => c.charCodeAt(0)), enc.encode(data)); } catch (e) { return false; }
}

// ---------- создание платежа ----------
// o = { id, amount, desc }. Возвращает { url } (страница оплаты Finik) или { error }
export async function createFinikPayment(env, o, origin, redirectUrl) {
  const base = (env.FINIK_BASE || PROD_BASE).replace(/\/+$/, ''), path = '/v1/payment', host = new URL(base).host;
  const body = {
    Amount: Number(o.amount), CardType: 'FINIK_QR', PaymentId: o.id, RedirectUrl: redirectUrl, Lang: 'ru',
    Data: {
      accountId: env.FINIK_ACCOUNT_ID, name_en: env.FINIK_QR_NAME || 'kvartirnik',
      webhookUrl: origin + '/api/finik/webhook', description: String(o.desc || 'Объявление').slice(0, 100),
      endDate: Date.now() + PAY_MIN * 60 * 1000,
    },
  };
  const ts = String(Date.now()), headers = { Host: host, 'x-api-key': env.FINIK_API_KEY, 'x-api-timestamp': ts };
  const signature = await signData(env.FINIK_PRIVATE_KEY, canonical({ method: 'POST', path, headers, body }));
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.FINIK_API_KEY, 'x-api-timestamp': ts, signature }, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(15000) });
  if (res.status === 302 || res.status === 301) { const loc = res.headers.get('location'); if (loc) return { url: loc }; }
  let msg = ''; try { const j = await res.json(); msg = j.ErrorMessage || ''; } catch (e) { /* не JSON */ }
  return { error: 'Finik: ' + (msg || ('ошибка ' + res.status)).slice(0, 150) };
}

// POST /api/finik/webhook: Finik присылает подписанное уведомление при успешной оплате.
// onPaid(env, adId, amount, txId) вызывается один раз на каждую транзакцию.
export async function finikWebhook(env, req, onPaid) {
  if (!env.FINIK_PUBLIC_KEY) return { status: 503, body: 'off' };
  const raw = await req.text(); let body; try { body = JSON.parse(raw); } catch (e) { return { status: 400, body: 'bad json' }; }
  const url = new URL(req.url), headers = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  const query = {}; url.searchParams.forEach((v, k) => { query[k] = v; });
  let ok = false;
  try { ok = await verifyData(env.FINIK_PUBLIC_KEY, canonical({ method: req.method, path: url.pathname, headers: { host: headers.host, ...Object.fromEntries(Object.entries(headers).filter(([k]) => k.startsWith('x-api-'))) }, query, body }), headers.signature || ''); } catch (e) { ok = false; }
  if (!ok) { console.log('finik webhook: bad signature'); return { status: 401, body: 'bad signature' }; }

  const status = String(body.status || '').toLowerCase();
  if (!['success', 'succeeded'].includes(status)) return { status: 200, body: 'ignored' };
  const f = body.fields || {}, adId = String(f.paymentId || '').slice(0, 20), tx = String(body.transactionId || body.id || '');
  if (!adId || !tx) return { status: 200, body: 'no ids' };
  const amount = Number(body.amount) || 0;
  const ins = await env.DB.prepare('INSERT OR IGNORE INTO finik_payments (tx_id, ad_id, amount, created_at) VALUES (?,?,?,?)').bind(tx, adId, amount, Date.now()).run();
  if (!ins.meta.changes) return { status: 200, body: 'duplicate' };   // повтор вебхука
  await onPaid(env, adId, amount, tx);
  return { status: 200, body: 'ok' };
}
