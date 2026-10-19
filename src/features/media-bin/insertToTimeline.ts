/**
 * 素材入轨：把素材池条目插到播放头处（M1 的「插入到时间线」）。
 *
 * 目标轨选择：视频/图片→最上层可用视频轨，音频→最上层可用音频轨
 * （「可用」＝同类型且未锁定；无可用轨先 addTrack 建一条）。
 * 落点＝当前播放头；与既有块重叠时由 store 的归一逻辑推挤，不覆盖。
 */
import { selectActiveSequence, useProjectStore } from "../../core/project/store";
import type { TrackKind } from "../../core/project/types";

/** 按契约 action 插入素材到播放头处；素材不在池中则忽略。 */
export function insertAssetAtPlayhead(assetId: string): void {
  const state = useProjectStore.getState();
  const asset = state.document.assets.find((a) => a.id === assetId);
  if (!asset) return;
  const sequence = selectActiveSequence(state);
  const kind: TrackKind = asset.kind === "audio" ? "audio" : "video";

  // 同类轨里从最上层往下找第一条未锁定的；全锁定或没有同类轨则新建
  const usable = sequence.tracks.filter((t) => t.kind === kind && !t.locked);
  const trackId = usable.length > 0 ? usable[usable.length - 1]!.id : state.addTrack(kind);

  useProjectStore.getState().insertClip({ assetId, trackId, timelineStartUs: state.playheadUs });
}
