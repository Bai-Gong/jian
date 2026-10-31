//! M2 对拍收口集成测试（m2-jian-plan §3/§5 T8）：ye 轨与 ffmpeg 轨在
//! 冻结向量上互证，jian 双引擎接缝的最后一环。
//!
//! ## 三组对拍（向量配方 §3.1 写死，与 ye 侧 T3 同款全套）
//!
//! - **抽帧**：直调 [`ye::frame_grab::decode_frame_rgba`] vs `ffmpeg -ss`
//!   同点位 rawvideo（f∈{0,45,88} 逐像素）；另锁 ye 引擎 PNG 出口
//!   （[`jian_lib::ye_engine::extract_frame_ye_impl`] 出临时 png 的魔数/
//!   非空，§3.3 jian 侧口径——两段各自断言，不解码 PNG）与不可解音轨
//!   向量的整体打回行为（§2.2 行为锁定）。
//! - **波形**：分别直调 pub 双轨 [`jian_lib::waveform::waveform_peaks_ye`]
//!   与 [`waveform_peaks_ffmpeg`]（§2.3 拆分的接缝）同容差对拍，正弦/
//!   白噪声两向量都过（§3.2）。
//! - **probe**：`probe_media` 双轨判等——vec.mp4 两轨字段级判等（§3.4
//!   容差）、带封面 vec-cover.m4a 命中启发式整体回退且与显式 ffmpeg 轨
//!   完全一致、非 mp4 素材 auto 落 ffprobe 轨。
//!
//! ## ffmpeg 定位器（§2.5 两仓统一口径，与 ye 侧 tests/common/mod.rs 同序同名）
//!
//! ① `BJ_FFMPEG_DIR`（目录，ffmpeg+ffprobe 双 exe 齐备才认）→ ② 系统
//! `PATH`（两工具独立查找，ffmpeg 无 ffprobe 仍算落空）→ ③ 仓相对
//! `CARGO_MANIFEST_DIR/../../duan/src-tauri/binaries`（jian 测试视角的
//! duan binaries 落点）→ ④ 全落空：**打印原因**，依赖 ffmpeg 的测试
//! 按分级 skip 语义合法返回。
//!
//! ## skip 语义分级（§3.1，与 ye 侧同款）
//!
//! 定位器落空 → 本文件已打印原因，测试合法 skip（jian CI 不跑 cargo
//! test，本地收口必须实跑全绿并记录实测数字）；定位器命中而向量生成
//! 失败（ffmpeg 退出非零/输出未落盘）＝ panic（测试失败），**不许
//! skip**——失败侧不许假绿。
//!
//! POLICY_NOTE（沿 conformance README:129-136 与 ye-filter mod.rs 先例）：
//! 下述容差常量**只准收紧**——向更严方向修改免评审；任何放宽必须回
//! 施工图（m2-jian-plan §3）重新定口径。

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use jian_lib::probe::probe_media;
use jian_lib::waveform::{PeakBucket, waveform_peaks_ffmpeg, waveform_peaks_ye};
use jian_lib::ye_engine::extract_frame_ye_impl;
use ye::container::ReadSeek;
use ye::frame_grab::decode_frame_rgba;

// ---- 定位器（§2.5 统一口径；实现与 ye tests/common/mod.rs 同义） ----

/// exe 文件名（Windows 补 `.exe` 后缀）。
fn exe_name(tool: &str) -> String {
    if cfg!(windows) {
        format!("{tool}.exe")
    } else {
        tool.to_string()
    }
}

/// 目录内双 exe（ffmpeg+ffprobe）齐备才认（§2.5 ①③ 目录档语义）。
fn dir_has_both_tools(dir: &Path) -> bool {
    dir.join(exe_name("ffmpeg")).is_file() && dir.join(exe_name("ffprobe")).is_file()
}

