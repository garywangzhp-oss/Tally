import { useState } from 'react';
import type { CheckinDiagnose, CreditBalanceResult, StatusResult } from '../types';
import { dayOnly, fmtCredits, severityOf, colorOf, text } from '../format';

type OkStatus = Extract<StatusResult, { ok: true }>;
type OkBalance = Extract<CreditBalanceResult, { ok: true }>;

interface Props {
  status: StatusResult | null;
  lastOk: OkStatus | null;
  balance: CreditBalanceResult | null;
  lastOkBalance: OkBalance | null;
  diagnose: CheckinDiagnose | null;
  loading: boolean;
  claiming: boolean;
  toast: string | null;
  onClaim: () => void;
  onRedetect: () => void;
}

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function buildWeek(checkinDates: string[], today: Date) {
  const mon = new Date(today);
  mon.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const todayIso = isoOf(today);
  return WEEK_LABELS.map((label, i) => {
    const cur = new Date(mon);
    cur.setDate(mon.getDate() + i);
    const iso = isoOf(cur);
    return {
      label,
      iso,
      done: checkinDates.includes(iso),
      isToday: iso === todayIso,
      future: iso > todayIso,
    };
  });
}

/** uin 是手机号派生的长数字，展示时打码，避免截图外传时泄露 */
function maskUin(uin: string | null | undefined): string {
  const s = String(uin || '');
  if (s.length < 6) return s;
  return `${s.slice(0, 3)}****${s.slice(-3)}`;
}

