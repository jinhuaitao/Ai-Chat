/**
 * Cloudflare Workers AI Chat —— 后端
 *
 * 路由一览
 *   GET    /                          聊天页面（单页应用，登录态由前端调用 /api/config 判断）
 *   GET    /api/config                站点配置：是否需要登录、可用模型列表等
 *   POST   /api/login                 校验访问密码（仅在设置了 ACCESS_PASSWORD 时启用）
 *   POST   /api/logout                退出登录
 *   GET    /api/conversations         会话列表
 *   POST   /api/conversations         新建会话
 *   GET    /api/conversations/:id     读取某个会话（含全部消息）
 *   PATCH  /api/conversations/:id     重命名会话
 *   DELETE /api/conversations/:id     删除会话
 *   POST   /api/chat                  发消息，SSE 流式返回
 *
 * R2 结构
 *   index.json                会话列表（轻量元数据，侧边栏一次读取）
 *   conv/<id>.json            单个会话（含 messages 全量）
 *   sess/<token>.json         登录会话（仅在启用访问密码时使用）
 *   login_fail/<ip>.json      登录失败限流记录
 *
 * 环境变量（Dashboard → Settings → Variables and Secrets）
 *   API_URL          上游接口地址（必填）
 *   API_KEY          上游密钥（必填，建议存为 Secret）
 *   MODEL            默认模型（可选，默认 gpt-4o-mini）
 *   MODELS           可选模型列表，逗号分隔（可选）
 *   SYSTEM_PROMPT    系统提示词（可选）
 *   SITE_TITLE       站点标题（可选）
 *   ACCESS_PASSWORD  访问密码（可选，设置后需要登录）
 *
 * ⚠️ 变量为什么会「重新部署后就没了」
 *   wrangler deploy 默认会先把 Worker 上所有【明文】变量删掉，再写入 wrangler.jsonc 的 vars。
 *   所以只在 Dashboard 里加的明文变量，每次部署都会被清空；而【Secret】类型永远不会被删。
 *   本项目两道防线：package.json 的 deploy 脚本带 --keep-vars；并且建议全部存成 Secret。
 *   为了不让人对着 500 猜半天，/api/config 会把缺失的必填变量直接报出来（见 missingVars）。
 */

import CHAT_HTML from '../public/index.html';

const CONV_PREFIX = 'conv/';
const INDEX_KEY = 'index.json';
const SESSION_PREFIX = 'sess/';
const FAIL_PREFIX = 'login_fail/';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';
const DEFAULT_TITLE = 'AI Chat';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const LOGIN_MAX_FAILS = 8;
const LOGIN_WINDOW_MS = 10 * 60 * 1000; // 10 分钟
const MAX_MESSAGE_CHARS = 32000;
const INDEX_LIMIT = 500;

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function fail(message, status = 400, code = 'bad_request') {
  return json({ error: code, message }, status);
}

function nowIso() {
  return new Date().toISOString();
}

function randomHex(bytes) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(input)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 恒定时间比较，避免用 === 泄露信息 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* R2 读写                                                             */
/* ------------------------------------------------------------------ */

async function getJson(env, key) {
  const obj = await env.CHAT_BUCKET.get(key);
  if (!obj) return null;
  try {
    return await obj.json();
  } catch {
    return null;
  }
}

async function putJson(env, key, value) {
  await env.CHAT_BUCKET.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: 'application/json' },
  });
}

async function deleteKey(env, key) {
  try {
    await env.CHAT_BUCKET.delete(key);
  } catch {
    /* 删除失败不阻塞主流程 */
  }
}

async function readIndex(env) {
  const list = await getJson(env, INDEX_KEY);
  return Array.isArray(list) ? list : [];
}

async function writeIndex(env, list) {
  await putJson(env, INDEX_KEY, list.slice(0, INDEX_LIMIT));
}

function convMeta(conv) {
  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: Array.isArray(conv.messages) ? conv.messages.length : 0,
  };
}

async function saveConversation(env, conv) {
  conv.updatedAt = nowIso();
  await putJson(env, CONV_PREFIX + conv.id + '.json', conv);

  const list = await readIndex(env);
  const meta = convMeta(conv);
  const idx = list.findIndex((item) => item && item.id === conv.id);
  if (idx >= 0) list[idx] = meta;
  else list.unshift(meta);
  list.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  await writeIndex(env, list);
}

