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
// Хостинг: тот же Worker что и статика (Cloudflare worker, субдомен из wrangler.toml).

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
  // Service-role вставка, RLS обходится. Возвращаем вставленную строку — нужно для AI-флоу.
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/chat_messages`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
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
  return { ok: true, row: Array.isArray(body) ? (body[0] || null) : null };
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

  // Лимит Telegram Bot API — 4096 символов. Урезаем display_name и, если надо, сам текст.
  const nameRaw = String(profile?.display_name || '').slice(0, 80);
  const prefix = nameRaw ? `[${nameRaw} · дашборд]\n` : '[дашборд]\n';
  const TG_LIMIT = 4096;
  let finalMsg = prefix + text;
  if (finalMsg.length > TG_LIMIT) finalMsg = finalMsg.slice(0, TG_LIMIT - 1) + '…';
  const tgRes = await tgSendMessage(env, chatId, finalMsg);
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

// =========================================================================
// /api/chat/ai — запрос к OpenRouter с историей переписки как контекстом.
// =========================================================================

// По состоянию на 2026-04: free-варианты Gemini 2.0 Flash exp и DeepSeek v3-0324 были убраны с OpenRouter,
// заменили на актуальные. Список моделей на сегодня в виджете и worker-е должны совпадать.
const DEFAULT_MODEL = 'openai/gpt-oss-120b:free';
const ALLOWED_MODELS = new Set([
  // free
  'openai/gpt-oss-120b:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'nousresearch/hermes-3-llama-3.1-405b:free',
  'google/gemma-4-31b-it:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  // paid 2026
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-opus-4.6',
  'openai/gpt-5',
  'openai/gpt-5-mini',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash',
  'deepseek/deepseek-v3.2',
]);
const DEFAULT_DOCGEN_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';

const SYSTEM_PROMPT = `Ты — AI-помощник юриста в сфере кинопроизводства и ТВ в Российской Федерации.
Твой пользователь — продюсер/юрист, работающий в кинопроизводстве.
Отвечай на русском, кратко и по делу. Форматируй ответы маркдауном (списки, выделение важного).
Ссылайся на конкретные статьи ГК РФ (часть IV — интеллектуальная собственность), ФЗ «О государственной поддержке кинематографии» №126-ФЗ, ТК РФ, НК РФ.
Если норма могла измениться или ты не уверен в актуальной редакции — прямо говори «нужно проверить на consultant.ru или pravo.gov.ru», не выдумывай статью.
Если задача выходит за пределы юр/производственной тематики — помогай как обычный ассистент, но не выдавай себя за лицензированного адвоката.
Не пиши длинных извинений и воды. Отвечай так, как отвечал бы опытный юрист коллеге.`;

async function sbFetchRecentMessages(env, jwt, userId, limit) {
  const url = `${env.SUPABASE_URL}/rest/v1/chat_messages?user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=${limit}&select=direction,text,created_at`;
  const res = await fetch(url, {
    headers: { apikey: env.SUPABASE_ANON_KEY, authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) return [];
  const rows = await res.json().catch(() => []);
  return rows.reverse();
}

async function openrouterChat(env, model, messages) {
  if (!env.OPENROUTER_API_KEY) return { ok: false, error: 'openrouter_key_missing' };
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://pravoeb-workspace.arstepan2006.workers.dev',
      'X-Title': 'Cuelex Dashboard',
    },
    body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 1500 }),
  });
  const body = await res.json().catch(() => ({}));
  // OpenRouter иногда возвращает HTTP 200 с inline error-объектом вместо choices, когда free-провайдер упал.
  // Собираем всю доступную диагностику: сообщение + raw upstream + код провайдера, чтобы тост в UI был осмысленный.
  const inlineErr = body?.error;
  if (!res.ok || inlineErr) {
    const baseMsg = inlineErr?.message || `openrouter_${res.status}`;
    const rawMeta = inlineErr?.metadata?.raw;
    const provider = inlineErr?.metadata?.provider_name;
    const code = inlineErr?.code;
    let detail = baseMsg;
    if (provider) detail += ` [${provider}]`;
    if (code) detail += ` (code=${code})`;
    if (rawMeta && typeof rawMeta === 'string' && rawMeta !== baseMsg) {
      detail += ` — ${rawMeta.slice(0, 300)}`;
    }
    console.error('openrouter call failed', { model, status: res.status, body });
    return { ok: false, error: detail };
  }
  const text = body?.choices?.[0]?.message?.content?.trim();
  if (!text) {
    console.error('openrouter empty response', { model, body });
    return { ok: false, error: 'empty_response (модель не вернула текст — попробуй другую)' };
  }
  return { ok: true, text, model: body?.model || model, usage: body?.usage || null };
}

function buildMessages(history, userText) {
  const msgs = [{ role: 'system', content: SYSTEM_PROMPT }];
  // Последние сообщения как контекст. direction='out' → user, 'ai' → assistant, 'in' → user (пишется от имени человека из TG).
  for (const m of history) {
    const role = m.direction === 'ai' ? 'assistant' : 'user';
    const content = String(m.text || '').slice(0, 4000);
    if (content) msgs.push({ role, content });
  }
  msgs.push({ role: 'user', content: userText });
  return msgs;
}

async function handleChatAi(request, env) {
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
  const model = ALLOWED_MODELS.has(body?.model) ? body.model : DEFAULT_MODEL;

  // 1) Сохраняем вопрос пользователя 'out'
  const userIns = await sbInsertChatMessageAsUser(env, jwt, {
    user_id: user.id,
    direction: 'out',
    text,
  });
  if (!userIns.ok) return json({ ok: false, error: 'db_insert_failed', detail: userIns.detail }, 500);

  // 2) Достаём историю (без только что вставленного — он уже есть в text)
  const history = await sbFetchRecentMessages(env, jwt, user.id, 20);
  // Убираем последний 'out' (мы его только что вставили) чтобы не дублировать в messages
  const idx = history.findLastIndex?.((m) => m.direction === 'out' && m.text === text);
  if (idx >= 0) history.splice(idx, 1);

  const messages = buildMessages(history, text);

  // 3) Запрос в OpenRouter
  const ai = await openrouterChat(env, model, messages);
  if (!ai.ok) {
    // user_row уже в БД; возвращаем его клиенту чтобы UI не терял сообщение пока realtime догоняет.
    return json({ ok: false, error: 'ai_failed', detail: ai.error, user_row: userIns.row || null }, 502);
  }

  // 4) Сохраняем ответ 'ai' через service-role (чтобы RLS не требовал auth.uid==user_id для записи 'ai')
  const aiIns = await sbInsertChatMessageAsService(env, {
    user_id: user.id,
    direction: 'ai',
    text: ai.text,
    model: ai.model,
  });
  if (!aiIns.ok) {
    // Ответ уже получен — вернём его клиенту даже если в БД не записали, чтобы юзер не потерял.
    console.error('ai response inserted failed', aiIns.error, aiIns.detail);
  }

  return json({
    ok: true,
    text: ai.text,
    model: ai.model,
    usage: ai.usage,
    user_row: userIns.row || null,
    ai_row: aiIns.ok ? (aiIns.row || null) : null,
  });
}

// =========================================================================
// /api/docgen/extract — Phase 5e: AI извлекает значения полей договора из
// свободного текста пользователя. На вход список fields[], на выход
// JSON {values: {key: value}, missing: [{key, label, question}]}.
// Не пишем в БД — это вспомогательный stateless-эндпоинт для модалки.
// =========================================================================

const DOCGEN_SYSTEM = `Ты — AI-ассистент, который извлекает значения полей юридического договора из описания пользователя.

