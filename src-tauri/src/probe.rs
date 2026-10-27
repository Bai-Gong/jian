//! 双引擎探测封装：媒体文件元数据 → 前端 MediaAsset 所需字段（M1 施工契约
//! §1；M2 T7 双引擎）。时间一律微秒；图片按零时长素材处理（types.ts 的
//! image 约定）。
//!
//! 引擎三态（`engine` 参数，缺省 auto）：
//! - `auto`：ye 轨（[`ContainerRegistry::probe`]，注册 mp4）优先；ye 轨 Err
//!   或命中疑似封面启发式（[`suspected_cover`]）→ 整体回退 ffprobe 轨；
//! - `ye`：只走 ye 轨，不回退（对拍 oracle 用；封面素材会被当视频流误判，
//!   调用方自知，正常业务请用 auto/ffmpeg）；
//! - `ffmpeg`：只走 ffprobe 子进程轨（回退与 oracle 轨，M1 语义原样）。
//!
//! 口径两轨同源不分叉：各轨把流/容器信息折算进 [`MediaSummary`]，kind 判定
//! 次序与时长回退统一收尾在 [`finalize_summary`] 纯函数。封面剔除
//! （ffprobe 的 disposition.attached_pic）只在 ffprobe 轨——ye Stream 无
//! disposition 概念，以 [`suspected_cover`] 形状启发式兜住后整体回退：
//! 含「mp4 家族 attached_pic 封面写 covr 原子、ye 头整条不可见」的盲区
//! 兜底（见其函数注释实测记录）。

use std::fs::File;
use std::io::BufReader;

use serde::Serialize;
use serde_json::Value;
use ye::codec::MediaType;
use ye::container::{ContainerRegistry, MediaHeader, Stream};
use ye::time::Timestamp;

use crate::ffmpeg::{ffmpeg_info, stderr_tail};

/// 引擎标识：auto（ye 优先 + 回退）。也作为前端 engine 参数的合法取值。
const ENGINE_AUTO: &str = "auto";
/// 引擎标识：ye 进程内轨（同时是 usedEngine 的取值之一）。
const ENGINE_YE: &str = "ye";
/// 引擎标识：ffprobe 子进程轨（同时是 usedEngine 的取值之一）。
const ENGINE_FFMPEG: &str = "ffmpeg";

/// 疑似封面启发式阈值（测试常量，施工图 §2.3 定死；收紧/放宽须回施工图重定口径）：
/// 视频流时长上限 1s（长音频时被「音频×5%」进一步压低）。
const COVER_MAX_VIDEO_US: i64 = 1_000_000;
/// 疑似封面启发式阈值：最长音频流时长 × 5%。
const COVER_AUDIO_RATIO: f64 = 0.05;

/// 探测结果（camelCase 序列化，对齐前端 MediaAsset 字段名）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub duration_us: i64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_audio: bool,
    pub kind: String,
    /// 实际产出本结果的引擎（"ye" | "ffmpeg"）：auto 回退后即回退轨名，
    /// 显式引擎恒等于所请求的引擎。
    pub used_engine: String,
}

/// 探测一个媒体文件，失败时把原因带回前端。engine 缺省 auto（ye 优先，
/// Err/疑似封面整体回退 ffprobe）；显式 ye/ffmpeg 各走各轨、互不越界。
#[tauri::command(async)]
pub fn probe_media(path: String, engine: Option<String>) -> Result<ProbeResult, String> {
    let engine = engine.unwrap_or_else(|| ENGINE_AUTO.to_string());
    match engine.as_str() {
        ENGINE_FFMPEG => probe_ffmpeg(&path),
        ENGINE_YE => probe_ye(&path),
        ENGINE_AUTO => match auto_via_ye(&path) {
            YeRoute::Result(r) => Ok(r),
            // ye 轨 Err 或疑似封面 → 整体回退 ffprobe 轨（结果以 ffprobe 为准）
            YeRoute::Fallback => probe_ffmpeg(&path),
        },
        other => Err(format!(
            "未知 engine「{other}」（合法值：auto / ye / ffmpeg）"
        )),
    }
}

/// auto 模式下 ye 轨的路由结论：拿到结果，或「该回退 ffprobe」。
enum YeRoute {
    Result(ProbeResult),
    Fallback,
}

/// auto 路由主体（纯流程，无 Tauri 类型）：ye 读头 → 疑似封面判定 → 折算
/// 收尾；任何一步 Err（打不开/容器不识/kind 无法判定）都按 Fallback 处理
/// ——ffprobe 是权威轨，误伤只是慢一点，漏判才会错数据。
fn auto_via_ye(path: &str) -> YeRoute {
    let header = match ye_header(path) {
        Ok(h) => h,
        Err(_) => return YeRoute::Fallback,
    };
    if suspected_cover(&header) {
        return YeRoute::Fallback;
    }
    match finalize_summary(summarize_ye_header(&header), path, ENGINE_YE) {
        Ok(r) => YeRoute::Result(r),
        Err(_) => YeRoute::Fallback,
    }
}

