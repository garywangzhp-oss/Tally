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

// ---------- at-rest-crypto 加密字段兼容（2026-09-26 实证） ----------
// ⚠️ 新版 WorkBuddy 桌面端把登录态里的敏感字段从**明文**改成了密文包装：
//     { "$wbEncrypted": 1, "envelope": "<base64>" }
// 涉及 account.nickname / account.phoneNumber / **auth.accessToken / auth.refreshToken**。
// envelope 解出来是 { suite:1, keyId, nonce, authTag, ciphertext }（AES-256-GCM 参数），
// 但 keyId 对应的密钥在客户端原生模块里（`deriveAtRestKeyId` 走 process_cpu_sampler 绑定），
// 纯 JS 拿不到 —— 所以这里**只做安全降级，不尝试解密**。
//
// 血泪教训：**对象绝不能交给渲染层**。原来写 `nickname: account.nickname || null`，
// 密文对象是 truthy，被原样送进 React 子节点 → React error #31
// （Objects are not valid as a React child）→ 整棵渲染树崩掉 → 窗口变成全透明：
// 进程都在、窗口也在桌面上，但用户什么都看不见，表现为「双击没反应 / 打不开」。
// 所以凡是往界面回传的字段，一律先过 asText()。
function isEncryptedField(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return v.$wbEncrypted === 1 || typeof v.envelope === 'string';
}

/** 只放行字符串；对象 / 数字 / 数组 / 密文包装一律返回 null（界面据此显示「—」） */
function asText(v) {
  return typeof v === 'string' ? v : null;
}

// ---------- 凭据回退：客户端迁移留档（2026-09-26 实证） ----------
//
// ⚠️ 为什么需要这条回退：
// WorkBuddy 桌面端新版把敏感字段换成了 at-rest-crypto 密文包装
//   { $wbEncrypted: 1, envelope: base64({suite,keyId,nonce,authTag,ciphertext}) }
// 算法本身是 AES-256-GCM（非机密），但**密钥是编译期静态密钥**，由客户端原生模块
// `electron.workbuddyStorage.loggerGet()` 提供（主进程 bootstrap 里
//  `loadMainCredentialProtectionBootstrap(policy, () => electron.workbuddyStorage.loggerGet(), …)`
//  → normalizeAtRestKeyPayload → key = sha256(atRestSecretKey) → keyId = sha256(key).hex[:16]）。
// 实测本机 auth 文件的 keyId = 9127dea1b44020a7，正落在客户端 keyblob 的
// protectorKeyId 上 —— 也就是说，没有那份静态密钥就**解不开**。OIDC 的 refresh 端点
// 需要 client 凭据（401 invalid_client），也走不通。
//
// 但客户端做登录态迁移时会**把迁移前的旧文件原样改名留档**：
//   workbuddy-desktop.<ISO时间戳>.<pid>.<uuid>.info
// 留档是**迁移前的明文格式**。实测本机 2026-09-11 那份留档里 accessToken 仍是明文 JWT，
// 拿它调签到 / 余额两个接口都是 200。所以：当前文件给不出明文时，回退到留档。
//
// 安全边界不变：**只读**，不回写、不复制、不外传，token 只留在内存里。
// 留档命名：workbuddy-desktop.<ISO时间戳>.<pid>.<uuid>.info（pid / uuid 段可能缺席，用 * 兼容）
const BACKUP_RE = /^workbuddy-desktop\.\d{4}-\d{2}-\d{2}T[\d-]+Z(\.[0-9a-f-]+)*\.info$/i;

/** 不空转 CPU 的同步 sleep（主进程里读文件失败要短暂等待重试） */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 极老环境不支持就算了，直接返回 */
  }
}

/**
 * 读取登录态文件（带短重试）。
 * 客户端每次刷新 token 都会**整体重写**这个文件，重写窗口内 open() 会拿到
 * EPERM / EACCES / EBUSY（实测同一时刻纯 Node 读得到、Electron 读不到），
 * 表现成「文件无法解析」，其实内容没坏 —— 别让用户去重装客户端。
 */
function readTextRetry(file, attempts = 4, gapMs = 45) {
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return { text: fs.readFileSync(file, 'utf8'), error: null };
    } catch (e) {
      lastErr = e;
      const transient =
        e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY' || e.code === 'ENOENT';
      if (!transient) break;
    }
    if (i < attempts - 1) sleepSync(gapMs * (i + 1));
  }
  return { text: null, error: lastErr };
}

