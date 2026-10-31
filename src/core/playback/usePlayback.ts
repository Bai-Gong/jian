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
 * 每个片段实例由 WebView 解码，Canvas 叠加视频，WebAudio 混合全部有效音轨。
 */
import { useEffect } from "react";
import { buildFrameDescription, evaluateSequence } from "../composite/composite";
import type { FrameDescription } from "../composite/composite";
import { selectActiveSequence, useProjectStore } from "../project/store";
import { videoPool } from "./VideoPool";

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

/** 将统一求值结果送入 Canvas/WebAudio，保持预览与导出语义一致。 */
function syncPool(desc: FrameDescription, playing: boolean): void {
  const state = useProjectStore.getState();
  const sequence = selectActiveSequence(state);
  videoPool.sync(desc, state.document.assets, sequence.width, sequence.height, playing);
}

function pauseAllElements(): void { videoPool.pauseAll(); }

// ---- 对外 API（模块级函数，引用恒定） ----

function play(): void {
  videoPool.resumeAudio();
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
    const documentSubscription = useProjectStore.subscribe((s) => s.document, () => {
      const state = useProjectStore.getState();
      syncPool(buildFrameDescription(selectActiveSequence(state), state.playheadUs, state.document.assets), state.isPlaying);
    });
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
      documentSubscription();
      stopClock();
      pauseAllElements();
    };
  }, []);
  return { play, pause, seek, stepFrame };
}
