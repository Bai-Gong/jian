import { create } from "zustand";

export type CanvasTool = "move" | "scale" | "rotate" | "hand" | "zoom";
export const TOOL_NAMES: Record<CanvasTool, string> = {
  move: "移动", scale: "缩放", rotate: "旋转", hand: "抓手", zoom: "缩放视图",
};
interface WorkspaceState {
  tool: CanvasTool;
  panel: "properties" | "assets";
  zoom: number | null;
  canvasScale: number;
  pan: { x: number; y: number };
  controls: boolean;
  rightWidth: number;
  timelineHeight: number;
  setTool(tool: CanvasTool): void;
  setPanel(panel: WorkspaceState["panel"]): void;
  setZoom(zoom: number | null): void;
  reset(): void;
}
const defaults = {
  tool: "move" as CanvasTool, panel: "properties" as const,
  zoom: null, canvasScale: 1, pan: { x: 0, y: 0 }, controls: true,
  rightWidth: 316, timelineHeight: 270,
};
export const useWorkspace = create<WorkspaceState>((set) => ({
  ...defaults,
  setTool: (tool) => set({ tool }),
  setPanel: (panel) => set({ panel }),
  setZoom: (zoom) => set({ zoom: zoom === null ? null : Math.max(0.05, Math.min(4, zoom)), pan: { x: 0, y: 0 } }),
  reset: () => set(defaults),
}));
