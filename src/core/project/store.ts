/**
 * 工程状态：document 是唯一事实源，selection/playhead/isPlaying 是 UI 会话态。
 *
 * 写入纪律：
 * - 不可变更新——只 spread 受影响路径（换轨内容必换 track/sequence/document 外壳）；
 * - 推导量（块时长/序列时长）不落库，一律走 timelineOps 现算；
 * - 块在轨内不重叠由 timelineOps 归一维护，store 不另写推挤逻辑；
 * - locked 语义：锁定轨拒绝一切破坏性写入（插入/移动/分割/删除）；
 * - mute 只影响求值（音频层），不影响本层任何写入。
 */
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { MediaAsset, ProjectDocument, Sequence, Track, TrackKind } from "./types";
import { createClip, createInitialDocument, createTrack, DEFAULT_IMAGE_CLIP_US, nextTrackName } from "./factory";
import * as timelineOps from "./timelineOps";

/**
 * 导出会话状态（M1 同时至多一个导出任务）：TopBar 订阅它显示进度百分比/禁用按钮。
 * 由 core/export/exportProject 编排写入，UI 只读。
 */
export interface ExportState {
  running: boolean;
  /** 已推进到的微秒（export-progress 事件回填）。 */
  timeUs: number;
  totalUs: number;
  /** 最近一次失败原因；新一轮导出开始时清空。 */
  error: string | null;
}

export interface ProjectState {
  document: ProjectDocument;
  /** 选中块 id 列表（M1 无轨选中概念）。 */
  selection: string[];
  playheadUs: number;
  isPlaying: boolean;
  exportState: ExportState;
  /** 导出状态补丁式合并写入（高频进度更新只动变化字段）。 */
  setExportState(patch: Partial<ExportState>): void;

  addAssets(assets: MediaAsset[]): void;
  /** 插同类组末位（命名 Vn/An 自增），返回新轨 id。 */
  addTrack(kind: TrackKind): string;
  /** 删轨并同步清掉 selection 中该轨的块。 */
  removeTrack(trackId: string): void;
  /** locked 轨或素材类型与轨不符 → 返回 null 且不入库。 */
  insertClip(i: { assetId: string; trackId: string; timelineStartUs: number }): string | null;
  /** 源轨或目标轨任一 locked、或跨类型 → no-op。 */
  moveClip(i: { clipId: string; trackId: string; timelineStartUs: number }): void;
  /** 缺省＝选中块所在轨；locked 轨跳过。 */
  splitAtPlayhead(trackIds?: string[]): void;
  /** locked 轨的块不删；删完清空 selection。 */
  deleteSelected(): void;
  setSelection(clipIds: string[]): void;
  toggleClipSelection(clipId: string): void;
  /** 钳 ≥0。 */
  setPlayhead(us: number): void;
  setPlaying(b: boolean): void;
  toggleTrackMute(trackId: string): void;
  toggleTrackLock(trackId: string): void;
}

/** 素材与轨的类型兼容：audio 素材只能进音频轨，video/image 进视频轨。 */
function kindCompatible(assetKind: MediaAsset["kind"], trackKind: TrackKind): boolean {
  return (assetKind === "audio") === (trackKind === "audio");
}

/** 从 document 取活动序列；正常恒存在（createInitialDocument 保证）。 */
function activeSequenceOf(doc: ProjectDocument): Sequence | undefined {
  return doc.sequences.find((s) => s.id === doc.activeSequenceId);
}

/** 不可变替换指定序列的轨道数组。 */
function withTracks(doc: ProjectDocument, seqId: string, tracks: Track[]): ProjectDocument {
  return {
    ...doc,
    sequences: doc.sequences.map((s) => (s.id === seqId ? { ...s, tracks } : s)),
  };
}

