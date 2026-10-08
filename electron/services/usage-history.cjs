/**
 * 本地 token 用量采集（用于「日 / 周 / 月 / 年」汇总图表）。
 *
 * 背景（2026-10-07 调研结论）：
 *   两个上游**都没有** Key 可访问的 token 时序接口：
 *     · commandcode  /alpha/usage/summary   只有 billing-period 累计（有 token 数字，无时间轴）
 *     · commandcode  /internal/usage/charts 有按日图表，但**只认网页 Cookie**
 *     · OpenCode     /zen/go/v1/usage       只有 percent 和金额，**压根没有 token 字段**
 *   所以时序只能自己攒：每次刷新把上游的累计值记一条，**用相邻两天的差值**得到"当天用了多少"。
 *
 * 数据文件：<dataDir>/usage-history.json（跟着 TALLY_DATA_DIR 走，与配置同目录）
 *   形状 { version:1, days: { "2026-10-07": { providers: { opencode:{...}, commandcode:{...} } } } }
 *
 * 每个 provider 每天只记**一条**（当天最后一次采样为准，累计值天然单调递增）。
 * 存的是「当天的累计读数」而不是增量 —— 这样重算/补采都不会累积误差，
 * 增量在聚合时才做差，读起来也更直观。
 *
 * ⚠️ 防倒退：换号、套餐重置、接口口径变化都会让累计值**变小**。
 *    遇到变小时不记负数，而是把当天标记为 `reset:true`，聚合时该天增量按 0 处理（而不是负值倒扣）。
 *
 * OpenCode 的 token 是**估算值**：上游只给 percent，这里按套餐基准额度折算成美元再
 * 除以一个平均单价得到 token（`estimated:true`）。commandcode 则是接口直给的真实 token。
 */

const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'usage-history.json';
const VERSION = 1;
const KEEP_DAYS = 400; // 保留一年多，够画年度曲线

/**
 * 估算用：OpenCode 无 token 字段，按「美元 → token」折算时的**混合单价**（美元/百万 token）。
 *
 * 基准模型 = **DeepSeek V4.1 Flash**。单价取自 **OpenCode 官方 Go 定价表**
 * （https://opencode.ai/docs/go → 「Usage limits」，2026-10-07 抓取），已是**美元原值，不用换汇**：
 *
 *   Model                          Input  Output  Cached Read  Monthly limit
 *   DeepSeek V4.1 Flash (Off-Peak) $0.15  $0.60   $0.003       $60
 *   DeepSeek V4.1 Flash (Peak)     $0.30  $1.20   $0.006       $60
 *
 * ⚠️ **不能直接用输入价或输出价** —— 输出是输入的 4 倍，必须按实际配比加权。
 *    编码场景输入远多于输出（大量代码上下文进、少量代码出），取 **输入:输出 = 4:1**：
 *      · 空闲: 0.8×0.15 + 0.2×0.60 = $0.24 /百万
 *      · 高峰: 0.8×0.30 + 0.2×1.20 = $0.48 /百万
 *    取两者中位 → **$0.36/百万**。
 *
 * ⚠️ 该账号实测 monthly percent=64 → 已花 $38.40 → 约 107M token，量级可信。
 *
 * 这是**粗估**，只用于曲线趋势对比；图上会标 `≈`。
 * 换模型时改这一个常数即可（各模型 Input/Output 价差很大，见官方表）。
 *
 * 参考：同一份表里 Go 的额度是 **$60/月**，且 5 小时 = 月度 20%（$12）、周 = 50%（$30）、
 * 月 = 100%（$60）—— 与 opencode.cjs 的 PLAN_LIMITS 一致。
 */
const OC_USD_PER_MTOK = 0.36;

