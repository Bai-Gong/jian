/**
 * 效果控件面板：M1 只读——展示选中单块的素材/时间线/变换/音频静态值。
 * 编辑（变换拖拽、关键帧、效果参数）随 M2–M4 开放；此处先把「模型有值」可视化。
 * 无选中显示序列信息；多选显示计数（M1 属性面板只支持单选）。
 */
import { DockPanel } from "@baigong/fang";
import { useProjectStore, selectActiveSequence } from "../../core/project/store";
import { clipDurationUs, clipEndUs, sequenceDurationUs } from "../../core/project/timelineOps";
import type { Animatable, Clip, MediaAsset, Track } from "../../core/project/types";
import { formatDurationLabel, formatTimecode } from "../preview/timecode";
import { basename } from "../media-bin/AssetCard";

const KIND_LABEL: Record<MediaAsset["kind"], string> = { video: "视频", audio: "音频", image: "图片" };

/** 静态值文案；关键帧形态 M1 不会出现（工厂全静态），兜底显示占位。 */
function staticText(prop: Animatable<number>, format: (v: number) => string): string {
  return prop.kind === "static" ? format(prop.value) : "关键帧（M2）";
}

/** 在活动序列里找选中块及其所在轨。 */
function findSelectedClip(
  sequence: ReturnType<typeof selectActiveSequence>,
  clipId: string,
): { clip: Clip; track: Track } | null {
  for (const track of sequence.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { clip, track };
  }
  return null;
}

export function InspectorPanel() {
  const selection = useProjectStore((s) => s.selection);
  const sequence = useProjectStore(selectActiveSequence);
  const assets = useProjectStore((s) => s.document.assets);

  const picked =
    selection.length === 1 ? findSelectedClip(sequence, selection[0]!) : null;
  const asset = picked ? assets.find((a) => a.id === picked.clip.assetId) : undefined;

  return (
    <DockPanel title="效果控件" collapsed={false} style={{ flex: 1, minHeight: 0 }}>
      {picked ? (
        <div className="inspector">
          <div className="inspector__head">
            <span className="inspector__name" title={asset ? asset.path : picked.clip.assetId}>
              {asset ? basename(asset.path) : "素材已失效"}
            </span>
            {asset && <span className="inspector__badge">{KIND_LABEL[asset.kind]}</span>}
          </div>

          <dl className="inspector__rows">
            <dt>轨道</dt>
            <dd>{picked.track.name}</dd>
            <dt>时间线区间</dt>
            <dd>
              {formatTimecode(picked.clip.timelineStartUs, sequence.fps)} –{" "}
              {formatTimecode(clipEndUs(picked.clip), sequence.fps)}
            </dd>
            <dt>时长</dt>
            <dd>{formatDurationLabel(clipDurationUs(picked.clip))}</dd>
            <dt>素材区间</dt>
            <dd>
              {formatTimecode(picked.clip.sourceInUs, sequence.fps)} –{" "}
              {formatTimecode(picked.clip.sourceOutUs, sequence.fps)}
            </dd>
            <dt>速度</dt>
            <dd>×{picked.clip.speed.toFixed(2)}</dd>
          </dl>

          <p className="inspector__section">变换（静态值）</p>
          <dl className="inspector__rows">
            <dt>位置 X / Y</dt>
            <dd>
              {staticText(picked.clip.transform.x, (v) => v.toFixed(0))} /{" "}
              {staticText(picked.clip.transform.y, (v) => v.toFixed(0))} px
            </dd>
            <dt>缩放</dt>
            <dd>{staticText(picked.clip.transform.scale, (v) => `×${v.toFixed(2)}`)}</dd>
            <dt>旋转</dt>
            <dd>{staticText(picked.clip.transform.rotation, (v) => `${v.toFixed(1)}°`)}</dd>
            <dt>不透明度</dt>
            <dd>{staticText(picked.clip.transform.opacity, (v) => `${Math.round(v * 100)}%`)}</dd>
          </dl>

          <p className="inspector__section">音频</p>
          <dl className="inspector__rows">
            <dt>增益</dt>
            <dd>{staticText(picked.clip.audio.gain, (v) => v.toFixed(2))}</dd>
            <dt>效果</dt>
            <dd>{picked.clip.effects.length} 个（编辑随 M2 开放）</dd>
          </dl>
        </div>
      ) : selection.length > 1 ? (
        <p className="panel-placeholder">已选中 {selection.length} 个块——M1 属性面板只支持单选。</p>
      ) : (
        <div className="inspector">
          <p className="panel-placeholder">未选中剪辑块——在时间线上点选后此处显示属性。</p>
          <p className="inspector__section">序列信息</p>
          <dl className="inspector__rows">
            <dt>名称</dt>
            <dd>{sequence.name}</dd>
            <dt>画幅</dt>
            <dd>
              {sequence.width}×{sequence.height}@{sequence.fps}
            </dd>
            <dt>总时长</dt>
            <dd>{formatTimecode(sequenceDurationUs(sequence), sequence.fps)}</dd>
            <dt>轨道</dt>
            <dd>
              {sequence.tracks.filter((t) => t.kind === "video").length}V /{" "}
              {sequence.tracks.filter((t) => t.kind === "audio").length}A
            </dd>
            <dt>素材</dt>
            <dd>{assets.length} 条</dd>
          </dl>
        </div>
      )}
    </DockPanel>
  );
}
