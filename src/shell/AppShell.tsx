import { isTauri } from "@tauri-apps/api/core";
import { ThemeProvider } from "@baigong/fang";
import { useEffect, type CSSProperties } from "react";
import { loadRuntime } from "../core/media/runtime";
import "@baigong/fang/tokens.css";
import { AppTitleBar } from "./AppTitleBar";
import { MediaBinPanel } from "../features/media-bin/MediaBinPanel";
import { PreviewPanel } from "../features/preview/PreviewPanel";
import { TimelinePanel } from "../features/timeline/TimelinePanel";
import { InspectorPanel } from "../features/inspector/InspectorPanel";
import { useProjectStore } from "../core/project/store";
import { DocumentTab, LayersPanel, ToolOptions, ToolRail, WorkspaceDivider, WorkspaceStatus } from "./WorkspaceChrome";
import { useWorkspace } from "./workspace";
import "./workspace.css";
import "./glass.css";

/** 毛玻璃剪辑工作区：预览与时间线居中，属性和素材在右侧停靠。 */
export function AppShell() {
  useEffect(()=>{if (isTauri()) void loadRuntime();},[]);
  const exportError=useProjectStore((s)=>s.exportState.error);
  const panel = useWorkspace(s=>s.panel);
  const rightWidth = useWorkspace(s=>s.rightWidth);
  const timelineHeight = useWorkspace(s=>s.timelineHeight);
  return (
    <ThemeProvider>
      <div className="app-shell glass-workspace fang-glass-shell" style={{ "--right-width": `${rightWidth}px`, "--timeline-height": `${timelineHeight}px` } as CSSProperties}>
        <AppTitleBar />
        <ToolOptions />
        {exportError && <details className="export-errors" open><summary>导出未完成</summary><pre>{exportError}</pre><button type="button" onClick={()=>useProjectStore.getState().setExportState({error:null})}>收起原因</button></details>}
        <div className="editing-workspace">
          <div className="editing-top">
            <aside className="source-dock fang-glass-surface" aria-label="项目素材">
              <header className="section-caption"><strong>项目素材</strong><span>收集与整理</span></header>
              <MediaBinPanel />
            </aside>
            <main className="document-workspace fang-glass-surface" aria-label="节目预览">
              <DocumentTab />
              <div className="document-view"><PreviewPanel /></div>
            </main>
            <WorkspaceDivider direction="vertical" />
            <aside className="panel-dock" aria-label="检查器">
              <div className="panel-dock__top fang-glass-surface">
                <div className="panel-tabs" role="tablist" aria-label="片段与轨道">
                  <button type="button" role="tab" id="properties-tab" aria-selected={panel === "properties"} aria-controls="properties-panel" onClick={() => useWorkspace.getState().setPanel("properties")}>片段属性</button>
                  <button type="button" role="tab" id="tracks-tab" aria-selected={panel === "tracks"} aria-controls="tracks-panel" onClick={() => useWorkspace.getState().setPanel("tracks")}>轨道管理</button>
                </div>
                <div id="properties-panel" role="tabpanel" aria-labelledby="properties-tab" hidden={panel !== "properties"}><InspectorPanel /></div>
                <div id="tracks-panel" role="tabpanel" aria-labelledby="tracks-tab" hidden={panel !== "tracks"}><LayersPanel /></div>
              </div>
            </aside>
          </div>
          <WorkspaceDivider direction="horizontal" />
          <section className="editing-bottom" aria-label="时间线编辑">
            <ToolRail />
            <div className="timeline-dock fang-glass-surface"><TimelinePanel /></div>
          </section>
        </div>
        <WorkspaceStatus />
      </div>
    </ThemeProvider>
  );
}