ВХОД:
1. Описание договора свободным русским текстом.
2. Шаблон договора с метаданными (название, налоговая форма исполнителя).
3. Список полей шаблона: каждое поле имеет уникальный key вида "{snake_case}", человекочитаемый label, type (text/date/number/textarea/select), и опциональный autofill-источник.

ЗАДАЧА:
Вернуть СТРОГО JSON-объект следующего формата (без markdown-обрамления, без комментариев):
{
  "values": { "{key1}": "значение", "{key2}": "значение" },
  "missing": [ { "key": "{keyN}", "label": "человеческий label", "question": "Уточняющий вопрос пользователю" } ]
}

ПРАВИЛА:
- Включай в "values" ТОЛЬКО те ключи, для которых пользователь явно указал значение или это обоснованно следует из текста.
- Ключи в "values" должны точно совпадать со списком fields (с фигурными скобками: "{contract_number}").
- Для type="date" возвращай в формате YYYY-MM-DD (ISO 8601, например "2026-05-15") — это требование нативного <input type="date">. Фронт сам конвертирует в русский формат для превью.
- Для type="number" — только цифры без пробелов, без символов валюты.
- Для текстовых полей суммы — пиши прописью ("сто тысяч рублей").
- Не выдумывай ИНН, ОГРН, КПП, паспорта — если не указаны, добавь в "missing".
- Поля school.* (реквизиты Киношколы) НЕ заполняй — они автозаполняются на фронте.
- Поля autofill="contact.*" заполняй из текста про контрагента; "project.*" — из текста про фильм/проект.
- В "missing" клади только КРИТИЧНЫЕ для договора поля, которые не упомянуты (например ФИО исполнителя, паспорт/ИНН в зависимости от tax_form, сумма гонорара, дата). Не больше 5 вопросов.
- Поля типа {manual_N} с label "Поле (контекст: ...)" — это неразмеченные плейсхолдеры; заполняй их только если из контекста ОЧЕВИДНО что туда пишется (например "ДОГОВОР {f1} (далее..." — туда идёт номер договора). Иначе НЕ включай в "values" и НЕ включай в "missing".
- НИКАКОГО текста кроме JSON. Никаких объяснений до или после.`;

function tryParseDocgenJson(text) {
  if (!text || typeof text !== 'string') return null;
  // Иногда модели оборачивают JSON в \`\`\`json ... \`\`\` или префиксят текстом.
  let s = text.trim();
  // Снимаем тройные обратные кавычки если есть
  const fence = s.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fence) s = fence[1].trim();
  // Берём от первой { до последней } — на случай мусора
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i < 0 || j < 0 || j <= i) return null;
  const cand = s.slice(i, j + 1);
  try { return JSON.parse(cand); } catch { return null; }
}

async function handleDocgenExtract(request, env) {
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
  if (text.length > 6000) return json({ ok: false, error: 'text_too_long' }, 400);
  const fields = Array.isArray(body?.fields) ? body.fields.slice(0, 200) : [];
  if (!fields.length) return json({ ok: false, error: 'no_fields' }, 400);
  const templateId = String(body?.template_id || '').slice(0, 80);
  const templateLabel = String(body?.template_label || '').slice(0, 200);
  const model = ALLOWED_MODELS.has(body?.model) ? body.model : DEFAULT_DOCGEN_MODEL;

  // Компактный JSON-список полей для промпта (label + key + type)
  const fieldsCompact = fields.map((f) => ({
    key: String(f.key || ''),
    label: String(f.label || '').slice(0, 200),
    type: String(f.type || 'text'),
    autofill: f.autofill ? String(f.autofill).slice(0, 60) : null,
  }));

  const userMsg = `ШАБЛОН: ${templateLabel} (id=${templateId})