/// `PATH` 中单工具查找（Windows 补 `.exe`；jian 生产侧 find_in_path 同义，
/// 单独使用不要求双全——双全约束只在目录档）。
fn find_in_path(tool: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = if cfg!(windows) {
            dir.join(format!("{tool}.exe"))
        } else {
            dir.join(tool)
        };
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// 定位 ffmpeg/ffprobe 可执行文件对（§2.5 顺序；全落空打印原因返回
/// `(None, None)`——ffprobe 随对解析：①③ 目录档与② PATH 档的「命中」
/// 都要求双工具在场，本文件只直接消费 ffmpeg 路径，ffprobe 由生产侧
/// ffmpeg_info 自行定位）。
fn resolve_tool_pair() -> (Option<PathBuf>, Option<PathBuf>) {
    // ① BJ_FFMPEG_DIR：双全才认。
    if let Some(dir) = std::env::var_os("BJ_FFMPEG_DIR").map(PathBuf::from) {
        if dir_has_both_tools(&dir) {
            return (
                Some(dir.join(exe_name("ffmpeg"))),
                Some(dir.join(exe_name("ffprobe"))),
            );
        }
        eprintln!(
            "parity: BJ_FFMPEG_DIR 已设但 ffmpeg/ffprobe 未双全（{}），转下一档",
            dir.display()
        );
    }
    // ② PATH：两工具独立查找。
    if let Some(ffmpeg) = find_in_path("ffmpeg") {
        return match find_in_path("ffprobe") {
            Some(ffprobe) => (Some(ffmpeg), Some(ffprobe)),
            None => {
                eprintln!(
                    "parity: PATH 有 ffmpeg（{}）但无 ffprobe，转下一档",
                    ffmpeg.display()
                );
                (None, None)
            }
        };
    }
    // ③ 仓相对：duan binaries（dev 机 ffmpeg 实际落点；jian 测试视角）。
    let repo_relative =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../duan/src-tauri/binaries");
    if dir_has_both_tools(&repo_relative) {
        return (
            Some(repo_relative.join(exe_name("ffmpeg"))),
            Some(repo_relative.join(exe_name("ffprobe"))),
        );
    }
    // ④ 全落空：打印原因（调用方按分级 skip 语义合法返回）。
    eprintln!(
        "parity: ffmpeg 定位三档全落空（BJ_FFMPEG_DIR 未设或未双全；PATH 无 ffmpeg+ffprobe；\
         仓相对 {} 不存在）——依赖 ffmpeg 的对拍测试按分级 skip 语义跳过",
        repo_relative.display()
    );
    (None, None)
}

/// 已解析的工具对（进程内缓存，落空原因只打印一次）。
fn tool_pair() -> &'static (Option<PathBuf>, Option<PathBuf>) {
    static PAIR: OnceLock<(Option<PathBuf>, Option<PathBuf>)> = OnceLock::new();
    PAIR.get_or_init(resolve_tool_pair)
}

/// ffmpeg 可执行文件全路径（定位失败返回 `None`，原因已打印）。
fn ffmpeg_exe() -> Option<PathBuf> {
    tool_pair().0.clone()
}

// ---- 向量配方（§3.1 冻结写死，与 ye 侧同款；仅追加 -v error 静音冗余日志） ----

/// 向量宽高（testsrc2 320x240）。
const W: u32 = 320;
const H: u32 = 240;

/// vec.mp4 配方（§3.1：testsrc2 3s 320x240 30fps，libx264 Baseline
/// yuv420p——ye H.264 只收 Baseline/CAVLC）。
const VEC_VIDEO_ARGS: &[&str] = &[
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=duration=3:size=320x240:rate=30",
    "-c:v",
    "libx264",
    "-profile:v",
    "baseline",
    "-pix_fmt",
    "yuv420p",
    "-y",
];

/// vec-audio.m4a 配方（§3.1：立体声 440Hz 正弦 48k、2s、AAC 128k，
/// `-aac_pns 0`——ye AAC 不支持 PNS，conformance 先例）。
const VEC_AUDIO_ARGS: &[&str] = &[
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=2",
    "-ac",
    "2",
    "-c:a",
    "aac",
    "-aac_pns",
    "0",
    "-b:a",
    "128k",
    "-y",
];

/// vec-noise.m4a 配方（§3.1：单声道白噪声 44.1k、2s、AAC 128k——rms 有
/// 区分度且对样本错位敏感，能暴露 edit list 口径错误；anoisesrc 未钉
/// 种子，内容逐次随机——两轨消费同一份生成文件，对拍不受影响）。
const VEC_NOISE_ARGS: &[&str] = &[
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "anoisesrc=color=white:sample_rate=44100:duration=2",
    "-ac",
    "1",
    "-c:a",
    "aac",
    "-aac_pns",
    "0",
    "-b:a",
    "128k",
    "-y",
];

