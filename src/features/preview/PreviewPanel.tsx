/**
 * 节目预览器：M1 形态＝HTML5 video 元素池（开发方案 3.5）。
 *
 * DOM 契约（与 core/playback/VideoPool 对齐）：
 * - 本组件只提供舞台容器：aspect-ratio＝序列比、黑底（token）、position:relative；
 * - video 元素由池创建（object-fit:contain 自带 letterbox）、显隐与出声由池每帧切换；
 * - 挂载即 videoPool.mount(容器)，卸载 unmount——元素生命周期完全归池。
 * 走带条（TransportBar）贴在舞台下方，与本面板同生共死。
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { DockPanel } from "@baigong/fang";
import { useProjectStore, selectActiveSequence } from "../../core/project/store";
import { videoPool } from "../../core/playback/VideoPool";
import { TransportBar } from "./TransportBar";
import { buildFrameDescription, type LayerDesc } from "../../core/composite/composite";
import { containsPoint } from "../../core/playback/canvasGeometry";

export function PreviewPanel() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [error,setError]=useState("");
  const selection=useProjectStore((s)=>s.selection);
  useEffect(()=>{videoPool.setSelection(selection);},[selection]);
  const drag=useRef<{id:string;pointer:number;px:number;py:number;layer:LayerDesc;mode:"move"|"scale"|"rotate"}|null>(null);
  const point=(event:ReactPointerEvent<HTMLDivElement>)=>{const rect=event.currentTarget.getBoundingClientRect();return [(event.clientX-rect.left)*width/rect.width,(event.clientY-rect.top)*height/rect.height] as const;};
  const onPointerDown=(event:ReactPointerEvent<HTMLDivElement>)=>{
    if(event.button!==0)return;
    const state=useProjectStore.getState(),sequence=selectActiveSequence(state),[x,y]=point(event);
    const desc=buildFrameDescription(sequence,state.playheadUs,state.document.assets);
    const layer=[...desc.videoLayers].reverse().find((l)=>{const asset=state.document.assets.find((a)=>a.id===l.assetId);return asset && containsPoint(l,asset.width,asset.height,width,height,x,y);});
    state.setSelection(layer?[layer.clipId]:[]);if(!layer)return;
    const track=sequence.tracks.find((t)=>t.id===layer.trackId);if(track?.locked)return;
    drag.current={id:layer.clipId,pointer:event.pointerId,px:x,py:y,layer,mode:event.altKey?"rotate":event.shiftKey?"scale":"move"};
    event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();
  };
  const onPointerMove=(event:ReactPointerEvent<HTMLDivElement>)=>{
    const d=drag.current;if(!d || d.pointer!==event.pointerId)return;
    const [x,y]=point(event),store=useProjectStore.getState(),l=d.layer;
    if(d.mode==="move") {store.setClipProperty(d.id,"transform","x",l.x+x-d.px);store.setClipProperty(d.id,"transform","y",l.y+y-d.py);}
    else {
      const cx=width/2+l.x,cy=height/2+l.y;
      if(d.mode==="scale")store.setClipProperty(d.id,"transform","scale",Math.max(0.01,l.scale*Math.hypot(x-cx,y-cy)/Math.max(1,Math.hypot(d.px-cx,d.py-cy))));
      else store.setClipProperty(d.id,"transform","rotation",l.rotation+(Math.atan2(y-cy,x-cx)-Math.atan2(d.py-cy,d.px-cx))*180/Math.PI);
    }
  };
  // 序列画幅驱动舞台比例；取原始值避免播放中随 playhead 重渲染
  const width = useProjectStore((s) => selectActiveSequence(s).width);
  const height = useProjectStore((s) => selectActiveSequence(s).height);
  const hasAnyClip = useProjectStore((s) =>
    selectActiveSequence(s).tracks.some((t) => t.clips.length > 0),
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    videoPool.mount(stage);
    const report=(event:Event)=>setError(String((event as CustomEvent).detail));
    stage.addEventListener("preview-error",report);
    return () => {stage.removeEventListener("preview-error",report);videoPool.unmount();};
  }, []);

  return (
    <DockPanel
      title="节目预览器"
      collapsed={false}
      className="preview-panel"
      style={{ flex: 1, minHeight: 0 }}
    >
      <div className="preview-body">
        <div className="preview-stage-wrap">
          <div
            ref={stageRef}
            className="preview-stage"
            style={{ aspectRatio: `${width} / ${height}`,touchAction:"none" }}
            title="拖动画面移动；Shift＋拖动缩放；Alt＋拖动旋转"
            onPointerDown={onPointerDown} onPointerMove={onPointerMove}
            onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}
          >
            {!hasAnyClip && <span className="preview-stage__empty">时间线暂无画面</span>}
          </div>
        </div>
        {error && <button type="button" onClick={()=>setError("")} role="alert">{error}（点击收起）</button>}
        <TransportBar />
      </div>
    </DockPanel>
  );
}
