import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 界面右下角的等比缩放手柄。
 *
 * 分工：这里只管「按下 / 松手」两个时刻，向主进程发信号；拖动过程中的位移由主进程
 * 轮询鼠标位置自己算 —— 窗口尺寸一直在变，指针很容易跑到窗口外面，渲染层的
 * pointermove 事件流是靠不住的。主进程算完把倍率推回来，这里显示百分比角标。
 */
export default function ResizeGrip({ scale }: { scale: number }) {
  const [dragging, setDragging] = useState(false);
  const [showPct, setShowPct] = useState(false);
  const draggingRef = useRef(false);
  const hideTimer = useRef<number | null>(null);

  const finish = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    window.tally.endScale();
    // 松手后角标再留一会儿，方便确认最终比例
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setShowPct(false), 1100);
  }, []);

  // 松手可能发生在窗口之外：指针捕获负责把事件送回来，这里再兜一层
  useEffect(() => {
    if (!dragging) return;
    const up = () => finish();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('keydown', onKey);
    };
  }, [dragging, finish]);

  useEffect(
    () => () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    },
    []
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;
    setDragging(true);
    setShowPct(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件或指针已释放时会抛，忽略 */
    }
    window.tally.beginScale();
  };

  return (
    <>
      <div
        className={`resize-grip${dragging ? ' active' : ''}`}
        title="拖动这里等比放大 / 缩小界面"
        onPointerDown={onPointerDown}
        onPointerUp={finish}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        >
          <path d="M12.4 3.2 3.2 12.4" />
          <path d="M12.4 7.4 7.4 12.4" />
        </svg>
      </div>
      {(dragging || showPct) && <div className="resize-badge">{Math.round(scale * 100)}%</div>}
    </>
  );
}
