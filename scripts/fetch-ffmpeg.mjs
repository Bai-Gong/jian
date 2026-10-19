#!/usr/bin/env node
/**
 * 下载 FFmpeg（ffmpeg.exe + ffprobe.exe）到 src-tauri/binaries/，作打包 sidecar 用。
 *
 * Usage:
 *   node scripts/fetch-ffmpeg.mjs           # 两个 exe 已齐则跳过（幂等）
 *   node scripts/fetch-ffmpeg.mjs --force   # 强制重新下载并覆盖
 *
 * 来源：GitHub BtbN/FFmpeg-Builds 的 latest release（win64 gpl 完整构建 zip，非 shared）。
 * 解压用系统自带 tar（Windows 10+ 的 bsdtar 原生支持 zip）。
 * qa/release workflow 打包前应先调本脚本（开发方案 M1）。
 *
 * 注意：
 * - 只服务 Windows sidecar；mac/linux 走系统包管理器或 BJ_FFMPEG_DIR。
 * - M1 开发用系统 PATH 里的 ffmpeg，本脚本本次未实际运行验证，报错以实际输出为准。
 * - GitHub API 匿名限流 60 次/小时/IP，正常构建足够。
 */

import { execFile } from "node:child_process";
import { access, constants, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const RELEASE_API = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest";
const FORCE = process.argv.includes("--force");
const BINARIES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src-tauri",
  "binaries",
);

async function exists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** 在目录树里按文件名找一个文件，返回首个命中路径。 */
async function findFile(dir, name) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const hit = await findFile(p, name);
      if (hit) return hit;
    } else if (ent.name === name) {
      return p;
    }
  }
  return null;
}

async function main() {
  const ffmpegExe = path.join(BINARIES_DIR, "ffmpeg.exe");
  const ffprobeExe = path.join(BINARIES_DIR, "ffprobe.exe");
  if (!FORCE && (await exists(ffmpegExe)) && (await exists(ffprobeExe))) {
    console.log(`[fetch-ffmpeg] 已存在，跳过：${BINARIES_DIR}`);
    return;
  }
  await mkdir(BINARIES_DIR, { recursive: true });

  // 1. 查 latest release 的 win64 gpl zip
  console.log("[fetch-ffmpeg] 查询 BtbN/FFmpeg-Builds latest release …");
  const res = await fetch(RELEASE_API, {
    headers: { "User-Agent": "baigong-jian-fetch-ffmpeg" },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`);
  const release = await res.json();
  const asset = release.assets.find(
    (a) => a.name.endsWith(".zip") && a.name.includes("win64-gpl") && !a.name.includes("shared"),
  );
  if (!asset) throw new Error("release 里没找到 win64-gpl zip 资产");
  console.log(`[fetch-ffmpeg] 选中 ${asset.name}（${(asset.size / 1048576).toFixed(1)} MB）`);

  // 2. 下载 zip 到临时目录
  const tmpDir = path.join(BINARIES_DIR, ".download");
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  const zipPath = path.join(tmpDir, asset.name);
  console.log(`[fetch-ffmpeg] 下载 ${asset.browser_download_url} …`);
  const zipRes = await fetch(asset.browser_download_url);
  if (!zipRes.ok) throw new Error(`下载失败：HTTP ${zipRes.status}`);
  await writeFile(zipPath, Buffer.from(await zipRes.arrayBuffer()));

  // 3. tar 解 zip，从解出的目录树里捞两个 exe
  const extractDir = path.join(tmpDir, "x");
  await mkdir(extractDir, { recursive: true });
  await execFileAsync("tar", ["-xf", zipPath, "-C", extractDir]);
  const srcFfmpeg = await findFile(extractDir, "ffmpeg.exe");
  const srcFfprobe = await findFile(extractDir, "ffprobe.exe");
  if (!srcFfmpeg || !srcFfprobe) throw new Error("解压后找不到 ffmpeg.exe / ffprobe.exe");
  await cp(srcFfmpeg, ffmpegExe, { force: true });
  await cp(srcFfprobe, ffprobeExe, { force: true });

  // 4. 清理临时目录
  await rm(tmpDir, { recursive: true, force: true });
  console.log(`[fetch-ffmpeg] 完成：${ffmpegExe}`);
}

main().catch((err) => {
  console.error(`[fetch-ffmpeg] 失败：${err?.message ?? err}`);
  process.exitCode = 1;
});
