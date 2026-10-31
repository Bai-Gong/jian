/** 按实际源流原子插入：视频独立，所有音轨与画面共同对齐；缺少空轨时自动加轨。 */
import { useWorkspace } from "../../shell/workspace";
import { selectActiveSequence, useProjectStore } from "../../core/project/store";
export function insertAssetAtPlayhead(assetId:string):void {
  const state=useProjectStore.getState();state.insertMedia(assetId,state.playheadUs);
  const tracks=selectActiveSequence(useProjectStore.getState()).tracks;
  const needed=tracks.reduce((n,t)=>n+t.height,92);
  if(typeof window!=="undefined")useWorkspace.setState(s=>({timelineHeight:Math.max(s.timelineHeight,Math.min(window.innerHeight*.55,needed))}));
}
