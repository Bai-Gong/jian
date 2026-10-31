/** 素材箱首帧：纯冶抽帧，经 asset URL 显示。并发共享 Promise，失败可重试。
 * 时间线连续缩略图使用 filmstrip.ts 的小图、可取消队列和有界缓存。 */
import { invoke } from "@tauri-apps/api/core";
import { useProjectStore } from "../project/store";
import { assetUrl } from "./assetUrl";

const cache = new Map<string, Promise<string>>();

function findAsset(assetId: string) {
  const asset = useProjectStore.getState().document.assets.find((a) => a.id === assetId);
  if (!asset) throw new Error(`素材不存在：${assetId}`);
  return asset;
}

/** 取指定时刻（微秒，缺省首帧）的缩略图 URL；素材不存在或冶抽帧失败时抛错。 */
export function getThumbnail(assetId: string, timeUs = 0): Promise<string> {
  const key = `${assetId}@${timeUs}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const job = (async () => {
    const asset = findAsset(assetId);
    // 命令返回 PNG 绝对路径，转成 <img> 可用的 asset URL。
    const framePath = await invoke<string>("extract_frame_ye", { path: asset.path, timeUs });
    return assetUrl(framePath);
  })();
  cache.set(key, job);
  job.catch(() => cache.delete(key)); // 失败不占缓存位
  return job;
}
