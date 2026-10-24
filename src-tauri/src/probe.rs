//! 媒体探测双引擎：MP4 系（ftyp 嗅探）优先走 ye（百工·冶，ContainerRegistry
//! 自动探测），失败或非 MP4 回退 ffprobe——回退一律记原因日志，不得静默掩盖
//! ye 的 bug；ffprobe 同时是开发期对拍 oracle。时间一律微秒；图片按零时长
//! 素材处理（types.ts 的 image 约定）。

use std::io::{BufReader, Read};
use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use ye::codec::MediaType;
use ye::container::mp4::register_mp4;
use ye::container::{ContainerRegistry, MediaHeader, Stream};
use ye::time::Rational;

use crate::ffmpeg::{ffmpeg_info, stderr_tail};

/// ffprobe / ye 共同产出的探测结果（camelCase 序列化，对齐前端 MediaAsset 字段名）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub duration_us: i64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_audio: bool,
    pub kind: String,
}

/// 探测一个媒体文件，失败时把原因带回前端。
///
/// 双引擎判定面：文件头 12 字节内是 ftyp/styp box（MP4 系，含 m4a/m4v/fMP4
/// 段）→ 先走 ye；ye 出错（解析失败、IO、bug）→ warn 记原因后回退 ffprobe。
/// 非 MP4 系（mp3/wav/图片/mkv…）ye 尚无对应容器，直接走 ffprobe（debug 记
/// 路由原因）。ffprobe 自身失败则如实报错——两个引擎都失败时把 ffprobe 的
/// 错误带给前端（与单引擎时期行为一致）。
#[tauri::command(async)]
pub fn probe_media(path: String) -> Result<ProbeResult, String> {
    match sniff_is_mp4_family(&path) {
        Ok(true) => match probe_with_ye(&path) {
            Ok(result) => Ok(result),
            Err(ye_err) => {
                // ye 的 bug 不许静默：回退原因必须留痕（tauri-plugin-log 落到前端控制台）
                log::warn!("ye 探测失败，回退 ffprobe（{path}）：{ye_err}");
                probe_with_ffprobe(&path)
            }
        },
        Ok(false) => {
            log::debug!("非 MP4 系（ftyp 嗅探未命中），直接走 ffprobe（{path}）");
            probe_with_ffprobe(&path)
        }
        Err(e) => {
            // 嗅探读不动（不存在/无权限）：交给 ffprobe 产出统一的用户向报错
            log::warn!("ftyp 嗅探读文件失败，走 ffprobe（{path}）：{e}");
            probe_with_ffprobe(&path)
        }
    }
}

// —— 判定面：ftyp 嗅探 ——

/// 文件头是否 MP4 系（纯函数，供单测）：≥8 字节、首 box size ≥ 8 且类型为
/// ftyp/styp。规则与 ye MP4 工厂的 probe_mp4（ye-container-mp4 adapter.rs）
/// 同源；brand 是否在常见集不影响路由——进了 ye 还有 ContainerRegistry
/// 自动探测打分兜底。
fn head_is_mp4_family(head: &[u8]) -> bool {
    if head.len() < 8 {
        return false;
    }
    let size = u32::from_be_bytes(head[0..4].try_into().unwrap()) as u64;
    size >= 8 && (&head[4..8] == b"ftyp" || &head[4..8] == b"styp")
}

/// 读文件头做 ftyp 嗅探；短文件按实际长度判。
fn sniff_is_mp4_family(path: &str) -> std::io::Result<bool> {
    let mut file = std::fs::File::open(path)?;
    let mut head = [0u8; 8];
    let mut filled = 0usize;
    while filled < head.len() {
        let n = file.read(&mut head[filled..])?;
        if n == 0 {
            break; // EOF：短文件按已读部分判
        }
        filled += n;
    }
    Ok(head_is_mp4_family(&head[..filled]))
}

// —— ye 引擎 ——

/// ye 探测：注册表挂 MP4 工厂后 auto-probe 打开 + 读头，一步式
/// （ContainerRegistry::probe，ye 文档明说 jian 列素材信息直接用它）。
fn run_ye_probe(path: &str) -> Result<(String, MediaHeader), String> {
    let file = std::fs::File::open(path).map_err(|e| format!("打开文件失败（{path}）: {e}"))?;
    let mut registry = ContainerRegistry::new();
    register_mp4(&mut registry);
    registry
        .probe(Box::new(BufReader::new(file)))
        .map_err(|e| format!("ye 探测失败: {e}"))
}

