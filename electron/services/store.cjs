const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  // 多账号配置：额度挂在 OpenCode 订阅（账号）上，不是挂在 key 上，
  // 所以这里一条 profile = 一个账号，同一个账号的多个 key 填进来数字会完全一样。
  opencodeProfiles: [],
  activeProfileId: '',
  refreshSeconds: 60,
  opacity: 0.97,
  locked: false,
  // 窗口层级：false = 贴桌面（默认，别的窗口能盖住它）；true = 永远浮在最前
  alwaysOnTop: false,
  // 一次性迁移标记，见 migrate()：0.13 起默认改成「贴桌面」
  topmostReviewed: false,
  position: null,
  autoCheckin: false,
  // 点关闭按钮时收进系统托盘而不是退出。托盘菜单里仍可真正退出。
  closeToTray: true,
  // 界面等比缩放倍率：窗口尺寸、页面 zoom 同时按这个倍数走（拖动右下角改它）。
  // 1 = 原始大小（400 宽）。见 main.cjs 的 applyScale()。
  windowScale: 1,
  // 开机自动启动。真正的事实来源是 HKCU\...\CurrentVersion\Run 里那条注册表值
  // （main.cjs 的 applyAutoStart/readAutoStart），这里只存用户的意图，启动时会对齐一次。
  autoStart: false,
  // WorkBuddy 凭据自持（2026-09-26 起）。
  // ⚠️ 这里是**真实凭据**：客户端把登录态加密后 Tally 读不到 token，所以改成自己拿
  // refreshToken 去 /v2/plugin/auth/token/refresh 续期（实测不需要 client_secret）。
  // 形状 { accessToken, refreshToken, expiresAt, refreshExpiresAt, uid, nickname, uin,
  //        accountType, updatedAt }。
  // ⚠️ data/ 已在 .gitignore 里，且 build-portable.mjs 的 --share 会写空白配置 + 扫密钥；
  //    自用版含真凭据，**禁止外发**。
  wbCredential: null,
};

const MAX_PROFILES = 8;

function newId() {
  return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function sanitizeProfiles(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
    if (!apiKey) continue;
    let id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : newId();
    while (seen.has(id)) id = newId();
    seen.add(id);
    const name = String(raw.name || '').trim().slice(0, 24) || `账号 ${out.length + 1}`;
    out.push({ id, name, apiKey });
    if (out.length >= MAX_PROFILES) break;
  }
  return out;
}

class Store {
  constructor(baseDir, fallbackDir) {
    this.primaryPath = path.join(baseDir, 'config.json');
    this.fallbackPath = path.join(fallbackDir, 'config.json');
    this.filePath = this.primaryPath;
    this.data = { ...DEFAULTS };
    this.load();
    this.migrate();
  }

  load() {
    const dir = path.dirname(this.primaryPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      this.filePath = this.fallbackPath;
    }
    const read = (p) => {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) {
        return e.code === 'ENOENT' ? null : { __corrupt: true };
      }
    };
    let parsed = read(this.filePath);
    if (parsed && parsed.__corrupt && this.filePath !== this.fallbackPath) {
      const alt = read(this.fallbackPath);
      if (alt && !alt.__corrupt) {
        parsed = alt;
        this.filePath = this.fallbackPath;
      }
    }
    if (parsed && !parsed.__corrupt) Object.assign(this.data, parsed);
    return this.data;
  }

  // 旧版把 key 存成单个 opencodeApiKey 字段，这里平滑迁移成一条 profile
  migrate() {
    let changed = false;

    const legacy =
      typeof this.data.opencodeApiKey === 'string' ? this.data.opencodeApiKey.trim() : '';
    const listEmpty = !Array.isArray(this.data.opencodeProfiles) || !this.data.opencodeProfiles.length;
    if (legacy && listEmpty) {
      this.data.opencodeProfiles = [{ id: newId(), name: '默认账号', apiKey: legacy }];
      changed = true;
    }
    if ('opencodeApiKey' in this.data) {
      delete this.data.opencodeApiKey;
      changed = true;
    }

    const clean = sanitizeProfiles(this.data.opencodeProfiles);
    if (JSON.stringify(clean) !== JSON.stringify(this.data.opencodeProfiles || [])) changed = true;
    this.data.opencodeProfiles = clean;

    if (!clean.some((p) => p.id === this.data.activeProfileId)) {
      this.data.activeProfileId = clean[0]?.id || '';
      changed = true;
    }

    // 0.13：默认层级从「永远浮在最前」改成「贴桌面」。
    // 老配置里那盏置顶灯多半是随手点开的（或者根本没意识到它会压住文件夹窗口），
    // 升级时统一关掉一次，只迁一次 —— 之后再打开就是用户自己的选择了。
    if (!this.data.topmostReviewed) {
      this.data.topmostReviewed = true;
      if (this.data.alwaysOnTop) this.data.alwaysOnTop = false;
      changed = true;
    }

    if (changed) this.save();
    return changed;
  }

  get(key) {
    return this.data[key];
  }

  all() {
    return { ...this.data };
  }

  set(patch) {
    Object.assign(this.data, patch);
    this.save();
    return this.all();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { Store, DEFAULTS, sanitizeProfiles, newId, MAX_PROFILES };
