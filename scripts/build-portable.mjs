// 统一打包脚本：自用版与分发版走同一条路径，避免两边代码不同步。
//
// ⛔ 铁律：执行本脚本前必须先征得用户明确同意。
//    出包 = 覆盖 release/ 下的可执行目录（约 370 MB），会直接改变用户手上正在用的程序。
//    未经同意不要跑，也不要"顺手"跑。
//
// 用法：
//   node scripts/build-portable.mjs            → release/Tally        自用版（保留 data/config.json）
//   node scripts/build-portable.mjs --share    → release/Tally-share  分发版（空白配置，可安全外发）
//   node scripts/build-portable.mjs --full     → 强制重装 Electron 运行时（默认已存在就跳过）
//
// 为什么要统一：之前「自用版」是手敲 Copy-Item 同步、「分发版」走脚本，结果自用版里的
// electron/ 一直是旧代码（用户拿到手的绿色版功能就是旧的）。现在两条路只能走这一个脚本。
//
// 脚本末尾会逐文件比对源与产物的大小/时间，任何一处不一致直接报错退出 —— 这是
// 「程序没更新」这类问题的硬闸门。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchExeResources, verifyExeResources } from './set-exe-resources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv.includes('--share') ? 'share' : 'self';
const force = process.argv.includes('--full');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
// 与界面上的 fmtVersion 保持同一口径：0.11.0 -> 0.11
const versionLabel = version.replace(/\.0$/, '');
const productName = pkg.productName || 'Tally';
const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name || '';

const outRoot = path.join(root, 'release', mode === 'share' ? `${productName}-share` : productName);
const appDir = path.join(outRoot, 'resources', 'app');
const exePath = path.join(outRoot, `${productName}.exe`);

const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

function assertExists(p, what) {
  if (!fs.existsSync(p)) fail(`缺少${what}：${p}\n  先在项目根跑一次 vite build 生成 dist/ 再执行本脚本。`);
}

log(`${productName} 打包 v${version} · 模式 ${mode === 'share' ? '分发版（空白配置）' : '自用版（保留配置）'}`);

// ---------- 0. 前置检查 ----------
assertExists(path.join(root, 'dist', 'index.html'), '渲染层产物 dist/index.html');
assertExists(path.join(root, 'electron', 'main.cjs'), '主进程 electron/main.cjs');
assertExists(
  path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  'Electron 运行时'
);

// exe 正在运行时，Windows 会锁住它 —— 写 PE 资源会 EBUSY，连 outRoot 都删不掉。
// 提前拦在这里，别等复制到一半才炸（那时 app 代码已经被替换，状态更脏）。
function isExeLocked(p) {
  if (!fs.existsSync(p)) return false;
  try {
    fs.closeSync(fs.openSync(p, 'r+'));
    return false;
  } catch (e) {
    return ['EBUSY', 'EPERM', 'EACCES'].includes(e.code);
  }
}
if (isExeLocked(exePath)) {
  fail(
    `${productName}.exe 正在运行，无法重建（Windows 会锁住运行中的 exe）。\n` +
      `  先退出它：右键托盘图标 →「退出 ${productName}」，\n` +
      `  或执行：taskkill /IM ${productName}.exe /F`
  );
}

// ---------- 1. 决定是否重建运行时 ----------
const needRuntime = force || !fs.existsSync(exePath);
if (needRuntime) {
  log('· 重建整包（含 Electron 运行时，约 370 MB）…');
  fs.rmSync(outRoot, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });
  fs.cpSync(path.join(root, 'node_modules', 'electron', 'dist'), outRoot, { recursive: true });
  fs.rmSync(path.join(outRoot, 'resources', 'default_app.asar'), { force: true });
  fs.renameSync(path.join(outRoot, 'electron.exe'), exePath);
} else {
  log(`· 运行时已就位，只同步应用代码（${path.relative(root, exePath)}）…`);
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });
}

