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
