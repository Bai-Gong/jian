import { useEffect, useRef, useState } from "react";
import { getWaveformPeaks, getStreamWaveformPeaks, type WaveformPeaks } from "../../core/media/waveform";
import type { Clip } from "../../core/project/types";
const pending = new Map<string,Promise<WaveformPeaks>>();
function waveform(path:string,streamIndex?:number):Promise<WaveformPeaks> {
  const key=`${path}:${streamIndex??"single"}`;const cached=pending.get(key);if(cached)return cached;
  const job=streamIndex===undefined?getWaveformPeaks(path,1024):getStreamWaveformPeaks(path,1024,streamIndex);pending.set(key,job);job.catch(()=>pending.delete(key));return job;
}
export function ClipWaveform({path,clip,width}:{path:string;clip:Clip;width:number}) {
  const canvas=useRef<HTMLCanvasElement>(null),[peaks,setPeaks]=useState<WaveformPeaks|null>(null),[error,setError]=useState("");
  useEffect(()=>{let active=true;setPeaks(null);setError("");void waveform(path,clip.sourceStreamIndex).then((p)=>{if(active)setPeaks(p);}).catch((e:unknown)=>{if(active)setError(String(e));});return()=>{active=false;};},[path,clip.sourceStreamIndex]);
  useEffect(()=>{
    const el=canvas.current;if(!el || !peaks)return;
    el.width=Math.max(2,Math.min(4096,Math.ceil(width)));el.height=24;
    const context=el.getContext("2d");if(!context)return;context.clearRect(0,0,el.width,24);context.strokeStyle="currentColor";context.beginPath();
    for(let x=0;x<el.width;x++){
      const lo=clip.sourceInUs+(clip.sourceOutUs-clip.sourceInUs)*x/el.width;
      const hi=clip.sourceInUs+(clip.sourceOutUs-clip.sourceInUs)*(x+1)/el.width;
      const from=Math.floor(lo*peaks.sampleRate/1e6/peaks.bucketSamples),to=Math.ceil(hi*peaks.sampleRate/1e6/peaks.bucketSamples);
      let minimum=0,maximum=0;
      for(const channel of peaks.peaks)for(let n=Math.max(0,from);n<Math.min(channel.length,to);n++){minimum=Math.min(minimum,channel[n].min);maximum=Math.max(maximum,channel[n].max);}
      context.moveTo(x,12-Math.min(1,maximum)*11);context.lineTo(x,12-Math.max(-1,minimum)*11);
    }
    context.stroke();
  },[peaks,clip.sourceInUs,clip.sourceOutUs,width]);
  return error ? <span title={error} style={{fontSize:10}}>波形失败</span> : <canvas ref={canvas} aria-label="音频波形" style={{position:"absolute",left:0,bottom:2,width:"100%",height:24,pointerEvents:"none",opacity:0.65}} />;
}
