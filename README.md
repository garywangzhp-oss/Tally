# Tally

> 桌面常驻小组件：**OpenCode Go 用量** + **WorkBuddy 每日积分自动领取**

一个贴在 Windows 桌面上的小面板。默认可视作「桌面小组件」——待在桌面之上、所有应用窗口之下，
不遮挡任何工作；被点过拖过之后会自动沉回桌面层。整个程序是绿色的，删掉文件夹即卸载干净。

Electron 44 + React 19 + Vite 8 + TypeScript。

---

## 功能

### OpenCode Go 用量

- 三档额度窗口（**5 小时 / 本周 / 本月**）的剩余百分比与重置倒计时
- 按官方额度反推的美元估算（`≈$0.96 / $12.00`）
- **多账号**：一条 profile 对应一个订阅账号，最多 8 个，顶部切换条一键换号
- 额度挂在**订阅账号**上而不是挂在 Key 上 —— 同账号生成的多个 Key 数字完全相同，填一条即可
- 保留「原始响应 / 字段识别」展开区，解析异常时可自查

### WorkBuddy 每日积分

- 自动领取每日签到积分，面板显示连续签到天数、本期累计、本周已签
- **不需要账号密码，也不做机器绑定**：只读本机 WorkBuddy 客户端留下的登录态，
  所以「装了并登录过」就自动关联到**你自己的账号**
- 显示账户**积分余额**（所有资源包求和）与**本期累计**（仅本次签到活动期）

### 窗口行为

- **桌面常驻**：主动锚定在「桌面之上、所有应用之下」的 gadget 层。
  即使用鼠标点它、拖它把它带到最前，也会立刻自己沉回桌面层，绝不长期压住其它窗口
- **可选置顶**：需要时才开，开启后永远浮在最上层（连任务栏在内），
  切换显示器 / 副屏重连后自动回到最前，且打字时不去抢输入法候选框
- **等比缩放**：拖右下角把手可整体放大缩小，文字 / 间距 / 图标一起变、**排版不变**；
  缩放上限跟着屏幕大小自动收窄，倍率会记住
- **关闭到托盘**：点 × 默认只是收进托盘，后台刷新与自动领取不停；真退出走托盘右键
- **开机自启**：可选，写 `HKCU\...\CurrentVersion\Run`

### 其它

- 自动刷新间隔可调（20 秒 ~ 30 分钟，默认 60 秒）
- 面板不透明度可调
- 显示／隐藏、置顶、锁定等操作都有托盘入口

---

## 开发

```bash
npm install

npm run dev        # Vite 开发服务器（热更新）
npm run build      # 构建渲染层到 dist/
npm run electron   # 直接用 Electron 跑（需先 build）
npm run start      # build + electron
```

类型检查：

```bash
npx tsc --noEmit -p tsconfig.json
```

### 打包绿色版

```bash
npm run portable        # 自用版 → release/Tally（保留已有 data/config.json）
npm run share           # 分发版 → release/Tally-share（空白配置 + 密钥扫描）
npm run portable:full   # 强制重装 Electron 运行时
```

`scripts/build-portable.mjs` 会顺带做三件事：写入 exe 的 PE 资源（图标 + 版本信息）、
**逐文件比对产物与源**、**密钥特征扫描**。运行时已存在时只同步 app 代码，几秒完成。

> ⚠️ 写 PE 资源会破坏 Electron 官方 exe 的数字签名，首次运行可能弹 SmartScreen
> （「更多信息」→「仍要运行」），同机器之后不再提示。

### 图标与 exe 资源

```bash
npm run icons                          # 重新生成图标（零依赖，自绘几何）
node scripts/make-icons.mjs --list     # 列出可用变体
node scripts/set-exe-resources.mjs     # 单独写 exe 图标与版本信息
```

---

## 数据与隐私

- 所有配置都在程序目录的 `data/config.json`，**纯本地、不上传**
- 需要重置就删掉 `data/` 目录，下次启动自动重建
- **仓库里不含任何 API Key**：`data/` 已被 `.gitignore` 排除
- WorkBuddy 登录态文件只读，不回写；OpenCode Key 存在本地 config，不入库、不外传

```jsonc
// data/config.json 结构（截取）
{
  "opencodeProfiles": [{ "id": "...", "name": "个人号", "apiKey": "" }],
  "activeProfileId": "",
  "refreshSeconds": 60,
  "opacity": 0.97,
  "alwaysOnTop": false,
  "autoCheckin": false,
  "closeToTray": true,
  "autoStart": false,
  "windowScale": 1
}
```

---

## 目录结构

```
electron/
  main.cjs                 主进程：窗口、缩放、托盘、置顶、自启、IPC
  preload.cjs              contextBridge → window.tally
  desktop-keep.ps1         Z 序守护（常驻 PowerShell，主动沉底）
  services/
    store.cjs              配置读写与迁移
    opencode.cjs           OpenCode Go 用量取数（宽容解析）
    workbuddy.cjs          登录态定位 + 签到 + 积分余额
    desktop-keeper.cjs     守护进程的生命周期管理
  assets/                  图标（PNG / ICO）
src/
  App.tsx                  面板主体
  components/              UsageSection / BuddySection / SettingsSection / ResizeGrip
  types.ts                 渲染层与主进程共享类型
  styles.css
scripts/
  build-portable.mjs       绿色版打包（同步校验 + 密钥扫描）
  make-icons.mjs           图标生成（零依赖自绘）
  set-exe-resources.mjs    写 exe 的 PE 资源
```

架构约定：**外部取数一律在主进程**，渲染层只通过 preload 暴露的 `window.tally` 调用。

---

## 自检开关

调试用的环境变量（不影响正常使用）：

| 变量 | 作用 |
|---|---|
| `TALLY_DATA_DIR` | 覆盖数据目录（同时隔离 Electron userData，避免与正式版抢单例锁） |
| `TALLY_SMOKE=1` | 稳定后执行脚本 → 截图 → 退出（配 `_DELAY` / `_OUT` / `_EVAL`） |
| `TALLY_MOCK_USAGE=1` | 假用量样本，不请求真实接口 |
| `TALLY_KEEP_TEST=1` | Z 序守护链路自检 |
| `TALLY_SCALE_TEST=1` | 界面等比缩放自检 |
| `TALLY_AUTOSTART_TEST=1` | 开机自启注册表读写自检 |
| `TALLY_TRAY_TEST=1` | 托盘行为自检 |
| `TALLY_AUTOQUIT_MS=N` | N 毫秒后自动退出 |

---

## 已知限制

- **仅支持中国大陆版 WorkBuddy**（接口域名 `www.codebuddy.cn`），其它区域版本可能不通
- WorkBuddy 登录态属于「当前这台电脑 + 当前 Windows 用户」，换机 / 换账号需重新登录客户端
- 登录态约 60 天一个周期，客户端启动会自动续期；长期不开客户端会过期
- 绿色版**挪目录后开机自启项失效**，需把开关关掉再打开一次重建路径
- 未购买代码签名证书，首次运行有 SmartScreen 提示

## 免责

本软件通过读取本机客户端的登录态代你调用官方接口，属个人效率工具。
请自行确认使用方式符合所在平台的服务条款。