/// cover.jpg 配方（§3.1：testsrc2 单帧 320x240——vec-cover 的封面原料，
/// 亦作「非 mp4 素材」probe 向量）。
const COVER_JPG_ARGS: &[&str] = &[
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x240:rate=1",
    "-frames:v",
    "1",
    "-y",
];

/// vec-video-multi.mp4 配方（§3.1：视频 + 440Hz 正弦 AAC **6 声道**——
/// ye AAC 拒多声道，作「不可解音轨」源）。
const VEC_MULTI_ARGS: &[&str] = &[
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=duration=3:size=320x240:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=3",
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "libx264",
    "-profile:v",
    "baseline",
    "-c:a",
    "aac",
    "-ac",
    "6",
    "-aac_pns",
    "0",
    "-y",
];

/// 向量临时文件路径（`CARGO_TARGET_TMPDIR` 唯一名：进程号 + 纳秒，
/// 并行测试无竞争；用后即删归调用方，仓库约定）。
fn tmp_path(tag: &str, ext: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "jian-parity-{tag}-{}-{nanos}.{ext}",
        std::process::id()
    ))
}

/// 跑 ffmpeg 生成一条向量（调用前置：定位器已命中）。任何失败（启动
/// 失败/退出非零/输出未落盘）＝ panic（测试失败），不许 skip——§3.1
/// 分级语义的失败侧。
fn run_ffmpeg_to(exe: &Path, args: &[OsString], out: &Path) {
    let status = Command::new(exe)
        .args(args)
        .arg(out)
        .status()
        .unwrap_or_else(|err| panic!("启动 ffmpeg 失败（{}）：{err}", exe.display()));
    assert!(
        status.success(),
        "ffmpeg 生成 {} 失败（退出码 {status:?}）——定位器已命中，生成失败不许 skip",
        out.display()
    );
    assert!(out.is_file(), "ffmpeg 报成功但未落盘：{}", out.display());
}

/// 就位一条单步向量：定位器命中 → 按配方生成并返回路径（**用后即删归
/// 调用方**）；定位器落空 → `None`（原因已打印，调用方合法 skip）。
#[must_use]
fn ensure_vector(name: &str, recipe_args: &[&str]) -> Option<PathBuf> {
    let exe = ffmpeg_exe()?;
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"));
    std::fs::create_dir_all(&dir).expect("CARGO_TARGET_TMPDIR 建目录");
    // 唯一后缀放在扩展名之前（ffmpeg 按扩展名推输出格式，mangle 扩展
    // 名会报 Unable to choose an output format——ye 侧同款坑）。
    let plain = Path::new(name);
    let stem = plain.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ext = plain
        .extension()
        .map_or_else(String::new, |e| format!(".{}", e.to_string_lossy()));
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = dir.join(format!(
        "jian-parity-{stem}-{}-{nanos}{ext}",
        std::process::id()
    ));
    let args: Vec<OsString> = recipe_args.iter().map(OsString::from).collect();
    run_ffmpeg_to(&exe, &args, &path);
    Some(path)
}

/// 就位带封面向量 vec-cover.m4a（§3.1 两步配方：先备 vec-audio.m4a 与
/// cover.jpg 原料，再 `-map 0:a -map 1:v -c:v mjpeg -disposition:v:0
/// attached_pic` 封装；音频无 -c:a 指定，m4a muxer 默认 AAC 重编码——
/// 配方冻结照抄，probe.rs 模块内向量同款）。中间原料用后即删。
#[must_use]
fn ensure_vec_cover() -> Option<PathBuf> {
    let audio = ensure_vector("vec-audio.m4a", VEC_AUDIO_ARGS)?;
    let cover = ensure_vector("cover.jpg", COVER_JPG_ARGS)?;
    let exe = ffmpeg_exe().expect("定位器已命中（原料已生成）");
    let out = tmp_path("vec-cover", "m4a");
    let args: Vec<OsString> = vec![
        "-v".into(),
        "error".into(),
        "-i".into(),
        audio.clone().into_os_string(),
        "-i".into(),
        cover.clone().into_os_string(),
        "-map".into(),
        "0:a".into(),
        "-map".into(),
        "1:v".into(),
        "-c:v".into(),
        "mjpeg".into(),
        "-disposition:v:0".into(),
        "attached_pic".into(),
        "-y".into(),
    ];
    run_ffmpeg_to(&exe, &args, &out);
    let _ = std::fs::remove_file(&audio); // 原料用后即删（仓库约定）。
    let _ = std::fs::remove_file(&cover);
    Some(out)
}

