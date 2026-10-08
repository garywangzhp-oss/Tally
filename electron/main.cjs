const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { Store, sanitizeProfiles } = require('./services/store.cjs');
const opencode = require('./services/opencode.cjs');
const commandcode = require('./services/commandcode.cjs');
const workbuddy = require('./services/workbuddy.cjs');
const desktopKeeper = require('./services/desktop-keeper.cjs');
const usageHistory = require('./services/usage-history.cjs');

// 本机 GPU 子进程缺 DLL、Chromium 渲染沙箱也初始化失败（渲染进程报 0xC0000135 -> 白屏）。
// 完整规避配方：angle + swiftshader + in-process-gpu + 关闭 GPU 沙箱与全局沙箱。
app.commandLine.appendSwitch('use-gl', 'angle');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('no-sandbox');

// 绿色版：把 userData 也重定向到程序目录，避免往 %APPDATA% 里塞缓存（拔走目录即无痕）
if (app.isPackaged) {
  try {
    app.setPath('userData', path.join(path.dirname(app.getPath('exe')), 'data', 'userdata'));
  } catch (err) {
    console.error('[tally] setPath(userData) 失败', err);
  }
}

// 自检 / 多实例隔离：TALLY_DATA_DIR 覆盖数据目录时，顺带把它设为 userData。
// ⚠️ 必须在这里（requestSingleInstanceLock 之前）：Electron 的单实例锁就是
// userData 目录下的锁文件，不隔离的话自检会跟用户正在跑的绿色版抢锁，两边都起不来。
if (process.env.TALLY_DATA_DIR) {
  try {
    app.setPath('userData', process.env.TALLY_DATA_DIR);
  } catch (err) {
    console.error('[tally] setPath(userData) 失败', err);
  }
}

const WIN_WIDTH = 400;
const WIN_HEIGHT = 452;

let win = null;
let store = null;
// 本地 token 用量采集（日/周/月/年图表的数据源）。跟着 data 目录走，见 resolveHistory()。
let history = null;
let saveTimer = null;
let tray = null;
// 托盘菜单的「退出」是唯一真正的退出路径；点关闭按钮只隐藏。
// 用这个标志把「用户主动退出」和「窗口被关掉」区分开，否则 app.quit() 会被
// close 事件里的 preventDefault 拦下来，变成永远退不掉。
let isQuitting = false;
let trayTip = 'Tally · 用量与积分';
// 面板是否被我们主动收起（托盘 / × / 最小化到托盘）。是置顶重放的闸门，
// 也是托盘菜单「显示/隐藏」文案的唯一依据 —— 不依赖 win.isVisible() 的瞬时值。
let panelHidden = false;
// 界面等比缩放：scale 同时是「窗口尺寸倍率」和「页面 zoomFactor」。
// baselineCssH 是渲染层实测上报的内容高度（CSS px，不受 zoom 影响），
// 窗口高度 = baselineCssH × scale，这样 CSS 视口始终是 400 × baselineCssH，
// 布局不变、只有每个像素变大 —— 才是真正的等比例，而不是把窗口拉宽后让内容重排。
let scale = 1;
let baselineCssH = WIN_HEIGHT;
// 拖动右下角时的状态（origin/起始倍率/轮询定时器），null = 没在拖
let scaleDrag = null;

function resolveStore() {
  // TALLY_DATA_DIR 可覆盖数据目录：用于自检时隔离配置、或同一份程序跑多套数据
  if (process.env.TALLY_DATA_DIR) {
    return new Store(process.env.TALLY_DATA_DIR, process.env.TALLY_DATA_DIR);
  }
  const root = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname + path.sep + '..';
  const base = path.join(root, 'data');
  return new Store(base, app.getPath('userData'));
}

function resolveIndex() {
  return path.join(__dirname, '..', 'dist', 'index.html');
}

/**
 * 用量历史的存放目录 —— 必须与 store 同目录，否则自检（TALLY_DATA_DIR）时
 * 采集数据会串到真实数据里。
 */
/**
 * 造一批假历史（只在 TALLY_MOCK_HISTORY=1 时调用），用来在没有真实累计数据时
 * 调图表样式与坐标轴。用**确定性**伪随机（按天做种子），每次启动曲线一致，方便对比截图。
 */
function seedMockHistory(h) {
  const DAYS = 120;
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  let oc = 0;
  let cc = 0;
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    // 周末少用一点，工作日多一点，做出肉眼可见的起伏
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const seed = (d.getFullYear() * 372 + (d.getMonth() + 1) * 31 + d.getDate()) % 97;
    const ocDay = Math.round((weekend ? 180000 : 520000) + seed * 12000);
    const ccDay = Math.round((weekend ? 60000 : 210000) + seed * 5200);
    oc += ocDay;
    cc += ccDay;
    // 单价与 usage-history.cjs 的 OC_USD_PER_MTOK 保持一致（OpenCode Go 的 DeepSeek V4.1 Flash 混合价）
    h.record('opencode', { tokens: oc, costUsd: (oc / 1e6) * 0.36, estimated: true }, d);
    h.record('commandcode', { tokens: cc, costUsd: (cc / 1e6) * 1.2 }, d);
  }
}

function resolveHistory() {
  const dir = process.env.TALLY_DATA_DIR
    ? process.env.TALLY_DATA_DIR
    : app.isPackaged
      ? path.join(path.dirname(app.getPath('exe')), 'data')
      : path.join(__dirname, '..', 'data');
  return new usageHistory.UsageHistory(dir);
}

// ---------- 窗口层级：两种模式，由 store.alwaysOnTop 决定 ----------
//
//   alwaysOnTop = false（默认）→ 贴桌面
//     面板常驻「桌面（壁纸/图标）之上、所有应用窗口之下」这一层。
//   alwaysOnTop = true → 永远浮在最前（连任务栏都盖住）
//
// ⚠️ 这一层语义**光靠 Electron 表达不出来**。alwaysOnTop=false 只是"不置顶"，
// 它并不把窗口放进桌面层 —— 普通窗口的 Z 序由"谁最后被激活"决定，所以用户点一下
// 面板（拖动、操作），它就被排到所有窗口之上，并且一直待在那儿不回落。这正是用户
// 反复报的「还是遮挡其他页面」：被动等待别人来盖，永远会漏。
//
// 真正的解法来自 TackIt（D:\workbuddy Project\Ticknote）：一个常驻的 PowerShell
// 守护进程（electron/desktop-keep.ps1，登记表见 services/desktop-keeper.cjs），
// 用 EnumWindows/SetWindowPos 主动把面板锚定在桌面层之上，并在面板不是前台时
// 无条件把它按回底部。主进程这边只负责"把当前应当可见的窗口告诉它"。
//
// 分工：
//   · 贴桌面模式 —— 全交给守护进程（主进程不碰 Z 序），它同时负责 Win+D 救援
//     （Win+D 后桌面抬升，面板会被压到壁纸下面，守护进程会临时顶到最前再降回来）。
//   · 置顶模式 —— 守护进程保证它常驻 TOPMOST；applyAlwaysOnTop() 保留，作为
//     守护进程不可用（PowerShell 被策略禁用等）时的降级路径。
//
// 历史坑：一开始只有置顶这一种模式，打包版配置里又留着 true，结果用户一开
// 资源管理器就被面板压住，反复报"遮挡文件夹和其他页面"。默认值已改为 false，
// 并在 store.migrate() 里做了一次性迁移。
//
// Windows 还会把置顶悄悄重置：切换显示器、副屏重连、分辨率变化、UAC 弹窗、
// 全屏程序退出都会让 Z 序重排，窗口就"掉"回普通层。所以置顶不设一次就算完，
// 统一走 applyAlwaysOnTop()，并在几个关键时机重放一遍。
const TOP_LEVEL = 'screen-saver';

