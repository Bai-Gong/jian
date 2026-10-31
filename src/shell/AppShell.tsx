import { DockHost, ThemeProvider } from "@baigong/fang";
import { useEffect } from "react";
import { loadRuntime } from "../core/media/runtime";
import "@baigong/fang/tokens.css";
import { AppTitleBar } from "./AppTitleBar";
import { MediaBinPanel } from "../features/media-bin/MediaBinPanel";
import { PreviewPanel } from "../features/preview/PreviewPanel";
import { TimelinePanel } from "../features/timeline/TimelinePanel";
import { InspectorPanel } from "../features/inspector/InspectorPanel";
import { useProjectStore } from "../core/project/store";

/**
 * 应用外壳：应用标题栏（菜单＋窗口三键，无系统装饰）+ 三列停靠（fang DockHost）。
 * 布局对应产品分析的四区：左＝素材池，中上＝节目预览器，中下＝时间线，右＝效果控件。
 * 源监视器（产品分析左上区）M1 随打点功能落地，先并入预览器面板。
 */
export function AppShell() {
  useEffect(()=>{void loadRuntime();},[]);
  const exportError=useProjectStore((s)=>s.exportState.error);
  return (
    <ThemeProvider>
      <div className="app-shell">
        <AppTitleBar />
        {exportError && <details open style={{padding:8,maxHeight:180,overflow:"auto"}}><summary>导出未完成</summary><pre style={{whiteSpace:"pre-wrap"}}>{exportError}</pre><button type="button" onClick={()=>useProjectStore.getState().setExportState({error:null})}>收起原因</button></details>}
        <DockHost
          left={<MediaBinPanel />}
          center={
            <div className="app-shell__center">
              <PreviewPanel />
              <TimelinePanel />
            </div>
          }
          right={<InspectorPanel />}
        />
      </div>
    </ThemeProvider>
  );
}
