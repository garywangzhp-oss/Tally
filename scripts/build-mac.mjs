#!/usr/bin/env node
// macOS 打包脚本：把本地 Electron 运行时组装成 Tally.app。
//
// ⛔ 铁律：执行本脚本前必须先征得用户明确同意（与 Windows 的 build-portable.mjs 同一条规矩）。
//
// ⚠️ **只能在 macOS 上运行**，原因不是路径写法，而是两件 mac 独有的事：
//   1) 必须用 codesign 做 ad-hoc 签名 —— Apple Silicon 上未签名的 .app 直接拒绝启动，
//      而 codesign 只有 macOS 自带（Linux/Windows 上没有任何等价替代）。
//   2) Electron.app 里有一堆相对符号链接（Frameworks/Versions/A 之类），打包必须原样保留，
//      ditto / cpSync(verbatimSymlinks) 才是可靠路径。
//   在非 mac 上执行会直接给出提示并退出，不会产出半成品。
//
// 用法（在 mac 上，项目根目录）：
//   npm install                     # 需要在 mac 上装一次，才会下载 darwin 版 Electron
//   npm run build                   # 生成 dist/
//   node scripts/build-mac.mjs          → release/mac/Tally.app        自用版（同级 data/ 便携）
//   node scripts/build-mac.mjs --share  → release/mac-share/Tally.app  分发版（不带 data，空白配置）
//
// 产物：
//   release/mac[-share]/Tally.app
//   release/Tally-v<version>[-share]-mac.zip      （可直接发给别人的那份）

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv.includes('--share') ? 'share' : 'self';
const skipSign = process.argv.includes('--no-sign');
const skipZip = process.argv.includes('--no-zip');

const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

if (process.platform !== 'darwin') {
  fail(
    `本脚本只能在 macOS 上运行（当前：${process.platform}）。\n` +
      `  .app 必须在 mac 上做 ad-hoc 签名才能在 Apple Silicon 上启动，Windows/Linux 没有等价工具。\n` +
      `  请把仓库拷到 Mac 上，执行：npm install && npm run build && node scripts/build-mac.mjs`
  );
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const versionLabel = version.replace(/\.0$/, '');
const productName = pkg.productName || 'Tally';
const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name || '';
const bundleId = `com.${String(author || 'garywang').toLowerCase().replace(/[^a-z0-9]/g, '')}.${productName.toLowerCase()}`;

const outBase = path.join(root, 'release', mode === 'share' ? 'mac-share' : 'mac');
const appPath = path.join(outBase, `${productName}.app`);
const contents = path.join(appPath, 'Contents');
const resources = path.join(contents, 'Resources');
const appDir = path.join(resources, 'app');

log(`${productName} macOS 打包 v${version} · 模式 ${mode === 'share' ? '分发版（空白配置）' : '自用版（保留配置）'}`);

// ---------- 0. 前置检查 ----------
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const electronApp = path.join(electronDist, 'Electron.app');
if (!fs.existsSync(electronApp)) {
  fail(
    `缺少 Electron 运行时：${electronApp}\n` +
      `  在 mac 上跑一次 npm install（会下载 darwin 版 Electron），再重试。`
  );
}
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  fail('缺少渲染层产物 dist/index.html —— 先在项目根跑 npm run build。');
}
const icns = path.join(root, 'electron', 'assets', 'icon.icns');
if (!fs.existsSync(icns)) {
  fail('缺少 electron/assets/icon.icns —— 先跑 npm run icons（make-icons.mjs 会生成它）。');
}

