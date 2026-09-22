export function fmtCountdown(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '';
  if (sec <= 0) return '0m';
  // 先四舍五入到「分钟」再拆分。若分别取 h 和 m 再各自 round，
  // 4h59m30s 会被算成 4h60m（分钟进到 60 却没往小时进位）。
  const totalMin = Math.round(sec / 60);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return m > 0 ? `${d}d ${h}h ${m}m` : `${d}d ${h}h`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${Math.max(1, m)}m`;
}

// 重置文案：接口不给重置时间时不能硬凑成「已重置后重置」
export function fmtResetLabel(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '重置时间未提供';
  if (sec <= 0) return '即将重置';
  return `${fmtCountdown(sec)} 后重置`;
}

export function remainSeconds(
  resetInSec: number | null,
  resetsAt: string | null,
  now: number
): number | null {
  if (typeof resetInSec === 'number' && resetInSec >= 0) return resetInSec;
  if (resetsAt) {
    const t = Date.parse(resetsAt);
    if (!Number.isNaN(t)) return Math.max(0, Math.round((t - now) / 1000));
  }
  return null;
}

export function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${n.toFixed(2)}`;
}

export type Severity = 'ok' | 'warn' | 'hot';

export function severityOf(usedPct: number | null | undefined): Severity {
  if (usedPct == null || !Number.isFinite(usedPct)) return 'ok';
  if (usedPct >= 85) return 'hot';
  if (usedPct >= 60) return 'warn';
  return 'ok';
}

export function colorOf(sev: Severity): string {
  if (sev === 'hot') return '#f4736f';
  if (sev === 'warn') return '#f5b740';
  return '#35d399';
}

// 版本号展示：0.10.0 → 0.10（末位补位零不显示）
export function fmtVersion(v: string | null | undefined): string {
  if (!v) return '—';
  return v.replace(/\.0$/, '');
}

export function dayOnly(s: string | null | undefined): string {
  if (!s) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[2]}/${m[3]}` : s;
}

/**
 * 积分数量：服务端给的是 "6533.99000103" 这种长小数，直接显示会撑爆排版。
 * 规则：整数就不带小数；有小数则保留两位并把末尾的 0 去掉。
 */
export function fmtCredits(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const text =
    abs >= 1000
      ? n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
      : String(Math.round(n * 100) / 100);
  return text;
}
