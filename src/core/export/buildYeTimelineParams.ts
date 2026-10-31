import { evaluateSequence, type LayerDesc } from "../composite/composite";
import type { MediaAsset, Sequence } from "../project/types";

/** Translate the editor's evaluator; capability decisions belong to Rust. */
export function buildYeTimelineParams(sequence: Sequence, assets: readonly MediaAsset[]) {
  const evaluated = evaluateSequence(sequence, assets);
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const window = (layer: LayerDesc) => ({
    path: byId.get(layer.assetId)?.path ?? "",
    sourceInUs: Math.round(layer.sourceInUs), sourceOutUs: Math.round(layer.sourceOutUs),
    timelineStartUs: Math.round(layer.timelineStartUs), timelineEndUs: Math.round(layer.timelineEndUs),
  });
  const [fpsNum, fpsDen] = frameRateRatio(sequence.fps);
  return {
    width: sequence.width, height: sequence.height, fpsNum, fpsDen,
    totalUs: Math.round(evaluated.durationUs),
    clips: [
      ...evaluated.videoLayers.map((layer, z) => ({ ...window(layer), kind: "video" as const,
        x: layer.x, y: layer.y, scale: layer.scale, rotation: layer.rotation, opacity: layer.opacity, z })),
      ...evaluated.audioLayers.map((layer) => ({ ...window(layer), kind: "audio" as const, gain: layer.gain, pan: layer.pan })),
    ],
    features: sequence.tracks.flatMap((track) => track.clips.map((clip) => ({
      label: clip.id, sourceKind: byId.get(clip.assetId)?.kind ?? "missing",
      speed: clip.speed,
      animated: [...Object.entries(clip.transform), ...Object.entries(clip.audio)]
        .filter(([, value]) => value.kind !== "static").map(([name]) => name),
      effects: clip.effects.length,
      transition: clip.inTransition !== null || clip.outTransition !== null,
    }))),
  };
}

/** Continued fractions retain NTSC values without treating 29.97 as 30000/1001. */
export function frameRateRatio(rate: number): [number, number] {
  if (!Number.isFinite(rate) || rate <= 0) return [0, 1];
  let x = rate, n0 = 0, n1 = 1, d0 = 1, d1 = 0;
  for (let i = 0; i < 24; i++) {
    const a = Math.floor(x), n = a * n1 + n0, d = a * d1 + d0;
    if (d > 1_000_000 || n > 2_147_483_647) break;
    [n0, n1, d0, d1] = [n1, n, d1, d];
    if (Math.abs(n / d - rate) < 1e-10) break;
    x = 1 / (x - a);
  }
  return [n1, d1 || 1];
}
