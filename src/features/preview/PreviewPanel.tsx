/** WebView 解码、Canvas 合成；工具与视图变换不写入工程。 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Film, Upload } from "lucide-react";
import { useProjectStore, selectActiveSequence } from "../../core/project/store";
import { videoPool } from "../../core/playback/VideoPool";
import { TransportBar } from "./TransportBar";
import { buildFrameDescription, type LayerDesc } from "../../core/composite/composite";
import { containsPoint } from "../../core/playback/canvasGeometry";
import { useWorkspace } from "../../shell/workspace";
import { openWorkspaceAssets } from "../../shell/WorkspaceChrome";

type Drag = { pointer: number; px: number; py: number; mode: "move"|"scale"|"rotate"; layer: LayerDesc } |
  { pointer: number; px: number; py: number; mode: "hand"; pan: {x:number;y:number} };
export function PreviewPanel() {
  const stageRef = useRef<HTMLDivElement>(null), wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [fit,setFit] = useState({width:1,height:1});
  const [error,setError] = useState("");
  const {tool,zoom,pan,controls} = useWorkspace();
  const selection=useProjectStore((s)=>s.selection);
  const width=useProjectStore((s)=>selectActiveSequence(s).width);
  const height=useProjectStore((s)=>selectActiveSequence(s).height);
  const hasAnyClip=useProjectStore((s)=>selectActiveSequence(s).tracks.some(t=>t.clips.length>0));
  useEffect(()=>{videoPool.setSelection(controls?selection:[]);},[selection,controls]);
  useEffect(()=>{
    const wrap=wrapRef.current;if(!wrap)return;
    const resize=()=>{
      const scale=zoom??Math.max(0.01,Math.min((wrap.clientWidth-64)/width,(wrap.clientHeight-64)/height));
      setFit({width:width*scale,height:height*scale});
      useWorkspace.setState({canvasScale:scale});
    };
    resize();const observer=new ResizeObserver(resize);observer.observe(wrap);return()=>observer.disconnect();
  },[width,height,zoom]);
  useEffect(()=>{
    const stage=stageRef.current;if(!stage)return;
    videoPool.mount(stage);
    const report=(event:Event)=>setError(String((event as CustomEvent).detail));
    stage.addEventListener("preview-error",report);
    return()=>{stage.removeEventListener("preview-error",report);videoPool.unmount();};
  },[]);
  const point=(event:ReactPointerEvent)=>{
    const rect=stageRef.current!.getBoundingClientRect();
    return [(event.clientX-rect.left)*width/rect.width,(event.clientY-rect.top)*height/rect.height] as const;
  };
  const onPointerDown=(event:ReactPointerEvent<HTMLDivElement>)=>{
    if(event.button!==0 || (event.target as HTMLElement).closest("button"))return;
    if(tool==="zoom"){
      const state=useWorkspace.getState();state.setZoom(state.canvasScale*(event.altKey?0.8:1.25));return;
    }
    if(tool==="hand")drag.current={pointer:event.pointerId,px:event.clientX,py:event.clientY,mode:"hand",pan};
    else {
      const state=useProjectStore.getState(),sequence=selectActiveSequence(state),[x,y]=point(event);
      const desc=buildFrameDescription(sequence,state.playheadUs,state.document.assets);
      const layer=[...desc.videoLayers].reverse().find(l=>{const asset=state.document.assets.find(a=>a.id===l.assetId);return asset&&containsPoint(l,asset.width,asset.height,width,height,x,y);});
      state.setSelection(layer?[layer.clipId]:[]);if(!layer)return;
      useWorkspace.getState().setPanel("properties");
      if(sequence.tracks.find(t=>t.id===layer.trackId)?.locked)return;
      drag.current={pointer:event.pointerId,px:x,py:y,layer,mode:event.altKey||tool==="rotate"?"rotate":event.shiftKey||tool==="scale"?"scale":"move"};
    }
    event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();
  };
  const onPointerMove=(event:ReactPointerEvent<HTMLDivElement>)=>{
    const d=drag.current;if(!d||d.pointer!==event.pointerId)return;
    if(d.mode==="hand"){useWorkspace.setState({pan:{x:d.pan.x+event.clientX-d.px,y:d.pan.y+event.clientY-d.py}});return;}
    const [x,y]=point(event),store=useProjectStore.getState(),l=d.layer;
    if(d.mode==="move"){store.setClipProperty(l.clipId,"transform","x",l.x+x-d.px);store.setClipProperty(l.clipId,"transform","y",l.y+y-d.py);}
    else {
      const cx=width/2+l.x,cy=height/2+l.y;
      if(d.mode==="scale")store.setClipProperty(l.clipId,"transform","scale",Math.max(0.01,l.scale*Math.hypot(x-cx,y-cy)/Math.max(1,Math.hypot(d.px-cx,d.py-cy))));
      else store.setClipProperty(l.clipId,"transform","rotation",l.rotation+(Math.atan2(y-cy,x-cx)-Math.atan2(d.py-cy,d.px-cx))*180/Math.PI);
    }
  };
  return <section className="preview-panel" aria-label="画布预览">
    <div ref={wrapRef} className={`preview-stage-wrap tool-${tool}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}>
      <div className="canvas-ruler horizontal" aria-hidden="true">{[0,1,2,3,4].map(i=><span key={i} style={{left:`calc(50% + ${(i/4-.5)*fit.width+pan.x}px)`}}>{Math.round(width*i/4)}</span>)}</div>
      <div className="canvas-ruler vertical" aria-hidden="true">{[0,1,2,3,4].map(i=><span key={i} style={{top:`calc(50% + ${(i/4-.5)*fit.height+pan.y}px)`}}>{Math.round(height*i/4)}</span>)}</div>
      <div ref={stageRef} className="preview-stage" style={{width:fit.width,height:fit.height,transform:`translate(${pan.x}px, ${pan.y}px)`}} />
      {!hasAnyClip&&<div className="canvas-empty"><Film size={30} strokeWidth={1}/><strong>开始你的下一段故事</strong><span>导入素材，然后插入时间线</span><button type="button" onClick={()=>void openWorkspaceAssets()}><Upload size={13}/>导入素材</button><small>MP4 / M4A</small></div>}
    </div>
    {error&&<div className="preview-error" role="alert">{error}<button type="button" onClick={()=>setError("")}>关闭</button></div>}
    <TransportBar />
  </section>;
}
