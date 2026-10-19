/**
 * 播放引擎（M1，开发方案 §3.5）：rAF 时钟驱动 videoPool 按 FrameDescription 走带。
 *
 * 架构要点：
 * - playheadUs 用 zustand 直写（transient）——每帧只动这一个字段，不触发 React 渲染；
 *   需要逐帧跟进的 UI（播放头标记、时间码）走命令式订阅：
 *   useProjectStore.subscribe((s) => s.playheadUs, cb)（subscribeWithSelector 提供）。
 * - 「当前时刻显示哪个块/哪些出声」一律复用 buildFrameDescription，本文件不自算窗口。
 * - 轨道静音/独奏不在播放侧处理：evaluateSequence 的 audioLayers 已经算完（导出同一份）。
 *
 * M1 已知局限：非顶层视频块不显示；同一素材多块同播只出一份声。M2 canvas 合成修。
 */
import { useEffect } from "react";
import { buildFrameDescription, evaluateSequence } from "../composite/composite";
import type { FrameDescription, LayerDesc } from "../composite/composite";
import { selectActiveSequence, useProjectStore } from "../project/store";
import type { MediaAsset } from "../project/types";
import { videoPool } from "./VideoPool";

/** 源时间偏差超过 80ms 才校正 currentTime（容忍解码抖动，防高频 seek 卡顿）。 */
const SEEK_TOLERANCE_SEC = 0.08;
/** HTMLVideoElement.playbackRate 合法区间，出界会抛 IndexSizeError。 */
const RATE_MIN = 0.0625;
const RATE_MAX = 16;

export interface PlaybackApi {
  play(): void;
  pause(): void;
  seek(us: number): void;
  /** 逐帧步进：先取整到最近帧，再跨 deltaFrames 帧（±1 即逐帧）。 */
  stepFrame(deltaFrames: number): void;
}

// ---- rAF 时钟（模块级单钟：多个 hook 实例共享，谁先挂载谁接管） ----

let rafId = 0;
let anchorWallMs = 0;
let anchorPlayheadUs = 0;

function clockRunning(): boolean {
  return rafId !== 0;
}

/** 起摆/重锚：以当前播放头为锚。已在跑则只重锚（seek/连按 L 的场景）。 */
function startClock(): void {
  anchorPlayheadUs = useProjectStore.getState().playheadUs;
  anchorWallMs = performance.now();
  if (clockRunning()) return;
  rafId = requestAnimationFrame(tick);
}

function stopClock(): void {
  if (!clockRunning()) return;
  cancelAnimationFrame(rafId);
  rafId = 0;
}

function tick(): void {
  const state = useProjectStore.getState();
  const sequence = selectActiveSequence(state);
  const assets = state.document.assets;
  const totalUs = evaluateSequence(sequence, assets).durationUs;
  const tUs = anchorPlayheadUs + (performance.now() - anchorWallMs) * 1000;

  if (tUs >= totalUs) {
    // 到尾：播放头钳在总时长，显示最后一帧（取尾前一瞬的帧描述，半开区间尾巴取不到）并停播
    useProjectStore.setState({ playheadUs: totalUs });
    syncPool(buildFrameDescription(sequence, Math.max(0, totalUs - 1), assets), false);
    state.setPlaying(false); // 订阅里会停摆
    return;
  }
  useProjectStore.setState({ playheadUs: tUs }); // transient 直写，不带动 React
  syncPool(buildFrameDescription(sequence, tUs, assets), true);
  rafId = requestAnimationFrame(tick);
}

/**
 * 把一帧的求值结果落到池元素上：
 * 显示＝最顶层视频块（M1 单层取景）；出声＝全部音频块；
 * 元素速率=speed、音量=gain（DOM 上限 1，gain>1 的放大 M2 交 WebAudio）；
 * 源时间偏差超阈才 seek。
 */
