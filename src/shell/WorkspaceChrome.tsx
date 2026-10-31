import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Move, Scaling, RotateCw, Hand, ZoomIn, Upload, Maximize, ChevronDown, Film, Music2, LockKeyhole, Volume2, VolumeX, Plus, Trash2, PanelRight, SlidersHorizontal } from "lucide-react";
import { selectActiveSequence, useProjectStore } from "../core/project/store";
import { clipEndUs, sequenceDurationUs } from "../core/project/timelineOps";
import { importAssets } from "../core/media/importAssets";
import { basename } from "../features/media-bin/AssetCard";
import { formatTimecode } from "../features/preview/timecode";
import { useRuntimeStore } from "../core/media/runtime";
import { TOOL_NAMES, useWorkspace, type CanvasTool } from "./workspace";

const tools = [
  ["move", Move, "V"], ["scale", Scaling, "T"], ["rotate", RotateCw, "R"],
  ["hand", Hand, "H"], ["zoom", ZoomIn, "Z"],
] as const;

export async function openWorkspaceAssets() {
  useWorkspace.getState().setPanel("assets");
  await importAssets();
}

export function ToolRail() {
  const tool = useWorkspace((s) => s.tool);
  useEffect(() => {
    const keys: Record<string, CanvasTool> = { v: "move", t: "scale", r: "rotate", h: "hand", z: "zoom" };
    const keydown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      if ((event.target as HTMLElement)?.closest("input,textarea,select,[contenteditable=true]")) return;
      const next = keys[event.key.toLowerCase()];
      if (next) { event.preventDefault(); useWorkspace.getState().setTool(next); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);
  return <aside className="tool-rail" aria-label="工具栏">
    <div className="tool-rail__grip">››</div>
    {tools.map(([id, Icon, key]) => <button key={id} type="button" className={tool === id ? "is-active" : ""}
      title={`${TOOL_NAMES[id]} (${key})`} aria-label={`${TOOL_NAMES[id]}工具`} aria-pressed={tool === id}
      onClick={() => useWorkspace.getState().setTool(id)}><Icon size={18} strokeWidth={1.5} /></button>)}
    <div className="tool-rail__divider" />
    <button type="button" title="导入素材" aria-label="导入素材到素材面板" onClick={() => void openWorkspaceAssets()}><Upload size={17} /></button>
    <button type="button" title="适合窗口" aria-label="适合窗口" onClick={() => useWorkspace.getState().setZoom(null)}><Maximize size={17} /></button>
    <div className="tool-rail__spacer" />
    <span className="tool-rail__brand" title="百工·剪">剪</span>
  </aside>;
}

export function ToolOptions() {
  const { tool, controls, zoom } = useWorkspace();
  const sequence = useProjectStore(selectActiveSequence);
  const selection = useProjectStore((s) => s.selection);
  const picked = sequence.tracks.flatMap((track) => track.clips.map((clip) => ({ clip, track }))).find(({ clip }) => selection.length === 1 && clip.id === selection[0]);
  const resetTransform = () => {
    if (!picked) return;
    for (const [name, value] of Object.entries({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }))
      useProjectStore.getState().setClipProperty(picked.clip.id, "transform", name, value);
  };
  const Icon = tools.find(([id]) => id === tool)![1];
  return <div className="tool-options" role="toolbar" aria-label="工具选项">
    <span className="tool-options__current"><Icon size={17} /><ChevronDown size={10} /></span>
    <strong>{TOOL_NAMES[tool]}</strong><i />
    <label className="checkbox-option"><input type="checkbox" checked={controls} onChange={(e) => useWorkspace.setState({ controls: e.target.checked })} />显示变换控件</label>
    <button type="button" className="quiet-button" disabled={!picked || picked.track.locked} onClick={resetTransform}>重置变换</button>
    <i /><label>视图 <select aria-label="画布缩放" value={zoom ?? "fit"} onChange={(e) => useWorkspace.getState().setZoom(e.target.value === "fit" ? null : Number(e.target.value))}>
      <option value="fit">适合窗口</option>{[0.25, 0.5, 1, 2].map((z) => <option key={z} value={z}>{z * 100}%</option>)}
      {zoom !== null && ![0.25, 0.5, 1, 2].includes(zoom) && <option value={zoom}>{Math.round(zoom * 100)}%</option>}
    </select></label>
    <span className="tool-options__hint">{tool === "move" ? "拖动移动 · Shift 缩放 · Alt 旋转" : tool === "hand" ? "拖动画布调整视图" : tool === "zoom" ? "点击放大 · Alt＋点击缩小" : `在画面上拖动${TOOL_NAMES[tool]}选中片段`}</span>
    <button type="button" className="workspace-reset" onClick={() => useWorkspace.getState().reset()} title="恢复默认面板尺寸与画布视图"><PanelRight size={14} />剪辑工作区</button>
  </div>;
}

export function DocumentTab() {
  const name = useProjectStore((s) => s.document.name);
  const sequence = useProjectStore(selectActiveSequence);
  const scale = useWorkspace((s) => s.canvasScale);
  return <div className="document-tabs"><div className="document-tab"><Film size={13} /><span>{name}</span><small>@ {Math.round(scale * 100)}% · {sequence.width} × {sequence.height}</small></div><span className="document-tabs__space" /></div>;
}

export function LayersPanel() {
  const sequence = useProjectStore(selectActiveSequence);
  const assets = useProjectStore((s) => s.document.assets);
  const selection = useProjectStore((s) => s.selection);
  const [filter, setFilter] = useState("all");
  const tracks = [...sequence.tracks.filter(t=>t.kind==="video").reverse(), ...sequence.tracks.filter(t=>t.kind==="audio").reverse()].filter((track) => filter === "all" || track.kind === filter);
  const canDelete = sequence.tracks.some(track=>!track.locked && track.clips.some(clip=>selection.includes(clip.id)));
  return <section className="layers-panel" aria-label="图层与轨道">
    <header className="panel-tabs"><span className="is-active">图层</span><small>{sequence.tracks.length} 个轨道</small><SlidersHorizontal size={13} /></header>
    <div className="layers-filter"><select aria-label="筛选轨道类型" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">全部轨道</option><option value="video">视频轨道</option><option value="audio">音频轨道</option></select><span>静态合成</span></div>
    <div className="layers-list">
      {tracks.map((track) => <div className={`layer-track ${track.locked ? "is-locked" : ""}`} key={track.id}>
        <div className="layer-track__heading">{track.kind === "video" ? <Film size={13} /> : <Music2 size={13} />}<strong>{track.name}</strong><span />
          <button type="button" aria-label={`${track.name}独奏`} aria-pressed={track.solo} title="独奏音频" onClick={() => useProjectStore.getState().toggleTrackSolo(track.id)}>S</button>
          <button type="button" aria-label={`${track.name}静音`} aria-pressed={track.muted} title="静音音频" onClick={() => useProjectStore.getState().toggleTrackMute(track.id)}>{track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}</button>
          <button type="button" aria-label={`${track.name}锁定`} aria-pressed={track.locked} title="锁定轨道" onClick={() => useProjectStore.getState().toggleTrackLock(track.id)}><LockKeyhole size={12} /></button>
        </div>
        {track.clips.length === 0 ? <p className="layer-track__empty">空轨道</p> : [...track.clips].reverse().map((clip) => {
          const asset = assets.find((a) => a.id === clip.assetId);
          return <button type="button" key={clip.id} className={`layer-row ${selection.includes(clip.id) ? "is-selected" : ""}`} aria-pressed={selection.includes(clip.id)}
            onClick={(event) => { const store = useProjectStore.getState(); if (event.ctrlKey) store.toggleClipSelection(clip.id); else store.setSelection([clip.id]); useWorkspace.getState().setPanel("properties"); }}
            onDoubleClick={() => useProjectStore.getState().setPlayhead(clip.timelineStartUs)} title={asset?.path}>
            <span className={`layer-row__thumb ${track.kind}`}>{track.kind === "video" ? <Film size={19} /> : <Music2 size={19} />}</span>
            <span className="layer-row__label"><strong>{asset ? basename(asset.path) : "素材已失效"}</strong><small>{formatTimecode(clip.timelineStartUs, sequence.fps)} — {formatTimecode(clipEndUs(clip), sequence.fps)}</small></span>
          </button>;
        })}
      </div>)}
    </div>
    <footer className="layers-footer"><span>{selection.length ? `已选 ${selection.length} 个片段` : "选择片段以编辑"}</span>
      <button type="button" title="新建视频轨道" aria-label="新建视频轨道" onClick={() => useProjectStore.getState().addTrack("video")}><Plus size={15} /></button>
      <button type="button" title="新建音频轨道" aria-label="新建音频轨道" onClick={() => useProjectStore.getState().addTrack("audio")}><Music2 size={14} /></button>
      <button type="button" title="删除选中片段" aria-label="删除选中片段" disabled={!canDelete} onClick={() => useProjectStore.getState().deleteSelected()}><Trash2 size={14} /></button>
    </footer>
  </section>;
}

export function WorkspaceStatus() {
  const sequence = useProjectStore(selectActiveSequence);
  const assets = useProjectStore((s) => s.document.assets.length);
  const runtime = useRuntimeStore((s) => s.info);
  const error = useRuntimeStore((s) => s.error);
  return <footer className="workspace-status"><span className={error ? "is-error" : ""}>{error || (runtime ? "就绪" : "正在检查媒体能力…")}</span><span>{sequence.width} × {sequence.height} px</span><span>{sequence.fps} fps</span><span>{formatTimecode(sequenceDurationUs(sequence), sequence.fps)}</span><span className="workspace-status__end">{assets} 个素材 · {sequence.tracks.length} 个轨道</span></footer>;
}

export function WorkspaceDivider({ direction }: { direction: "horizontal" | "vertical" }) {
  const horizontal = direction === "horizontal";
  const current = useWorkspace(s=>horizontal?s.timelineHeight:s.rightWidth);
  const change = (value: number) => useWorkspace.setState(horizontal
    ? { timelineHeight: Math.max(190, Math.min(window.innerHeight * 0.55, value)) }
    : { rightWidth: Math.max(280, Math.min(Math.min(440, window.innerWidth * 0.36), value)) });
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  return <div className={`workspace-divider ${horizontal ? "horizontal" : "vertical"}`} role="separator" aria-label={horizontal ? "调整时间线高度" : "调整右侧面板宽度"} aria-orientation={direction} aria-valuenow={Math.round(current)} aria-valuemin={horizontal?190:280} aria-valuemax={horizontal?Math.round(window.innerHeight*0.55):440} tabIndex={0}
    onPointerDown={start} onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) change(horizontal ? window.innerHeight - e.clientY - 23 : window.innerWidth - e.clientX); }}
    onKeyDown={(e) => { if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) { e.preventDefault(); const s = useWorkspace.getState(); change((horizontal ? s.timelineHeight : s.rightWidth) + (["ArrowUp", "ArrowLeft"].includes(e.key) ? 16 : -16)); } }} />;
}
