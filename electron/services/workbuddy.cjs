const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ⚠️ 这是 WorkBuddy 中国大陆版（codebuddy.cn）的积分接口。
// 国际版（codebuddy.ai / 其它区域）域名与活动不同，需要另接。
const HOST = 'https://www.codebuddy.cn';
const BASE = `${HOST}/v2/billing/meter`;
const STATUS_URL = `${BASE}/checkin-activity-status`;
const CHECKIN_URL = `${BASE}/daily-checkin`;

// ⚠️ 积分余额走的是另一条网关路由：客户端源码里 billingPrefix 在桌面端被覆写成 "/v2"，
// 而 resourcePrefix 两端都是空串（老接口 get-user-resource 才需要 /v2）。
// 实测：加 /v2 一律 404，不加才 200。别"顺手统一"成 BASE。
const BALANCE_URL = `${HOST}/billing/meter/get-user-resource-summary`;

const ALREADY_SIGNED_CODE = 10001;

// ---------- 登录态定位 ----------
// WorkBuddy 桌面端把登录态明文存在用户目录下。历史上目录名换过几次
// （CodeBuddyExtension / WorkBuddy / CodeBuddy），不同版本可能落在不同位置，
// 所以这里按候选列表逐个试，全miss再兜底做一次有界扫描。
const APP_DIRS = ['CodeBuddyExtension', 'WorkBuddy', 'CodeBuddy', 'CodeBuddy-Desktop'];
const AUTH_TAIL = ['Data', 'Public', 'auth'];
const FILE_NAMES = ['workbuddy-desktop.info', 'codebuddy-desktop.info'];

function envRoots() {
  const home = os.homedir();
  const out = [];
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p);
  };
  push(process.env.LOCALAPPDATA);
  push(process.env.APPDATA);
  push(path.join(home, 'AppData', 'Local'));
  push(path.join(home, 'AppData', 'Roaming'));
  return out;
}

/** 按已知布局枚举候选路径（顺序即优先级） */
function candidatePaths() {
  const list = [];
  const roots = envRoots();
  for (const root of roots) {
    for (const dir of APP_DIRS) {
      for (const fn of FILE_NAMES) {
        list.push(path.join(root, dir, ...AUTH_TAIL, fn));
        list.push(path.join(root, dir, fn)); // 少数版本直接放在应用目录下
      }
    }
  }
  return list;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 客户端数据目录是否已存在 —— 用来区分「没装客户端」和「装了但没登录」 */
function dataDirExists() {
  return envRoots().some((root) =>
    APP_DIRS.some((dir) => isDir(path.join(root, dir, 'Data', 'Public')))
  );
}

/**
 * 兜底扫描：已知布局全 miss 时，在用户目录下浅层找形如 *desktop.info 且含 accessToken 的文件。
 * 有严格的深度/数量/耗时上限，避免在别人的机器上卡住启动。
 */
function deepSearch(skip) {
  const skipSet = new Set(skip);
  const SKIP_DIRS = new Set([
    'node_modules',
    'cache',
    'cacheddata',
    'gpucache',
    'code cache',
    'logs',
    'temp',
    'tmp',
    'crashpad',
    'service worker',
    'blob_storage',
  ]);
  const MAX_DEPTH = 5;
  const MAX_DIRS = 8000;
  const DEADLINE = Date.now() + 3000;
  let visited = 0;

  for (const root of envRoots()) {
    if (!isDir(root)) continue;
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length) {
      if (visited++ > MAX_DIRS || Date.now() > DEADLINE) return null;
      const { dir, depth } = queue.shift();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (depth < MAX_DEPTH && !SKIP_DIRS.has(ent.name.toLowerCase())) {
            queue.push({ dir: full, depth: depth + 1 });
          }
          continue;
        }
        if (!/\.info$/i.test(ent.name)) continue;
        if (skipSet.has(full)) continue;
        if (!/desktop/i.test(ent.name)) continue;
        try {
          const head = fs.readFileSync(full, 'utf8');
          if (head.includes('accessToken')) return full;
        } catch {
          /* 读不了就跳过 */
        }
      }
    }
  }
  return null;
}

let located = null;

/** 解析登录态文件位置，结果进程内缓存；refresh=true 时重新探测 */
function locate({ refresh = false } = {}) {
  if (located && !refresh) return located;
  const searched = candidatePaths();
  let file = null;
  let source = 'none';
  for (const p of searched) {
    if (isFile(p)) {
      file = p;
      source = 'known';
      break;
    }
  }
  if (!file) {
    const found = deepSearch(searched);
    if (found) {
      file = found;
      source = 'search';
    }
  }
  located = { file, source, searched };
  return located;
}

/** 供界面展示用：找到就返回实际路径，没找到则回落到首选默认路径 */
function tokenFilePath() {
  return locate().file || candidatePaths()[0] || '';
}

