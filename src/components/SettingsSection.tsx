import { useEffect, useState } from 'react';
import type { AppInfo, CheckinDiagnose, TallyConfig, OpenCodeProfile } from '../types';
import { fmtVersion } from '../format';

interface Props {
  config: TallyConfig;
  info: AppInfo | null;
  onSave: (patch: Partial<TallyConfig>) => Promise<{ autoStartError?: string } | void>;
  onBack: () => void;
}

const REFRESH_OPTIONS = [
  { value: 30, label: '30 秒' },
  { value: 60, label: '1 分钟' },
  { value: 120, label: '2 分钟' },
  { value: 300, label: '5 分钟' },
];

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button className={`switch${on ? ' on' : ''}`} onClick={onClick} aria-pressed={on}>
      <i />
    </button>
  );
}

function newProfileId() {
  return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function maskKey(key: string) {
  const k = key.trim();
  if (!k) return '未填写';
  return `····${k.slice(-4)}`;
}

export default function SettingsSection({ config, info, onSave, onBack }: Props) {
  const profiles = config.opencodeProfiles ?? [];
  const active = profiles.find((p) => p.id === config.activeProfileId) ?? null;

  const [adding, setAdding] = useState(false);
  const isAdding = adding || !active;

  const [nameDraft, setNameDraft] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const [reveal, setReveal] = useState(false);
  const [flash, setFlash] = useState('');
  const [err, setErr] = useState('');
  const [wb, setWb] = useState<CheckinDiagnose | null>(null);

  // 取一次 WorkBuddy 关联诊断，用于显示「当前挂在哪个账号 / 登录态读自哪个文件」
  useEffect(() => {
    let alive = true;
    window.tally
      .getCheckinDiagnose()
      .then((d) => {
        if (alive) setWb(d);
      })
      .catch(() => {
        /* 诊断失败不影响设置页其它功能 */
      });
    return () => {
      alive = false;
    };
  }, []);

  // 切换当前账号时，编辑区跟着换成对应账号的内容
  useEffect(() => {
    if (adding) return;
    setNameDraft(active?.name ?? '');
    setKeyDraft(active?.apiKey ?? '');
    setReveal(false);
    setErr('');
  }, [active?.id, active?.name, active?.apiKey, adding]);

  const say = (text: string) => {
    setFlash(text);
    setTimeout(() => setFlash(''), 2200);
  };

  const startAdd = () => {
    setAdding(true);
    setNameDraft(`账号 ${profiles.length + 1}`);
    setKeyDraft('');
    setReveal(true);
    setErr('');
  };

  const commit = async () => {
    const key = keyDraft.trim();
    if (!key) {
      setErr('请先填入 API Key，空条目不会被保存。');
      return;
    }
    const name = nameDraft.trim().slice(0, 24) || (isAdding ? `账号 ${profiles.length + 1}` : '账号');

    if (isAdding) {
      const p: OpenCodeProfile = { id: newProfileId(), name, apiKey: key };
      const next = [...profiles, p];
      await onSave({ opencodeProfiles: next, activeProfileId: p.id });
      setAdding(false);
      say('账号已添加并设为当前');
    } else if (active) {
      const next = profiles.map((p) => (p.id === active.id ? { ...p, name, apiKey: key } : p));
      await onSave({ opencodeProfiles: next });
      say('已保存并重新拉取用量');
    }
  };

  const remove = async (p: OpenCodeProfile) => {
    const next = profiles.filter((x) => x.id !== p.id);
    await onSave({ opencodeProfiles: next });
    if (p.id === config.activeProfileId) setAdding(false);
    say(`已删除「${p.name}」`);
  };

  const dirty =
    isAdding
      ? Boolean(keyDraft.trim())
      : Boolean(active) && (keyDraft.trim() !== active.apiKey || nameDraft.trim() !== active.name);

  // 开机自启写注册表可能失败（开发模式 / 权限被拒），主进程会把原因带回来，
  // 就近显示在这一行下面 —— 复用到账号区的 flash 离得太远，用户看不到。
  const [autoNote, setAutoNote] = useState<{ text: string; bad: boolean } | null>(null);

  const toggleAutoStart = async () => {
    const wasOn = config.autoStart;
    setAutoNote(null);
    const r = await onSave({ autoStart: !wasOn });
    const err = r && typeof r === 'object' ? r.autoStartError : '';
    if (err) setAutoNote({ text: err, bad: true });
    else setAutoNote({ text: wasOn ? '已关闭开机自启。' : '已设为开机自启。', bad: false });
  };

  return (
    <section className="section">
      <div className="section-head">
        <span className="section-title">设置</span>
        <span className="section-meta">
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onBack();
            }}
            style={{ color: 'var(--accent)' }}
          >
            返回
          </a>
        </span>
      </div>

      <div className="field">
        <div className="acct-head">
          <label className="field-label" style={{ marginBottom: 0 }}>
            OpenCode Go 账号
          </label>
          <button className="mini-btn" onClick={startAdd} disabled={profiles.length >= 8}>
            + 添加
          </button>
        </div>

        {profiles.length > 0 && (
          <div className="acct-list">
            {profiles.map((p) => (
              <div
                key={p.id}
                className={`acct-item${p.id === config.activeProfileId && !adding ? ' on' : ''}`}
                onClick={() => {
                  setAdding(false);
                  if (p.id !== config.activeProfileId) onSave({ activeProfileId: p.id });
                }}
              >
                <span className="acct-radio" />
                <span className="acct-item-name">{p.name}</span>
                <span className="acct-item-key">{maskKey(p.apiKey)}</span>
                <button
                  className="acct-item-del"
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(p);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="acct-edit">
          <div className="acct-edit-title">{isAdding ? '新增账号' : `编辑「${active?.name ?? ''}」`}</div>
          <label className="mini-label" htmlFor="acct-name">
            备注名
          </label>
          <input
            id="acct-name"
            className="input"
            type="text"
            value={nameDraft}
            spellCheck={false}
            maxLength={24}
            placeholder="例如：个人号 / 公司号"
            onChange={(e) => setNameDraft(e.target.value)}
          />
          <label className="mini-label" htmlFor="acct-key">
            API Key
          </label>
          <input
            id="acct-key"
            className="input"
            type={reveal ? 'text' : 'password'}
            value={keyDraft}
            spellCheck={false}
            autoComplete="off"
            placeholder="粘贴 opencode.ai console 里的 Go API Key"
            onChange={(e) => setKeyDraft(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 7, marginTop: 7, alignItems: 'center' }}>
            <button className="btn primary" onClick={commit} disabled={!dirty}>
              {isAdding ? '添加' : '保存'}
            </button>
            <button className="btn" onClick={() => setReveal((v) => !v)}>
              {reveal ? '隐藏' : '显示'}
            </button>
            {isAdding && profiles.length > 0 ? (
              <button className="btn" onClick={() => setAdding(false)}>
                取消
              </button>
            ) : (
              <button
                className="btn"
                onClick={() => window.tally.openExternal('https://opencode.ai/auth')}
              >
                去获取
              </button>
            )}
          </div>
          {err && <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 7 }}>{err}</div>}
          {flash && <div style={{ fontSize: 11, color: 'var(--green)', marginTop: 7 }}>{flash}</div>}
        </div>

        <div className="hint">
          额度挂在账号（订阅）上而不是 key 上。同一个账号生成的多个 key 用量完全相同，合并成一条即可；
          只有不同账号才需要在这里分别添加。
        </div>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="rsec">
          自动刷新间隔
        </label>
        <select
          id="rsec"
          className="input"
          value={config.refreshSeconds}
          onChange={(e) => onSave({ refreshSeconds: Number(e.target.value) })}
        >
          {REFRESH_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field-label">窗口不透明度 {Math.round(config.opacity * 100)}%</label>
        <input
          type="range"
          min={0.3}
          max={1}
          step={0.02}
          value={config.opacity}
          style={{ width: '100%' }}
          onChange={(e) => onSave({ opacity: Number(e.target.value) })}
        />
      </div>

      <div className="field">
        <label className="field-label">界面缩放 {Math.round(config.windowScale * 100)}%</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <input
            type="range"
            min={70}
            max={200}
            step={5}
            value={Math.round(config.windowScale * 100)}
            style={{ flex: 1 }}
            onChange={(e) => onSave({ windowScale: Number(e.target.value) / 100 })}
          />
          <button
            className="btn"
            onClick={() => onSave({ windowScale: 1 })}
            disabled={Math.abs(config.windowScale - 1) < 0.001}
          >
            100%
          </button>
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          窗口和内容一起等比缩放（字号、间距、图标同步变大，排版不变）。也可以直接拖动界面右下角的
          斜纹把手。上限会跟着屏幕大小自动收窄。
        </div>
      </div>

      <div className="row-between">
        <span>窗口置顶（浮在所有窗口之上）</span>
        <Toggle on={config.alwaysOnTop} onClick={() => onSave({ alwaysOnTop: !config.alwaysOnTop })} />
      </div>
      <div className="hint" style={{ marginTop: -2 }}>
        {config.alwaysOnTop
          ? '面板会一直压在最前面，连文件夹、浏览器、任务栏都盖住 —— 确认要随时瞟一眼再开。'
          : '面板贴在桌面上：始终待在所有程序窗口之下，打开文件夹、浏览器、微信都会被它们盖住。就算你点过或拖动过面板，它也会立刻自己沉回去，不会一直压着别的窗口。'}
      </div>
      <div className="row-between">
        <span>启动时自动领取积分</span>
        <Toggle on={config.autoCheckin} onClick={() => onSave({ autoCheckin: !config.autoCheckin })} />
      </div>
      <div className="row-between">
        <span>关闭窗口时最小化到托盘</span>
        <Toggle
          on={config.closeToTray}
          onClick={() => onSave({ closeToTray: !config.closeToTray })}
        />
      </div>
      {config.closeToTray && (
        <div className="hint" style={{ marginTop: -2 }}>
          点右上角 × 只会把面板收进托盘，程序继续在后台运行。想真正退出：右键托盘图标 →
          「退出 Tally」。
        </div>
      )}
      <div className="row-between">
        <span>开机自动启动</span>
        <Toggle on={config.autoStart} onClick={toggleAutoStart} />
      </div>
      <div className="hint" style={{ marginTop: -2 }}>
        {config.autoStart
          ? '开机会自动把面板放回你上次的位置。想彻底关掉：关掉这个开关，或在任务管理器「启动」页里禁用它。'
          : '登录 Windows 后自动启动 Tally，省去手动双击。绿色版挪了目录的话，把开关关掉再打开一次即可重建。'}
      </div>
      {autoNote && (
        <div
          className="hint"
          style={{ marginTop: -2, color: autoNote.bad ? 'var(--red)' : 'var(--green)' }}
        >
          {autoNote.text}
        </div>
      )}

      <div className="row-between" style={{ display: 'block' }}>
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 5 }}>配置文件</div>
        <div className="path">{info?.configPath ?? '—'}</div>

        <div
          style={{
            fontSize: 11,
            color: 'var(--text-3)',
            margin: '9px 0 5px',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span>WorkBuddy 登录态（只读，不写入）</span>
          {wb && (
            <span className={`wb-acct${wb.linked ? '' : ' off'}`} style={{ marginLeft: 'auto' }}>
              <span className={`wb-dot${wb.linked ? '' : ' off'}`} />
              {wb.linked ? wb.nickname || '已关联' : '未关联'}
            </span>
          )}
        </div>
        <div className="path">
          {wb?.file ?? info?.tokenPath ?? '—'}
        </div>
        {wb && !wb.linked && (
          <div className="hint" style={{ marginTop: 6 }}>
            {wb.message}
            <br />
            已尝试 {wb.searchedCount} 个位置
            {wb.dataDirExists ? '；客户端数据目录存在，说明装了但没登录。' : '；未发现客户端数据目录。'}
          </div>
        )}
        {wb?.linked && wb.expiresInDays != null && (
          <div className="hint" style={{ marginTop: 6 }}>
            凭据剩余 {wb.expiresInDays} 天
            {wb.refreshInDays != null ? `，可续期 ${wb.refreshInDays} 天` : ''}
            ；打开 WorkBuddy 客户端会自动续期，长期不开会失效。
          </div>
        )}
      </div>

      <div className="buddy-foot" style={{ marginTop: 12 }}>
        <span>
          Electron {info?.electron ?? '—'} · Tally v{fmtVersion(info?.version)}
          {info ? (info.packaged ? ' · 打包版' : ' · 开发模式') : ''}
        </span>
      </div>
    </section>
  );
}
