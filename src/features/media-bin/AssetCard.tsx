/**
 * 素材卡：缩略图（core/media getThumbnail 抽帧）＋文件名＋时长/分辨率＋种类角标。
 * 音频无画面，直接走图标占位不抽帧；抽帧失败降级为图标占位（不重试卡死 UI）。
 * 双击卡片＝插入到时间线（NLE 习惯），另有显式「插入」按钮兜底。
 */
import { useEffect, useState } from "react";
import { Film, Image as ImageIcon, Music } from "lucide-react";
import type { ComponentType } from "react";
import type { MediaAsset } from "../../core/project/types";
import { getThumbnail } from "../../core/media/thumbnail";
import { formatDurationLabel } from "../preview/timecode";

const KIND_LABEL: Record<MediaAsset["kind"], string> = { video: "视频", audio: "音频", image: "图片" };
const KIND_ICON: Record<MediaAsset["kind"], ComponentType<{ size?: number; className?: string }>> = {
  video: Film,
  audio: Music,
  image: ImageIcon,
};

/** 路径取文件名（Windows / POSIX 分隔符都认）。 */
export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** 卡片副文案：视频＝时长＋分辨率，音频＝时长，图片＝分辨率（图片零时长不显示秒数）。 */
function metaLine(asset: MediaAsset): string {
  const resolution = `${asset.width}×${asset.height}`;
  if (asset.kind === "audio") return formatDurationLabel(asset.durationUs);
  if (asset.kind === "image") return resolution;
  return `${formatDurationLabel(asset.durationUs)} · ${resolution}`;
}

interface AssetCardProps {
  asset: MediaAsset;
  onInsert: (assetId: string) => void;
}

export function AssetCard({ asset, onInsert }: AssetCardProps) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [thumbFailed, setThumbFailed] = useState(false);
  const KindIcon = KIND_ICON[asset.kind];

  useEffect(() => {
    setThumbUrl(null);
    setThumbFailed(false);
    if (asset.kind === "audio") return; // 音频无帧可抽，走图标占位
    let cancelled = false;
    getThumbnail(asset.id)
      .then((url) => {
        if (!cancelled) setThumbUrl(url);
      })
      .catch(() => {
        if (!cancelled) setThumbFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [asset.id, asset.kind]);

  return (
    <article className="media-card" onDoubleClick={() => onInsert(asset.id)} title="双击插入到时间线">
      <div className="media-card__thumb">
        {thumbUrl ? (
          <img className="media-card__img" src={thumbUrl} alt="" loading="lazy" />
        ) : (
          <KindIcon size={28} />
        )}
        {thumbFailed && <span className="media-card__thumb-note">缩略图不可用</span>}
        <span className="media-card__badge">{KIND_LABEL[asset.kind]}</span>
      </div>
      <div className="media-card__name" title={asset.path}>
        {basename(asset.path)}
      </div>
      <div className="media-card__meta">
        <span>{metaLine(asset)}</span>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => onInsert(asset.id)}
          onDoubleClick={(e) => e.stopPropagation()} /* 防双击冒泡到卡片造成重复插入 */
        >
          插入
        </button>
      </div>
    </article>
  );
}
