import { DockPanel } from "@baigong/fang";

/** 素材池：导入与素材管理（M1 交付）。 */
export function MediaBinPanel() {
  return (
    <DockPanel title="素材池" collapsed={false} style={{ flex: 1, minHeight: 0 }}>
      <p className="panel-placeholder">导入视频 / 音频 / 图片素材 —— M1 交付。</p>
    </DockPanel>
  );
}
