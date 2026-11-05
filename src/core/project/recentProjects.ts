/** 最近打开的工程仅保存入口信息，不保存工程内容。存储不可用时仍可正常工作。 */
import { create } from "zustand";

export interface RecentProject {
  path: string;
  name: string;
  /** Unix 毫秒时间。 */
  lastOpenedAt: number;
}

export const RECENT_PROJECTS_STORAGE_KEY = "baigong-jian-recent-projects";
const MAX_RECENT_PROJECTS = 12;

function isRecentProject(value: unknown): value is RecentProject {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.path === "string" && entry.path.trim().length > 0
    && typeof entry.name === "string" && entry.name.trim().length > 0
    && typeof entry.lastOpenedAt === "number" && Number.isSafeInteger(entry.lastOpenedAt)
    && entry.lastOpenedAt >= 0 && entry.lastOpenedAt <= 8_640_000_000_000_000;
}

function normalize(entries: RecentProject[]): RecentProject[] {
  const seen = new Set<string>();
  return [...entries].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).filter((entry) => {
    if (seen.has(entry.path)) return false;
    seen.add(entry.path);
    return true;
  }).slice(0, MAX_RECENT_PROJECTS).map(({ path, name, lastOpenedAt }) => ({ path, name, lastOpenedAt }));
}

function readRecentProjects(): RecentProject[] {
  try {
    const raw = localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY);
    if (raw === null) return [];
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return [];
    const saved = data as Record<string, unknown>;
    if (saved.version !== 1 || !Array.isArray(saved.projects)) return [];
    return normalize(saved.projects.filter(isRecentProject));
  } catch {
    return [];
  }
}

function persistRecentProjects(recentProjects: RecentProject[]): void {
  try {
    localStorage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify({ version: 1, projects: recentProjects }));
  } catch {
    // 存储权限、容量或浏览器隐私设置不会影响打开和保存工程。
  }
}

export const useRecentProjects = create<{
  recentProjects: RecentProject[];
  removeRecent(path: string): void;
}>(() => ({
  recentProjects: readRecentProjects(),
  removeRecent: (path) => {
    const recentProjects = useRecentProjects.getState().recentProjects.filter((entry) => entry.path !== path);
    persistRecentProjects(recentProjects);
    useRecentProjects.setState({ recentProjects });
  },
}));

/** 仅在工程读取或写入成功后登记；重新打开同一路径更新名称和时间。 */
export function recordRecentProject(path: string, name: string): void {
  const filename = path.split(/[\\/]/).pop()?.replace(/\.jian$/i, "");
  const entry = { path, name: name.trim() || filename || "未命名工程", lastOpenedAt: Date.now() };
  if (!isRecentProject(entry)) return;
  const recentProjects = [entry, ...useRecentProjects.getState().recentProjects.filter((previous) => previous.path !== path)]
    .slice(0, MAX_RECENT_PROJECTS);
  persistRecentProjects(recentProjects);
  useRecentProjects.setState({ recentProjects });
}
