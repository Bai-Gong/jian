/** 静态变换与音频属性；锁定或关键帧数据保留并禁止静态覆盖。 */
import { DockPanel } from "@baigong/fang";
import { useProjectStore, selectActiveSequence } from "../../core/project/store";
import { clipDurationUs, clipEndUs, sequenceDurationUs } from "../../core/project/timelineOps";
import type { Animatable, Clip, MediaAsset, Track } from "../../core/project/types";
import { formatDurationLabel, formatTimecode } from "../preview/timecode";
import { basename } from "../media-bin/AssetCard";

const KIND_LABEL: Record<MediaAsset["kind"], string> = { video: "视频", audio: "音频", image: "图片" };

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
  const source=asset?.audioStreams?.find(s=>s.index===picked?.clip.sourceStreamIndex);
  const control = (group:"transform"|"audio", name:string, prop:Animatable<number>, min?:number, max?:number, step=0.01) => prop.kind!=="static"
    ? <span>关键帧（保留，暂不可编辑）</span>
    : <input aria-label={({x:"位置 X",y:"位置 Y",scale:"缩放",rotation:"旋转",opacity:"不透明度",gain:"增益",pan:"声像"} as Record<string,string>)[name] ?? name} type="number" value={prop.value} min={min} max={max} step={step} disabled={picked?.track.locked}
        style={{width:76}} onChange={(event)=>{if(picked && event.target.value!=="")useProjectStore.getState().setClipProperty(picked.clip.id,group,name,Number(event.target.value));}} />;

  return (
    <DockPanel title="属性" className="inspector-panel" collapsed={false} style={{ flex: 1, minHeight: 0 }}>
      {picked ? (
        <div className="inspector">
          <div className="inspector__head">
            <span className="inspector__name" title={asset ? asset.path : picked.clip.assetId}>
              {asset ? basename(asset.path) : "素材已失效"}
            </span>
            {asset && <span className="inspector__badge">{picked.track.kind === "audio" ? "音频" : KIND_LABEL[asset.kind]}</span>}
          </div>

          <dl className="inspector__rows">
            {source && <><dt>源音轨</dt><dd>{source.name} · {source.channels} 声道</dd></>}
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

          {picked.track.kind === "video" && <><p className="inspector__section">变换</p>
          <dl className="inspector__rows">
            <dt>位置 X / Y</dt>
            <dd>
              {control("transform","x",picked.clip.transform.x,undefined,undefined,1)} /{" "}
              {control("transform","y",picked.clip.transform.y,undefined,undefined,1)} px
            </dd>
            <dt>缩放</dt>
            <dd>{control("transform","scale",picked.clip.transform.scale,0.01)}</dd>
            <dt>旋转</dt>
            <dd>{control("transform","rotation",picked.clip.transform.rotation,undefined,undefined,1)}°</dd>
            <dt>不透明度</dt>
            <dd>{control("transform","opacity",picked.clip.transform.opacity,0,1)}</dd>
          </dl>

          </>}
          {(picked.track.kind === "audio" || !picked.clip.audioDetached && asset?.hasAudio) && <><p className="inspector__section">音频</p>
          <dl className="inspector__rows">
            <dt>增益</dt>
            <dd>{control("audio","gain",picked.clip.audio.gain,0,2)}</dd>
            <dt>声像</dt><dd>{control("audio","pan",picked.clip.audio.pan,-1,1)}</dd>
            <dt>效果</dt>
            <dd>{picked.clip.effects.length} 个</dd>
          </dl></>}
        </div>
      ) : selection.length > 1 ? (
        <p className="panel-placeholder">已选中 {selection.length} 个块，请单选一个片段以调整属性。</p>
      ) : (
        <div className="inspector">
          <p className="panel-placeholder">在画布、图层或时间线中选择片段，调整变换与音频。</p>
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
            {source && <><dt>源音轨</dt><dd>{source.name} · {source.channels} 声道</dd></>}
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