// ---------- 2. 应用代码 ----------
log('· 复制应用代码…');
fs.cpSync(path.join(root, 'electron'), path.join(appDir, 'electron'), { recursive: true });
fs.cpSync(path.join(root, 'dist'), path.join(appDir, 'dist'), { recursive: true });
if (fs.existsSync(path.join(appDir, 'electron', 'electron'))) {
  fail('复制出现目录嵌套（resources/app/electron/electron），产物不可信。');
}
fs.writeFileSync(
  path.join(appDir, 'package.json'),
  JSON.stringify({ name: productName.toLowerCase(), productName, version, author, main: 'electron/main.cjs' }, null, 2),
  'utf8'
);

// ---------- 2b. 写 PE 资源（exe 自身的图标 + 版本信息）----------
// 资源管理器 / 快捷方式 / 属性对话框里看到的就是这里写进去的东西。
// 走 resedit（纯 JS 的 PE 资源编辑器），不用 rcedit 那类外部二进制。
// **每次打包都跑** —— exe 只在首次（或 --full）复制，但 PE 里的版本号要跟着 package.json 走。
// ⚠️ 副作用：会破坏 Electron 官方 exe 的数字签名，首次运行可能弹 SmartScreen（点「仍要运行」）。
const exeIconPath = path.join(root, 'electron', 'assets', 'icon.ico');
assertExists(exeIconPath, '应用图标 electron/assets/icon.ico（先跑 node scripts/make-icons.mjs）');
log('· 写入 exe 图标与版本信息…');
try {
  const r = patchExeResources({
    exePath,
    icoPath: exeIconPath,
    productName,
    description: `${productName} · 用量与积分面板`,
    company: author || 'GaryWang',
    copyright: `Copyright (C) ${new Date().getFullYear()} ${author || 'GaryWang'}`,
    version,
  });
  const v = verifyExeResources(exePath);
  log(
    `  ${(r.sizeAfter / 1024 / 1024).toFixed(0)} MB · 图标 ${v.iconCount} 档 · ` +
      `${v.ProductName} ${v.FileVersion} · ${v.CompanyName}`
  );
  if (v.ProductName !== productName || v.iconCount < 8 || v.FileVersion !== version) {
    fail(`PE 资源没写全（期望 ${productName} ${version} / ≥8 档图标）：${JSON.stringify(v)}`);
  }
} catch (e) {
  fail(`写 PE 资源失败：${e.message}`);
}

