import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  open: vi.fn(), probe: vi.fn(), addAssets: vi.fn(), begin: vi.fn(), release: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("./probe", () => ({ probeMedia: mocks.probe }));
vi.mock("../project/store", () => ({ useProjectStore: { getState: () => ({ addAssets: mocks.addAssets }) } }));
vi.mock("../project/projectSession", () => ({ beginProjectImport: mocks.begin }));
import { importAssets } from "./importAssets";

describe("import session", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.begin.mockReturnValue(mocks.release); });
  it("holds the session until probing and insertion finish", async () => {
    let resolve!: (value: unknown) => void;
    mocks.open.mockResolvedValue(["a.mp4"]);
    mocks.probe.mockReturnValue(new Promise((r) => { resolve = r; }));
    const importing = importAssets();
    await Promise.resolve();
    expect(mocks.release).not.toHaveBeenCalled();
    resolve({ kind: "video", durationUs: 1, width: 1, height: 1, fps: 1, hasAudio: false });
    await importing;
    expect(mocks.addAssets).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("releases the session when the dialog fails", async () => {
    mocks.open.mockRejectedValue(new Error("dialog failed"));
    await expect(importAssets()).rejects.toThrow("dialog failed");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("does not open a dialog while the project is busy", async () => {
    mocks.begin.mockReturnValue(null);
    expect(await importAssets()).toEqual([]);
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
