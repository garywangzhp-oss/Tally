/**
 * commandcode 额度查询服务。
 *
 * 接口来源（2026-10-07 实测定稿）：官方文档没写，是从 Studio 前端 chunk
 * （constants-fZ8pgs-W.js）的路由表里挖出来的，并用真实 Key 200 实测通过。
 *
 *   GET https://api.commandcode.ai/alpha/billing/credits     ← 主接口（额度 + 窗口）
 *   GET https://api.commandcode.ai/alpha/billing/subscriptions ← 套餐/周期（可选）
 *   GET https://api.commandcode.ai/alpha/usage/summary       ← 用量统计（暂未用）
 *
 * 鉴权：`Authorization: Bearer <API Key>`（Key 即 CLI 用的那个，settings/api 生成）。
 * ⚠️ Studio 网页自己走的是 `/internal/*`（Cookie 制），不要用那套；
 *    `/alpha/*` 才是给 Key 用的，两者 401 文案不同可据此分辨。
 *
 * 真实响应（2026-10-07 实测，Go v1 套餐）：
 *   {
 *     "credits": { "belowThreshold":false, "creditThreshold":0,
 *                  "monthlyCredits":10, "purchasedCredits":0, "freeCredits":0 },
 *     "windowLimits": {
 *       "limited": true, "exceeded": null,
 *       "fiveHour": { "used":0, "cap":3, "exceeded":false, "resetAt":0 },
 *       "weekly":   { "used":0, "cap":6, "exceeded":false, "resetAt":0 }
 *     },
 *     "sandboxAccess": false, "sandboxMinutes": null
 *   }
 *
 * 关键点：**接口直接给 used / cap 的美元数字**，不需要按套餐折算（不像 OpenCode 只给百分比）。
 * 只有两个滚动窗口：5 小时 + 周。月度额度是「每计费周期初重置」，不是滚动窗口。
 * resetAt 为 0 表示窗口尚未开启（还没用过）。
 */

const API_BASE = 'https://api.commandcode.ai';
const CREDITS_URL = `${API_BASE}/alpha/billing/credits`;
const SUBS_URL = `${API_BASE}/alpha/billing/subscriptions`;
const SUMMARY_URL = `${API_BASE}/alpha/usage/summary`;

// 伪装成浏览器，避免被前置校验拦掉
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// 两档滚动窗口（键 ↔ 接口字段一一对应，不再需要猜键名）
const WINDOW_DEFS = [
  { key: 'fiveHour', field: 'fiveHour', label: '5 小时' },
  { key: 'week', field: 'weekly', label: '本周' },
];

function clampPct(v) {
  return Math.max(0, Math.min(100, v));
}

/**
 * resetAt 兼容多种形态：0/null 表示窗口未开启；秒级或毫秒级时间戳；ISO 字符串。
 * 返回 { resetsAt, resetInSec }。
 */
function parseReset(v) {
  if (v == null || v === 0) return { resetsAt: null, resetInSec: null };
  let ms = null;
  if (typeof v === 'number') ms = v > 1e12 ? v : v * 1000;
  else {
    const t = Date.parse(String(v));
    if (!Number.isNaN(t)) ms = t;
  }
  if (ms == null) return { resetsAt: null, resetInSec: null };
  const iso = new Date(ms).toISOString();
  const sec = Math.max(0, Math.round((ms - Date.now()) / 1000));
  return { resetsAt: iso, resetInSec: sec };
}

/** 把接口响应规整成 UI 需要的 windows 结构（与开放平台那套 QuotaWindow 对齐） */
function normalize(raw) {
  const credits = raw?.credits || {};
  const limits = raw?.windowLimits || {};

  const windows = WINDOW_DEFS.map(({ key, field, label }) => {
    const w = limits[field] || null;
    const used = typeof w?.used === 'number' ? w.used : null;
    const limit = typeof w?.cap === 'number' ? w.cap : null;
    const { resetsAt, resetInSec } = parseReset(w?.resetAt);

    let usedPct = null;
    if (used != null && limit != null && limit > 0) usedPct = clampPct((used / limit) * 100);
    else if (limit === 0) usedPct = 0;

    const remaining = used != null && limit != null ? Math.max(0, limit - used) : null;

    return {
      key,
      label,
      planUsd: limit ?? 0,
      limit,
      used,
      remaining,
      // 接口直接给金额，不需要折算
      derived: false,
      usedPct,
      remainingPct: usedPct === null ? null : Math.max(0, 100 - usedPct),
      resetInSec,
      resetsAt,
      status: w?.exceeded === true ? 'exceeded' : 'ok',
      detected: Boolean(w),
    };
  });

  // 月度额度单独摘出来（不进 windows，作为顶部汇总用）
  const summary = {
    monthlyCredits: typeof credits.monthlyCredits === 'number' ? credits.monthlyCredits : null,
    purchasedCredits:
      typeof credits.purchasedCredits === 'number' ? credits.purchasedCredits : null,
    freeCredits: typeof credits.freeCredits === 'number' ? credits.freeCredits : null,
    belowThreshold: Boolean(credits.belowThreshold),
  };

  return { windows, summary, recognized: windows.filter((w) => w.detected).length };
}