fn probe_with_ye(path: &str) -> Result<ProbeResult, String> {
    let (_, header) = run_ye_probe(path)?;
    header_to_probe_result(&header, path)
}

/// ye 头信息 → ProbeResult（纯函数，供单测与对拍）。
///
/// 剪在 ffprobe 路径踩过的四个坑，ye 路径的对齐情况：
/// ① attached_pic 封面流：MP4 系里 ffmpeg 把封面写成 moov 元数据里的 covr
///    盒（movenc 行为），不落成 trak 轨道；ye 的 MP4 reader 对 udta 等
///    非轨道 box 一律跳过，不会把封面合成流——ye 路径天然无此坑（mp3/flac
///    的封面流坑仍在 ffprobe 路径处理，见 parse_probe_json）。若未来 ye 把
///    covr 暴露成流，对拍测试（对拍_ye与ffprobe_小mp4关键字段一致）会顶出差异。
/// ② 扩展名优先判图片：与 ffprobe 路径共用 classify_media_kind，扩展名
///    集合与次序完全一致（ftyp 命中但扩展名是 .png/.jpg 的仍判 image）。
/// ③ avg_frame_rate 0/0 回退：ye 的 VideoParams.frame_rate 当前恒 None
///    （MP4 box 无权威帧率字段），回退链为 nb_frames ÷ 流时长——与 ffprobe
///    对 MP4 的 avg_frame_rate 同一公式（CFR 精确，VFR 近似），再缺失退 0，
///    语义等价 ffprobe 侧的 avg_frame_rate → r_frame_rate → 0 链。
/// ④ 容器无时长退流时长：ye 的 MP4 read_header 本就把容器时长算成
///    「各轨时长最大值」（adapter.rs），等价 ffprobe 侧的容器缺时长退流
///    时长最大值；两边都拿不到时 ye 为 None → 0。
fn header_to_probe_result(h: &MediaHeader, path: &str) -> Result<ProbeResult, String> {
    let mut has_video = false;
    let mut has_audio = false;
    let mut width = 0u32;
    let mut height = 0u32;
    let mut fps = 0.0;
    // 画幅/帧率取第一条视频流；音频流只标记存在性（与 ffprobe 侧同策略）
    for s in &h.streams {
        match s.media_type {
            MediaType::Video if !has_video => {
                has_video = true;
                if let Some(v) = &s.codec.video {
                    width = v.width;
                    height = v.height;
                }
                fps = s
                    .codec
                    .video
                    .as_ref()
                    .and_then(|v| v.frame_rate)
                    .map(|r| r.to_f64())
                    .or_else(|| approx_stream_fps(s))
                    .unwrap_or(0.0);
            }
            MediaType::Video => {}
            MediaType::Audio => has_audio = true,
            MediaType::Subtitle => {}
        }
    }

    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let kind = classify_media_kind(ext, has_video, has_audio)
        .map_err(|e| format!("{e}: {path}"))?
        .to_string();

    // 容器级时长已在 ye read_header 里取过「各轨最大值」（坑④）；
    // canonical 时基（1/7_056_000）精确重标度到微秒
    let duration_us: i64 = h
        .duration
        .and_then(|d| d.rescale(Rational::new(1, 1_000_000)).ok())
        .map(|t| t.ticks())
        .unwrap_or(0);

    // 图片是零时长素材：durationUs=0、fps=0（types.ts:53）
    let (duration_us, fps) = if kind == "image" {
        (0, 0.0)
    } else {
        (duration_us, fps)
    };

    Ok(ProbeResult {
        duration_us,
        width,
        height,
        fps,
        has_audio,
        kind,
    })
}

/// 帧率近似（坑③回退）：样例数 ÷ 流时长；帧数或时长缺失/为 0 → None。
/// ye-cli probe 同款公式。
fn approx_stream_fps(s: &Stream) -> Option<f64> {
    let frames = s.nb_frames? as f64;
    let secs = s
        .duration
        .map(|d| d.to_seconds())
        .filter(|x| *x > 0.0)?;
    Some(frames / secs)
}

// —— ffprobe 引擎（oracle 与回退）——

/// 跑 ffprobe 进程并解析 JSON（供回退路径与对拍测试取原始结构）。
fn run_ffprobe_json(path: &str) -> Result<Value, String> {
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
    serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("解析 ffprobe 输出失败（{path}）: {e}"))
}

