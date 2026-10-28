/**
 * ye 引擎的导出翻译（纯函数）：与 buildExportArgs 同一「求值入口唯一」的
 * 铁律——层序/音频成员/总时长一律取 evaluateSequence，本文件禁自行枚举轨道。
 * 目标不是 ffmpeg argv 而是 Rust 命令 run_export_ye 的入参（片段表 +
 * 输出参数面）。能力面之外的一律明确拒绝并给可操作的错误文案（不静默降级
 * ——静默忽略某个属性会让用户以为导出符合预览）。
 *
 * ye compose 合成泵（M4 首轮）的能力面 = **顺序拼接**（纯剪辑）：
 * 视频层按时间线排序后首尾相接（无重叠无空隙）、无变换/变速/透明度/
 * 效果/转场、素材 kind=video 且源 H.264、序列帧率为整数、画幅为偶数；
 * 音频只接「视频层各片段同窗口的自带音频」（全带或全不带，AAC 且
 * 采样率/声道全序列一致——probe 的 videoCodec/audioCodec/sampleRate/
 * channels 四字段即为此接入）。其余形态（变速/画中画/叠加/独立音轨/
 * 转场/非整数帧率等）→ 拒绝并指路 ffmpeg 引擎（duan buildYeTranscodeParams
 * 同款「能力面内如实翻译、面外明确拒绝」）。
 *
 * 质量面对标 ffmpeg 轨：CRF 固定 23（buildExportArgs 未显式传 -crf，
 * libx264 缺省即 23）；音频码率固定 128k（ffmpeg 轨 `-c:a aac` 未显式传
 * 码率，原生 aac 编码器缺省 ~128k——同量级）。
 */
import { evaluateSequence } from "../composite/composite";
import type { MediaAsset, Sequence } from "../project/types";

/** run_export_ye 的片段入参（serde camelCase 对齐 Rust SegmentArg）。 */
export interface YeExportSegment {
  path: string;
  trimInUs: number;
  trimOutUs: number;
}

/** 翻译结果：成功＝run_export_ye 的参数面；失败＝可直接展示的错误。 */
export type YeExportBuilt =
  | {
      ok: true;
      /** 有序片段表（视频层按时间线排序；speed=1 已校验，窗口即源内区间）。 */
      segments: YeExportSegment[];
      width: number;
      height: number;
      /** 输出帧率（num/den，首轮恒为整数帧率 den=1）。 */
      fpsNum: number;
      fpsDen: number;
      /** 基准 CRF（对标 ffmpeg 轨 libx264 缺省 23）。 */
      crf: number;
      /** 剥音轨（输出无音轨；参与片段全无自带音频时为 true）。 */
      stripAudio: boolean;
      /** 音频重编码码率 kbps（对标 ffmpeg 轨 -c:a aac 的缺省量级；stripAudio 时为 null）。 */
      audioBitrateKbps: number | null;
      /** 序列求值总时长（µs，进度兜底）。 */
      totalUs: number;
    }
  | { ok: false; error: string };

type Reject = { ok: false; error: string };

/** 视频源 codec 的 ye 解码面（M4 首轮：H.264；avc1 是 MP4 stsd 的同名异写）。 */
function isH264(codec: string): boolean {
  const name = codec.trim().toLowerCase();
  return name === "h264" || name === "avc1";
}

/**
 * 把求值结果 + 素材表翻译成 ye 引擎参数。
 * 接受面（首轮，逐项校验、首个违例即拒）：
 * 1. 序列画幅非零偶数、帧率为正整数；
 * 2. 转场：任一块挂有转场（含 null 之外的）即拒——ye 合成段间硬接；
 * 3. 每个视频层：素材 kind=video、源视频 h264、speed=1、scale=1、
 *    rotation=0、opacity=1、x=y=0、无效果（enabled 与否都拒——ye 轨
 *    不翻译效果，连禁用态一起拒绝才不与「预览=导出」的演进冲突）；
 * 4. 视频层按时间线排序后首尾相接：首块起点 0、相邻块首尾相等、
 *    末块终点 = 序列总时长（无重叠/空隙/尾部空隙）；
 * 5. 音频：参与层恰为「视频层中素材自带音频的块」（mute/solo 导致的
 *    部分缺员不可表达即拒）、gain=1、pan=0；素材 AAC、采样率>0、
 *    声道 1|2 且全序列一致；或全部视频素材均无音频 → 剥音轨。
 */