/// ffprobe 轨（M1 语义原样，oracle 与回退轨）。
fn probe_ffmpeg(path: &str) -> Result<ProbeResult, String> {
    let ffprobe = ffmpeg_info()?.ffprobe_path;
    let out = std::process::Command::new(&ffprobe)
        .arg("-v")
        .arg("error")
        .arg("-print_format")
        .arg("json")
        .arg("-show_format")
        .arg("-show_streams")
        .arg(path)
        .output()
        .map_err(|e| format!("启动 ffprobe 失败（{ffprobe}）: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ffprobe 探测失败（{path}）: {}",
            stderr_tail(&out.stderr)
        ));
    }
    let json: Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("解析 ffprobe 输出失败（{path}）: {e}"))?;
    parse_probe_json(&json, path)
}

/// ye 轨：注册 mp4 的注册表一步式探查，返回头信息（不解码任何包）。
fn probe_ye(path: &str) -> Result<ProbeResult, String> {
    let header = ye_header(path)?;
    finalize_summary(summarize_ye_header(&header), path, ENGINE_YE)
}

/// 打开文件并经 ContainerRegistry 探查（auto 与显式 ye 共用；注册表目前
/// 只注册 mp4，其余容器在 auto 下自然落入 Err → ffprobe 回退）。
fn ye_header(path: &str) -> Result<MediaHeader, String> {
    let file = File::open(path).map_err(|e| format!("ye 打开失败（{path}）: {e}"))?;
    let mut registry = ContainerRegistry::new();
    ye::container::mp4::register_mp4(&mut registry);
    registry
        .probe(Box::new(BufReader::new(file)))
        .map(|(_, header)| header)
        .map_err(|e| format!("ye 探测失败（{path}）: {e}"))
}

/// 媒体种类判定（纯函数，供单测）。次序写死：
/// ① 扩展名 ∈ 图片集合 → image（实测 ffprobe 对 PNG 报 codec_type=video/png_pipe，
///    流判定放在前则图片永远走不到，必须扩展名优先）；
/// ② 有视频流 → video（gif 走此支，取真实 fps）；
/// ③ 有音频流 → audio；④ 否则报错。
fn classify_media_kind(
    ext: &str,
    has_video: bool,
    has_audio: bool,
) -> Result<&'static str, String> {
    match ext.to_ascii_lowercase().as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "bmp" => Ok("image"),
        _ if has_video => Ok("video"),
        _ if has_audio => Ok("audio"),
        _ => Err("无法识别的媒体".to_string()),
    }
}

/// 轨道无关的探测中间摘要：两轨各自把流/容器信息折算进来，口径收尾统一
/// 走 [`finalize_summary`]——同源不分叉的载体。
struct MediaSummary {
    has_video: bool,
    has_audio: bool,
    width: u32,
    height: u32,
    fps: f64,
    /// 容器级时长（微秒），缺失为 None。
    container_duration_us: Option<i64>,
    /// 流级时长（微秒）集合，容器级缺失时取最大。
    stream_durations_us: Vec<i64>,
}

/// 口径收尾（两轨同源，纯函数，供单测）：kind 判定次序 → 时长回退（容器级
/// 优先，缺失取流级最大）→ 图片零时长清零。
fn finalize_summary(s: MediaSummary, path: &str, used_engine: &str) -> Result<ProbeResult, String> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let kind = classify_media_kind(ext, s.has_video, s.has_audio)
        .map_err(|e| format!("{e}: {path}"))?
        .to_string();

    let duration_us = s
        .container_duration_us
        .or_else(|| s.stream_durations_us.iter().copied().max())
        .unwrap_or(0);

    // 图片是零时长素材：durationUs=0、fps=0（types.ts:53）
    let (duration_us, fps) = if kind == "image" {
        (0, 0.0)
    } else {
        (duration_us, s.fps)
    };

    Ok(ProbeResult {
        duration_us,
        width: s.width,
        height: s.height,
        fps,
        has_audio: s.has_audio,
        kind,
        used_engine: used_engine.to_string(),
    })
}

