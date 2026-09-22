import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppInfo,
  CheckinDiagnose,
  ClaimResult,
  CreditBalanceResult,
  TallyConfig,
  StatusResult,
  UsageResult,
} from './types';
import { fmtCredits, fmtVersion } from './format';
import UsageSection from './components/UsageSection';
import BuddySection from './components/BuddySection';
import SettingsSection from './components/SettingsSection';
import ResizeGrip from './components/ResizeGrip';

type OkUsage = Extract<UsageResult, { ok: true }>;
type OkStatus = Extract<StatusResult, { ok: true }>;
type OkBalance = Extract<CreditBalanceResult, { ok: true }>;

const ICON_PIN = (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5.2 1.8h3.6l-.6 3 1.9 2H3.9l1.9-2-.6-3z" />
    <path d="M7 6.8v5.4" />
  </svg>
);

const ICON_SLIDERS = (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
    <path d="M2 4.6h10M2 9.4h10" />
    <circle cx="5.2" cy="4.6" r="1.5" />
    <circle cx="8.8" cy="9.4" r="1.5" />
  </svg>
);

const ICON_MIN = (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
    <path d="M3 7h8" />
  </svg>
);

const ICON_CLOSE = (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
    <path d="M3.6 3.6l6.8 6.8M10.4 3.6l-6.8 6.8" />
  </svg>
);

// 底部署名条
function Credit() {
  return (
    <div className="credit">
      <span>作者：GaryWang</span>
      <span className="spacer" />
      <span>版本 V {fmtVersion(__TALLY_VERSION__)}</span>
    </div>
  );
}