/** 列出同目录下的迁移留档（按修改时间倒序） */
function rotationBackups(dir, excludeFile) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => BACKUP_RE.test(n))
    .map((n) => path.join(dir, n))
    .filter((p) => p !== excludeFile)
    .map((p) => {
      let m = 0;
      try {
        m = fs.statSync(p).mtimeMs;
      } catch {
        /* 读不到就排最后 */
      }
      return { p, m };
    })
    .sort((a, b) => b.m - a.m)
    .map((x) => x.p);
}

/**
 * 在留档里找一份**仍有效**的明文 token（最新优先）。
 * 只接受「未过期 + 明文 + uid 与当前账号一致」的留档，宁可不可用也不串号。
 */
function readPlaintextBackup(dir, excludeFile, currentUid) {
  for (const p of rotationBackups(dir, excludeFile)) {
    const { text } = readTextRetry(p, 2, 20);
    if (!text) continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const auth = parsed && parsed.auth && typeof parsed.auth === 'object' ? parsed.auth : {};
    const token = asText(auth.accessToken ?? parsed.accessToken);
    if (!token) continue;
    const expiresAt = Number(auth.expiresAt) || null;
    if (expiresAt && Date.now() >= expiresAt) continue;
    const acct = parsed.account && typeof parsed.account === 'object' ? parsed.account : {};
    const uid = asText(acct.uid);
    if (currentUid && uid && uid !== currentUid) continue; // 别拿另一个账号的凭据
    return {
      token,
      refreshToken: asText(auth.refreshToken),
      file: p,
      expiresAt,
      refreshExpiresAt: Number(auth.refreshExpiresAt) || null,
      identity: {
        nickname: asText(acct.nickname),
        uid: uid || currentUid || null,
        uin: asText(acct.uin),
        accountType: asText(acct.type),
      },
    };
  }
  return null;
}

// ---------- 自助续期：真正的永久解法（2026-09-26 实证通过） ----------
//
// 既然密文解不开、留档又会过期，那就**别依赖客户端的存储**：客户端本来就是拿
// refreshToken 去换新 accessToken 的，而那个私有端点**不需要 client_secret**，
// 我们自己也能调。实测（本机真凭据）：
//
//   POST https://www.workbuddy.cn/v2/plugin/auth/token/refresh
//     X-Domain: www.workbuddy.cn        ← 客户端 enterpriseHeaders()：endpoint 的 authority
//     X-Refresh-Token: <refreshToken>
//     X-Auth-Refresh-Source: plugin
//     body: {}
//   → 200 {"code":0,"msg":"OK","data":{"accessToken","refreshToken","expiresIn","refreshExpiresIn"}}
//
// 关键实测结论：
//   * 不需要 client_secret（officially 走 OIDC 的那条路才需要，实测 401 invalid_client）；
//   * 端点/前缀的权威来源是客户端 resources/app.asar.unpacked/cli/product.json：
//       endpoint = "https://www.workbuddy.cn"，authentication.attributes.prefixPath = "/plugin"
//     路径 = `/v2${prefixPath}/auth/token/refresh` —— **少写 /plugin 直接 404**；
//   * 垃圾 token → 401 {"code":12153,"msg":"...token format error"}；
//   * **code=0 但 data 为空 = 服务端认为当前令牌还新鲜、不需要换发**（实测：换新后连续
//     5 次间隔 15 秒调用全是空 data，所以**不是**同秒限流、也**不是**令牌失效）。
//     → 判成功**只看 `data.accessToken` 是否存在**；为空就继续用现有令牌；
//   * 旧 refreshToken 可重复使用（连续 4+ 次全 200），**不会把客户端挤下线**；
//   * access ≈44 天 / refresh ≈90 天，且**每次续期都重新计 refresh 窗口**
//     → 只要每 ~2 个月至少刷一次，就能永远续下去（这就是「永久」的来源）。
//
// 所以取数顺序变成：**自持凭据（必要时续期）→ 客户端明文登录态 → 客户端迁移留档 → 失败**。
const API_ORIGIN = 'https://www.workbuddy.cn';
const API_DOMAIN = 'www.workbuddy.cn';
const REFRESH_URL = `${API_ORIGIN}/v2/plugin/auth/token/refresh`;
// access token 剩余不足这么多天就主动续期（留足余量，别卡在过期瞬间）
const REFRESH_AHEAD_DAYS = 7;
const DAY_MS = 86400000;

