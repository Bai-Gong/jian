/**
 * 刻度尺：自适应档位（帧/秒/分）＋ 按下/拖动定位播放头。
 *
 * 刻度只画可视窗口附近（滚动/尺寸变化自测）——高倍缩放下内容宽度上万 px，
 * 全量画刻度会爆 DOM；窗口状态收敛在本组件，滚动不惊动父级。
 *
 * 滚动容器经「元素实例」prop 传入而非 ref 对象：React 先跑子组件 layout effect、
 * 后挂祖先 DOM 的 ref，挂载帧里 ref.current 必为 null（曾致监听永不挂上、
 * 刻度冻在初始窗口——即「只渲染到 12 秒」缺陷）。
 */
import { useCallback, useLayoutEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { formatRulerLabel, pickRulerStep, rulerTicks, RULER_HEIGHT_PX, visibleRangeUs } from "./timelineGeometry";

/** 可视窗口两侧各多画的余量（px）。 */
const VIEW_MARGIN_PX = 80;

export interface TimeRulerProps {
  pxPerUs: number;
  /** 内容总时长（微秒），刻度画到此处为止。 */
  contentUs: number;
  fps: number;
  /** 滚动容器元素实例（窗口测量挂它身上）；挂载帧后由父级回调 ref 注入。 */
  scrollerEl: HTMLDivElement | null;
  /** 由 clientX 换算微秒并写播放头（父级持有内容原点）。 */
  onSeek: (clientX: number) => void;
}

export function TimeRuler({ pxPerUs, contentUs, fps, scrollerEl, onSeek }: TimeRulerProps) {
  const [view, setView] = useState({ leftPx: 0, widthPx: 0 });

  // 窗口测量：滚动 + 容器尺寸变化。useLayoutEffect 保证首帧有刻度。
  useLayoutEffect(() => {
    if (!scrollerEl) return;
    const measure = () =>
      setView({ leftPx: scrollerEl.scrollLeft, widthPx: scrollerEl.clientWidth });
    measure();
    scrollerEl.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(scrollerEl);
    return () => {
      scrollerEl.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [scrollerEl]);

  const { stepUs, tier, minorUs } = pickRulerStep(pxPerUs, fps);

  // 可视窗口换算成微秒区间，主/次刻度只落在区间内
  const { leftUs, rightUs } = visibleRangeUs(view.leftPx, view.widthPx, pxPerUs, contentUs, VIEW_MARGIN_PX);
  const { majors, minors } = rulerTicks(leftUs, rightUs, stepUs, minorUs);

  // 按下即定位，捕获后拖动持续定位
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      onSeek(e.clientX);
    },
    [onSeek],
  );
  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) onSeek(e.clientX);
    },
    [onSeek],
  );

  return (
    <div
      className="timeline-ruler"
      style={{ height: RULER_HEIGHT_PX }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      role="slider"
      aria-label="时间刻度尺（拖动定位播放头）"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={Math.round(contentUs)}
    >
      {minors.map((us) => (
        <div
          key={`m${us}`}
          className="timeline-ruler__tick timeline-ruler__tick--minor"
          style={{ transform: `translateX(${us * pxPerUs}px)` }}
        />
      ))}
      {majors.map((us) => (
        <div key={us} className="timeline-ruler__tick" style={{ transform: `translateX(${us * pxPerUs}px)` }}>
          <span className="timeline-ruler__label">{formatRulerLabel(us, tier, fps)}</span>
        </div>
      ))}
    </div>
  );
}