ПОЛЯ ШАБЛОНА:
${JSON.stringify(fieldsCompact, null, 0)}

ОПИСАНИЕ ДОГОВОРА:
${text}

Верни JSON с values и missing.`;

  const messages = [
    { role: 'system', content: DOCGEN_SYSTEM },
    { role: 'user', content: userMsg },
  ];

  const ai = await openrouterChat(env, model, messages);
  if (!ai.ok) return json({ ok: false, error: 'ai_failed', detail: ai.error }, 502);

  const parsed = tryParseDocgenJson(ai.text);
  if (!parsed || typeof parsed !== 'object') {
    return json({ ok: false, error: 'bad_ai_response', detail: 'AI вернул не-JSON: ' + (ai.text || '').slice(0, 300) }, 502);
  }

  const values = parsed.values && typeof parsed.values === 'object' ? parsed.values : {};
  const missing = Array.isArray(parsed.missing) ? parsed.missing.slice(0, 10) : [];

  // Фильтруем values: ключи должны быть из fields[]; missing — тоже валидируем
  const fieldKeys = new Set(fieldsCompact.map((f) => f.key));
  const cleanValues = {};
  for (const [k, v] of Object.entries(values)) {
    const key = String(k).startsWith('{') ? String(k) : '{' + String(k).replace(/[{}]/g, '') + '}';
    if (!fieldKeys.has(key)) continue;
    if (v == null || v === '') continue;
    cleanValues[key] = String(v).slice(0, 1000);
  }
  const cleanMissing = missing
    .filter((m) => m && m.key)
    .map((m) => ({
      key: String(m.key).startsWith('{') ? String(m.key) : '{' + String(m.key).replace(/[{}]/g, '') + '}',
      label: String(m.label || '').slice(0, 200),
      question: String(m.question || m.label || '').slice(0, 300),
    }))
    .filter((m) => fieldKeys.has(m.key) && !cleanValues[m.key]);

  return json({ ok: true, values: cleanValues, missing: cleanMissing, model: ai.model, usage: ai.usage });
}

// =========================================================================
// /api/docgen/chat — Phase 5f+5g: ОДНА ручка для чата.
// Принимает свободный текст → AI выбирает шаблон из templates_index.json
// → AI извлекает значения полей → отдаёт всё клиенту, тот рендерит DOCX.
// =========================================================================

const DOCGEN_CLASSIFY_SYSTEM = `Ты — классификатор юридических шаблонов договоров для российского кинопроизводства.

