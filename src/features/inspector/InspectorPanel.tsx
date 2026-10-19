import { DockPanel } from "@baigong/fang";

/** 效果控件：选中对象的属性与效果参数（M2 交付）。 */
export function InspectorPanel() {
  return (
    <DockPanel title="效果控件" collapsed={false} style={{ flex: 1, minHeight: 0 }}>
      <p className="panel-placeholder">选中剪辑块的属性与效果参数 —— M2 交付。</p>
    </DockPanel>
  );
}
