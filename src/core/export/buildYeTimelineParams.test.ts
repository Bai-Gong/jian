import { describe, expect, it } from "vitest";
import { frameRateRatio } from "./buildYeTimelineParams";
describe("timeline frame clock", () => {
  it("preserves NTSC and an explicitly rounded decimal as distinct rates", () => {
    expect(frameRateRatio(30000 / 1001)).toEqual([30000, 1001]);
    expect(frameRateRatio(29.97)).toEqual([2997, 100]);
    expect(frameRateRatio(24)).toEqual([24, 1]);
    expect(frameRateRatio(NaN)).toEqual([0, 1]);
  });
});

it("显式源流随独立音频片段进入导出，画面不会重复夹带伴音",async()=>{
 const {createClip,createTrack,createSequence}=await import("../project/factory");const {buildYeTimelineParams}=await import("./buildYeTimelineParams");
 const sequence=createSequence("测试"),v=createClip({assetId:"source",sourceInUs:0,sourceOutUs:1000000,timelineStartUs:0}),a={...v,id:"audio",sourceStreamIndex:4};v.audioDetached=true;
 const vt=createTrack("video"),at=createTrack("audio");vt.clips=[v];at.clips=[a];sequence.tracks=[vt,at];
 const asset={id:"source",path:"source.mp4",kind:"video" as const,durationUs:1000000,width:32,height:32,fps:30,hasAudio:true,videoCodec:"h264",audioCodec:"aac",sampleRate:48000,channels:2,addedAt:0};
 const params=buildYeTimelineParams(sequence,[asset]);expect(params.clips).toHaveLength(2);expect(params.clips[1]).toMatchObject({kind:"audio",streamIndex:4});
});
