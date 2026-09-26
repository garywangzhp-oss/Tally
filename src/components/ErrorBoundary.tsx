import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** 出错时显示的区块名，便于定位（如「WorkBuddy 加油站」） */
  label: string;
  children: ReactNode;
  /** compact = 单区块兜底（小条提示）；不传则整窗兜底 */
  compact?: boolean;
}

interface State {
  error: Error | null;
}

/**
 * 渲染错误边界。
 *
 * ⚠️ 为什么必须有：2026-09-26 实测，WorkBuddy 新版客户端把登录态里的 nickname
 * 换成密文对象 `{ $wbEncrypted: 1, envelope }`，`{nickname}` 直接渲染触发
 * React error #31（Objects are not valid as a React child）。**未捕获的渲染异常会把
 * 整棵 React 树卸载**，页面变空白 → Electron 透明窗口什么都没画 → 用户看到的是
 * 「面板彻底不见了，双击也没反应，Win+D 也找不到」。
 *
 * 有了边界，最坏情况也只是这一块显示错误提示，用量面板照常工作。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 主进程会把渲染层 console 转出来（TALLY_SMOKE 时落在日志里），便于事后定位
    console.error(`[tally] ${this.props.label} 渲染异常（已兜底）：`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const msg = String((error as Error)?.message ?? error);
    if (this.props.compact) {
      return (
        <section className="section">
          <div className="section-head">
            <span className="section-title">{this.props.label}</span>
          </div>
          <div className="crash-inline">
            <div>这一块渲染出错了，其他功能不受影响。</div>
            <div className="mono-dim break">{msg}</div>
            <button className="crash-btn" onClick={() => this.setState({ error: null })}>
              重试
            </button>
          </div>
        </section>
      );
    }

    return (
      <div className="crash-full">
        <div className="crash-title">界面渲染出错</div>
        <div className="crash-hint">已兜底，程序没有退出。</div>
        <div className="mono-dim break crash-msg">{msg}</div>
        <button className="crash-btn" onClick={() => this.setState({ error: null })}>
          重试
        </button>
      </div>
    );
  }
}
