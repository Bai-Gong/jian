import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { getFilmstripThumbnail } from "./filmstrip";
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
describe("visible filmstrip decode queue", () => {
  it("shares requests, limits concurrent decode to two and drops offscreen queued work", async () => {
    const decoders: ((bytes: number[]) => void)[] = [];
    vi.mocked(invoke).mockImplementation(() => new Promise(resolve => decoders.push(resolve as (b: number[]) => void)));
    const a = new AbortController(), b = new AbortController(), offscreen = new AbortController();
    const first = getFilmstripThumbnail("recording.mp4", 0, a.signal);
    const shared = getFilmstripThumbnail("recording.mp4", 0, b.signal);
    const second = getFilmstripThumbnail("recording.mp4", 1e6, b.signal);
    const dropped = getFilmstripThumbnail("recording.mp4", 2e6, offscreen.signal).catch(e => e.name);
    const third = getFilmstripThumbnail("recording.mp4", 3e6, b.signal);
    expect(invoke).toHaveBeenCalledTimes(2);
    offscreen.abort();
    expect(await dropped).toBe("AbortError");
    decoders[0]([137, 80, 78, 71]);
    expect(await first).toBe(await shared);
    await tick();
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenLastCalledWith("timeline_thumbnail", { path: "recording.mp4", timeUs: 3e6 });
    decoders[1]([1]); decoders[2]([2]);
    await Promise.all([second, third]); await tick();
    await getFilmstripThumbnail("recording.mp4", 0, b.signal);
    expect(invoke).toHaveBeenCalledTimes(3);
  });
  it("reports decode failure and allows retry without a fallback", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("damaged video");
    await expect(getFilmstripThumbnail("bad.mp4", 0, new AbortController().signal)).rejects.toBe("damaged video");
    await tick();
    vi.mocked(invoke).mockResolvedValueOnce([137, 80, 78, 71]);
    await expect(getFilmstripThumbnail("bad.mp4", 0, new AbortController().signal)).resolves.toMatch(/^data:image\/png;base64,/);
  });
  it("re-importing a replaced source does not reuse the earlier asset's pictures", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([1]).mockResolvedValueOnce([2]);
    const signal = new AbortController().signal;
    const old = await getFilmstripThumbnail("replace.mp4", 0, signal, "old-import");
    const current = await getFilmstripThumbnail("replace.mp4", 0, signal, "new-import");
    expect(current).not.toBe(old);
  });
});
