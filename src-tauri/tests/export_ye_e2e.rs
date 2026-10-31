//! ye 导出引擎端到端对拍（M4 首轮：剪的导出接管最小集）。
//!
//! 口径（任务书 M4 首轮）：ffmpeg 造两段 3s 176x144 H.264(Baseline)+AAC
//! 源 → run_export_ye 的主体路径（export_ye_impl）拼接导出（窗口各裁 2s、
//! 输出 320x240@15fps）→ 与 ffmpeg 同参数对照
//! （两段各 -ss/-t 裁剪 → concat filter → -r 15 -s 320x240）对拍：
//! 1. 双方产物都能被 ffmpeg 无错解码（流合法性）；
//! 2. ffprobe：时长 ≈ 4s（±0.1s）、逐帧计数 = 60（两段各 30）、流形态
//!    （h264+aac 双轨 / 剥音频单轨）；
//! 3. 同点位灰度帧平均 |Δ| 容差对拍（两编码器 + 两条缩放路径的视觉一致，
//!    非逐字节对齐——duan ye_engine_e2e 同款思路；容差见 MEAN_DIFF_MAX
//!    注释的实测依据，只准收紧）。
//!
//! ffmpeg/ffprobe 定位：BJ_FFMPEG_DIR → PATH → 仓相对
//! ../../duan/src-tauri/binaries（集群开发机布局，probe.rs 测试同口径）；
//! 都没有则失败——对拍测试不许假绿（duan/ye 同款约定）。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicBool;

use jian_lib::export_ye::{ExportYeSpec, SegmentArg, export_ye_impl};
use ye::time::Rational;

/// 对拍容差：灰度帧平均 |Δ| 上限。实测（2026-10-26，本机，五点位
/// 0.5/1.933/2.066/2.5/3.9s）：1.537 / 1.620 / 0.749 / 0.751 / 0.751
/// ——max 1.62（libx264 CRF 23 vs ye H.264 CRF 23 + swscale vs ye-filter
/// 双线性缩放 + concat/fps 路径差的合成误差；smptebars 段内容稳定在
/// 0.75、testsrc2 运动段在 1.5–1.7）。取 3.0（实测 max 的 ~1.85 倍裕量
/// 覆盖编码非确定性），只准收紧不许放宽。
const MEAN_DIFF_MAX: f64 = 3.0;

/// ffmpeg/ffprobe 定位（probe.rs 测试同口径：env → PATH → 仓相对 duan）。
fn tool(name: &str) -> PathBuf {
    let with_exe = |dir: &Path| {
        if cfg!(windows) {
            dir.join(format!("{name}.exe"))
        } else {
            dir.join(name)
        }
    };
    let has = |p: &Path| p.is_file();
    if let Some(dir) = std::env::var_os("BJ_FFMPEG_DIR").map(PathBuf::from) {
        let cand = with_exe(&dir);
        if has(&cand) {
            return cand;
        }
    }
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let cand = with_exe(&dir);
            if has(&cand) {
                return cand;
            }
        }
    }
    let repo_relative = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../duan/src-tauri/binaries");
    with_exe(&repo_relative)
}

fn run(cmd: &Path, args: &[&str]) -> (bool, Vec<u8>, Vec<u8>) {
    let out = Command::new(cmd)
        .args(args)
        .output()
        .expect("启动外部命令失败");
    (out.status.success(), out.stdout, out.stderr)
}

/// 生成一段源：3 秒 176x144 15fps H.264(Baseline)+AAC(44.1k 立体声) MP4。
/// 两段内容不同（testsrc2 / smptebars）以暴露段序错乱；音频参数两段一致
/// （compose 的跨段一致性约束）。
fn make_source(dir: &Path, ffmpeg: &Path, name: &str, lavfi_video: &str) -> PathBuf {
    let src = dir.join(name);
    let video_src = format!("{lavfi_video}=duration=3:size=176x144:rate=15");
    let mut args: Vec<&str> = vec![
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        &video_src,
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=44100:duration=3",
        "-c:v",
        "libx264",
        "-profile:v",
        "baseline",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ac",
        "2",
        "-b:a",
        "128k",
        "-shortest",
    ];
    args.push(src.to_str().unwrap());
    let (ok, _, stderr) = run(ffmpeg, &args);
    assert!(
        ok,
        "ffmpeg 造源失败（{name}）: {}",
        String::from_utf8_lossy(&stderr)
    );
    src
}