// 凭据的持久化出口由主进程注入（store.cjs）；没注入时（例如纯 node 探针）自动退化成
// 「只用内存里的客户端文件 / 留档」，不会报错。
// 另外允许注入一个 refreshUrl **仅供自检**覆盖续期端点（真机 main.cjs 不传，恒走 REFRESH_URL）。
let credentialIO = null;
let refreshUrlOverride = null;
function setCredentialIO(io) {
  credentialIO = io && typeof io.read === 'function' ? io : null;
  refreshUrlOverride = io && typeof io.refreshUrl === 'string' && io.refreshUrl ? io.refreshUrl : null;
}
function readStoredCredential() {
  if (!credentialIO) return null;
  try {
    const c = credentialIO.read();
    return c && typeof c === 'object' ? c : null;
  } catch {
    return null;
  }
}
function writeStoredCredential(cred) {
  if (!credentialIO || typeof credentialIO.write !== 'function') return;
  try {
    credentialIO.write(cred);
  } catch {
    /* 存不下就算了，不影响本次使用 */
  }
}
function clearStoredCredential() {
  if (!credentialIO || typeof credentialIO.clear !== 'function') return;
  try {
    credentialIO.clear();
  } catch {
    /* ignore */
  }
}
/** 能不能把凭据存下来 —— 存不下就谈不上「自助续期」，UI 得如实说 */
function canPersist() {
  return Boolean(credentialIO && typeof credentialIO.write === 'function');
}

/**
 * 本次运行内已被服务端明确拒绝（401/403）的 refreshToken。
 * 用来避免「续期失败 → 清掉 → 又从留档引导回同一个死令牌 → 又自称能自助续期」这种假乐观。
 * 只存内存、不落盘（重启后重新探一次，服务端可能已经改了）。
 */
const deadRefresh = new Set();

/** 解 JWT 的 payload（只取 exp / sub，不验签 —— 我们自己签不出来，也不需要） */
function jwtInfo(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    const exp = Number(json.exp);
    return {
      exp: Number.isFinite(exp) && exp > 0 ? exp * 1000 : null,
      sub: typeof json.sub === 'string' ? json.sub : null,
    };
  } catch {
    return null;
  }
}

/**
 * 用 refreshToken 换一对新凭据。
 * ⚠️ **判成功只看 `data.accessToken` 是否存在**，不能只看 HTTP 200 —— 当前令牌仍新鲜时
 * 服务端会返回 `code:0` 但 `data` 为空（实测），那不是失败，继续用现有令牌即可。
 */