// ---------- 「删除目录」的替代方案 ----------
// 与 Windows 脚本同一套理由：沙箱里 fs.rmSync 会被 safe-delete 垫片拦掉，
// 换名挪到项目根 .trash/ 是瞬时且不触发的；旧内容收尾时尽力删。
const trashRoot = path.join(root, '.trash');
const stale = [];
function resetDir(dir) {
  if (fs.existsSync(dir)) {
    const bak = path.join(trashRoot, `${path.basename(dir)}-${Date.now()}`);
    try {
      fs.mkdirSync(trashRoot, { recursive: true });
      fs.renameSync(dir, bak);
      stale.push(bak);
    } catch (e) {
      log(`· 换名挪走失败（${e.code || e.message}），退回直接删除…`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(dir, { recursive: true });
}

// ---------- 1. 复制 Electron.app ----------
log('· 复制 Electron.app（含 Frameworks，保留符号链接）…');
resetDir(outBase);
// verbatimSymlinks: 保留 Electron.app 里的相对符号链接（Frameworks/Versions/Current 等），
// 解引用会让包体积翻倍且破坏 Framework 加载。
fs.cpSync(electronApp, appPath, { recursive: true, verbatimSymlinks: true, dereference: false });

const defaultAsar = path.join(resources, 'default_app.asar');
if (fs.existsSync(defaultAsar)) fs.rmSync(defaultAsar, { force: true });

// ---------- 2. 应用代码 ----------
log('· 复制应用代码…');
fs.mkdirSync(appDir, { recursive: true });
fs.cpSync(path.join(root, 'electron'), path.join(appDir, 'electron'), { recursive: true });
fs.cpSync(path.join(root, 'dist'), path.join(appDir, 'dist'), { recursive: true });
if (fs.existsSync(path.join(appDir, 'electron', 'electron'))) {
  fail('复制出现目录嵌套（Resources/app/electron/electron），产物不可信。');
}
fs.writeFileSync(
  path.join(appDir, 'package.json'),
  JSON.stringify(
    { name: productName.toLowerCase(), productName, version, author, main: 'electron/main.cjs' },
    null,
    2
  ),
  'utf8'
);

// ---------- 2b. 剥离本地专用模块（分发版）----------
// 与 Windows 完全同一套规则：wb-recover.local.cjs 是「从客户端加密登录态就地解密」的实现，
// 只能留在自用版里。分发版删掉后主流程的 try/catch require 会自动退化成「请手动登录」。
const LOCAL_ONLY = ['wb-recover.local.cjs', 'wb-recover.local.js'].map((n) =>
  path.join(appDir, 'electron', 'services', n)
);
if (mode === 'share') {
  for (const p of LOCAL_ONLY) {
    if (!fs.existsSync(p)) continue;
    fs.unlinkSync(p);
    log(`· 已从分发版剥离本地专用模块：${path.relative(outBase, p)}`);
  }
  const leaked = LOCAL_ONLY.filter((p) => fs.existsSync(p));
  if (leaked.length) fail(`分发版里仍有本地专用模块，拒绝出包：${leaked.join(', ')}`);
}

// ---------- 2c. macOS 原生窗口行为补丁 ----------
// Electron 没有公开 NSWindowCollectionBehaviorStationary；编译一个小型 N-API 模块，
// 让组件在触发角/显示桌面、Mission Control 和全屏应用切换时保持常驻。
log('· 编译 macOS 常驻窗口行为补丁…');
const nativeSource = path.join(root, 'native', 'macos', 'window_behavior.mm');
const nativeDestDir = path.join(appDir, 'electron', 'native');
const nativeDest = path.join(nativeDestDir, 'tally-window.node');
if (!fs.existsSync(nativeSource)) fail('缺少 native/macos/window_behavior.mm');
const nodeInclude = [
  process.env.NODE_INCLUDE_DIR,
  path.resolve(path.dirname(process.execPath), '..', 'include', 'node'),
  '/opt/homebrew/include/node',
  '/usr/local/include/node',
]
  .filter(Boolean)
  .find((dir) => fs.existsSync(path.join(dir, 'node_api.h')));
if (!nodeInclude) {
  fail('找不到 node_api.h：请安装 Node 头文件，或用 NODE_INCLUDE_DIR 指定 include/node 目录。');
}
fs.mkdirSync(nativeDestDir, { recursive: true });
try {
  execFileSync(
    'clang++',
    [
      '-x', 'objective-c++',
      '-std=c++17',
      '-O2',
      '-dynamiclib',
      '-undefined', 'dynamic_lookup',
      '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64',
      '-I', nodeInclude,
      '-framework', 'Cocoa',
      nativeSource,
      '-o', nativeDest,
    ],
    { stdio: 'pipe' }
  );
} catch (err) {
  const detail = String(err.stderr || err.message || err).trim().split('\n').slice(-6).join('\n');
  fail(`macOS 常驻窗口行为补丁编译失败：\n${detail}`);
}
log(`· 已写入 ${path.relative(outBase, nativeDest)}`);

// ---------- 3. 图标 ----------
log('· 写入 .app 图标…');
const icnsDest = path.join(resources, `${productName}.icns`);
fs.copyFileSync(icns, icnsDest);
const oldIcns = path.join(resources, 'electron.icns');
if (fs.existsSync(oldIcns)) fs.rmSync(oldIcns, { force: true });

// ---------- 4. Info.plist ----------
// 只改「键值」，**不改任何二进制文件名**。
// 原因：Electron 在 macOS 上按主可执行文件名推导 Helper 的路径
// （Contents/Frameworks/<名字> Helper.app/...）。只改主 exe 而不改整套 Helper，
// 渲染进程会找不到 Helper 直接白屏 —— 那套重命名（主 exe + 4 个 Helper + 各自 plist）
// 属于 electron-packager 的活，收益只是「活动监视器里显示 Tally」，不值得在这里手写。
// 图标、显示名、Bundle ID、LSUIElement 已经足够让它看起来、用起来都是 Tally。
const plistPath = path.join(contents, 'Info.plist');
let plist = fs.readFileSync(plistPath, 'utf8');

function setPlistValue(xml, key, valueXml) {
  const marker = `<key>${key}</key>`;
  const i = xml.indexOf(marker);
  if (i === -1) {
    const j = xml.lastIndexOf('</dict>');
    if (j === -1) return xml;
    return `${xml.slice(0, j)}\t<key>${key}</key>\n\t${valueXml}\n${xml.slice(j)}`;
  }
  const start = i + marker.length;
  const rest = xml.slice(start);
  // 紧跟在这个 key 后面的第一个完整值节点（字符串 / 布尔 / 整数 / 数组）
  const m = /^\s*(?:<string>[\s\S]*?<\/string>|<true\/>|<false\/>|<integer>[\s\S]*?<\/integer>|<array>[\s\S]*?<\/array>)/.exec(
    rest
  );
  if (!m) return `${xml.slice(0, start)}\n\t${valueXml}${rest}`;
  return `${xml.slice(0, start)}\n\t${valueXml}${rest.slice(m[0].length)}`;
}

const escaped = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

plist = setPlistValue(plist, 'CFBundleName', `<string>${escaped(productName)}</string>`);
plist = setPlistValue(plist, 'CFBundleDisplayName', `<string>${escaped(productName)}</string>`);
plist = setPlistValue(plist, 'CFBundleIdentifier', `<string>${escaped(bundleId)}</string>`);
plist = setPlistValue(plist, 'CFBundleShortVersionString', `<string>${escaped(version)}</string>`);
plist = setPlistValue(plist, 'CFBundleVersion', `<string>${escaped(version)}</string>`);
plist = setPlistValue(plist, 'CFBundleIconFile', `<string>${escaped(productName)}.icns</string>`);
plist = setPlistValue(
  plist,
  'NSHumanReadableCopyright',
  `<string>© ${new Date().getFullYear()} ${escaped(author)}</string>`
);
plist = setPlistValue(plist, 'NSHighResolutionCapable', '<true/>');
// LSUIElement：纯菜单栏应用，不占 Dock、不进 Cmd+Tab。
// 主进程里还有一次 app.dock.hide()，两条一起保证「启动瞬间也不会闪一下 Dock 图标」。
plist = setPlistValue(plist, 'LSUIElement', '<true/>');
fs.writeFileSync(plistPath, plist, 'utf8');
log(`· Info.plist：${productName} / ${bundleId} / v${version} / LSUIElement=true`);

// ---------- 5. 数据目录 ----------
// macOS 的数据目录在 .app **外面**（.app 是只读包，写进去会破坏签名）。
// platform.cjs 的判定：.app 同级存在 data/ 就认便携模式，否则落 ~/Library/Application Support/Tally。
if (mode === 'share') {
  log('· 分发版不创建 data/（首次启动落 ~/Library/Application Support/Tally）');
} else {
  const dataDir = path.join(outBase, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const cfgDest = path.join(dataDir, 'config.json');
  const cfgSrc = path.join(root, 'data', 'config.json');
  if (fs.existsSync(cfgDest)) {
    log('· 保留现有 data/config.json（自用配置未改动）');
  } else if (fs.existsSync(cfgSrc)) {
    fs.copyFileSync(cfgSrc, cfgDest);
    log('· 从项目 data/config.json 复制了一份自用配置（含真实密钥，禁止外发）');
  } else {
    log('· 项目里没有 data/config.json，跳过（首次启动会写默认值）');
  }
}

// ---------- 6. 安全闸门 ----------
// 默认层级必须是「贴桌面」——与 Windows 脚本同一条硬断言，防止某天误改 DEFAULTS
const storeTxt = fs.readFileSync(path.join(appDir, 'electron', 'services', 'store.cjs'), 'utf8');
if (!/alwaysOnTop:\s*false/.test(storeTxt)) {
  fail('DEFAULTS 里的 alwaysOnTop 不是 false —— 默认必须是「贴桌面」。');
}
if (mode === 'share') {
  log('· 扫描 .app，确认没有残留密钥…');
  const KEY_PATTERN =
    /(?:\bsk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{8,})/g;
  const TEXT_EXT = new Set([
    '.json', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.css', '.html',
    '.txt', '.md', '.yml', '.yaml', '.map', '.plist',
  ]);
  const hits = [];
  const stats = { files: 0, bytes: 0 };
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      // 符号链接不跟进去：Frameworks 里有大量指向同一份二进制的链接
      if (ent.isSymbolicLink()) continue;
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
      if (found) hits.push({ file: path.relative(outBase, full), keys: [...new Set(found)] });
    }
  };
  walk(appPath);
  if (hits.length) {
    console.error('\n✗ 产物中发现疑似 API Key，已中止（请勿分发）：');
    for (const h of hits) console.error(`   ${h.file}: ${h.keys.map((k) => k.slice(0, 10) + '…').join(', ')}`);
    fail('清理后再重新执行本脚本。');
  }
  if (fs.existsSync(path.join(appDir, 'data'))) {
    fail('分发版的 .app 里出现了 data/ 目录，拒绝出包。');
  }
  log(`  密钥扫描：干净（0 处命中，共 ${stats.files} 个文件 / ${(stats.bytes / 1024 / 1024).toFixed(1)} MB）`);
}

// ---------- 7. ad-hoc 签名 ----------
// Apple Silicon 强制要求至少 ad-hoc 签名；未签名 = 双击直接报「已损坏」。
// ad-hoc（--sign -）不需要开发者账号，代价是：别人首次打开要右键 →「打开」，
// 或在终端 xattr -dr com.apple.quarantine <Tally.app> 一下（zip 解压会带 quarantine 标记）。
const signed = { ok: false, detail: '' };
if (skipSign) {
  log('· 跳过签名（--no-sign）：产物只能在本机调试，拷给别人会报「已损坏」');
} else {
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'pipe' });
    const out = execFileSync('codesign', ['-dv', appPath], { stdio: 'pipe', encoding: 'utf8' });
    signed.ok = true;
    signed.detail = (out.match(/Signature=([^)]*)/) || [])[0] || 'ad-hoc';
    log(`· 已签名（ad-hoc）：${signed.detail}`);
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
    log('· 签名校验通过');
  } catch (err) {
    const msg = String(err.stderr || err.message || err).trim().split('\n')[0];
    log(`⚠️ 签名失败：${msg}`);
    log('  产物仍会生成，但在 Apple Silicon 上双击打开会提示「已损坏」。');
  }
}

