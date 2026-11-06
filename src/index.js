import { handleUpdate, onPaid, cleanup } from './bot.js';
import { finikWebhook, finikReady } from './finik.js';
import { ensure } from './db.js';

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), path = url.pathname;
    await ensure(env);

    // Вебхук Telegram
    if (path === '/tg' && req.method === 'POST') {
      if (!env.WEBHOOK_SECRET || req.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      const u = await req.json().catch(() => null);
      if (u) ctx.waitUntil(handleUpdate(env, u, url.origin).catch(e => console.log('update error', e && e.stack || e)));
      return new Response('ok');
    }

    // Вебхук Finik: подтверждение оплаты
    if (path === '/api/finik/webhook' && req.method === 'POST') {
      const r = await finikWebhook(env, req, onPaid);
      return new Response(r.body, { status: r.status });
    }

    // Разовая настройка: открыть в браузере https://<воркер>/setup?key=<WEBHOOK_SECRET>
    if (path === '/setup') {
      if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      const call = (m, b) => fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${m}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
      const hook = await call('setWebhook', { url: url.origin + '/tg', secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
      const cmds = await call('setMyCommands', { commands: [{ command: 'start', description: 'Главное меню' }] });
      const me = await call('getMe', {});
      const grp = env.GROUP_ID ? await call('getChatMember', { chat_id: env.GROUP_ID, user_id: me.result && me.result.id }) : null;
      return Response.json({ webhook: hook, commands: cmds, bot: me.result && me.result.username, finik: finikReady(env), group_id_set: !!env.GROUP_ID, bot_in_group: grp && grp.ok ? grp.result.status : (grp ? grp.description : 'GROUP_ID не задан') });
    }

    return new Response('Квартирник: бот работает');
  },
  async scheduled(ev, env, ctx) { await ensure(env); ctx.waitUntil(cleanup(env)); },
};