/// ffprobe 逐帧计数（-count_frames 的 nb_read_frames）。
fn count_frames(ffprobe: &Path, file: &Path) -> u32 {
    let (ok, out, err) = run(
        ffprobe,
        &[
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_frames",
            "-show_entries",
            "stream=nb_read_frames",
            "-of",
            "default=noprint_wrappers=1",
            file.to_str().unwrap(),
        ],
    );
    assert!(ok, "ffprobe 失败: {}", String::from_utf8_lossy(&err));
    let text = String::from_utf8_lossy(&out);
    text.lines()
        .find_map(|l| {
            l.strip_prefix("nb_read_frames=")?
                .trim()
                .parse::<u32>()
                .ok()
        })
        .unwrap_or_else(|| panic!("ffprobe 未读到帧数: {text}"))
}

/// ffprobe 视频流时长（秒）。
fn video_duration(ffprobe: &Path, file: &Path) -> f64 {
    let (ok, out, err) = run(
        ffprobe,
        &[
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=duration",
            "-of",
            "default=noprint_wrappers=1",
            file.to_str().unwrap(),
        ],
    );
    assert!(ok, "ffprobe 失败: {}", String::from_utf8_lossy(&err));
    let text = String::from_utf8_lossy(&out);
    text.lines()
        .find_map(|l| l.strip_prefix("duration=")?.trim().parse::<f64>().ok())
        .unwrap_or_else(|| panic!("duration 应为数值：{text}"))
}