/// 对拍点位（µs）：`t = f × 33333 + 5000`（§3.1 修正案——三点均落在
/// 目标帧 pts 与后继帧 pts 之间，两侧「取 pts ≥ t 的首帧」语义一致取到帧 f）。
fn point_us(frame: i64) -> i64 {
    frame * 33_333 + 5_000
}

/// 打开向量文件为 ye 门面输入。
fn open_vector(path: &Path) -> Box<dyn ReadSeek> {
    Box::new(std::fs::File::open(path).expect("打开向量"))
}

// ---- 抽帧参考侧助手 ----

/// 参考侧 ffmpeg 单帧 rgba（`-ss` 在 -i 前：输入侧定位，解码到目标帧即
/// 止——与 ye 门面「取首个 pts ≥ 时点的帧即置 cancel」同语义，两侧取到
/// 同一物理帧；输出恰 `W×H×4` 字节）。失败语义同 [`run_ffmpeg_to`]。
fn reference_frame(exe: &Path, vec: &Path, t_us: i64, tag: &str) -> Vec<u8> {
    let out = tmp_path(tag, "rgba");
    let seconds = format!(
        "{:.6}",
        f64::from(i32::try_from(t_us).expect("时点在 i32 域")) / 1e6
    );
    let status = Command::new(exe)
        .args(["-v", "error", "-ss"])
        .arg(&seconds)
        .arg("-i")
        .arg(vec)
        .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba"])
        .arg(&out)
        .status()
        .unwrap_or_else(|err| panic!("启动 ffmpeg 失败（{}）：{err}", exe.display()));
    assert!(
        status.success(),
        "ffmpeg 参考侧抽帧失败（退出码 {status:?}）——定位器已命中，不许 skip"
    );
    let rgba = std::fs::read(&out)
        .unwrap_or_else(|err| panic!("读参考侧输出失败（{}）：{err}", out.display()));
    let _ = std::fs::remove_file(&out); // 用后即删（仓库约定）。
    assert_eq!(
        rgba.len(),
        (W * H * 4) as usize,
        "{tag}：参考侧应恰出一帧 {W}x{H} rgba"
    );
    rgba
}

// ---- 对拍容差（POLICY_NOTE：只准收紧，放宽须回施工图 §3 重定口径） ----

/// 像素通道容差：100% 通道 |Δ| ≤ 2 且 Δ=0 通道占比 ≥ 99%（§3.3 初值；
/// 依据：H.264 YUV 口径 100% |Δ|≤1 且 99.9% Δ=0，叠加 yuv420p→rgba8
/// BT.601 转换两侧舍入路径差异放一档）。
const CHANNEL_TOL: u32 = 2;
/// Δ=0 通道占比下限（同上 POLICY_NOTE 管辖：只准上调）。
const ZERO_RATIO_MIN: f64 = 0.99;
/// 波形峰值三元组容差（§3.2：初值 2e-4；采 ye 侧 T3 实测收紧终值
/// 1.5e-4——duan binaries ffmpeg N-127696 上正弦 |Δmax|=5.022e-6、白噪声
/// 7 次采样最坏 8.810e-5，取 1.7× 余量，ye waveform_oracle.rs 同数）。
const PEAK_TOL: f32 = 1.5e-4;
/// 波形对拍桶数（§3.2：100——2 秒向量桶长 ~960 样本）。
const BUCKETS: usize = 100;
/// probe 时长容差（§3.4：容器 timescale 换算来源不同）。
const PROBE_DURATION_TOL_US: i64 = 1_000;
/// probe 帧率相对差容差（§3.4：ye 由样本数/时长推导，ffprobe 取
/// avg_frame_rate）。
const PROBE_FPS_REL_TOL: f64 = 1e-3;

