// 重写 Tally.exe 的 PE 资源：应用图标 + 版本信息（产品名 / 版本 / 公司 / 版权）。
//
// 为什么不用 rcedit：github.com 在本机沙箱里连不上（Connect Timeout），
// 而 npm registry 可达。resedit 是纯 JS 的 PE 资源编辑器，零二进制依赖。
//
// 由 build-portable.mjs 在「复制 Electron 运行时之后」调用，且**每次打包都跑** ——
// exe 只在首次复制，但写进 PE 里的版本号要跟着 package.json 走。
//
// ⚠️ 副作用：会破坏 Electron 官方 exe 的数字签名。Windows 会把它当未签名程序，
// 首次运行可能弹 SmartScreen「Windows 已保护你的电脑」→ 点「更多信息 / 仍要运行」。
// 绿色版本来就没签名，不影响功能。
//
// 单独跑（对一份拷贝试）：
//   node scripts/set-exe-resources.mjs <exe> <ico> <version> [productName]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ResEdit from 'resedit';

const ICON_GROUP_ID = 1; // Electron 官方 exe 的图标组：type 14 / id 1 / lang 1033
const LANG = 1033; // en-US，与原资源一致
const CODEPAGE = 1200; // UTF-16

function versionQuad(v) {
  const parts = String(v)
    .split(/[.\-+]/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4);
}

/**
 * 自己解析 ICO 目录。
 *
 * 为什么不直接用 `ResEdit.Data.IconFile.from()`：它返回的 icons 元素原型是 `Object.prototype`，
 * 没有 `isIcon()`，喂给 `replaceIconsForResource` 会抛
 * `TypeError: icon.isIcon is not a function`。自己按 ICO 规范解析反而更省事：
 * 6 字节头（reserved/type/count）+ 每项 16 字节。
 * width/height 写 0 表示 256（ICO 格式限制），这里还原成真实值。
 */
function parseIco(buf) {
  const count = buf.readUInt16LE(4);
  const items = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    items.push({
      width: buf[o] === 0 ? 256 : buf[o],
      height: buf[o + 1] === 0 ? 256 : buf[o + 1],
      bitCount: buf.readUInt16LE(o + 6),
      size: buf.readUInt32LE(o + 8),
      offset: buf.readUInt32LE(o + 12),
    });
  }
  return items;
}

/**
 * 把图标与版本信息写进 exe。exePath 会被原地覆盖。
 * @param {{exePath:string, icoPath:string, productName:string, description:string,
 *          company:string, copyright:string, version:string}} opts
 */
export function patchExeResources(opts) {
  const { exePath, icoPath, productName, description, company, copyright, version } = opts;
  if (!fs.existsSync(exePath)) throw new Error(`找不到 exe：${exePath}`);
  if (!fs.existsSync(icoPath)) throw new Error(`找不到图标：${icoPath}`);

  const sizeBefore = fs.statSync(exePath).size;
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  // 1) 图标（9 档，系统按 DPI 自己挑）。RT_ICON 与 ICO 里的图像数据格式一致，直接搬。
  const icoBuf = fs.readFileSync(icoPath);
  const icoItems = parseIco(icoBuf);
  if (!icoItems.length) throw new Error(`图标里没有图像：${icoPath}`);
  const rawIcons = icoItems.map((it) =>
    ResEdit.Data.RawIconItem.from(icoBuf, it.width, it.height, it.bitCount, it.offset, it.size)
  );
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    ICON_GROUP_ID,
    LANG,
    rawIcons
  );

  // 2) 版本信息
  const vis = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (!vis.length) throw new Error('exe 里找不到版本信息资源（RT_VERSION），无法写入');
  const vi = vis[0];
  const quad = versionQuad(version);
  vi.setFileVersion(...quad);
  vi.setProductVersion(...quad);
  vi.setStringValues(
    { lang: LANG, codepage: CODEPAGE },
    {
      ProductName: productName,
      FileDescription: description,
      CompanyName: company,
      LegalCopyright: copyright,
      OriginalFilename: `${productName}.exe`,
      InternalName: productName,
      FileVersion: version,
      ProductVersion: version,
    }
  );
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));

  return { sizeBefore, sizeAfter: fs.statSync(exePath).size, icons: rawIcons.length, quad };
}

/** 重新读回产物，确认图标组与版本信息真的写进去了。 */
export function verifyExeResources(exePath) {
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const vis = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const sv = vis.length ? vis[0].getStringValues({ lang: LANG, codepage: CODEPAGE }) : {};
  return {
    iconGroups: groups.length,
    iconCount: groups.length ? (groups[0].icons || []).length : 0,
    ProductName: sv.ProductName ?? null,
    FileVersion: sv.FileVersion ?? null,
    CompanyName: sv.CompanyName ?? null,
    OriginalFilename: sv.OriginalFilename ?? null,
  };
}

// ---------- CLI ----------
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const [exePath, icoPath, version, productName = 'Tally'] = process.argv.slice(2);
  if (!exePath || !icoPath || !version) {
    console.error('用法：node scripts/set-exe-resources.mjs <exe> <ico> <version> [productName]');
    process.exit(1);
  }
  const r = patchExeResources({
    exePath,
    icoPath,
    productName,
    description: `${productName} · 用量与积分面板`,
    company: 'GaryWang',
    copyright: `Copyright (C) 2026 GaryWang`,
    version,
  });
  console.log('patched:', JSON.stringify(r));
  console.log('verify :', JSON.stringify(verifyExeResources(exePath)));
}
