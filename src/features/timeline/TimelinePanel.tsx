/**
 * 时间线面板：轨头列 + 刻度尺 + 滚动主体。
 *
 * 渲染纪律：
 * - 播放头 60fps 走命令式订阅（subscribeWithSelector 选 playheadUs 直写 transform），
 *   面板不订 playheadUs——播放中整个面板零重渲染（防 React 重渲染风暴）；
 * - 拖动块只写本地视觉，pointerup 才经 store action 入库（M1 无撤销，防误拖推挤）；
 * - 所有编辑一律调 store action，组件不直接碰 document。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { DockPanel, useHotkeys } from "@baigong/fang";
import { Plus } from "lucide-react";
import { selectActiveSequence, useProjectStore } from "../../core/project/store";
import { clipEndUs, sequenceDurationUs } from "../../core/project/timelineOps";
import type { TrackKind } from "../../core/project/types";
import { TimeRuler } from "./TimeRuler";
import { TrackHeader } from "./TrackHeader";
import { TrackLane } from "./TrackLane";
import { DEFAULT_PX_PER_US, RULER_HEIGHT_PX, zoomPxPerUs } from "./timelineGeometry";
import "./timeline.css";

/** 内容右侧预留余量（微秒）：拖块到末尾外还有得滚。 */
const CONTENT_TAIL_US = 4_000_000;
/** 空序列的最小内容时长（微秒）。 */
const CONTENT_MIN_US = 30_000_000;