/// 从 ffprobe JSON 拆字段（纯函数，供单测）：流循环只做封面剔除与首条视频流
/// 画幅/帧率提取，折算进 [`MediaSummary`] 后交 [`finalize_summary`] 收尾。
fn parse_probe_json(v: &Value, path: &str) -> Result<ProbeResult, String> {
    let streams: Vec<Value> = v["streams"].as_array().cloned().unwrap_or_default();
    let mut s = MediaSummary {
        has_video: false,
        has_audio: false,
        width: 0,
        height: 0,
        fps: 0.0,
        container_duration_us: v["format"]["duration"]
            .as_str()
            .and_then(|d| d.parse::<f64>().ok())
            .map(|sec| (sec * 1e6).round() as i64),
        stream_durations_us: streams
            .iter()
            .filter_map(|st| st["duration"].as_str().and_then(|d| d.parse::<f64>().ok()))
            .map(|sec| (sec * 1e6).round() as i64)
            .collect(),
    };
    // 画幅/帧率取第一条视频流；音频流只标记存在性
    for st in &streams {
        // 内嵌封面不算内容视频流：带封面的 mp3/m4a/flac 实测会多出一条
        // codec_type=video 的 mjpeg 流（disposition.attached_pic=1），不剔除会被
        // 误判成 video——素材进不了音频轨，导出时封面还会整段叠在成片上。
        let is_cover = st["disposition"]["attached_pic"].as_i64() == Some(1);
        match st["codec_type"].as_str() {
            Some("video") if is_cover => {}
            Some("video") if !s.has_video => {
                s.has_video = true;
                s.width = st["width"].as_u64().unwrap_or(0).min(u32::MAX as u64) as u32;
                s.height = st["height"].as_u64().unwrap_or(0).min(u32::MAX as u64) as u32;
                // 帧率用 avg_frame_rate；个别封装报 0/0，退回 r_frame_rate
                s.fps = st["avg_frame_rate"]
                    .as_str()
                    .and_then(parse_rate)
                    .or_else(|| st["r_frame_rate"].as_str().and_then(parse_rate))
                    .unwrap_or(0.0);
            }
            Some("video") => {}
            Some("audio") => s.has_audio = true,
            _ => {}
        }
    }
    finalize_summary(s, path, ENGINE_FFMPEG)
}

/// ye 头信息 → [`MediaSummary`]：视频流取 stsd 宽高；帧率容器不带
/// （stsd 表达不了，ye 读侧恒 None），按 样本数/流时长 推导；音频流只标记
/// 存在性；容器级时长取头信息 canonical 时长（mp4 读侧为各流时长最大值）。
fn summarize_ye_header(header: &MediaHeader) -> MediaSummary {
    let mut s = MediaSummary {
        has_video: false,
        has_audio: false,
        width: 0,
        height: 0,
        fps: 0.0,
        container_duration_us: header.duration.map(timestamp_us),
        stream_durations_us: header
            .streams
            .iter()
            .filter_map(|st| st.duration.map(timestamp_us))
            .collect(),
    };
    for st in &header.streams {
        match st.media_type {
            MediaType::Video if !s.has_video => {
                s.has_video = true;
                if let Some(v) = &st.codec.video {
                    s.width = v.width;
                    s.height = v.height;
                }
                if let (Some(frames), Some(dur)) = (st.nb_frames, st.duration) {
                    let dur_us = timestamp_us(dur);
                    if frames > 0 && dur_us > 0 {
                        s.fps = frames as f64 * 1e6 / dur_us as f64;
                    }
                }
            }
            MediaType::Video => {}
            MediaType::Audio => s.has_audio = true,
            _ => {}
        }
    }
    s
}

/// 疑似封面启发式（纯函数，供单测）。ye Stream 无 disposition/attached_pic，
/// 内嵌封面只能靠流形状识别；命中即整体回退 ffprobe 轨（那边有 disposition
/// 可精确剔除）。判据（①② 为施工图 §2.3 原文；③ 为 2026-10-27 本机实测
/// 补充，见函数体注释）：
/// ① 多条视频流 → 疑似（真实内容视频 + 封面缩略图的组合形状）；
/// ② 存在音频流且唯一视频流命中其一：
///    时长 < min(1s, 最长音频流时长×5%)，或 nb_frames=1（单帧视频配音频
///    即封面形状；个别封装把封面轨时长写成与音频等长，时长判据抓不到，
///    nb_frames 兜底）；
/// ③ 有音频流而无视频流（mp4 家族音频）→ 疑似。
/// 误伤（真短视频/纯音频被当封面）只是多跑一次 ffprobe，结果仍以权威轨
/// 为准；漏判才会把音频素材误报成 video——判据从严不从宽。
fn suspected_cover(header: &MediaHeader) -> bool {
    let videos: Vec<&Stream> = header
        .streams
        .iter()
        .filter(|st| st.media_type == MediaType::Video)
        .collect();
    if videos.len() > 1 {
        return true;
    }
    if !header
        .streams
        .iter()
        .any(|st| st.media_type == MediaType::Audio)
    {
        return false;
    }
    let Some(video) = videos.first() else {
        // ③ mp4 家族的 attached_pic 封面写在 moov.udta.meta 的 covr 原子，
        // 不是 trak——ye 的头信息里整条封面消失（vec-cover.m4a 实测仅见
        // 一条音频流），①② 无从命中；且 AAC priming 使 ye 的 mdhd 时长比
        // ffprobe 的 edit list 口径长（实测 2026667µs vs 2000000µs）。
        // 音频族整体回退权威轨：封面剔除与时长口径都归 ffprobe。
        return true;
    };
    let max_audio_us = header
        .streams
        .iter()
        .filter(|st| st.media_type == MediaType::Audio)
        .filter_map(|st| st.duration.map(timestamp_us))
        .max();
    let duration_suspect = video
        .duration
        .map(timestamp_us)
        .is_some_and(|d| d < cover_threshold_us(max_audio_us));
    duration_suspect || video.nb_frames == Some(1)
}

