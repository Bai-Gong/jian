/**
 * 本地文件 → 可显示 URL 的唯一通道。
 * Tauri 的 asset 协议同源转换（convertFileSrc），video/img src 一律经此封装，
 * 界面不许直接拼 file://。
 */
import { convertFileSrc } from "@tauri-apps/api/core";

export function assetUrl(path: string): string {
  return convertFileSrc(path);
}
