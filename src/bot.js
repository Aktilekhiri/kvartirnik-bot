// Квартирник: Telegram-бот объявлений об аренде жилья в Бишкеке.
// Подать объявление стоит 10 сом (Finik), после оплаты оно сразу публикуется в группе.
import { createFinikPayment, finikReady, PAY_MIN } from './finik.js';

export const PRICE = 10;
const CITIES = ['Бишкек', 'Ош', 'Каракол', 'Джалал-Абад'];
const GENDERS = ['Парни', 'Девушки', 'Семья', 'Любой'];
const STEPS = ['photo', 'city', 'district', 'type', 'price', 'gender', 'people', 'comment', 'contact'];
const stepsFor = kind => kind === 'rent' ? STEPS : STEPS.filter(x => x !== 'photo');   // фото только у тех, кто сдаёт
const PAGE = 3;

const KIND = {
  rent: { title: '🏠 СДАЮ КВАРТИРУ', tag: '#сдаю', typeLabel: 'Тип жилья', priceLabel: 'Цена', genderLabel: 'Заселю' },
  seek: { title: '🔍 ИЩУ КВАРТИРУ', tag: '#ищу', typeLabel: 'Что ищу', priceLabel: 'Бюджет', genderLabel: 'Кто будет жить' },
};

// ---------- мелочи ----------
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const rid = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
const kb = rows => ({ inline_keyboard: rows });
const btn = (text, data) => ({ text, callback_data: data });

