/**
 * 走带条：播放/暂停、逐帧步进、时间码（当前/总长）、全局静音、JKL 快捷键。
 *
 * 快捷键口径（开发方案 3.5，M1 无倒放）：
 * - J＝播放头后退 1 秒；K＝暂停；L＝播放；
 * - 空格＝播放/暂停——fang 的 useHotkeys 按 event.key 匹配且 " " 被 trim 判非法，
 *   故空格走原生 keydown（event.code === "Space"），输入框聚焦时不抢键。
 */
import { useEffect, useState } from "react";
import { useHotkeys } from "@baigong/fang";
import { Pause, Play, StepBack, StepForward, Volume2, VolumeX } from "lucide-react";
import { useProjectStore, selectActiveSequence } from "../../core/project/store";
import { sequenceDurationUs } from "../../core/project/timelineOps";
import { usePlayback } from "../../core/playback/usePlayback";
import { videoPool } from "../../core/playback/VideoPool";
import { formatTimecode } from "./timecode";

/** 空格键按下时的目标是否为文本输入控件（不抢键）。 */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

export function TransportBar() {
  const { play, pause, seek, stepFrame } = usePlayback();
  const isPlaying = useProjectStore((s) => s.isPlaying);
  // 播放中 playheadUs 每帧更新，本组件是时间码的自然消费者，重渲染开销可忽略
  const playheadUs = useProjectStore((s) => s.playheadUs);
  const fps = useProjectStore((s) => selectActiveSequence(s).fps);
  const totalUs = useProjectStore((s) => sequenceDurationUs(selectActiveSequence(s)));
  const [masterMuted, setMasterMuted] = useState(false);

  // JKL：倒退/暂停/播放（M1 的 J 是步退 1 秒，倒放属 M2+）
  useHotkeys({
    j: () => seek(Math.max(0, useProjectStore.getState().playheadUs - 1_000_000)),
    k: () => pause(),
    l: () => play(),
  });

  // 空格不走 fang（见文件头注释），自挂原生监听
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      if (isTextEntryTarget(event.target)) return;
      event.preventDefault();
      if (useProjectStore.getState().isPlaying) pause();
      else play();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [play, pause]);

  const toggleMasterMute = () => {
    const next = !masterMuted;
    setMasterMuted(next);
    videoPool.setMasterMuted(next);
  };

  return (
    <div className="transport-bar" role="toolbar" aria-label="走带控制">
      <button
        type="button"
        className="icon-btn"
        title="上一帧"
        aria-label="上一帧"
        onClick={() => stepFrame(-1)}
      >
        <StepBack size={16} aria-hidden />
      </button>
      <button
        type="button"
        className="icon-btn transport-bar__play"
        title={isPlaying ? "暂停（K / 空格）" : "播放（L / 空格）"}
        aria-label={isPlaying ? "暂停" : "播放"}
        onClick={() => (isPlaying ? pause() : play())}
      >
        {isPlaying ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}
      </button>
      <button
        type="button"
        className="icon-btn"
        title="下一帧"
        aria-label="下一帧"
        onClick={() => stepFrame(1)}
      >
        <StepForward size={16} aria-hidden />
      </button>

      <span className="transport-bar__time" aria-label="当前时间码">
        {formatTimecode(playheadUs, fps)}
        <span className="transport-bar__total"> / {formatTimecode(totalUs, fps)}</span>
      </span>

      <span className="transport-bar__hint">J −1s · K 暂停 · L 播放 · 空格 播放/暂停</span>

      <button
        type="button"
        className="icon-btn"
        title={masterMuted ? "取消全局静音" : "全局静音"}
        aria-label={masterMuted ? "取消全局静音" : "全局静音"}
        aria-pressed={masterMuted}
        onClick={toggleMasterMute}
      >
        {masterMuted ? <VolumeX size={16} aria-hidden /> : <Volume2 size={16} aria-hidden />}
      </button>
    </div>
  );
}