/** 解析订阅信息（套餐名 + 本周期结束时间），失败不影响主流程 */
function normalizeSubscription(raw) {
  const d = raw?.data;
  if (!d || typeof d !== 'object') return null;
  return {
    planId: typeof d.planId === 'string' ? d.planId : null,
    status: typeof d.status === 'string' ? d.status : null,
    currentPeriodEnd: typeof d.currentPeriodEnd === 'string' ? d.currentPeriodEnd : null,
    cancelAtPeriodEnd: Boolean(d.cancelAtPeriodEnd),
  };
}

/** 把 planId 变成人话：individual-go-v1 → Go（v1） */
function planLabel(planId) {
  if (!planId) return null;
  const m = /^individual-(goat|go|pro|max|provider|ultra)(?:-(v\d+))?$/.exec(planId);
  if (!m) return planId;
  const name = m[1].toUpperCase() === 'GOAT' ? 'GOAT' : m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return m[2] ? `${name}（${m[2]}）` : name;
}

async function getJson(url, apiKey, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': BROWSER_UA,
        Accept: 'application/json, text/plain, */*',
      },
      signal: ac.signal,
    });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取 token 汇总（给本地用量采集用）。
 * 注意：这是 **billing-period 累计值**（当前计费周期从一开始到现在），不是按日拆分的时序，
 * 所以只能「每天记一条 → 相邻两天做差」得到当天用量，见 usage-history.cjs。
 *
 * 响应样例（2026-10-07 实测，全 0 是因为当天还没跑过请求）：
 *   {"totalCount":0,"totalCost":0,"averageCost":0,"successRate":0,
 *    "completedCount":0,"failedCount":0,"totalTokensIn":0,"totalTokensOut":0,
 *    "totalTokens":0,"totalCredits":0,"periodBasis":"billing-period"}
 */
async function fetchTokenSummary(apiKey, { timeoutMs = 15000 } = {}) {
  if (!apiKey) return { ok: false, reason: 'no-key' };
  try {
    const { res, text } = await getJson(SUMMARY_URL, apiKey, timeoutMs);
    if (!res.ok) return { ok: false, reason: 'http', status: res.status };
    const j = JSON.parse(text);
    const num = (k) => (typeof j?.[k] === 'number' ? j[k] : null);
    // 用 totalTokens（in+out 合计）；拿不到就现算
    const total = num('totalTokens') ?? (num('totalTokensIn') || 0) + (num('totalTokensOut') || 0);
    return {
      ok: true,
      tokens: total || 0,
      tokensIn: num('totalTokensIn'),
      tokensOut: num('totalTokensOut'),
      costUsd: num('totalCost'),
      requests: num('totalCount'),
      periodBasis: typeof j?.periodBasis === 'string' ? j.periodBasis : null,
    };
  } catch (err) {
    return { ok: false, reason: err?.name === 'AbortError' ? 'timeout' : 'network' };
  }
}

async function fetchUsage(apiKey, { timeoutMs = 15000 } = {}) {
  if (!apiKey) {
    return { ok: false, reason: 'no-key', message: '未配置 commandcode API Key' };
  }

  let payload;
  try {
    const { res, text } = await getJson(CREDITS_URL, apiKey, timeoutMs);
    if (res.status === 401 || res.status === 403) {
      let msg = 'API Key 无效或已失效';
      if (text.includes('Invalid') && text.includes('Authorization')) msg = 'API Key 无效或已失效';
      else if (text.includes('logged out')) msg = '登录态已失效（该接口需要 API Key，不是 Cookie）';
      return { ok: false, reason: 'auth', message: msg, status: res.status, raw: text.slice(0, 800) };
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: 'http',
        message: `接口返回 HTTP ${res.status}`,
        status: res.status,
        raw: text.slice(0, 800),
      };
    }
    try {
      payload = JSON.parse(text);
    } catch {
      return {
        ok: false,
        reason: 'parse',
        message: '响应不是合法 JSON，接口结构可能已变更',
        raw: text.slice(0, 800),
      };
    }
    payload.__raw = text.slice(0, 4000);
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      reason: aborted ? 'timeout' : 'network',
      message: aborted ? '请求超时' : `网络错误：${err?.message || err}`,
    };
  }

  const normalized = normalize(payload);

  // 订阅信息是附加项：拿不到也算成功，只是少显示套餐名
  let plan = null;
  try {
    const { res, text } = await getJson(SUBS_URL, apiKey, timeoutMs);
    if (res.ok) plan = normalizeSubscription(JSON.parse(text));
  } catch {
    /* 忽略 */
  }

  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    windows: normalized.windows,
    summary: normalized.summary,
    plan: plan ? { ...plan, label: planLabel(plan.planId) } : null,
    recognized: normalized.recognized,
    raw: payload.__raw,
  };
}

module.exports = {
  fetchUsage,
  fetchTokenSummary,
  normalize,
  normalizeSubscription,
  planLabel,
  CREDITS_URL,
  SUBS_URL,
  SUMMARY_URL,
  API_BASE,
  BROWSER_UA,
};