/// 封面判据的视频时长上限：min(1s, 最长音频×5%)。音频时长缺失时只按
/// 1s 上限（保守；mp4 读侧流时长恒有值，此支纯为全函数兜底）。
fn cover_threshold_us(max_audio_us: Option<i64>) -> i64 {
    match max_audio_us {
        Some(audio) => COVER_MAX_VIDEO_US.min(((audio as f64) * COVER_AUDIO_RATIO).round() as i64),
        None => COVER_MAX_VIDEO_US,
    }
}

/// 时戳 → 微秒（四舍五入）。两轨时长换算的唯一出入口。
fn timestamp_us(t: Timestamp) -> i64 {
    (t.to_seconds() * 1e6).round() as i64
}

/// 解析 ffprobe 的分数帧率（如 "30000/1001"），先约分再相除；0 或非法返回 None。
fn parse_rate(rate: &str) -> Option<f64> {
    let mut parts = rate.splitn(2, '/');
    let num: i64 = parts.next()?.trim().parse().ok()?;
    let den: i64 = match parts.next() {
        Some(d) => d.trim().parse().ok()?,
        None => 1,
    };
    if num <= 0 || den <= 0 {
        return None;
    }
    let g = gcd(num, den);
    Some((num / g) as f64 / (den / g) as f64)
}