function newConversation(title) {
  const now = nowIso();
  return { id: randomHex(12), title: title || '新对话', createdAt: now, updatedAt: now, messages: [] };
}

/** 用第一条用户消息生成会话标题 */
function makeTitle(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '新对话';
  return flat.length > 24 ? flat.slice(0, 24) + '…' : flat;
}

/* ------------------------------------------------------------------ */
/* 环境变量解析                                                        */
/* ------------------------------------------------------------------ */

function siteTitle(env) {
  return String(env.SITE_TITLE || DEFAULT_TITLE);
}

/** 把用户填的 API_URL 归一化成 /chat/completions 端点 */
function resolveEndpoint(rawUrl) {
  let base = String(rawUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v\d+$/i.test(base)) return base + '/chat/completions';
  return base + '/v1/chat/completions';
}

/**
 * 解析单个模型配置项，支持自定义显示名：
 *   deepseek-chat               → { id: 'deepseek-chat', label: 'deepseek-chat' }
 *   deepseek-chat:DeepSeek V3   → { id: 'deepseek-chat', label: 'DeepSeek V3' }
 *   deepseek-chat=DeepSeek V3   → 同上（= 与 : 等价）
 *
 * 优先按 "=" 切分，没有 "=" 时才按 ":" 切分 —— 因为模型 id 里可能自带冒号
 * （例如 Ollama 的 llama3:8b），这种情况请用 "=" 写显示名：llama3:8b=Llama 3 8B
 */
function parseModelEntry(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;

  let sep = text.indexOf('=');
  if (sep < 0) sep = text.indexOf(':');
  if (sep <= 0) return { id: text, label: text };

  const id = text.slice(0, sep).trim();
  if (!id) return { id: text, label: text };
  const label = text.slice(sep + 1).trim();
  return { id, label: label || id };
}

/** 返回 [{ id, label }]，按 id 去重 */
function modelList(env) {
  const raw = String(env.MODELS || env.MODEL || DEFAULT_MODEL);
  const seen = new Set();
  const list = [];

  for (const part of raw.split(',')) {
    const entry = parseModelEntry(part);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    list.push(entry);
  }

  return list.length ? list : [{ id: DEFAULT_MODEL, label: DEFAULT_MODEL }];
}

function systemPrompt(env) {
  const value = env.SYSTEM_PROMPT;
  if (value === undefined || value === null) return DEFAULT_SYSTEM_PROMPT;
  return String(value).trim();
}

/* ------------------------------------------------------------------ */
/* 配置自检                                                            */
/* ------------------------------------------------------------------ */

const REQUIRED_VARS = ['API_URL', 'API_KEY'];

/** 读变量并去掉首尾空白，顺带把 undefined/null 归一成空串 */
function readVar(env, name) {
  const value = env[name];
  return String(value == null ? '' : value).trim();
}

/**
 * 列出缺失的必填环境变量。
 *
 * 这个函数存在的唯一理由，是让「重新部署后变量没了」这个故障自己说清楚。
 * 变量被清空时 Worker 本身照常启动、页面也照常打开，只有发消息那一刻才 500，
 * 用户很难意识到是变量被删了。这里把缺失项报给前端，前端就能直接弹提示。
 */
function missingVars(env) {
  return REQUIRED_VARS.filter((name) => !readVar(env, name));
}

const VARS_FIX_HINT =
  '去 Cloudflare Dashboard → 该 Worker → Settings → Variables and Secrets 添加，' +
  '类型请选 Secret（加密）。选 Text（明文）的变量会在每次 wrangler deploy 时被删除，' +
  '这正是「重新部署后变量就没了」的原因。';

function missingVarsMessage(names) {
  return '缺少环境变量：' + names.join('、') + '。' + VARS_FIX_HINT;
}

/* ------------------------------------------------------------------ */
/* 访问密码 / 会话                                                     */
/* ------------------------------------------------------------------ */

function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!key) return;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  });
  return out;
}

async function authState(env, request) {
  if (!env.ACCESS_PASSWORD) return { required: false, ok: true };
  const token = parseCookies(request)['chat_session'] || '';
  if (!/^[a-f0-9]{48}$/.test(token)) return { required: true, ok: false };
  const session = await getJson(env, SESSION_PREFIX + token + '.json');
  if (!session || !session.exp || session.exp < Date.now()) return { required: true, ok: false };
  return { required: true, ok: true };
}

