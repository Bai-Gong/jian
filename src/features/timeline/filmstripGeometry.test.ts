import { describe, expect, it } from "vitest";
import { filmstripCells } from "./filmstripGeometry";
const base = { width: 10000, cellWidth: 100, left: 0, right: 450,
  sourceInUs: 2e6, sourceOutUs: 102e6, speed: 1, pxPerUs: 0.0001, fps: 25 };
describe("timeline filmstrip sampling", () => {
  it("samples consecutive source pictures after the trim in point", () => {
    expect(filmstripCells(base).map(c => c.timeUs)).toEqual([2e6, 3e6, 4e6, 5e6, 6e6]);
  });
  it("only creates visible cells and keeps their times stable across scrolling", () => {
    const scrolled = filmstripCells({ ...base, left: 250, right: 450 });
    expect(scrolled).toEqual(filmstripCells(base).slice(2));
    expect(filmstripCells({ ...base, left: 10001, right: 11000 })).toEqual([]);
  });
  it("zoom and speed change time density; the exclusive end never gets sampled", () => {
    expect(filmstripCells({ ...base, pxPerUs: 0.0002 }).map(c => c.timeUs)).toEqual([2e6, 2480000, 3e6, 3480000, 4e6]);
    expect(filmstripCells({ ...base, speed: 2 }).map(c => c.timeUs)).toEqual([2e6, 4e6, 6e6, 8e6, 10e6]);
    const cells = filmstripCells({ ...base, width: 151, sourceInUs: 0, sourceOutUs: 1510000, fps: 30000 / 1001 });
    expect(cells).toHaveLength(2);
    expect(cells[1].width).toBe(51);
    expect(cells.every(c => c.timeUs < 1510000)).toBe(true);
    // Rounding a fractional frame boundary up would make first-PTS>=target
    // select the following frame instead (especially visible at clip ends).
    expect(filmstripCells({ ...base, sourceInUs: 0, sourceOutUs: 100100, width: 300,
      pxPerUs: 100 / (1e6 * 1001 / 30000), fps: 30000 / 1001 }).map(c => c.timeUs)).toEqual([0, 33366, 66733]);
    expect(filmstripCells({ ...base, width: 2, sourceInUs: 0, sourceOutUs: 100 })).toEqual([{ left: 0, width: 2, timeUs: 0 }]);
  });
});
