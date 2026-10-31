/**
 * 素材池面板：导入按钮（plugin-dialog 多选，探测入池）＋素材卡列表＋插入到时间线。
 * 导入流程整体在 core/media/importAssets（对话框→并发 probe→store.addAssets），
 * 本面板只管按钮状态与列表渲染；导入中禁用按钮防重复弹窗。
 */
import { useCallback, useState } from "react";
import { DockPanel, ScrollArea } from "@baigong/fang";
import { Upload } from "lucide-react";
import { useProjectStore } from "../../core/project/store";
import { importAssets } from "../../core/media/importAssets";
import { AssetCard } from "./AssetCard";
import { insertAssetAtPlayhead } from "./insertToTimeline";

export function MediaBinPanel() {
  const assets = useProjectStore((s) => s.document.assets);
  const [importing, setImporting] = useState(false);

  const onImport = async () => {
    setImporting(true);
    try {
      await importAssets(); // 取消/单个失败已在 core 层吞掉，这里不追加提示
    } finally {
      setImporting(false);
    }
  };

  const onInsert = useCallback((assetId: string) => insertAssetAtPlayhead(assetId), []);

  return (
    <DockPanel
      title="素材池"
      collapsed={false}
      className="media-bin-panel"
      style={{ flex: 1, minHeight: 0 }}
    >
      <div className="media-bin">
        <div className="media-bin__toolbar">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void onImport()}
            disabled={importing}
          >
            <Upload size={14} aria-hidden />
            {importing ? "导入中…" : "导入素材"}
          </button>
        </div>
        {assets.length === 0 ? (
          <p className="panel-placeholder">
            素材池为空——点「导入素材」选择 MP4 / M4A 视频或音频，双击卡片即可插入时间线。
          </p>
        ) : (
          <ScrollArea orientation="vertical" className="media-bin__list">
            <div className="media-bin__cards">
              {assets.map((asset) => (
                <AssetCard key={asset.id} asset={asset} onInsert={onInsert} />
              ))}
            </div>
          </ScrollArea>
        )}
      </div>
    </DockPanel>
  );
}
