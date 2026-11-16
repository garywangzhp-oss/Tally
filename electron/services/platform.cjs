'use strict';
// 平台适配层：Windows / macOS 的差异集中在这一个文件，main.cjs 只调用、不判断。
//
// 两边真正的差别只有三处，其余（取数、渲染、IPC）完全一致：
//
//   1. 数据目录
//      Windows 绿色版把 userData 放在程序目录旁（拔走即无痕）。
//      macOS 的 .app 是**只读包**：往里写会破坏代码签名（Apple Silicon 上直接拒绝启动），
//      所以只能二选一 ——
//        · 便携模式：.app **同级**已有 data/ 目录 → 数据和程序一起搬走
//        · 系统模式：~/Library/Application Support/Tally（分发版默认走这条）
//      注意「同级已有 data」才认便携，不自己创建：否则用户把 .app 拖进 /Applications
//      时会被塞进一个 /Applications/data。
//
//   2. 窗口层级
//      Windows 有真正的「桌面层」（desktop-keep.ps1 用 SetWindowPos 实现）。
//      macOS 没有等价的公开层级（想贴桌面背景层要写 native addon 设
//      kCGDesktopWindowLevel，代价太大），所以：
//        · 贴桌面 = 普通层级 + 在所有 Space 上常驻（mac 用户对桌面小组件的预期）
//        · 置顶   = floating 层（盖住普通窗口，但**不**盖全屏应用和系统 UI —— 用
//                   screen-saver 会连屏保/通知中心一起压住，太霸道）
//
//   3. 托盘
//      Windows 是任务栏通知区，彩色 PNG 即可。
//      macOS 是菜单栏，图标必须是 template 图（纯黑 + alpha，文件名带 Template），
//      系统才会按明暗菜单栏自动反色。Dock 图标用 app.dock.hide() 隐去（与 Windows
//      隐藏任务栏按钮同一个意图：小组件不该占着应用切换器）。

const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

// 与 package.json 的 productName 保持一致；mac 上它同时是 ~/Library/Application Support 下的目录名
const PRODUCT = 'Tally';
const ASSETS = path.join(__dirname, '..', 'assets');

function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** .app 包根目录（mac: /Applications/Tally.app；win: 程序所在目录） */
function bundleRoot() {
  if (!IS_MAC) return path.dirname(app.getPath('exe'));
  // <...>/Tally.app/Contents/MacOS/Tally → 上三级才是 .app
  return path.resolve(path.dirname(app.getPath('exe')), '..', '..');
}

let cachedPaths = null;

/**
 * 数据目录与 userData。
 * 返回 { dataDir, userDataDir, portable }：
 *   · dataDir     存 config.json / 诊断日志
 *   · userDataDir Electron 的缓存、单实例锁
 * ⚠️ 必须在 app.whenReady() 之前（或至少 setPath 之前）调用一次，值会被缓存。
 */
function resolvePaths() {
  if (cachedPaths) return cachedPaths;

  // TALLY_DATA_DIR 优先：自检 / 多套数据隔离，行为与旧版一致
  if (process.env.TALLY_DATA_DIR) {
    cachedPaths = {
      dataDir: process.env.TALLY_DATA_DIR,
      userDataDir: process.env.TALLY_DATA_DIR,
      portable: false,
    };
    return cachedPaths;
  }

  // 开发模式：数据放项目根 data/（与旧版完全一致，别让 dev 把配置写进 node_modules）
  if (!app.isPackaged) {
    const devData = path.resolve(__dirname, '..', '..', 'data');
    cachedPaths = { dataDir: devData, userDataDir: devData, portable: false };
    return cachedPaths;
  }

  if (IS_MAC) {
    const parent = path.dirname(bundleRoot());
    const portableData = path.join(parent, 'data');
    if (fs.existsSync(portableData)) {
      cachedPaths = {
        dataDir: portableData,
        userDataDir: path.join(portableData, 'userdata'),
        portable: true,
      };
      return cachedPaths;
    }
    const sysDir = path.join(app.getPath('appData'), PRODUCT);
    cachedPaths = { dataDir: sysDir, userDataDir: sysDir, portable: false };
    return cachedPaths;
  }

  // Windows：与原实现一致 —— 无条件用程序目录旁的 data/
  const base = path.dirname(app.getPath('exe'));
  const dataDir = path.join(base, 'data');
  if (isWritableDir(dataDir)) {
    cachedPaths = { dataDir, userDataDir: path.join(dataDir, 'userdata'), portable: true };
    return cachedPaths;
  }
  // 装在 Program Files 这类只读位置时退回系统目录（旧版会在 setPath 后一起写不进去）
  const sysDir = path.join(app.getPath('appData'), PRODUCT);
  cachedPaths = { dataDir: sysDir, userDataDir: sysDir, portable: false };
  return cachedPaths;
}