/// 逐通道像素对拍（先全量统计留实测数字——收紧容差的依据，再按容差
/// 断言；返回 (max |Δ|, Δ=0 占比) 供打印）。
fn assert_pixels_close(got: &[u8], want: &[u8], ctx: &str) -> (u32, f64) {
    assert_eq!(got.len(), want.len(), "{ctx}：字节数");
    let mut max_diff = 0u32;
    let mut zero = 0usize;
    let mut worst_at = 0usize;
    for (index, (a, b)) in got.iter().zip(want).enumerate() {
        let diff = u32::from(a.abs_diff(*b));
        if diff > max_diff {
            max_diff = diff;
            worst_at = index;
        }
        if diff == 0 {
            zero += 1;
        }
    }
    let ratio = zero as f64 / got.len() as f64;
    eprintln!(
        "{ctx}：实测 max |Δ|={max_diff}（最坏字节 {worst_at}：ye {} vs 参考 {}），\
         Δ=0 通道占比 {ratio:.5}",
        got[worst_at], want[worst_at]
    );
    assert!(
        max_diff <= CHANNEL_TOL,
        "{ctx}：max |Δ|={max_diff} > {CHANNEL_TOL}"
    );
    assert!(
        ratio >= ZERO_RATIO_MIN,
        "{ctx}：Δ=0 通道占比 {ratio:.5} < {ZERO_RATIO_MIN}"
    );
    (max_diff, ratio)
}

// ---- 波形对拍助手 ----

/// 三元组差的最坏值（诊断与收紧依据）。
#[derive(Debug, Clone, Copy)]
struct WorstDiff {
    /// max |Δmin|。
    min: f32,
    /// max |Δmax|。
    max: f32,
    /// max |Δrms|。
    rms: f32,
}

/// 逐声道逐桶对拍 jian 双轨（结构精确等：声道数/桶数；三元组 |Δ| 全在
/// 容差内）。返回实测最坏差（调用方打印留档——收紧容差的依据）。
fn assert_peaks_close(got: &[Vec<PeakBucket>], want: &[Vec<PeakBucket>], ctx: &str) -> WorstDiff {
    assert_eq!(
        got.len(),
        want.len(),
        "{ctx}：声道数应一致（ye 轨 {} vs ffmpeg 轨 {}）",
        got.len(),
        want.len()
    );
    let mut worst = WorstDiff {
        min: 0.0,
        max: 0.0,
        rms: 0.0,
    };
    for (channel, (ye_row, ff_row)) in got.iter().zip(want).enumerate() {
        assert_eq!(
            ye_row.len(),
            ff_row.len(),
            "{ctx}：声道 {channel} 桶数应一致（ye {} vs ffmpeg {}）",
            ye_row.len(),
            ff_row.len()
        );
        for (bucket, (ye_b, ff_b)) in ye_row.iter().zip(ff_row).enumerate() {
            let (dmin, dmax, drms) = (
                (ye_b.min - ff_b.min).abs(),
                (ye_b.max - ff_b.max).abs(),
                (ye_b.rms - ff_b.rms).abs(),
            );
            worst.min = worst.min.max(dmin);
            worst.max = worst.max.max(dmax);
            worst.rms = worst.rms.max(drms);
            assert!(
                dmin <= PEAK_TOL && dmax <= PEAK_TOL && drms <= PEAK_TOL,
                "{ctx}：声道 {channel} 桶 {bucket} 超容差 {PEAK_TOL}——ye 轨 {ye_b:?} vs \
                 ffmpeg 轨 {ff_b:?}（|Δmin|={dmin} |Δmax|={dmax} |Δrms|={drms}）"
            );
        }
    }
    worst
}