async function tg(env, method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    return await r.json();
  } catch (e) { return { ok: false, description: String(e) }; }
}
const send = (env, chat, text, extra = {}) => tg(env, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
// Объявление всегда с фото: подпись под фотографией (лимит Telegram 1024 символа, наш текст короче)
const sendAd = (env, chat, photo, caption, extra = {}) => photo
  ? tg(env, 'sendPhoto', { chat_id: chat, photo, caption, parse_mode: 'HTML', ...extra })
  : send(env, chat, caption, extra);
const editAd = (env, chat, mid, photo, text, extra = {}) => photo
  ? tg(env, 'editMessageCaption', { chat_id: chat, message_id: mid, caption: text, parse_mode: 'HTML', ...extra })
  : tg(env, 'editMessageText', { chat_id: chat, message_id: mid, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
async function alertAdmin(env, text) { if (env.ADMIN_ID) await send(env, env.ADMIN_ID, text); }

// ---------- текст объявления ----------
export function adText(a) {
  const k = KIND[a.kind];
  const L = [
    `<b>${k.title}</b>`, '',
    `📍 ${esc(a.city)}, ${esc(a.district)}`,
    `🛏 ${k.typeLabel}: ${esc(a.type)}`,
    `💰 ${k.priceLabel}: <b>${fmt(a.price)} сом/мес</b>`,
    `👥 ${k.genderLabel}: ${esc(a.gender)} · человек: ${a.people}`,
  ];
  if (a.comment) L.push(`💬 ${esc(a.comment)}`);
  L.push(`📞 ${esc(a.contact)}`, '', a.active ? '✅ Актуально' : '❌ Неактуально');
  const city = String(a.city).replace(/[^\p{L}\p{N}]+/gu, '');
  L.push((city ? '#' + city + ' ' : '') + k.tag);
  return L.join('\n');
}
const contactBtn = a => {
  const m = /^@([A-Za-z0-9_]{4,32})$/.exec(String(a.contact).trim());
  return m ? { text: '✉️ Написать', url: 'https://t.me/' + m[1] } : null;
};
const botLink = (env, start) => env.BOT_USERNAME ? `https://t.me/${String(env.BOT_USERNAME).replace('@', '')}${start ? '?start=' + start : ''}` : null;
// Кнопки под объявлением в группе: «Написать» (если контакт @username) и «Создать объявление»
function groupMarkup(env, a) {
  const rows = [], c = contactBtn(a), l = botLink(env, 'new');
  if (c) rows.push([c]);
  if (l) rows.push([{ text: '➕ Создать объявление', url: l }]);
  return rows.length ? kb(rows) : undefined;
}
function postLink(env, msgId) {
  if (!msgId) return null;
  if (env.GROUP_USERNAME) return `https://t.me/${String(env.GROUP_USERNAME).replace('@', '')}/${msgId}`;
  const g = String(env.GROUP_ID || '');
  return g.startsWith('-100') ? `https://t.me/c/${g.slice(4)}/${msgId}` : null;
}

// ---------- пользователь и состояние ----------
async function getUser(env, from) {
  await env.DB.prepare('INSERT INTO users (tg_id, username, first_name, created_at) VALUES (?,?,?,?) ON CONFLICT(tg_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name')
    .bind(from.id, from.username || null, from.first_name || null, Date.now()).run();
  return env.DB.prepare('SELECT * FROM users WHERE tg_id = ?').bind(from.id).first();
}
const setState = (env, id, state, draft) => env.DB.prepare('UPDATE users SET state = ?, draft = ? WHERE tg_id = ?').bind(state, draft ? JSON.stringify(draft) : null, id).run();
const readDraft = u => { try { return JSON.parse(u.draft || 'null'); } catch (e) { return null; } };

// ---------- меню ----------
async function menu(env, chat) {
  const rows = [
    [btn('🏠 Сдать квартиру', 'new:rent')],
    [btn('🔍 Найти квартиру', 'new:seek')],
    [btn('📋 Смотреть объявления', 'br')],
    [btn('👤 Мой профиль', 'me')],
  ];
  const link = env.GROUP_LINK;
  if (link) rows.push([{ text: '👥 Перейти в группу', url: link }]);
  return send(env, chat, `👋 <b>Добро пожаловать в Квартирник!</b>\n\nОбъявление в группе стоит ${PRICE} сом. Оплата через банковское приложение, публикация сразу после оплаты.\n\n📋 Выберите действие:`, { reply_markup: kb(rows) });
}

// ---------- мастер подачи объявления ----------
async function startWizard(env, user, chat, kind) {
  if (!KIND[kind]) return menu(env, chat);
  const d = { kind };
  const first = stepsFor(kind)[0];
  await setState(env, user.tg_id, 'wiz:' + first, d);
  return ask(env, chat, d, first, user);
}
async function ask(env, chat, d, step, user) {
  const st = stepsFor(d.kind), n = st.indexOf(step) + 1, head = `<b>${KIND[d.kind].title}</b> · шаг ${n} из ${st.length}\n\n`;
  const cancel = [btn('✖ Отмена', 'menu')];
  const rent = d.kind === 'rent';
  switch (step) {
    case 'photo':
      return send(env, chat, head + '📷 Отправьте одно фото квартиры. Именно фото, не файлом.', { reply_markup: kb([cancel]) });
    case 'city':
      return send(env, chat, head + 'В каком городе?', { reply_markup: kb([CITIES.slice(0, 2).map(c => btn(c, 'v:city:' + c)), CITIES.slice(2).map(c => btn(c, 'v:city:' + c)), [btn('Другой город', 'v:city:*')], cancel]) });
    case 'district':
      return send(env, chat, head + 'Район или микрорайон? Напишите текстом.', { reply_markup: kb([cancel]) });
    case 'type':
      return send(env, chat, head + (rent ? 'Тип жилья: комнаты, этаж, этажность.\nНапример: 2-комн., 4 этаж из 9' : 'Какое жильё ищете?\nНапример: 1-комн. или комната'), { reply_markup: kb([cancel]) });
    case 'price':
      return send(env, chat, head + (rent ? 'Цена в сомах за месяц. Только число.' : 'Ваш бюджет в сомах за месяц. Только число.'), { reply_markup: kb([cancel]) });
    case 'gender':
      return send(env, chat, head + (rent ? 'Кого готовы заселить?' : 'Кто будет жить?'), { reply_markup: kb([GENDERS.map(g => btn(g, 'v:gender:' + g)), cancel]) });
    case 'people':
      return send(env, chat, head + 'Сколько человек? Напишите число.', { reply_markup: kb([cancel]) });
    case 'comment':
      return send(env, chat, head + 'Комментарий: условия, мебель, коммуналка, залог и всё важное. Можно пропустить.', { reply_markup: kb([[btn('Пропустить', 'v:comment:')], cancel]) });
    case 'contact': {
      const rows = []; if (user && user.username) rows.push([btn('Мой @' + user.username, 'v:contact:me')]); rows.push(cancel);
      return send(env, chat, head + 'Контакты для связи: телефон или @username.', { reply_markup: kb(rows) });
    }
  }
}
function validate(step, v) {
  switch (step) {
    case 'photo': return v.length > 10 ? '' : 'Отправьте фото квартиры.';
    case 'city': case 'district': case 'type': return v.length >= 2 && v.length <= 60 ? '' : 'Напишите от 2 до 60 символов.';
    case 'price': { const n = parseInt(v.replace(/\D/g, ''), 10); return n >= 100 && n <= 10000000 ? '' : 'Введите сумму числом, например 15000.'; }
    case 'gender': return GENDERS.includes(v) ? '' : 'Выберите вариант кнопкой.';
    case 'people': { const n = parseInt(v, 10); return /^\d{1,2}$/.test(v) && n >= 1 && n <= 30 ? '' : 'Введите число от 1 до 30.'; }
    case 'comment': return v.length <= 300 ? '' : 'Слишком длинно, до 300 символов.';
    case 'contact': return v.length >= 5 && v.length <= 60 && (/@[A-Za-z0-9_]{4,}/.test(v) || (v.match(/\d/g) || []).length >= 7) ? '' : 'Укажите телефон (минимум 7 цифр) или @username.';
  }
  return '';
}
async function accept(env, user, chat, step, raw) {
  const d = readDraft(user); if (!d || !d.kind) return menu(env, chat);
  const v = String(raw ?? '').trim();
  const err = validate(step, v);
  if (err) return send(env, chat, '⚠️ ' + err);
  d[step] = step === 'price' || step === 'people' ? parseInt(v.replace(/\D/g, ''), 10) : v;
  const st = stepsFor(d.kind), i = st.indexOf(step);
  if (i < 0) return menu(env, chat);   // шаг не из этой анкеты (старая кнопка)
  if (i < st.length - 1) { await setState(env, user.tg_id, 'wiz:' + st[i + 1], d); return ask(env, chat, d, st[i + 1], user); }
  await setState(env, user.tg_id, 'prev', d);
  return preview(env, chat, d);
}
async function preview(env, chat, d) {
  return sendAd(env, chat, d.photo, adText({ ...d, active: 1 }) + `\n\n— — —\nТак объявление выглядит в группе. Публикация: ${PRICE} сом.`, {
    reply_markup: kb([[btn(`💳 Оплатить ${PRICE} сом`, 'pay')], [btn('✏️ Заполнить заново', 'new:' + d.kind), btn('✖ Отмена', 'menu')]]),
  });
}

// ---------- оплата ----------
async function pay(env, user, chat, origin) {
  const d = readDraft(user);
  if (!d || user.state !== 'prev') return menu(env, chat);
  if (!finikReady(env)) return send(env, chat, 'Оплата пока не подключена. Попробуйте позже.');
  let ad = d.ad_id ? await env.DB.prepare("SELECT * FROM ads WHERE id = ? AND status = 'pending'").bind(d.ad_id).first() : null;
  if (!ad || !ad.pay_url || ad.pay_exp < Date.now() + 60000) {
    const id = 'KV' + rid(8), now = Date.now();
    await env.DB.prepare("INSERT INTO ads (id, tg_id, username, kind, photo, city, district, type, price, gender, people, comment, contact, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)")
      .bind(id, user.tg_id, user.username, d.kind, d.photo || null, d.city, d.district, d.type, d.price, d.gender, d.people, d.comment || '', d.contact, now).run();
    const back = env.BOT_USERNAME ? 'https://t.me/' + String(env.BOT_USERNAME).replace('@', '') : 'https://t.me/';
    const p = await createFinikPayment(env, { id, amount: PRICE, desc: 'Объявление Квартирник ' + id }, origin, back);
    if (p.error) {
      await env.DB.prepare("UPDATE ads SET status = 'expired' WHERE id = ?").bind(id).run();
      await alertAdmin(env, '⚠️ Не удалось создать оплату: ' + esc(p.error));
      return send(env, chat, 'Не получилось создать оплату. Попробуйте ещё раз через минуту.');
    }
    await env.DB.prepare('UPDATE ads SET pay_url = ?, pay_exp = ? WHERE id = ?').bind(p.url, now + PAY_MIN * 60000, id).run();
    d.ad_id = id; await setState(env, user.tg_id, 'prev', d);
    ad = { id, pay_url: p.url };
  }
  return send(env, chat, `<b>Оплата ${PRICE} сом</b>\nНажмите кнопку, выберите банк или отсканируйте QR. После оплаты объявление появится в группе автоматически, я напишу сюда.\n⏱ Ссылка действует ${PAY_MIN} минут.`, {
    reply_markup: kb([[{ text: '⚡ Перейти к оплате', url: ad.pay_url }], [btn('« Меню', 'menu')]]),
  });
}

// Вызывается из вебхука Finik после успешной оплаты
export async function onPaid(env, adId, amount) {
  const ad = await env.DB.prepare('SELECT * FROM ads WHERE id = ?').bind(adId).first();
  if (!ad) return alertAdmin(env, `⚠️ Finik: оплата ${amount} сом по неизвестному объявлению ${esc(adId)}. Проверьте кабинет Finik.`);
  if (amount + 0.001 < PRICE) return alertAdmin(env, `⚠️ Объявление ${ad.id} оплачено не полностью: ${amount} из ${PRICE} сом. Не опубликовано.`);
  // «expired» тоже публикуем: клиент мог оплатить на последней минуте
  const lock = await env.DB.prepare("UPDATE ads SET status = 'publishing', paid_at = ? WHERE id = ? AND status IN ('pending','expired')").bind(Date.now(), ad.id).run();
  if (!lock.meta.changes) return;
  const r = await sendAd(env, env.GROUP_ID, ad.photo, adText({ ...ad, active: 1 }), { reply_markup: groupMarkup(env, ad) });
  if (!r.ok) {
    await env.DB.prepare("UPDATE ads SET status = 'pending' WHERE id = ?").bind(ad.id).run();
    await alertAdmin(env, `⚠️ Объявление ${ad.id} оплачено, но не опубликовано: ${esc(r.description || '')}. Проверьте, что бот админ группы и GROUP_ID верный.`);
    return send(env, ad.tg_id, 'Оплата прошла, но опубликовать не получилось. Мы уже разбираемся, объявление выйдет в ближайшее время.');
  }
  const msgId = r.result.message_id;
  await env.DB.prepare("UPDATE ads SET status = 'published', active = 1, group_msg_id = ? WHERE id = ?").bind(msgId, ad.id).run();
  await env.DB.prepare('UPDATE users SET state = NULL, draft = NULL WHERE tg_id = ?').bind(ad.tg_id).run();
  const link = postLink(env, msgId);
  return send(env, ad.tg_id, '✅ <b>Оплата получена, объявление опубликовано в группе!</b>\nКогда оно перестанет быть актуальным, отметьте это в разделе «Мой профиль».', {
    reply_markup: kb([...(link ? [[{ text: '📣 Открыть в группе', url: link }]] : []), [btn('👤 Мой профиль', 'me')]]),
  });
}

// ---------- профиль и мои объявления ----------
async function profile(env, user, chat) {
  const s = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(active),0) AS a FROM ads WHERE tg_id = ? AND status = 'published'").bind(user.tg_id).first();
  return send(env, chat, `👤 <b>Мой профиль</b>\n${user.username ? '@' + esc(user.username) : esc(user.first_name || '')}\n\nОпубликовано объявлений: ${s.n}\nИз них актуальных: ${s.a}`, {
    reply_markup: kb([[btn('📄 Мои объявления', 'my')], [btn('« Меню', 'menu')]]),
  });
}
const ownerButtons = (env, a) => {
  const link = postLink(env, a.group_msg_id);
  return kb([[btn(a.active ? '❌ Снять с актуальных' : '✅ Сделать актуальным', 'tg:' + a.id), btn('🗑 Удалить', 'del:' + a.id)], ...(link ? [[{ text: '📣 В группе', url: link }]] : [])]);
};
async function myAds(env, user, chat) {
  const { results } = await env.DB.prepare("SELECT * FROM ads WHERE tg_id = ? AND status = 'published' ORDER BY created_at DESC LIMIT 10").bind(user.tg_id).all();
  if (!results.length) return send(env, chat, 'У вас пока нет опубликованных объявлений.', { reply_markup: kb([[btn('🏠 Сдать', 'new:rent'), btn('🔍 Найти', 'new:seek')], [btn('« Меню', 'menu')]]) });
  for (const a of results) await sendAd(env, chat, a.photo, adText(a), { reply_markup: ownerButtons(env, a) });
  return send(env, chat, 'Показаны последние 10 объявлений.', { reply_markup: kb([[btn('« Меню', 'menu')]]) });
}
async function toggle(env, user, chat, mid, id) {
  const a = await env.DB.prepare("SELECT * FROM ads WHERE id = ? AND tg_id = ? AND status = 'published'").bind(id, user.tg_id).first();
  if (!a) return;
  a.active = a.active ? 0 : 1;
  await env.DB.prepare('UPDATE ads SET active = ? WHERE id = ?').bind(a.active, a.id).run();
  await editAd(env, env.GROUP_ID, a.group_msg_id, a.photo, adText(a), { reply_markup: groupMarkup(env, a) });
  await editAd(env, chat, mid, a.photo, adText(a), { reply_markup: ownerButtons(env, a) });
}
async function askDelete(env, user, chat, id) {
  const a = await env.DB.prepare("SELECT * FROM ads WHERE id = ? AND tg_id = ? AND status = 'published'").bind(id, user.tg_id).first();
  if (!a) return;
  return send(env, chat, `Удалить объявление «${esc(a.city)}, ${esc(a.district)}, ${fmt(a.price)} сом»? Оплата не возвращается.`, { reply_markup: kb([[btn('🗑 Да, удалить', 'dy:' + a.id), btn('Отмена', 'my')]]) });
}
async function doDelete(env, user, chat, id) {
  const a = await env.DB.prepare("SELECT * FROM ads WHERE id = ? AND tg_id = ? AND status = 'published'").bind(id, user.tg_id).first();
  if (!a) return;
  await tg(env, 'deleteMessage', { chat_id: env.GROUP_ID, message_id: a.group_msg_id });
  await env.DB.prepare("UPDATE ads SET status = 'deleted', active = 0 WHERE id = ?").bind(a.id).run();
  return send(env, chat, 'Объявление удалено из группы.', { reply_markup: kb([[btn('📄 Мои объявления', 'my'), btn('« Меню', 'menu')]]) });
}

// ---------- просмотр объявлений ----------
async function browse(env, chat, kind, page) {
  const { results } = await env.DB.prepare("SELECT * FROM ads WHERE status = 'published' AND active = 1 AND kind = ? ORDER BY created_at DESC LIMIT ? OFFSET ?").bind(kind, PAGE + 1, page * PAGE).all();
  if (!results.length) return send(env, chat, page ? 'Больше объявлений нет.' : 'Пока объявлений нет.', { reply_markup: kb([[btn('« Назад', 'br')]]) });
  for (const a of results.slice(0, PAGE)) {
    const link = postLink(env, a.group_msg_id), rows = [];
    const c = contactBtn(a); if (c) rows.push(c);
    if (link) rows.push({ text: '📣 В группе', url: link });
    await sendAd(env, chat, a.photo, adText(a), rows.length ? { reply_markup: kb([rows]) } : {});
  }
  const nav = []; if (page) nav.push(btn('← Назад', `b:${kind}:${page - 1}`)); if (results.length > PAGE) nav.push(btn('Далее →', `b:${kind}:${page + 1}`));
  return send(env, chat, 'Это ещё не всё? Листайте дальше.', { reply_markup: kb([...(nav.length ? [nav] : []), [btn('« Меню', 'menu')]]) });
}

// ---------- обработка обновлений ----------
export async function handleUpdate(env, u, origin) {
  if (u.callback_query) return onCallback(env, u.callback_query, origin);
  const m = u.message;
  // /id в любом чате (в том числе в группе) отвечает номером чата: нужен для GROUP_ID
  if (m && /^\/id(@\w+)?\s*$/i.test((m.text || '').trim())) return send(env, m.chat.id, `ID этого чата: <code>${m.chat.id}</code>`);
  if (!m || !m.from || m.chat.type !== 'private') return;
  const user = await getUser(env, m.from), chat = m.chat.id, text = (m.text || '').trim();
  if (/^\/start\s+new\b/.test(text)) {   // кнопка «Создать объявление» из группы
    await setState(env, user.tg_id, null, null);
    return send(env, chat, 'Что хотите разместить? Объявление стоит ' + PRICE + ' сом.', { reply_markup: kb([[btn('🏠 Сдать квартиру', 'new:rent')], [btn('🔍 Найти квартиру', 'new:seek')], [btn('« Меню', 'menu')]]) });
  }
  if (/^\/(start|menu)/.test(text)) { await setState(env, user.tg_id, null, null); return menu(env, chat); }
  if (user.state && user.state.startsWith('wiz:')) {
    const step = user.state.slice(4);
    if (step === 'photo') {
      if (m.photo && m.photo.length) return accept(env, user, chat, 'photo', m.photo[m.photo.length - 1].file_id);   // последний размер = самый крупный
      return send(env, chat, '⚠️ Нужно фото квартиры. Отправьте именно фото, не файлом и не текстом.');
    }
    if (m.photo) return;   // лишние фото из альбома на других шагах не мешаем
    if (text) return accept(env, user, chat, step, text);
  }
  return menu(env, chat);
}
async function onCallback(env, cq, origin) {
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  if (!cq.message) return;
  const chat = cq.message.chat.id, mid = cq.message.message_id, user = await getUser(env, cq.from);
  const data = cq.data || '', i = data.indexOf(':'), a = i < 0 ? data : data.slice(0, i), rest = i < 0 ? '' : data.slice(i + 1);
  switch (a) {
    case 'menu': await setState(env, user.tg_id, null, null); return menu(env, chat);
    case 'new': return startWizard(env, user, chat, rest);
    case 'v': {   // выбор кнопкой в мастере: v:<шаг>:<значение>
      const j = rest.indexOf(':'), step = rest.slice(0, j); let val = rest.slice(j + 1);
      if (user.state !== 'wiz:' + step) return;   // нажали кнопку из старого сообщения
      if (step === 'city' && val === '*') return send(env, chat, 'Напишите название города.');
      if (step === 'contact' && val === 'me') val = '@' + (user.username || '');
      return accept(env, user, chat, step, val);
    }
    case 'pay': return pay(env, user, chat, origin);
    case 'me': return profile(env, user, chat);
    case 'my': return myAds(env, user, chat);
    case 'tg': return toggle(env, user, chat, mid, rest);
    case 'del': return askDelete(env, user, chat, rest);
    case 'dy': return doDelete(env, user, chat, rest);
    case 'br': return send(env, chat, 'Какие объявления показать?', { reply_markup: kb([[btn('🏠 Сдают', 'b:rent:0'), btn('🔍 Ищут', 'b:seek:0')], [btn('« Меню', 'menu')]]) });
    case 'b': { const [k, p] = rest.split(':'); return KIND[k] ? browse(env, chat, k, Math.max(0, parseInt(p, 10) || 0)) : undefined; }
  }
}

// Раз в несколько минут: неоплаченные черновики старше 40 минут помечаем просроченными
export async function cleanup(env) {
  await env.DB.prepare("UPDATE ads SET status = 'expired' WHERE status = 'pending' AND created_at < ?").bind(Date.now() - (PAY_MIN + 10) * 60000).run();
}
