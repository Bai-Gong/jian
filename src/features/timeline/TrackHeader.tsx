/**
 * 轨头：轨名（V1/A1…）、静音/锁定切换、删轨。
 * 删轨策略（任务契约）：只删空轨；非空或锁定时按钮禁用 + title 提示。
 * 锁定语义：锁定轨上的块禁止编辑（拖动/选中/分割/删除在各自入口拒绝）。
 */
import { AudioLines, Lock, LockOpen, Video, Volume2, VolumeX, X } from "lucide-react";
import { useProjectStore } from "../../core/project/store";
import type { Track } from "../../core/project/types";

const ICON_SIZE = 13;

export interface TrackHeaderProps {
  track: Track;
}

export function TrackHeader({ track }: TrackHeaderProps) {
  const onToggleMute = () => useProjectStore.getState().toggleTrackMute(track.id);
  const onToggleLock = () => useProjectStore.getState().toggleTrackLock(track.id);
  const onRemove = () => useProjectStore.getState().removeTrack(track.id);

  const canDelete = !track.locked && track.clips.length === 0;
  const deleteTitle = track.locked
    ? "轨道已锁定，先解锁再删"
    : track.clips.length > 0
      ? "轨道非空，先清空剪辑块"
      : "删除此轨道";

  return (
    <div
      className={["timeline-header", track.locked ? "is-locked" : ""].filter(Boolean).join(" ")}
      style={{ height: track.height }}
      data-kind={track.kind}
    >
      <span className="timeline-header__icon" aria-hidden="true">
        {track.kind === "video" ? <Video size={ICON_SIZE} /> : <AudioLines size={ICON_SIZE} />}
      </span>
      <span className="timeline-header__name" title={track.name}>
        {track.name}
      </span>
      <div className="timeline-header__actions">
        <button type="button" className={`timeline-icon-btn ${track.solo ? "is-on" : ""}`} title="独奏（仅播放独奏轨的音频）" aria-pressed={track.solo} onClick={()=>useProjectStore.getState().toggleTrackSolo(track.id)}>S</button>
        <button
          type="button"
          className={["timeline-icon-btn", track.muted ? "is-on" : ""].filter(Boolean).join(" ")}
          title={track.muted ? "取消静音" : "静音（只影响音频层）"}
          aria-pressed={track.muted}
          onClick={onToggleMute}
        >
          {track.muted ? <VolumeX size={ICON_SIZE} /> : <Volume2 size={ICON_SIZE} />}
        </button>
        <button
          type="button"
          className={["timeline-icon-btn", track.locked ? "is-on" : ""].filter(Boolean).join(" ")}
          title={track.locked ? "解锁轨道" : "锁定轨道（禁止编辑）"}
          aria-pressed={track.locked}
          onClick={onToggleLock}
        >
          {track.locked ? <Lock size={ICON_SIZE} /> : <LockOpen size={ICON_SIZE} />}
        </button>
        <button
          type="button"
          className="timeline-icon-btn"
          title={deleteTitle}
          aria-label={`删除轨道 ${track.name}`}
          disabled={!canDelete}
          onClick={onRemove}
        >
          <X size={ICON_SIZE} />
        </button>
      </div>
    </div>
  );
}
