/**
 * 轨道主体：一行编辑泳道，块绝对定位其中。
 * 点空白处清空选择；高度走模型里的 track.height（轨头列同值对齐）。
 */
import type { PointerEvent as ReactPointerEvent } from "react";
import { useProjectStore } from "../../core/project/store";
import type { MediaAsset, Track } from "../../core/project/types";
import { ClipBlock } from "./ClipBlock";

export interface TrackLaneProps {
  track: Track;
  pxPerUs: number;
  scrollerEl: HTMLDivElement | null;
  assets: Map<string, MediaAsset>;
  selectionSet: ReadonlySet<string>;
  /** 全轨块边缘（含 0），拖动吸附候选。 */
  snapEdges: readonly number[];
  onClipHover: (info: { clipId: string; trackId: string } | null) => void;
}

export function TrackLane({ track, pxPerUs, scrollerEl, assets, selectionSet, snapEdges, onClipHover }: TrackLaneProps) {
  // 点到泳道本体（而非某个块）才清选——块的 pointerdown 不冒泡到这个分支
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) useProjectStore.getState().setSelection([]);
  };

  return (
    <div
      className="timeline-lane"
      data-kind={track.kind}
      data-locked={track.locked}
      style={{ height: track.height }}
      onPointerDown={onPointerDown}
    >
      {track.clips.map((clip) => (
        <ClipBlock
          key={clip.id}
          clip={clip}
          track={track}
          pxPerUs={pxPerUs}
          scrollerEl={scrollerEl}
          asset={assets.get(clip.assetId)}
          selected={selectionSet.has(clip.id)}
          snapEdges={snapEdges}
          onHover={onClipHover}
        />
      ))}
    </div>
  );
}
