/**
 * 导出命令生成：把 composite 求值结果翻译成一条 ffmpeg 命令的参数。
 * 铁律：层序/静音/独奏/总时长一律取 evaluateSequence，本文件禁自行枚举轨道——
 * 预览（buildFrameDescription）与导出（这里）消费同一份求值，任何属性组合都不能「预览得到、导不出」。
 *
 * 时间戳偏移写法均经实证（M1 施工契约 §5）：
 * - 视频层时间线定位走 setpts 的 `+{startUs}/1000000/TB`——setpts 表达式单位是 timebase，秒偏移必须 /TB；
 * - 音频层走 adelay（毫秒、all=1 覆盖全部声道），且必须排在 atempo 之后（防静音段被变速吃掉）。
 */
import { evaluateSequence } from "../composite/composite";
import type { LayerDesc } from "../composite/composite";
import type { MediaAsset, Sequence } from "../project/types";

/** 微秒 → 秒字符串（6 位小数保住微秒精度，ffmpeg 好这口）。 */
function secs(us: number): string {
  return (us / 1e6).toFixed(6);
}

/**
 * atempo 因子串：单个 atempo 只吃 [0.5, 2]，越界拆成多段串联（乘积＝speed）。
 * 变速只允许 atempo——asetpts 会破坏与画面的对齐，禁用。
 */
function atempoFactors(speed: number): string {
  const factors: number[] = [];
  let s = speed;
  while (s > 2) {
    factors.push(2);
    s /= 2;
  }
  while (s < 0.5 && s > 0) {
    factors.push(0.5);
    s *= 2;
  }
  factors.push(s);
  return factors.map((f) => `atempo=${f}`).join(",");
}

/** 单层音频链：atempo（变速）→ volume（增益）→ adelay（起点偏移，仅 startUs>0 时追加）。 */
function audioChain(layer: LayerDesc): string {
  let chain = `${atempoFactors(layer.speed)},volume=${layer.gain}`;
  if (layer.timelineStartUs > 0) {
    chain += `,adelay=${Math.round(layer.timelineStartUs / 1000)}:all=1`;
  }
  return chain;
}

/**
 * 生成完整 ffmpeg 参数（含 -progress pipe:1 -nostats 与输出路径）。
 * 输出结构：每块一个 -i 输入段 + 一条 filter_complex（层滤镜 → 底板 → overlay 链 → 音频链/amix）+ 编码输出段。
 */
export function buildExportArgs(sequence: Sequence, assets: readonly MediaAsset[], outPath: string): string[] {
  const ev = evaluateSequence(sequence, assets); // 唯一求值入口
  const assetById = new Map(assets.map((a) => [a.id, a] as const));

  // 输入编号：每个参与合成的块一个 -i。视频层先行，纯音频块补在后；
  // 同一块既出画面又出声时共用同一个输入号（[k:v] 与 [k:a] 各取各的流）。
  const ordered = [...ev.videoLayers];
  const seen = new Set(ordered.map((l) => l.clipId));
  for (const l of ev.audioLayers) {
    if (!seen.has(l.clipId)) {
      seen.add(l.clipId);
      ordered.push(l);
    }
  }
  const inputOf = new Map(ordered.map((l, i) => [l.clipId, i] as const));

  const args: string[] = [];
  for (const layer of ordered) {
    const asset = assetById.get(layer.assetId);
    if (!asset) continue; // 求值已滤悬空，防御性兜底
    if (asset.kind === "image") {
      // 图片：定格呈现。按序列帧率出帧，时长＝推导时长
      const durUs = (layer.sourceOutUs - layer.sourceInUs) / layer.speed;
      args.push("-loop", "1", "-framerate", String(sequence.fps), "-t", secs(durUs), "-i", asset.path);
    } else {
      // 视频/音频：-ss 入点前置（快 seek），-t 只读素材区间这么长（源时间，speed 在滤镜里才生效）
      args.push(
        "-ss",
        secs(layer.sourceInUs),
        "-t",
        secs(layer.sourceOutUs - layer.sourceInUs),
        "-i",
        asset.path,
      );
    }
  }

  const filters: string[] = [];

  // 视频层链：变速重定时 → 缩放 → 带透明度格式 → 旋转 → 不透明度。
  // format=rgba 必须在 rotate 前（rotate 的 c=none 依赖 alpha 通道）。
  for (const layer of ev.videoLayers) {
    const k = inputOf.get(layer.clipId)!;
    filters.push(
      `[${k}:v]setpts=(PTS-STARTPTS)/${layer.speed}+${layer.timelineStartUs}/1000000/TB,` +
        `scale=iw*${layer.scale}:ih*${layer.scale},format=rgba,` +
        `rotate=${layer.rotation}*PI/180:c=none,colorchannelmixer=aa=${layer.opacity}[l${k}]`,
    );
  }

  // 黑场底板：分辨率/帧率取序列，时长取求值总时长
  filters.push(
    `color=c=black:s=${sequence.width}x${sequence.height}:r=${sequence.fps}:d=${secs(ev.durationUs)}[base]`,
  );

  // 叠加链：按层序自底向上——videoLayers 靠后＝上层，后进 overlay 的盖在先进的上面。
  // enable 只控显示窗口；帧与时间线的对齐全靠上面 setpts 的偏移，两者都要。
  if (ev.videoLayers.length === 0) {
    filters.push("[base]null[vout]");
  } else {
    let main = "base";
    ev.videoLayers.forEach((layer, i) => {
      const k = inputOf.get(layer.clipId)!;
      const out = i === ev.videoLayers.length - 1 ? "vout" : `ov${i}`;
      filters.push(
        `[${main}][l${k}]overlay=x='(main_w-overlay_w)/2+${layer.x}':y='(main_h-overlay_h)/2+${layer.y}'` +
          `:eof_action=pass:enable='between(t,${secs(layer.timelineStartUs)},${secs(layer.timelineEndUs)})'[${out}]`,
      );
      main = out;
    });
  }

  // 音频链：单路直接当 aout；多路 amix（normalize=0 保音量、dropout_transition=0 防渐出）
  const hasAudioOut = ev.audioLayers.length > 0;
  if (ev.audioLayers.length === 1) {
    const layer = ev.audioLayers[0];
    const k = inputOf.get(layer.clipId)!;
    filters.push(`[${k}:a]${audioChain(layer)}[aout]`);
  } else if (ev.audioLayers.length > 1) {
    const labels = ev.audioLayers.map((layer) => {
      const k = inputOf.get(layer.clipId)!;
      const label = `a${k}`;
      filters.push(`[${k}:a]${audioChain(layer)}[${label}]`);
      return `[${label}]`;
    });
    filters.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0:dropout_transition=0[aout]`);
  }

  args.push("-filter_complex", filters.join(";"));
  args.push("-map", "[vout]");
  if (hasAudioOut) args.push("-map", "[aout]", "-c:a", "aac");
  else args.push("-an"); // 没有音频层：明确禁声，别让 ffmpeg 自作主张挑流
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(sequence.fps));
  args.push("-y", "-progress", "pipe:1", "-nostats", outPath);
  return args;
}