// 把「当前应当可见的窗口」同步给 Z 序守护。
//
// ⚠️ 只登记可见的窗口，这一条不能省：守护脚本里的 SetWindowPos 带 SWP_SHOWWINDOW，
// 会把隐藏的窗口重新显示出来 —— 收进托盘的面板若留在登记表里，就会被它弹出回来，
// 正好复现旧的「点了 × 窗口闪一下又回来」bug。空列表 = 守护进程什么都不碰。
//
// 每 400ms 跑一次（守护进程侧同样是轮询），hide/show 等关键时机再立刻推一次，
// 免得等下一次 tick。
function syncDesktopKeeper() {
  if (!store) return;
  if (!win || win.isDestroyed() || panelHidden || win.isMinimized() || !win.isVisible()) {
    desktopKeeper.update([]);
    return;
  }
  desktopKeeper.update([{ win, topmost: Boolean(store.get('alwaysOnTop')) }]);
}

// TALLY_TOP_DEBUG=1 时把置顶相关的动作落盘，排查「被别的窗口盖住」这类问题时用
function topLog(msg) {
  if (process.env.TALLY_TOP_DEBUG !== '1' || !store) return;
  try {
    fs.appendFileSync(
      path.join(path.dirname(store.filePath), 'top.log'),
      `[${new Date().toISOString()}] ${msg}\n`
    );
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function applyAlwaysOnTop(on) {
  if (!win || win.isDestroyed()) return;
  if (!on) {
    // ⚠️ 贴桌面模式下不要无脑调 setAlwaysOnTop(false)：它底层走 HWND_NOTOPMOST，
    // 而 Windows 把 HWND_NOTOPMOST 解释成「移到所有非置顶窗口之上」—— 对一个本来就
    // 不是置顶的窗口，这等于把它临时提到最前面（守护进程 300ms 内会沉回去，但那
    // 是一次用户看得见的闪烁）。只在窗口真的是置顶状态时才需要取消。
    if (win.isAlwaysOnTop()) {
      win.setAlwaysOnTop(false);
      topLog('apply -> off (was topmost)');
    } else {
      topLog('apply -> off (already normal, no-op)');
    }
    return;
  }
  win.setAlwaysOnTop(false); // 先清掉，避免 level 叠加后被系统忽略
  win.setAlwaysOnTop(true, TOP_LEVEL);
  // 提到置顶层的最前面：能压住任务栏等其它同为 TOPMOST 的窗口
  win.moveTop();
  topLog(`apply -> on(${TOP_LEVEL}) focused=${win.isFocused()}`);
}

// 重放置顶。force=true 表示无条件重放 —— 用在「失焦 / 重新显示 / 显示器变化」
// 这些 Z 序随时会被系统重排的时机。不要只看 win.isAlwaysOnTop()：它仅反映
// Electron 自己的标志位，Z 序被外部改掉时它照样返回 true。
//
// ⚠️ 必须先挡掉「面板已收起」的情况：win.hide() 会触发一次 blur，而 blur 里会
// 无条件重放置顶（setAlwaysOnTop + moveTop），在 Windows 上这会把已经隐藏的窗口
// 重新显示出来 —— 表现就是「点了 × 窗口闪一下又回来了」。
// 用自己维护的 panelHidden 而不是 win.isVisible()：blur 可能早于窗口状态更新，
// 那一刻 isVisible() 还是 true，拦不住。
function enforceTopmost(force) {
  if (!win || win.isDestroyed() || !store) return;
  if (!store.get('alwaysOnTop')) return;
  if (panelHidden) return;
  if (win.isMinimized()) return;
  if (!force && win.isAlwaysOnTop()) return;
  applyAlwaysOnTop(true);
}

// ---------- 界面等比缩放（拖右下角 / 设置里的滑块） ----------
//
// 「等比例放大缩小」= 窗口尺寸和页面缩放**一起**按同一个倍率变：
//     窗口宽  = WIN_WIDTH   × scale
//     窗口高  = 内容高(CSS)  × scale
//     zoomFactor = scale
// 三者同步的价值：CSS 视口恒为 400 × 内容高，**布局一帧都不变**，只是每个 CSS
// 像素变大/变小。只改窗口尺寸不改 zoom 会把内容拉成更宽的视口重排，那就不是等比了。
//
// 拖动交互由主进程驱动：按下后按 16ms 轮询鼠标位置。不用渲染层的 mousemove，
// 因为窗口尺寸一直在变，指针动不动就跑到窗口外，渲染层的事件流会断掉。
// 渲染层只负责「按下 / 松手」两个时刻。
const MIN_SCALE = 0.7;
const MAX_SCALE = 2;

// clamp 到「最小 ~ 最大」和「不超过当前显示器工作区」的交集。
// 上限跟着 baselineCssH 走：内容多的时候缩放上限会自动降低，窗口不会长到屏幕外。
function clampScale(next) {
  const n = Number(next);
  if (!Number.isFinite(n) || n <= 0) return scale;
  let wa = screen.getPrimaryDisplay().workArea;
  if (win && !win.isDestroyed()) {
    try {
      wa = screen.getDisplayMatching(win.getBounds()).workArea;
    } catch {
      /* 拿不到就退回主屏 */
    }
  }
  const byWidth = (wa.width - 12) / WIN_WIDTH;
  const byHeight = (wa.height - 12) / Math.max(160, baselineCssH);
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, byWidth, byHeight, n));
}

function applyScale(next) {
  if (!win || win.isDestroyed()) return;
  const s = clampScale(next);
  scale = s;

  const w = Math.round(WIN_WIDTH * s);
  const h = Math.round(Math.max(160, baselineCssH) * s);
  const [cx, cy] = win.getPosition();
  const wa = screen.getDisplayMatching({ x: cx, y: cy, width: w, height: h }).workArea;
  // 锚点保持左上角不动（拖右下角时这是最自然的），只在窗口要被推出屏幕时推回来。
  // 窗口被推回时会触发 moved -> 位置照样会存，不会丢。
  const x = Math.max(wa.x, Math.min(cx, wa.x + wa.width - w));
  const y = Math.max(wa.y, Math.min(cy, wa.y + wa.height - h));

  win.webContents.setZoomFactor(s);
  const cur = win.getBounds();
  if (cur.x !== x || cur.y !== y || cur.width !== w || cur.height !== h) {
    win.setBounds({ x, y, width: w, height: h });
  }
  // 渲染层靠这个数显示「125%」角标；页面还没加载完时发出去会被丢掉，无所谓
  win.webContents.send('window:scale-changed', s);
}

