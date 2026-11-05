import { beforeEach, describe, expect, it, vi } from "vitest";

let values: Map<string, string>;
let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.resetModules();
  values = new Map();
  storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
  };
  vi.stubGlobal("localStorage", storage);
});

const key = "baigong-jian-recent-projects";

describe("recent project persistence", () => {
  it("starts empty without persisting an active project and restores saved entries", async () => {
    const { useRecentProjects, recordRecentProject } = await import("./recentProjects");
    expect(useRecentProjects.getState().recentProjects).toEqual([]);
    recordRecentProject("/a.jian", "甲");
    const saved = JSON.parse(values.get(key)!);
    expect(saved).toEqual({ version: 1, projects: [{ path: "/a.jian", name: "甲", lastOpenedAt: expect.any(Number) }] });
    vi.resetModules();
    const restored = await import("./recentProjects");
    expect(restored.useRecentProjects.getState().recentProjects).toEqual(saved.projects);
  });

  it("deduplicates paths, refreshes names, caps at twelve, and persists removals", async () => {
    const { useRecentProjects, recordRecentProject } = await import("./recentProjects");
    for (let i = 0; i < 15; i += 1) recordRecentProject(`/project-${i}.jian`, `工程 ${i}`);
    expect(useRecentProjects.getState().recentProjects).toHaveLength(12);
    expect(useRecentProjects.getState().recentProjects[0].path).toBe("/project-14.jian");
    expect(useRecentProjects.getState().recentProjects[11]?.path).toBe("/project-3.jian");
    recordRecentProject("/project-3.jian", "已更新名称");
    expect(useRecentProjects.getState().recentProjects).toHaveLength(12);
    expect(useRecentProjects.getState().recentProjects[0]).toMatchObject({ path: "/project-3.jian", name: "已更新名称" });
    useRecentProjects.getState().removeRecent("/project-3.jian");
    expect(useRecentProjects.getState().recentProjects).toHaveLength(11);
    expect(JSON.parse(values.get(key)!).projects).toEqual(useRecentProjects.getState().recentProjects);
  });

  it.each(["{", "null", "[]", '{"version":2,"projects":[]}', '{"version":1,"projects":{}}'])(
    "ignores corrupt or unknown storage: %s", async (raw) => {
      values.set(key, raw);
      const { useRecentProjects } = await import("./recentProjects");
      expect(useRecentProjects.getState().recentProjects).toEqual([]);
    },
  );

  it("validates entries and normalizes persisted duplicates by most recent time", async () => {
    values.set(key, JSON.stringify({ version: 1, projects: [
      { path: "/a.jian", name: "旧名", lastOpenedAt: 1 },
      null,
      { path: " ", name: "空路径", lastOpenedAt: 2 },
      { path: "/b.jian", name: " ", lastOpenedAt: 2 },
      { path: "/c.jian", name: "坏时间", lastOpenedAt: "3" },
      { path: "/d.jian", name: "负数", lastOpenedAt: -1 },
      { path: "/huge.jian", name: "超出日期范围", lastOpenedAt: 1e300 },
      { path: "/range.jian", name: "超出日期范围", lastOpenedAt: 8_640_000_000_000_001 },
      { path: "/fraction.jian", name: "非整数毫秒", lastOpenedAt: 1.5 },
      { path: "/a.jian", name: "新名", lastOpenedAt: 4, hasProject: true },
      { path: "/e.jian", name: "另一个", lastOpenedAt: 3 },
    ] }));
    const { useRecentProjects } = await import("./recentProjects");
    expect(useRecentProjects.getState().recentProjects).toEqual([
      { path: "/a.jian", name: "新名", lastOpenedAt: 4 },
      { path: "/e.jian", name: "另一个", lastOpenedAt: 3 },
    ]);
  });

  it("keeps opening and removing usable when localStorage throws", async () => {
    storage.getItem.mockImplementation(() => { throw new Error("denied"); });
    storage.setItem.mockImplementation(() => { throw new Error("full"); });
    const { useRecentProjects, recordRecentProject } = await import("./recentProjects");
    expect(useRecentProjects.getState().recentProjects).toEqual([]);
    expect(() => recordRecentProject("/a.jian", "甲")).not.toThrow();
    expect(useRecentProjects.getState().recentProjects).toHaveLength(1);
    expect(() => useRecentProjects.getState().removeRecent("/a.jian")).not.toThrow();
    expect(useRecentProjects.getState().recentProjects).toEqual([]);
  });
});
