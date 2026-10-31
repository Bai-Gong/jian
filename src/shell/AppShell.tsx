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

/** Photoshop 式工作区：文档与时间线居中，工具在左，属性/素材/图层停靠在右。 */
export function AppShell() {
  useEffect(()=>{void loadRuntime();},[]);
  const exportError=useProjectStore((s)=>s.exportState.error);
  const { panel, rightWidth, timelineHeight } = useWorkspace();
  return (
    <ThemeProvider>
      <div className="app-shell ps-workspace" style={{ "--right-width": `${rightWidth}px`, "--timeline-height": `${timelineHeight}px` } as CSSProperties}>
        <AppTitleBar />
        <ToolOptions />
        {exportError && <details className="export-errors" open><summary>导出未完成</summary><pre>{exportError}</pre><button type="button" onClick={()=>useProjectStore.getState().setExportState({error:null})}>收起原因</button></details>}
        <div className="workspace-body">
          <ToolRail />
          <main className="document-workspace" aria-label="文档工作区">
            <DocumentTab />
            <div className="document-view"><PreviewPanel /></div>
            <WorkspaceDivider direction="horizontal" />
            <div className="timeline-dock"><TimelinePanel /></div>
          </main>
          <WorkspaceDivider direction="vertical" />
          <aside className="panel-dock" aria-label="停靠面板">
            <div className="panel-dock__top">
              <div className="panel-tabs" role="tablist" aria-label="属性与素材">
                <button type="button" role="tab" id="properties-tab" aria-selected={panel === "properties"} aria-controls="properties-panel" onClick={() => useWorkspace.getState().setPanel("properties")}>属性</button>
                <button type="button" role="tab" id="assets-tab" aria-selected={panel === "assets"} aria-controls="assets-panel" onClick={() => useWorkspace.getState().setPanel("assets")}>素材</button>
              </div>
              <div id="properties-panel" role="tabpanel" aria-labelledby="properties-tab" hidden={panel !== "properties"}><InspectorPanel /></div>
              <div id="assets-panel" role="tabpanel" aria-labelledby="assets-tab" hidden={panel !== "assets"}><MediaBinPanel /></div>
            </div>
            <LayersPanel />
          </aside>
        </div>
        <WorkspaceStatus />
      </div>
    </ThemeProvider>
  );
}
