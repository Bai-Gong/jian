/**
 * 刻度尺：自适应档位（帧/秒/分）＋ 按下/拖动定位播放头。
 *
 * 刻度只画可视窗口附近（滚动/尺寸变化自测）——高倍缩放下内容宽度上万 px，
 * 全量画刻度会爆 DOM；窗口状态收敛在本组件，滚动不惊动父级。
 */
import {
  useCallback,
  useLayoutEffect,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { formatRulerLabel, pickRulerStep, RULER_HEIGHT_PX } from "./timelineGeometry";

/** 可视窗口两侧各多画的余量（px）。 */
const VIEW_MARGIN_PX = 80;

export interface TimeRulerProps {
  pxPerUs: number;
  /** 内容总时长（微秒），刻度画到此处为止。 */
  contentUs: number;
  fps: number;
  /** 滚动容器 ref（窗口测量挂它身上）。 */
  scrollerRef: RefObject<HTMLDivElement | null>;
  /** 由 clientX 换算微秒并写播放头（父级持有内容原点）。 */
  onSeek: (clientX: number) => void;
}

export function TimeRuler({ pxPerUs, contentUs, fps, scrollerRef, onSeek }: TimeRulerProps) {
  const [view, setView] = useState({ leftPx: 0, widthPx: 1200 });

  // 窗口测量：滚动 + 容器尺寸变化。useLayoutEffect 保证首帧有刻度。
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const measure = () =>
      setView({ leftPx: scroller.scrollLeft, widthPx: scroller.clientWidth });
    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [scrollerRef]);

  const { stepUs, tier, minorUs } = pickRulerStep(pxPerUs, fps);

  // 可视窗口换算成微秒区间，主/次刻度只落在区间内
  const leftUs = Math.max(0, (view.leftPx - VIEW_MARGIN_PX) / pxPerUs);
  const rightUs = Math.min(contentUs, (view.leftPx + view.widthPx + VIEW_MARGIN_PX) / pxPerUs);

  const majors: number[] = [];
  for (let i = Math.floor(leftUs / stepUs); i * stepUs <= rightUs; i++) {
    if (i < 0) continue;
    majors.push(i * stepUs);
  }
  const minors: number[] = [];
  if (minorUs < stepUs) {
    for (let i = Math.floor(leftUs / minorUs); i * minorUs <= rightUs; i++) {
      if (i < 0) continue;
      const us = i * minorUs;
      // 与主刻度重合的跳过（除不尽判定走整数下标）
      if (Math.abs(us / stepUs - Math.round(us / stepUs)) > 1e-6) minors.push(us);
    }
  }

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