function ymd(d) {
  const x = d instanceof Date ? d : new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

function shiftDays(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return ymd(dt);
}

/** 自然周的起点（周一）。ISO 周口径，中文习惯也是周一开头。 */
function weekStart(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = (dt.getDay() + 6) % 7; // 周一=0
  dt.setDate(dt.getDate() - dow);
  return ymd(dt);
}

class UsageHistory {
  constructor(dataDir) {
    this.dir = dataDir;
    this.filePath = path.join(dataDir, FILE_NAME);
    this.data = { version: VERSION, days: {} };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object') {
        this.data = { version: VERSION, days: raw.days };
      }
    } catch {
      /* 首次运行或文件损坏 → 用空数据，不影响主流程 */
    }
    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 记一条采样。
   * @param {'opencode'|'commandcode'} provider
   * @param {{tokens?:number|null, costUsd?:number|null, estimated?:boolean, note?:string}} sample
   * @param {Date|string} [when] 采样时间，默认现在（测试可注入）
   */
  record(provider, sample, when) {
    const day = ymd(when || new Date());
    const bucket = (this.data.days[day] ||= { providers: {} });
    const prev = bucket.providers[provider] || null;

    const tokens = Number.isFinite(sample?.tokens) ? sample.tokens : null;
    const costUsd = Number.isFinite(sample?.costUsd) ? sample.costUsd : null;
    if (tokens === null && costUsd === null) return { ok: false, reason: 'empty' };

    // 同一天：取较大的累计值（接口偶发抖动/缓存回退时不会把当天读数压低）
    // 同时用 max 而不是覆盖，避免"刷新早于上一次"导致数字倒退。
    let reset = false;
    if (prev) {
      const prevTok = Number.isFinite(prev.tokens) ? prev.tokens : 0;
      const prevCost = Number.isFinite(prev.costUsd) ? prev.costUsd : 0;
      if ((tokens !== null && tokens < prevTok) || (costUsd !== null && costUsd < prevCost)) {
        // 变小只可能是换号/重置/口径变了，标记一下，聚合时当天按 0 增量算
        reset = true;
      }
    }

    const next = {
      tokens: tokens !== null ? Math.max(tokens, prev?.tokens ?? 0) : (prev?.tokens ?? null),
      costUsd: costUsd !== null ? Math.max(costUsd, prev?.costUsd ?? 0) : (prev?.costUsd ?? null),
      estimated: Boolean(sample?.estimated ?? prev?.estimated ?? false),
      at: new Date(when || Date.now()).toISOString(),
    };
    if (prev?.reset || reset) next.reset = true;
    // 上游给的一句话状态（如 OpenCode 的 "rate-limited"、commandcode 的额度状态），
    // 只保留非空的，用于前端解释「为什么两条曲线平着不动」。
    if (typeof sample?.note === 'string' && sample.note) next.note = sample.note;

    bucket.providers[provider] = next;
    this.prune();
    this.save();
    return { ok: true, day, provider, reset };
  }

  /** 只保留最近 KEEP_DAYS 天 */
  prune() {
    const keys = Object.keys(this.data.days).sort();
    if (keys.length <= KEEP_DAYS) return;
    const cutoff = shiftDays(ymd(new Date()), -KEEP_DAYS);
    for (const k of keys) if (k < cutoff) delete this.data.days[k];
  }

  /**
   * 算出每天各 provider 的**增量**（当天累计 − 前一天累计）。
   * 返回 [{ date, total, opencode, commandcode, estimated, reset }]
   */
  dailySeries() {
    const dates = Object.keys(this.data.days).sort();
    const out = [];
    for (const date of dates) {
      const bucket = this.data.days[date];
      const rec = { date, opencode: 0, commandcode: 0, total: 0, estimated: false, reset: false };

      for (const provider of ['opencode', 'commandcode']) {
        const today = bucket.providers?.[provider];
        if (!today) continue;
        // 前一天：往前找最近的一条（用户可能几天没开机，不能直接 date-1）
        let prevTokens = 0;
        const earlier = dates.filter((d) => d < date);
        for (let i = earlier.length - 1; i >= 0; i--) {
          const p = this.data.days[earlier[i]].providers?.[provider];
          if (p && Number.isFinite(p.tokens)) {
            prevTokens = p.tokens;
            break;
          }
        }
        const cur = Number.isFinite(today.tokens) ? today.tokens : 0;
        let delta = cur - prevTokens;
        if (today.reset || delta < 0) {
          delta = 0; // 重置日不倒扣
          rec.reset = true;
        }
        rec[provider] += delta;
        if (today.estimated) rec.estimated = true;
      }

      rec.total = rec.opencode + rec.commandcode;
      out.push(rec);
    }
    return out;
  }

  /**
   * 按粒度聚合。
   * @param {'day'|'week'|'month'|'year'} grain
   * @param {number} count 想要多少个点
   */
  aggregate(grain = 'day', count = 14) {
    const daily = this.dailySeries();
    const byDate = new Map(daily.map((d) => [d.date, d]));

    // 生成完整时间桶（没有数据的日子补 0，曲线才连续）
    const buckets = [];
    const today = ymd(new Date());

    if (grain === 'day') {
      for (let i = count - 1; i >= 0; i--) {
        const d = shiftDays(today, -i);
        buckets.push({ key: d, label: d.slice(5), start: d, end: d });
      }
    } else if (grain === 'week') {
      for (let i = count - 1; i >= 0; i--) {
        const start = shiftDays(weekStart(today), -i * 7);
        buckets.push({ key: start, label: start.slice(5), start, end: shiftDays(start, 6) });
      }
    } else if (grain === 'month') {
      const [ty, tm] = today.split('-').map(Number);
      for (let i = count - 1; i >= 0; i--) {
        const dt = new Date(ty, tm - 1 - i, 1);
        const start = ymd(dt);
        const end = ymd(new Date(dt.getFullYear(), dt.getMonth() + 1, 0));
        buckets.push({ key: start, label: start.slice(0, 7), start, end });
      }
    } else {
      const ty = Number(today.slice(0, 4));
      for (let i = count - 1; i >= 0; i--) {
        const y = ty - i;
        buckets.push({
          key: String(y),
          label: String(y),
          start: `${y}-01-01`,
          end: `${y}-12-31`,
        });
      }
    }

    return buckets.map((b) => {
      let opencode = 0;
      let commandcode = 0;
      let estimated = false;
      let reset = false;
      let days = 0;
      for (const d of daily) {
        if (d.date < b.start || d.date > b.end) continue;
        opencode += d.opencode;
        commandcode += d.commandcode;
        if (d.estimated) estimated = true;
        if (d.reset) reset = true;
        days++;
      }
      return {
        key: b.key,
        label: b.label,
        start: b.start,
        end: b.end,
        opencode,
        commandcode,
        total: opencode + commandcode,
        estimated,
        reset,
        days,
      };
    });
  }

  /**
   * 每个 provider 的最新一条采样摘要（用于解释「曲线为什么平着不动」）。
   * 取**全部历史**里最后出现的那个值，而不是只看今天。
   * note 单独往前找最近一条**非空**的：采样只在状态成立时写 note，
   * 某天没写不该把之前的状态说明丢掉。
   */
  latestByProvider() {
    const dates = Object.keys(this.data.days).sort();
    const pids = ['opencode', 'commandcode'];
    const out = {};
    for (const provider of pids) {
      let lastNote = null;
      for (let i = dates.length - 1; i >= 0; i--) {
        const p = this.data.days[dates[i]].providers?.[provider];
        if (lastNote == null && typeof p?.note === 'string' && p.note) {
          lastNote = p.note;
        }
        if (!out[provider] && p) {
          out[provider] = {
            date: dates[i],
            tokens: Number.isFinite(p.tokens) ? p.tokens : null,
            costUsd: Number.isFinite(p.costUsd) ? p.costUsd : null,
            estimated: Boolean(p.estimated),
            at: p.at || null,
            note: null,
          };
        }
        if (out[provider] && lastNote != null) break;
      }
      if (out[provider]) out[provider].note = lastNote;
    }
    return out;
  }

  /** 某个 provider 的累计读数**连续多少天没变了**（含最新那天）。0 = 今天刚涨过。 */
  stagnantDays(provider) {
    const dates = Object.keys(this.data.days).sort();
    const vals = [];
    for (const d of dates) {
      const p = this.data.days[d].providers?.[provider];
      if (p && Number.isFinite(p.tokens)) vals.push(p.tokens);
    }
    if (vals.length < 2) return 0;
    let n = 0;
    for (let i = vals.length - 1; i > 0; i--) {
      if (vals[i] === vals[i - 1]) n++;
      else break;
    }
    return n;
  }

  /** UI 用的一揽子：四种粒度 + 元信息 */
  snapshot(counts = { day: 14, week: 12, month: 12, year: 5 }) {
    const series = {};
    for (const g of ['day', 'week', 'month', 'year']) {
      series[g] = this.aggregate(g, counts[g]);
    }
    const daily = this.dailySeries();
    const totalAll = daily.reduce((a, d) => a + d.total, 0);
    const latest = this.latestByProvider();
    return {
      generatedAt: new Date().toISOString(),
      trackedDays: Object.keys(this.data.days).length,
      totalTokens: totalAll,
      series,
      // 采样最早一天：用来提示"曲线从这天开始积累"
      since: Object.keys(this.data.days).sort()[0] || null,
      latest,
      stagnant: {
        opencode: this.stagnantDays('opencode'),
        commandcode: this.stagnantDays('commandcode'),
      },
    };
  }
}

