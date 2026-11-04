// WorkBuddy 官方网页登录（external-link 流程）
//
// ---------- 这是什么 ----------
// WorkBuddy 桌面客户端的登录方式，在 product.json 里写作
//   authentication.type = "account-scoped-external-link"
// 也就是「客户端生成一个登录态（state），把浏览器甩到官方登录页，用户在网页里
// 完成登录（微信扫码 / 手机号 / 企业 SSO 都行），再回来轮询把令牌取走」。
//
// ---------- 为什么 Tally 要自己做 ----------
// 以前 Tally 是「蹭」客户端登录态的：读 %LOCALAPPDATA% 下的 workbuddy-desktop.info。
// 但客户端新版把 accessToken / refreshToken 全换成了 at-rest-crypto 密文
// （AES-256-GCM，密钥编译期烤进 native 模块），Tally 读不到；而重新登录客户端又会
// 吊销服务端 offline session，把手里唯一那份明文留档一并作废。
// → 结论：**别再依赖客户端的存储，自己走一次官方登录拿自己的令牌。**
//
// 这条路的好处是它本来就是公开协议（客户端主进程代码里就有），Tally 用的是
// 服务端给的一次性 state，不碰客户端密钥、不解 at-rest 密文、不回写客户端文件，
// 因此**可以进公开仓库和分发版**（与 wb-recover.local.cjs 的定位完全不同）。
//
// ---------- 协议（2026-11-02 从客户端 /main/common2.js 的
//            ExternalLinkAuthenticationProvider 里逐行挖出并实测） ----------
//  1) POST {origin}/v2/plugin/auth/state?platform=workbuddy
//       headers: X-Domain / X-No-Authorization: true / X-No-User-Id: true
//                X-No-Enterprise-Id: true / X-No-Department-Info: true
//       body: {}
//     → { code:0, data:{ state, authUrl } }
//     实测：authUrl = https://www.workbuddy.cn/login?platform=workbuddy&state=<state>
//
//  2) 用系统浏览器打开 authUrl（客户端也是 shell.openExternal，不内嵌 webview）
//
//  3) 轮询 GET {origin}/v2/plugin/auth/token?state=<state>
//       → code 11217  = "login ing..."，用户还没登完，继续轮询（实测）
//       → data.accessToken 存在 = 成功
//         data 形状：{ accessToken, refreshToken, expiresIn, refreshExpiresIn,
//                      domain?, tokenType? }
//
//  4) GET {origin}/v2/plugin/login/account?state=<state>
//       headers: Authorization: Bearer <accessToken>，外加同上四个 X-No-*
//       → data = 当前账号（昵称 / uid / uin）
//       未带 Authorization 时网关直接 401（实测），所以必须先拿到 token
//
//  5) （可选）GET {origin}/v2/plugin/accounts  → data.accounts[]（多账号 / 企业列表）
//
// 客户端参数：SIGN_IN_PENDING_TIMEOUT = 300000ms，SIGN_IN_FETCH_INTERVAL = 1000ms。
//
// ---------- 安全边界 ----------
// * 只往 data/config.json 的 wbCredential 写（跟自助续期同一格），不碰客户端任何文件；
// * 令牌只在主进程内存与本地配置里，绝不进渲染层（渲染层只拿 status / 账号名）；
// * state 是一次性的，登录完成后立刻失效；
// * 用户可以随时取消，取消后不再轮询。

const API_ORIGIN = 'https://www.workbuddy.cn';
const API_DOMAIN = 'www.workbuddy.cn';
// product.json 的 authentication.attributes.prefixPath，少写 /plugin 直接 404
const PREFIX = '/plugin';

const STATE_URL = `${API_ORIGIN}/v2${PREFIX}/auth/state?platform=workbuddy`;
const TOKEN_URL = `${API_ORIGIN}/v2${PREFIX}/auth/token`;
const ACCOUNT_URL = `${API_ORIGIN}/v2${PREFIX}/login/account`;

