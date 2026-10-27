/**
 * 素材缩略图（双引擎，ye 优先）：ye 轨 extract_frame_ye 进程内抽帧到临时 png；
 * 失败（含 High/CABAC 等解码能力面外、不可解音轨打回）console.warn 后回退
 * ffmpeg 轨 extract_frame（oracle 与兜底，原样保留）。两轨同入参同返回形状
 * （临时 png 绝对路径），再转 asset URL 给 <img>。
 * 按 (assetId, timeUs) 缓存——同一素材卡反复渲染不重复抽帧；
 * 缓存存 Promise 而非结果，并发请求共享同一次抽帧；失败不缓存（下次重试）。
 */
import { invoke } from "@tauri-apps/api/core";
import { useProjectStore } from "../project/store";
import { assetUrl } from "./assetUrl";

const cache = new Map<string, Promise<string>>();

function findAsset(assetId: string) {
  const asset = useProjectStore.getState().document.assets.find((a) => a.id === assetId);
  if (!asset) throw new Error(`素材不存在：${assetId}`);
  return asset;
}

/** 取某素材指定时刻（微秒，缺省首帧）的缩略图 URL。素材不在池中或两轨抽帧均失败时抛错。 */
export function getThumbnail(assetId: string, timeUs = 0): Promise<string> {
  const key = `${assetId}@${timeUs}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const job = (async () => {
    const asset = findAsset(assetId);
    // 两轨返回的都是临时 png 的绝对路径，转成 <img> 可用的 asset URL
    let framePath: string;
    try {
      framePath = await invoke<string>("extract_frame_ye", { path: asset.path, timeUs });
    } catch (yeErr) {
      // 回退决策在前端：ye 轨任何 Err（能力面外等）都落 ffmpeg 轨，
      // warn 留在现场供排查；ffmpeg 轨再失败则整体抛出（不吞错）。
      console.warn("ye 抽帧失败，回退 ffmpeg 轨:", yeErr);
      framePath = await invoke<string>("extract_frame", { path: asset.path, timeUs });
    }
    return assetUrl(framePath);
  })();
  cache.set(key, job);
  job.catch(() => cache.delete(key)); // 失败不占缓存位
  return job;
}