fn probe_with_ffprobe(path: &str) -> Result<ProbeResult, String> {
    let json = run_ffprobe_json(path)?;
    parse_probe_json(&json, path)
}

/// 媒体种类判定（纯函数，供单测）。次序写死：
/// ① 扩展名 ∈ 图片集合 → image（实测 ffprobe 对 PNG 报 codec_type=video/png_pipe，
///    流判定放在前则图片永远走不到，必须扩展名优先）；
/// ② 有视频流 → video（gif 走此支，取真实 fps）；
/// ③ 有音频流 → audio；④ 否则报错。
fn classify_media_kind(ext: &str, has_video: bool, has_audio: bool) -> Result<&'static str, String> {
    match ext.to_ascii_lowercase().as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "bmp" => Ok("image"),
        _ if has_video => Ok("video"),
        _ if has_audio => Ok("audio"),
        _ => Err("无法识别的媒体".to_string()),
    }
}

/// 从 ffprobe JSON 拆字段（纯函数，供单测）。
fn parse_probe_json(v: &Value, path: &str) -> Result<ProbeResult, String> {
    let streams: Vec<Value> = v["streams"].as_array().cloned().unwrap_or_default();
    let mut has_video = false;
    let mut has_audio = false;
    let mut width = 0u32;
    let mut height = 0u32;
    let mut fps = 0.0;
    // 画幅/帧率取第一条视频流；音频流只标记存在性
    for s in &streams {
        // 内嵌封面不算内容视频流：带封面的 mp3/m4a/flac 实测会多出一条
        // codec_type=video 的 mjpeg 流（disposition.attached_pic=1），不剔除会被
        // 误判成 video——素材进不了音频轨，导出时封面还会整段叠在成片上。
        let is_cover = s["disposition"]["attached_pic"].as_i64() == Some(1);
        match s["codec_type"].as_str() {
            Some("video") if is_cover => {}
            Some("video") if !has_video => {
                has_video = true;
                width = s["width"].as_u64().unwrap_or(0).min(u32::MAX as u64) as u32;
                height = s["height"].as_u64().unwrap_or(0).min(u32::MAX as u64) as u32;
                // 帧率用 avg_frame_rate；个别封装报 0/0，退回 r_frame_rate
                fps = s["avg_frame_rate"]
                    .as_str()
                    .and_then(parse_rate)
                    .or_else(|| s["r_frame_rate"].as_str().and_then(parse_rate))
                    .unwrap_or(0.0);
            }
            Some("video") => {}
            Some("audio") => has_audio = true,
            _ => {}
        }
    }

    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let kind = classify_media_kind(ext, has_video, has_audio)
        .map_err(|e| format!("{e}: {path}"))?
        .to_string();

    // 时长优先取容器 format.duration，缺了再取流时长最大值
    let duration_us = v["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .map(|sec| (sec * 1e6).round() as i64)
        .unwrap_or_else(|| stream_max_duration_us(&streams));

    // 图片是零时长素材：durationUs=0、fps=0（types.ts:53）
    let (duration_us, fps) = if kind == "image" { (0, 0.0) } else { (duration_us, fps) };

    Ok(ProbeResult {
        duration_us,
        width,
        height,
        fps,
        has_audio,
        kind,
    })
}

/// 流时长最大值（微秒）。部分音频格式只有流级 duration，没有容器级。
fn stream_max_duration_us(streams: &[Value]) -> i64 {
    streams
        .iter()
        .filter_map(|s| s["duration"].as_str().and_then(|d| d.parse::<f64>().ok()))
        .map(|sec| (sec * 1e6).round() as i64)
        .max()
        .unwrap_or(0)
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
    use serde_json::json;
    use ye::codec::{AudioParams, CodecId, CodecParameters, VideoParams};
    use ye::container::Metadata;
    use ye::time::{CANONICAL_TIME_BASE, Timestamp};

    // ---- 既有 ffprobe 路径测试（原样保留） ----

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
        let v = json!({
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
    }

    #[test]
    fn 解析图片_json_零时长() {
        // ffprobe 对 PNG 报 video 流（png_pipe），扩展名判定使其归 image，时长/帧率清零
        let v = json!({
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
        let v = json!({
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
        let v = json!({
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
        let v = json!({
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
        let v = json!({"streams": [{"codec_type": "data"}], "format": {"duration": "1.0"}});
        let err = parse_probe_json(&v, "D:/a/x.txt").unwrap_err();
        assert!(err.contains("无法识别的媒体"), "实际报错：{err}");
        assert!(err.contains("x.txt"));
    }

    // ---- 双引擎判定面：ftyp 嗅探 ----

    /// 真实 MP4 头：size=0x18、ftyp、brand=isom
    #[test]
    fn ftyp嗅探_常见mp4头() {
        assert!(head_is_mp4_family(&[
            0x00, 0x00, 0x00, 0x18, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm'
        ]));
        // m4a 也是 MP4 系
        assert!(head_is_mp4_family(&[
            0x00, 0x00, 0x00, 0x20, b'f', b't', b'y', b'p', b'M', b'4', b'A', b' '
        ]));
        // fMP4 段头是 styp
        assert!(head_is_mp4_family(&[
            0x00, 0x00, 0x00, 0x1c, b's', b't', b'y', b'p', b'm', b's', b'd', b'h'
        ]));
    }

    #[test]
    fn ftyp嗅探_非mp4与非法头() {
        // RIFF（wav）、OggS、ID3（mp3）、PNG 魔数
        assert!(!head_is_mp4_family(b"RIFF\x00\x00\x00\x00"));
        assert!(!head_is_mp4_family(b"OggS\x00\x02\x00\x00"));
        assert!(!head_is_mp4_family(b"ID3\x04\x00\x00\x00"));
        assert!(!head_is_mp4_family(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]));
        // box 类型对但 size < 8（非法 box）
        assert!(!head_is_mp4_family(&[0, 0, 0, 4, b'f', b't', b'y', b'p']));
        // 短头
        assert!(!head_is_mp4_family(b"ftyp"));
    }

    // ---- ye 路径：header → ProbeResult ----

    /// 造一条视频流：H264、320x240、frame_rate=None（mp4 reader 现状）、
    /// 50 样例 @1/25 = 2s。
    fn ye_video_stream(index: u32) -> Stream {
        let mut codec = CodecParameters::new(CodecId::H264, MediaType::Video);
        codec.video = Some(VideoParams {
            width: 320,
            height: 240,
            pixel_format: None,
            frame_rate: None,
        });
        Stream {
            index,
            media_type: MediaType::Video,
            codec,
            time_base: Rational::new(1, 25),
            start_time: None,
            duration: Some(Timestamp::new(50, Rational::new(1, 25))),
            nb_frames: Some(50),
            metadata: Metadata::new(),
        }
    }

    fn ye_audio_stream(index: u32) -> Stream {
        let mut codec = CodecParameters::new(CodecId::Aac, MediaType::Audio);
        codec.audio = Some(AudioParams {
            sample_rate: 44_100,
            channel_layout: None,
            sample_format: None,
        });
        Stream {
            index,
            media_type: MediaType::Audio,
            codec,
            time_base: Rational::new(1, 44_100),
            start_time: None,
            duration: Some(Timestamp::new(88_200, Rational::new(1, 44_100))),
            nb_frames: Some(87),
            metadata: Metadata::new(),
        }
    }

    /// 视频流 50 样例 ÷ 2s = 25fps（坑③回退链），画幅/时长/音频标记齐全。
    #[test]
    fn ye头信息_视频音频齐全() {
        let header = MediaHeader {
            format_name: "mp4".to_string(),
            streams: vec![ye_video_stream(0), ye_audio_stream(1)],
            duration: Some(Timestamp::new(2 * 7_056_000, CANONICAL_TIME_BASE)),
            start_time: None,
            bit_rate: None,
            metadata: Metadata::new(),
        };
        let r = header_to_probe_result(&header, "D:/a/clip.mp4").unwrap();
        assert_eq!(r.kind, "video");
        assert_eq!(r.width, 320);
        assert_eq!(r.height, 240);
        assert!((r.fps - 25.0).abs() < 1e-9, "fps={}", r.fps);
        assert!(r.has_audio);
        assert_eq!(r.duration_us, 2_000_000);
    }

    /// 坑③：帧数与流时长都缺失 → fps=0（等价 ffprobe 侧 avg/r 都拿不到）。
    /// 坑④：容器时长 None → duration=0（ye read_header 已做过各轨最大值，
    /// 轨道也缺时长才会到这）。
    #[test]
    fn ye头信息_帧率时长缺失退零() {
        let mut s = ye_video_stream(0);
        s.duration = None;
        s.nb_frames = None;
        let header = MediaHeader {
            format_name: "mp4".to_string(),
            streams: vec![s],
            duration: None,
            start_time: None,
            bit_rate: None,
            metadata: Metadata::new(),
        };
        let r = header_to_probe_result(&header, "D:/a/v.mp4").unwrap();
        assert_eq!(r.kind, "video");
        assert_eq!(r.fps, 0.0);
        assert_eq!(r.duration_us, 0);
        assert!(!r.has_audio);
    }

    /// 坑②对齐：ftyp 命中进 ye、但扩展名是图片 → 仍判 image 且零时长
    /// （与 ffprobe 路径共用 classify_media_kind，次序一致）。
    #[test]
    fn ye头信息_扩展名优先判图片() {
        let header = MediaHeader {
            format_name: "mp4".to_string(),
            streams: vec![ye_video_stream(0)],
            duration: Some(Timestamp::new(7_056_000, CANONICAL_TIME_BASE)),
            start_time: None,
            bit_rate: None,
            metadata: Metadata::new(),
        };
        let r = header_to_probe_result(&header, "D:/a/pic.png").unwrap();
        assert_eq!(r.kind, "image");
        assert_eq!(r.duration_us, 0);
        assert_eq!(r.fps, 0.0);
        assert_eq!(r.width, 320); // 画幅仍带出，供前端缩略图用
    }

    /// 帧率优先用容器给的 frame_rate（当前 mp4 reader 恒 None，此处锁语义：
    /// 一旦 ye 开始填，立即优先生效，不再走近似）。
    #[test]
    fn ye头信息_frame_rate参数优先于近似() {
        let mut s = ye_video_stream(0);
        s.codec.video = Some(VideoParams {
            width: 320,
            height: 240,
            pixel_format: None,
            frame_rate: Some(Rational::new(30000, 1001)),
        });
        let header = MediaHeader {
            format_name: "mp4".to_string(),
            streams: vec![s],
            duration: Some(Timestamp::new(2 * 7_056_000, CANONICAL_TIME_BASE)),
            start_time: None,
            bit_rate: None,
            metadata: Metadata::new(),
        };
        let r = header_to_probe_result(&header, "D:/a/ntsc.mp4").unwrap();
        assert!((r.fps - 30000.0 / 1001.0).abs() < 1e-9, "fps={}", r.fps);
    }

    /// 嗅探失败（文件不存在）不 panic、返回 Err；probe_media 会转走 ffprobe。
    #[test]
    fn ftyp嗅探_文件不存在() {
        let err = sniff_is_mp4_family("Z:/definitely/not/exist.mp4").unwrap_err();
        assert!(err.kind() == std::io::ErrorKind::NotFound);
    }

    // ---- 对拍：ye vs ffprobe（PATH 无 ffmpeg 自动 skip） ----

    /// ye CodecId → ffprobe codec_name（对拍用映射，两边命名对齐）。
    fn codec_id_to_ffprobe_name(c: CodecId) -> &'static str {
        match c {
            CodecId::H264 => "h264",
            CodecId::Hevc => "hevc",
            CodecId::Av1 => "av1",
            CodecId::Vp9 => "vp9",
            CodecId::Aac => "aac",
            CodecId::Flac => "flac",
            CodecId::Opus => "opus",
            CodecId::Mp3 => "mp3",
            CodecId::Unknown => "unknown",
        }
    }

    /// 用 PATH 里的 ffmpeg 生成小 MP4（320x240 25fps 2s 视频 + 44.1kHz 立体声
    /// 音频），ye 与 ffprobe 双跑 probe，断言关键字段一致。
    /// ProbeResult 层比 kind/宽高/音频/帧率/时长；编解码与采样率 ProbeResult
    /// 没有字段，在两引擎原始结构（MediaHeader vs ffprobe JSON）上比。
    /// 流数（去掉 ffprobe 可能多报的 timed_id3 数据流后）逐流对齐。
    #[test]
    fn 对拍_ye与ffprobe_小mp4关键字段一致() {
        // 缺 ffmpeg 自动 skip（ask 约定）
        let Ok(probe) = std::process::Command::new("ffmpeg").arg("-version").output() else {
            eprintln!("skip：PATH 里没有 ffmpeg");
            return;
        };
        if !probe.status.success() {
            eprintln!("skip：ffmpeg -version 不可用");
            return;
        }

        let dir = std::env::temp_dir().join(format!("jian-probe-parity-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let mp4 = dir.join("parity.mp4");
        let gen_out = std::process::Command::new("ffmpeg")
            .args(["-y", "-hide_banner", "-loglevel", "error"])
            .args(["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=2"])
            .args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=2"])
            .args(["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"])
            .args(["-c:a", "aac", "-ac", "2", "-shortest"])
            .arg(&mp4)
            .output()
            .expect("spawn ffmpeg");
        assert!(
            gen_out.status.success(),
            "ffmpeg 生成小 MP4 失败：{}",
            String::from_utf8_lossy(&gen_out.stderr)
        );
        let path = mp4.to_str().unwrap();

        // 双引擎各跑各的（不经 probe_media 路由——对拍测的是引擎本身）
        let (_, header) = run_ye_probe(path).expect("ye probe 应成功");
        let ye_r = header_to_probe_result(&header, path).expect("ye 解析应成功");
        let ff_json = run_ffprobe_json(path).expect("ffprobe 应成功");
        let ff_r = parse_probe_json(&ff_json, path).expect("ffprobe 解析应成功");

        // —— ProbeResult 层 ——
        assert_eq!(ye_r.kind, ff_r.kind, "kind：ye={} ff={}", ye_r.kind, ff_r.kind);
        assert_eq!(ye_r.width, ff_r.width, "width");
        assert_eq!(ye_r.height, ff_r.height, "height");
        assert_eq!(ye_r.has_audio, ff_r.has_audio, "has_audio");
        assert!(
            (ye_r.fps - ff_r.fps).abs() < 0.5,
            "fps：ye={} ff={}",
            ye_r.fps,
            ff_r.fps
        );
        assert!(
            (ye_r.duration_us - ff_r.duration_us).abs() <= 50_000,
            "duration：ye={}µs ff={}µs（差 {}µs）",
            ye_r.duration_us,
            ff_r.duration_us,
            (ye_r.duration_us - ff_r.duration_us).abs()
        );

        // —— 原始结构层：编解码、采样率、流数 ——
        let ff_streams: Vec<Value> =
            ff_json["streams"].as_array().cloned().unwrap_or_default();
        // ffprobe 对 ffmpeg 产物可能多报一条 timed_id3 数据流（写 metadata 的
        // 副产物），ye 只解析 trak 轨道——按内容流（video/audio）对齐
        let ff_content: Vec<&Value> = ff_streams
            .iter()
            .filter(|s| matches!(s["codec_type"].as_str(), Some("video") | Some("audio")))
            .collect();
        let ye_content: Vec<&Stream> = header
            .streams
            .iter()
            .filter(|s| matches!(s.media_type, MediaType::Video | MediaType::Audio))
            .collect();
        assert_eq!(
            ye_content.len(),
            ff_content.len(),
            "流数：ye={} ff={}",
            ye_content.len(),
            ff_content.len()
        );
        for (y, f) in ye_content.iter().zip(ff_content.iter()) {
            let y_name = codec_id_to_ffprobe_name(y.codec.codec);
            let f_name = f["codec_name"].as_str().unwrap_or("<null>");
            assert_eq!(y_name, f_name, "编解码：ye={y_name} ff={f_name}");
            if y.media_type == MediaType::Audio {
                let y_sr = y.codec.audio.as_ref().map(|a| a.sample_rate);
                let f_sr = f["sample_rate"].as_str().and_then(|s| s.parse::<u32>().ok());
                assert_eq!(y_sr, f_sr, "采样率：ye={y_sr:?} ff={f_sr:?}");
            }
        }
        // 视频宽高在原始层再核一遍（防两引擎适配层各自吃错又恰好相等的巧合）
        let ye_v = ye_content.iter().find(|s| s.media_type == MediaType::Video);
        let ff_v = ff_content.iter().find(|s| s["codec_type"] == "video");
        if let (Some(y), Some(f)) = (ye_v, ff_v) {
            assert_eq!(y.codec.video.as_ref().unwrap().width, f["width"].as_u64().unwrap() as u32);
            assert_eq!(
                y.codec.video.as_ref().unwrap().height,
                f["height"].as_u64().unwrap() as u32
            );
        }

        // —— 路由层：probe_media 对该文件应走 ye 且成功 ——
        let routed = probe_media(mp4.to_string_lossy().into_owned()).expect("probe_media 应成功");
        assert_eq!(routed.kind, "video");
        assert_eq!(routed.width, 320);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