const POLL_INTERVAL_MS = 1200;
const TOTAL_TIMEOUT_MS = 300000;
// 轮询期间允许的连续网络错误次数（断网 / 代理抖动不该直接判失败）
const MAX_NETWORK_ERRORS = 5;
// 用户还没登录时服务端给的「继续等」业务码
const CODE_PENDING = 11217;

// 无鉴权请求统一带的四个头，抄自客户端的 loginPollHeaders。
// 它们的意思是「这是登录前的请求，别往里面塞 token / uid / 企业信息」，
// 少了会被网关当成匿名调用处理。
const NO_AUTH_HEADERS = {
  'X-No-Authorization': 'true',
  'X-No-User-Id': 'true',
  'X-No-Enterprise-Id': 'true',
  'X-No-Department-Info': 'true',
};

// 客户端是 Electron（Chromium），默认 UA 就是浏览器 UA；
// 纯 Node 的 fetch 默认发 `node`，网关的匿名风控可能据此区别对待 —— 显式对齐浏览器。
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36';

/** 解 JWT 的 payload（只取 exp / sub，不验签） */
function jwtInfo(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/gu, '+').replace(/_/gu, '/');
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

function asText(v) {
  return typeof v === 'string' && v ? v : null;
}

/** 带超时的 fetch，返回 { status, json, text } 或 { error } */
async function request(url, { method = 'GET', headers = {}, body = null, timeoutMs = 8000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA, ...headers },
      ...(body === null ? {} : { body }),
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 保留原文，调用方按 status 判断 */
    }
    return { status: res.status, json, text };
  } catch (err) {
    return {
      error: err?.name === 'AbortError' ? 'timeout' : 'network',
      message: err?.name === 'AbortError' ? '请求超时' : `网络错误：${err?.message || err}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 会话单例：同一时刻只允许一个登录流程在跑 */
let session = null;
let seq = 0;

/** 把一次请求的原始响应压成一行 trace（诊断用，见 startLogin 的 trace 参数） */
function traceLine(label, r) {
  if (r.error) return `${label} | ${r.error} | ${r.message}`;
  const body = String(r.text || '').replace(/\s+/gu, ' ').slice(0, 300);
  return `${label} | HTTP ${r.status} | ${body}`;
}

function emit(s, type, payload = {}) {
  if (!s || s.done) return;
  const evt = { type, at: Date.now(), ...payload };
  try {
    s.onEvent(evt);
  } catch {
    /* 监听方自己出错不该影响登录 */
  }
}

/** 写一行诊断日志（没配 trace 就什么都不做） */
function trace(s, line) {
  if (!s || !s.trace) return;
  try {
    s.trace(line);
  } catch {
    /* 日志写不进去不该影响登录 */
  }
}

function finish(s, result) {
  if (!s || s.done) return;
  s.done = true;
  s.stopped = true;
  if (s.timer) clearTimeout(s.timer);
  if (session === s) session = null;
  s.resolve(result);
}

/**
 * 开始一次登录。
 * @param {object} opts
 * @param {(url:string)=>Promise<boolean>|boolean} opts.openExternal 打开系统浏览器
 * @param {(evt:object)=>void} opts.onEvent 进度事件回调
 * @param {(line:string)=>void} [opts.trace] 诊断日志（每次请求的原始响应，一行一条）
 * @returns {Promise<object>} 登录结果
 */
function startLogin({ openExternal, onEvent, trace } = {}) {
  if (session && !session.done) {
    return Promise.resolve({
      ok: false,
      reason: 'busy',
      message: '已有一个登录流程在进行中',
      state: session.state || null,
    });
  }

  const s = {
    id: (seq += 1),
    state: null,
    authUrl: null,
    done: false,
    stopped: false,
    startedAt: Date.now(),
    onEvent: typeof onEvent === 'function' ? onEvent : () => {},
    trace: typeof trace === 'function' ? trace : null,
    resolve: null,
    timer: null,
  };
  session = s;

  return new Promise((resolve) => {
    s.resolve = resolve;
    runLogin(s, openExternal).catch((err) => {
      finish(s, {
        ok: false,
        reason: 'error',
        message: `登录流程异常：${err?.message || err}`,
      });
      emit(s, 'failed', { message: `登录流程异常：${err?.message || err}` });
    });
  });
}

async function runLogin(s, openExternal) {
  emit(s, 'starting', {});

  // ---------- 1. 申请登录态 ----------
  const st = await request(STATE_URL, {
    method: 'POST',
    headers: { 'X-Domain': API_DOMAIN, ...NO_AUTH_HEADERS },
    body: '{}',
  });
  if (s.stopped) return;
  if (st.error) {
    trace(s, traceLine('[auth/state]', st));
    emit(s, 'failed', { message: `无法连接登录服务：${st.message}` });
    finish(s, { ok: false, reason: st.error, message: `无法连接登录服务：${st.message}` });
    return;
  }
  trace(s, traceLine('[auth/state]', st));
  const data = st.json && st.json.code === 0 ? st.json.data : null;
  const stateId = data ? asText(data.state) : null;
  const rawUrl = data ? asText(data.authUrl) : null;
  if (!stateId || !rawUrl) {
    const msg =
      (st.json && st.json.msg) ||
      `登录服务返回异常（HTTP ${st.status}，code=${st.json ? st.json.code : '?'}）`;
    emit(s, 'failed', { message: msg });
    finish(s, { ok: false, reason: 'state', message: msg, raw: (st.text || '').slice(0, 300) });
    return;
  }
  s.state = stateId;
  s.authUrl = rawUrl;
  trace(s, `[authUrl] ${rawUrl}`);

  // ---------- 2. 甩给系统浏览器 ----------
  let browserOpened = false;
  try {
    browserOpened = Boolean(await openExternal(rawUrl));
  } catch {
    browserOpened = false;
  }

  emit(s, 'awaiting', {
    authUrl: rawUrl,
    state: stateId,
    browserOpened,
    // 浏览器没打开时把链接给界面，让用户自己点（复制到已登录的浏览器里也行）
    message: browserOpened
      ? '已在浏览器打开 WorkBuddy 登录页，登录完成后这里会自动继续'
      : '没能自动打开浏览器，请手动点击下面的登录链接',
  });

  // 硬超时（客户端也是 300s）
  s.timer = setTimeout(() => {
    const msg = '登录等待超时（5 分钟）。可以重新发起一次。';
    emit(s, 'failed', { message: msg });
    finish(s, { ok: false, reason: 'timeout', message: msg });
  }, TOTAL_TIMEOUT_MS);

  // ---------- 3. 轮询令牌 ----------
  const tokenUrl = `${TOKEN_URL}?state=${encodeURIComponent(stateId)}`;
  let netErrors = 0;
  let pollCount = 0;
  let lastCode = '__init__';

  while (!s.stopped) {
    await new Promise((r) => {
      setTimeout(r, POLL_INTERVAL_MS);
    });
    if (s.stopped) return;
    pollCount += 1;

    const r = await request(tokenUrl, { headers: NO_AUTH_HEADERS, timeoutMs: 6000 });
    if (s.stopped) return;

    if (r.error) {
      netErrors += 1;
      trace(s, traceLine(`[token #${pollCount}]`, r));
      emit(s, 'polling', { pollCount, netErrors, message: r.message });
      if (netErrors >= MAX_NETWORK_ERRORS) {
        const msg = `连续 ${netErrors} 次无法连接登录服务（${r.message}）`;
        emit(s, 'failed', { message: msg });
        finish(s, { ok: false, reason: r.error, message: msg });
        return;
      }
      continue;
    }
    netErrors = 0;

    const code = r.json ? r.json.code : null;
    const payload = r.json && r.json.data ? r.json.data : null;
    const accessToken = payload ? asText(payload.accessToken) : null;

    // 只在业务码变化时落一行（否则 1.2s 一条刷屏），拿不到 code 的情况每 15 次也记一次
    if (code !== lastCode || pollCount % 15 === 1) {
      trace(s, traceLine(`[token #${pollCount}] code=${code}`, r));
      lastCode = code;
    }

    if (accessToken) {
      // ---------- 4. 拿账号信息 ----------
      const account = await fetchAccount(stateId, accessToken);
      trace(s, `[account] ${account ? JSON.stringify(account).slice(0, 300) : 'null'}`);
      const refreshToken = asText(payload.refreshToken);
      const at = jwtInfo(accessToken);
      const rt = refreshToken ? jwtInfo(refreshToken) : null;
      const cred = {
        accessToken,
        refreshToken,
        expiresAt:
          (at && at.exp) ||
          (Number(payload.expiresIn) ? Date.now() + Number(payload.expiresIn) * 1000 : null),
        refreshExpiresAt:
          (rt && rt.exp) ||
          (Number(payload.refreshExpiresIn)
            ? Date.now() + Number(payload.refreshExpiresIn) * 1000
            : null),
        uid: asText(account?.uid) || (at && at.sub) || null,
        nickname: asText(account?.nickname),
        uin: asText(account?.uin),
        accountType: asText(account?.type) || asText(account?.accountType),
        updatedAt: Date.now(),
      };
      emit(s, 'success', {
        nickname: cred.nickname,
        uid: cred.uid,
        uin: cred.uin,
        expiresAt: cred.expiresAt,
        refreshExpiresAt: cred.refreshExpiresAt,
      });
      finish(s, { ok: true, credential: cred, pollCount });
      return;
    }

    if (code === CODE_PENDING) {
      // 用户还在网页里没登完 —— 正常，继续等
      emit(s, 'polling', { pollCount, code, message: '等待浏览器完成登录…' });
      continue;
    }

    // 其它业务码：多数是 state 已被用掉 / 过期
    const msg = (r.json && r.json.msg) || `登录轮询返回 code=${code}`;
    emit(s, 'failed', { message: msg, code });
    finish(s, {
      ok: false,
      reason: 'api',
      code,
      message: msg,
      raw: (r.text || '').slice(0, 300),
    });
    return;
  }
}

