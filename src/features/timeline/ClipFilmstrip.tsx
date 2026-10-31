import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Clip, MediaAsset } from "../../core/project/types";
import { getFilmstripThumbnail } from "../../core/media/filmstrip";
import { filmstripCells, type FilmCell } from "./filmstripGeometry";

function FilmFrame({ path, assetId, cell }: { path: string; assetId: string; cell: FilmCell }) {
  const [result, setResult] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    setResult({});
    void getFilmstripThumbnail(path, cell.timeUs, controller.signal, assetId).then(
      (url) => { if (!controller.signal.aborted) setResult({ url }); },
      (error: unknown) => { if (!controller.signal.aborted) setResult({ error: String(error) }); },
    );
    return () => controller.abort();
  }, [path, assetId, cell.timeUs]);
  return <span className="timeline-filmstrip__cell" style={{ left: cell.left, width: cell.width }} title={result.error}>
    {result.url ? <img src={result.url} alt="" draggable={false} /> :
      <span className="timeline-filmstrip__placeholder">{result.error ? "缩略图不可用" : "…"}</span>}
  </span>;
}

export function ClipFilmstrip({ asset, clip, width, pxPerUs, scrollerEl }: {
  asset: MediaAsset; clip: Clip; width: number; pxPerUs: number; scrollerEl: HTMLDivElement | null;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, right: 0, height: 0 });
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || !scrollerEl) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const rect = el.getBoundingClientRect(), viewport = scrollerEl.getBoundingClientRect();
      const visible = rect.bottom > viewport.top && rect.top < viewport.bottom;
      const left = visible ? Math.max(0, viewport.left - rect.left - 80) : 0;
      const right = visible ? Math.min(width, viewport.right - rect.left + 80) : 0;
      setView((old) => old.left === left && old.right === right && old.height === rect.height ? old : { left, right, height: rect.height });
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(measure, 100); };
    measure();
    scrollerEl.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(el); observer.observe(scrollerEl);
    return () => { clearTimeout(timer); observer.disconnect(); scrollerEl.removeEventListener("scroll", schedule); };
  }, [scrollerEl, width, clip.timelineStartUs]);
  const ratio = asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 16 / 9;
  const cellWidth = Math.max(40, Math.min(180, Math.round(view.height * ratio)));
  const cells = filmstripCells({ width, cellWidth, left: view.left, right: view.right,
    sourceInUs: clip.sourceInUs, sourceOutUs: clip.sourceOutUs, speed: clip.speed, pxPerUs, fps: asset.fps });
  return <div ref={root} className="timeline-filmstrip" aria-label="视频片段连续缩略图">
    {cells.map((cell) => <FilmFrame key={`${asset.id}:${cell.left}:${cell.timeUs}`} assetId={asset.id} path={asset.path} cell={cell} />)}
  </div>;
}
