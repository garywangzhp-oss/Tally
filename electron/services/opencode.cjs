const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

// Cloudflare 前置校验：UA 不合规会直接 403 error code: 1010，必须伪装成浏览器
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// 真实接口只返回 percent（已用百分比），没有金额字段，这里的 usd 仅作折算基准。
//
// 2026-11 核对官方 Go 文档（opencode.ai/docs/go）：$10/月这一档，DeepSeek V4.1 Flash
// 月额度 $100，且「5 小时 = 月额度 20%、每周 = 50%、每月 = 100%」——所以是
// $20 / $50 / $100。此前写的 $12/$30/$60 对应的是 Operation Cheepseek 第二阶段，
// 已过期（第四阶段把额度从 $60 抬到 $100），照旧值折算会把花费低估约 40%。
//
// ⚠️ 两个前提：① 只对 Go（$10）成立，Go Plus（$40）月额度 $200，这三个数要翻倍；
// ② OpenCode 的额度是**按模型分别计算**的，接口给的是当前生效模型的百分比。
// 若改用 GLM-5.3-Flash（$60）或 Kimi K3（$15），基准并不一样。
const PLAN_LIMITS = {
  fiveHour: { usd: 20, label: '5 小时' },
  week: { usd: 50, label: '本周' },
  month: { usd: 100, label: '本月' },
};

// 实测 2026-09-21，接口返回形如：
// {"usage":{"rolling":{"status":"ok","percent":8,"resetsAt":"..."},
//           "weekly":{...},"monthly":{...}}}
// percent 是「已用」百分比（对照官方 console 的 "Monthly Usage 70.2%" 措辞确认）。
// 注意顺序：weekly 不含 "rolling"，monthly 不含 "week"，所以不会互相误匹配。
const WINDOW_MATCHERS = [
  { key: 'fiveHour', test: /five.?hour|^5h$|rolling|session/i },
  { key: 'week', test: /week|^7d$/i },
  { key: 'month', test: /month|^30d$/i },
];

const MICRO = 1e8; // micro-cents -> USD