Тебе дают:
1. Описание договора пользователем (свободный русский текст).
2. Список доступных шаблонов: каждый имеет id, label, role_group ("Звукоцех", "Операторский цех", и т.п.), tax_form ("ИП"/"ФЛ"/"СЗ"/"ЮЛ"/"ИП+ФЛ"/"?").

Твоя задача — выбрать ОДИН наиболее подходящий шаблон.

Верни СТРОГО JSON (без markdown):
{
  "template_id": "id_шаблона",
  "confidence": 0.85,
  "alternatives": [
    { "template_id": "alt_1", "label": "alt label" },
    { "template_id": "alt_2", "label": "alt label" }
  ],
  "reason": "короткое объяснение почему именно этот шаблон"
}

ПРАВИЛА:
- "confidence" — твоя оценка от 0 до 1 насколько ты уверен. Если < 0.6 — обязательно дай alternatives с 2-3 вариантами.
- Сначала определи РОЛЬ исполнителя (звукорежиссёр, оператор, актёр, гафер, …) → это указывает на role_group + конкретный шаблон.
- Затем определи НАЛОГОВУЮ ФОРМУ: ИП (есть ОГРНИП/ИНН ИП), Самозанятый/СЗ (упоминается НПД), ФЛ (есть паспорт без ИП), ЮЛ (договор с компанией). Если форма не указана — используй "ФЛ" как дефолт.
- Если role_group ясен но конкретный шаблон неоднозначен — используй alternatives.
- НИКАКОГО текста кроме JSON.`;

async function loadTemplatesIndex(request, env) {
  if (!env.ASSETS || !env.ASSETS.fetch) return null;
  const u = new URL('/contracts/templates_index.json', request.url);
  const res = await env.ASSETS.fetch(new Request(u.toString()));
  if (!res.ok) return null;
  return await res.json().catch(() => null);
}

async function handleDocgenChat(request, env) {
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
  if (text.length > 6000) return json({ ok: false, error: 'text_too_long' }, 400);
  const model = ALLOWED_MODELS.has(body?.model) ? body.model : DEFAULT_DOCGEN_MODEL;
  // Опциональное принудительное закрепление шаблона (если пользователь уточнил какой именно)
  const forceTemplateId = body?.template_id ? String(body.template_id).slice(0, 80) : null;

  // 1) Загружаем индекс шаблонов из ASSETS
  const idx = await loadTemplatesIndex(request, env);
  if (!idx || !Array.isArray(idx.templates)) {
    return json({ ok: false, error: 'templates_index_missing' }, 500);
  }
  const tplById = new Map(idx.templates.map((t) => [t.id, t]));

  let chosen = null;
  let classify = null;

  if (forceTemplateId && tplById.has(forceTemplateId)) {
    chosen = tplById.get(forceTemplateId);
    classify = { template_id: forceTemplateId, confidence: 1, alternatives: [], reason: 'forced by client' };
  } else {
    // 2) Шаг классификации — отдаём AI компактный список (id + label + role_group + tax_form)
    const tplCompact = idx.templates.map((t) => ({
      id: t.id,
      label: t.label,
      role_group: t.role_group || null,
      tax_form: t.tax_form || null,
    }));
    const classifyMsg = `СПИСОК ШАБЛОНОВ:
