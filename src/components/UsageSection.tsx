import type { OpenCodeProfile, UsageResult } from '../types';
import { colorOf, fmtMoney, fmtResetLabel, remainSeconds, severityOf } from '../format';

type OkUsage = Extract<UsageResult, { ok: true }>;

interface Props {
  usage: UsageResult | null;
  lastOk: OkUsage | null;
  loading: boolean;
  hasProfiles: boolean;
  now: number;
  onOpenSettings: () => void;
  profiles: OpenCodeProfile[];
  activeProfileId: string;
  usageMap: Record<string, UsageResult>;
  lastOkMap: Record<string, OkUsage>;
  onSwitchProfile: (id: string) => void;
}

function pickUsage(
  id: string,
  usageMap: Record<string, UsageResult>,
  lastOkMap: Record<string, OkUsage>
): OkUsage | null {
  const u = usageMap[id];
  if (u?.ok) return u as OkUsage;
  return lastOkMap[id] ?? null;
}

/** 把一个账号的三个窗口压成「最紧张的剩余量」，用于账号切换条上的迷你摘要 */
function summarize(u: OkUsage | null | undefined) {
  if (!u) return null;
  const withPct = u.windows.filter((w) => w.usedPct != null);
  if (!withPct.length) return { color: 'var(--text-3)', remainPct: null as number | null };
  const worst = withPct.reduce((a, b) => ((b.usedPct ?? 0) > (a.usedPct ?? 0) ? b : a));
  const remain = worst.remainingPct ?? (worst.usedPct != null ? 100 - worst.usedPct : null);
  return { color: colorOf(severityOf(worst.usedPct)), remainPct: remain };
}

export default function UsageSection({
  usage,
  lastOk,
  loading,
  hasProfiles,
  now,
  onOpenSettings,
  profiles,
  activeProfileId,
  usageMap,
  lastOkMap,
  onSwitchProfile,
}: Props) {
  const live = usage?.ok ? (usage as OkUsage) : null;
  const shown = live ?? lastOk;
  const stale = !live && Boolean(lastOk);

  // 额度挂在账号上而不是 key 上：若两个账号用量完全一致，多半填的是同一个账号的多个 key
  const dupNames = (() => {
    const groups: Record<string, string[]> = {};
    for (const p of profiles) {
      const u = pickUsage(p.id, usageMap, lastOkMap);
      if (!u || !u.windows.some((w) => w.used)) continue;
      const sig = u.windows.map((w) => `${w.used ?? ''}/${w.limit ?? ''}`).join('|');
      (groups[sig] ||= []).push(p.name);
    }
    return Object.values(groups).filter((g) => g.length > 1).flat();
  })();

  let notice: { kind: string; text: string } | null = null;
  if (!hasProfiles) {
    notice = { kind: 'warn', text: '未配置 OpenCode Go API Key，用量面板无法取数。' };
  } else if (usage && !usage.ok) {
    notice = { kind: 'err', text: `${usage.message}${stale ? '（下面为上次成功的数据）' : ''}` };
  } else if (stale) {
    notice = { kind: 'warn', text: '刷新失败，显示上次成功的数据。' };
  }

  return (
    <section className="section">
      <div className="section-head">
        <span className="section-title">OpenCode Go</span>
        <span className="section-meta">
          {loading
            ? '刷新中…'
            : live
              ? `更新于 ${new Date(live.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
              : '—'}
        </span>
      </div>

      {profiles.length > 1 && (
        <div className="acct-row">
          {profiles.map((p) => {
            const u = usageMap[p.id];
            const ok = pickUsage(p.id, usageMap, lastOkMap);
            const sum = summarize(ok);
            const failed = Boolean(u && !u.ok);
            const tip = failed
              ? `${p.name}：${(u as { message: string }).message}`
              : sum?.remainPct == null
                ? p.name
                : `${p.name}：最紧张的窗口还剩 ${Math.round(sum.remainPct)}%`;
            return (
              <button
                key={p.id}
                className={`acct${p.id === activeProfileId ? ' on' : ''}`}
                title={tip}
                onClick={() => onSwitchProfile(p.id)}
              >
                <span
                  className="acct-dot"
                  style={{ background: failed ? 'var(--red)' : (sum?.color ?? 'var(--text-3)') }}
                />
                <span className="acct-name">{p.name}</span>
                <span className="acct-pct">
                  {failed
                    ? '失败'
                    : sum?.remainPct == null
                      ? '—'
                      : `${Math.round(sum.remainPct)}%`}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {dupNames.length > 1 && (
        <div className="hint" style={{ marginTop: -5, marginBottom: 10 }}>
          这几个账号的用量完全相同（{dupNames.join('、')}），多半是同一个账号下的多个 key。
          额度按账号共享，只留一条就够了。
        </div>
      )}

      {notice && (
        <div className={`notice ${notice.kind}`} style={{ marginBottom: 11 }}>
          <span className="dot" />
          <span>
            {notice.text}
            {!hasProfiles && (
              <>
                {' '}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    onOpenSettings();
                  }}
                  style={{ color: 'var(--accent)' }}
                >
                  去设置
                </a>
              </>
            )}
          </span>
        </div>
      )}

      {shown?.windows.map((w) => {
        if (!w.detected && w.usedPct == null) {
          return (
            <div className="qrow" key={w.key}>
              <div className="qrow-top">
                <span className="qrow-label">{w.label}</span>
                <span className="qrow-miss">接口未返回该窗口</span>
              </div>
              <div className="bar" />
            </div>
          );
        }

        const sev = severityOf(w.usedPct);
        const color = colorOf(sev);
        const remainPct = w.remainingPct ?? (w.usedPct != null ? 100 - w.usedPct : null);
        const secs = remainSeconds(w.resetInSec, w.resetsAt, now);
        const limit = w.limit ?? w.planUsd;

        return (
          <div className="qrow" key={w.key}>
            <div className="qrow-top">
              <span className="qrow-label">
                {w.label}
                {w.status && w.status !== 'ok' && <span className="qrow-flag">{w.status}</span>}
              </span>
              <span className="qrow-reset">{fmtResetLabel(secs)}</span>
            </div>
            <div className="bar">
              <i
                style={{
                  width: `${remainPct == null ? 0 : Math.max(1.5, remainPct)}%`,
                  background: color,
                }}
              />
            </div>
            <div className="qrow-foot">
              <span className="qrow-remain" style={{ color }}>
                剩余 <b>{remainPct == null ? '—' : Math.round(remainPct)}%</b>
              </span>
              <span
                className="qrow-usd"
                title={
                  w.derived
                    ? `接口只返回百分比，金额按套餐基准 ${fmtMoney(w.planUsd)} 折算，仅供参考`
                    : undefined
                }
              >
                {w.used == null
                  ? `上限 ${fmtMoney(limit)}`
                  : `${w.derived ? '≈' : '已用 '}${fmtMoney(w.used)} / ${fmtMoney(limit)}`}
              </span>
            </div>
          </div>
        );
      })}

      {shown && shown.windows.every((w) => !w.detected) && (
        <div className="notice" style={{ marginTop: 11 }}>
          <span className="dot" />
          <span>
            已连通接口但未能识别额度字段，说明返回结构与解析器不匹配。展开下方原始响应以便修正映射。
          </span>
        </div>
      )}

      {shown?.raw && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ fontSize: 11, color: 'var(--text-3)', cursor: 'pointer' }}>
            原始响应 / 字段识别
          </summary>
          <div className="path" style={{ marginTop: 6, maxHeight: 120, overflow: 'auto' }}>
            {shown.raw}
          </div>
        </details>
      )}
    </section>
  );
}