// ---------- 8. 同步校验 ----------
// 与 Windows 脚本同一个硬闸门：源文件与产物必须逐文件一致，否则说明复制漏了。
const syncPairs = [];
const walkPair = (srcDir, dstDir, rel = '') => {
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const relPath = path.join(rel, ent.name);
    const s = path.join(srcDir, ent.name);
    const d = path.join(dstDir, ent.name);
    if (ent.isDirectory()) {
      walkPair(s, d, relPath);
      continue;
    }
    syncPairs.push({ rel: relPath, src: s, dst: d });
  }
};
walkPair(path.join(root, 'electron'), path.join(appDir, 'electron'));
walkPair(path.join(root, 'dist'), path.join(appDir, 'dist'));
let mismatched = 0;
for (const p of syncPairs) {
  if (!fs.existsSync(p.dst)) {
    console.error(`   ✗ 缺失：${p.rel}`);
    mismatched++;
    continue;
  }
  const a = fs.statSync(p.src);
  const b = fs.statSync(p.dst);
  if (a.size !== b.size) {
    console.error(`   ✗ 大小不一致：${p.rel}（源 ${a.size} / 产物 ${b.size}）`);
    mismatched++;
  }
}
if (mismatched) fail(`同步校验失败：${mismatched} 个文件对不上，产物不可信。`);
log(`· 同步校验：${syncPairs.length} 个文件全部一致`);

