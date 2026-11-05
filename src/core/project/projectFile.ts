import type { ProjectDocument } from "./types";

export const PROJECT_EXTENSION = "jian";
const FORMAT = "baigong-jian-project";
const FILE_VERSION = 1;

type Obj = Record<string, unknown>;
function fail(path: string): never { throw new Error(`工程文件无效：${path}`); }
function obj(v: unknown, p: string): Obj {
  if (v === null || typeof v !== "object" || Array.isArray(v)) fail(p);
  return v as Obj;
}
function arr(v: unknown, p: string): unknown[] { if (!Array.isArray(v)) fail(p); return v; }
function str(v: unknown, p: string, nonempty = false): string {
  if (typeof v !== "string" || (nonempty && !v.trim())) fail(p); return v;
}
function bool(v: unknown, p: string): void { if (typeof v !== "boolean") fail(p); }
function num(v: unknown, p: string, min = -Infinity, max = Infinity, integer = false): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isSafeInteger(v))) fail(p);
  return v;
}
function choice(v: unknown, p: string, choices: readonly string[]): void {
  if (typeof v !== "string" || !choices.includes(v)) fail(p);
}
function anim(v: unknown, p: string, min = -Infinity, max = Infinity): void {
  const a = obj(v, p);
  if (a.kind === "static") num(a.value, `${p}.value`, min, max);
  else if (a.kind === "keyframed") for (const [i, raw] of arr(a.keyframes, `${p}.keyframes`).entries()) {
    const k = obj(raw, `${p}.keyframes[${i}]`);
    num(k.tUs, `${p}.keyframes[${i}].tUs`, 0, Infinity, true);
    num(k.value, `${p}.keyframes[${i}].value`, min, max);
    // Preserve easing values from newer effect implementations without interpreting them.
    str(k.easing, `${p}.keyframes[${i}].easing`, true);
  } else fail(`${p}.kind`);
}
function params(v: unknown, p: string): void {
  for (const [key, value] of Object.entries(obj(v, p))) anim(value, `${p}.${key}`);
}
function transition(v: unknown, p: string): void {
  if (v === null) return;
  const t = obj(v, p); str(t.transitionId, `${p}.transitionId`, true);
  num(t.durationUs, `${p}.durationUs`, 0, Infinity, true); params(t.params, `${p}.params`);
}
function validateDocument(value: unknown): asserts value is ProjectDocument {
  const d = obj(value, "document");
  if (d.version !== 2) fail("document.version");
  str(d.name, "document.name");
  const assets = new Set<string>(), sequences = new Set<string>(), tracks = new Set<string>(), clips = new Set<string>();
  const unique = (set: Set<string>, v: unknown, p: string) => { const id = str(v, p, true); if (set.has(id)) fail(`${p} 重复`); set.add(id); };
  for (const [i, raw] of arr(d.assets, "document.assets").entries()) {
    const p = `document.assets[${i}]`, a = obj(raw, p);
    unique(assets, a.id, `${p}.id`); str(a.path, `${p}.path`, true); choice(a.kind, `${p}.kind`, ["video", "audio", "image"]);
    for (const key of ["durationUs", "width", "height", "sampleRate", "channels", "addedAt"]) num(a[key], `${p}.${key}`, 0, Infinity, true);
    num(a.fps, `${p}.fps`, 0); bool(a.hasAudio, `${p}.hasAudio`);
    str(a.videoCodec, `${p}.videoCodec`); str(a.audioCodec, `${p}.audioCodec`);
    if (a.audioStreams !== undefined) {
      const indices = new Set<number>();
      for (const [j, rawStream] of arr(a.audioStreams, `${p}.audioStreams`).entries()) {
        const sp = `${p}.audioStreams[${j}]`, s = obj(rawStream, sp);
        const index = num(s.index, `${sp}.index`, 0, Infinity, true); if (indices.has(index)) fail(`${sp}.index 重复`); indices.add(index);
        str(s.name, `${sp}.name`); str(s.codec, `${sp}.codec`);
        for (const key of ["sampleRate", "channels"]) num(s[key], `${sp}.${key}`, 0, Infinity, true);
        for (const key of ["startUs", "endUs"]) num(s[key], `${sp}.${key}`, -Infinity, Infinity, true);
        if ((s.endUs as number) < (s.startUs as number)) fail(`${sp}.endUs`);
      }
    }
  }
  for (const [i, raw] of arr(d.sequences, "document.sequences").entries()) {
    const p = `document.sequences[${i}]`, s = obj(raw, p);
    unique(sequences, s.id, `${p}.id`); str(s.name, `${p}.name`);
    const fps = num(s.fps, `${p}.fps`, Number.MIN_VALUE);
    if (!Number.isFinite(1_000_000 / fps)) fail(`${p}.fps`);
    for (const key of ["width", "height"]) num(s[key], `${p}.${key}`, 1, Infinity, true);
    for (const [j, rawTrack] of arr(s.tracks, `${p}.tracks`).entries()) {
      const tp = `${p}.tracks[${j}]`, t = obj(rawTrack, tp);
      unique(tracks, t.id, `${tp}.id`); choice(t.kind, `${tp}.kind`, ["video", "audio"]); str(t.name, `${tp}.name`);
      for (const key of ["locked", "muted", "solo"]) bool(t[key], `${tp}.${key}`);
      num(t.height, `${tp}.height`, Number.MIN_VALUE);
      for (const [k, rawClip] of arr(t.clips, `${tp}.clips`).entries()) {
        const cp = `${tp}.clips[${k}]`, c = obj(rawClip, cp);
        unique(clips, c.id, `${cp}.id`); if (!assets.has(str(c.assetId, `${cp}.assetId`, true))) fail(`${cp}.assetId 引用不存在`);
        for (const key of ["timelineStartUs", "sourceInUs", "sourceOutUs"]) num(c[key], `${cp}.${key}`, 0);
        if ((c.sourceOutUs as number) <= (c.sourceInUs as number)) fail(`${cp}.sourceOutUs`);
        const speed = num(c.speed, `${cp}.speed`, Number.MIN_VALUE);
        const end = (c.timelineStartUs as number) + ((c.sourceOutUs as number) - (c.sourceInUs as number)) / speed;
        if (!Number.isFinite(end) || end > Number.MAX_SAFE_INTEGER) fail(`${cp}.speed 导致时间线超出范围`);
        if (c.sourceStreamIndex !== undefined) num(c.sourceStreamIndex, `${cp}.sourceStreamIndex`, 0, Infinity, true);
        if (c.audioDetached !== undefined) bool(c.audioDetached, `${cp}.audioDetached`);
        const transform = obj(c.transform, `${cp}.transform`), audio = obj(c.audio, `${cp}.audio`);
        for (const key of ["x", "y", "rotation"]) anim(transform[key], `${cp}.transform.${key}`);
        anim(transform.scale, `${cp}.transform.scale`, Number.MIN_VALUE); anim(transform.opacity, `${cp}.transform.opacity`, 0, 1);
        anim(audio.gain, `${cp}.audio.gain`, 0, 2); anim(audio.pan, `${cp}.audio.pan`, -1, 1);
        const effects = new Set<string>();
        for (const [n, rawEffect] of arr(c.effects, `${cp}.effects`).entries()) {
          const ep = `${cp}.effects[${n}]`, e = obj(rawEffect, ep);
          unique(effects, e.id, `${ep}.id`); str(e.effectId, `${ep}.effectId`, true); bool(e.enabled, `${ep}.enabled`); params(e.params, `${ep}.params`);
        }
        transition(c.inTransition, `${cp}.inTransition`); transition(c.outTransition, `${cp}.outTransition`);
      }
    }
  }
  if (!sequences.has(str(d.activeSequenceId, "document.activeSequenceId", true))) fail("document.activeSequenceId 引用不存在");
}

/** Serialize only after validation: JSON.stringify otherwise silently converts NaN/Infinity to null. */
export function serializeProject(document: ProjectDocument): string {
  validateDocument(document);
  return JSON.stringify({ format: FORMAT, version: FILE_VERSION, document }, null, 2) + "\n";
}

export function parseProject(text: string): ProjectDocument {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("工程文件不是有效的 JSON"); }
  const envelope = obj(parsed, "文件头");
  if (envelope.format !== FORMAT) fail("文件格式不受支持");
  if (envelope.version !== FILE_VERSION) fail("文件版本不受支持");
  validateDocument(envelope.document);
  return envelope.document;
}