export default function App() {
  const [config, setConfig] = useState<TallyConfig | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  // 多账号：用量按 profileId 归类，切换账号不需要重新请求
  const [usageMap, setUsageMap] = useState<Record<string, UsageResult>>({});
  const [lastOkMap, setLastOkMap] = useState<Record<string, OkUsage>>({});
  const [mapError, setMapError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [lastOkStatus, setLastOkStatus] = useState<OkStatus | null>(null);
  const [balance, setBalance] = useState<CreditBalanceResult | null>(null);
  const [lastOkBalance, setLastOkBalance] = useState<OkBalance | null>(null);
  const [diagnose, setDiagnose] = useState<CheckinDiagnose | null>(null);
  const [view, setView] = useState<'main' | 'settings'>('main');
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  // 当前界面缩放倍率：设置页滑块改的是 config，拖右下角时由主进程推回来
  const [scale, setScale] = useState(1);
  const autoTried = useRef('');
  const cardRef = useRef<HTMLDivElement>(null);

  const profiles = config?.opencodeProfiles ?? [];
  const activeId = config?.activeProfileId ?? '';
  const activeUsage: UsageResult | null = activeId ? (usageMap[activeId] ?? null) : null;
  const activeLastOk: OkUsage | null = activeId ? (lastOkMap[activeId] ?? null) : null;

  // 内容高度变化时同步窗口高度
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const report = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (h > 0) window.tally.setHeight(h);
    };
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    return () => ro.disconnect();
  }, [config, view, usageMap, status, toast]);

  const refreshUsage = useCallback(async () => {
    setLoadingUsage(true);
    try {
      const r = await window.tally.fetchAllUsage();
      setMapError(null);
      setUsageMap(r.map);
      setLastOkMap((prev) => {
        const next: Record<string, OkUsage> = {};
        // 只保留仍然存在的账号，避免删号后残留旧数据
        for (const [id, u] of Object.entries(r.map)) {
          if (u.ok) next[id] = u as OkUsage;
          else if (prev[id]) next[id] = prev[id];
        }
        return next;
      });
    } catch (e) {
      setMapError(`取数失败：${String(e)}`);
    } finally {
      setLoadingUsage(false);
    }
  }, []);

  const refreshStatus = useCallback(async (opts?: { refresh?: boolean }) => {
    setLoadingStatus(true);
    try {
      // 签到状态 / 积分余额 / 关联诊断三个请求互不依赖，并发发出去
      const [r, b, d] = await Promise.all([
        window.tally.getCheckinStatus(opts),
        window.tally.getCreditBalance(),
        window.tally.getCheckinDiagnose(opts),
      ]);
      setStatus(r);
      if (r.ok) setLastOkStatus(r);
      setBalance(b);
      if (b.ok) setLastOkBalance(b);
      setDiagnose(d);
    } catch (e) {
      setStatus({ ok: false, reason: 'network', message: `调用主进程失败：${String(e)}` });
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  // 「重新检测」：忽略缓存重新探测登录态文件位置，给刚装好/刚登录客户端的用户用
  const redetect = useCallback(async () => {
    try {
      await refreshStatus({ refresh: true });
    } catch (e) {
      setStatus({ ok: false, reason: 'network', message: `重新检测失败：${String(e)}` });
    }
  }, [refreshStatus]);

  const doClaim = useCallback(async () => {
    setClaiming(true);
    try {
      const r: ClaimResult = await window.tally.claimCheckin();
      if (r.ok) {
        const tail = r.status
          ? ` · 连续 ${r.status.streakDays} 天 · 累计 ${r.status.totalCredits} 分`
          : '';
        setToast(`${r.message}${tail}`);
        await refreshStatus();
      } else {
        setToast(r.message);
      }
    } catch (e) {
      setToast(`领取失败：${String(e)}`);
    } finally {
      setClaiming(false);
      setTimeout(() => setToast(null), 7000);
    }
  }, [refreshStatus]);

  // 托盘 tooltip：鼠标悬停托盘图标就能看到余额/连续天数，不用打开面板
  useEffect(() => {
    const parts: string[] = [];
    if (lastOkBalance) parts.push(`余额 ${fmtCredits(lastOkBalance.credits.remain)} 分`);
    if (lastOkStatus?.status) parts.push(`连续 ${lastOkStatus.status.streakDays} 天`);
    window.tally.setTrayTip(parts.join(' · ') || '用量与积分');
  }, [lastOkBalance, lastOkStatus]);

  // 托盘菜单里的「立即领取今日积分」
  useEffect(() => window.tally.onTrayClaim(() => doClaim()), [doClaim]);

  // 缩放倍率：配置里的值是基准，拖动中主进程会推最新值过来
  useEffect(() => window.tally.onScaleChanged(setScale), []);
  useEffect(() => {
    setScale(config?.windowScale ?? 1);
  }, [config?.windowScale]);

  useEffect(() => {
    (async () => {
      const [c, i] = await Promise.all([window.tally.getConfig(), window.tally.getAppInfo()]);
      setConfig(c);
      setInfo(i);
      refreshUsage();
      refreshStatus();
    })();
  }, [refreshUsage, refreshStatus]);

  useEffect(() => {
    const ms = Math.max(20, config?.refreshSeconds ?? 60) * 1000;
    const id = setInterval(() => {
      refreshUsage();
      refreshStatus();
    }, ms);
    return () => clearInterval(id);
  }, [config?.refreshSeconds, refreshUsage, refreshStatus]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!config?.autoCheckin) return;
    const s = lastOkStatus?.status;
    if (!s || !s.active || s.todayCheckedIn) return;
    const today = new Date().toISOString().slice(0, 10);
    if (autoTried.current === today) return;
    autoTried.current = today;
    doClaim();
  }, [config?.autoCheckin, lastOkStatus, doClaim]);

  const saveConfig = useCallback(
    async (patch: Partial<TallyConfig>) => {
      const r = await window.tally.setConfig(patch);
      setConfig(r.config);
      // 只有账号增删才需要重新取数，单纯切换当前账号直接读缓存
      if ('opencodeProfiles' in patch) refreshUsage();
      // 开机自启写注册表可能被拒（开发模式等），把原因交回设置页提示
      return { autoStartError: r.autoStartError };
    },
    [refreshUsage]
  );

  if (!config) {
    return (
      <div className="card">
        <div className="header">
          <span className="brand">Tally</span>
        </div>
        <div className="body">
          <div className="notice">
            <span className="dot" />
            <span>正在启动…</span>
          </div>
        </div>
        <Credit />
      </div>
    );
  }

  const hasProfiles = profiles.length > 0;
  const buddyUnlinked = Boolean(diagnose && !diagnose.linked);
  let footDot = 'ok';
  let footText = hasProfiles ? '已同步' : '用量未配置 Key';
  if (!hasProfiles) {
    footDot = 'warn';
  } else if (mapError || (activeUsage && !activeUsage.ok)) {
    footDot = 'err';
    footText = '用量获取失败';
  } else if (status && !status.ok) {
    footDot = 'warn';
    footText = buddyUnlinked ? 'WorkBuddy 未关联' : '签到状态异常';
  } else if (claiming) {
    footDot = 'warn';
    footText = '领取中…';
  } else if (loadingUsage || loadingStatus) {
    footDot = 'warn';
    footText = '刷新中…';
  }

  return (
    <div className="card" ref={cardRef}>
      <div className="header">
        <span className="brand">Tally</span>
        <span className="brand-sub">
          {view === 'settings' ? '设置' : hasProfiles && profiles.length > 1 ? `${profiles.length} 个账号` : '用量 · 积分'}
        </span>
        <span className="header-spacer" />
        <button
          className={`icon-btn${config.alwaysOnTop ? ' on' : ''}`}
          title={
            config.alwaysOnTop
              ? '当前：永远浮在最前（会盖住文件夹和浏览器）· 点击改为贴桌面'
              : '贴桌面中：待在所有窗口之下，绝不遮挡 · 点击改为永远浮在最前'
          }
          onClick={() => saveConfig({ alwaysOnTop: !config.alwaysOnTop })}
        >
          {ICON_PIN}
        </button>
        <button
          className={`icon-btn${view === 'settings' ? ' on' : ''}`}
          title="设置"
          onClick={() => setView(view === 'settings' ? 'main' : 'settings')}
        >
          {ICON_SLIDERS}
        </button>
        <button className="icon-btn" title="最小化" onClick={() => window.tally.minimize()}>
          {ICON_MIN}
        </button>
        <button
          className="icon-btn close"
          title={config.closeToTray ? '关闭到托盘（托盘菜单可退出）' : '退出'}
          onClick={() => (config.closeToTray ? window.tally.close() : window.tally.quit())}
        >
          {ICON_CLOSE}
        </button>
      </div>

      <div className="body">
        {view === 'settings' ? (
          <SettingsSection config={config} info={info} onSave={saveConfig} onBack={() => setView('main')} />
        ) : (
          <>
            <UsageSection
              usage={activeUsage}
              lastOk={activeLastOk}
              loading={loadingUsage}
              hasProfiles={hasProfiles}
              now={now}
              onOpenSettings={() => setView('settings')}
              profiles={profiles}
              activeProfileId={activeId}
              usageMap={usageMap}
              lastOkMap={lastOkMap}
              onSwitchProfile={(id) => saveConfig({ activeProfileId: id })}
            />
            <BuddySection
              status={status}
              lastOk={lastOkStatus}
              balance={balance}
              lastOkBalance={lastOkBalance}
              diagnose={diagnose}
              loading={loadingStatus}
              claiming={claiming}
              toast={toast}
              onClaim={doClaim}
              onRedetect={redetect}
            />
          </>
        )}
      </div>

      <div className="footer">
        <span className={`status-dot ${footDot}`} />
        <span>{footText}</span>
        <span className="spacer" />
        <span>
          {activeLastOk
            ? new Date(activeLastOk.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })
            : ''}
        </span>
      </div>

      <Credit />
      <ResizeGrip scale={scale} />
    </div>
  );
}
