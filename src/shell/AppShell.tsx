import { DockHost, ThemeProvider } from "@baigong/fang";
import "@baigong/fang/tokens.css";
import { TopBar } from "./TopBar";
import { MediaBinPanel } from "../features/media-bin/MediaBinPanel";
import { PreviewPanel } from "../features/preview/PreviewPanel";
import { TimelinePanel } from "../features/timeline/TimelinePanel";
import { InspectorPanel } from "../features/inspector/InspectorPanel";

/**
 * 应用外壳：TopBar + 三列停靠（fang DockHost）。
 * 布局对应产品分析的四区：左＝素材池，中上＝节目预览器，中下＝时间线，右＝效果控件。
 * 源监视器（产品分析左上区）M1 随打点功能落地，先并入预览器面板。
 */
export function AppShell() {
  return (
    <ThemeProvider>
      <div className="app-shell">
        <TopBar />
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
