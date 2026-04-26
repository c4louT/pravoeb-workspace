// Cloudflare Worker entry: статика + API-мост чат-виджета к Telegram.
// Все не-API запросы отдаются через env.ASSETS.fetch() (т.е. index.html и прочая статика).
//
// Маршруты:
//   POST /api/chat/send       — авторизованный (Supabase JWT). Тело {text}. Пересылает в Telegram и кладёт строку 'out' в chat_messages.
//   POST /api/tg/webhook      — Telegram webhook. Проверяет секретный заголовок, ищет пользователя по chat_id, кладёт 'in' в chat_messages.
//   GET  /api/health          — простой пинг.
//   всё остальное             — env.ASSETS.fetch(request) (index.html, _headers и т.д.)
//
// Нужные CF-секреты (wrangler secret put ...):
//   TELEGRAM_BOT_TOKEN            — токен Telegram-бота.
//   TELEGRAM_WEBHOOK_SECRET       — произвольная строка; Telegram пришлёт её в заголовке X-Telegram-Bot-Api-Secret-Token.
//   SUPABASE_URL                  — например https://vcjwzkbsivgiivgvibjo.supabase.co
//   SUPABASE_ANON_KEY             — публичный anon key (для верификации JWT пользователя + RLS-insert).
//   SUPABASE_SERVICE_ROLE_KEY     — service-role key (для webhook: вставка 'in' в обход RLS).
//
// Хостинг: тот же Worker что и статика — https://pravoeb-workspace.arstepan2006.workers.dev/.

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function methodNotAllowed() {
  return json({ ok: false, error: 'method_not_allowed' }, 405);
}

async function tgSendMessage(env, chatId, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    return { ok: false, error: body.description || `telegram_${res.status}` };
  }
  return { ok: true, tg_message_id: body.result?.message_id || null };
}

async function sbGetUser(env, jwt) {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

async function sbGetProfile(env, jwt, userId) {
  const url = `${env.SUPABASE_URL}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=telegram_chat_id,display_name`;
  const res = await fetch(url, {
    headers: { apikey: env.SUPABASE_ANON_KEY, authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return rows[0] || null;
}

async function sbInsertChatMessageAsUser(env, jwt, row) {
  // Вставляем из-под JWT пользователя — RLS-чек пройдёт (policy "chat: insert own").
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/chat_messages`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: `Bearer ${jwt}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    return { ok: false, error: `supabase_${res.status}`, detail: err.slice(0, 400) };
  }
  const body = await res.json().catch(() => []);
  return { ok: true, row: body[0] || null };
}

async function sbInsertChatMessageAsService(env, row) {
  // Webhook -> вставляем от service-role, RLS обходится.
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/chat_messages`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    return { ok: false, error: `supabase_${res.status}`, detail: err.slice(0, 400) };
  }
  return { ok: true };
}

async function sbFindUserByChatId(env, chatId) {
  const url = `${env.SUPABASE_URL}/rest/v1/profiles?telegram_chat_id=eq.${encodeURIComponent(chatId)}&select=user_id&limit=1`;
  const res = await fetch(url, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return rows[0]?.user_id || null;
}

async function handleChatSend(request, env) {
  if (request.method !== 'POST') return methodNotAllowed();
  const auth = request.headers.get('authorization') || '';
  const jwt = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : null;
  if (!jwt) return json({ ok: false, error: 'unauthorized' }, 401);

  const user = await sbGetUser(env, jwt);
  if (!user?.id) return json({ ok: false, error: 'unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }
  const text = String(body?.text || '').trim();
  if (!text) return json({ ok: false, error: 'empty_text' }, 400);
  if (text.length > 4000) return json({ ok: false, error: 'text_too_long' }, 400);

  const profile = await sbGetProfile(env, jwt, user.id);
  const chatId = profile?.telegram_chat_id;
  if (!chatId) {
    return json({ ok: false, error: 'no_telegram_chat_id', hint: 'Укажи свой Telegram ID в настройках профиля' }, 400);
  }

  const prefix = profile?.display_name ? `[${profile.display_name} · дашборд]\n` : '[дашборд]\n';
  const tgRes = await tgSendMessage(env, chatId, prefix + text);
  if (!tgRes.ok) return json({ ok: false, error: 'telegram_failed', detail: tgRes.error }, 502);

  const ins = await sbInsertChatMessageAsUser(env, jwt, {
    user_id: user.id,
    direction: 'out',
    text,
    tg_message_id: tgRes.tg_message_id,
  });
  if (!ins.ok) return json({ ok: false, error: 'db_insert_failed', detail: ins.detail }, 500);

  return json({ ok: true, tg_message_id: tgRes.tg_message_id, row: ins.row });
}

async function handleTgWebhook(request, env) {
  if (request.method !== 'POST') return methodNotAllowed();
  const got = request.headers.get('x-telegram-bot-api-secret-token') || '';
  if (!env.TELEGRAM_WEBHOOK_SECRET || got !== env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }
  let update;
  try { update = await request.json(); } catch { return json({ ok: true }); } // Telegram всё равно ждёт 200

  const msg = update?.message || update?.edited_message;
  if (!msg) return json({ ok: true });
  const chatId = msg.chat?.id;
  const text = (msg.text || msg.caption || '').trim();
  const mid = msg.message_id;
  if (!chatId || !text) return json({ ok: true });

  // Команда /start — инструкция как прописать chat_id в дашборде.
  if (text === '/start' || text === '/id') {
    await tgSendMessage(env, chatId, `Твой Telegram chat_id: ${chatId}\nВставь его в дашборде: Профиль → Telegram ID.`);
    return json({ ok: true });
  }

  const userId = await sbFindUserByChatId(env, chatId);
  if (!userId) {
    await tgSendMessage(env, chatId, `Этот chat_id (${chatId}) ещё не привязан к пользователю дашборда. Открой дашборд → Профиль → Telegram ID и вставь: ${chatId}`);
    return json({ ok: true });
  }

  const ins = await sbInsertChatMessageAsService(env, {
    user_id: userId,
    direction: 'in',
    text,
    tg_message_id: mid,
  });
  if (!ins.ok) {
    // Возвращаем 500, чтобы Telegram повторил вебхук (транзиентные сбои БД) и сообщение не потерялось.
    console.error('tg webhook: failed to insert incoming message', ins.error, ins.detail);
    return json({ ok: false, error: ins.error, detail: ins.detail }, 500);
  }

  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/health') return json({ ok: true, ts: Date.now() });
    if (path === '/api/chat/send') return handleChatSend(request, env);
    if (path === '/api/tg/webhook') return handleTgWebhook(request, env);

    // Fallback — статика
    if (env.ASSETS && env.ASSETS.fetch) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