${JSON.stringify(tplCompact, null, 0)}

ОПИСАНИЕ ДОГОВОРА:
${text}

Выбери template_id.`;
    const ai1 = await openrouterChat(env, model, [
      { role: 'system', content: DOCGEN_CLASSIFY_SYSTEM },
      { role: 'user', content: classifyMsg },
    ]);
    if (!ai1.ok) return json({ ok: false, error: 'classify_failed', detail: ai1.error }, 502);
    classify = tryParseDocgenJson(ai1.text);
    if (!classify || !classify.template_id) {
      return json({ ok: false, error: 'classify_bad_json', detail: (ai1.text || '').slice(0, 300) }, 502);
    }
    chosen = tplById.get(classify.template_id);
    if (!chosen) {
      return json({ ok: false, error: 'classify_unknown_template', detail: classify.template_id }, 502);
    }
  }

  // 3) Если confidence низкая — отдаём пользователю на выбор, БЕЗ извлечения значений
  const confidence = typeof classify.confidence === 'number' ? classify.confidence : 1;
  if (!forceTemplateId && confidence < 0.6) {
    const alts = Array.isArray(classify.alternatives) ? classify.alternatives.slice(0, 4) : [];
    // Гарантируем что в альтернативах есть сам chosen
    const altIds = new Set(alts.map((a) => a.template_id));
    if (!altIds.has(chosen.id)) {
      alts.unshift({ template_id: chosen.id, label: chosen.label });
    }
    const altsResolved = alts
      .map((a) => tplById.get(a.template_id))
      .filter(Boolean)
      .slice(0, 4)
      .map((t) => ({ id: t.id, label: t.label, role_group: t.role_group, tax_form: t.tax_form }));
    return json({
      ok: true,
      stage: 'pick_template',
      reason: classify.reason || '',
      confidence,
      alternatives: altsResolved,
    });
  }

  // 4) Шаг извлечения значений — переиспользуем DOCGEN_SYSTEM
  const fieldsCompact = (chosen.fields || []).map((f) => ({
    key: String(f.key || ''),
    label: String(f.label || '').slice(0, 200),
    type: String(f.type || 'text'),
    autofill: f.autofill ? String(f.autofill).slice(0, 60) : null,
  }));
  const extractMsg = `ШАБЛОН: ${chosen.label} (id=${chosen.id})

ПОЛЯ ШАБЛОНА:
${JSON.stringify(fieldsCompact, null, 0)}

ОПИСАНИЕ ДОГОВОРА:
${text}

Верни JSON с values и missing.`;
  const ai2 = await openrouterChat(env, model, [
    { role: 'system', content: DOCGEN_SYSTEM },
    { role: 'user', content: extractMsg },
  ]);
  if (!ai2.ok) return json({ ok: false, error: 'extract_failed', detail: ai2.error }, 502);
  const parsed = tryParseDocgenJson(ai2.text);
  if (!parsed) {
    return json({ ok: false, error: 'extract_bad_json', detail: (ai2.text || '').slice(0, 300) }, 502);
  }
  const values = parsed.values && typeof parsed.values === 'object' ? parsed.values : {};
  const missing = Array.isArray(parsed.missing) ? parsed.missing.slice(0, 10) : [];
  const fieldKeys = new Set(fieldsCompact.map((f) => f.key));
  const cleanValues = {};
  for (const [k, v] of Object.entries(values)) {
    const key = String(k).startsWith('{') ? String(k) : '{' + String(k).replace(/[{}]/g, '') + '}';
    if (!fieldKeys.has(key)) continue;
    if (v == null || v === '') continue;
    cleanValues[key] = String(v).slice(0, 1000);
  }
  const cleanMissing = missing
    .filter((m) => m && m.key)
    .map((m) => ({
      key: String(m.key).startsWith('{') ? String(m.key) : '{' + String(m.key).replace(/[{}]/g, '') + '}',
      label: String(m.label || '').slice(0, 200),
      question: String(m.question || m.label || '').slice(0, 300),
    }))
    .filter((m) => fieldKeys.has(m.key) && !cleanValues[m.key]);

  return json({
    ok: true,
    stage: 'filled',
    template: { id: chosen.id, label: chosen.label, file: chosen.file, role_group: chosen.role_group, tax_form: chosen.tax_form },
    confidence,
    reason: classify.reason || '',
    values: cleanValues,
    missing: cleanMissing,
    model: ai2.model,
  });
}

// =========================================================================
// /api/docgen/generate — Phase 5k: AI-генератор договоров "с нуля".
// Не просто заполняет шаблон, а комбинирует клаузы из корпуса 69 шаблонов
// Кинoшколы и при необходимости пишет новые пункты под нестандартные условия.
// Возвращает структуру блоков с пометкой источника (template_id / ai) для
// Review UI с подсветкой AI-сгенерированных частей.
// =========================================================================

const DOCGEN_GEN_CLASSIFY_SYSTEM = `Ты — аналитик сценариев юридических договоров для российского кинопроизводства.

