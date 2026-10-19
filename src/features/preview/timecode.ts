/**
 * 展示层时间换算：微秒 → 时间码 / 粗粒度秒文案。
 * 只服务 UI 文案，不进 core（core 一律裸微秒）。
 */

/** 补两位。 */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 时间码 HH:MM:SS:FF（帧号按序列 fps 换算，向下取整）。
 * fps 非法（≤0）时按 30 兜底，防止除零。
 */
export function formatTimecode(us: number, fps: number): string {
  const safeUs = Math.max(0, Math.round(us));
  const safeFps = fps > 0 ? fps : 30;
  const totalSeconds = Math.floor(safeUs / 1_000_000);
  const frame = Math.floor(((safeUs % 1_000_000) * safeFps) / 1_000_000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}:${pad2(frame)}`;
}

/** 粗粒度时长文案（素材卡等）：秒级显示，超过一分钟走 m:ss。 */
export function formatDurationLabel(us: number): string {
  const seconds = us / 1_000_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${pad2(s)}`;
}
