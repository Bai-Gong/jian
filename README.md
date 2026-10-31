# 百工·剪 (Jian)

视频剪辑工具，对标 Adobe Premiere。

属于「百工」项目集群，约定参见上级目录 [AGENTS.md](../AGENTS.md)。

## 状态

- **M0 工程骨架已落地**（2026-10-19）：Tauri 2 + React 19，接入 @baigong/fang（alias 联调轨），四区界面占位就位。
- 技术选型与里程碑路线见 [docs/开发方案.md](docs/开发方案.md)；产品定位见 [docs/产品分析.md](docs/产品分析.md)。

## 开发

- 环境：Node 22+、Rust stable；包管理器一律 npm。
- 前置：同级目录的 fang 仓库需先 `npm install`（tsc 解析依赖，见开发方案 3.3）。
- 常用命令：`npm install` → `npm run tauri dev`（开发窗口）；`npm run build` + `cargo check`（本地门禁，与 CI 同链）。

## 门禁与对拍（M2 引擎接线后）

- **四件套**（本地门禁，与 CI 同链 + 集成测试）：
  `cargo check --manifest-path src-tauri/Cargo.toml --locked` →
  `cargo test --manifest-path src-tauri/Cargo.toml --locked` →
  `npm test` → `npm run build`。
- **对拍测试**（`src-tauri/tests/parity.rs`，ye/docs/m2-jian-plan §3/§5 T8）：冻结向量上
  ye 轨与 ffmpeg 轨互证三组——抽帧（`decode_frame_rgba` vs `ffmpeg -ss` rawvideo，另有
  PNG 出口与不可解音轨打回行为锁定）、波形（`waveform_peaks_ye` vs
  `waveform_peaks_ffmpeg` 逐桶峰值）、probe 双轨判等（含封面回退）。容差写死在文件
  顶部，POLICY_NOTE 只准收紧。
- **ffmpeg 定位口径**（与 ye 仓测试统一，§2.5）：① `BJ_FFMPEG_DIR`（须 ffmpeg+ffprobe
  双 exe 齐备）→ ② 系统 `PATH` → ③ 仓相对 `../../duan/src-tauri/binaries`（dev 机
  duan 落点）→ ④ 全落空：打印原因，对拍测试按分级语义合法跳过（定位器命中而向量
  生成失败＝测试失败，不许跳过）。CI 只跑 `cargo check` 不跑对拍；本地收口须实跑
  全绿（把 duan 的 `src-tauri/binaries` 加进 PATH 即三档全中）。
