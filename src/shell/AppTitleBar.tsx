/**
 * 应用标题栏：坊 TitleBar（菜单栏＋窗口三键＋拖动区）＋剪的菜单与导出动作。
 *
 * 菜单（M1 首批）：文件＝导入素材 / 导出 MP4 / 退出；帮助＝关于。
 * 通用默认项（defaultMenus 的编辑/帮助模式）待撤销重做落地后接入。
 *
 * 导出流程（施工契约 §7，自原 TopBar 迁移）：save 对话框选 .mp4 → exportProject
 * （内部走 run_export 命令并转 export-progress 事件为 onProgress 回调）→ 导出中
 * 按钮禁用＋百分比，完成/失败出文本提示。
 */
import { useCallback, useMemo, useState } from "react";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { Download } from "lucide-react";
import { getWindowAdapter, TitleBar, type MenuEntry } from "@baigong/fang";
import { selectActiveSequence, useProjectStore } from "../core/project/store";
import { exportProject } from "../core/export/exportProject";
import { importAssets } from "../core/media/importAssets";

export function AppTitleBar() {
  const projectName = useProjectStore((s) => s.document.name);
  // 字符串是原始值，selector 等值比较天然去抖：画幅不变不重渲染
  const seqSummary = useProjectStore((s) => {
    const seq = selectActiveSequence(s);
    return `${seq.width}×${seq.height}@${seq.fps}`;
  });

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
      await exportProject(selectActiveSequence(state), state.document.assets, outPath, (p) => {
        // 进度事件按微秒对齐，换算百分比并钳 0–100
        const ratio = p.totalUs > 0 ? p.timeUs / p.totalUs : 0;
        setPercent(Math.max(0, Math.min(100, Math.round(ratio * 100))));
      });
      setMessage({ kind: "ok", text: `已导出：${outPath}` });
    } catch (err) {
      setMessage({ kind: "error", text: `导出失败：${err instanceof Error ? err.message : String(err)}` });
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
          { kind: "item", label: "导入素材…", onSelect: () => void importAssets() },
          { kind: "item", label: "导出 MP4…", disabled: phase === "exporting", onSelect: () => void onExport() },
          { kind: "separator" },
          { kind: "item", label: "退出", onSelect: () => void getWindowAdapter()?.close() },
        ],
      },
      { label: "帮助", items: [{ kind: "item", label: "关于 百工·剪", onSelect: onAbout }] },
    ],
    [phase, onExport, onAbout],
  );

  return (
    <TitleBar
      appName="百工·剪"
      menus={menus}
      center={
        <>
          <span className="top-bar__project">{projectName}</span>
          <span className="top-bar__seq" title="序列画幅与帧率">
            {seqSummary}
          </span>
        </>
      }
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
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void onExport()}
            disabled={phase === "exporting"}
          >
            <Download size={14} aria-hidden />
            {phase === "exporting" ? `导出中 ${percent}%` : "导出 MP4"}
          </button>
        </>
      }
    />
  );
}
