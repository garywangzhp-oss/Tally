export type QuotaKey = 'fiveHour' | 'week' | 'month';

export interface QuotaWindow {
  key: QuotaKey;
  label: string;
  planUsd: number;
  limit: number | null;
  used: number | null;
  remaining: number | null;
  /** true 表示金额是按套餐基准从百分比折算出来的，不是接口原值（UI 用 ≈ 标示） */
  derived: boolean;
  usedPct: number | null;
  remainingPct: number | null;
  resetInSec: number | null;
  resetsAt: string | null;
  /** 接口自带的状态字段，实测为 "ok" */
  status: string | null;
  detected: boolean;
}

export type UsageResult =
  | {
      ok: true;
      fetchedAt: string;
      windows: QuotaWindow[];
      recognized: number;
      raw: string;
      elapsedMs: number;
      profileId?: string;
      mock?: boolean;
    }
  | {
      ok: false;
      reason: 'no-key' | 'auth' | 'http' | 'parse' | 'timeout' | 'network' | string;
      message: string;
      status?: number;
      raw?: string;
      elapsedMs?: number;
      profileId?: string;
    };

/** 一次拉全部账号的返回：按 profileId 归类 */
export interface UsageBatchResult {
  map: Record<string, UsageResult>;
  elapsedMs: number;
  profileCount: number;
}

/**
 * 一个 OpenCode 账号。额度挂在订阅（账号）上而不是 key 上，
 * 所以同一个账号的多个 key 在这里应当合并成一条，否则数字会重复。
 */
export interface OpenCodeProfile {
  id: string;
  name: string;
  apiKey: string;
}

export interface CheckinStatus {
  active: boolean;
  todayCheckedIn: boolean;
  streakDays: number;
  dailyCredit: number;
  todayCredit: number;
  totalCredits: number;
  weekCheckinDays: number;
  weekProgress: boolean[];
  checkinDates: string[];
  periodStart: string | null;
  periodEnd: string | null;
  activityName: string | null;
  season: number | null;
  claimButtonText: string | null;
  actionButton: { show?: boolean; text?: string; action?: string } | null;
}

export type StatusResult =
  | {
      ok: true;
      fetchedAt: string;
      account: { nickname: string | null; uid: string | null; uin: string | null };
      tokenExpiresAt: string | null;
      tokenExpiresInDays: number | null;
      status: CheckinStatus;
    }
  | { ok: false; reason: string; message: string; raw?: string; file?: string | null };

/**
 * WorkBuddy 关联诊断：说明当前签到面板挂在哪个 WorkBuddy 账号上、
 * 去哪儿找过登录态。别人拿到安装包后靠这个确认「关联到自己了没」。
 */
export interface CheckinDiagnose {
  linked: boolean;
  reason: string | null;
  message: string | null;
  file: string | null;
  source: 'known' | 'search' | 'none' | undefined;
  dataDirExists: boolean;
  apiHost: string;
  searchedCount: number;
  searched: string[];
  nickname: string | null;
  uid: string | null;
  uin: string | null;
  accountType: string | null;
  expiresAt: string | null;
  expiresInDays: number | null;
  refreshInDays: number | null;
  expired: boolean | null;
}

export type ClaimResult =
  | {
      ok: true;
      action: 'claimed' | 'skip_already_signed';
      message: string;
      status: CheckinStatus | null;
    }
  | { ok: false; reason: string; message: string; raw?: string };

/** 一个资源包（订阅档 / 加量包 / 活动赠送）在本周期内的容量 */
export interface CreditPackage {
  packageCode: string;
  total: number;
  remain: number;
  used: number;
  frozen: number;
  unit: string;
  count: number;
}

/**
 * 积分余额。注意跟签到活动里的 totalCredits 不是一回事：
 * 那个只统计「本次活动期内签到累计」，这个是账户可用的真实余额（所有包求和）。
 */
export type CreditBalanceResult =
  | {
      ok: true;
      fetchedAt: string;
      elapsedMs: number;
      account: { nickname: string | null; uid: string | null; uin: string | null };
      credits: {
        unit: string;
        total: number;
        remain: number;
        used: number;
        usedPct: number;
      };
      packages: CreditPackage[];
      isPaidUser: boolean;
      subscriptionPackageCode: string;
    }
  | { ok: false; reason: string; message: string; raw?: string };

export interface TallyConfig {
  opencodeProfiles: OpenCodeProfile[];
  activeProfileId: string;
  refreshSeconds: number;
  opacity: number;
  locked: boolean;
  alwaysOnTop: boolean;
  position: { x: number; y: number } | null;
  autoCheckin: boolean;
  closeToTray: boolean;
  /** 界面等比缩放倍率（1 = 原始大小）。拖动右下角或设置页滑块改它 */
  windowScale: number;
  /** 开机自动启动（写入 HKCU\...\Run；挪动程序目录后需要重新开关一次） */
  autoStart: boolean;
}

export interface AppInfo {
  version: string;
  configPath: string;
  tokenPath: string;
  electron: string;
  packaged: boolean;
}

export interface TallyBridge {
  getConfig(): Promise<TallyConfig>;
  setConfig(
    patch: Partial<TallyConfig>
  ): Promise<{ ok: boolean; config: TallyConfig; autoStartError?: string }>;
  fetchUsage(profileId?: string): Promise<UsageResult>;
  fetchAllUsage(): Promise<UsageBatchResult>;
  getCheckinStatus(opts?: { refresh?: boolean }): Promise<StatusResult>;
  claimCheckin(): Promise<ClaimResult>;
  getCheckinDiagnose(opts?: { refresh?: boolean }): Promise<CheckinDiagnose>;
  getCreditBalance(): Promise<CreditBalanceResult>;
  minimize(): Promise<void>;
  setHeight(height: number): Promise<void>;
  beginScale(): Promise<void>;
  endScale(): Promise<void>;
  onScaleChanged(handler: (scale: number) => void): () => void;
  hide(): Promise<void>;
  close(): Promise<void>;
  quit(): Promise<void>;
  openExternal(url: string): Promise<void>;
  getAppInfo(): Promise<AppInfo>;
  setTrayTip(text: string): Promise<void>;
  onTrayClaim(handler: () => void): () => void;
}

declare global {
  interface Window {
    tally: TallyBridge;
  }
}