/** 从 commandcode 的 /alpha/usage/summary 响应取 token / 金额 */
function fromCommandCode(payload) {
  const pick = (k) => (typeof payload?.[k] === 'number' ? payload[k] : null);
  const tokens = pick('totalTokens');
  // totalCost 单位未知（实测全 0），先按美元存；拿不到就用 credit 字段兜底都存 null
  const costUsd = pick('totalCost');
  return { tokens, costUsd, estimated: false };
}

/**
 * 从 OpenCode 的 windows 估算 token。
 * windows 里 used/limit 是美元（接口只给 percent，由 opencode.cjs 折算），
 * 这里取**本月窗口**的已用金额 ÷ 混合单价反推 token。
 * 单价基准 = DeepSeek V4.1 Flash，见 OC_USD_PER_MTOK 的说明。
 */
function fromOpenCode(windows) {
  const month = (windows || []).find((w) => w.key === 'month');
  const usedUsd = Number.isFinite(month?.used) ? month.used : null;
  if (usedUsd === null) return { tokens: null, costUsd: null, estimated: true };
  return {
    tokens: Math.round((usedUsd / OC_USD_PER_MTOK) * 1e6),
    costUsd: usedUsd,
    estimated: true,
  };
}

module.exports = {
  UsageHistory,
  fromCommandCode,
  fromOpenCode,
  ymd,
  weekStart,
  shiftDays,
  OC_USD_PER_MTOK,
  FILE_NAME,
};