export function TimelinePanel() {
  // 只订 document/selection/assets——playheadUs 刻意不订（见文件头注释）
  const seq = useProjectStore(selectActiveSequence);
  const selection = useProjectStore((s) => s.selection);
  const assets = useProjectStore((s) => s.document.assets);

  const [pxPerUs, setPxPerUs] = useState(DEFAULT_PX_PER_US);
  const pxPerUsRef = useRef(pxPerUs);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const headersRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  /** 缩放锚点：指针下的时间 + 指针在视口的 x，DOM 提交后再校 scrollLeft。 */
  const zoomAnchorRef = useRef<{ tUs: number; viewportX: number } | null>(null);
  /** 剃刀 S 无选中时的分割目标：指针悬停的块。 */
  const hoverRef = useRef<{ clipId: string; trackId: string } | null>(null);

  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const selectionSet = useMemo(() => new Set(selection), [selection]);
  const contentUs = useMemo(
    () => Math.max(sequenceDurationUs(seq) + CONTENT_TAIL_US, CONTENT_MIN_US),
    [seq],
  );
  /** 吸附候选：全轨块边缘 + 0（播放头由块在拖动开始时快照追加）。 */
  const snapEdges = useMemo(() => {
    const edges: number[] = [0];
    for (const track of seq.tracks) {
      for (const clip of track.clips) {
        edges.push(clip.timelineStartUs, clipEndUs(clip));
      }
    }
    return edges;
  }, [seq]);

  // ===== 播放头：命令式位移 =====
  const applyMarker = useCallback(() => {
    const el = markerRef.current;
    if (!el) return;
    el.style.transform = `translateX(${useProjectStore.getState().playheadUs * pxPerUsRef.current}px)`;
  }, []);
  useEffect(
    () =>
      useProjectStore.subscribe(
        (s) => s.playheadUs,
        () => applyMarker(),
      ),
    [applyMarker],
  );
  useLayoutEffect(() => {
    pxPerUsRef.current = pxPerUs;
    applyMarker();
  }, [pxPerUs, applyMarker]);

  // ===== Ctrl+滚轮缩放（以指针为锚） =====
  // React 的 onWheel 是被动监听，preventDefault 无效，须手动挂非被动监听
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // 普通滚动走原生
      e.preventDefault(); // 顺带压掉 WebView2 的页面缩放
      const rect = scroller.getBoundingClientRect();
      const viewportX = e.clientX - rect.left;
      const tUs = (scroller.scrollLeft + viewportX) / pxPerUsRef.current;
      zoomAnchorRef.current = { tUs, viewportX };
      setPxPerUs(zoomPxPerUs(pxPerUsRef.current, e.deltaY));
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, []);
  // 内容宽度提交后校正 scrollLeft，把锚点时间钉回指针位置
  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    const scroller = scrollerRef.current;
    if (anchor && scroller) {
      scroller.scrollLeft = anchor.tUs * pxPerUs - anchor.viewportX;
      zoomAnchorRef.current = null;
    }
  }, [pxPerUs]);

  // 轨头列垂直同步（直写 DOM，不经状态）
  const onScrollSync = useCallback(() => {
    if (headersRef.current && scrollerRef.current) {
      headersRef.current.scrollTop = scrollerRef.current.scrollTop;
    }
  }, []);

  // ===== 播放头定位（刻度尺点击/拖动共用） =====
  const seekFromClientX = useCallback((clientX: number) => {
    const el = contentRef.current;
    if (!el) return;
    const us = (clientX - el.getBoundingClientRect().left) / pxPerUsRef.current;
    useProjectStore.getState().setPlayhead(us); // 负值由 store 钳 0
  }, []);
  const onHeadPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      seekFromClientX(e.clientX);
    },
    [seekFromClientX],
  );
  const onHeadPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) seekFromClientX(e.clientX);
    },
    [seekFromClientX],
  );

  // ===== 快捷键（fang useHotkeys）：S 分割 / Del 删除 =====
  const onSplit = useCallback(() => {
    const s = useProjectStore.getState();
    if (s.selection.length > 0) {
      s.splitAtPlayhead(); // 缺省＝选中块所在轨
      return;
    }
    const hovered = hoverRef.current;
    if (hovered) s.splitAtPlayhead([hovered.trackId]); // 剃刀语义：分割指针下的块
  }, []);
  const onDelete = useCallback(() => useProjectStore.getState().deleteSelected(), []);
  const hotkeys = useMemo(
    () => ({ s: onSplit, delete: onDelete, backspace: onDelete }),
    [onSplit, onDelete],
  );
  useHotkeys(hotkeys);

  // ===== 工具条 =====
  const addTrack = useCallback(
    (kind: TrackKind) => useProjectStore.getState().addTrack(kind),
    [],
  );
  const onClipHover = useCallback(
    (info: { clipId: string; trackId: string } | null) => {
      hoverRef.current = info;
    },
    [],
  );

  return (
    <DockPanel
      title="时间线"
      collapsed={false}
      className="timeline-panel"
      style={{ flex: "1 1 42%", minHeight: 240 }}
    >
      <div className="timeline-toolbar">
        <button type="button" className="timeline-btn" onClick={() => addTrack("video")}>
          <Plus size={13} />
          视频轨
        </button>
        <button type="button" className="timeline-btn" onClick={() => addTrack("audio")}>
          <Plus size={13} />
          音频轨
        </button>
        <span className="timeline-toolbar__hint">S 分割 · Del 删除 · Ctrl+滚轮 缩放</span>
      </div>

      <div className="timeline-body">
        <div className="timeline-headers" ref={headersRef}>
          <div className="timeline-corner" style={{ height: RULER_HEIGHT_PX }} />
          {seq.tracks.map((track) => (
            <TrackHeader key={track.id} track={track} />
          ))}
        </div>

        <div className="timeline-scroll" ref={scrollerRef} onScroll={onScrollSync}>
          <div
            className="timeline-content"
            ref={contentRef}
            style={{ width: contentUs * pxPerUs }}
          >
            <TimeRuler
              pxPerUs={pxPerUs}
              contentUs={contentUs}
              fps={seq.fps}
              scrollerRef={scrollerRef}
              onSeek={seekFromClientX}
            />
            {seq.tracks.map((track) => (
              <TrackLane
                key={track.id}
                track={track}
                pxPerUs={pxPerUs}
                assets={assetById}
                selectionSet={selectionSet}
                snapEdges={snapEdges}
                onClipHover={onClipHover}
              />
            ))}
            {/* 播放头：竖线贯穿刻度尺与轨道，顶部手柄可拖 */}
            <div className="timeline-playhead" ref={markerRef} aria-hidden="true">
              <div
                className="timeline-playhead__hit"
                style={{ height: RULER_HEIGHT_PX }}
                onPointerDown={onHeadPointerDown}
                onPointerMove={onHeadPointerMove}
                title="播放头（拖动定位）"
              />
            </div>
          </div>
        </div>
      </div>
    </DockPanel>
  );
}