function cookieHeader(request, token, maxAgeSeconds) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return (
    'chat_session=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(maxAgeSeconds) + secure
  );
}

function clearCookieHeader(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return 'chat_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + secure;
}

function clientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  );
}

async function throttleKey(env, request) {
  return FAIL_PREFIX + (await sha256Hex(clientIp(request))).slice(0, 20) + '.json';
}

/* ------------------------------------------------------------------ */
/* 路由处理                                                            */
/* ------------------------------------------------------------------ */

async function handleConfig(request, env) {
  const auth = await authState(env, request);
  const models = modelList(env);
  if (auth.required && !auth.ok) {
    return json({ needsAuth: true, authed: false, title: siteTitle(env) }, 401);
  }
  const missing = missingVars(env);
  return json({
    needsAuth: auth.required,
    authed: true,
    title: siteTitle(env),
    models,
    defaultModel: models[0].id,
    // 缺失的必填变量。前端据此显示醒目提示，避免用户对着 500 猜原因。
    missing,
    missingHint: missing.length ? VARS_FIX_HINT : '',
    endpointHost: (() => {
      try {
        return new URL(resolveEndpoint(env.API_URL)).host;
      } catch {
        return '';
      }
    })(),
  });
}

async function handleLogin(request, env) {
  if (request.method !== 'POST') return fail('方法不允许', 405, 'method_not_allowed');
  if (!env.ACCESS_PASSWORD) return json({ ok: true, authDisabled: true });

  const key = await throttleKey(env, request);
  const record = (await getJson(env, key)) || { count: 0, until: 0 };
  if (record.until && record.until > Date.now()) {
    const retryAfter = Math.ceil((record.until - Date.now()) / 1000);
    return json(
      { error: 'too_many_attempts', message: '尝试次数过多，请稍后再试', retryAfter },
      429,
      { 'Retry-After': String(retryAfter) }
    );
  }

  const body = await request.json().catch(() => null);
  const password = body && typeof body.password === 'string' ? body.password : '';
  const [given, expected] = await Promise.all([
    sha256Hex(password),
    sha256Hex(String(env.ACCESS_PASSWORD)),
  ]);

  if (!safeEqual(given, expected)) {
    const count = (record.count || 0) + 1;
    const next = { count, until: count >= LOGIN_MAX_FAILS ? Date.now() + LOGIN_WINDOW_MS : 0 };
    await putJson(env, key, next);
    const left = Math.max(0, LOGIN_MAX_FAILS - count);
    return fail(left > 0 ? '密码错误（还可尝试 ' + left + ' 次）' : '尝试次数过多，请 10 分钟后再试', 401, 'bad_password');
  }

  await deleteKey(env, key);
  const token = randomHex(24); // 48 位十六进制，与 authState 的格式校验一致
  await putJson(env, SESSION_PREFIX + token + '.json', { exp: Date.now() + SESSION_TTL_MS, createdAt: Date.now() });
  return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader(request, token, SESSION_TTL_MS / 1000) });
}

async function handleLogout(request, env) {
  const token = parseCookies(request)['chat_session'] || '';
  if (/^[a-f0-9]{48}$/.test(token)) await deleteKey(env, SESSION_PREFIX + token + '.json');
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookieHeader(request) });
}

async function listConversations(env) {
  const list = await readIndex(env);
  return json({ conversations: list });
}

async function createConversation(env) {
  const conv = newConversation('新对话');
  await saveConversation(env, conv);
  return json({ conversation: conv }, 201);
}

async function getConversation(env, id) {
  const conv = await getJson(env, CONV_PREFIX + id + '.json');
  if (!conv) return fail('会话不存在', 404, 'not_found');
  if (!Array.isArray(conv.messages)) conv.messages = [];
  return json({ conversation: conv });
}

async function renameConversation(request, env, id) {
  const conv = await getJson(env, CONV_PREFIX + id + '.json');
  if (!conv) return fail('会话不存在', 404, 'not_found');
  const body = await request.json().catch(() => null);
  const title = body && typeof body.title === 'string' ? body.title.trim().slice(0, 60) : '';
  if (!title) return fail('标题不能为空');
  conv.title = title;
  await saveConversation(env, conv);
  return json({ conversation: convMeta(conv) });
}