// ---------- 3. 配置 ----------
fs.mkdirSync(path.join(outRoot, 'data'), { recursive: true });
const cfgPath = path.join(outRoot, 'data', 'config.json');
const blankConfig = {
  opencodeProfiles: [],
  activeProfileId: '',
  refreshSeconds: 60,
  opacity: 0.97,
  locked: false,
  alwaysOnTop: false,
  position: null,
  autoCheckin: false,
  closeToTray: true,
};
if (mode === 'share') {
  log('· 写入空白 data/config.json（不含任何密钥）…');
  fs.writeFileSync(cfgPath, JSON.stringify(blankConfig, null, 2), 'utf8');
} else {
  // 自用版：不清空已有配置，没有就写一份默认值
  if (fs.existsSync(cfgPath)) {
    log('· 保留现有 data/config.json（自用配置未改动）');
  } else {
    log('· 新建默认 data/config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(blankConfig, null, 2), 'utf8');
  }
}

// ---------- 4. 使用说明 ----------
fs.writeFileSync(
  path.join(outRoot, '使用说明.txt'),
  `${productName} —— OpenCode Go 用量 + WorkBuddy 积分桌面小组件
作者：${author}    版本 V ${versionLabel}
=====================================================

启动
    双击 ${productName}.exe。窗口默认贴在桌面右上角，可拖动，位置会记住。
    右上角 × 默认只是把面板收进系统托盘（右下角通知区域），程序继续在后台跑，
    自动刷新和自动领取都不会停。想真正退出：右键托盘图标 →「退出 ${productName}」。
    托盘图标左键单击 = 显示 / 隐藏面板；鼠标悬停能直接看到积分余额。
    整个目录可随意搬动或删除。

左上角图标：窗口置顶 / 设置 / 最小化 / 关闭
    默认状态下面板是个「桌面小组件」：它待在桌面（壁纸和图标）之上、
    所有程序窗口之下。打开文件夹、浏览器、聊天窗口，都会把它们盖在面板上面，
    面板不挡任何活；点桌面（或按 Win+D 显示桌面）时它仍然在那儿。
    即使用鼠标点它、拖它，把它带到了最前面，它也会立刻自己沉回桌面层，
    绝不会一直压着 Windows 里的其它窗口。
    置顶开启后（左上角第一个图标）才会变成「永远浮在最上层」（连任务栏在内）：
    切换显示器、副屏重连，或被别的程序压下去时，它都会自己回到最前；
    你在面板里打字时不会去抢输入法候选框。一般不需要开这个。
    不想用托盘：设置里关掉「关闭窗口时最小化到托盘」，× 就恢复成直接退出。

界面大小
    拖动面板右下角的斜纹把手可以等比放大 / 缩小整个界面 —— 文字、间距、图标一起变，
    排版不变，松手时右下角会显示当前百分比。设置页里也有「界面缩放」滑块，
    以及一键回到 100% 的按钮。缩放上限会跟着屏幕大小自动收窄，保证窗口不出屏。
    倍率会记住，下次启动还是这个大小。

开机自启
    设置页里打开「开机自动启动」，登录 Windows 后会自动把面板放回上次的位置，
    不用每次手动双击。想关掉：关掉这个开关，或在任务管理器「启动」页里禁用 Tally。
    注意：自启记录里存的是 Tally.exe 的完整路径，所以如果你把这个文件夹挪到别处，
    需要把开关关掉再打开一次，让它记住新路径。


一、WorkBuddy 每日积分（需要自己装 WorkBuddy）
    本软件不保存你的 WorkBuddy 账号密码，它只是读取「WorkBuddy 桌面客户端
    在这台电脑上留下的登录态」来代你签到，所以：

      1. 在这台电脑上安装 WorkBuddy 桌面客户端（中国大陆版，接口域名为
         www.codebuddy.cn），并用你自己的账号登录一次；
      2. 打开 ${productName}，签到面板会自动读到你的账号，
         标题旁会显示你的昵称（例如「账号名 · 123****456」）；
      3. 面板里的「积分余额」就是账户当前可用的积分（所有资源包求和），
         下面的「本期累计」只统计本次签到活动期内的累计数，两者不是一回事；
      4. 点「领取今日积分」即可。

    若显示「未检测到 WorkBuddy 登录态」：
      · 确认客户端确实登录过（不是只装了没登录）；
      · 必须是同一个 Windows 用户 —— 换个 Windows 账号登录，凭据是不同的；
      · 登录完回到 ${productName}，点提示里的「重新检测」。

    关于登录态有效期：客户端每次启动会自动续期（约 60 天一个周期）。
    长期不开客户端，凭据会过期，届时重新登录一次即可。

    展开面板底部的「关联详情」，可以看到当前挂在哪个账号、凭据读自哪个文件、
    还剩多少天 —— 换人用 / 换电脑时靠它自查。

    提醒：签到的积分归「当前登录的 WorkBuddy 账号」，每人签自己的。


二、OpenCode Go 用量（需要自己的 API Key）
    本软件不含任何 API Key，首次使用请自行配置：
      1. 登录 https://opencode.ai 的 console，订阅 Go 后生成一个 API Key；
      2. 在 ${productName} 里点右上角滑杆图标 → 找到「OpenCode 账号」；
      3. 填一个备注名（例如「个人号」）+ 粘贴 Key → 点「添加」。

    额度挂在「订阅账号」上而不是挂在 Key 上，所以同一个账号生成的多个 Key
    数字会完全一样，填一条就够；不同账号才需要分别添加（最多 8 个）。
    多个账号时，用量面板上方会出现切换条，点一下即可切换。


三、数据放在哪
    所有配置都在本目录的 data/config.json，纯本地、不上传、不联网存任何东西。
    想重置就把 data 目录删掉，下次启动会自动重建。
    整个软件是绿色的：删掉这个文件夹就等于卸载干净，注册表里不留东西。


四、可能的疑问
    · 点了 × 之后程序不见了？→ 它收进托盘了，没退出。看右下角通知区域的那个图标；
      左键点一下就能把面板叫回来，右键 →「退出 ${productName}」才是真退出。
    · 面板全是横杠？→ 该账号还没配 Key，或 Key 无效，点「设置」里核对。
    · 积分余额一直是横杠？→ 90% 是登录态过期了，打开 WorkBuddy 客户端重新登录一次。
    · 余额和「本期累计」对不上？→ 正常的，余额是账户所有资源包的总剩余，
      「本期累计」只统计本次签到活动期内领到的分数。
    · 数据为什么不是实时？→ 默认 60 秒刷新一次，可在设置里改（20 秒 ~ 30 分钟）。
    · 能装到 U 盘里带着走吗？→ 可以，但 WorkBuddy 登录态属于「当前这台电脑」，
      换电脑要重新登录客户端才能签到。
    · 国际版 CodeBuddy/WorkBuddy 能用吗？→ 目前接口按中国大陆版（codebuddy.cn）
      实现，其它区域版本可能不通。
    · 首次运行时弹出「Windows 已保护你的电脑」？→ 这是 SmartScreen 对未签名程序的
      例行提示（本软件没有购买代码签名证书）。点「更多信息」→「仍要运行」即可，
      同一台电脑之后不再提示。右键 exe →「属性」里能看到产品名与版本号。


五、免责
    本软件通过读取本机客户端的登录态代你调用官方接口，属个人效率工具。
    请自行确认使用方式符合所在平台的服务条款。
`,
  'utf8'
);

// ---------- 5. 同步校验：产物必须和源逐文件一致 ----------
log('· 校验产物与源一致…');
const syncPairs = [
  'electron/main.cjs',
  'electron/preload.cjs',
  'electron/desktop-keep.ps1',
  'electron/services/store.cjs',
  'electron/services/opencode.cjs',
  'electron/services/workbuddy.cjs',
  'electron/services/desktop-keeper.cjs',
  'electron/assets/icon.ico',
  'electron/assets/app-256.png',
  'electron/assets/tray-16.png',
  'electron/assets/tray-32.png',
  'dist/index.html',
];
const mismatches = [];
for (const rel of syncPairs) {
  const src = path.join(root, rel);
  const dst = path.join(appDir, rel);
  if (!fs.existsSync(dst)) {
    mismatches.push(`${rel}：产物缺失`);
    continue;
  }
  const a = fs.statSync(src);
  const b = fs.statSync(dst);
  if (a.size !== b.size) mismatches.push(`${rel}：大小 ${a.size} ≠ ${b.size}`);
}
// dist/assets 文件名带构建哈希，逐个比对
const assets = fs.readdirSync(path.join(root, 'dist', 'assets'));
const outAssets = fs.existsSync(path.join(appDir, 'dist', 'assets'))
  ? fs.readdirSync(path.join(appDir, 'dist', 'assets'))
  : [];
for (const f of assets) {
  if (!outAssets.includes(f)) mismatches.push(`dist/assets/${f}：产物缺失`);
}
if (mismatches.length) {
  console.error('\n✗ 产物与源不一致（绿色版会跑旧代码）：');
  for (const m of mismatches) console.error('   ' + m);
  fail('重新执行本脚本；若仍失败，用 --full 强制重建。');
}
// 产物必须包含最新特征（防止改完源码忘了重新构建/打包）
const featureChecks = [
  ['electron/main.cjs', 'screen-saver', '置顶逻辑'],
  ['electron/main.cjs', 'showInactive', '贴桌面模式默认不抢焦点'],
  ['electron/main.cjs', 'TALLY_AUTOQUIT_MS', '自检自动退出钩子'],
  ['electron/main.cjs', 'createTray', '托盘 / 关闭最小化到托盘'],
  ['electron/main.cjs', 'APP_ICON_ICO', '应用图标 ICO 接线'],
  ['electron/main.cjs', 'syncDesktopKeeper', 'Z 序守护接线'],
  ['electron/services/desktop-keeper.cjs', 'ParentPid', 'Z 序守护进程管理'],
  ['electron/desktop-keep.ps1', 'SWP_NOOWNERZORDER', 'Z 序守护核心修复'],
  ['electron/desktop-keep.ps1', 'sunk-to-desktop-band', '面板主动沉底（不遮挡其他窗口）'],
  ['electron/services/store.cjs', 'topmostReviewed', '窗口层级一次性迁移'],
  ['electron/services/store.cjs', 'windowScale', '界面等比缩放（拖右下角）'],
  ['electron/services/store.cjs', 'autoStart', '开机自启'],
  ['electron/main.cjs', 'setLoginItemSettings', '开机自启写注册表'],
  ['electron/services/workbuddy.cjs', 'BALANCE_URL', '积分余额'],
];
for (const [rel, needle, why] of featureChecks) {
  const file = path.join(appDir, rel);
  const hay = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!hay.includes(needle)) fail(`产物不是最新版（${rel} 缺少${why}），请检查源文件后重新构建。`);
}