/** 用刚拿到的 accessToken 取当前账号（失败不影响登录本身，只是少个昵称） */
async function fetchAccount(stateId, accessToken) {
  const r = await request(`${ACCOUNT_URL}?state=${encodeURIComponent(stateId)}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Domain': API_DOMAIN,
      'X-No-User-Id': 'true',
      'X-No-Enterprise-Id': 'true',
      'X-No-Department-Info': 'true',
    },
    timeoutMs: 6000,
  });
  if (r.error || !r.json || r.json.code !== 0 || !r.json.data) return null;
  return r.json.data;
}

/** 取消当前登录（界面点「取消」或窗口关闭时调） */
function cancelLogin(reason = 'canceled') {
  const s = session;
  if (!s || s.done) return false;
  const msg = reason === 'canceled' ? '已取消登录' : reason;
  emit(s, 'canceled', { message: msg });
  finish(s, { ok: false, reason: 'canceled', message: msg });
  return true;
}

/** 供界面查询「现在是不是有个登录在等」 */
function currentSession() {
  if (!session || session.done) return null;
  return {
    state: session.state,
    authUrl: session.authUrl,
    startedAt: session.startedAt,
    elapsedMs: Date.now() - session.startedAt,
  };
}

module.exports = {
  startLogin,
  cancelLogin,
  currentSession,
  STATE_URL,
  TOKEN_URL,
  ACCOUNT_URL,
  API_ORIGIN,
  TOTAL_TIMEOUT_MS,
};
