# 百工·剪 (Jian)

视频剪辑工具，对标 Adobe Premiere。

属于「百工」项目集群，约定参见上级目录 [AGENTS.md](../AGENTS.md)。

## 状态

- **静态多轨接线已落地**（2026-10-31）：Tauri 2 + React，Canvas 多层画面＋WebView原生解码＋WebAudio独立片段音频；冶提供导入探测、抽帧、对齐波形及时间线导出。
- 技术选型与里程碑路线见 [docs/开发方案.md](docs/开发方案.md)；产品定位见 [docs/产品分析.md](docs/产品分析.md)。

## 开发

- 环境：Node 22+、Rust stable；包管理器一律 npm。
- 前置：同级目录的 fang 仓库需先 `npm install`（tsc 解析依赖，见开发方案 3.3）。
- 常用命令：`npm install` → `npm run tauri dev`（开发窗口）；`npm run build` + `cargo check`（本地门禁，与 CI 同链）。

## 门禁与对拍（M2 引擎接线后）

默认构建使用纯冶，不查找或执行 FFmpeg/ffprobe，不包含其二进制。当前素材范围：MP4/M4A、H.264 progressive 8-bit 4:2:0、AAC-LC 单/双声道。支持静态层序、中心偏移、等比缩放、顺时针旋转、透明度、黑场空隙、独立音轨、mute/solo、gain/pan。音频混合统一48kHz双声道；不做自动响度补偿。预览与导出均消费 evaluateSequence，预览继续使用原生媒体元素。

在预览画面拖动移动、Shift拖动缩放、Alt拖动旋转；精确值在属性面板输入。已有关键帧、变速、效果、转场、图片等数据保留，Rust预检汇总导出阻塞原因；不会静默扁平化。导出支持取消，失败和取消仅清理自有临时文件，已有目标文件拒绝覆盖。

`timeline_export` 集成测试生成参考素材后在空PATH子进程验收探测、抽帧、波形与两视频层＋两音轨导出。Windows 打包：`npm run package:windows`。开发兼容引擎须显式 `--features compat-ffmpeg`；兼容对拍命令为 `cargo test --manifest-path src-tauri/Cargo.toml --features compat-ffmpeg --test parity`。默认安装包不得加入开发工具资源。

- **四件套**（本地门禁，与 CI 同链 + 集成测试）：
  `cargo check --manifest-path src-tauri/Cargo.toml --locked` →
  `cargo test --manifest-path src-tauri/Cargo.toml --locked` →
  `npm test` → `npm run build`。
- **对拍测试**（`src-tauri/tests/parity.rs`，ye/docs/m2-jian-plan §3/§5 T8）：冻结向量上
  ye 轨与 ffmpeg 轨互证三组——抽帧（`decode_frame_rgba` vs `ffmpeg -ss` rawvideo，另有
  PNG 出口与无关音轨不阻塞视频抽帧）、波形（`waveform_peaks_ye` vs
  `waveform_peaks_ffmpeg` 逐桶峰值）、probe 双轨判等（含封面回退）。容差写死在文件
  顶部，POLICY_NOTE 只准收紧。
- **ffmpeg 定位口径**（与 ye 仓测试统一，§2.5）：① `BJ_FFMPEG_DIR`（须 ffmpeg+ffprobe
  双 exe 齐备）→ ② 系统 `PATH` → ③ 仓相对 `../../duan/src-tauri/binaries`（dev 机
  duan 落点）→ ④ 全落空：打印原因，对拍测试按分级语义合法跳过（定位器命中而向量
  生成失败＝测试失败，不许跳过）。CI安装外部基准工具并跑默认测试；本地兼容对拍须实跑
  全绿（把 duan 的 `src-tauri/binaries` 加进 PATH 即三档全中）。


## 当前工作区

界面采用 Photoshop 式整体排布：顶层菜单与上下文工具选项、左侧工具栏、中央文档标签和等比画布、右侧属性/素材标签与图层面板、底部时间线及状态栏。右侧宽度和时间线高度支持拖动或聚焦分隔条后用方向键调整；“窗口 → 重置工作区”恢复默认尺寸。

V 移动、T 缩放、R 旋转、H 抓手、Z 缩放视图。工具快捷键在文本输入期间不抢键。抓手与画布缩放仅改变视图；片段属性由工程模型管理。图层面板与时间线共用选择、静音、solo、锁定和删除操作，右侧素材列表仍使用实际导入及抽帧结果。未实现的绘图工具不显示。

插入视频时，画面与每条源音频分别成为视频/音频片段，起点保持对齐；一条立体声音频仍是一条轨。自动复用当前时段空闲且未锁定的同类轨道，需要时增加 V/A 轨道，不推挤已存在的片段。音频片段标明“音轨 1/2/…”，波形、预览和导出均使用同一个实际源流编号；视频不会再重复播放隐含伴音。旧工程缺少源流编号时仍保留原语义，多音轨歧义在执行前明确拒绝。

视频片段上方保留名称，下方以 Photoshop 式胶片条显示连续缩略图，音频轨显示波形。滚动只生成可见区域附近的画面，时间轴缩放、分割和裁剪后按源区间重新取样；分数帧率也不采到片段尾端以外。时间线小图由冶直接生成，尺寸不超过 192×96，不生成临时图片文件；前端最多同时抽取两帧，缓存最近 256 张，滚出视野后取消尚未开始的请求。失败单元格显示“缩略图不可用”，不借助 FFmpeg 回退。

多音轨预览只由冶重封装指定 AAC 流，再交给 WebView 原生解码；临时音轨按源文件状态缓存，并在应用正常退出时清理。`detached_audio` 验收五音轨身份、预览内容、波形及实际混音导出；`filmstrip` 用长 GOP/B 帧的红蓝色块验证不同时间的缩略图。私有录屏可显式运行 `cargo run --release --manifest-path src-tauri/Cargo.toml --example multitrack_recording -- <原片> <新输出目录>`，验证三处小图和原片前 0.5 秒的逐轨混音，不修改原片。