На вход — описание ситуации от продюсера. На выход — СТРОГО JSON (без markdown):
{
  "contract_type": "actor | director | dop | sound | composer | editor | screenplay | production_designer | art | costume | makeup | light | producer | administrator | choreographer | license | consent | backstage | alienation | other",
  "tax_form": "ФЛ | СЗ | ИП | ЮЛ",
  "role_group": "Актёрский цех | Режиссёрский цех | Операторский цех | Звукоцех | Художественный цех | Световой цех | Сценарий/Литература | Продюсерский цех | Производство | Постпродакшн | Согласия",
  "needs_rid_alienation": true,
  "summary": "2-3 предложения: кто, что делает, за сколько, ключевые нестандартные условия",
  "custom_conditions": ["список нестандартных условий, которых может не быть в стандартных шаблонах — например 'процент от сборов', 'пожизненная лицензия', 'ребёнок-актёр до 14 лет', 'без оформления как ИП'"]
}

Если условие неясно — выбирай наиболее вероятный вариант (для tax_form по умолчанию "ФЛ"). НИКАКОГО текста кроме JSON.`;

const DOCGEN_GEN_COMPOSE_SYSTEM = `Ты — юрист-редактор, собирающий договор для российского кинопроизводства.

Тебе дают:
1. Описание сценария от продюсера.
2. Результат классификации (тип договора, tax_form, нестандартные условия).
3. КОРПУС клауз из проверенных шаблонов Кинoшколы имени С.Ф. Бондарчука — сгруппирован по разделам (subject, term, rights_duties, payment, rights_transfer, personal_data, liability, force_majeure, confidentiality, termination, disputes, requisites).

Твоя задача — собрать полный договор в стиле Кинoшколы.

ПРАВИЛА:
1. Используй клаузы из корпуса ДОСЛОВНО когда они подходят. Это основа юр. корректности.
2. Если нужный пункт НЕ покрыт корпусом (нестандартное условие) — напиши его сам в том же канцелярском стиле. Помечай такие блоки ai_generated=true.
3. Когда адаптируешь клаузу (меняешь детали под сценарий, напр. меняешь сумму, сроки, имена) — оставляй source=template_id + ai_generated=false, но можешь дополнить текст деталями.
4. Подставляй из сценария конкретные значения: суммы, сроки, имена, название фильма. Плейсхолдеры {field_name} из корпуса замени на реальные значения или на [скобки] если нет данных.
5. Сохраняй нумерацию разделов (1, 2, 3, ...) и пунктов внутри раздела (1.1, 1.2, 2.1, ...) — даже если клаузы из разных шаблонов, перенумеруй последовательно.
6. Не включай разделы "requisites" в JSON — их обработаем отдельно.