/// 一条波形向量的双轨对拍：分别直调两个 pub 纯库轨函数（§2.3 拆分的
/// 接缝），同容差（§3.2）；打印实测最坏差（收紧容差的留档数字）。
fn run_waveform_parity(vec_name: &str, recipe: &[&str], channels: usize) {
    let Some(path) = ensure_vector(vec_name, recipe) else {
        return; // 定位器落空：原因已打印，合法 skip（分级语义）。
    };
    let ye_got = waveform_peaks_ye(&path, BUCKETS)
        .unwrap_or_else(|e| panic!("{vec_name}：ye 轨应成功（{}）：{e}", path.display()));
    let ff_got = waveform_peaks_ffmpeg(&path, BUCKETS)
        .unwrap_or_else(|e| panic!("{vec_name}：ffmpeg 轨应成功（{}）：{e}", path.display()));
    let _ = std::fs::remove_file(&path); // 向量用后即删（仓库约定）。
    assert_eq!(ye_got.used_engine, "ye", "{vec_name}：ye 轨盖章");
    assert_eq!(ff_got.used_engine, "ffmpeg", "{vec_name}：ffmpeg 轨盖章");
    assert_eq!(ye_got.channels, channels, "{vec_name}：ye 轨声道数");
    assert_eq!(ff_got.channels, channels, "{vec_name}：ffmpeg 轨声道数");
    assert_eq!(
        ye_got.sample_rate, ff_got.sample_rate,
        "{vec_name}：采样率两轨一致"
    );
    assert_eq!(ye_got.buckets, BUCKETS, "{vec_name}：ye 轨桶数=请求值");
    assert_eq!(ff_got.buckets, BUCKETS, "{vec_name}：ffmpeg 轨桶数=请求值");
    let worst = assert_peaks_close(&ye_got.peaks, &ff_got.peaks, vec_name);
    eprintln!(
        "parity[波形 {vec_name}]：双轨实测最坏差 |Δmin|={:.3e} |Δmax|={:.3e} \
         |Δrms|={:.3e}（容差 {PEAK_TOL:e}，全过）",
        worst.min, worst.max, worst.rms
    );
}

// ---- 第一组：抽帧（§3.3） ----

/// vec.mp4 三点位像素对拍：直调 `ye::frame_grab::decode_frame_rgba` vs
/// ffmpeg 同点位 rawvideo（宽高精确等后逐像素比，f ∈ {0,45,88}）。
///
/// 实测留档（2026-10-27，duan binaries ffmpeg N-127696）：三点位均超
/// 容差——f=0 max |Δ|=21（Δ=0 占比 0.770）、f=45 → 35（0.817）、f=88 →
/// 130（0.708）。f=0 已在 jian 集成路径复测（21、0.77042，与 ye 侧逐位
/// 同数——同一份 ye 解码器经路径依赖链接、同一向量与 ffmpeg，f=45/88
/// 承 ye 侧同向量实测）；分歧归因 ye H.264 解码器（§3.1 冻结向量上解码
/// YUV 与 ffmpeg 存在两处独立分歧：去块启用首差帧 0 luma / 关去块仍首差
/// 帧 81 chroma，90 帧 max_abs=74；像素核 |Δ|≤1 与帧定位已排除——ye 侧
/// T3 交付状态同源）。解码器修复另行排期（ye 侧本轮裁决），修复工程师
/// 收口后翻除 `#[ignore]` 过门（`-- --ignored` 可显式重跑看失败明细）。
#[test]
fn 基线向量三时点抽帧与ffmpeg参考一致() {
    let Some(path) = ensure_vector("vec.mp4", VEC_VIDEO_ARGS) else {
        return; // 定位器落空：原因已打印，合法 skip（分级语义）。
    };
    let exe = ffmpeg_exe().expect("定位器已命中（向量已生成）");
    for frame in [0i64, 45, 88] {
        let t = point_us(frame);
        let got = decode_frame_rgba(open_vector(&path), t)
            .unwrap_or_else(|err| panic!("帧 {frame}（t={t}µs）ye 侧取帧应成功：{err}"));
        assert_eq!((got.width, got.height), (W, H), "帧 {frame}：宽高");
        let want = reference_frame(&exe, &path, t, &format!("vec-f{frame}"));
        assert_pixels_close(&got.rgba, &want, &format!("parity[抽帧 vec.mp4 f={frame}]"));
    }
    let _ = std::fs::remove_file(&path); // 向量用后即删（仓库约定）。
}

