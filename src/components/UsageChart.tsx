import { useMemo, useState } from 'react';
import type { UsageBucket, UsageGrain, UsageHistorySnapshot } from '../types';

/**
 * token 用量坐标系图（日 / 周 / 月 / 年）。
 *
 * ⚠️ 数据是 **本地累积采样** 得来的，不是上游接口给的时序：
 *   · OpenCode 侧只给 percent → 按金额折算估算（estimated，UI 用 ≈ 标示）
 *   · commandcode 侧 /alpha/usage/summary 直给 totalTokens（真实值）
 *   所以曲线**从 Tally 开始采集那天起**才有数据，越用越准。
 *
 * 纯手写 SVG，不引图表库 —— 面板只有 400px 宽，库的开销和风格都划不来。
 */

interface Props {
  snapshot: UsageHistorySnapshot | null;
  loading: boolean;
  /** 是否显示「≈ 估算」角标（OpenCode 侧没有真实 token 数） */
  hasEstimated: boolean;
  /** 折叠状态由 config 持久化，这样重启后记得用户的选择 */
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
}

const GRAINS: { key: UsageGrain; label: string }[] = [
  { key: 'day', label: '日' },
  { key: 'week', label: '周' },
  { key: 'month', label: '月' },
  { key: 'year', label: '年' },
];

// 两个来源分色：OpenCode 用主蓝、commandcode 用青绿，跟额度条的语义色区分开
const COLOR_OC = '#6d8df8';
const COLOR_CC = '#35d399';

const PAD_L = 34; // 左侧留给 Y 轴刻度
const PAD_R = 6;
const PAD_T = 8;
const PAD_B = 18; // 底部留给 X 轴标签
const H = 108;

const ICON_CHEVRON = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.2 1.6L6.8 5l-3.6 3.4" />
  </svg>
);

/** 紧凑 token 数：1.2M / 340K / 980 */
export function fmtTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}

/** 找一个好看的 Y 轴上限（1/2/5 × 10^n），让刻度落在整齐的数上 */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const n = v / base;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  const scaled = step * base;
  // 五等分时可能还有点紧，往上取一档更稳
  return scaled < v ? scaled * 2 : scaled;
}