export const useProjectStore = create<ProjectState>()(
  subscribeWithSelector((set, get) => ({
    document: createInitialDocument(),
    selection: [],
    playheadUs: 0,
    isPlaying: false,

    addAssets: (assets) => {
      if (assets.length === 0) return;
      set((s) => ({ document: { ...s.document, assets: [...s.document.assets, ...assets] } }));
    },

    addTrack: (kind) => {
      const doc = get().document;
      const seq = activeSequenceOf(doc);
      if (!seq) throw new Error("活动序列不存在，无法加轨");
      const track = createTrack(kind, nextTrackName(seq.tracks, kind));
      // 插同类组末位：视频组在前、音频组收尾，同类各自连续
      const insertAt = seq.tracks.map((t) => t.kind).lastIndexOf(kind) + 1;
      const tracks = [...seq.tracks];
      tracks.splice(insertAt, 0, track);
      set({ document: withTracks(doc, seq.id, tracks) });
      return track.id;
    },

    removeTrack: (trackId) => {
      const doc = get().document;
      const seq = activeSequenceOf(doc);
      const removed = seq?.tracks.find((t) => t.id === trackId);
      if (!seq || !removed) return;
      const removedClipIds = new Set(removed.clips.map((c) => c.id));
      set({
        document: withTracks(
          doc,
          seq.id,
          seq.tracks.filter((t) => t.id !== trackId),
        ),
        // 该轨的块一并消失，selection 同步清
        selection: get().selection.filter((id) => !removedClipIds.has(id)),
      });
    },

    insertClip: ({ assetId, trackId, timelineStartUs }) => {
      const doc = get().document;
      const asset = doc.assets.find((a) => a.id === assetId);
      const seq = activeSequenceOf(doc);
      const track = seq?.tracks.find((t) => t.id === trackId);
      if (!asset || !seq || !track) return null;
      if (track.locked) return null;
      if (!kindCompatible(asset.kind, track.kind)) return null;
      // 入点顶格；出点：图片给定格常量（素材本身零时长），其余整段素材
      const clip = createClip({
        assetId,
        sourceInUs: 0,
        sourceOutUs: asset.kind === "image" ? DEFAULT_IMAGE_CLIP_US : asset.durationUs,
        timelineStartUs: Math.max(0, timelineStartUs),
      });
      set({
        document: withTracks(doc, seq.id, seq.tracks.map((t) =>
          t.id === trackId ? { ...t, clips: timelineOps.insertClip(t.clips, clip) } : t,
        )),
      });
      return clip.id;
    },

    moveClip: ({ clipId, trackId, timelineStartUs }) => {
      const doc = get().document;
      const seq = activeSequenceOf(doc);
      if (!seq) return;
      const source = seq.tracks.find((t) => t.clips.some((c) => c.id === clipId));
      const target = seq.tracks.find((t) => t.id === trackId);
      const clip = source?.clips.find((c) => c.id === clipId);
      if (!source || !target || !clip) return;
      if (source.locked || target.locked) return; // 任一端锁定 → no-op
      if (source.kind !== target.kind) return; // 跨类型 → no-op
      set({
        document: withTracks(
          doc,
          seq.id,
          seq.tracks.map((t) => {
            if (source.id === target.id) {
              // 同轨移动：钳 0 后归一
              if (t.id !== target.id) return t;
              return { ...t, clips: timelineOps.moveClip(t.clips, clipId, timelineStartUs) };
            }
            // 跨轨移动：源轨摘除，目标轨按新起点投放（insert 内部归一）
            if (t.id === source.id) return { ...t, clips: t.clips.filter((c) => c.id !== clipId) };
            if (t.id === target.id) {
              return {
                ...t,
                clips: timelineOps.insertClip(t.clips, {
                  ...clip,
                  timelineStartUs: Math.max(0, timelineStartUs),
                }),
              };
            }
            return t;
          }),
        ),
      });
    },

    splitAtPlayhead: (trackIds) => {
      const { document, selection, playheadUs } = get();
      const seq = activeSequenceOf(document);
      if (!seq) return;
      // 缺省目标轨＝选中块所在轨（去重）
      const ids =
        trackIds ??
        [
          ...new Set(
            seq.tracks.filter((t) => t.clips.some((c) => selection.includes(c.id))).map((t) => t.id),
          ),
        ];
      if (ids.length === 0) return;
      set({
        document: withTracks(
          document,
          seq.id,
          seq.tracks.map((t) => {
            if (!ids.includes(t.id) || t.locked) return t; // locked 轨跳过
            // 逐块过 splitAt：不跨播放头的块原样返回，跨的裂成两块
            let clips = t.clips;
            for (const c of t.clips) clips = timelineOps.splitAt(clips, c.id, playheadUs);
            return { ...t, clips };
          }),
        ),
      });
    },

    deleteSelected: () => {
      const { document, selection } = get();
      if (selection.length === 0) return;
      const seq = activeSequenceOf(document);
      if (!seq) return;
      set({
        document: withTracks(
          document,
          seq.id,
          seq.tracks.map((t) =>
            // locked 轨的块一个都不动
            t.locked ? t : { ...t, clips: t.clips.filter((c) => !selection.includes(c.id)) },
          ),
        ),
        selection: [],
      });
    },

    setSelection: (clipIds) => set({ selection: [...clipIds] }),

    toggleClipSelection: (clipId) =>
      set((s) => ({
        selection: s.selection.includes(clipId)
          ? s.selection.filter((id) => id !== clipId)
          : [...s.selection, clipId],
      })),

    setPlayhead: (us) => set({ playheadUs: Math.max(0, us) }),

    setPlaying: (b) => set({ isPlaying: b }),

    exportState: { running: false, timeUs: 0, totalUs: 0, error: null },

    setExportState: (patch) => set((s) => ({ exportState: { ...s.exportState, ...patch } })),

    toggleTrackMute: (trackId) => {
      const doc = get().document;
      const seq = activeSequenceOf(doc);
      if (!seq) return;
      set({
        document: withTracks(
          doc,
          seq.id,
          seq.tracks.map((t) => (t.id === trackId ? { ...t, muted: !t.muted } : t)),
        ),
      });
    },

    toggleTrackLock: (trackId) => {
      const doc = get().document;
      const seq = activeSequenceOf(doc);
      if (!seq) return;
      set({
        document: withTracks(
          doc,
          seq.id,
          seq.tracks.map((t) => (t.id === trackId ? { ...t, locked: !t.locked } : t)),
        ),
      });
    },
  })),
);

/** 派生：当前活动序列。activeSequenceId 悬空属数据损坏，早炸早暴露。 */
export function selectActiveSequence(s: ProjectState): Sequence {
  const seq = activeSequenceOf(s.document);
  if (!seq) throw new Error("活动序列不存在：activeSequenceId 悬空");
  return seq;
}