// 默认层级必须是「贴桌面」（alwaysOnTop 默认 false）。这是用户 2026-09-21 定的行为，
// 一旦被误改成 true，面板又会永久压住文件夹和浏览器窗口。
const storeTxt = fs.readFileSync(path.join(appDir, 'electron', 'services', 'store.cjs'), 'utf8');
if (!/alwaysOnTop:\s*false/.test(storeTxt)) {
  fail('DEFAULTS 里的 alwaysOnTop 不是 false —— 默认必须是「贴桌面」，否则会遮挡用户的文件夹窗口。');
}

// ---------- 6. 分发版安全闸门 ----------
if (mode === 'share') {
  log('· 扫描产物，确认没有残留密钥…');
  const KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}/g;
  const TEXT_EXT = new Set([
    '.json', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.css', '.html',
    '.txt', '.md', '.yml', '.yaml', '.map',
  ]);
  const hits = [];
  const stats = { files: 0, bytes: 0 };
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      const st = fs.statSync(full);
      stats.files += 1;
      stats.bytes += st.size;
      if (!TEXT_EXT.has(path.extname(ent.name).toLowerCase())) continue;
      if (st.size > 8 * 1024 * 1024) continue;
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const found = text.match(KEY_PATTERN);
      if (found) hits.push({ file: path.relative(outRoot, full), keys: [...new Set(found)] });
    }
  };
  walk(outRoot);
  if (hits.length) {
    console.error('\n✗ 产物中发现疑似 API Key，已中止（请勿分发）：');
    for (const h of hits) console.error(`   ${h.file}: ${h.keys.map((k) => k.slice(0, 10) + '…').join(', ')}`);
    fail('清理后再重新执行本脚本。');
  }
  const produced = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (produced.opencodeProfiles?.length) fail('data/config.json 里仍有账号条目，拒绝出包。');
  log(`  密钥扫描：干净（0 处命中，共 ${stats.files} 个文件 / ${(stats.bytes / 1024 / 1024).toFixed(1)} MB）`);
}

log('');
log(`✓ 完成：${outRoot}`);
log(`  版本 ${version} · 可执行文件 ${productName}.exe`);
log(`  同步校验：${syncPairs.length} 个源文件 + ${assets.length} 个 bundle 全部一致`);
if (mode === 'share') {
  log('');
  log('  下一步 —— 压缩成可发送的 zip：');
  log(`  Compress-Archive -Path "${outRoot}" -DestinationPath "${path.join(root, 'release', `${productName}-v${version}-share.zip`)}" -Force`);
}