/** 是否应该把 userData 重定向到程序旁边（绿色版语义） */
function shouldRelocateUserData() {
  const p = resolvePaths();
  return p.userDataDir !== app.getPath('userData');
}

// ---------- 窗口 ----------

/** BrowserWindow 构造参数里只属于 macOS 的那部分 */
function windowExtras() {
  if (!IS_MAC) return {};
  return {
    // 面板不是当前前台应用时，第一次点击直接生效（不然要「点两下」才按到按钮）
    acceptFirstMouse: true,
    // 圆角交给 CSS 画：系统再裁一次会在透明窗口边缘留出方角黑边
    roundedCorners: false,
  };
}

/** 置顶层名称：Windows 用 screen-saver（能压住任务栏），mac 用 floating（不压系统 UI） */
function topLevel() {
  return IS_MAC ? 'floating' : 'screen-saver';
}

/** 让面板在所有桌面空间（Space）上都可见 —— mac 上这是「贴桌面」最接近的语义 */
function stickToAllSpaces(win) {
  if (!IS_MAC || !win || win.isDestroyed()) return;
  try {
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: false, // 全屏应用里不冒头，否则会打断看电影/演示
      skipTransformProcessType: true,
    });
  } catch (err) {
    console.error('[tally] setVisibleOnAllWorkspaces 失败', err?.message || err);
  }
}

/** 隐藏 Dock 图标（等价于 Windows 的 skipTaskbar：不占应用切换器） */
function hideDock() {
  if (!IS_MAC) return false;
  try {
    if (app.dock) {
      app.dock.hide();
      return true;
    }
  } catch (err) {
    console.error('[tally] dock.hide 失败', err?.message || err);
  }
  return false;
}

// ---------- 托盘 / 菜单栏图标 ----------

/**
 * 托盘图标。
 * mac 用 trayTemplate.png —— 文件名里的 Template 是给系统看的信号：
 * 只有 alpha 通道有意义，颜色由菜单栏明暗决定。同目录的 @2x 会被自动配对。
 */
function trayIconPaths() {
  if (IS_MAC) {
    return {
      main: path.join(ASSETS, 'trayTemplate.png'),
      // template 图不需要手工补 1x 表示，系统按 @2x 自己挑
      small: null,
    };
  }
  return {
    main: path.join(ASSETS, 'tray-32.png'),
    small: path.join(ASSETS, 'tray-16.png'),
  };
}

/** 窗口 / Dock / 关于面板用的应用图标 */
function appIconPath() {
  if (IS_MAC) {
    // .app 的图标来自 Info.plist 的 CFBundleIconFile（build-mac.mjs 写 icns），
    // 运行时 BrowserWindow 的 icon 选项在 mac 上不生效，给 PNG 只为兜底。
    const png = path.join(ASSETS, 'app-256.png');
    return fs.existsSync(png) ? png : null;
  }
  const ico = path.join(ASSETS, 'icon.ico');
  const png = path.join(ASSETS, 'app-256.png');
  return fs.existsSync(ico) ? ico : fs.existsSync(png) ? png : null;
}

// ---------- 开机自启 ----------
//
// Windows 写 HKCU\...\Run 一条值（内容是 exe 绝对路径），注册表就是事实来源。
// macOS 13+ 走 SMAppService 登记登录项 —— **必须已签名**且通常要在 /Applications 下，
// 否则登记不上；登记成功但用户还没在「系统设置 → 通用 → 登录项」里允许时，
// 状态是 requires-approval，这时不能报失败，只能提示。

function readAutoStart() {
  try {
    if (IS_MAC) return Boolean(app.getLoginItemSettings().openAtLogin);
    return Boolean(app.getLoginItemSettings({ path: process.execPath }).openAtLogin);
  } catch {
    return false;
  }
}

function writeAutoStart(on) {
  if (IS_MAC) {
    app.setLoginItemSettings({ openAtLogin: Boolean(on) });
    const st = app.getLoginItemSettings();
    return {
      actual: Boolean(st.openAtLogin),
      pending: st.status === 'requires-approval',
      status: st.status || '',
    };
  }
  app.setLoginItemSettings({ openAtLogin: Boolean(on), path: process.execPath, args: [] });
  return { actual: readAutoStart(), pending: false, status: '' };
}

module.exports = {
  IS_MAC,
  IS_WIN,
  PRODUCT,
  bundleRoot,
  resolvePaths,
  shouldRelocateUserData,
  windowExtras,
  topLevel,
  stickToAllSpaces,
  hideDock,
  trayIconPaths,
  appIconPath,
  readAutoStart,
  writeAutoStart,
};
