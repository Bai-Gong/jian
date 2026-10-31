/** 应用菜单、冶自检状态与可取消的时间线导出。开发兼容引擎仅显式构建时可选。 */
import { useCallback, useMemo, useState } from "react";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { Download, Clapperboard } from "lucide-react";
import { useWorkspace } from "./workspace";
import { openWorkspaceAssets } from "./WorkspaceChrome";
import { getWindowAdapter, TitleBar, type MenuEntry } from "@baigong/fang";
import { selectActiveSequence, useProjectStore } from "../core/project/store";
import { exportProject,cancelExport,ExportCancelled } from "../core/export/exportProject";
import { useRuntimeStore } from "../core/media/runtime";

export function AppTitleBar() {
  const exporting = useProjectStore((s) => s.exportState.running);
  const engine = useProjectStore((s) => s.exportEngine);
  const legacyEngine = useProjectStore((s)=>s.legacyEngine);
  const setEngine = useProjectStore((s) => s.setExportEngine);
  const runtime = useRuntimeStore((s)=>s.info);
  const runtimeError = useRuntimeStore((s)=>s.error);

  const [phase, setPhase] = useState<"idle" | "exporting">("idle");
  const [percent, setPercent] = useState(0);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const onExport = useCallback(async () => {
    const outPath = await saveFileDialog({
      filters: [{ name: "MP4", extensions: ["mp4"] }],
    });
    if (!outPath) return; // 用户取消

    const state = useProjectStore.getState();
    setPhase("exporting");
    setPercent(0);
    setMessage(null);
    try {
      await exportProject(
        selectActiveSequence(state),
        state.document.assets,
        outPath,
        (p) => {
          // 进度事件按微秒对齐，换算百分比并钳 0–100
          const ratio = p.totalUs > 0 ? p.timeUs / p.totalUs : 0;
          setPercent(Math.max(0, Math.min(100, Math.round(ratio * 100))));
        },
        // 引擎取自 store（导出瞬间的最新选择；exportProject 的注入面）
        { getEngine: () => useRuntimeStore.getState().info?.compatFfmpeg ? useProjectStore.getState().exportEngine : "ye" },
      );
      setMessage({ kind: "ok", text: `已导出：${outPath}` });
    } catch (err) {
      setMessage(err instanceof ExportCancelled ? {kind:"ok",text:err.message}:{ kind: "error", text: `导出失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setPhase("idle");
    }
  }, []);

  const onAbout = useCallback(() => {
    setMessage({ kind: "ok", text: "百工·剪 v0.1.0 · 百工集群 · Tauri + React" });
  }, []);

  const menus = useMemo<MenuEntry[]>(
    () => [
      {
        label: "文件",
        items: [
          { kind: "item", label: "导入素材…", onSelect: () => void openWorkspaceAssets() },
          { kind: "item", label: "导出 MP4…", disabled: phase === "exporting", onSelect: () => void onExport() },
          { kind: "separator" },
          { kind: "item", label: "退出", onSelect: () => void getWindowAdapter()?.close() },
        ],
      },
      { label: "编辑", items: [
        { kind: "item", label: "选择全部片段", onSelect: () => { const s=useProjectStore.getState();s.setSelection(selectActiveSequence(s).tracks.flatMap(t=>t.clips.map(c=>c.id))); } },
        { kind: "item", label: "取消选择", onSelect: () => useProjectStore.getState().setSelection([]) },
        { kind: "separator" },
        { kind: "item", label: "删除选中片段", hint: "Del", onSelect: () => useProjectStore.getState().deleteSelected() },
      ] },
      { label: "序列", items: [
        { kind: "item", label: "新建视频轨道", onSelect: () => {useProjectStore.getState().addTrack("video");} },
        { kind: "item", label: "新建音频轨道", onSelect: () => {useProjectStore.getState().addTrack("audio");} },
        { kind: "item", label: "在播放头处分割", hint: "S", onSelect: () => useProjectStore.getState().splitAtPlayhead() },
      ] },
      { label: "视图", items: [
        { kind: "item", label: "适合窗口", onSelect: () => useWorkspace.getState().setZoom(null) },
        { kind: "item", label: "实际像素 100%", onSelect: () => useWorkspace.getState().setZoom(1) },
        { kind: "item", label: "放大", onSelect: () => {const s=useWorkspace.getState();s.setZoom(s.canvasScale*1.25);} },
        { kind: "item", label: "缩小", onSelect: () => {const s=useWorkspace.getState();s.setZoom(s.canvasScale/1.25);} },
      ] },
      { label: "窗口", items: [
        { kind: "item", label: "属性", onSelect: () => useWorkspace.getState().setPanel("properties") },
        { kind: "item", label: "素材", onSelect: () => useWorkspace.getState().setPanel("assets") },
        { kind: "separator" },
        { kind: "item", label: "重置工作区", onSelect: () => useWorkspace.getState().reset() },
      ] },
      { label: "帮助", items: [{ kind: "item", label: "关于 百工·剪", onSelect: onAbout }] },
    ],
    [phase, onExport, onAbout],
  );

  return (
    <TitleBar
      appName="百工·剪"
      appIcon={<Clapperboard size={15} />}
      className="workspace-menubar"
      style={{height:30,zIndex:30}}
      menus={menus}
      actions={
        <>
          {message && (
            <span
              className={`top-bar__export-msg${message.kind === "error" ? " top-bar__export-msg--error" : ""}`}
              title={message.text}
            >
              {message.text}
            </span>
          )}
          {runtime?.compatFfmpeg && <select
            className="top-bar__engine"
            value={runtime?.compatFfmpeg ? engine : "ye"}
            onChange={(e) => setEngine(e.target.value as "ffmpeg" | "ye")}
            disabled={exporting || phase === "exporting"}
            title="使用冶合成视频与混合音频；导出前列出不支持的内容"
            aria-label="导出引擎"
          >
            {runtime?.compatFfmpeg && <option value="ffmpeg">开发兼容：FFmpeg</option>}
            <option value="ye">引擎：ye（冶）</option>
          </select>}
          {phase==="exporting" && (!runtime?.compatFfmpeg || engine==="ye") && <button type="button" className="btn" onClick={()=>{void cancelExport().catch((err)=>setMessage({kind:"error",text:String(err)}));}}>取消导出</button>}
          {(runtimeError || (!runtime && "冶正在自检…")) && <span role="status">{runtimeError || "冶正在自检…"}</span>}
          {(engine==="ffmpeg" || legacyEngine==="ffmpeg") && !runtime?.compatFfmpeg && <span title="旧偏好已保留，当前构建使用冶">已切换到冶</span>}
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void onExport()}
            disabled={phase === "exporting" || !runtime}
          >
            <Download size={14} aria-hidden />
            {phase === "exporting" ? `导出中 ${percent}%` : "导出 MP4"}
          </button>
        </>
      }
    />
  );
}