export function buildYeExportParams(
  sequence: Sequence,
  assets: readonly MediaAsset[],
): YeExportBuilt {
  // ① 序列参数
  if (!(sequence.width > 0) || !(sequence.height > 0)) {
    return { ok: false, error: `序列画幅须为正（当前 ${sequence.width}x${sequence.height}），请修正序列或用 ffmpeg 引擎` };
  }
  if (sequence.width % 2 !== 0 || sequence.height % 2 !== 0) {
    return { ok: false, error: `ye 引擎要求偶数画幅（H.264 4:2:0；当前 ${sequence.width}x${sequence.height}），请修正序列或用 ffmpeg 引擎` };
  }
  if (!Number.isInteger(sequence.fps) || sequence.fps < 1) {
    return { ok: false, error: `ye 引擎暂不支持非整数帧率（当前 ${sequence.fps}），请修正序列或用 ffmpeg 引擎` };
  }

  const ev = evaluateSequence(sequence, assets);
  if (ev.videoLayers.length === 0) {
    return { ok: false, error: "序列没有视频层，无从导出（ye 引擎只接视频拼接）" };
  }
  const assetById = new Map(assets.map((a) => [a.id, a] as const));

  // ② 转场：序列级扫描（LayerDesc 不携带转场，任何块挂转场即拒）
  for (const track of sequence.tracks) {
    for (const clip of track.clips) {
      if (clip.inTransition !== null || clip.outTransition !== null) {
        return { ok: false, error: "ye 引擎暂不支持转场（段间硬接），请移除转场或用 ffmpeg 引擎" };
      }
    }
  }

  // ③ 逐视频层的接受面
  for (const layer of ev.videoLayers) {
    const asset = assetById.get(layer.assetId);
    if (!asset) continue; // 求值已滤悬空，防御性兜底
    if (asset.kind !== "video") {
      return { ok: false, error: `ye 引擎只接视频素材拼接（检测到 ${asset.kind === "image" ? "图片" : "音频"}素材），请切回 ffmpeg 引擎` };
    }
    if (!isH264(asset.videoCodec)) {
      return { ok: false, error: `ye 引擎目前只解码 H.264 源（检测到 ${asset.videoCodec || "未知"}视频轨），请切回 ffmpeg 引擎` };
    }
    if (layer.speed !== 1) {
      return { ok: false, error: `ye 引擎暂不支持变速（speed=${layer.speed}），请重置速率或用 ffmpeg 引擎` };
    }
    if (layer.scale !== 1 || layer.rotation !== 0 || layer.opacity !== 1 || layer.x !== 0 || layer.y !== 0) {
      return { ok: false, error: "ye 引擎暂不支持画中画/叠加/旋转/透明度等空间变换（M4 首轮只接顺序拼接），请重置变换或用 ffmpeg 引擎" };
    }
    if (layer.effects.length > 0) {
      return { ok: false, error: "ye 引擎暂不支持效果滤镜（含禁用态——不翻译的属性不能假装没有），请移除效果或用 ffmpeg 引擎" };
    }
  }

  // ④ 首尾相接（按时间线排序）
  const ordered = [...ev.videoLayers].sort((a, b) => a.timelineStartUs - b.timelineStartUs);
  if (ordered[0].timelineStartUs !== 0) {
    return { ok: false, error: "ye 引擎要求视频层从时间线 0 起连续排列（检测到起始空隙），请消除空隙或用 ffmpeg 引擎" };
  }
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    if (cur.timelineStartUs !== prev.timelineEndUs) {
      return {
        ok: false,
        error:
          cur.timelineStartUs < prev.timelineEndUs
            ? "ye 引擎暂不支持画面叠加（检测到视频层重叠），请切回 ffmpeg 引擎"
            : "ye 引擎要求视频层首尾相接（检测到层间空隙），请消除空隙或用 ffmpeg 引擎",
      };
    }
  }
  if (ordered[ordered.length - 1].timelineEndUs !== ev.durationUs) {
    return { ok: false, error: "ye 引擎要求视频层覆盖到序列末尾（检测到尾部空隙——多半有更长的音频层），请修剪或用 ffmpeg 引擎" };
  }

  // ⑤ 音频接受面
  const audioCheck = checkAudioFace(ev, assetById);
  if (!audioCheck.ok) return audioCheck;

  return {
    ok: true,
    segments: ordered.map((layer) => {
      const asset = assetById.get(layer.assetId)!;
      return { path: asset.path, trimInUs: layer.sourceInUs, trimOutUs: layer.sourceOutUs };
    }),
    width: sequence.width,
    height: sequence.height,
    fpsNum: sequence.fps,
    fpsDen: 1,
    crf: 23, // 对标 ffmpeg 轨 libx264 缺省（未显式传 -crf 即 23）
    stripAudio: audioCheck.stripAudio,
    audioBitrateKbps: audioCheck.stripAudio ? null : 128, // 对标 -c:a aac 缺省量级
    totalUs: ev.durationUs,
  };
}

