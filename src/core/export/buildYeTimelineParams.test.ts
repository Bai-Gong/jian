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