/// ye 引擎 PNG 出口（§3.3 jian 侧）：`extract_frame_ye_impl` 出临时 png
/// 文件——魔数（PNG 签名）与非空断言，不解码 PNG（encode 无损已有
/// 逐字节 0 容差先例，ye 侧 lib.rs:16）。测试删掉自己产的临时文件；
/// 生产轨临时 png 永不清理系已留档低危问题（docs/待开发.md:29，双引擎
/// 后堆积翻倍——治理归该条，本测试不治理）。
#[test]
fn ye引擎抽帧png出口魔数非空() {
    let Some(path) = ensure_vector("vec.mp4", VEC_VIDEO_ARGS) else {
        return; // 定位器落空：合法 skip。
    };
    let out = extract_frame_ye_impl(&path, point_us(45))
        .unwrap_or_else(|e| panic!("ye 引擎抽帧应成功（{}）：{e}", path.display()));
    let _ = std::fs::remove_file(&path); // 向量用后即删（仓库约定）。
    let png =
        std::fs::read(&out).unwrap_or_else(|err| panic!("读 ye 引擎临时 PNG 失败（{out}）：{err}"));
    let _ = std::fs::remove_file(&out); // 测试自产文件用后即删。
    assert!(!png.is_empty(), "PNG 出口非空");
    assert!(png.len() > 8, "PNG 至少含 8 字节签名");
    assert_eq!(&png[0..8], &ye::png::SIGNATURE, "合法 PNG 签名开头");
}

/// vec-video-multi.mp4（视频可解 + 6 声道不可解音轨）：ye 侧**整体 Err**
/// （泵给每条流建解码器，AAC 多声道解码 Err 打回整个抽帧——§2.2 行为
/// 锁定，差异即「该类素材走 ffmpeg 回退」的依据）；ffmpeg 参考侧同点位
/// 可正常出帧——不做像素对拍。
#[test]
fn 不可解音轨向量ye轨整体打回() {
    let Some(path) = ensure_vector("vec-video-multi.mp4", VEC_MULTI_ARGS) else {
        return; // 定位器落空：合法 skip。
    };
    let exe = ffmpeg_exe().expect("定位器已命中（向量已生成）");
    let t = point_us(45);
    let err = decode_frame_rgba(open_vector(&path), t)
        .expect_err("含不可解音轨的素材，ye 侧应整体 Err（不静默丢帧）");
    assert!(
        err.to_string().contains("channelConfiguration=6"),
        "打回原因应述多声道能力面外：{err}"
    );
    eprintln!("parity[不可解音轨]：ye 侧整体 Err（{err}）");
    // 参考侧对照：ffmpeg 同点位可正常出帧（行为差异即回退依据）。
    let reference = reference_frame(&exe, &path, t, "multi-f45");
    assert_eq!(reference.len(), (W * H * 4) as usize, "参考侧可正常出帧");
    let _ = std::fs::remove_file(&path); // 用后即删。
}

// ---- 第二组：波形（§3.2） ----

/// 正弦向量（vec-audio.m4a：立体声 440Hz 48k、2s）——对 min/max 敏感。
#[test]
fn 正弦向量双轨逐桶峰值一致() {
    run_waveform_parity("vec-audio.m4a", VEC_AUDIO_ARGS, 2);
}

/// 白噪声向量（vec-noise.m4a：单声道 44.1k、2s）——对样本错位敏感
/// （错一帧即 rms 大幅漂移，能暴露 edit list 口径错误）。
#[test]
fn 白噪声向量双轨逐桶峰值一致() {
    run_waveform_parity("vec-noise.m4a", VEC_NOISE_ARGS, 1);
}

// ---- 第三组：probe 双轨判等（§3.4） ----

/// probe 便捷封装（engine 透传，路径转 String）。
fn probe(path: &Path, engine: Option<&str>) -> jian_lib::probe::ProbeResult {
    probe_media(
        path.to_string_lossy().into_owned(),
        engine.map(|e| e.to_string()),
    )
    .unwrap_or_else(|e| panic!("probe 应成功（{}，engine={engine:?}）：{e}", path.display()))
}