/** 音频接受面的裁决：全部片段自带音频（可混成一路）或全部不带（剥轨）。 */
function checkAudioFace(
  ev: ReturnType<typeof evaluateSequence>,
  assetById: ReadonlyMap<string, MediaAsset>,
): Reject | { ok: true; stripAudio: boolean } {
  const videoLayers = ev.videoLayers;
  const withAudio = videoLayers.filter((l) => assetById.get(l.assetId)?.hasAudio === true);
  const audioLayers = ev.audioLayers;

  if (audioLayers.length === 0) {
    if (withAudio.length > 0) {
      // 有素材自带音频但音频层为空 = mute/solo 全部压掉了：部分静音不可表达
      return {
        ok: false,
        error: "ye 引擎暂不支持片段级静音/独奏（音频要么全带要么全剥），请解除静音或用 ffmpeg 引擎",
      };
    }
    return { ok: true, stripAudio: true };
  }

  // 音频层成员必须恰为「视频层中自带音频的块」（独立音轨层/静音缺员都拒）
  const expectedIds = new Set(withAudio.map((l) => l.clipId));
  const actualIds = new Set(audioLayers.map((l) => l.clipId));
  if (expectedIds.size !== actualIds.size || [...expectedIds].some((id) => !actualIds.has(id))) {
    return {
      ok: false,
      error: "ye 引擎只接视频片段自带的同窗音频（检测到独立音轨或被静音的片段伴音），请切回 ffmpeg 引擎",
    };
  }
  for (const layer of audioLayers) {
    if (layer.gain !== 1) {
      return { ok: false, error: `ye 引擎暂不支持音频增益（gain=${layer.gain}），请重置增益或用 ffmpeg 引擎` };
    }
    if (layer.pan !== 0) {
      return { ok: false, error: `ye 引擎暂不支持声像（pan=${layer.pan}），请重置声像或用 ffmpeg 引擎` };
    }
  }

  // 素材侧参数：AAC + 采样率/声道一致（probe 四字段）
  let sampleRate: number | null = null;
  let channels: number | null = null;
  for (const layer of withAudio) {
    const asset = assetById.get(layer.assetId)!;
    if (asset.audioCodec.toLowerCase() !== "aac") {
      return { ok: false, error: `ye 引擎目前只解码 AAC 音频源（检测到 ${asset.audioCodec || "未知"}），请切回 ffmpeg 引擎` };
    }
    if (!(asset.sampleRate > 0) || !(asset.channels > 0)) {
      return { ok: false, error: "素材音频参数未知（采样率/声道缺失），无法校验 ye 导出（请切回 ffmpeg 引擎）" };
    }
    if (asset.channels !== 1 && asset.channels !== 2) {
      return { ok: false, error: `ye 引擎只接单/双声道音频（检测到 ${asset.channels} 声道），请切回 ffmpeg 引擎` };
    }
    if (sampleRate === null) {
      sampleRate = asset.sampleRate;
      channels = asset.channels;
    } else if (asset.sampleRate !== sampleRate || asset.channels !== channels) {
      return {
        ok: false,
        error: `ye 引擎要求全序列音频参数一致（检测到 ${asset.sampleRate}Hz×${asset.channels}ch ≠ ${sampleRate}Hz×${channels}ch，无重采样器），请切回 ffmpeg 引擎`,
      };
    }
  }
  return { ok: true, stripAudio: false };
}