export default function BuddySection({
  status,
  lastOk,
  balance,
  lastOkBalance,
  diagnose,
  loading,
  claiming,
  toast,
  onClaim,
  onRedetect,
}: Props) {
  const [showDetail, setShowDetail] = useState(false);

  const live = status?.ok ? (status as OkStatus) : null;
  const shown = live ?? lastOk;
  const s = shown?.status ?? null;
  const today = new Date();

  // 余额：优先用本次结果，失败时回落到上一次成功值，避免数字一闪变「—」
  const balLive = balance?.ok ? (balance as OkBalance) : null;
  const bal = balLive ?? lastOkBalance;
  const cred = bal?.credits ?? null;
  const balanceStale = Boolean(!balLive && bal);
  const pkgTip = bal?.packages.length
    ? bal.packages
        .map((p) => `${p.packageCode}\n  剩余 ${fmtCredits(p.remain)} / 总 ${fmtCredits(p.total)}`)
        .join('\n')
    : undefined;

  const canClaim = Boolean(status?.ok && s && s.active && !s.todayCheckedIn);
  const unlinked = Boolean(diagnose && !diagnose.linked);
  // 已自持 refreshToken：能自助续期，跟客户端登录态文件彻底解耦（「永久可用」的判据）
  const selfRenew = Boolean(diagnose?.selfRenew);
  // 降级：手里没有 refreshToken，只能靠一次性的明文留档 —— 到期即失效
  const degraded = Boolean(diagnose?.degraded);

  let buttonText = '领取今日积分';
  if (!s) buttonText = loading ? '读取中…' : '未关联 WorkBuddy';
  else if (!s.active) buttonText = '当前无签到活动';
  else if (s.todayCheckedIn)
    buttonText = `今日已领 +${s.todayCredit || s.dailyCredit}${s.streakDays ? ` · 连续 ${s.streakDays} 天` : ''}`;
  else buttonText = `领取今日积分 +${s.dailyCredit}`;

  // 关联到的 WorkBuddy 账号：优先用诊断结果（即使接口失败也能显示），兜底用状态返回。
  // ⚠️ 必须过 text()：新版客户端的 nickname 是密文对象，直接渲染会炸掉整个界面。
  const acctName = text(diagnose?.nickname) ?? text(shown?.account?.nickname) ?? null;
  const acctUin = text(diagnose?.uin) ?? text(shown?.account?.uin) ?? null;
  const linked = Boolean(diagnose ? diagnose.linked : shown);

  let notice: { kind: string; text: string } | null = null;
  if (status && !status.ok) {
    const msg = diagnose?.message || status.message;
    notice = {
      kind: status.reason === 'expired' ? 'err' : 'warn',
      text:
        status.reason === 'no-file'
          ? `${msg}（同一台电脑、同一个 Windows 用户下登录才有效）`
          : msg,
    };
  }

  return (
    <section className="section">
      <div className="section-head">
        <span className="section-title">WorkBuddy 加油站</span>
        <span className="section-meta">
          {linked && acctName ? (
            <span className="wb-acct" title={`uin ${acctUin ?? ''}`}>
              <span className="wb-dot" />
              {acctName}
              {acctUin ? ` · ${maskUin(acctUin)}` : ''}
            </span>
          ) : (
            ''
          )}
          {s?.season ? `第 ${s.season} 期` : ''}
          {s?.activityName ? ` · ${s.activityName}` : ''}
        </span>
      </div>

      {/* 自持凭据（selfRenew）不显示横幅 —— 一切正常时保持面板干净；
          只有走降级路径（degraded）才提示，见下 */}
      {/* 降级：只有一次性的明文留档，没有可续期的令牌 */}
      {degraded && (
        <div className="notice warn" style={{ marginBottom: 10 }}>
          <span className="dot" />
          <span>
            凭据取自客户端升级留档（明文格式），且未拿到可自助续期的令牌，签到与余额可用
            {diagnose?.expiresAt ? `至 ${dayOnly(diagnose.expiresAt)}` : ''}。
          </span>
        </div>
      )}

      {notice && (
        <div className={`notice ${notice.kind}`} style={{ marginBottom: 10 }}>
          <span className="dot" />
          <span>
            {notice.text}
            {unlinked && (
              <>
                {' '}
                <button className="link-btn" onClick={onRedetect} disabled={loading}>
                  {loading ? '检测中…' : '重新检测'}
                </button>
              </>
            )}
          </span>
        </div>
      )}

      <div className="buddy">
        {/* 账户级积分余额：跟下面的「本期累计」不是一回事，后者只统计本次签到活动 */}
        <div className="wb-balance" title={pkgTip}>
          <div className="wb-balance-head">
            <span className="wb-balance-label">
              积分余额
              {balanceStale && <span className="wb-balance-stale">待更新</span>}
            </span>
            <span className="wb-balance-value">
              {cred ? fmtCredits(cred.remain) : '—'}
              <span>分</span>
            </span>
          </div>
          <div className="wb-bar">
            <i
              style={{
                width: `${cred ? Math.max(cred.usedPct, cred.used > 0 ? 1.5 : 0) : 0}%`,
                background: colorOf(severityOf(cred?.usedPct ?? 0)),
              }}
            />
          </div>
          <div className="wb-balance-foot">
            <span>
              {cred ? `已用 ${fmtCredits(cred.used)} / 总额 ${fmtCredits(cred.total)}` : '余额读取中…'}
            </span>
            <span className="spacer">
              {cred ? `${cred.usedPct.toFixed(1)}%` : ''}
              {bal?.isPaidUser ? ' · 付费' : ''}
            </span>
          </div>
        </div>

        <div className="buddy-stats">
          <div className="stat">
            <div className="stat-label">连续签到</div>
            <div className="stat-value">
              {s ? s.streakDays : '—'}
              <span>天</span>
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">本期累计</div>
            <div className="stat-value">
              {s ? s.totalCredits : '—'}
              <span>分</span>
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">本周已签</div>
            <div className="stat-value">
              {s ? s.weekCheckinDays : '—'}
              <span>/7 天</span>
            </div>
          </div>
        </div>

        <div className="dots">
          {buildWeek(s?.checkinDates ?? [], today).map((d) => (
            <div
              key={d.iso}
              className={`dot-day${d.done ? ' done' : ''}${d.isToday ? ' today' : ''}`}
              title={d.iso}
              style={d.future && !d.done ? { opacity: 0.42 } : undefined}
            >
              {d.done ? '✓' : d.label}
            </div>
          ))}
        </div>

        <button
          className={`claim-btn${claiming ? ' busy' : ''}`}
          disabled={!canClaim || claiming}
          onClick={onClaim}
        >
          {claiming ? '领取中…' : buttonText}
        </button>

        <div className="buddy-foot">
          <span>
            {s?.periodStart ? `${dayOnly(s.periodStart)} 起` : ''}
            {s?.periodEnd ? ` · ${dayOnly(s.periodEnd)} 截止` : ''}
          </span>
          <span className="spacer">
            {shown?.tokenExpiresInDays != null ? `登录态剩 ${shown.tokenExpiresInDays} 天` : ''}
          </span>
        </div>
      </div>

      {toast && (
        <div className="notice" style={{ marginTop: 9 }}>
          <span className="dot" />
          <span>{toast}</span>
        </div>
      )}

      {loading && !s && (
        <div className="notice" style={{ marginTop: 9 }}>
          正在读取签到状态…
        </div>
      )}

      {/* 关联详情：换人使用 / 换机器时用来自查凭据到底读到了什么 */}
      {diagnose && (
        <div className="wb-detail">
          <button className="wb-detail-toggle" onClick={() => setShowDetail((v) => !v)}>
            <span className="caret">{showDetail ? '▾' : '▸'}</span>
            关联详情
            <span style={{ marginLeft: 'auto' }} className="mono-dim">
              {linked ? '已关联' : '未关联'}
            </span>
          </button>
          {showDetail && (
            <div className="wb-detail-body">
              <div className="kv">
                <span>账号</span>
                <span>
                  {text(diagnose.nickname) ?? (diagnose.encrypted ? '（昵称已加密）' : '—')}
                  {text(diagnose.accountType) ? `（${text(diagnose.accountType)}）` : ''}
                </span>
              </div>
              <div className="kv">
                <span>归属</span>
                <span>{text(diagnose.uid) ? `${text(diagnose.uid)!.slice(0, 8)}…` : '—'}</span>
              </div>
              {diagnose.encrypted && (
                <div className="kv kv-col">
                  <span className="warn-text">
                    {diagnose.selfRenew
                      ? '客户端已把登录态文件里的 token 加密（at-rest-crypto：AES-256-GCM，密钥是客户端编译期静态密钥，Tally 解不开）。Tally 改用自持的 refreshToken 向官方续期端点自助换新，因此仍然可用 —— 客户端文件全程只读，不回写、不外传。'
                      : '登录态已加密：WorkBuddy 新版把 accessToken 等字段改成 at-rest-crypto 密文（AES-256-GCM，密钥在客户端原生模块里），Tally 解不开，且未找到可用的明文留档 —— 签到与余额暂不可用。用量面板不受影响。'}
                  </span>
                </div>
              )}
              <div className="kv">
                <span>凭据来源</span>
                <span>
                  {diagnose.credSource === 'stored'
                    ? 'Tally 自持（本地保存）'
                    : diagnose.credSource === 'refreshed'
                      ? 'Tally 自助续期'
                      : diagnose.credSource === 'backup'
                        ? '客户端迁移留档（明文）'
                        : diagnose.source === 'known'
                          ? '客户端登录态（标准位置）'
                          : diagnose.source === 'search'
                            ? '客户端登录态（扫描发现）'
                            : '未找到'}
                </span>
              </div>
              {(diagnose.selfRenew || diagnose.credSource === 'backup') && (
                <div className="kv kv-col">
                  <span>自动续期</span>
                  <span>
                    {diagnose.selfRenew
                      ? `已持有续期凭证${diagnose.refreshInDays != null ? `，${diagnose.refreshInDays} 天内会自动换新` : ''}`
                      : '无续期凭证：现有凭据到期后将不可用'}
                  </span>
                </div>
              )}
              {diagnose.refreshError && (
                <div className="kv kv-col">
                  <span className="warn-text">
                    本次续期未成功（先用未过期的本地令牌顶着）：{diagnose.refreshError}
                  </span>
                </div>
              )}
              {diagnose.degraded && (
                <div className="kv kv-col">
                  <span>留档文件</span>
                  <span className="mono-dim break">{diagnose.backupFile ?? '—'}</span>
                </div>
              )}
              <div className="kv">
                <span>接口</span>
                <span className="mono-dim">{diagnose.apiHost}</span>
              </div>
              <div className="kv">
                <span>有效期</span>
                <span>
                  {diagnose.expiresInDays != null
                    ? `剩 ${diagnose.expiresInDays} 天`
                    : '—'}
                  {diagnose.refreshInDays != null ? ` / 续期 ${diagnose.refreshInDays} 天` : ''}
                </span>
              </div>
              <div className="kv kv-col">
                <span>登录态文件</span>
                <span className="mono-dim break">
                  {diagnose.file ?? `未找到（已尝试 ${diagnose.searchedCount} 个位置）`}
                </span>
              </div>
              {!linked && !diagnose.encrypted && diagnose.dataDirExists && (
                <div className="kv kv-col">
                  <span className="warn-text">
                    {diagnose.reason === 'bad-file'
                      ? '登录态文件存在但读取失败（可能被客户端独占或权限不足）。可尝试关闭 WorkBuddy 客户端后再点「重新检测」。'
                      : '检测到客户端数据目录，但没有登录态 —— 请打开 WorkBuddy 客户端完成登录。'}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