/// vec.mp4 双轨判等（§3.4）：width/height/hasAudio/kind **精确等**；
/// durationUs |Δ| ≤ 1000（容器 timescale 换算来源不同）；fps 相对差
/// ≤ 1e-3（ye 由样本数/时长推导，ffprobe 取 avg_frame_rate）。
#[test]
fn 视频向量probe双轨判等() {
    let Some(path) = ensure_vector("vec.mp4", VEC_VIDEO_ARGS) else {
        return; // 定位器落空：合法 skip。
    };
    let ye_res = probe(&path, Some("ye"));
    let ff_res = probe(&path, Some("ffmpeg"));
    let _ = std::fs::remove_file(&path); // 向量用后即删（仓库约定）。
    assert_eq!(ye_res.used_engine, "ye", "显式 ye 轨盖章");
    assert_eq!(ff_res.used_engine, "ffmpeg", "显式 ffmpeg 轨盖章");
    assert_eq!(ye_res.width, ff_res.width, "width 精确等");
    assert_eq!(ye_res.height, ff_res.height, "height 精确等");
    assert_eq!(
        ye_res.has_audio, ff_res.has_audio,
        "hasAudio 精确等（vec 无音轨）"
    );
    assert_eq!(ye_res.kind, ff_res.kind, "kind 精确等");
    assert_eq!(ye_res.kind, "video", "视频向量两轨都判 video");
    let (dye, dff) = (ye_res.duration_us, ff_res.duration_us);
    assert!(
        (dye - dff).abs() <= PROBE_DURATION_TOL_US,
        "durationUs 超容差：ye={dye} ffprobe={dff}"
    );
    assert!(ff_res.fps > 0.0, "ffprobe 轨 fps 应为正（vec 为 30fps 源）");
    let rel = ((ye_res.fps - ff_res.fps) / ff_res.fps).abs();
    assert!(
        rel <= PROBE_FPS_REL_TOL,
        "fps 相对差超容差：ye={} ffprobe={}",
        ye_res.fps,
        ff_res.fps
    );
    eprintln!(
        "parity[probe vec.mp4]：双轨判等全过（durationUs ye={dye} ffprobe={dff}，\
         fps ye={:.4} ffprobe={:.4}，宽高 {}x{}）",
        ye_res.fps, ff_res.fps, ye_res.width, ye_res.height
    );
}

/// 带封面 vec-cover.m4a：auto 命中疑似封面启发式（covr 盲区兜底）→
/// 整体回退 ffprobe 轨，usedEngine="ffmpeg"；最终结果与显式 engine=
/// "ffmpeg" 轨**完全一致**（kind=audio，不误报 video）。
#[test]
fn 带封面向量auto回退ffmpeg轨且判等() {
    let Some(path) = ensure_vec_cover() else {
        return; // 定位器落空：合法 skip。
    };
    let auto = probe(&path, None);
    let explicit = probe(&path, Some("ffmpeg"));
    let _ = std::fs::remove_file(&path); // 向量用后即删（仓库约定）。
    assert_eq!(auto.used_engine, "ffmpeg", "auto 应经启发式回退 ffprobe 轨");
    assert_eq!(auto.kind, "audio", "带封面音频不误报 video");
    assert_eq!(
        auto.duration_us, explicit.duration_us,
        "与显式 ffmpeg 轨完全一致"
    );
    assert_eq!(auto.width, explicit.width);
    assert_eq!(auto.height, explicit.height);
    assert_eq!(auto.fps, explicit.fps);
    assert_eq!(auto.has_audio, explicit.has_audio);
    eprintln!(
        "parity[probe vec-cover.m4a]：auto 回退 ffmpeg 轨，kind={} durationUs={}（与显式轨逐字段一致）",
        auto.kind, auto.duration_us
    );
}

/// 非 mp4 素材（cover.jpg）：auto 落 ffprobe 轨且 usedEngine="ffmpeg"
/// （ye 注册表只 mp4，jpg 自然 Err 回退；kind=image、零时长零帧率）。
#[test]
fn 非mp4素材auto落ffprobe轨() {
    let Some(path) = ensure_vector("cover.jpg", COVER_JPG_ARGS) else {
        return; // 定位器落空：合法 skip。
    };
    let r = probe(&path, None);
    let _ = std::fs::remove_file(&path); // 用后即删。
    assert_eq!(r.used_engine, "ffmpeg", "非 mp4 素材 auto 落 ffprobe 轨");
    assert_eq!(r.kind, "image", "jpg 判 image（扩展名优先）");
    assert_eq!(r.duration_us, 0, "图片零时长");
    assert_eq!(r.fps, 0.0, "图片零帧率");
}
