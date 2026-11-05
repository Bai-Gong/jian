import { describe, expect, it } from "vitest";
import { createClip, createInitialDocument } from "./factory";
import { parseProject, serializeProject } from "./projectFile";
import type { MediaAsset } from "./types";

function project() {
  const d = createInitialDocument();
  const asset: MediaAsset = { id: "asset", path: "/tmp/a.mov", kind: "video", durationUs: 1000000, width: 1920, height: 1080, fps: 30, hasAudio: false, videoCodec: "h264", audioCodec: "", sampleRate: 0, channels: 0, addedAt: 1 };
  d.assets.push(asset);
  const clip = createClip({ assetId: asset.id, sourceInUs: 0, sourceOutUs: 1000000, timelineStartUs: 0 });
  clip.speed = 1.5;
  clip.effects.push({ id: "fx", effectId: "unknown-effect", enabled: true, params: { amount: { kind: "keyframed", keyframes: [{ tUs: 10, value: 0.5, easing: "linear" }] } } });
  d.sequences[0].tracks[0].clips.push(clip, { ...clip, id: "split", sourceInUs: 1.5, timelineStartUs: 2.5 });
  return d;
}

describe("project file", () => {
  it("round trips the complete document, including unknown effects and fractional split times", () => {
    const d = project();
    expect(parseProject(serializeProject(d))).toEqual(d);
  });
  it("rejects malformed JSON, unknown envelopes and dangling references", () => {
    expect(() => parseProject("{" )).toThrow();
    const envelope = JSON.parse(serializeProject(project()));
    envelope.version = 999;
    expect(() => parseProject(JSON.stringify(envelope))).toThrow();
    envelope.version = 1;
    envelope.document.sequences[0].tracks[0].clips[0].assetId = "missing";
    expect(() => parseProject(JSON.stringify(envelope))).toThrow(/引用不存在/);
  });
  it("rejects duplicate IDs and non-finite or invalid ranges before writing", () => {
    const d = project();
    d.sequences[0].tracks[0].clips[1].id = d.sequences[0].tracks[0].clips[0].id;
    expect(() => serializeProject(d)).toThrow(/重复/);
    d.sequences[0].tracks[0].clips[1].id = "other";
    d.sequences[0].tracks[0].clips[0].speed = NaN;
    expect(() => serializeProject(d)).toThrow();
    d.sequences[0].tracks[0].clips[0].speed = -1;
    expect(() => serializeProject(d)).toThrow();
    d.sequences[0].tracks[0].clips[0].speed = Number.MIN_VALUE;
    expect(() => serializeProject(d)).toThrow(/时间线超出范围/);
  });
});