async function refreshToken(refreshTokenValue, { timeoutMs = 15000 } = {}) {
  if (typeof refreshTokenValue !== 'string' || !refreshTokenValue) {
    return { ok: false, reason: 'no-refresh-token', message: '没有可用的 refreshToken' };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(refreshUrlOverride || REFRESH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Domain': API_DOMAIN,
        'X-Refresh-Token': refreshTokenValue,
        'X-Auth-Refresh-Source': 'plugin',
      },
      body: '{}',
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 保留原文 */
    }
    const data = json && json.data && json.data.data ? json.data.data : null;
    const accessToken = data ? asText(data.accessToken) : null;
    if (!accessToken) {
      return {
        ok: false,
        httpStatus: res.status,
        code: json ? json.code : null,
        // 服务端说 code:0 却没给令牌 = 当前令牌还新鲜，不需要换发（不是失败）
        noNewToken: Boolean(json && json.code === 0),
        message: (json && json.msg) || `续期接口返回 HTTP ${res.status}`,
        raw: text.slice(0, 300),
      };
    }
    const nextRefresh = asText(data.refreshToken) || refreshTokenValue;
    const at = jwtInfo(accessToken);
    const rt = jwtInfo(nextRefresh);
    return {
      ok: true,
      httpStatus: res.status,
      accessToken,
      refreshToken: nextRefresh,
      expiresAt:
        (at && at.exp) ||
        (Number(data.expiresIn) ? Date.now() + Number(data.expiresIn) * 1000 : null),
      refreshExpiresAt:
        (rt && rt.exp) ||
        (Number(data.refreshExpiresIn)
          ? Date.now() + Number(data.refreshExpiresIn) * 1000
          : null),
      uid: asText(data.uid) || (at && at.sub) || null,
    };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      reason: aborted ? 'timeout' : 'network',
      message: aborted ? '续期请求超时' : `续期网络错误：${err?.message || err}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 把凭据统一摊平成 readAuth / diagnose 用的返回形状 */
function authFromCredential(cred, credSource, extra = {}) {
  const expiresAt = Number(cred.expiresAt) || null;
  const refreshExpiresAt = Number(cred.refreshExpiresAt) || null;
  const selfRenew =
    Boolean(cred.refreshToken) && canPersist() && !deadRefresh.has(cred.refreshToken);
  return {
    ok: true,
    token: cred.accessToken,
    nickname: cred.nickname ?? null,
    uid: cred.uid ?? null,
    uin: cred.uin ?? null,
    accountType: cred.accountType ?? null,
    credSource,
    // 「降级」= 手里没有 refreshToken，只能等过期 —— 有 refreshToken 就是自持，不算降级
    degraded: !selfRenew,
    selfRenew,
    encrypted: false,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    expiresInDays: expiresAt ? Math.floor((expiresAt - Date.now()) / DAY_MS) : null,
    refreshExpiresAt: refreshExpiresAt ? new Date(refreshExpiresAt).toISOString() : null,
    refreshInDays: refreshExpiresAt ? Math.floor((refreshExpiresAt - Date.now()) / DAY_MS) : null,
    expired: expiresAt ? Date.now() >= expiresAt : false,
    ...extra,
  };
}

/** 从客户端登录态 / 留档里摘出可持久化的凭据（含 refreshToken，用于一次性引导） */
function credentialFrom({ token, refreshToken, expiresAt, refreshExpiresAt, identity }) {
  const id = identity || {};
  return {
    accessToken: token,
    refreshToken: refreshToken || null,
    expiresAt: expiresAt || (jwtInfo(token) || {}).exp || null,
    refreshExpiresAt: refreshExpiresAt || (refreshToken ? (jwtInfo(refreshToken) || {}).exp : null) || null,
    uid: id.uid || (jwtInfo(token) || {}).sub || null,
    nickname: id.nickname || null,
    uin: id.uin || null,
    accountType: id.accountType || null,
    updatedAt: Date.now(),
  };
}

/** 只读客户端当前文件里的账号身份（用来判断用户是不是换了账号） */
function peekClientIdentity(file) {
  if (!file) return null;
  const { text } = readTextRetry(file, 2, 20);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    const acct = parsed && parsed.account && typeof parsed.account === 'object' ? parsed.account : {};
    return { uid: asText(acct.uid) };
  } catch {
    return null;
  }
}

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

// 取数顺序：**自持凭据（必要时续期）→ 客户端明文登录态 → 客户端迁移留档 → 失败**。
// ⚠️ 边界不变：**绝不回写客户端的登录态文件**；自持的那一份存在我们自己的 data/config.json。
async function readAuth({ refresh = false, forceRefresh = false } = {}) {
  const { file, source, searched } = locate({ refresh });
  const base = { file, source, searched };

  // 先把客户端当前文件只读地解析出来：既当兜底，也用来判断「用户是不是换了账号」
  let live = null;
  let liveError = null;
  if (file) {
    const read = readTextRetry(file);
    if (read.text === null) {
      liveError = read.error || {};
    } else {
      try {
        const parsed = JSON.parse(read.text);
        const auth = parsed.auth || {};
        const account =
          parsed.account && typeof parsed.account === 'object' ? parsed.account : {};
        const rawToken = auth.accessToken ?? parsed.accessToken;
        live = {
          token: asText(rawToken),
          encrypted: isEncryptedField(rawToken),
          refreshToken: asText(auth.refreshToken),
          expiresAt: Number(auth.expiresAt) || null,
          refreshExpiresAt: Number(auth.refreshExpiresAt) || null,
          identity: {
            nickname: asText(account.nickname),
            uid: asText(account.uid),
            uin: asText(account.uin),
            accountType: asText(account.type),
          },
        };
      } catch {
        liveError = { code: 'PARSE' };
      }
    }
  }

  // ---------- A. 自持凭据（与客户端文件格式彻底解耦） ----------
  const stored = readStoredCredential();
  if (stored) {
    const clientUid = (live && live.identity && live.identity.uid) || peekClientIdentity(file)?.uid;
    if (clientUid && stored.uid && clientUid !== stored.uid) {
      // 客户端换账号了 —— 自持凭据属于旧账号，必须丢掉，宁可不可用也不能串号
      clearStoredCredential();
    } else {
      const exp = Number(stored.expiresAt) || null;
      const fresh =
        Boolean(stored.accessToken) && (!exp || exp - Date.now() > REFRESH_AHEAD_DAYS * DAY_MS);
      if (fresh && !forceRefresh) {
        return { ...base, ...authFromCredential(stored, 'stored') };
      }
      if (stored.refreshToken && !deadRefresh.has(stored.refreshToken)) {
        const r = await refreshToken(stored.refreshToken);
        if (r.ok) {
          const merged = {
            ...stored,
            accessToken: r.accessToken,
            refreshToken: r.refreshToken,
            expiresAt: r.expiresAt || stored.expiresAt,
            refreshExpiresAt: r.refreshExpiresAt || stored.refreshExpiresAt,
            uid: stored.uid || r.uid || null,
            updatedAt: Date.now(),
          };
          writeStoredCredential(merged);
          return { ...base, ...authFromCredential(merged, 'refreshed') };
        }
        if (r.noNewToken) {
          // 服务端说 code:0 但没给新令牌 = 当前令牌还新鲜，不需要换发。
          // 本地还有一天以上余量就当无事发生；已经临近/超过过期时间还拿不到新令牌，
          // 那是真的要断了，得如实告诉界面，别静默地拖着。
          const stillGood = Boolean(stored.accessToken) && exp && exp - Date.now() > DAY_MS;
          return {
            ...base,
            ...authFromCredential(stored, 'stored'),
            ...(stillGood ? {} : { refreshError: '续期端点未返回新令牌（当前令牌已临近过期）' }),
          };
        }
        if (r.httpStatus === 401 || r.httpStatus === 403) {
          // 服务端明确拒绝了这个 refreshToken —— 记下来（本次运行内不再假装能自助续期），
          // 然后清掉，让下面的回退链从客户端文件 / 留档重新引导一次。
          deadRefresh.add(stored.refreshToken);
          clearStoredCredential();
        } else if (stored.accessToken && exp && exp > Date.now()) {
          // 网络类失败（超时/断网）：本地这份还没过期 → 先顶着用，并把原因如实告诉界面
          return {
            ...base,
            ...authFromCredential(stored, 'stored'),
            refreshError: r.message || '续期请求失败',
          };
        }
      }
    }
  }

  // ---------- B. 客户端当前登录态（仍是明文时可用，顺手把 refreshToken 存下来做引导） ----------
  if (live && live.token) {
    const expired = live.expiresAt ? Date.now() >= live.expiresAt : false;
    if (!expired) {
      const cred = credentialFrom({ ...live, identity: live.identity });
      if (cred.refreshToken && !deadRefresh.has(cred.refreshToken)) writeStoredCredential(cred);
      return {
        ...base,
        ...authFromCredential(cred, 'live'),
        bootstrapped: Boolean(cred.refreshToken),
      };
    }
  }

  // ---------- C. 客户端迁移留档（明文，当前文件被加密时的兜底） ----------
  if (file) {
    const fb = readPlaintextBackup(path.dirname(file), file, live?.identity?.uid ?? null);
    if (fb) {
      const cred = credentialFrom(fb);
      if (cred.refreshToken && !deadRefresh.has(cred.refreshToken)) writeStoredCredential(cred);
      return {
        ...base,
        ...authFromCredential(cred, 'backup', {
          backupFile: fb.file,
          encrypted: Boolean(live && live.encrypted),
          lockRetried: Boolean(liveError),
        }),
        bootstrapped: Boolean(cred.refreshToken),
      };
    }
  }

  // ---------- D. 全部拿不到 ----------
  if (!file) {
    return {
      ok: false,
      reason: 'no-file',
      message: dataDirExists()
        ? '检测到 WorkBuddy 客户端数据，但未找到登录态。请在客户端里完成登录后再点「重新检测」。'
        : '未检测到 WorkBuddy 登录态。请先在本机安装并登录 WorkBuddy 客户端。',
      ...base,
    };
  }
  if (liveError) {
    const e = liveError;
    const locked = e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY';
    return {
      ok: false,
      reason: 'bad-file',
      message:
        e.code === 'ENOENT'
          ? '登录态文件已消失，请重新检测'
          : locked
            ? '登录态文件被占用或拒绝读取，请关闭 WorkBuddy 客户端后重试'
            : '登录态文件无法解析',
      ...base,
    };
  }
  const encrypted = Boolean(live && live.encrypted);
  const identity =
    (live && live.identity) || { nickname: null, uid: null, uin: null, accountType: null };
  return {
    ok: false,
    reason: encrypted ? 'encrypted' : 'no-token',
    message: encrypted
      ? 'WorkBuddy 登录态已加密，且没有可用的明文留档：签到与余额暂不可用'
      : '登录态中缺少 accessToken，请在 WorkBuddy 客户端重新登录',
    ...base,
    encrypted,
    ...identity,
  };
}

/** 诊断信息：给界面用，说明「当前关联的是哪个账号 / 去哪些地方找过登录态」 */
async function diagnose({ refresh = false } = {}) {
  const auth = await readAuth({ refresh });
  const searched = auth.searched || locate({ refresh }).searched;
  const stored = readStoredCredential();
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
    // ⚠️ 一律过 asText：密文包装 / 任何对象都不能流到渲染层（会炸掉整棵 React 树）
    nickname: asText(auth.nickname),
    uid: asText(auth.uid),
    uin: asText(auth.uin),
    accountType: asText(auth.accountType),
    encrypted: auth.encrypted ?? false,
    // 凭据实际取自哪里：stored = 本应用自持；refreshed = 刚自助续期；
    // live = 客户端当前登录态文件；backup = 客户端迁移留档
    credSource: auth.credSource ?? null,
    degraded: auth.degraded ?? false,
    selfRenew: auth.selfRenew ?? Boolean(stored && stored.refreshToken),
    bootstrapped: auth.bootstrapped ?? false,
    refreshError: auth.refreshError ?? null,
    backupFile: auth.backupFile ?? null,
    lockRetried: auth.lockRetried ?? false,
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

function isAuthFailure(res) {
  return res && (res.httpStatus === 401 || res.httpStatus === 403);
}

/**
 * 接口返 401/403 时强制续期一次。
 * 只有真的换到了**不同的**新 token 才返回，否则 null —— 避免拿同一个失效 token 白跑一趟。
 */
async function renewOnce(prev) {
  const next = await readAuth({ forceRefresh: true });
  if (next && next.ok && next.token && next.token !== prev.token) return next;
  return null;
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
  let auth = await readAuth();
  if (!auth.ok) return auth;

  const started = Date.now();
  let res = await call(BALANCE_URL, auth.token, { headers: authHeaders(auth) });
  if (isAuthFailure(res)) {
    const renewed = await renewOnce(auth);
    if (renewed) {
      auth = renewed;
      res = await call(BALANCE_URL, auth.token, { headers: authHeaders(auth) });
    }
  }
  if (res.error) return { ok: false, reason: res.error, message: res.message };
  if (isAuthFailure(res)) {
    return {
      ok: false,
      reason: 'expired',
      message: 'WorkBuddy 凭据已失效，请在客户端重新登录后再试（Tally 下次启动会自动续期）',
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
  let auth = await readAuth(opts);
  if (!auth.ok) return auth;

  let res = await call(STATUS_URL, auth.token, { headers: authHeaders(auth) });
  if (isAuthFailure(res)) {
    const renewed = await renewOnce(auth);
    if (renewed) {
      auth = renewed;
      res = await call(STATUS_URL, auth.token, { headers: authHeaders(auth) });
    }
  }
  if (res.error) return { ok: false, reason: res.error, message: res.message };
  if (isAuthFailure(res)) {
    return {
      ok: false,
      reason: 'expired',
      message: 'WorkBuddy 凭据已失效，请在客户端重新登录后再试（Tally 下次启动会自动续期）',
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
  let auth = await readAuth();
  if (!auth.ok) return auth;

  let res = await call(CHECKIN_URL, auth.token, { headers: authHeaders(auth) });
  if (isAuthFailure(res)) {
    const renewed = await renewOnce(auth);
    if (renewed) {
      auth = renewed;
      res = await call(CHECKIN_URL, auth.token, { headers: authHeaders(auth) });
    }
  }
  if (res.error) return { ok: false, reason: res.error, message: res.message };
  if (isAuthFailure(res)) {
    return {
      ok: false,
      reason: 'expired',
      message: 'WorkBuddy 凭据已失效，请在客户端重新登录后再试（Tally 下次启动会自动续期）',
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
  // 自助续期
  setCredentialIO,
  refreshToken,
  STATUS_URL,
  CHECKIN_URL,
  BALANCE_URL,
  REFRESH_URL,
  API_HOST: HOST,
};
