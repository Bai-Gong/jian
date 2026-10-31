import { invoke } from "@tauri-apps/api/core";

// Small PNG data URLs need no temporary files or object-URL lifetime management.
const cache = new Map<string, string>();
interface Waiter { resolve: (url: string) => void; reject: (error: unknown) => void }
interface Job { key: string; path: string; timeUs: number; waiters: Set<Waiter> }
const pending = new Map<string, Job>();
const queue: Job[] = [];
let active = 0;
const MAX_ACTIVE = 2, MAX_CACHED = 256;
function abortError() { return new DOMException("缩略图请求已取消", "AbortError"); }
function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const job = queue.shift()!;
    if (!job.waiters.size) { pending.delete(job.key); continue; }
    active++;
    void invoke<number[]>("timeline_thumbnail", { path: job.path, timeUs: job.timeUs }).then((bytes) => {
      let binary = "";
      for (let n = 0; n < bytes.length; n += 8192) binary += String.fromCharCode(...bytes.slice(n, n + 8192));
      const url = `data:image/png;base64,${btoa(binary)}`;
      cache.set(job.key, url);
      if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
      for (const waiter of job.waiters) waiter.resolve(url);
    }).catch((error: unknown) => {
      for (const waiter of job.waiters) waiter.reject(error);
    }).finally(() => { pending.delete(job.key); active--; pump(); });
  }
}

/** Share visible requests; discard queued work as soon as all its cells scroll away. */
export function getFilmstripThumbnail(path: string, timeUs: number, signal: AbortSignal, assetId = path): Promise<string> {
  if (signal.aborted) return Promise.reject(abortError());
  const key = JSON.stringify([assetId, path, timeUs]);
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return Promise.resolve(hit); }
  let job = pending.get(key);
  if (!job) { job = { key, path, timeUs, waiters: new Set() }; pending.set(key, job); queue.push(job); }
  const selected = job;
  return new Promise<string>((resolve, reject) => {
    const finish = () => { selected.waiters.delete(waiter); signal.removeEventListener("abort", abort); };
    const waiter: Waiter = {
      resolve: (url) => { finish(); resolve(url); }, reject: (error) => { finish(); reject(error); },
    };
    const abort = () => { finish(); reject(abortError()); };
    selected.waiters.add(waiter);
    signal.addEventListener("abort", abort, { once: true });
    pump();
  });
}
