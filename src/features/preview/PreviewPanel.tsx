import { DockPanel } from "@baigong/fang";

/** 节目预览器：时间线合成结果预览（M1 交付）。 */
export function PreviewPanel() {
  return (
    <DockPanel title="节目预览器" collapsed={false} style={{ flex: 1, minHeight: 0 }}>
      <div className="preview-stage">
        <p className="panel-placeholder">预览画布（16:9）与播放控制 —— M1 交付。</p>
      </div>
    </DockPanel>
  );
}