Верни СТРОГО JSON (без markdown):
{
  "title": "Название договора (напр. 'Договор № ___ на исполнение роли с условием об отчуждении исключительного права')",
  "preamble": "Вводный абзац со сторонами (Продюсер/Исполнитель/Заказчик, ФИО, реквизиты) — в стиле шаблонов корпуса, с плейсхолдерами [ФИО] и [реквизиты] если данных нет",
  "sections": [
    {
      "num": 1,
      "title": "ПРЕДМЕТ ДОГОВОРА",
      "slug": "subject",
      "blocks": [
        {
          "num": "1.1",
          "text": "Полный текст пункта с подставленными значениями из сценария",
          "source": "director_main_fl",
          "ai_generated": false,
          "note": "Опционально: если ты адаптировал или скомпоновал — короткий комментарий, что изменено"
        },
        {
          "num": "1.2",
          "text": "Нестандартный пункт про 2% от сборов",
          "source": "ai",
          "ai_generated": true,
          "note": "Нет аналога в корпусе — сформулировано с нуля под описанный сценарий"
        }
      ]
    }
  ]
}

НИКАКОГО текста кроме JSON. Верни строго валидный JSON.`;

const SECTION_ORDER_FALLBACK = ['definitions', 'subject', 'term', 'rights_duties', 'acceptance', 'payment', 'rights_transfer', 'personal_data', 'liability', 'force_majeure', 'confidentiality', 'guarantees', 'anticorruption', 'termination', 'disputes', 'notices', 'misc'];
const CORPUS_ASSET_PATH = '/contracts/clauses_corpus.json';

async function loadClauseCorpus(request, env) {
  if (!env.ASSETS || !env.ASSETS.fetch) return null;
  const u = new URL(CORPUS_ASSET_PATH, request.url);
  const res = await env.ASSETS.fetch(new Request(u.toString()));
  if (!res.ok) return null;
  return await res.json().catch(() => null);
}

function filterCorpusForScenario(corpus, scenario) {
  if (!corpus || !Array.isArray(corpus.clauses)) return { bySection: {}, templates: [] };
  const targetType = scenario.contract_type || 'other';
  const targetTax = scenario.tax_form || 'ФЛ';
  const targetRG = scenario.role_group || '';
  const needsRid = !!scenario.needs_rid_alienation;

  // Score each template by match quality
  const tplScores = new Map();
  for (const c of corpus.clauses) {
    const t = c.template_id;
    if (!tplScores.has(t)) {
      let score = 0;
      if (c.contract_type === targetType) score += 10;
      if (c.tax_form === targetTax) score += 6;
      if (c.role_group === targetRG) score += 4;
      tplScores.set(t, score);
    }
  }
  // Pick top 4 templates
  const topTemplates = [...tplScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map((x) => x[0])
    .filter((t) => tplScores.get(t) > 0);
  const topSet = new Set(topTemplates);

  const bySection = {};
  for (const c of corpus.clauses) {
    if (!topSet.has(c.template_id)) continue;
    if (c.section_slug === 'requisites' || c.section_slug === 'other') continue;
    if (!needsRid && c.section_slug === 'rights_transfer') continue;
    const arr = bySection[c.section_slug] || (bySection[c.section_slug] = []);
    if (arr.length < 12) {
      arr.push({
        id: c.id,
        template: c.template_id,
        num: c.clause_num,
        text: c.text.slice(0, 1800),
      });
    }
  }
  return { bySection, templates: topTemplates };
}

function buildComposePrompt(scenario, filtered) {
  const lines = ['СЦЕНАРИЙ:', JSON.stringify(scenario, null, 2), '', 'КОРПУС КЛАУЗ (сгруппирован по разделам):', ''];
  const ordered = SECTION_ORDER_FALLBACK.filter((s) => filtered.bySection[s]);
  for (const slug of ordered) {
    const items = filtered.bySection[slug];
    lines.push(`## section=${slug} (${items.length} candidates)`);
    for (const it of items) {
      lines.push(`- [${it.template} §${it.num}] ${it.text.replace(/\s+/g, ' ').slice(0, 600)}`);
    }
    lines.push('');
  }
  lines.push('Собери договор. Верни JSON по описанной схеме.');
  return lines.join('\n');
}

