/** WebView decodes each clip occurrence; Canvas and WebAudio consume the evaluator. */
import { audioPreview, type AudioPreview } from "../media/audioPreview";
import { assetUrl } from "../media/assetUrl";
import type { MediaAsset } from "../project/types";
import type { FrameDescription } from "../composite/composite";

interface AudioRoute { source: MediaElementAudioSourceNode; input: GainNode; splitter: ChannelSplitterNode; left: GainNode; right: GainNode; merger: ChannelMergerNode }
export class VideoPool {
  private container: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private readonly elements = new Map<string, HTMLVideoElement | HTMLImageElement>();
  private readonly routes = new Map<string, AudioRoute>();
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private masterMuted = false;
  private readonly loading=new Map<string,Promise<void>>();
  private readonly failed=new Set<string>();
  private readonly audioSources=new Map<string,AudioPreview>();
  private selected = new Set<string>();
  private last: { desc: FrameDescription; assets:readonly MediaAsset[]; width: number; height: number; playing:boolean } | null = null;

  mount(container: HTMLElement): void {
    this.unmount(); this.container = container;
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "width:100%;height:100%;display:block;position:absolute;inset:0";
    this.canvas.setAttribute("aria-label", "多轨画面预览");
    container.appendChild(this.canvas);
    for (const element of this.elements.values()) container.appendChild(element);
    this.draw();
  }
  unmount(): void {
    this.pauseAll(); this.canvas?.remove(); this.canvas = null;
    for (const element of this.elements.values()) element.remove();
    this.container = null;
  }
  private report(message: string): void {
    this.container?.dispatchEvent(new CustomEvent("preview-error", { detail: message }));
  }
  acquire(asset: MediaAsset, key = asset.id, streamIndex?:number): HTMLVideoElement | HTMLImageElement {
    const existing = this.elements.get(key); if (existing) return existing;
    const el = asset.kind === "image" ? document.createElement("img") : document.createElement("video");
    el.crossOrigin = "anonymous";
    if(streamIndex===undefined)el.src = assetUrl(asset.path);
    el.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none";
    if (el instanceof HTMLVideoElement) { el.preload = "auto"; el.playsInline = true; el.muted = true; }
    else el.alt = "";
    for (const event of ["loadeddata", "seeked", "load"]) el.addEventListener(event, () => this.draw());
    el.addEventListener("error", () => this.report(`预览无法解码：${asset.path}`));
    this.elements.set(key, el); this.container?.appendChild(el);
    if(streamIndex!==undefined){
      const job=audioPreview(asset,streamIndex).then(source=>{
        if(this.elements.get(key)!==el)return;
        this.audioSources.set(key,source);el.src=assetUrl(source.path);
        const last=this.last;if(last)this.sync(last.desc,last.assets,last.width,last.height,last.playing);
      }).catch((e:unknown)=>{if(this.elements.get(key)===el){this.failed.add(key);this.report(`音轨 ${streamIndex} 预览准备失败：${String(e)}`);}throw e;})
        .finally(()=>{if(this.loading.get(key)===job)this.loading.delete(key);this.status();});
      this.loading.set(key,job);void job.catch(()=>{});this.status();
    }
    return el;
  }
  release(key: string): void {
    const el = this.elements.get(key);
    if (el instanceof HTMLVideoElement) { el.pause(); el.removeAttribute("src"); el.load(); }
    el?.remove(); this.elements.delete(key);this.audioSources.delete(key);this.failed.delete(key);this.loading.delete(key);this.status();
    const route = this.routes.get(key);
    if (route) { for (const node of Object.values(route)) node.disconnect(); this.routes.delete(key); }
  }
  get(key: string): HTMLElement | undefined { return this.elements.get(key); }
  entries(): IterableIterator<[string, HTMLVideoElement | HTMLImageElement]> { return this.elements.entries(); }
  setMasterMuted(muted: boolean): void { this.masterMuted = muted; if (this.master) this.master.gain.value = muted ? 0 : 1; }
  setSelection(ids:readonly string[]):void {this.selected=new Set(ids);this.draw();}
  refresh():void {this.draw();}
  pauseAll(): void {
    for (const el of this.elements.values()) if (el instanceof HTMLVideoElement) el.pause();
    for (const route of this.routes.values()) { route.left.gain.value = 0; route.right.gain.value = 0; }
  }
  resumeAudio(): void {
    this.context ??= new AudioContext({ sampleRate: 48000 });
    if (!this.master) { this.master = this.context.createGain(); this.master.gain.value = this.masterMuted ? 0 : 1; this.master.connect(this.context.destination); }
    void this.context.resume().catch((error) => this.report(`音频预览启动失败：${String(error)}`));
  }
  private audioRoute(key: string, el: HTMLVideoElement): AudioRoute | undefined {
    if (!this.context || !this.master) return undefined;
    const hit = this.routes.get(key); if (hit) return hit;
    const context = this.context;
    const source = context.createMediaElementSource(el), input = context.createGain();
    input.channelCount = 2; input.channelCountMode = "explicit"; input.channelInterpretation = "speakers";
    const splitter = context.createChannelSplitter(2), left = context.createGain(), right = context.createGain(), merger = context.createChannelMerger(2);
    left.gain.value = 0; right.gain.value = 0;
    source.connect(input); input.connect(splitter); splitter.connect(left, 0); splitter.connect(right, 1);
    left.connect(merger, 0, 0); right.connect(merger, 0, 1); merger.connect(this.master);
    el.muted = false; el.volume = 1;
    const route = { source, input, splitter, left, right, merger }; this.routes.set(key, route); return route;
  }
  sync(desc: FrameDescription, assets: readonly MediaAsset[], width: number, height: number, playing: boolean): void {
    this.last = { desc, assets, width, height, playing };
    const byId = new Map(assets.map((a) => [a.id, a]));
    const drivers = new Map([...desc.audioLayers, ...desc.videoLayers].map((layer) => [layer.clipId, layer]));
    const audio = new Map(desc.audioLayers.map((layer) => [layer.clipId, layer]));
    for (const key of this.elements.keys()) if (!drivers.has(key)) this.release(key);
    for (const [key, layer] of drivers) {
      const asset = byId.get(layer.assetId); if (!asset) continue;
      const el = this.acquire(asset, key, layer.sourceStreamIndex !== undefined && audio.has(key) ? layer.sourceStreamIndex : undefined); if (!(el instanceof HTMLVideoElement)) continue;
      const target = Math.max(0, (layer.sourceInUs + (desc.tUs - layer.timelineStartUs) * layer.speed) / 1e6);
      if(this.loading.has(key)&&!this.audioSources.has(key))continue;
      if(this.failed.has(key))continue;
      const source=this.audioSources.get(key);
      el.playbackRate = Math.min(16, Math.max(0.0625, layer.speed));
      const mediaTarget=Math.max(0,target-(source?.sourceOriginUs??0)/1e6);
      if (Math.abs(el.currentTime - mediaTarget) > (playing ? 0.08 : 0.0005)) el.currentTime = mediaTarget;
      const mix = audio.get(key), route = mix ? this.audioRoute(key, el) : this.routes.get(key);
      const audible=playing&&mix&&(!source||(target*1e6>=source.validStartUs&&target*1e6<source.validEndUs));
      if (route) {
        route.left.gain.value = audible && mix ? mix.gain * (1 - Math.max(0, mix.pan)) : 0;
        route.right.gain.value = audible && mix ? mix.gain * (1 + Math.min(0, mix.pan)) : 0;
      }
      if (playing) void el.play().catch((error: unknown) => {
        if (!(error instanceof DOMException) || error.name !== "AbortError") this.report(`播放失败：${String(error)}`);
      });
      else el.pause();
    }
    this.draw();
  }
  private status():void {
    this.container?.dispatchEvent(new CustomEvent("preview-status",{detail:this.loading.size?`正在准备 ${this.loading.size} 条独立音轨…`:""}));
  }
  async prepare(desc:FrameDescription,assets:readonly MediaAsset[],width:number,height:number):Promise<void>{
    this.sync(desc,assets,width,height,false);
    await Promise.all(this.loading.values());
    if(this.failed.size)throw new Error("独立音轨准备失败");
  }
  private draw(): void {
    if (!this.canvas || !this.last) return;
    const { desc, width, height } = this.last;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const context = this.canvas.getContext("2d"); if (!context) return;
    context.globalAlpha = 1; context.fillStyle = "black"; context.fillRect(0, 0, width, height);
    for (const layer of desc.videoLayers) {
      const el = this.elements.get(layer.clipId); if (!el) continue;
      const [w, h] = el instanceof HTMLVideoElement ? [el.videoWidth, el.videoHeight] : [el.naturalWidth, el.naturalHeight];
      if (!w || !h || (el instanceof HTMLVideoElement && el.readyState < 2)) continue;
      context.save(); context.translate(width / 2 + layer.x, height / 2 + layer.y);
      context.rotate(layer.rotation * Math.PI / 180); context.scale(layer.scale, layer.scale); context.globalAlpha = layer.opacity;
      context.drawImage(el, -w / 2, -h / 2, w, h); context.restore();
    }
    if(this.canvas.clientWidth<2)return;
    for(const layer of desc.videoLayers.filter((l)=>this.selected.has(l.clipId))) {
      const el=this.elements.get(layer.clipId);if(!el)continue;
      const [w,h]=el instanceof HTMLVideoElement?[el.videoWidth,el.videoHeight]:[el.naturalWidth,el.naturalHeight];if(!w || !h || layer.scale<=0)continue;
      context.save();context.translate(width/2+layer.x,height/2+layer.y);context.rotate(layer.rotation*Math.PI/180);context.scale(layer.scale,layer.scale);
      context.strokeStyle="#67c5ff";context.lineWidth=1.5*width/Math.max(1,this.canvas.clientWidth)/layer.scale;context.strokeRect(-w/2,-h/2,w,h);context.restore();
    }
  }
}
export const videoPool = new VideoPool();