/// 流形态（ffprobe csv：每流 codec_name,codec_type，按流序）。
fn stream_layout(ffprobe: &Path, file: &Path) -> String {
    let (ok, out, err) = run(
        ffprobe,
        &[
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name,codec_type:stream_side_data=",
            "-of",
            "json",
            file.to_str().unwrap(),
        ],
    );
    assert!(ok, "ffprobe 失败: {}", String::from_utf8_lossy(&err));
    let json: serde_json::Value = serde_json::from_slice(&out).expect("ffprobe JSON");
    json["streams"]
        .as_array()
        .expect("stream list")
        .iter()
        .map(|stream| {
            format!(
                "{},{}",
                stream["codec_name"].as_str().expect("codec name"),
                stream["codec_type"].as_str().expect("codec type")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 抽取指定时间点的灰度帧（rawvideo 单帧），供画面一致性比较。
fn extract_gray_frame(ffmpeg: &Path, file: &Path, at_s: &str) -> Vec<u8> {
    let (ok, out, err) = run(
        ffmpeg,
        &[
            "-v",
            "error",
            "-ss",
            at_s,
            "-i",
            file.to_str().unwrap(),
            "-frames:v",
            "1",
            "-pix_fmt",
            "gray",
            "-f",
            "rawvideo",
            "-",
        ],
    );
    assert!(ok, "抽帧失败: {}", String::from_utf8_lossy(&err));
    out
}

/// 灰度帧平均 |Δ|（对拍统计量）。
fn mean_abs_diff(a: &[u8], b: &[u8]) -> f64 {
    assert_eq!(a.len(), b.len(), "两产物抽帧尺寸不一致");
    let sum: u32 = a
        .iter()
        .zip(b)
        .map(|(x, y)| u32::from(x.abs_diff(*y)))
        .sum();
    sum as f64 / a.len() as f64
}

/// 被测主体：两段各裁 2s（A [0,2s)、B [1s,3s)）→ 320x240@15fps。
/// 返回 ye 输出路径（strip_audio 控制音频轨）。
fn export_via_ye(dir: &Path, a: &Path, b: &Path, tag: &str, strip_audio: bool) -> PathBuf {
    let out = dir.join(format!("ye-{tag}.mp4"));
    let segments = vec![
        SegmentArg {
            path: a.to_string_lossy().into_owned(),
            trim_in_us: 0,
            trim_out_us: 2_000_000,
        },
        SegmentArg {
            path: b.to_string_lossy().into_owned(),
            trim_in_us: 1_000_000,
            trim_out_us: 3_000_000,
        },
    ];
    let spec = ExportYeSpec {
        size: (320, 240),
        frame_rate: Rational::new(15, 1),
        crf: 23,
        audio_bitrate_kbps: if strip_audio { None } else { Some(128) },
        strip_audio,
    };
    let stats = export_ye_impl(&segments, &out, &spec, &AtomicBool::new(false), &|_, _| {})
        .unwrap_or_else(|e| panic!("ye 导出失败（{tag}）: {e}"));
    // 两段各 ⌈2s×15fps⌉=30 tick；音频轨（非 strip 时）应有重编码包。
    assert_eq!(stats.video_frames, 60, "两段窗口帧数之和 = 60 tick");
    if !strip_audio {
        assert!(stats.audio_frames > 0, "应有音频输出包");
    } else {
        assert_eq!(stats.audio_frames, 0, "剥音频后不应有音频包");
    }
    out
}

/// 对照方：ffmpeg 同参数（两段 -ss/-t 裁剪 → concat → -r 15 -s 320x240，
/// libx264 crf 23；音频侧 ye 轨重编码 128k，对照按同码率 aac）。
fn export_via_ffmpeg(dir: &Path, ffmpeg: &Path, a: &Path, b: &Path) -> PathBuf {
    let out = dir.join("ff-ref.mp4");
    let (ok, _, stderr) = run(
        ffmpeg,
        &[
            "-y",
            "-v",
            "error",
            "-ss",
            "0",
            "-t",
            "2",
            "-i",
            a.to_str().unwrap(),
            "-ss",
            "1",
            "-t",
            "2",
            "-i",
            b.to_str().unwrap(),
            "-filter_complex",
            "[0:v][1:v]concat=n=2:v=1:a=0[v];[0:a][1:a]concat=n=2:v=0:a=1[a]",
            "-map",
            "[v]",
            "-map",
            "[a]",
            "-r",
            "15",
            "-s",
            "320x240",
            "-c:v",
            "libx264",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            out.to_str().unwrap(),
        ],
    );
    assert!(
        ok,
        "ffmpeg 对照导出失败: {}",
        String::from_utf8_lossy(&stderr)
    );
    out
}

#[test]
fn ye_引擎_顺序拼接导出对拍_ffmpeg() {
    let ffmpeg = tool("ffmpeg");
    let ffprobe = tool("ffprobe");
    // 工具缺席＝明确失败（对拍不许假绿，duan/ye 同款）。
    let (ok, _, _) = run(&ffmpeg, &["-version"]);
    assert!(
        ok,
        "ffmpeg 不可用（{ffmpeg:?}）：对拍测试需要 ffmpeg/ffprobe"
    );
    let (ok, _, _) = run(&ffprobe, &["-version"]);
    assert!(ok, "ffprobe 不可用（{ffprobe:?}）");

    let dir = std::env::temp_dir().join(format!("jian-export-ye-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("建临时目录");
    let a = make_source(&dir, &ffmpeg, "src-a.mp4", "testsrc2");
    let b = make_source(&dir, &ffmpeg, "src-b.mp4", "smptebars");

    // —— 被测方 ①：双轨（视频 + AAC 重编码）——
    let ye_out = export_via_ye(&dir, &a, &b, "out", false);
    // —— 被测方 ②：剥音频单轨 ——
    let ye_strip = export_via_ye(&dir, &a, &b, "strip", true);
    // —— 对照方 ——
    let ff_out = export_via_ffmpeg(&dir, &ffmpeg, &a, &b);

    // 对拍 1：产物 ffmpeg 无错解码。
    for file in [&ye_out, &ye_strip, &ff_out] {
        let (ok, _, err) = run(
            &ffmpeg,
            &[
                "-v",
                "error",
                "-i",
                file.to_str().unwrap(),
                "-f",
                "null",
                "-",
            ],
        );
        assert!(
            ok && err.is_empty(),
            "{} 解码报错: {}",
            file.display(),
            String::from_utf8_lossy(&err)
        );
    }

    // 对拍 2：时长 ≈ 4s、帧数 = 60、流形态。
    assert_eq!(count_frames(&ffprobe, &ye_out), 60, "ye 双轨产物帧数");
    assert_eq!(count_frames(&ffprobe, &ye_strip), 60, "ye 剥音频产物帧数");
    assert_eq!(count_frames(&ffprobe, &ff_out), 60, "ffmpeg 对照帧数");
    let ye_dur = video_duration(&ffprobe, &ye_out);
    assert!(
        (ye_dur - 4.0).abs() <= 0.1,
        "ye 产物时长应 ≈4s（两段 2s 窗口），实际 {ye_dur}s"
    );
    assert_eq!(
        stream_layout(&ffprobe, &ye_out),
        "h264,video\naac,audio",
        "双轨形态"
    );
    assert_eq!(
        stream_layout(&ffprobe, &ye_strip),
        "h264,video",
        "剥音频单轨形态"
    );

    // 对拍 3：同点位灰度帧平均 |Δ| ≤ MEAN_DIFF_MAX（点位覆盖段 A、拼接点
    // 两侧、段 B）。
    for at in ["0.5", "1.933", "2.066", "2.5", "3.9"] {
        let ye_frame = extract_gray_frame(&ffmpeg, &ye_out, at);
        let ff_frame = extract_gray_frame(&ffmpeg, &ff_out, at);
        assert_eq!(ye_frame.len(), 320 * 240, "抽帧不是 320x240 灰度（{at}s）");
        let mean = mean_abs_diff(&ye_frame, &ff_frame);
        eprintln!("export_ye_e2e: {at}s 灰度帧平均 |Δ| = {mean:.3}（容差 {MEAN_DIFF_MAX}）");
        assert!(
            mean <= MEAN_DIFF_MAX,
            "{at}s 画面平均 |Δ| 超限：{mean:.2}（容差 {MEAN_DIFF_MAX}）"
        );
    }

    let _ = std::fs::remove_dir_all(&dir);
}