async function handleDocgenGenerate(request, env) {
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
  if (text.length > 6000) return json({ ok: false, error: 'text_too_long' }, 400);
  const model = ALLOWED_MODELS.has(body?.model) ? body.model : DEFAULT_DOCGEN_MODEL;
  // Если клиент уже прогнал Stage-A classify и просто хочет regenerate конкретный блок —
  // поддерживаем режим regenerate с передачей scenario и focus_section.
  const providedScenario = body?.scenario && typeof body.scenario === 'object' ? body.scenario : null;
  const focusSection = body?.focus_section ? String(body.focus_section).slice(0, 40) : null;

  // Stage A: классификация сценария
  let scenario = providedScenario;
  if (!scenario) {
    const ai1 = await openrouterChat(env, model, [
      { role: 'system', content: DOCGEN_GEN_CLASSIFY_SYSTEM },
      { role: 'user', content: text },
    ]);
    if (!ai1.ok) return json({ ok: false, error: 'classify_failed', detail: ai1.error }, 502);
    scenario = tryParseDocgenJson(ai1.text);
    if (!scenario || !scenario.contract_type) {
      return json({ ok: false, error: 'classify_bad_json', detail: (ai1.text || '').slice(0, 300) }, 502);
    }
  }

  // Stage B: загрузка корпуса и фильтрация
  const corpus = await loadClauseCorpus(request, env);
  if (!corpus) return json({ ok: false, error: 'corpus_missing' }, 500);
  const filtered = filterCorpusForScenario(corpus, scenario);
  if (!filtered.templates.length) {
    return json({ ok: false, error: 'no_matching_templates', detail: scenario }, 502);
  }

  // Если focus_section — отсекаем лишние секции из промпта
  if (focusSection && filtered.bySection[focusSection]) {
    const only = { [focusSection]: filtered.bySection[focusSection] };
    filtered.bySection = only;
  }

  // Stage C: композиция
  const composePrompt = buildComposePrompt({ ...scenario, user_description: text }, filtered);
  const ai2 = await openrouterChat(env, model, [
    { role: 'system', content: DOCGEN_GEN_COMPOSE_SYSTEM },
    { role: 'user', content: composePrompt },
  ]);
  if (!ai2.ok) return json({ ok: false, error: 'compose_failed', detail: ai2.error }, 502);
  const composed = tryParseDocgenJson(ai2.text);
  if (!composed || !Array.isArray(composed.sections)) {
    return json({ ok: false, error: 'compose_bad_json', detail: (ai2.text || '').slice(0, 400) }, 502);
  }

  // Санитизация структуры
  const sections = [];
  for (const s of composed.sections.slice(0, 20)) {
    if (!s || typeof s !== 'object') continue;
    const blocks = Array.isArray(s.blocks) ? s.blocks : [];
    const cleanBlocks = blocks
      .map((b) => ({
        num: String(b?.num || '').slice(0, 20),
        text: String(b?.text || '').slice(0, 6000),
        source: String(b?.source || 'ai').slice(0, 80),
        ai_generated: !!b?.ai_generated,
        note: b?.note ? String(b.note).slice(0, 300) : null,
      }))
      .filter((b) => b.text);
    if (!cleanBlocks.length) continue;
    sections.push({
      num: Number.isFinite(s.num) ? s.num : sections.length + 1,
      title: String(s.title || '').slice(0, 200),
      slug: String(s.slug || 'other').slice(0, 40),
      blocks: cleanBlocks,
    });
  }

  return json({
    ok: true,
    scenario,
    title: String(composed.title || 'Договор').slice(0, 300),
    preamble: String(composed.preamble || '').slice(0, 4000),
    sections,
    corpus_templates: filtered.templates,
    model: ai2.model,
    usage: ai2.usage,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/health') return json({ ok: true, ts: Date.now() });
    if (path === '/api/chat/send') return handleChatSend(request, env);
    if (path === '/api/chat/ai') return handleChatAi(request, env);
    if (path === '/api/docgen/extract') return handleDocgenExtract(request, env);
    if (path === '/api/docgen/chat') return handleDocgenChat(request, env);
    if (path === '/api/docgen/generate') return handleDocgenGenerate(request, env);
    if (path === '/api/tg/webhook') return handleTgWebhook(request, env);

    // Fallback — статика
    if (env.ASSETS && env.ASSETS.fetch) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