// 拖右下角 = 让窗口对角线跟着光标走：把光标位移投影到「基准对角线」方向上。
// 沿对角线拖 (WIN_WIDTH, baseH) 个像素时倍率恰好 +1，也就是角正好跟手。
function tickScaleDrag() {
  if (!scaleDrag || !win || win.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  const dx = p.x - scaleDrag.origin.x;
  const dy = p.y - scaleDrag.origin.y;
  const { baseW, baseH, startScale } = scaleDrag;
  applyScale(startScale + (baseW * dx + baseH * dy) / (baseW * baseW + baseH * baseH));
}

function beginScaleDrag() {
  if (!win || win.isDestroyed() || scaleDrag) return;
  scaleDrag = {
    origin: screen.getCursorScreenPoint(),
    startScale: scale,
    // 分母在拖动开始时定死：拖动中途 baselineCssH 变了也不会让手感突变
    baseW: WIN_WIDTH,
    baseH: Math.max(160, baselineCssH),
    timer: setInterval(tickScaleDrag, 16),
  };
  tickScaleDrag();
}

function endScaleDrag() {
  if (!scaleDrag) return;
  clearInterval(scaleDrag.timer);
  scaleDrag = null;
  applyScale(scale); // 用 clamp 后的最终值再校正一次
  if (store) store.set({ windowScale: scale });
  topLog(`scale -> ${scale.toFixed(3)}`);
}

function stopScaleDrag() {
  if (!scaleDrag) return;
  clearInterval(scaleDrag.timer);
  scaleDrag = null;
}

// ---------- 开机自启 ----------
//
// 走 Electron 的 app.setLoginItemSettings()。Windows 上它写的是
// HKCU\Software\Microsoft\Windows\CurrentVersion\Run 里一条以程序名为键的值，内容指向
// **Tally.exe 的绝对路径**。所以绿色版有个固有约束：**把程序目录挪了位置，这条就会失效**，
// 需要在设置里把开关关掉再打开一次来重建 —— 界面上有写。
//
// 只在打包版真正写注册表。开发模式下 process.execPath 是 node_modules 里的 electron.exe，
// 注册它毫无意义还会在用户注册表里留垃圾，所以那种情况直接返回失败，UI 会跟着回弹。
//
// 注册表是事实来源：用户可能在任务管理器「启动」页里把这条禁用掉，
// 光看配置里的布尔值会撒谎，所以启动时会拿实际状态对齐一次配置。
function autoStartTarget() {
  return process.execPath;
}

function readAutoStart() {
  try {
    return Boolean(app.getLoginItemSettings({ path: autoStartTarget() }).openAtLogin);
  } catch {
    return false;
  }
}

function applyAutoStart(on) {
  if (!app.isPackaged) {
    return { ok: false, reason: 'dev', message: '开发模式下不会写注册表，打包版才生效' };
  }
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(on), path: autoStartTarget(), args: [] });
    return { ok: true, actual: readAutoStart(), message: '' };
  } catch (err) {
    return { ok: false, reason: 'error', message: `写注册表失败：${err?.message || err}` };
  }
}

// ---------- 托盘 ----------
// 小组件常驻桌面，点关闭默认收进托盘而不是退出；托盘图标是「隐藏后怎么找回来」的唯一入口，
// 所以它必须先于窗口可用，且在任何情况下都不能创建失败导致窗口收不回来。
const TRAY_ICON_32 = path.join(__dirname, 'assets', 'tray-32.png');
const TRAY_ICON_16 = path.join(__dirname, 'assets', 'tray-16.png');

// 窗口 / 任务栏 / Alt-Tab 图标走多尺寸 ICO：Chromium 和系统会按 DPI 自己挑最合适的一档，
// 比只塞一张 PNG 再让系统缩放清楚得多。全部由 scripts/make-icons.mjs 生成。
const APP_ICON_ICO = path.join(__dirname, 'assets', 'icon.ico');
const APP_ICON_PNG = path.join(__dirname, 'assets', 'app-256.png');
const APP_ICON = fs.existsSync(APP_ICON_ICO) ? APP_ICON_ICO : APP_ICON_PNG;

function loadTrayImage() {
  try {
    const img = nativeImage.createFromPath(TRAY_ICON_32);
    if (img.isEmpty()) return null;
    // 补一份 1x 表示，100% 缩放下才是像素对齐的，不会被系统缩放出毛边
    try {
      const small = fs.readFileSync(TRAY_ICON_16);
      img.addRepresentation({ scaleFactor: 1, width: 16, height: 16, buffer: small });
    } catch {
      /* 没有 16px 版本也能用，只是高 DPI 下由系统缩放 */
    }
    return img;
  } catch {
    return null;
  }
}

function showPanel() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  panelHidden = false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  enforceTopmost(true);
  syncDesktopKeeper();
}

function hidePanel() {
  panelHidden = true;
  if (win && !win.isDestroyed()) win.hide();
  // 立刻从守护登记表里撤掉，别等下一次 tick：残留的 HWND 会被守护进程
  // 用 SWP_SHOWWINDOW 重新显示出来。
  syncDesktopKeeper();
}

function togglePanel() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (!panelHidden && win.isVisible() && !win.isMinimized()) hidePanel();
  else showPanel();
}

