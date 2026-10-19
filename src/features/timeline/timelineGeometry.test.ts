/**
 * 时间线几何纯函数测试：缩放钳制、刻度档自适应、时间码标注、拖动吸附。
 */
import { describe, expect, it } from "vitest";
import {
  clampPxPerUs,
  findSnapOffset,
  formatRulerLabel,
  pickRulerStep,
  SNAP_THRESHOLD_PX,
  zoomPxPerUs,
  DEFAULT_PX_PER_US,
  MAX_PX_PER_US,
  MIN_PX_PER_US,
} from "./timelineGeometry";

const FPS = 30;
const SECOND_US = 1_000_000;

describe("clampPxPerUs / zoomPxPerUs", () => {
  it("默认值 100px/s，钳制到上下限内", () => {
    expect(DEFAULT_PX_PER_US).toBe(1e-4);
    expect(clampPxPerUs(1)).toBe(MAX_PX_PER_US);
    expect(clampPxPerUs(1e-9)).toBe(MIN_PX_PER_US);
    expect(clampPxPerUs(5e-4)).toBe(5e-4);
  });

  it("deltaY<0 放大、>0 缩小，边界处不再变化", () => {
    expect(zoomPxPerUs(1e-4, -100)).toBeGreaterThan(1e-4);
    expect(zoomPxPerUs(1e-4, 100)).toBeLessThan(1e-4);
    expect(zoomPxPerUs(MAX_PX_PER_US, -100)).toBe(MAX_PX_PER_US);
    expect(zoomPxPerUs(MIN_PX_PER_US, 100)).toBe(MIN_PX_PER_US);
  });
});

describe("pickRulerStep（帧/秒/分自适应）", () => {
  it("极高缩放（单帧 ≥64px）落帧档", () => {
    const pxPerUs = 64 / (SECOND_US / FPS); // 一帧正好 64px
    const step = pickRulerStep(pxPerUs, FPS);
    expect(step.tier).toBe("frame");
    expect(step.stepUs).toBeGreaterThan(0);
  });

  it("默认缩放（100px/s）落秒档", () => {
    const step = pickRulerStep(DEFAULT_PX_PER_US, FPS);
    expect(step.tier).toBe("second");
    expect(step.stepUs).toBe(SECOND_US); // 1s 间距 = 100px ≥ 64px
  });

  it("极低缩放升到分档，且次刻度不比主刻度细于屏显 9px", () => {
    const step = pickRulerStep(MIN_PX_PER_US, FPS);
    expect(step.tier).toBe("minute");
    expect(step.minorUs * MIN_PX_PER_US).toBeGreaterThanOrEqual(9);
  });

  it("次刻度间距不大于主刻度", () => {
    for (const px of [MIN_PX_PER_US, 1e-5, DEFAULT_PX_PER_US, 1e-3, MAX_PX_PER_US]) {
      const step = pickRulerStep(px, FPS);
      expect(step.minorUs).toBeLessThanOrEqual(step.stepUs);
    }
  });
});

describe("formatRulerLabel", () => {
  it("帧档输出 MM:SS:FF，41 帧进位为 1 秒 11 帧", () => {
    expect(formatRulerLabel(0, "frame", FPS)).toBe("00:00:00");
    expect(formatRulerLabel((41 * SECOND_US) / FPS, "frame", FPS)).toBe("00:01:11");
  });

  it("秒/分档输出 MM:SS，满小时加 H: 前缀", () => {
    expect(formatRulerLabel(5 * SECOND_US, "second", FPS)).toBe("00:05");
    expect(formatRulerLabel(83 * SECOND_US, "minute", FPS)).toBe("01:23");
    expect(formatRulerLabel(3661 * SECOND_US, "second", FPS)).toBe("1:01:01");
  });
});

describe("findSnapOffset（8px 阈值吸附）", () => {
  const pxPerUs = DEFAULT_PX_PER_US; // 100px/s → 8px = 80ms
  const durationUs = 2 * SECOND_US;
  const edges = [0, 3 * SECOND_US, 10 * SECOND_US];

  it("起边命中：吸到块边缘", () => {
    const r = findSnapOffset(3 * SECOND_US - 40_000, durationUs, edges, pxPerUs, SNAP_THRESHOLD_PX);
    expect(r.startUs).toBe(3 * SECOND_US);
    expect(r.snappedEdgeUs).toBe(3 * SECOND_US);
  });

  it("终边命中：起点吸到 边缘−时长", () => {
    // 起点 960ms，终点 2.96s 距 3s 边 40ms → 起点吸到 1s
    const r = findSnapOffset(SECOND_US - 40_000, durationUs, edges, pxPerUs, SNAP_THRESHOLD_PX);
    expect(r.startUs).toBe(SECOND_US);
    expect(r.snappedEdgeUs).toBe(3 * SECOND_US);
  });

  it("阈值外不吸附，原样返回", () => {
    const r = findSnapOffset(3 * SECOND_US - 200_000, durationUs, edges, pxPerUs, SNAP_THRESHOLD_PX);
    expect(r.startUs).toBe(3 * SECOND_US - 200_000);
    expect(r.snappedEdgeUs).toBeNull();
  });

  it("起终两边都命中时取屏显距离更近的边", () => {
    // 起点 1.06s：距 1s 边 60ms；终点 3.06s 距 3.1s 边 40ms → 终边胜，起点吸到 1.1s
    const r = findSnapOffset(
      1.06 * SECOND_US,
      durationUs,
      [SECOND_US, 3.1 * SECOND_US],
      pxPerUs,
      SNAP_THRESHOLD_PX,
    );
    expect(r.startUs).toBeCloseTo(1.1 * SECOND_US, 4);
  });
});
