/**
 * 顶栏：应用标识＋工程名＋序列画幅信息；右侧＝导出入口（M1 唯一导出 UI）。
 *
 * 导出流程（施工契约 §7）：save 对话框选 .mp4 → exportProject（内部走 run_export
 * 命令并转 export-progress 事件为 onProgress 回调）→ 导出中按钮禁用＋百分比，
 * 完成/失败出文本提示。导出与预览消费同一 composite 求值（core/export 负责保证）。
 */
import { useState } from "react";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { Download } from "lucide-react";
import { selectActiveSequence, useProjectStore } from "../core/project/store";
import { exportProject } from "../core/export/exportProject";

type ExportPhase = "idle" | "exporting";

export function TopBar() {
  const projectName = useProjectStore((s) => s.document.name);
  // 字符串是原始值，selector 等值比较天然去抖：画幅不变不重渲染
  const seqSummary = useProjectStore((s) => {
    const seq = selectActiveSequence(s);
    return `${seq.width}×${seq.height}@${seq.fps}`;
  });

  const [phase, setPhase] = useState<ExportPhase>("idle");
  const [percent, setPercent] = useState(0);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const onExport = async () => {
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
  };

  return (
    <header className="top-bar">
      <span className="top-bar__app">百工·剪</span>
      <span className="top-bar__divider" aria-hidden="true" />
      <span className="top-bar__project">{projectName}</span>
      <span className="top-bar__seq" title="序列画幅与帧率">
        {seqSummary}
      </span>

      <div className="top-bar__actions">
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
      </div>
    </header>
  );
}
