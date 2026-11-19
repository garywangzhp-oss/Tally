# Tally for macOS

> 常驻桌面的 macOS 小组件：**OpenCode Go 用量** + **commandcode 额度** +
> **WorkBuddy 每日积分自动领取**

当前分支只维护 macOS 版。Windows 版位于
[`main` 分支](https://github.com/garywangzhp-oss/Tally/tree/main)，
两端使用独立分支与独立 Release 标签，避免安装包和平台说明混在一起。

## 下载

- **macOS v1.4.2（Apple Silicon）**：
  [Tally-v1.4.2-mac-arm64.dmg](https://github.com/garywangzhp-oss/Tally/releases/download/mac-v1.4.2/Tally-v1.4.2-mac-arm64.dmg)
- **macOS ZIP 备份**：
  [Tally-v1.4.2-share-mac.zip](https://github.com/garywangzhp-oss/Tally/releases/download/mac-v1.4.2/Tally-v1.4.2-share-mac.zip)
- **Windows 版**：
  [前往 Windows 发布页](https://github.com/garywangzhp-oss/Tally/releases/latest)

> 当前 macOS 安装包为 Apple Silicon（arm64）版本。Intel Mac 需要在本机重新构建，
> 并修改 `scripts/build-mac.mjs` 的目标架构。

## 安装与首次启动

1. 下载并打开 `Tally-v1.4.2-mac-arm64.dmg`。
2. 把 `Tally.app` 拖进 `Applications` 文件夹。
3. 首次启动时，在 Finder 里右键 `Tally.app`，选择「打开」。

如果 macOS 仍提示无法验证开发者，可在终端执行：

```bash
xattr -dr com.apple.quarantine "/Applications/Tally.app"
open "/Applications/Tally.app"
```

Tally 使用 ad-hoc 签名，没有 Apple Developer ID，也没有经过公证，因此首次运行出现
Gatekeeper 提示属于预期行为。

## 使用方法

### 菜单栏常驻

- 启动后 Tally 只显示面板，不占用 Dock 和 `Cmd+Tab`。
- 点击左上角红色关闭按钮 `×`，面板会**收进菜单栏**，不会退出程序。
- 单击菜单栏 Tally 图标，会显示三项实时摘要：
  - OpenCode Go：5 小时 / 本周 / 本月
  - commandcode：5 小时 / 本周 / 每月
  - WorkBuddy：积分余额
- 菜单中的三行摘要也是可点击项，点击任一行会重新显示面板。
- 要真正退出，请使用菜单栏菜单里的「退出 Tally」。

### 桌面常驻与置顶

- 默认固定在桌面：切换桌面、进入触发角、显示桌面、Mission Control 时不会消失。
- 普通应用窗口会盖在 Tally 上；点击标题栏的固定按钮可切换为始终置顶。
- 开启置顶后使用 macOS `floating` 层级，不会覆盖全屏应用和系统 UI。
- 拖动右下角斜纹把手可等比缩放；选择会被记住。

### 液态玻璃与经典界面

- 默认使用液态玻璃界面。
- 标题栏左侧的「经典 / 玻璃」按钮可以随时切换。
- 主题选择保存在本地配置中，重启后继续生效。

### 开机自启

在设置中开启「开机自动启动」。如果 macOS 提示需要许可，请前往：

`系统设置 → 通用 → 登录项与扩展`

把 Tally 加入允许列表。未签名应用或不在 `/Applications` 下的 `.app` 可能无法登记登录项。

### 数据位置与重置

macOS 分发版默认把数据保存在：

```text
~/Library/Application Support/Tally/config.json
```

该目录包含 OpenCode API Key、commandcode API Key 和 WorkBuddy 续期令牌。
**不要把该目录或自己的 `Tally.app` 数据一起发给别人。**

需要重置时，先退出 Tally，再把整个目录改名备份：

```bash
mv "$HOME/Library/Application Support/Tally" \
   "$HOME/Library/Application Support/Tally.backup"
```

下次启动会生成空白配置。

## 功能

### OpenCode Go

- 5 小时、本周、本月三档额度的剩余百分比与重置倒计时
- 金额估算、已用额度与套餐上限
- 最多 8 个账号配置，可从顶部快速切换
- 保留原始响应与字段识别，便于排查接口变化

### commandcode

- 使用独立 API Key，与 OpenCode 账号不共用
- 5 小时、本周、每月三档额度
- 前两档显示剩余百分比、重置时间、已用金额 / 上限
- 月度接口只返回剩余金额，因此显示「剩余 $xx」与本期重置日期
- 默认不显示，填写 Key 并打开开关后才出现

### WorkBuddy

- 通过官方网页登录，不需要保存账号密码
- 自动续期 Tally 自己的令牌
- 显示积分余额、连续签到、本期累计与本周签到进度
- 可手动领取，也可在设置里开启每日自动领取
- 仅支持中国大陆版 WorkBuddy

### 界面

- 液态玻璃 / 经典双主题
- 面板不透明度可调
- 自动刷新间隔可调（20 秒 ~ 30 分钟）
- 等比缩放窗口，不改变内部排版
- 界面错误隔离，单个数据区块失败不会拖垮整个面板

## 隐私与仓库安全

- 源码仓库不包含 API Key、JWT、WorkBuddy 令牌或用户标识。
- `data/`、`.smoke-*/`、`.trash/`、`release/`、`node_modules/`、`dist/`、
  运行截图和本机诊断文件均被 `.gitignore` 排除。
- 配置与登录态只保存在本机，不会上传到 GitHub。
- WorkBuddy 登录走官方网页流程；macOS 版不使用客户端登录态解密模块。
- 发布前会扫描打包产物中的 `sk-*` 与 JWT 特征，并检查分发版没有空白配置以外的数据。

## 开发

环境要求：macOS、Node.js、npm、Xcode Command Line Tools。

```bash
npm ci
npm run dev
```

类型检查：

```bash
npx tsc --noEmit -p tsconfig.json
```

生产构建：

```bash
npm run build
```

### 构建 macOS `.app`

```bash
npm run mac          # 自用版：release/mac/Tally.app
npm run mac:share    # 分发版：release/mac-share/Tally.app
```

`mac:share` 会：

- 复制 Electron 运行时并生成 `Tally.app`
- 写入 Bundle ID、版本、图标和 `LSUIElement`
- 编译 `native/macos/window_behavior.mm`
- 使用 ad-hoc 签名并校验
- 检查分发版不含本地凭据
- 输出 `release/Tally-v1.4.2-share-mac.zip`

### 生成 DMG

```bash
npm run mac:dmg
```

输出：

```text
release/Tally-v1.4.2-mac-arm64.dmg
```

脚本会重新校验 DMG，并输出 SHA-256。

## 项目结构

```text
electron/
  main.cjs                     窗口、菜单栏、置顶、自启与 IPC
  preload.cjs                  contextBridge → window.tally
  services/
    platform.cjs               Windows / macOS 平台差异
    store.cjs                  本地配置读写与迁移
    opencode.cjs               OpenCode Go 用量
    commandcode.cjs            commandcode 额度
    workbuddy.cjs              WorkBuddy 签到、积分与令牌续期
    wb-login.cjs               官方网页登录
    desktop-keeper.cjs         桌面层级守护
  assets/                      应用与菜单栏图标
native/
  macos/window_behavior.mm     NSPanel / Space / Mission Control 行为
src/
  App.tsx                      面板主体
  components/                  用量、额度、签到、设置等区块
  styles.css                   液态玻璃与经典主题
scripts/
  build-mac.mjs                .app / ZIP 构建
  build-dmg.sh                 DMG 构建与校验
  make-icons.mjs               图标生成
```

## 已知限制

- 当前安装包仅支持 Apple Silicon。
- 没有 Apple Developer ID，未公证；升级后首次打开仍可能需要右键「打开」。
- WorkBuddy 仅支持中国大陆版接口。
- 桌面常驻依赖 macOS 原生窗口补丁；更换 Electron 主版本后需重新验证。
- 开机自启可能被 macOS「登录项与扩展」权限拦截，需要在系统设置中手动允许。

## 免责声明

Tally 通过 WorkBuddy 官方网页登录获取属于使用者本人的令牌，并调用官方接口。
这是个人效率工具，请自行确认使用方式符合相关平台的服务条款。
