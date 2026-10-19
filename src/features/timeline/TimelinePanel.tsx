import { DockPanel } from "@baigong/fang";

/** 时间线：多轨道编辑区（M1 单轨起步，M2 多轨）。 */
export function TimelinePanel() {
  return (
    <DockPanel title="时间线" collapsed={false} style={{ flex: "0 0 260px", minHeight: 0 }}>
      <p className="panel-placeholder">轨道、剪辑块、工具条（选择 / 剃刀）—— M1 交付。</p>
    </DockPanel>
  );
}
