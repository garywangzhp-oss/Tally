'use strict';
// 桌面 Z 序守护：让面板常驻「桌面之上、所有应用之下」，并在它盖住任何可见应用时把它按回去。
//
// 为什么需要它：Electron 的 alwaysOnTop=false 只是「不置顶」，并不等于「待在桌面层」。
// 普通窗口的 Z 序由「谁最后被激活」决定 —— 用户点一下面板（拖动、操作），它就被排到
// 所有窗口之上，并且一直待在那儿不回落。用户反复报的「还是遮挡其他页面」就是这个：
// 被动等待别人来盖，永远会漏。真正的解法是主动下沉，这需要 EnumWindows/SetWindowPos
// 级别的能力，Electron 没有暴露，所以由 desktop-keep.ps1（PowerShell + Win32）承担。
//
// 契约：主进程**只登记「当前应当可见」的窗口**。收进托盘的面板不登记，守护就碰不到它。
// 这一条不能省 —— 脚本里的 SetWindowPos 带 SWP_SHOWWINDOW，会把隐藏的窗口显示出来，
// 正好复现旧的「点了 × 窗口闪一下又回来」bug。

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const SCRIPT = path.join(__dirname, '..', 'desktop-keep.ps1');
const RESPAWN_THROTTLE_MS = 5000;

let child = null;
let handlesFile = '';
let lastWritten = null;
let lastSpawnAt = 0;
let unavailable = false;
let logger = () => {};

function log(...a) {
  logger('[keeper]', ...a);
}

// Electron 的 getNativeWindowHandle() 在 64 位上给 8 字节，32 位给 4 字节。
// keeper 那边按十进制整数解析成 HWND。
function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : buf.readUInt32LE(0).toString();
}

function configure(opts) {
  if (opts && typeof opts.handlesFile === 'string') handlesFile = opts.handlesFile;
  if (opts && typeof opts.log === 'function') logger = opts.log;
}

function isRunning() {
  return Boolean(child && child.exitCode === null && !child.killed);
}

// entries: [{ win, topmost }] —— 只传**应当可见**的窗口。空数组 = 面板收在托盘里。
function update(entries) {
  if (!handlesFile || unavailable) return;
  if (!fs.existsSync(SCRIPT)) {
    if (!unavailable) log('desktop-keep.ps1 不存在，Z 序守护停用');
    unavailable = true;
    return;
  }

  const lines = [];
  for (const e of entries || []) {
    const w = e && e.win;
    if (!w || w.isDestroyed()) continue;
    try {
      lines.push((e.topmost ? 'wt:' : 'w:') + hwndOf(w));
    } catch {
      /* 窗口正在销毁，跳过 */
    }
  }
  const text = lines.join('\n');

  // 内容没变就不写盘：这个函数每 400ms 跑一次，不能每次都碰 IO。
  if (text !== lastWritten) {
    lastWritten = text;
    try {
      // 空字符串（收进托盘）= keeper 读到空列表，什么都不碰
      fs.writeFileSync(handlesFile, text, 'utf8');
    } catch (err) {
      log('写 handles 失败', err.message);
      return;
    }
  }

  // keeper 被外部杀掉 / 脚本异常退出时自动拉起，5 秒节流避免 spawn 风暴
  const now = Date.now();
  if (!isRunning() && lines.length > 0 && now - lastSpawnAt > RESPAWN_THROTTLE_MS) {
    lastSpawnAt = now;
    spawnKeeper();
  }
}

function spawnKeeper() {
  try {
    child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        SCRIPT,
        '-HandlesFile',
        handlesFile,
        '-ParentPid',
        String(process.pid),
      ],
      { windowsHide: true, stdio: 'ignore' }
    );
    child.on('exit', (code) => {
      log('keeper 退出，code=', code);
      child = null;
    });
    child.on('error', (err) => {
      log('keeper 启动失败', err.message);
      child = null;
      unavailable = true;
    });
    log('keeper 已启动 pid=', child.pid);
  } catch (err) {
    log('spawn 异常', err.message);
    child = null;
  }
}

function stop() {
  if (child && child.exitCode === null) {
    try {
      child.kill();
    } catch {
      /* 已经没了 */
    }
  }
  child = null;
  // 面板下次启动会重新写；先清空，免得残留的 HWND 被别的 keeper 拿到
  lastWritten = null;
}

function status() {
  return {
    running: isRunning(),
    pid: child ? child.pid : null,
    handlesFile,
    lastWritten: lastWritten || '',
    logPath: path.join(process.env.TEMP || '', 'tally-keep.log'),
  };
}

module.exports = { configure, update, stop, isRunning, status, SCRIPT };
