import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialDocument } from "./factory";
import { serializeProject } from "./projectFile";
import { readProjectFile, writeProjectFile, MAX_PROJECT_FILE_BYTES } from "./projectFileIO";

vi.mock("@tauri-apps/plugin-fs", () => ({ readTextFile: vi.fn(), writeTextFile: vi.fn(), stat: vi.fn(), rename: vi.fn(), remove: vi.fn() }));
import { readTextFile, writeTextFile, stat, rename, remove } from "@tauri-apps/plugin-fs";

beforeEach(() => vi.resetAllMocks());
describe("project file IO", () => {
  it("writes a sibling before replacing the destination", async () => {
    const doc = createInitialDocument();
    await writeProjectFile("/a/project.jian", doc);
    const [temp, text, options] = vi.mocked(writeTextFile).mock.calls[0];
    expect(temp).toMatch(/^\/a\/project\.jian\..+\.tmp$/);
    expect(text).toBe(serializeProject(doc));
    expect(options).toEqual({ createNew: true });
    expect(rename).toHaveBeenCalledWith(temp, "/a/project.jian");
    expect(remove).toHaveBeenCalledWith(temp);
  });
  it("does not replace the destination when writing fails", async () => {
    vi.mocked(writeTextFile).mockRejectedValueOnce(new Error("disk full"));
    await expect(writeProjectFile("/a/project.jian", createInitialDocument())).rejects.toThrow("disk full");
    expect(rename).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  it("cleans up its own temporary file when replacement fails", async () => {
    vi.mocked(rename).mockRejectedValueOnce(new Error("rename failed"));
    await expect(writeProjectFile("/a/project.jian", createInitialDocument())).rejects.toThrow("rename failed");
    expect(remove).toHaveBeenCalledWith(vi.mocked(writeTextFile).mock.calls[0][0]);
  });
  it("rejects oversized and invalid files", async () => {
    vi.mocked(stat).mockResolvedValueOnce({ size: MAX_PROJECT_FILE_BYTES + 1 } as Awaited<ReturnType<typeof stat>>);
    await expect(readProjectFile("/a/project.jian")).rejects.toThrow(/过大/);
    expect(readTextFile).not.toHaveBeenCalled();
    vi.mocked(stat).mockResolvedValueOnce({ size: 1 } as Awaited<ReturnType<typeof stat>>);
    vi.mocked(readTextFile).mockResolvedValueOnce("{");
    await expect(readProjectFile("/a/project.jian")).rejects.toThrow();
  });
});
