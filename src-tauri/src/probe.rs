//! ffprobe 探测封装：媒体文件元数据 → 前端 MediaAsset 所需字段（M1 施工契约 §1）。
//! 时间一律微秒；图片按零时长素材处理（types.ts 的 image 约定）。

use serde::Serialize;
use serde_json::Value;

use crate::ffmpeg::{ffmpeg_info, stderr_tail};

/// ffprobe 探测结果（camelCase 序列化，对齐前端 MediaAsset 字段名）。
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
#[tauri::command(async)]
pub fn probe_media(path: String) -> Result<ProbeResult, String> {
    let ffprobe = ffmpeg_info()?.ffprobe_path;
    let out = std::process::Command::new(&ffprobe)
        .arg("-v")
        .arg("error")
        .arg("-print_format")
        .arg("json")
        .arg("-show_format")
        .arg("-show_streams")
        .arg(&path)
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
    parse_probe_json(&json, &path)
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

    let ext = std::path::Path::new(path)
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
}