async function deleteConversation(env, id) {
  await deleteKey(env, CONV_PREFIX + id + '.json');
  const list = await readIndex(env);
  await writeIndex(
    env,
    list.filter((item) => !item || item.id !== id)
  );
  return json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* 聊天（SSE 流式）                                                    */
/* ------------------------------------------------------------------ */

function sse(payload) {
  return 'data: ' + JSON.stringify(payload) + '\n\n';
}

/** 从上游返回的 delta 里抽出文本，兼容字符串 / 数组 / 非流式 message 三种形态 */
function extractDelta(obj) {
  const choice = obj && Array.isArray(obj.choices) ? obj.choices[0] : null;
  if (!choice) return '';
  const delta = choice.delta;
  if (delta) {
    if (typeof delta.content === 'string') return delta.content;
    if (Array.isArray(delta.content)) {
      return delta.content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('');
    }
  }
  if (choice.message && typeof choice.message.content === 'string') return choice.message.content;
  return '';
}

async function handleChat(request, env, ctx) {
  const body = await request.json().catch(() => null);
  if (!body) return fail('请求体不是合法 JSON');

  const text = typeof body.message === 'string' ? body.message.trim() : '';
  if (!text) return fail('消息不能为空');
  if (text.length > MAX_MESSAGE_CHARS) return fail('消息过长（上限 ' + MAX_MESSAGE_CHARS + ' 字符）');

  const endpoint = resolveEndpoint(env.API_URL);
  if (!endpoint) return fail(missingVarsMessage(['API_URL']), 500, 'missing_api_url');
  if (!env.API_KEY) return fail(missingVarsMessage(['API_KEY']), 500, 'missing_api_key');

  // 载入或新建会话
  let conv = null;
  if (body.conversationId && /^[a-f0-9]{24}$/.test(String(body.conversationId))) {
    conv = await getJson(env, CONV_PREFIX + body.conversationId + '.json');
  }
  if (!conv) conv = newConversation(makeTitle(text));
  if (!Array.isArray(conv.messages)) conv.messages = [];

  // 重新生成：保留前 keepCount 条消息，再重新追加这条用户消息
  const keepCount = Number(body.keepCount);
  if (Number.isInteger(keepCount) && keepCount >= 0 && keepCount <= conv.messages.length) {
    conv.messages = conv.messages.slice(0, keepCount);
  }

  conv.messages.push({ role: 'user', content: text, ts: Date.now() });
  if (conv.messages.length === 1) conv.title = makeTitle(text);
  await saveConversation(env, conv); // 先把用户消息落盘，中断也不会丢

  // 只接受配置里出现过的模型 id，避免通过接口调用任意（可能更贵的）模型
  const models = modelList(env);
  const requested = body.model && typeof body.model === 'object' ? body.model.id : body.model;
  const picked = models.find((m) => m.id === String(requested == null ? '' : requested).trim());
  const model = (picked || models[0]).id;

  const upstreamMessages = [];
  const sys = systemPrompt(env);
  if (sys) upstreamMessages.push({ role: 'system', content: sys });
  for (const m of conv.messages) {
    if ((m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content) {
      upstreamMessages.push({ role: m.role, content: m.content });
    }
  }

  // 客户端断开时用它掐掉上游请求，别再白烧 token
  const upstreamCancel = new AbortController();

  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: 'Bearer ' + env.API_KEY,
      },
      body: JSON.stringify({ model, messages: upstreamMessages, stream: true }),
      signal: upstreamCancel.signal,
    });
  } catch (e) {
    return json(
      { error: 'upstream_unreachable', message: '无法连接上游接口：' + String((e && e.message) || e), conversationId: conv.id },
      502
    );
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return json(
      {
        error: 'upstream_error',
        message: '上游接口返回 ' + upstream.status + '：' + String(detail).slice(0, 400),
        conversationId: conv.id,
      },
      502
    );
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const convRef = conv;
  let buffer = '';
  let answer = '';
  let persisted = false;

  // 落盘助手回复。flush（正常结束）与 cancel（用户中途点停止 / 断开连接）都会走到这里，
  // 用 persisted 保证只写一次，避免重复追加。
  async function persist() {
    if (persisted) return;
    persisted = true;
    if (!answer.trim()) return;
    convRef.messages.push({ role: 'assistant', content: answer, ts: Date.now() });
    await saveConversation(env, convRef);
  }

  // waitUntil 必须在返回 Response【之前】登记：客户端断开之后再调 ctx.waitUntil，
  // 运行时已经不接受延长请求生命周期；而 cancel() 里直接 await 也不可靠——
  // 那时候 Worker 不再保证还活着，中断的回复就可能静默丢失。
  // 所以这里用一个 gate 把落盘挂到 waitUntil 上，等流真正结束（flush 或 cancel）再执行。
  // 正常路径由 flush 里的 await 先完成写入，persist() 的幂等标志会让这里变成空操作。
  let markSettled = () => {};
  const settled = new Promise((resolve) => { markSettled = resolve; });
  ctx.waitUntil(settled.then(() => persist()).catch(() => {}));

  const stream = new TransformStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(sse({ type: 'meta', conversationId: convRef.id, title: convRef.title, model }))
      );
    },

    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let obj;
        try {
          obj = JSON.parse(payload);
        } catch {
          continue;
        }

        if (obj && obj.error) {
          const msg = typeof obj.error === 'string' ? obj.error : obj.error.message || JSON.stringify(obj.error);
          controller.enqueue(encoder.encode(sse({ type: 'error', message: msg })));
          continue;
        }

        const piece = extractDelta(obj);
        if (!piece) continue;
        answer += piece;
        controller.enqueue(encoder.encode(sse({ type: 'delta', text: piece })));
      }
    },

    async flush(controller) {
      try {
        await persist();
      } catch (e) {
        controller.enqueue(encoder.encode(sse({ type: 'error', message: '保存失败：' + String((e && e.message) || e) })));
      }
      markSettled();
      controller.enqueue(
        encoder.encode(
          sse({
            type: 'done',
            conversationId: convRef.id,
            title: convRef.title,
            messageCount: convRef.messages.length,
          })
        )
      );
    },

    // 客户端主动中断（点「停止」或关闭页面）时保留已生成的部分。
    // 这里【不 await】落盘——连接已断，运行时不再等待这里的异步操作；
    // 交给上面登记的 waitUntil 去做。abort 上游是 best-effort：
    // 若运行时因管道未排空而暂不触发 cancel，这段流会随响应结束一并丢弃，不会泄漏。
    cancel() {
      markSettled();
      upstreamCancel.abort();
    },
  });

  return new Response(upstream.body.pipeThrough(stream), {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (!env.CHAT_BUCKET) {
        return json(
          {
            error: 'binding_missing',
            message: 'R2 绑定 CHAT_BUCKET 不存在。请确认 wrangler.jsonc 里的 r2_buckets 配置已生效并重新部署。',
          },
          500
        );
      }

      if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

      // 页面
      if (path === '/' || path === '/index.html') {
        return new Response(CHAT_HTML, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
        });
      }

      // 公开接口（无需登录）
      if (path === '/api/config') return handleConfig(request, env);
      if (path === '/api/login') return handleLogin(request, env);
      if (path === '/api/logout') return handleLogout(request, env);

      // 以下接口统一要求已登录（未配置 ACCESS_PASSWORD 时直接放行）
      const auth = await authState(env, request);
      if (!auth.ok) return fail('未登录或登录已过期', 401, 'unauthorized');

      if (path === '/api/conversations') {
        if (request.method === 'GET') return listConversations(env);
        if (request.method === 'POST') return createConversation(env);
        return fail('方法不允许', 405, 'method_not_allowed');
      }

      const match = path.match(/^\/api\/conversations\/([A-Za-z0-9_-]{1,64})$/);
      if (match) {
        const id = match[1];
        if (request.method === 'GET') return getConversation(env, id);
        if (request.method === 'PATCH') return renameConversation(request, env, id);
        if (request.method === 'DELETE') return deleteConversation(env, id);
        return fail('方法不允许', 405, 'method_not_allowed');
      }

      if (path === '/api/chat') {
        if (request.method !== 'POST') return fail('方法不允许', 405, 'method_not_allowed');
        return handleChat(request, env, ctx);
      }

      return fail('接口不存在', 404, 'not_found');
    } catch (e) {
      return json({ error: 'internal_error', message: String((e && e.message) || e) }, 500);
    }
  },
};