export default function UsageChart({
  snapshot,
  loading,
  hasEstimated,
  expanded,
  onToggle,
}: Props) {
  const [grain, setGrain] = useState<UsageGrain>('day');
  const [hover, setHover] = useState<number | null>(null);

  const bars: UsageBucket[] = snapshot?.series?.[grain] ?? [];

  // 关掉时是 400px 宽的固定视口（主进程按内容高定窗口高），
  // 但等比缩放只改 zoom 不改 CSS 视口，所以这里可以直接按 400 布局。
  const W = 372;
  const plotW = W - PAD_L - PAD_R;

  const geom = useMemo(() => {
    const max = Math.max(...bars.map((b) => b.total), 0);
    const yMax = niceCeil(max || 1);
    const slot = bars.length ? plotW / bars.length : plotW;
    // 柱宽占槽位 62%，至少 2px，避免点多时细成头发丝
    const barW = Math.max(2, Math.min(18, slot * 0.62));
    const x = (i: number) => PAD_L + slot * i + (slot - barW) / 2;
    const y = (v: number) => PAD_T + (1 - v / yMax) * (H - PAD_T - PAD_B);
    return { yMax, slot, barW, x, y };
  }, [bars, plotW]);

  const ticks = useMemo(() => {
    const { yMax } = geom;
    return [0, yMax / 2, yMax].map((v) => ({ v, y: geom.y(v) }));
  }, [geom]);

  // X 轴标签抽稀：最多显示 6 个，避免挤在一起
  const labelEvery = Math.max(1, Math.ceil(bars.length / 6));

  const hasAny = bars.some((b) => b.total > 0);

  // 折叠态也能看到关键数字：用当前粒度的合计当摘要，不至于每次都要点开
  const summaryTotal = snapshot ? bars.reduce((a, b) => a + b.total, 0) : 0;
  const scopeLabel =
    grain === 'day' ? '近 14 天' : grain === 'week' ? '近 12 周' : grain === 'month' ? '近 12 月' : '近 5 年';

  const head = (
    <button
      className={`uc-head${expanded ? ' open' : ''}`}
      onClick={() => onToggle(!expanded)}
      title={expanded ? '收起用量图表' : '展开用量图表'}
    >
      <span className={`uc-chev${expanded ? ' open' : ''}`}>{ICON_CHEVRON}</span>
      <span className="section-title">
        token 用量
        {hasEstimated && <span className="uc-est">含估算</span>}
      </span>
      <span className="uc-head-spacer" />
      {/* 折叠时把最关键的数字直接露出来，省得为了看一眼总量还得点开 */}
      <span className="uc-head-meta">
        {loading && !snapshot
          ? '加载中…'
          : snapshot && snapshot.trackedDays > 0
            ? `${scopeLabel} ${hasEstimated ? '≈ ' : ''}${fmtTokens(summaryTotal)}`
            : '尚无记录'}
      </span>
    </button>
  );

  if (!expanded) {
    return <section className="section uc-collapsed">{head}</section>;
  }

  if (!snapshot || (loading && !bars.length)) {
    return (
      <section className="section">
        {head}
        <div className="uc-empty">正在读取本地用量记录…</div>
      </section>
    );
  }

  const hoveredBucket = hover != null ? bars[hover] : null;

  return (
    <section className="section">
      {head}

      <div className="uc-body">
        <div className="uc-tabs">
          {GRAINS.map((g) => (
            <button
              key={g.key}
              className={`uc-tab${grain === g.key ? ' on' : ''}`}
              onClick={() => {
                setGrain(g.key);
                setHover(null);
              }}
            >
              {g.label}
            </button>
          ))}
          <span className="uc-tabs-spacer" />
          <span className="uc-legend">
            <i style={{ background: COLOR_OC }} />
            OpenCode
          </span>
          <span className="uc-legend">
            <i style={{ background: COLOR_CC }} />
            commandcode
          </span>
        </div>

        {!hasAny ? (
          <div className="uc-empty">
            {snapshot.trackedDays > 0
              ? '该时间范围内还没有用量记录。'
              : '用量曲线从 Tally 开始采集那天起积累 —— 上游没有可用的 token 时序接口，只能本地攒。'}
          </div>
        ) : (
          <svg
            className="uc-svg"
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            height={H}
            role="img"
            aria-label="token 用量趋势图"
          >
          {/* Y 轴网格 + 刻度 */}
          {ticks.map((t, i) => (
            <g key={i}>
              <line
                x1={PAD_L}
                x2={W - PAD_R}
                y1={t.y}
                y2={t.y}
                stroke="rgba(255,255,255,0.07)"
                strokeWidth={1}
              />
              <text x={PAD_L - 5} y={t.y + 3} className="uc-axis" textAnchor="end">
                {fmtTokens(t.v)}
              </text>
            </g>
          ))}

          {/* 柱：下段 OpenCode，上段 commandcode 堆叠 */}
          {bars.map((b, i) => {
            const { x, y, barW } = geom;
            const bx = x(i);
            const yTop = y(b.total);
            const yOcTop = y(b.commandcode);
            const ocH = Math.max(0, yOcTop - yTop); // OpenCode 段高
            const ccH = Math.max(0, y(0) - yOcTop); // commandcode 段高
            const dim = hover != null && hover !== i;
            return (
              <g key={b.key} opacity={dim ? 0.35 : 1}>
                {ocH > 0 && (
                  <rect
                    x={bx}
                    y={yTop}
                    width={barW}
                    height={ocH}
                    rx={Math.min(2, barW / 3)}
                    fill={COLOR_OC}
                  />
                )}
                {ccH > 0 && (
                  <rect
                    x={bx}
                    y={yOcTop}
                    width={barW}
                    height={ccH}
                    rx={Math.min(2, barW / 3)}
                    fill={COLOR_CC}
                  />
                )}
                {/* 全 0 的日子留一条基线痕迹，避免看起来"漏了一格" */}
                {b.total === 0 && (
                  <rect
                    x={bx}
                    y={geom.y(0) - 1.5}
                    width={barW}
                    height={1.5}
                    rx={0.75}
                    fill="rgba(255,255,255,0.10)"
                  />
                )}
              </g>
            );
          })}

          {/* 命中区：整列可悬停，比只点柱子好点得多 */}
          {bars.map((b, i) => (
            <rect
              key={`hit-${b.key}`}
              x={PAD_L + geom.slot * i}
              y={PAD_T}
              width={geom.slot}
              height={H - PAD_T - PAD_B}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              style={{ cursor: 'default' }}
            />
          ))}

          {/* X 轴标签：每 labelEvery 个画一个。不再强制补末尾 —— 末尾跟上一个
              挨太近时两个日期会糊成一团（实测 10-0…10-07 重叠）。 */}
          {bars.map((b, i) =>
            i % labelEvery === 0 ? (
              <text
                key={`lb-${b.key}`}
                x={PAD_L + geom.slot * i + geom.slot / 2}
                y={H - 5}
                className="uc-axis"
                textAnchor="middle"
              >
                {b.label}
              </text>
            ) : null
          )}
        </svg>
        )}

        {/* 读数行：没悬停时显示总量，悬停时显示该桶明细 */}
        <div className="uc-readout">
          {hoveredBucket ? (
            <>
              <span className="uc-readout-date">
                {hoveredBucket.label}
                {grain === 'week' ? ' 周' : grain === 'year' ? ' 年' : ''}
              </span>
              <span className="uc-readout-val">
                合计{' '}
                <b>
                  {hoveredBucket.estimated ? '≈ ' : ''}
                  {fmtTokens(hoveredBucket.total)}
                </b>
              </span>
            </>
          ) : (
            <>
              <span className="uc-readout-date">{scopeLabel}</span>
              <span className="uc-readout-val">
                合计{' '}
                <b>
                  {hasEstimated ? '≈ ' : ''}
                  {fmtTokens(summaryTotal)}
                </b>
              </span>
            </>
          )}
        </div>

        {hoveredBucket && (
          <div className="uc-detail">
            <span style={{ color: COLOR_OC }}>
              OpenCode <b>{fmtTokens(hoveredBucket.opencode)}</b>
            </span>
            <span style={{ color: COLOR_CC }}>
              commandcode <b>{fmtTokens(hoveredBucket.commandcode)}</b>
            </span>
            {grain !== 'day' && hoveredBucket.days > 0 && (
              <span className="uc-days">采到 {hoveredBucket.days} 天</span>
            )}
          </div>
        )}

        {snapshot.since && (
          <div className="uc-foot">
            自 {snapshot.since} 起累计 {hasEstimated ? '≈ ' : ''}
            {fmtTokens(snapshot.totalTokens)}
            {hasEstimated && ' · OpenCode 侧按 DeepSeek V4.1 Flash 单价估算'}
          </div>
        )}
      </div>
    </section>
  );
}