function syncPool(desc: FrameDescription, playing: boolean): void {
  const assets = useProjectStore.getState().document.assets;
  const assetById = new Map<string, MediaAsset>(assets.map((a) => [a.id, a] as const));

  // 每个素材取一个「驱动层」：先铺音频层，视频层后铺（同素材时画面优先对齐显示层）
  const driverByAsset = new Map<string, LayerDesc>();
  for (const layer of desc.audioLayers) driverByAsset.set(layer.assetId, layer);
  for (const layer of desc.videoLayers) driverByAsset.set(layer.assetId, layer);
  const audibleAssets = new Set(desc.audioLayers.map((l) => l.assetId));
  const topVideoAssetId =
    desc.videoLayers.length > 0 ? desc.videoLayers[desc.videoLayers.length - 1].assetId : null;

  // 本帧需要的元素先确保进池
  for (const assetId of driverByAsset.keys()) {
    const asset = assetById.get(assetId);
    if (asset) videoPool.acquire(asset);
  }

  for (const [assetId, el] of videoPool.entries()) {
    const layer = driverByAsset.get(assetId);
    const show = assetId === topVideoAssetId; // M1：只有最顶层视频块上画面
    el.style.display = show ? "block" : "none";
    if (!(el instanceof HTMLVideoElement)) continue; // img 定格：只管显隐
    if (!layer) {
      el.pause(); // 不在本帧：藏起来停走
      continue;
    }
    el.playbackRate = Math.min(RATE_MAX, Math.max(RATE_MIN, layer.speed));
    el.volume = Math.min(1, Math.max(0, layer.gain));
    // 块内源时间＝入点 ＋ (t − 块起点) × speed
    const targetSec = (layer.sourceInUs + (desc.tUs - layer.timelineStartUs) * layer.speed) / 1e6;
    if (Math.abs(el.currentTime - targetSec) > SEEK_TOLERANCE_SEC) {
      el.currentTime = Math.max(0, targetSec);
    }
    const shouldPlay = playing && (show || audibleAssets.has(assetId));
    if (shouldPlay) {
      void el.play().catch(() => {}); // 连续 seek 会打断 play（AbortError），吞掉等下一帧重试
    } else {
      el.pause();
    }
  }
}

function pauseAllElements(): void {
  for (const [, el] of videoPool.entries()) {
    if (el instanceof HTMLVideoElement) el.pause();
  }
}

// ---- 对外 API（模块级函数，引用恒定） ----

function play(): void {
  const state = useProjectStore.getState();
  const totalUs = evaluateSequence(selectActiveSequence(state), state.document.assets).durationUs;
  if (totalUs > 0 && state.playheadUs >= totalUs) {
    useProjectStore.setState({ playheadUs: 0 }); // 停在末尾再播：从头来（NLE 惯例）
  }
  state.setPlaying(true); // 订阅里起摆/重锚
}

function pause(): void {
  useProjectStore.getState().setPlaying(false); // 订阅里停摆并暂停元素
}

function seek(us: number): void {
  const tUs = Math.max(0, us);
  useProjectStore.setState({ playheadUs: tUs });
  anchorPlayheadUs = tUs; // 在播时重锚；暂停态无副作用
  anchorWallMs = performance.now();
  // 暂停态没有 rAF 在跑，当场补一帧；播放态下一 tick 自然对齐
  const state = useProjectStore.getState();
  syncPool(buildFrameDescription(selectActiveSequence(state), tUs, state.document.assets), state.isPlaying);
}

function stepFrame(deltaFrames: number): void {
  const fps = selectActiveSequence(useProjectStore.getState()).fps;
  const frameUs = 1e6 / fps;
  const current = useProjectStore.getState().playheadUs;
  seek(Math.round(current / frameUs) * frameUs + deltaFrames * frameUs);
}

/**
 * 播放控制 hook（TransportBar 挂载一次）。挂载即接管时钟：isPlaying 翻真起摆、
 * 翻假停摆；卸载时停摆并暂停全部元素。JKL/空格等快捷键由界面层注册，调这里的 API。
 */
export function usePlayback(): PlaybackApi {
  useEffect(() => {
    if (useProjectStore.getState().isPlaying) startClock(); // 挂载时已在播（热重载/面板迟到）
    const unsubscribe = useProjectStore.subscribe(
      (s) => s.isPlaying,
      (playing) => {
        if (playing) {
          startClock();
        } else {
          stopClock();
          pauseAllElements();
        }
      },
    );
    return () => {
      unsubscribe();
      stopClock();
      pauseAllElements();
    };
  }, []);
  return { play, pause, seek, stepFrame };
}