// 只读登录态，绝不回写；token 由 WorkBuddy 客户端自己维护刷新
function readAuth({ refresh = false } = {}) {
  const { file, source, searched } = locate({ refresh });
  if (!file) {
    return {
      ok: false,
      reason: 'no-file',
      message: dataDirExists()
        ? '检测到 WorkBuddy 客户端数据，但未找到登录态。请在客户端里完成登录后再点「重新检测」。'
        : '未检测到 WorkBuddy 登录态。请先在本机安装并登录 WorkBuddy 客户端。',
      file: null,
      searched,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return {
      ok: false,
      reason: 'bad-file',
      message: e.code === 'ENOENT' ? '登录态文件已消失，请重新检测' : '登录态文件无法解析',
      file,
      searched,
    };
  }

  const auth = parsed.auth || {};
  const token = auth.accessToken || parsed.accessToken;
  if (!token) {
    return {
      ok: false,
      reason: 'no-token',
      message: '登录态中缺少 accessToken，请在 WorkBuddy 客户端重新登录',
      file,
      searched,
    };
  }

  const expiresAt = Number(auth.expiresAt) || null;
  const refreshExpiresAt = Number(auth.refreshExpiresAt) || null;
  const expired = expiresAt ? Date.now() >= expiresAt : false;
  const account = parsed.account || {};
  return {
    ok: true,
    file,
    source,
    searched,
    token,
    nickname: account.nickname || null,
    uid: account.uid || null,
    uin: account.uin || null,
    accountType: account.type || null,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    expiresInDays: expiresAt ? Math.floor((expiresAt - Date.now()) / 86400000) : null,
    refreshExpiresAt: refreshExpiresAt ? new Date(refreshExpiresAt).toISOString() : null,
    refreshInDays: refreshExpiresAt
      ? Math.floor((refreshExpiresAt - Date.now()) / 86400000)
      : null,
    expired,
  };
}

/** 诊断信息：给界面用，说明「当前关联的是哪个账号 / 去哪些地方找过登录态」 */
function diagnose({ refresh = false } = {}) {
  const auth = readAuth({ refresh });
  const searched = auth.searched || locate({ refresh }).searched;
  return {
    linked: Boolean(auth.ok),
    reason: auth.ok ? null : auth.reason,
    message: auth.ok ? null : auth.message,
    file: auth.file || null,
    source: auth.source || (auth.ok ? undefined : 'none'),
    dataDirExists: dataDirExists(),
    apiHost: BASE.replace(/\/v2\/.*$/, ''),
    searchedCount: searched.length,
    // 只回传前若干条，避免界面被长列表撑爆
    searched: searched.slice(0, 12),
    nickname: auth.nickname ?? null,
    uid: auth.uid ?? null,
    uin: auth.uin ?? null,
    accountType: auth.accountType ?? null,
    expiresAt: auth.expiresAt ?? null,
    expiresInDays: auth.expiresInDays ?? null,
    refreshInDays: auth.refreshInDays ?? null,
    expired: auth.expired ?? null,
  };
}

async function call(url, token, { timeoutMs = 15000, headers = {}, body = '{}' } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...headers,
      },
      body,
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 保留原文 */
    }
    return { httpStatus: res.status, json, text };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      error: aborted ? 'timeout' : 'network',
      message: aborted ? '请求超时' : `网络错误：${err?.message || err}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 计费类接口统一带的头：桌面端源码里会带 X-User-Id，缺了可能被网关判成匿名 */
function authHeaders(auth) {
  const headers = {};
  if (auth?.uid) headers['X-User-Id'] = auth.uid;
  if (auth?.accountType) headers['X-Account-Type'] = auth.accountType;
  return headers;
}

/** 金额/容量字段服务端给的是字符串，且可能是 "6533.99000103" 这种长小数 */
function toCapacity(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 积分余额。
 *
 * 返回结构（与客户端 parseResourceSummary / sumSummaryCapacity 同口径）：
 *   Packages[] 里每个包有 总容量 / 剩余 / 已用，按包求和得到账户级余额。
 * 注意：这里的「积分」是花额度用的 credits，跟签到活动返回的 total_credits
 * （活动期内的累计签到分）不是同一个东西 —— 后者只统计本次活动。
 */
async function getBalance() {
  const auth = readAuth();
  if (!auth.ok) return auth;

  const started = Date.now();
  const res = await call(BALANCE_URL, auth.token, { headers: authHeaders(auth) });
  if (res.error) return { ok: false, reason: res.error, message: res.message };
  if (res.httpStatus === 401 || res.httpStatus === 403) {
    return {
      ok: false,
      reason: 'expired',
      message: '登录态已过期，请打开 WorkBuddy 客户端重新登录（客户端会自动续期）',
    };
  }
  if (!res.json) {
    return { ok: false, reason: 'parse', message: '余额接口返回非 JSON', raw: res.text.slice(0, 500) };
  }
  if (res.json.code !== 0) {
    return {
      ok: false,
      reason: 'api',
      message: res.json.msg || `接口返回 code=${res.json.code}`,
      raw: res.text.slice(0, 500),
    };
  }

  const data = res.json.data || {};
  const rawPackages = Array.isArray(data.Packages) ? data.Packages : [];
  const packages = rawPackages.map((item) => ({
    packageCode: item?.PackageCode || '',
    total: toCapacity(item?.CycleTotalCapacity),
    remain: toCapacity(item?.CycleRemainCapacity),
    used: toCapacity(item?.CycleUsedCapacity),
    frozen: toCapacity(item?.CycleFrozenCapacity),
    unit: item?.CapacityUnit || 'credits',
    count: Number(item?.TotalCount) || 0,
  }));

  // 累加口径照抄客户端：只累加 > 0 的值，负数/NaN 当 0，避免脏数据把余额拉低
  let total = 0;
  let left = 0;
  let used = 0;
  for (const p of packages) {
    if (p.total > 0) total += p.total;
    if (p.remain > 0) left += p.remain;
    if (p.used > 0) used += p.used;
  }

  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    account: { nickname: auth.nickname, uid: auth.uid, uin: auth.uin },
    credits: {
      unit: packages[0]?.unit || 'credits',
      total,
      remain: left,
      used,
      usedPct: total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0,
    },
    packages,
    isPaidUser: Boolean(data.IsPaidUser),
    subscriptionPackageCode: data.SubscriptionPackageCode || '',
  };
}

function mapStatusPayload(data) {
  if (!data) return null;
  return {
    active: data.active !== false,
    todayCheckedIn: Boolean(data.today_checked_in),
    streakDays: Number(data.streak_days) || 0,
    dailyCredit: Number(data.daily_credit) || 0,
    todayCredit: Number(data.today_credit) || 0,
    totalCredits: Number(data.total_credits) || 0,
    weekCheckinDays: Number(data.week_checkin_days) || 0,
    weekProgress: Array.isArray(data.week_progress) ? data.week_progress : [],
    // 服务端的 week_progress 索引口径不明（实测首日为 true 但当天是周一），
    // 因此额外返回真实签到日期，由前端自行推算周视图，避免画错。
    checkinDates: Array.isArray(data.checkin_dates) ? data.checkin_dates : [],
    periodStart: data.start_time || null,
    periodEnd: data.end_time || null,
    activityName: data.activity_name || data.theme_name || null,
    season: data.season ?? null,
    claimButtonText: data.claim_button_text || null,
    actionButton: data.action_button || null,
  };
}

async function getStatus(opts = {}) {
  const auth = readAuth(opts);
  if (!auth.ok) return auth;

  const res = await call(STATUS_URL, auth.token, { headers: authHeaders(auth) });
  if (res.error) return { ok: false, reason: res.error, message: res.message };
  if (res.httpStatus === 401 || res.httpStatus === 403) {
    return {
      ok: false,
      reason: 'expired',
      message: '登录态已过期，请打开 WorkBuddy 客户端重新登录（客户端会自动续期）',
    };
  }
  if (!res.json) {
    return { ok: false, reason: 'parse', message: '状态接口返回非 JSON', raw: res.text.slice(0, 500) };
  }
  if (res.json.code !== 0) {
    return {
      ok: false,
      reason: 'api',
      message: res.json.msg || `接口返回 code=${res.json.code}`,
      raw: res.text.slice(0, 500),
    };
  }
  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    account: { nickname: auth.nickname, uid: auth.uid, uin: auth.uin },
    tokenExpiresAt: auth.expiresAt,
    tokenExpiresInDays: auth.expiresInDays,
    status: mapStatusPayload(res.json.data),
  };
}

async function claim() {
  const auth = readAuth();
  if (!auth.ok) return auth;

  const res = await call(CHECKIN_URL, auth.token, { headers: authHeaders(auth) });
  if (res.error) return { ok: false, reason: res.error, message: res.message };
  if (res.httpStatus === 401 || res.httpStatus === 403) {
    return {
      ok: false,
      reason: 'expired',
      message: '登录态已过期，请打开 WorkBuddy 客户端重新登录（客户端会自动续期）',
    };
  }
  if (!res.json) {
    return { ok: false, reason: 'parse', message: '签到接口返回非 JSON', raw: res.text.slice(0, 500) };
  }

  const code = res.json.code;
  if (code === 0) {
    // 领取成功后再拉一次状态，拿到最新的连续天数与总积分
    const after = await getStatus();
    return {
      ok: true,
      action: 'claimed',
      message: res.json.msg || '领取成功',
      status: after.ok ? after.status : null,
    };
  }
  if (code === ALREADY_SIGNED_CODE) {
    const after = await getStatus();
    return {
      ok: true,
      action: 'skip_already_signed',
      message: res.json.msg || '今天已签到',
      status: after.ok ? after.status : null,
    };
  }
  return {
    ok: false,
    reason: 'api',
    message: res.json.msg || `接口返回 code=${code}`,
    raw: res.text.slice(0, 500),
  };
}

module.exports = {
  getStatus,
  claim,
  getBalance,
  readAuth,
  diagnose,
  tokenFilePath,
  locate,
  candidatePaths,
  dataDirExists,
  STATUS_URL,
  CHECKIN_URL,
  BALANCE_URL,
  API_HOST: HOST,
};
