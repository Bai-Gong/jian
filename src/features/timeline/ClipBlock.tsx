/**
 * 剪辑块：px 定位渲染 + 水平拖动。
 *
 * 拖动纪律（契约 risks 条目）：pointermove 只写本地视觉（inline transform），
 * pointerup 才 moveClip 入 store——防误拖把别的块永久推挤（M1 无撤销）。
 * 吸附在视觉阶段完成：起/终边对齐其他块边缘与播放头，阈值 8px。
 */
import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { useProjectStore } from "../../core/project/store";
import { clipDurationUs, clipEndUs } from "../../core/project/timelineOps";
import type { Clip, MediaAsset, Track } from "../../core/project/types";
import { findSnapOffset, SNAP_THRESHOLD_PX, assetDisplayName } from "./timelineGeometry";

/** 位移超过该 px 才算拖动，否则视为点击（点选不触发 moveClip）。 */
const DRAG_THRESHOLD_PX = 3;

interface DragState {
  pointerId: number;
  startX: number;
  origUs: number;
  durationUs: number;
  /** 拖动开始时的吸附候选快照（其余块边缘 + 0 + 播放头）。 */
  edges: number[];
  /** 最近一次吸附后的起点，pointerup 提交用。 */
  lastUs: number;
  moved: boolean;
}

export interface ClipBlockProps {
  clip: Clip;
  track: Track;
  pxPerUs: number;
  asset: MediaAsset | undefined;
  selected: boolean;
  /** 全轨块边缘（含 0），拖动时排除自身两条边。 */
  snapEdges: readonly number[];
  /** 悬停上报：剃刀 S 无选中时分割指针下的块。 */
  onHover: (info: { clipId: string; trackId: string } | null) => void;
}

export function ClipBlock({
  clip,
  track,
  pxPerUs,
  asset,
  selected,
  snapEdges,
  onHover,
}: ClipBlockProps) {
  const dragRef = useRef<DragState | null>(null);

  const durationUs = clipDurationUs(clip);
  // 最窄 2px：极端缩放下块仍可见
  const widthPx = Math.max(durationUs * pxPerUs, 2);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (track.locked || e.button !== 0) return; // 锁定轨拒绝一切编辑
    const store = useProjectStore.getState();
    // 点下即选；Ctrl 点选切换（多选）
    if (e.ctrlKey || e.metaKey) store.toggleClipSelection(clip.id);
    else if (!store.selection.includes(clip.id)) store.setSelection([clip.id]);
    // 吸附候选快照：排除自身起/终边，追加当前播放头
    const ownEnd = clipEndUs(clip);
    const edges = snapEdges.filter((us) => us !== clip.timelineStartUs && us !== ownEnd);
    edges.push(store.playheadUs);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      origUs: clip.timelineStartUs,
      durationUs,
      edges,
      lastUs: clip.timelineStartUs,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startX;
    if (!d.moved) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      d.moved = true;
      e.currentTarget.classList.add("is-dragging");
    }
    const rawUs = Math.max(0, d.origUs + dx / pxPerUs);
    const snapped = findSnapOffset(rawUs, d.durationUs, d.edges, pxPerUs, SNAP_THRESHOLD_PX);
    d.lastUs = snapped.startUs;
    // 只改本地视觉，不进 store
    e.currentTarget.style.transform = `translateX(${(snapped.startUs - d.origUs) * pxPerUs}px)`;
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    dragRef.current = null;
    const el = e.currentTarget;
    el.classList.remove("is-dragging");
    if (d.moved) {
      // 一次提交：store 钳 0 + 防重叠归一
      useProjectStore.getState().moveClip({
        clipId: clip.id,
        trackId: track.id,
        timelineStartUs: d.lastUs,
      });
    }
    el.style.transform = ""; // React 重渲染接管 left 前先清视觉残影
  };

  const name = assetDisplayName(asset);
  const classNames = [
    "timeline-clip",
    track.kind === "audio" ? "timeline-clip--audio" : "timeline-clip--video",
    selected ? "is-selected" : "",
    track.locked ? "is-locked" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classNames}
      style={{ left: clip.timelineStartUs * pxPerUs, width: widthPx }}
      title={name}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerEnter={() => onHover({ clipId: clip.id, trackId: track.id })}
      onPointerLeave={() => onHover(null)}
    >
      <span className="timeline-clip__bar" aria-hidden="true" />
      <span className="timeline-clip__name">{name}</span>
    </div>
  );
}