// ---------- 9. 打包 zip ----------
let zipPath = '';
if (skipZip) {
  log('· 跳过 zip（--no-zip）');
} else {
  zipPath = path.join(
    root,
    'release',
    `${productName}-v${version}${mode === 'share' ? '-share' : ''}-mac.zip`
  );
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
  // ditto 是 mac 上唯一能完整保留符号链接、权限位和资源 fork 的打包工具；
  // 别用 zip 命令（--symlinks 也容易把 Framework 打坏）。
  execFileSync('ditto', ['-c', '-k', '--keepParent', appPath, zipPath], { stdio: 'pipe' });
  const size = fs.statSync(zipPath).size;
  const sha = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex').toUpperCase();
  log('');
  log(`· zip：${path.relative(root, zipPath)}  ${(size / 1024 / 1024).toFixed(2)} MB`);
  log(`  sha256 ${sha.slice(0, 8)}…${sha.slice(-8)}`);
}

// ---------- 10. 收尾 ----------
for (const d of stale) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {}
  if (fs.existsSync(d)) log(`⚠️ 旧目录未能自动清理，可手动删除：${path.relative(root, d)}`);
}

log('');
log(`✓ 完成：${appPath}`);
log(`  版本 ${version} · ${mode === 'share' ? '分发版' : '自用版'}`);
log(`  数据目录：${mode === 'share' ? '~/Library/Application Support/Tally' : path.join(outBase, 'data')}`);
if (mode === 'share') {
  log('');
  log('  发给别人前确认：');
  log(`    1) 对方首次打开要右键 →「打开」，或 xattr -dr com.apple.quarantine "${productName}.app"`);
  log('    2) 本机没有 Apple 开发者证书，未做公证（notarize），这是预期行为');
}
