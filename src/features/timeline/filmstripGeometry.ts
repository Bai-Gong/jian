/** Visible film cells stay anchored to the clip, so scrolling never changes their source times. */
export interface FilmCell { left: number; width: number; timeUs: number }
export function filmstripCells(input: {
  width: number; cellWidth: number; left: number; right: number;
  sourceInUs: number; sourceOutUs: number; speed: number; pxPerUs: number; fps: number;
}): FilmCell[] {
  const { width, cellWidth, sourceInUs, sourceOutUs, speed, pxPerUs } = input;
  if (!(width > 0 && cellWidth > 0 && speed > 0 && pxPerUs > 0 && sourceOutUs > sourceInUs)) return [];
  const left = Math.max(0, input.left), right = Math.min(width, input.right);
  if (right <= left) return [];
  const fps = input.fps > 0 ? input.fps : 30;
  // The decoder selects the first frame at/after the requested time. Request a
  // frame boundary before the exclusive out point, including fractional rates.
  const lastFrame = Math.max(0, Math.floor((sourceOutUs - 1) * fps / 1e6));
  const cells: FilmCell[] = [];
  for (let n = Math.floor(left / cellWidth); n * cellWidth < right; n++) {
    const x = n * cellWidth;
    const sourceUs = sourceInUs + x / pxPerUs * speed;
    const frame = Math.min(lastFrame, Math.floor(sourceUs * fps / 1e6 + 1e-8));
    cells.push({ left: x, width: Math.min(cellWidth, width - x), timeUs: Math.max(0, Math.floor(frame * 1e6 / fps)) });
  }
  return cells;
}
