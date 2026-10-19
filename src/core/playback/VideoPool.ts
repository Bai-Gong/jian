/**
 * 媒体元素池（开发方案 §3.5 M1 阶段）：每素材一个 DOM 元素，预览舞台的显示主体。
 * 池只管元素生命周期与主静音；「这一帧显示谁、谁出声、走带到哪」由 usePlayback
 * 按 FrameDescription 驱动——求值永远只有一个出处（core/composite）。
 *
 * M1 已知局限：video 元素池单层取景——非顶层视频块画面不可见；
 * 同一素材多个块同播时共用一个元素，只出一份声（导出走 amix 是多路）。均 M2 canvas 合成修。
 */
import { assetUrl } from "../media/assetUrl";
import type { MediaAsset } from "../project/types";

/** 舞台内媒体元素的统一形态：铺满容器、保持比例、初始隐藏（显隐由播放循环逐帧切）。 */
function applyStageStyle(el: HTMLElement): void {
  el.style.position = "absolute";
  el.style.inset = "0";
  el.style.width = "100%";
  el.style.height = "100%";
  el.style.objectFit = "contain";
  el.style.display = "none";
}

export class VideoPool {
  private container: HTMLElement | null = null;
  /** assetId → 媒体元素。视频/音频建 video（纯音频只出声），图片建 img（定格帧）。 */
  private readonly elements = new Map<string, HTMLElement>();
  private masterMuted = false;

  /** 舞台容器就位（PreviewPanel 的 useEffect 调一次）；已 acquire 的元素随后挂进去。 */
  mount(container: HTMLElement): void {
    if (this.container === container) return;
    this.unmount();
    this.container = container;
    for (const el of this.elements.values()) container.appendChild(el);
  }

  /** 舞台拆除：元素摘下留用（不销毁），下次 mount 再挂回。 */
  unmount(): void {
    if (this.container === null) return;
    for (const el of this.elements.values()) el.remove();
    this.container = null;
  }

  /** 取素材对应的媒体元素（无则建）。同一素材恒同一个元素——这就是 M1 的单元素局限所在。 */
  acquire(asset: MediaAsset): HTMLElement {
    const existing = this.elements.get(asset.id);
    if (existing) return existing;
    const el = asset.kind === "image" ? document.createElement("img") : document.createElement("video");
    el.src = assetUrl(asset.path);
    if (el instanceof HTMLVideoElement) {
      el.preload = "auto";
      el.playsInline = true; // 桌面 WebView 无碍，防移动端全屏劫持
      el.muted = this.masterMuted;
    } else {
      el.alt = "";
    }
    applyStageStyle(el);
    this.elements.set(asset.id, el);
    this.container?.appendChild(el);
    return el;
  }

  /** 素材不再被任何层引用时归还（元素销毁）。 */
  release(assetId: string): void {
    this.elements.get(assetId)?.remove();
    this.elements.delete(assetId);
  }

  get(assetId: string): HTMLElement | undefined {
    return this.elements.get(assetId);
  }

  /** 池内全部元素（usePlayback 逐帧切显隐/音量/走带用）。 */
  entries(): IterableIterator<[string, HTMLElement]> {
    return this.elements.entries();
  }

  /** 全局（主）静音：独立于各层增益，直接压 element.muted。 */
  setMasterMuted(muted: boolean): void {
    this.masterMuted = muted;
    for (const el of this.elements.values()) {
      if (el instanceof HTMLVideoElement) el.muted = muted;
    }
  }
}

/** 模块级单例：舞台与素材元素跨组件共享（预览器 mount、TransportBar 控静音、播放引擎走带）。 */
export const videoPool: VideoPool = new VideoPool();
