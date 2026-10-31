import { invoke } from "@tauri-apps/api/core";
import type { MediaAsset } from "../project/types";
export interface AudioPreview { path:string; sourceOriginUs:number; validStartUs:number; validEndUs:number }
const pending=new Map<string,Promise<AudioPreview>>();
/** 每次导入独立缓存身份；Rust 再按源文件时间与大小检查缓存。 */
export function audioPreview(asset:MediaAsset,index:number):Promise<AudioPreview>{
 const key=`${asset.id}:${index}`,hit=pending.get(key);if(hit)return hit;
 const job=invoke<AudioPreview>("audio_stream_preview",{path:asset.path,streamIndex:index});pending.set(key,job);job.catch(()=>pending.delete(key));return job;
}