function numFrom(obj, names) {
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase();
    if (!names.some((n) => lk === n.toLowerCase())) continue;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (v && typeof v === 'object' && typeof v.value === 'number') return v.value;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

function extractWindow(obj) {
  const limitMicro = numFrom(obj, ['limitMicroCents', 'limit_micro_cents', 'limitMicrocents']);
  const usedMicro = numFrom(obj, ['usedMicroCents', 'used_micro_cents', 'usedMicrocents']);
  const limitUsd = numFrom(obj, ['limitUsd', 'limit_usd', 'limitDollars']);
  const usedUsd = numFrom(obj, ['usedUsd', 'used_usd', 'usedDollars']);
  const remainingPercent = numFrom(obj, ['remainingPercent', 'remaining_percent', 'remainingPct']);
  const usedPercent = numFrom(obj, ['usagePercent', 'usedPercent', 'used_percent', 'percent', 'pct']);
  const resetInSec = numFrom(obj, ['resetInSec', 'reset_in_sec', 'resetInSeconds', 'resetsInSec']);
  const resetsAt = obj.resetsAt ?? obj.resets_at ?? obj.resetAt ?? obj.reset_at ?? null;

  let limit = null;
  let used = null;
  if (typeof limitMicro === 'number' && typeof usedMicro === 'number') {
    limit = limitMicro / MICRO;
    used = usedMicro / MICRO;
  } else if (typeof limitUsd === 'number' && typeof usedUsd === 'number') {
    limit = limitUsd;
    used = usedUsd;
  }

  let usedPct = null;
  if (typeof usedPercent === 'number') usedPct = usedPercent;
  else if (typeof remainingPercent === 'number') usedPct = 100 - remainingPercent;
  else if (limit !== null && used !== null && limit > 0) usedPct = (used / limit) * 100;

  const hasAnything =
    limit !== null || usedPct !== null || resetInSec !== undefined || resetsAt != null;
  if (!hasAnything) return null;

  if (limit === null && usedPct !== null) usedPct = clampPct(usedPct);
  if (limit === null && usedPct !== null) used = null;
  if (limit !== null && usedPct !== null) usedPct = clampPct(usedPct);

  return {
    limit,
    used,
    remaining: limit !== null && used !== null ? Math.max(0, limit - used) : null,
    usedPct,
    remainingPct: usedPct === null ? null : Math.max(0, 100 - usedPct),
    resetInSec: typeof resetInSec === 'number' ? resetInSec : null,
    resetsAt: normalizeTime(resetsAt),
    status: typeof obj.status === 'string' ? obj.status : null,
  };
}

function clampPct(v) {
  return Math.max(0, Math.min(100, v));
}

function normalizeTime(v) {
  if (v == null) return null;
  if (typeof v === 'number') {
    // 秒级时间戳与毫秒级时间戳都兼容
    return new Date(v > 1e12 ? v : v * 1000).toISOString();
  }
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function collectWindows(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return out;
  if (Array.isArray(node)) {
    node.forEach((n) => collectWindows(n, out, depth + 1));
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') {
      const win = extractWindow(v);
      if (win) {
        out.push({ name: k, win });
      }
      collectWindows(v, out, depth + 1);
    }
  }
  return out;
}

function matchWindowKey(name, obj) {
  const haystack = `${name} ${Object.keys(obj || {}).join(' ')}`;
  for (const m of WINDOW_MATCHERS) if (m.test.test(haystack)) return m.key;
  return null;
}

function normalize(raw) {
  const found = collectWindows(raw, []);
  const byKey = {};
  for (const { name, win } of found) {
    const key = matchWindowKey(name, null);
    if (key && !byKey[key]) byKey[key] = win;
  }
  // 兜底：按 5h -> week -> month 的顺序把未识别窗口顺位填入
  if (!byKey.fiveHour || !byKey.week || !byKey.month) {
    const order = ['fiveHour', 'week', 'month'];
    const used = new Set(Object.values(byKey));
    const leftovers = found.map((f) => f.win).filter((w) => !used.has(w));
    for (const k of order) {
      if (!byKey[k] && leftovers.length) byKey[k] = leftovers.shift();
    }
  }

  const windows = Object.entries(PLAN_LIMITS).map(([key, meta]) => {
    const win = byKey[key] || null;
    let limit = win?.limit ?? null;
    let used = win?.used ?? null;
    let derived = false;

    // 接口只给百分比时，按套餐基准额度折算金额，并标记 derived 让 UI 用 ≈ 呈现（不是接口原值）
    if (limit === null && win?.usedPct != null) {
      limit = meta.usd;
      used = Math.round(meta.usd * win.usedPct) / 100;
      derived = true;
    }
    const remaining = limit !== null && used !== null ? Math.max(0, limit - used) : null;

    return {
      key,
      label: meta.label,
      planUsd: meta.usd,
      limit,
      used,
      remaining,
      derived,
      usedPct: win?.usedPct ?? null,
      remainingPct: win?.remainingPct ?? null,
      resetInSec: win?.resetInSec ?? null,
      resetsAt: win?.resetsAt ?? null,
      status: win?.status ?? null,
      detected: Boolean(win),
    };
  });

  return { windows, recognized: found.length };
}

async function fetchUsage(apiKey, { timeoutMs = 15000 } = {}) {
  if (!apiKey) {
    return { ok: false, reason: 'no-key', message: '未配置 OpenCode Go API Key' };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': BROWSER_UA,
        Accept: 'application/json, text/plain, */*',
      },
      signal: ac.signal,
    });
    const text = await res.text();

    if (res.status === 401 || res.status === 403) {
      let msg = 'API Key 无效或已失效';
      if (text.includes('Missing API key')) msg = '请求未携带 API Key';
      else if (text.includes('1010')) msg = '被 Cloudflare 拦截（UA 校验失败）';
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

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        ok: false,
        reason: 'parse',
        message: '响应不是合法 JSON，接口结构可能已变更',
        raw: text.slice(0, 800),
      };
    }

    const normalized = normalize(json);
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      windows: normalized.windows,
      recognized: normalized.recognized,
      raw: JSON.stringify(json).slice(0, 4000),
    };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      reason: aborted ? 'timeout' : 'network',
      message: aborted ? '请求超时' : `网络错误：${err?.message || err}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchUsage, USAGE_URL, BROWSER_UA, PLAN_LIMITS, normalize };