fn gcd(mut a: i64, mut b: i64) -> i64 {
    while b != 0 {
        let r = a % b;
        a = b;
        b = r;
    }
    a
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::OnceLock;
    use ye::codec::{CodecId, CodecParameters, VideoParams};
    use ye::container::Metadata;
    use ye::time::Rational;

    // ---- 既有口径单测（M1，双轨重构后必须原样通过）----

    #[test]
    fn png_扩展名优先于视频流() {
        // 实测 ffprobe 对 PNG 报 codec_type=video，扩展名必须先判
        assert_eq!(classify_media_kind("png", true, false), Ok("image"));
        assert_eq!(classify_media_kind("PNG", true, true), Ok("image"));
        assert_eq!(classify_media_kind("jpeg", true, false), Ok("image"));
    }

    #[test]
    fn gif_走视频支() {
        assert_eq!(classify_media_kind("gif", true, false), Ok("video"));
    }

    #[test]
    fn mp3_走音频支() {
        assert_eq!(classify_media_kind("mp3", false, true), Ok("audio"));
        assert_eq!(classify_media_kind("wav", false, true), Ok("audio"));
    }

    #[test]
    fn 无法识别的扩展名报错() {
        assert!(classify_media_kind("txt", false, false).is_err());
        assert!(classify_media_kind("", false, false).is_err());
    }

    #[test]
    fn 帧率分数约分() {
        assert_eq!(parse_rate("30000/1001"), Some(30000.0 / 1001.0));
        assert_eq!(parse_rate("25/1"), Some(25.0));
        assert_eq!(parse_rate("10"), Some(10.0));
        assert_eq!(parse_rate("0/0"), None);
        assert_eq!(parse_rate("N/A"), None);
    }

    #[test]
    fn 解析最小视频_json() {
        let v = serde_json::json!({
            "streams": [
                {"codec_type": "video", "width": 1920, "height": 1080, "avg_frame_rate": "30000/1001"},
                {"codec_type": "audio"}
            ],
            "format": {"duration": "12.345678"}
        });
        let r = parse_probe_json(&v, "D:/a/demo.mp4").unwrap();
        assert_eq!(r.kind, "video");
        assert_eq!(r.duration_us, 12_345_678);
        assert_eq!(r.width, 1920);
        assert_eq!(r.height, 1080);
        assert!((r.fps - 30000.0 / 1001.0).abs() < 1e-9);
        assert!(r.has_audio);
        assert_eq!(r.used_engine, "ffmpeg");
    }

    #[test]
    fn 解析图片_json_零时长() {
        // ffprobe 对 PNG 报 video 流（png_pipe），扩展名判定使其归 image，时长/帧率清零
        let v = serde_json::json!({
            "streams": [
                {"codec_type": "video", "width": 800, "height": 600, "avg_frame_rate": "25/1"}
            ],
            "format": {"duration": "0.040000"}
        });
        let r = parse_probe_json(&v, "D:/a/pic.png").unwrap();
        assert_eq!(r.kind, "image");
        assert_eq!(r.duration_us, 0);
        assert_eq!(r.fps, 0.0);
        assert_eq!(r.width, 800);
        assert!(!r.has_audio);
    }

    #[test]
    fn 解析纯音频_json_容器无时长退回流时长() {
        let v = serde_json::json!({
            "streams": [
                {"codec_type": "audio", "duration": "3.5"}
            ],
            "format": {"duration": "N/A"}
        });
        let r = parse_probe_json(&v, "D:/a/a.mp3").unwrap();
        assert_eq!(r.kind, "audio");
        assert_eq!(r.duration_us, 3_500_000);
        assert!(r.has_audio);
        assert_eq!(r.width, 0);
    }

    #[test]
    fn 带内嵌封面的音频不误判成视频() {
        // 实测：ffmpeg 生成含封面 mp3 后 ffprobe 报 streams=[audio, video(mjpeg, attached_pic=1)]。
        // 封面流若计入 has_video，会命中「有视频流→video」，音频素材进不了音频轨。
        let v = serde_json::json!({
            "streams": [
                {"codec_type": "audio", "duration": "200.5"},
                {
                    "codec_type": "video", "width": 500, "height": 500,
                    "avg_frame_rate": "1/90000",
                    "disposition": {"attached_pic": 1}
                }
            ],
            "format": {"duration": "200.5"}
        });
        let r = parse_probe_json(&v, "D:/a/song.mp3").unwrap();
        assert_eq!(r.kind, "audio");
        assert_eq!(r.duration_us, 200_500_000);
        assert!(r.has_audio);
        assert_eq!(r.width, 0); // 封面画幅不进结果
        assert_eq!(r.height, 0);
        assert_eq!(r.fps, 0.0);
    }

    #[test]
    fn 真实视频带封面缩略图仍判视频() {
        // mp4 内嵌封面缩略图（attached_pic=1）不影响真实视频流判定
        let v = serde_json::json!({
            "streams": [
                {"codec_type": "video", "width": 1920, "height": 1080, "avg_frame_rate": "25/1"},
                {"codec_type": "audio"},
                {
                    "codec_type": "video", "width": 320, "height": 180,
                    "disposition": {"attached_pic": 1}
                }
            ],
            "format": {"duration": "6.0"}
        });
        let r = parse_probe_json(&v, "D:/a/clip.mp4").unwrap();
        assert_eq!(r.kind, "video");
        assert_eq!(r.width, 1920); // 画幅取第一条真实视频流，不是封面
        assert_eq!(r.height, 1080);
        assert!((r.fps - 25.0).abs() < 1e-9);
        assert!(r.has_audio);
    }

    #[test]
    fn 悬空流信息报无法识别() {
        let v =
            serde_json::json!({"streams": [{"codec_type": "data"}], "format": {"duration": "1.0"}});
        let err = parse_probe_json(&v, "D:/a/x.txt").unwrap_err();
        assert!(err.contains("无法识别的媒体"), "实际报错：{err}");
        assert!(err.contains("x.txt"));
    }

    // ---- 引擎参数 ----

    #[test]
    fn 未知engine中文报错() {
        let err = probe_media("D:/a/x.mp4".into(), Some("ffmpegx".into())).unwrap_err();
        assert!(err.contains("未知 engine"), "实际报错：{err}");
        assert!(err.contains("auto / ye / ffmpeg"));
    }

    // ---- 疑似封面启发式（纯函数，构造头信息）----

    /// 造流：时基 1/1_000_000（µs 直读），视频参数可选。
    fn stream_of(
        media_type: MediaType,
        duration_us: Option<i64>,
        nb_frames: Option<u64>,
        video: Option<VideoParams>,
    ) -> Stream {
        Stream {
            index: 0,
            media_type,
            codec: CodecParameters {
                video,
                ..CodecParameters::new(CodecId::Unknown, media_type)
            },
            time_base: Rational::new(1, 1_000_000),
            start_time: None,
            duration: duration_us.map(|us| Timestamp::new(us, Rational::new(1, 1_000_000))),
            nb_frames,
            metadata: Metadata::new(),
        }
    }

    fn header_of(streams: Vec<Stream>) -> MediaHeader {
        MediaHeader {
            format_name: "mp4".to_string(),
            streams,
            duration: None,
            start_time: None,
            bit_rate: None,
            metadata: Metadata::new(),
        }
    }

    fn video_params() -> Option<VideoParams> {
        Some(VideoParams {
            width: 320,
            height: 240,
            pixel_format: None,
            frame_rate: None, // mp4 读侧恒 None，帧率靠样本数/时长推
        })
    }

    #[test]
    fn 封面启发式_多条视频流命中() {
        // 真实内容视频 + 封面缩略图的组合形状，无音频也命中
        let h = header_of(vec![
            stream_of(MediaType::Video, Some(3_000_000), Some(90), video_params()),
            stream_of(MediaType::Video, Some(0), Some(1), video_params()),
        ]);
        assert!(suspected_cover(&h));
    }

    #[test]
    fn 封面启发式_纯视频不命中() {
        // vec.mp4 形状：单视频 3s、无音频——auto 应走 ye 轨
        let h = header_of(vec![stream_of(
            MediaType::Video,
            Some(3_000_000),
            Some(90),
            video_params(),
        )]);
        assert!(!suspected_cover(&h));
    }

    #[test]
    fn 封面启发式_音频加短视频按比例命中() {
        // 2s 音频 × 5% = 0.1s 上限；40ms 封面 < 0.1s → 命中
        let h = header_of(vec![
            stream_of(MediaType::Audio, Some(2_000_000), None, None),
            stream_of(MediaType::Video, Some(40_000), Some(1), video_params()),
        ]);
        assert!(suspected_cover(&h));
    }

    #[test]
    fn 封面启发式_音频加正常短视频不命中() {
        // 2s 音频配 0.15s 真实视频（> 0.1s 阈值）、多帧——不误伤
        let h = header_of(vec![
            stream_of(MediaType::Audio, Some(2_000_000), None, None),
            stream_of(MediaType::Video, Some(150_000), Some(5), video_params()),
        ]);
        assert!(!suspected_cover(&h));
    }

    #[test]
    fn 封面启发式_长音频按1秒上限() {
        // 40s 音频 × 5% = 2s → min(1s, 2s) = 1s 上限：0.5s 视频命中、1.5s 不命中
        let short = header_of(vec![
            stream_of(MediaType::Audio, Some(40_000_000), None, None),
            stream_of(MediaType::Video, Some(500_000), Some(15), video_params()),
        ]);
        assert!(suspected_cover(&short));
        let long = header_of(vec![
            stream_of(MediaType::Audio, Some(40_000_000), None, None),
            stream_of(MediaType::Video, Some(1_500_000), Some(45), video_params()),
        ]);
        assert!(!suspected_cover(&long));
    }

    #[test]
    fn 封面启发式_单帧流兜底命中() {
        // 个别封装把封面轨时长写成与音频等长（时长判据失效），nb_frames=1 兜底
        let h = header_of(vec![
            stream_of(MediaType::Audio, Some(2_000_000), None, None),
            stream_of(MediaType::Video, Some(2_000_000), Some(1), video_params()),
        ]);
        assert!(suspected_cover(&h));
        // 时长缺失 + 单帧，同样命中
        let no_dur = header_of(vec![
            stream_of(MediaType::Audio, Some(2_000_000), None, None),
            stream_of(MediaType::Video, None, Some(1), video_params()),
        ]);
        assert!(suspected_cover(&no_dur));
    }

    #[test]
    fn 封面启发式_纯音频mp4整体回退() {
        // ③ covr 盲区兜底：mp4 家族 attached_pic 封面不是 trak，ye 头里
        // 只剩音频流（vec-cover.m4a 实测形状）——判疑似，回退权威轨。
        let h = header_of(vec![stream_of(
            MediaType::Audio,
            Some(2_000_000),
            None,
            None,
        )]);
        assert!(suspected_cover(&h));
    }

    #[test]
    fn ye摘要_帧率由样本数与流时长推导() {
        // mp4 读侧 frame_rate 恒 None：90 帧 / 3s = 30fps；宽高取 stsd
        let h = header_of(vec![stream_of(
            MediaType::Video,
            Some(3_000_000),
            Some(90),
            video_params(),
        )]);
        let s = summarize_ye_header(&h);
        assert_eq!(s.width, 320);
        assert_eq!(s.height, 240);
        assert!((s.fps - 30.0).abs() < 1e-9);
        assert!(!s.has_audio);
        // 零时长/零帧不推帧率（保持 0，不造数）
        let degenerate = header_of(vec![stream_of(
            MediaType::Video,
            Some(0),
            Some(1),
            video_params(),
        )]);
        assert_eq!(summarize_ye_header(&degenerate).fps, 0.0);
    }

    // ---- 双引擎对拍向量（施工图 §3.1 配方写死）----
    // 运行前置：ffmpeg/ffprobe 须可定位——ffprobe 轨走生产解析器
    // （ffmpeg_info：BJ_FFMPEG_DIR → sidecar → PATH），向量生成走本模块
    // 定位器（BJ_FFMPEG_DIR → PATH → 仓相对 ../../duan/src-tauri/binaries，
    // 施工图 §2.5 口径）。本机把 duan/src-tauri/binaries 加进 PATH 即全中。
    // 工具缺席一律判失败（panic），不假绿跳过；jian CI 只跑 cargo check，
    // 不跑本组测试。

    /// 定位 ffmpeg/ffprobe 所在目录；全落空 → panic（测试失败）。
    fn locate_binaries_dir() -> PathBuf {
        let exe = |name: &str| {
            if cfg!(windows) {
                format!("{name}.exe")
            } else {
                name.to_string()
            }
        };
        let has_pair =
            |dir: &Path| dir.join(exe("ffmpeg")).is_file() && dir.join(exe("ffprobe")).is_file();
        if let Some(dir) = std::env::var_os("BJ_FFMPEG_DIR").map(PathBuf::from) {
            if has_pair(&dir) {
                return dir;
            }
        }
        if let Some(path_var) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path_var) {
                if has_pair(&dir) {
                    return dir;
                }
            }
        }
        let repo_relative =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../duan/src-tauri/binaries");
        if has_pair(&repo_relative) {
            return repo_relative;
        }
        panic!(
            "找不到 ffmpeg/ffprobe（已试 BJ_FFMPEG_DIR、PATH、../../duan/src-tauri/binaries）；\
             对拍测试工具缺席判失败，不跳过"
        );
    }

    /// 跑 ffmpeg 生成一条向量；非零退出即 panic（向量生成失败＝测试失败，不许跳过）。
    fn run_ffmpeg(ffmpeg: &Path, args: &[&str], out: &Path) {
        let mut cmd = std::process::Command::new(ffmpeg);
        cmd.arg("-v").arg("error");
        for a in args {
            cmd.arg(a);
        }
        cmd.arg(out);
        let result = cmd
            .output()
            .unwrap_or_else(|e| panic!("启动 ffmpeg 失败: {e}"));
        assert!(
            result.status.success(),
            "生成向量失败（{}）: {}",
            out.display(),
            stderr_tail(&result.stderr)
        );
    }

    /// 生成全套对拍向量（进程内一次，lavfi 确定性源；配方施工图 §3.1）。
    /// 返回向量目录：vec.mp4 / vec-audio.m4a / cover.jpg / vec-cover.m4a。
    fn ensure_vectors() -> PathBuf {
        static DIR: OnceLock<PathBuf> = OnceLock::new();
        DIR.get_or_init(|| {
            let ffmpeg = locate_binaries_dir().join(if cfg!(windows) {
                "ffmpeg.exe"
            } else {
                "ffmpeg"
            });
            let dir = std::env::temp_dir().join(format!("jian-probe-vec-{}", std::process::id()));
            std::fs::create_dir_all(&dir).expect("创建向量目录失败");
            // 视频：3s 320x240 30fps H.264 Baseline（ye 解码面与 probe 双轨共用口径）
            run_ffmpeg(
                &ffmpeg,
                &[
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
                ],
                &dir.join("vec.mp4"),
            );
            // 音频：2s 立体声正弦 48k AAC
            run_ffmpeg(
                &ffmpeg,
                &[
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
                ],
                &dir.join("vec-audio.m4a"),
            );
            // 封面 jpg（单帧）
            run_ffmpeg(
                &ffmpeg,
                &[
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=320x240:rate=1",
                    "-frames:v",
                    "1",
                ],
                &dir.join("cover.jpg"),
            );
            // 带封面 m4a：音频 + mjpeg 封面轨（disposition attached_pic）
            run_ffmpeg(
                &ffmpeg,
                &[
                    "-i",
                    dir.join("vec-audio.m4a").to_str().unwrap(),
                    "-i",
                    dir.join("cover.jpg").to_str().unwrap(),
                    "-map",
                    "0:a",
                    "-map",
                    "1:v",
                    "-c:v",
                    "mjpeg",
                    "-disposition:v:0",
                    "attached_pic",
                ],
                &dir.join("vec-cover.m4a"),
            );
            dir
        })
        .clone()
    }

    fn probe(path: &Path, engine: Option<&str>) -> Result<ProbeResult, String> {
        probe_media(
            path.to_string_lossy().into_owned(),
            engine.map(|e| e.to_string()),
        )
    }

    // 验收 ①：mp4 向量双轨判等——宽高/hasAudio/kind 精确等；durationUs
    // 容差 1000µs（容器 timescale 换算来源不同）；fps 相对差 ≤ 1e-3
    // （ye 由样本数/时长推导，ffprobe 取 avg_frame_rate）。
    #[test]
    fn mp4向量ye轨与ffprobe轨判等() {
        let dir = ensure_vectors();
        let ye_res = probe(&dir.join("vec.mp4"), Some("ye")).expect("ye 轨应成功");
        let ff_res = probe(&dir.join("vec.mp4"), Some("ffmpeg")).expect("ffmpeg 轨应成功");
        assert_eq!(ye_res.used_engine, "ye");
        assert_eq!(ff_res.used_engine, "ffmpeg");
        assert_eq!(ye_res.width, ff_res.width);
        assert_eq!(ye_res.height, ff_res.height);
        assert_eq!(ye_res.has_audio, ff_res.has_audio);
        assert_eq!(ye_res.kind, ff_res.kind);
        assert!(
            (ye_res.duration_us - ff_res.duration_us).abs() <= 1000,
            "durationUs 超容差：ye={} ffprobe={}",
            ye_res.duration_us,
            ff_res.duration_us
        );
        let ff_fps = ff_res.fps;
        assert!(ff_fps > 0.0);
        let rel = ((ye_res.fps - ff_fps) / ff_fps).abs();
        assert!(
            rel <= 1e-3,
            "fps 相对差超容差：ye={} ffprobe={}",
            ye_res.fps,
            ff_fps
        );
    }

    // 验收 ②：带封面 m4a（attached_pic 向量）启发式命中 → 整体回退
    // ffprobe；结果与显式 ffmpeg 轨完全一致，kind=audio 不误报 video。
    // 实测（2026-10-27）：mp4 家族的 attached_pic 封面写在 moov.udta.meta
    // 的 covr 原子而非 trak——ye 头里看不到任何视频流，①② 无从命中，
    // 由启发式③（covr 盲区兜底）触发回退。
    #[test]
    fn 带封面m4a启发式命中整体回退_ffprobe口径() {
        let dir = ensure_vectors();
        let m4a = dir.join("vec-cover.m4a");
        // 证据锁定：ye 头只剩一条音频流（封面在 covr，ye 全盲），启发式
        // 仍要命中（③），不是靠 ye Err 误打误撞回退：
        let header = ye_header(m4a.to_string_lossy().as_ref()).expect("ye 应能读出封面 m4a 头");
        assert_eq!(
            header
                .streams
                .iter()
                .filter(|st| st.media_type == MediaType::Video)
                .count(),
            0,
            "covr 封面不应出现在 ye 头的流表里"
        );
        assert!(suspected_cover(&header), "封面向量应命中疑似封面启发式");
        // ye 轨裸跑 kind 不误报（封面不可见），但时长含 AAC priming、
        // 与权威轨有毫秒级分歧（实测 2026667µs vs 2000000µs）——回退动机：
        let raw_ye = probe(&m4a, Some("ye")).expect("显式 ye 应成功（读头不解码）");
        assert_eq!(raw_ye.kind, "audio");
        let explicit = probe(&m4a, Some("ffmpeg")).expect("显式 ffmpeg 应成功");
        assert_ne!(raw_ye.duration_us, explicit.duration_us);
        // auto：回退后与显式 ffmpeg 轨逐字段完全一致
        let auto = probe(&m4a, None).expect("auto 应经回退成功");
        assert_eq!(auto.used_engine, "ffmpeg");
        assert_eq!(auto.kind, "audio"); // 不误报 video
        assert_eq!(auto.duration_us, explicit.duration_us);
        assert_eq!(auto.width, explicit.width);
        assert_eq!(auto.height, explicit.height);
        assert_eq!(auto.fps, explicit.fps);
        assert_eq!(auto.has_audio, explicit.has_audio);
    }

    // 验收 ③：非 mp4 素材（jpg）auto 落 ffprobe 轨且 usedEngine=ffmpeg。
    #[test]
    fn 非mp4素材auto落ffprobe轨() {
        let dir = ensure_vectors();
        let jpg = dir.join("cover.jpg");
        let r = probe(&jpg, None).expect("jpg 应经 ffprobe 轨成功");
        assert_eq!(r.used_engine, "ffmpeg");
        assert_eq!(r.kind, "image");
        assert_eq!(r.duration_us, 0);
        assert_eq!(r.fps, 0.0);
    }

    // 验收 ④：显式 engine=ffmpeg 不触 ye——同一 mp4 上 auto 落 ye、显式
    // ffmpeg 落 ffprobe（usedEngine 由产出轨盖章：若显式请求误走 ye 轨，
    // 此处会得到 "ye" 而翻车）。
    #[test]
    fn 显式ffmpeg引擎不触ye轨() {
        let dir = ensure_vectors();
        let mp4 = dir.join("vec.mp4");
        assert_eq!(probe(&mp4, None).unwrap().used_engine, "ye");
        assert_eq!(probe(&mp4, Some("ffmpeg")).unwrap().used_engine, "ffmpeg");
    }
}
