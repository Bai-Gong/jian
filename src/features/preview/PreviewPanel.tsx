/**
 * 节目预览器：M1 形态＝HTML5 video 元素池（开发方案 3.5）。
 *
 * DOM 契约（与 core/playback/VideoPool 对齐）：
 * - 本组件只提供舞台容器：aspect-ratio＝序列比、黑底（token）、position:relative；
 * - video 元素由池创建（object-fit:contain 自带 letterbox）、显隐与出声由池每帧切换；
 * - 挂载即 videoPool.mount(容器)，卸载 unmount——元素生命周期完全归池。
 * 走带条（TransportBar）贴在舞台下方，与本面板同生共死。
 */
import { useEffect, useRef } from "react";
import { DockPanel } from "@baigong/fang";
import { useProjectStore, selectActiveSequence } from "../../core/project/store";
import { videoPool } from "../../core/playback/VideoPool";
import { TransportBar } from "./TransportBar";

export function PreviewPanel() {
  const stageRef = useRef<HTMLDivElement>(null);
  // 序列画幅驱动舞台比例；取原始值避免播放中随 playhead 重渲染
  const width = useProjectStore((s) => selectActiveSequence(s).width);
  const height = useProjectStore((s) => selectActiveSequence(s).height);
  const hasAnyClip = useProjectStore((s) =>
    selectActiveSequence(s).tracks.some((t) => t.clips.length > 0),
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    videoPool.mount(stage);
    return () => videoPool.unmount();
  }, []);

  return (
    <DockPanel
      title="节目预览器"
      collapsed={false}
      className="preview-panel"
      style={{ flex: 1, minHeight: 0 }}
    >
      <div className="preview-body">
        <div className="preview-stage-wrap">
          <div
            ref={stageRef}
            className="preview-stage"
            style={{ aspectRatio: `${width} / ${height}` }}
          >
            {!hasAnyClip && <span className="preview-stage__empty">时间线暂无画面</span>}
          </div>
        </div>
        <TransportBar />
      </div>
    </DockPanel>
  );
}
