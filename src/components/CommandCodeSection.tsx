import type { CommandCodeResult } from '../types';
import { colorOf, fmtMoney, fmtResetLabel, remainSeconds, severityOf } from '../format';

type OkCC = Extract<CommandCodeResult, { ok: true }>;

interface Props {
  result: CommandCodeResult | null;
  lastOk: OkCC | null;
  loading: boolean;
  hasKey: boolean;
  now: number;
  onOpenSettings: () => void;
}

export default function CommandCodeSection({
  result,
  lastOk,
  loading,
  hasKey,
  now,
  onOpenSettings,
}: Props) {
  const live = result?.ok ? (result as OkCC) : null;
  const shown = live ?? lastOk;
  const stale = !live && Boolean(lastOk);

  let notice: { kind: string; text: string } | null = null;
  if (!hasKey) {
    notice = { kind: 'warn', text: '未配置 commandcode API Key，额度面板无法取数。' };
  } else if (result && !result.ok) {
    notice = { kind: 'err', text: `${result.message}${stale ? '（下面为上次成功的数据）' : ''}` };
  } else if (stale) {
    notice = { kind: 'warn', text: '刷新失败，显示上次成功的数据。' };
  }

  // 月度额度：monthly + purchased + free 是可用总量
  const s = shown?.summary;
  const monthTotal =
    s && (s.monthlyCredits != null || s.purchasedCredits != null || s.freeCredits != null)
      ? (s.monthlyCredits ?? 0) + (s.purchasedCredits ?? 0) + (s.freeCredits ?? 0)
      : null;

  return (
    <section className="section">
      <div className="section-head">
        <span className="section-title">
          commandcode
          {shown?.plan?.label && <span className="cc-plan">{shown.plan.label}</span>}
        </span>
        <span className="section-meta">
          {loading
            ? '刷新中…'
            : live
              ? `更新于 ${new Date(live.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
              : '—'}
        </span>
      </div>

      {notice && (
        <div className={`notice ${notice.kind}`} style={{ marginBottom: 11 }}>
          <span className="dot" />
          <span>
            {notice.text}
            {!hasKey && (
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

        const color = colorOf(severityOf(w.usedPct));
        const remainPct = w.remainingPct ?? (w.usedPct != null ? 100 - w.usedPct : null);
        const secs = remainSeconds(w.resetInSec, w.resetsAt, now);
        const limit = w.limit ?? 0;

        return (
          <div className="qrow" key={w.key}>
            <div className="qrow-top">
              <span className="qrow-label">
                {w.label}
                {w.status === 'exceeded' && <span className="qrow-flag">已超限</span>}
              </span>
              <span className="qrow-reset">
                {secs == null ? '窗口未开启' : fmtResetLabel(secs)}
              </span>
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
              <span className="qrow-usd">
                {w.used == null
                  ? `上限 ${fmtMoney(limit)}`
                  : `已用 ${fmtMoney(w.used)} / ${fmtMoney(limit)}`}
              </span>
            </div>
          </div>
        );
      })}

      {monthTotal != null && (
        <div className="cc-month">
          <span>月度额度</span>
          <span className="cc-month-val">
            {fmtMoney(monthTotal)}
            {s?.belowThreshold ? <span className="cc-warn"> 余额偏低</span> : null}
          </span>
        </div>
      )}

      {shown?.plan?.currentPeriodEnd && (
        <div className="cc-month" style={{ marginTop: -4 }}>
          <span>本期重置</span>
          <span className="cc-month-val">
            {new Date(shown.plan.currentPeriodEnd).toLocaleDateString('zh-CN')}
            {shown.plan.cancelAtPeriodEnd ? <span className="cc-warn"> 到期取消</span> : null}
          </span>
        </div>
      )}

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
