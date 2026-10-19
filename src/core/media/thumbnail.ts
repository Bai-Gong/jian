/**
 * 素材缩略图：Rust 侧 extract_frame 抽帧到临时 png，再转 asset URL 给 <img>。
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

/** 取某素材指定时刻（微秒，缺省首帧）的缩略图 URL。素材不在池中或抽帧失败时抛错。 */
export function getThumbnail(assetId: string, timeUs = 0): Promise<string> {
  const key = `${assetId}@${timeUs}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const job = (async () => {
    const asset = findAsset(assetId);
    // extract_frame 返回临时 png 的绝对路径，转成 <img> 可用的 asset URL
    const framePath = await invoke<string>("extract_frame", { path: asset.path, timeUs });
    return assetUrl(framePath);
  })();
  cache.set(key, job);
  job.catch(() => cache.delete(key)); // 失败不占缓存位
  return job;
}