function buildTrayMenu() {
  const visible = !panelHidden && Boolean(win && !win.isDestroyed() && win.isVisible());
  return Menu.buildFromTemplate([
    { label: trayTip, enabled: false },
    { type: 'separator' },
    { label: visible ? '隐藏面板' : '显示面板', click: () => togglePanel() },
    {
      label: '立即领取今日积分',
      click: () => {
        showPanel();
        if (win && !win.isDestroyed()) win.webContents.send('tray:claim');
      },
    },
    { type: 'separator' },
    {
      label: '退出 Tally',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  if (win && !win.isDestroyed()) tray.setToolTip(trayTip);
  tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  if (tray && !tray.isDestroyed()) return tray;
  const image = loadTrayImage();
  if (!image) {
    console.error('[tally] 托盘图标加载失败，关闭窗口将改为直接退出');
    return null;
  }
  tray = new Tray(image);
  tray.setToolTip(trayTip);
  tray.setContextMenu(buildTrayMenu());
  // 左键单击：显示/隐藏。双击在部分 Windows 版本上也会触发单击，这里不额外处理双击。
  tray.on('click', () => togglePanel());
  return tray;
}

function destroyTray() {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

// 无头自检的统一退出路径。app.exit() 不跑 before-quit / will-quit，守护进程
// 收不掉就会变成孤儿 PowerShell（实测留下过两个），所以必须在这里显式收掉。
// keeper 侧还有"父进程已消失"的检测兜底，但那要等一个 tick，且要防 PID 复用。
function exitForTest(code) {
  desktopKeeper.stop();
  app.exit(code);
}

function createWindow() {
  const cfg = store.all();
  panelHidden = false;
  // 还原上次的缩放：窗口按倍率创建，zoom 等首帧渲染好（ready-to-show）再设，
  // 那样用户看不到「先按原大小画一帧再放大」的闪动。
  scale = clampScale(cfg.windowScale);
  const winW = Math.round(WIN_WIDTH * scale);
  const winH = Math.round(WIN_HEIGHT * scale);
  const { workArea } = screen.getPrimaryDisplay();

  let x, y;
  if (cfg.position && Number.isFinite(cfg.position.x) && Number.isFinite(cfg.position.y)) {
    x = cfg.position.x;
    y = cfg.position.y;
  } else {
    x = workArea.x + workArea.width - winW - 24;
    y = workArea.y + 24;
  }

  win = new BrowserWindow({
    width: winW,
    height: winH,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    alwaysOnTop: Boolean(cfg.alwaysOnTop),
    title: 'Tally',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 关键：面板常驻桌面层，会被别的窗口遮住 —— Chromium 的遮挡检测那时会暂停
      // 渲染管线，等 Win+D 救援把它拉回前台时画帧不恢复，窗口变成全透明"消失"。
      // 关掉节流保证随时有新帧。（TackIt 实测踩过，见 desktop-keep.ps1 顶部注释。）
      backgroundThrottling: false,
    },
  });

  // 小组件默认不开 DevTools，需要调试时用 TALLY_DEVTOOLS=1 启动
  if (!app.isPackaged && process.env.TALLY_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(resolveIndex());

  win.once('ready-to-show', () => {
    if (process.env.TALLY_TRAY_TEST === '1') console.log('[tray-test] ready-to-show fired');
    // 首帧已渲染、还没显示 —— 此刻设 zoom 最划算：用户看不到中间态
    applyScale(scale);
    win.setOpacity(Math.max(0.3, Math.min(1, Number(cfg.opacity) || 0.97)));
    // 构造函数里传的 alwaysOnTop 只拿到默认 level，这里按最强 level 再应用一次
    applyAlwaysOnTop(Boolean(cfg.alwaysOnTop));
    // 贴桌面模式用 showInactive()：不抢焦点。开机时把光标从用户正在用的窗口抢走很讨嫌，
    // 而面板本来就不该是"喊你看我"的角色。置顶模式是用户主动开的，保持 show()。
    if (cfg.alwaysOnTop) win.show();
    else win.showInactive();
    syncDesktopKeeper();
  });

  // 置顶时，失焦 / 重新显示都要重放一次，否则可能被系统降到普通层
  win.on('blur', () => {
    // 拖动中窗口不该失焦；真失焦了说明用户松手去了别处（或者 pointerup 丢了），
    // 不能继续粘着鼠标把面板越拖越小。
    endScaleDrag();
    enforceTopmost(true);
  });
  win.on('show', () => {
    panelHidden = false;
    enforceTopmost(true);
    refreshTrayMenu();
    syncDesktopKeeper();
  });
  win.on('hide', () => {
    panelHidden = true;
    refreshTrayMenu();
    syncDesktopKeeper();
  });
  win.on('minimize', () => {
    refreshTrayMenu();
    syncDesktopKeeper();
  });
  win.on('restore', () => {
    refreshTrayMenu();
    syncDesktopKeeper();
  });

  // 关闭按钮 = 收进托盘（默认行为）。只有走托盘菜单「退出 Tally」或系统关机时
  // isQuitting 才为 true，那时才真的让窗口关掉。
  win.on('close', (e) => {
    if (isQuitting) return;
    if (store && store.get('closeToTray') === false) return;
    e.preventDefault();
    hidePanel();
    topLog('close -> hide to tray');
  });

  win.on('moved', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const [wx, wy] = win.getPosition();
      store.set({ position: { x: wx, y: wy } });
    }, 400);
  });

  win.on('closed', () => {
    win = null;
    // 拖动定时器不能留着 —— 它每 16ms 摸一次鼠标，窗口没了就是纯浪费
    stopScaleDrag();
    // 窗口没了，登记表必须立刻清空 —— 残留的 HWND 会被守护进程用 SWP_SHOWWINDOW
    // 重新显示出来（一个没有主人的幽灵窗口）。
    syncDesktopKeeper();
  });

  // zoomFactor 是按 origin 记忆的，导航完成后补一次（幂等，防首帧那次没生效）
  win.webContents.on('did-finish-load', () => {
    if (win && !win.isDestroyed()) win.webContents.setZoomFactor(scale);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[tally] render-process-gone', JSON.stringify(details));
  });

  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[tally] did-fail-load ${code} ${desc} ${url}`);
  });

  // TALLY_TRAY_TEST=1：无头验证「关闭=收进托盘」与托盘回显。
  // 小组件没有窗口可点，这个钩子让关闭/恢复行为能被自动化断言，不用手点。
  // ⚠️ 跑这个测试要确保配置里的 alwaysOnTop 为 true —— 曾经的「关闭后窗口又弹回来」
  // 只在置顶开启时才复现（hide 触发 blur → 置顶重放把窗口显示回来）。
  if (process.env.TALLY_TRAY_TEST === '1') {
    const say = (...a) => console.log('[tray-test]', ...a);
    const state = () =>
      `visible=${win.isVisible()} minimized=${win.isMinimized()} panelHidden=${panelHidden}`;
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        say('trayCreated=' + Boolean(tray && !tray.isDestroyed()));
        say('alwaysOnTop=' + (store ? store.get('alwaysOnTop') : 'nostore'));
        say('before: ' + state());
        win.close();
        setTimeout(() => {
          say('afterClose: destroyed=' + win.isDestroyed() + ' ' + state());
          say('closeToTray=' + (store ? store.get('closeToTray') : 'nostore'));
          togglePanel();
          setTimeout(() => {
            say('afterTrayClick1: ' + state() + ' focused=' + win.isFocused());
            togglePanel();
            setTimeout(() => {
              say('afterTrayClick2: ' + state());
              isQuitting = true;
              app.quit();
            }, 900);
          }, 900);
        }, 900);
      }, 2500);
    });
  }

  // TALLY_KEEP_TEST=1：无头验证 Z 序守护的链路是否打通（PowerShell 能否 Add-Type、
  // 登记表是否写出、守护进程是否活着）。守护进程自己的决策流水在
  // %TEMP%\tally-keep.log（加 TALLY_KEEP_DEBUG=1 会逐 tick 打印判定输入）。
  // 真正的「谁在上面」断言要在外面用 Win32 读 Z 序，这里只确认链路通。
  if (process.env.TALLY_KEEP_TEST === '1') {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        const st = desktopKeeper.status();
        const dump = (label) => {
          let txt = '(文件不存在)';
          try {
            txt = JSON.stringify(fs.readFileSync(st.handlesFile, 'utf8'));
          } catch (err) {
            txt = `(读不到: ${err.code})`;
          }
          console.log(`[keep-test] ${label} handles=${txt}`);
        };
        console.log('[keep-test] running=' + st.running + ' pid=' + st.pid);
        console.log('[keep-test] script=' + desktopKeeper.SCRIPT);
        dump('visible');
        // 收进托盘 → 登记表必须清空，否则守护进程会用 SWP_SHOWWINDOW 把面板弹回来
        hidePanel();
        setTimeout(() => {
          dump('hidden');
          showPanel();
          setTimeout(() => {
            dump('reshown');
            isQuitting = true;
            exitForTest(0);
          }, 1200);
        }, 1200);
      }, 4000);
    });
  }

  // TALLY_SCALE_TEST=1：无头验证界面等比缩放 —— 窗口尺寸与 zoomFactor 是否同步、
  // 上下限 clamp 是否生效、右下角手柄的「按下/松手」事件链路是否通。不用真实鼠标。
  if (process.env.TALLY_SCALE_TEST === '1') {
    const say = (...a) => console.log('[scale-test]', ...a);
    const snap = (label) => {
      const b = win.getBounds();
      say(
        `${label} bounds=${b.width}x${b.height} ` +
          `zoom=${win.webContents.getZoomFactor().toFixed(3)} ` +
          `scale=${scale.toFixed(3)} baseCssH=${baselineCssH}`
      );
    };
    const dispatch = (js) =>
      win.webContents.executeJavaScript(js).then((r) => say('js ->', r)).catch((e) => say('js err', e.message));
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        snap('initial');
        applyScale(1.5);
        snap('apply 1.5');
        applyScale(99);
        snap('apply 99 (clamp high)');
        applyScale(0.1);
        snap('apply 0.1 (clamp low)');
        applyScale(1);
        snap('apply 1');

        // 精确验证拖动公式：把「当前光标位置」换成可控的假值再拖，否则真实鼠标
        // 只要动一下就会被算成拖动位移（第一次跑就是被这个干扰了）。
        // 期望：位移投影 / 基准对角线平方，即 dy 与 dx 加权。
        const realCursor = screen.getCursorScreenPoint.bind(screen);
        let fake = { x: 1000, y: 600 };
        try {
          screen.getCursorScreenPoint = () => fake;
        } catch (e) {
          say('cursor patch failed: ' + e.message);
        }
        applyScale(0.7);
        const bw = WIN_WIDTH;
        const bh = Math.max(160, baselineCssH);
        beginScaleDrag();
        fake = { x: 1000 + bw / 4, y: 600 + bh / 4 };
        tickScaleDrag();
        say(
          `drag formula: scale=${scale.toFixed(4)} expected=${(0.7 + 0.25).toFixed(4)} ` +
            `(moved ${(bw / 4).toFixed(0)},${(bh / 4).toFixed(0)} = 1/4 of baseline diag)`
        );
        fake = { x: 1000, y: 600 };
        tickScaleDrag();
        say(`drag back to origin: scale=${scale.toFixed(4)} expected=0.7000`);
        endScaleDrag();
        say('saved after drag=' + (store ? store.get('windowScale') : 'nostore'));

        dispatch(`
          (() => {
            const g = document.querySelector('.resize-grip');
            if (!g) return 'no-grip';
            const r = g.getBoundingClientRect();
            g.dispatchEvent(new PointerEvent('pointerdown', {
              bubbles: true, cancelable: true, button: 0, buttons: 1,
              pointerId: 1, isPrimary: true, pointerType: 'mouse',
              clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
            }));
            return 'pointerdown dispatched';
          })()
        `);
        setTimeout(() => {
          say('after down: dragging=' + Boolean(scaleDrag));
          dispatch(`(window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })), 'pointerup dispatched')`);
          setTimeout(() => {
            say(
              'after up: dragging=' + Boolean(scaleDrag) + ' saved=' +
                (store ? store.get('windowScale') : 'nostore')
            );
            screen.getCursorScreenPoint = realCursor;
            exitForTest(0);
          }, 600);
        }, 700);
      }, 3500);
    });
  }

  // TALLY_ICON_TEST=1：无头验证图标资产能被 Chromium 正确解码（ICO 是否真的多尺寸、
  // 各档 PNG 是否齐全）。图标本身在这台机器上肉眼看不到（窗口无边框 + skipTaskbar），
  // 只能靠这条钩子断言「文件是好的」。
  if (process.env.TALLY_ICON_TEST === '1') {
    app.whenReady().then(() => {
      const ico = nativeImage.createFromPath(APP_ICON_ICO);
      console.log('[icon-test] using:', path.basename(APP_ICON));
      console.log(`[icon-test] icon.ico empty=${ico.isEmpty()} size=${JSON.stringify(ico.getSize())}`);
      for (const s of [16, 24, 32, 48, 64, 128, 256]) {
        const p = path.join(__dirname, 'assets', `app-${s}.png`);
        const im = fs.existsSync(p) ? nativeImage.createFromPath(p) : null;
        console.log(
          `[icon-test] app-${s}.png exists=${Boolean(im)} empty=${im ? im.isEmpty() : '-'} ` +
            `size=${im ? JSON.stringify(im.getSize()) : '-'}`
        );
      }
      for (const s of [16, 32]) {
        const im = nativeImage.createFromPath(path.join(__dirname, 'assets', `tray-${s}.png`));
        console.log(`[icon-test] tray-${s}.png empty=${im.isEmpty()} size=${JSON.stringify(im.getSize())}`);
      }
      const trayImg = loadTrayImage();
      console.log(`[icon-test] loadTrayImage -> ${trayImg ? 'ok' : 'null'}`);
      exitForTest(0);
    });
  }

  // TALLY_EXEICON_TEST=1：提取 exe 自身的「文件图标」（走 Windows shell 的 app.getFileIcon），
  // 落盘成 PNG。打包脚本往 PE 资源里写了图标，但只有这一步能证明「资源管理器里真的会显示它」。
  // 同时测一份临时副本 —— shell 的图标缓存是按路径缓存的，副本能绕开缓存、看到当前内容。
  if (process.env.TALLY_EXEICON_TEST === '1') {
    app.whenReady().then(async () => {
      const os = require('node:os');
      const outDir = process.env.TALLY_EXEICON_OUT || path.join(__dirname, '..', 'snapshots');
      fs.mkdirSync(outDir, { recursive: true });
      const self = process.execPath;
      const copy = path.join(os.tmpdir(), `tally-exeicon-${process.pid}.exe`);
      const lines = [];
      for (const kind of ['self', 'copy']) {
        const target = kind === 'self' ? self : copy;
        try {
          if (kind === 'copy') fs.copyFileSync(self, copy);
          for (const size of ['small', 'normal', 'large']) {
            const img = await app.getFileIcon(target, { size });
            const s = img.getSize();
            const file = path.join(outDir, `exe-icon-${kind}-${size}.png`);
            fs.writeFileSync(file, img.toPNG());
            lines.push(
              `${kind}/${size}: ${s.width}x${s.height} pngBytes=${fs.statSync(file).size} ` +
                `empty=${img.isEmpty()}`
            );
          }
        } catch (e) {
          lines.push(`${kind}: ERR ${e.message}`);
        }
      }
      try {
        fs.rmSync(copy, { force: true });
      } catch {
        /* 副本删不掉也不影响结论 */
      }
      for (const l of lines) console.log('[exe-icon-test]', l);
      exitForTest(0);
    });
  }

  // TALLY_SMOKE=1 时：等页面稳定后自己截图落盘再退出，便于无头验证视觉与取数结果
  if (process.env.TALLY_SMOKE === '1') {
    win.webContents.once('did-finish-load', async () => {
      try {
        await new Promise((r) =>
          setTimeout(r, Number(process.env.TALLY_SMOKE_DELAY || 4000))
        );
        // 可选：截图前先执行一段页面脚本（例如点开设置面板），用于验证交互后的状态
        if (process.env.TALLY_SMOKE_EVAL) {
          await win.webContents.executeJavaScript(process.env.TALLY_SMOKE_EVAL);
          await new Promise((r) => setTimeout(r, 1500));
        }
        const image = await win.webContents.capturePage();
        const out =
          process.env.TALLY_SMOKE_OUT || path.join(__dirname, '..', '.smoke.png');
        fs.writeFileSync(out, image.toPNG());
        console.log('[tally] smoke screenshot ->', out);
      } catch (err) {
        console.error('[tally] smoke failed', err);
      } finally {
        exitForTest(0);
      }
    });
  }
}

function registerIpc() {
  ipcMain.handle('config:get', () => store.all());

  ipcMain.handle('config:set', (_e, patch) => {
    const clean = {};
    if (Array.isArray(patch?.opencodeProfiles)) {
      clean.opencodeProfiles = sanitizeProfiles(patch.opencodeProfiles);
    }
    if (typeof patch?.activeProfileId === 'string') {
      clean.activeProfileId = patch.activeProfileId.trim();
    }
    if (Number.isFinite(patch?.refreshSeconds)) {
      clean.refreshSeconds = Math.max(20, Math.min(1800, Math.round(patch.refreshSeconds)));
    }
    if (Number.isFinite(patch?.opacity)) {
      clean.opacity = Math.max(0.3, Math.min(1, patch.opacity));
      if (win && !win.isDestroyed()) win.setOpacity(clean.opacity);
    }
    if (typeof patch?.alwaysOnTop === 'boolean') {
      clean.alwaysOnTop = patch.alwaysOnTop;
      applyAlwaysOnTop(patch.alwaysOnTop);
    }
    if (typeof patch?.autoCheckin === 'boolean') clean.autoCheckin = patch.autoCheckin;
    if (typeof patch?.closeToTray === 'boolean') clean.closeToTray = patch.closeToTray;
    // 开机自启：注册表写成功才认这个开关。写不进去（开发模式 / 权限被拒）就把它退回 false，
    // 免得界面上亮着「已开启」而实际什么都没发生 —— 同时把原因回给渲染层提示。
    let autoStartError = '';
    if (typeof patch?.autoStart === 'boolean') {
      const r = applyAutoStart(patch.autoStart);
      clean.autoStart = r.ok ? patch.autoStart : false;
      if (!r.ok) autoStartError = r.message || '开机自启未能生效';
    }
    if (Number.isFinite(patch?.windowScale)) {
      clean.windowScale = clampScale(patch.windowScale);
      applyScale(clean.windowScale);
    }
    // commandcode：独立服务的 API Key 与显示开关
    if (typeof patch?.commandCodeKey === 'string') clean.commandCodeKey = patch.commandCodeKey.trim();
    if (typeof patch?.showCommandCode === 'boolean') clean.showCommandCode = patch.showCommandCode;
    // token 用量图表的折叠状态
    // ⚠️ 这里是**白名单**：新配置项必须同时加进 DEFAULTS 和这里，否则界面改了会被静默丢弃
    if (typeof patch?.showUsageChart === 'boolean') clean.showUsageChart = patch.showUsageChart;

    let next = store.set(clean);
    // 删掉了当前激活账号（或列表被清空）时，自动回落到第一条，避免面板空转
    if (!next.opencodeProfiles.some((p) => p.id === next.activeProfileId)) {
      next = store.set({ activeProfileId: next.opencodeProfiles[0]?.id || '' });
    }
    // 层级模式可能刚从置顶切到贴桌面（或反过来），立刻把新意图推给守护进程，
    // 别让用户看到 400ms 的中间状态。
    syncDesktopKeeper();
    return { ok: true, config: next, autoStartError };
  });

  // 把 OpenCode 的窗口状态压成一句话，用来解释「曲线为什么不动」。
  // 实测 2026-10-08：weekly.status = 'rate-limited' 且 percent=100 时，
  // 该账号的请求会被上游全部拒绝 → 月度消耗自然停住，曲线看起来"坏了"，其实是额度打满。
  function summarizeOpenCodeNote(windows) {
    const list = Array.isArray(windows) ? windows : [];
    const byKey = (k) => list.find((w) => w.key === k);
    const week = byKey('week');
    if (week && (week.status === 'rate-limited' || week.percent >= 100)) {
      return '本周额度已用满';
    }
    const anyLimited = list.find((w) => w.status && w.status !== 'ok');
    if (anyLimited) return `${anyLimited.label || anyLimited.key} 受限`;
    return null;
  }

  // 单个账号取数。TALLY_MOCK_USAGE=1 时按账号序号造不同样本（默认关闭，不影响正式取数），
  // 用来在没有真实 Key 时验证解析器、阈值配色以及多账号切换的排版。
  async function fetchOne(profile, index) {
    const started = Date.now();
    if (process.env.TALLY_MOCK_USAGE === '1') {
      const hours = (n) => new Date(Date.now() + n * 3600_000).toISOString();
      // 结构与 2026-09-21 实测的真实响应一致（上台阶的 add/use 流程会变，这里只求结构相同）
      const pct = [8, 63, 87][index % 3];
      const mock = {
        usage: {
          rolling: { status: 'ok', percent: pct, resetsAt: hours(3.4) },
          weekly: { status: 'ok', percent: pct, resetsAt: hours(58) },
          monthly: { status: 'ok', percent: pct },
        },
      };
      const normalized = opencode.normalize(mock);
      return {
        ok: true,
        fetchedAt: new Date().toISOString(),
        windows: normalized.windows,
        recognized: normalized.recognized,
        raw: JSON.stringify(mock, null, 2),
        elapsedMs: Date.now() - started,
        mock: true,
      };
    }
    const result = await opencode.fetchUsage(profile.apiKey);
    return { ...result, elapsedMs: Date.now() - started };
  }

  ipcMain.handle('usage:fetch', async (_e, profileId) => {
    const profiles = store.get('opencodeProfiles') || [];
    const wanted =
      typeof profileId === 'string' && profileId ? profileId : store.get('activeProfileId');
    const index = Math.max(0, profiles.findIndex((p) => p.id === wanted));
    const profile = profiles[index];
    if (!profile) {
      return { ok: false, reason: 'no-key', message: '未配置 OpenCode Go API Key', elapsedMs: 0 };
    }
    return { ...(await fetchOne(profile, index)), profileId: profile.id };
  });

  // 一次拉全部账号：各账号并发，单个账号失败不影响其它账号
  ipcMain.handle('usage:fetchAll', async () => {
    const started = Date.now();
    const profiles = store.get('opencodeProfiles') || [];
    const map = {};
    await Promise.all(
      profiles.map(async (p, i) => {
        try {
          map[p.id] = { ...(await fetchOne(p, i)), profileId: p.id };
        } catch (err) {
          map[p.id] = {
            ok: false,
            reason: 'network',
            message: `取数异常：${err?.message || err}`,
            profileId: p.id,
          };
        }
      })
    );

    // 本地采集：OpenCode 没有 token 字段，只能用「本月已用金额 × 单价」估一个 token 数，
    // 仅用于趋势对比（窗口里 used 本身就是按套餐折算来的近似值）。
    // 多账号时取**已用金额最大**的那条代表当前账号，避免切号把曲线抖出锯齿。
    try {
      const oks = Object.values(map).filter((r) => r?.ok && Array.isArray(r.windows));
      if (oks.length) {
        let best = null;
        let bestWindows = null;
        for (const r of oks) {
          const s = usageHistory.fromOpenCode(r.windows);
          if (s.costUsd != null && (best == null || s.costUsd > best.costUsd)) {
            best = s;
            bestWindows = r.windows;
          }
        }
        if (best && best.tokens != null) {
          history.record('opencode', { ...best, note: summarizeOpenCodeNote(bestWindows) });
        }
      }
    } catch (err) {
      console.error('[tally] 记录 opencode 用量失败', err);
    }

    return { map, elapsedMs: Date.now() - started, profileCount: profiles.length };
  });

  // commandcode 额度：独立服务，单个 API Key（config.commandCodeKey）
  ipcMain.handle('cc:fetch', async () => {
    const started = Date.now();
    const key = store.get('commandCodeKey') || '';
    if (process.env.TALLY_MOCK_CC === '1') {
      // 结构与 2026-10-07 实测的真实响应一致（Go v1 套餐）
      const mock = {
        credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 10, purchasedCredits: 0, freeCredits: 0 },
        windowLimits: {
          limited: true,
          exceeded: null,
          fiveHour: { used: 0.66, cap: 3, exceeded: false, resetAt: Date.now() + 2.1 * 3600_000 },
          weekly: { used: 2.7, cap: 6, exceeded: false, resetAt: Date.now() + 70 * 3600_000 },
        },
        sandboxAccess: false,
        sandboxMinutes: null,
      };
      const normalized = commandcode.normalize(mock);
      return {
        ok: true,
        fetchedAt: new Date().toISOString(),
        windows: normalized.windows,
        summary: normalized.summary,
        plan: { planId: 'individual-go-v1', label: 'Go（v1）', status: 'active', currentPeriodEnd: null, cancelAtPeriodEnd: false },
        recognized: normalized.recognized,
        raw: JSON.stringify(mock, null, 2),
        elapsedMs: Date.now() - started,
        mock: true,
      };
    }
    const result = await commandcode.fetchUsage(key);

    // 本地采集：commandcode 的 /alpha/usage/summary 直接给 totalTokens（真实值，不用估）。
    // 它是 billing-period 累计，正好适合「每天记一条、差值算当天用量」的采集模型。
    // 采样失败不影响主流程（额度块照常显示）。
    try {
      if (result?.ok) {
        const summary = await commandcode.fetchTokenSummary(key);
        if (summary?.ok && summary.tokens != null) {
          history.record('commandcode', {
            tokens: summary.tokens,
            costUsd: summary.costUsd,
            estimated: false,
            note: summarizeCommandCodeNote(result, summary),
          });
        }
      }
    } catch (err) {
      console.error('[tally] 记录 commandcode 用量失败', err);
    }

    return { ...result, elapsedMs: Date.now() - started };
  });

  // commandcode 的状态一句话。实测 2026-10-08：刚开通的账号 totalTokens 恒为 0
  // （一次都没调用过），曲线平在 0 是真实情况。
  function summarizeCommandCodeNote(result, summary) {
    const week = (result?.windows || []).find((w) => w.key === 'week');
    if (week && week.limit > 0 && Number.isFinite(week.used) && week.used >= week.limit) {
      return '本周额度已用满';
    }
    if (Number.isFinite(summary?.tokens) && summary.tokens === 0) {
      // 从未用过：Key 有效但一次都没调用
      return '尚无调用记录';
    }
    return null;
  }

  // 用量历史（日/周/月/年）：纯本地数据，不联网。
  ipcMain.handle('usage:history', () => history.snapshot());

  // refresh=true 时重新探测登录态文件位置（用户刚登录完客户端后点「重新检测」用）
  ipcMain.handle('checkin:status', async (_e, opts) =>
    workbuddy.getStatus({ refresh: Boolean(opts?.refresh) })
  );
  ipcMain.handle('checkin:claim', async () => workbuddy.claim());
  ipcMain.handle('checkin:balance', async () => workbuddy.getBalance());
  ipcMain.handle('checkin:diagnose', async (_e, opts) =>
    workbuddy.diagnose({ refresh: Boolean(opts?.refresh) })
  );

  ipcMain.handle('window:minimize', () => {
    if (win && !win.isDestroyed()) win.minimize();
  });

  // 关闭按钮：走 win.close()，让 close 事件决定是收进托盘还是真退出
  ipcMain.handle('window:close', () => {
    if (win && !win.isDestroyed()) win.close();
  });

  // 渲染层把摘要（余额/连续天数）推给托盘 tooltip，鼠标悬停就能看，不用打开面板
  ipcMain.handle('tray:tip', (_e, text) => {
    if (typeof text !== 'string') return;
    trayTip = `Tally · ${text}`.slice(0, 120);
    refreshTrayMenu();
  });

  // 按渲染层实测内容高度调整窗口，避免固定高度造成留白或裁切。
  // ⚠️ 上报的是**未缩放的 CSS 高度**（getBoundingClientRect 不受 zoom 影响），
  // 所以这个值在缩放前后一样 —— 窗口实际高度 = 它 × scale。
  ipcMain.handle('window:height', (_e, requested) => {
    if (!win || win.isDestroyed()) return;
    const want = Math.round(Number(requested));
    if (!Number.isFinite(want)) return;
    baselineCssH = Math.max(120, Math.min(1200, want));
    if (scaleDrag) return; // 拖动中尺寸归拖动管，别跟它抢
    const w = Math.round(WIN_WIDTH * scale);
    const h = Math.round(baselineCssH * scale);
    const cur = win.getBounds();
    // 宽度对不上说明倍率刚变过：交给 applyScale 连位置一起重算，避免右边缘跑出屏幕
    if (cur.width !== w) {
      applyScale(scale);
      return;
    }
    if (Math.abs(cur.height - h) < 2) return;
    win.setBounds({ width: w, height: h });
  });

  // 拖动右下角：渲染层只负责报告「按下 / 松手」两个时刻，中间位移由主进程
  // 轮询鼠标自己算（窗口尺寸在变，指针会跑出窗口，渲染层的事件流靠不住）。
  ipcMain.handle('window:scale-start', () => beginScaleDrag());
  ipcMain.handle('window:scale-end', () => endScaleDrag());
  ipcMain.handle('window:hide', () => hidePanel());
  ipcMain.handle('window:quit', () => {
    isQuitting = true;
    app.quit();
  });
  ipcMain.handle('shell:open', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    configPath: path.join(path.dirname(store.filePath), 'config.json'),
    tokenPath: workbuddy.tokenFilePath(),
    electron: process.versions.electron,
    packaged: app.isPackaged,
  }));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 重复启动：把已有窗口叫回前台，而不是开第二个
    showPanel();
  });

  app.whenReady().then(() => {
    store = resolveStore();
    // 本地用量采集（日/周/月/年曲线）。上游没有 Key 可用的时序接口，只能自己攒，
    // 见 usage-history.cjs 顶部说明。TALLY_MOCK_HISTORY=1 时造一批假历史，方便调图表样式。
    history = resolveHistory();
    if (process.env.TALLY_MOCK_HISTORY === '1') seedMockHistory(history);
    // WorkBuddy 凭据自持：客户端新版把登录态加密后我们读不到 token，改成拿 refreshToken
    // 自己去 /v2/plugin/auth/token/refresh 续期（见 workbuddy.cjs 顶部说明）。
    // 凭据存在本目录 data/config.json —— 自用版含真凭据，禁止外发。
    workbuddy.setCredentialIO({
      read: () => store.get('wbCredential') || null,
      write: (cred) => store.set({ wbCredential: cred }),
      clear: () => store.set({ wbCredential: null }),
    });
    // Z 序守护：登记表放在 data 目录下（跟着 TALLY_DATA_DIR 走，自检互不干扰），
    // 守护进程的日志固定写 %TEMP%\tally-keep.log。
    // TALLY_KEEP_DEBUG=1 会被 spawn 出来的 PowerShell 继承，打开逐 tick 决策日志。
    desktopKeeper.configure({
      handlesFile: path.join(path.dirname(store.filePath), 'panel-handles.txt'),
      log: (...a) => console.log(...a),
    });

    // 开机自启：注册表才是事实来源。用户可能在任务管理器「启动」页里禁用掉那条，
    // 配置里的 true 就成了谎话 —— 启动时对齐一次，界面显示的就是真实状态。
    if (app.isPackaged) {
      const actualAutoStart = readAutoStart();
      if (Boolean(store.get('autoStart')) !== actualAutoStart) {
        console.log(
          `[tally] 开机自启状态对齐：配置 ${store.get('autoStart')} -> 实际 ${actualAutoStart}`
        );
        store.set({ autoStart: actualAutoStart });
      }
    }

    // TALLY_AUTOSTART_TEST=1：无头验证开机自启的注册表读写。
    // 打印打包态 / 可执行文件路径 / 当前状态，然后「开 → 读回 → 关 → 读回」，
    // 最后恢复成进入测试时的原始状态（不留副作用）。
    // 开发模式下 applyAutoStart 会拒绝写注册表 —— 这里照样跑一遍，确认护栏真的拦住了。
    if (process.env.TALLY_AUTOSTART_TEST === '1') {
      const say = (...a) => console.log('[autostart-test]', ...a);
      say(`packaged=${app.isPackaged}`);
      say(`execPath=${autoStartTarget()}`);
      const original = readAutoStart();
      say(`original openAtLogin=${original}`);
      const on = applyAutoStart(true);
      say(`set true  ok=${on.ok} reason=${on.reason || '-'} readBack=${readAutoStart()}`);
      const off = applyAutoStart(false);
      say(`set false ok=${off.ok} reason=${off.reason || '-'} readBack=${readAutoStart()}`);
      const back = applyAutoStart(original);
      say(`restore ${original} ok=${back.ok} readBack=${readAutoStart()}`);
      say('done');
      exitForTest(0);
      return;
    }

    registerIpc();
    const t = createTray();
    createWindow();

    // 守护进程内部按 ~300ms 轮询 Z 序；这边 400ms 推一次「当前应当可见的窗口」，
    // 内容没变时不写盘（desktop-keeper.cjs 里做了去重）。
    setInterval(syncDesktopKeeper, 400);

    // TALLY_AUTOQUIT_MS=8000：到点自动退出。无头验证（Z 序 / 置顶 / 托盘）时用，
    // 免得测试跑完在机器上留一个占着单例锁的幽灵实例。
    if (process.env.TALLY_AUTOQUIT_MS) {
      const ms = Math.max(1000, Number(process.env.TALLY_AUTOQUIT_MS) || 8000);
      setTimeout(() => {
        isQuitting = true;
        exitForTest(0);
      }, ms);
    }
    // 托盘创建失败时，close 事件里仍会 preventDefault 把窗口藏起来 —— 那样就再也找不回来了，
    // 所以这里把配置降级：没有托盘就退回「关闭即退出」。
    if (!t && store.get('closeToTray') !== false) {
      console.error('[tally] 无托盘，closeToTray 自动置为 false');
      store.set({ closeToTray: false });
    }

    // 副屏重连 / 分辨率变化 / 显示器增删后，Z 序会被系统重排，这里重放置顶
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.on(ev, () => enforceTopmost(true));
    }

    // 置顶模式的降级兜底：Z 序正常由守护进程维持（它每 ~300ms 检查一次并重放）。
    // 这条 8 秒重放只在守护进程不可用（PowerShell 被策略禁用等）时才有意义，
    // 所以它只处理 alwaysOnTop=true；贴桌面模式**绝不能**走这里 ——
    // 把非置顶窗口反复提到前面，正是「遮挡其他页面」的老毛病。
    // 窗口自己是前台时跳过：那时用户正在面板里操作，不能去抢输入法候选框。
    setInterval(() => {
      if (!win || win.isDestroyed() || !store) return;
      if (!store.get('alwaysOnTop')) return;
      if (panelHidden) return; // 收在托盘里就别去动 Z 序
      if (win.isFocused()) return;
      if (!win.isVisible() || win.isMinimized()) return;
      applyAlwaysOnTop(true);
    }, 8000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // isQuitting 必须在这里置位：这是所有退出路径（菜单、系统注销、任务管理器）的唯一收口，
  // 放晚了会被 close 事件的 preventDefault 拦成"退不掉"。
  app.on('before-quit', () => {
    isQuitting = true;
    // 守护进程自己会检测父进程存活并退出（app.exit() 这类路径不跑任何 handler），
    // 这里主动收一次只是在正常退出路径上少等一个 tick。
    desktopKeeper.stop();
  });

  // 关机 / 注销：Windows 直接发 session-end，不一定经过 before-quit。
  // 不接这个的话 close 事件里的 preventDefault 会把系统关机卡住。
  app.on('session-end', () => {
    isQuitting = true;
  });

  app.on('will-quit', () => {
    stopScaleDrag();
    desktopKeeper.stop();
    destroyTray();
  });

  app.on('window-all-closed', () => {
    // 收进托盘时窗口只是 hide，不会走到这里。能走到这里说明窗口是真关掉了：
    // 要么从托盘菜单退出，要么用户自己关掉了「关闭时最小化到托盘」。
    if (isQuitting) {
      app.quit();
      return;
    }
    if (store && store.get('closeToTray') === false) {
      isQuitting = true;
      app.quit();
    }
  });
}
