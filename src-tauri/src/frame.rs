//! 抽帧双引擎：MP4 系（ftyp 嗅探）+ H.264 视频优先走 ye（百工·冶），
//! 失败或非 MP4/非 H.264 回退 ffmpeg——回退一律记原因日志，不得静默掩盖
//! ye 的 bug；ffmpeg 同时是开发期对拍 oracle。
//!
//! ## ye 主链（施工契约：seek → 解码 → 像素核 → 出图）
//!
//! 1. `Demuxer::seek`：定位到目标时刻**前一个关键帧**（ye MP4 reader
//!    语义，任意时基精确比较——目标用微秒时基构造）；
//! 2. `H264Decoder`：从关键帧起逐包解码（AVCC 输入，avcC extradata
//!    带外），直至**显示时刻 ≤ 目标时刻的最后一帧**（即预览语义下
//!    「t 时刻可见的那一帧」；目标早于首帧 → 首帧；越过目标/EOF →
//!    此前最后解出的帧）；
//! 3. 像素核 `ye::filter::video::yuv420p_to_rgba`：BT.601 有限范围
//!    （H.264 无 VUI 信号时按 limited 处理，与 swscale 默认口径一致）；
//! 4. 需要缩放时 `scale_rgba`（双线性，保持宽高比）；当前命令不带
//!    尺寸参数，恒等直通，`max_size` 留给后续缩略图档位；
//! 5. `ye::png::encode_rgba` 出 PNG（ye-png，零第三方依赖）。
//!
//! ## 引擎开关
//!
//! 环境变量 `BJ_FRAME_ENGINE=ffmpeg` 强制走 ffmpeg（诊断/对拍用）；
//! 未设置或其他值 = 默认 ye 优先、失败回退 ffmpeg（回退留 warn 日志）。

use std::cmp::Ordering as TimeOrdering;
use std::io::BufReader;

use serde::Serialize;
use ye::codec::{CodecId, Decoded, Decoder, Frame, MediaType};
use ye::codec_h264::H264Decoder;
use ye::container::mp4::register_mp4;
use ye::container::{ContainerRegistry, ReadSeek};
use ye::filter::{Yuv420pView, YuvRange, scale_rgba, yuv420p_to_rgba};
use ye::time::{Rational, Timestamp};

use crate::ffmpeg::{extract_frame_ffmpeg, unique_token};
use crate::probe::sniff_is_mp4_family;

/// 抽帧引擎选择（纯数据，供命令与测试）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameEngine {
    /// ye 优先，失败回退 ffmpeg（默认）。
    YeFirst,
    /// 只走 ffmpeg（`BJ_FRAME_ENGINE=ffmpeg`：诊断/对拍）。
    FfmpegOnly,
}

/// 由 `BJ_FRAME_ENGINE` 环境变量值解析引擎选择（纯函数，供单测）。
pub fn frame_engine_from_env(value: Option<&str>) -> FrameEngine {
    match value {
        Some("ffmpeg") => FrameEngine::FfmpegOnly,
        _ => FrameEngine::YeFirst,
    }
}

/// 抽帧结果：PNG 落盘路径 + 实际出图尺寸（引擎无关，供前端/测试核对）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameImage {
    pub path: String,
    pub width: u32,
    pub height: u32,
}

/// 抽帧命令（前端 `extract_frame` 位，签名与 ffmpeg 单引擎时期一致）：
/// 取 path 在 time_us 处的一帧写成临时目录下的 PNG，返回文件绝对路径。
///
/// 双引擎：默认 ye（MP4+H.264），失败回退 ffmpeg（warn 留痕）；
/// `BJ_FRAME_ENGINE=ffmpeg` 强制 ffmpeg。
pub fn extract_frame(path: String, time_us: i64) -> Result<String, String> {
    let engine = frame_engine_from_env(std::env::var("BJ_FRAME_ENGINE").ok().as_deref());
    match engine {
        FrameEngine::FfmpegOnly => extract_frame_ffmpeg(&path, time_us),
        FrameEngine::YeFirst => match extract_frame_ye(&path, time_us, None) {
            Ok(img) => Ok(img.path),
            Err(ye_err) => {
                // ye 的 bug 不许静默：回退原因必须留痕（tauri-plugin-log 落到前端控制台）
                log::warn!("ye 抽帧失败，回退 ffmpeg（{path}@{time_us}µs）：{ye_err}");
                extract_frame_ffmpeg(&path, time_us)
            }
        },
    }
}

// —— ye 引擎 ——

/// ye 抽帧主链：seek 关键帧 → H.264 解码至目标帧 → 像素核转 RGBA →
/// （如需）缩放 → ye-png 出图。`max_size = Some((w, h))` 时按框内
/// 最大尺寸等比缩小（小于框则原样直通）。
pub fn extract_frame_ye(
    path: &str,
    time_us: i64,
    max_size: Option<(u32, u32)>,
) -> Result<FrameImage, String> {
    let frame = decode_frame_ye(path, time_us)?;
    let rgba = frame_to_rgba_png(&frame, max_size)?;
    let out = std::env::temp_dir().join(format!("jian-frame-{}.png", unique_token()));
    std::fs::write(&out, &rgba.png)
        .map_err(|e| format!("写临时 PNG 失败（{}）: {e}", out.display()))?;
    Ok(FrameImage {
        path: out.to_string_lossy().into_owned(),
        width: rgba.width,
        height: rgba.height,
    })
}

/// 解码「time_us 时刻可见的那一帧」（显示时刻 ≤ 目标的最后一帧）。
fn decode_frame_ye(path: &str, time_us: i64) -> Result<ye::codec::VideoFrame, String> {
    if !sniff_is_mp4_family(path).map_err(|e| format!("读文件失败（{path}）: {e}"))? {
        return Err("非 MP4 系（ftyp 嗅探未命中），ye 容器暂只支持 MP4".into());
    }
    let file = std::fs::File::open(path).map_err(|e| format!("打开文件失败（{path}）: {e}"))?;
    let mut registry = ContainerRegistry::new();
    register_mp4(&mut registry);
    let input: Box<dyn ReadSeek> = Box::new(BufReader::new(file));
    let (_, mut demuxer) = registry
        .open_demuxer(input)
        .map_err(|e| format!("ye 打开解封装器失败: {e}"))?;
    let header = demuxer
        .read_header()
        .map_err(|e| format!("ye 读头失败: {e}"))?;

    let stream = header
        .streams
        .iter()
        .find(|s| s.media_type == MediaType::Video)
        .ok_or("ye 路径：无视频流")?;
    if stream.codec.codec != CodecId::H264 {
        return Err(format!(
            "ye 路径：视频编解码 {:?} 暂不支持（仅 H.264）",
            stream.codec.codec
        ));
    }
    let video_index = stream.index;

    // 目标时刻：微秒时基（seek 契约允许任意时基，内部精确比较）
    let target = Timestamp::new(time_us.max(0), Rational::new(1, 1_000_000));
    demuxer
        .seek(video_index, target)
        .map_err(|e| format!("ye seek 失败: {e}"))?;

    let mut decoder =
        H264Decoder::new(&stream.codec).map_err(|e| format!("ye H.264 解码器构造失败: {e}"))?;

    // 从关键帧起解码，保留「显示时刻 ≤ 目标的最后一帧」；越过目标或
    // EOF 即止（EOF 后 flush 排空解码器再取尾帧）。
    let mut best: Option<ye::codec::VideoFrame> = None;
    loop {
        match demuxer
            .read_packet()
            .map_err(|e| format!("ye 读包失败: {e}"))?
        {
            Some(pkt) if pkt.stream_index != video_index => continue,
            Some(pkt) => {
                decoder
                    .feed(&pkt)
                    .map_err(|e| format!("ye H.264 解码失败: {e}"))?;
                loop {
                    match decoder
                        .pull()
                        .map_err(|e| format!("ye H.264 解码失败: {e}"))?
                    {
                        Decoded::Frame(Frame::Video(v)) => {
                            let beyond = v
                                .pts()
                                .map(|p| Timestamp::compare(p, target) == TimeOrdering::Greater);
                            if beyond == Some(true) {
                                // 越过目标：best（或此前无帧则本帧）即答案
                                return Ok(best.unwrap_or(v));
                            }
                            best = Some(v);
                        }
                        Decoded::Frame(Frame::Audio(_)) => continue,
                        Decoded::NeedInput => break,
                        Decoded::Finished => return Ok(best.ok_or("ye 路径：解码无帧输出")?),
                    }
                }
            }
            None => {
                // EOF：排空解码器
                decoder.flush();
                loop {
                    match decoder
                        .pull()
                        .map_err(|e| format!("ye H.264 解码失败: {e}"))?
                    {
                        Decoded::Frame(Frame::Video(v)) => best = Some(v),
                        Decoded::Frame(Frame::Audio(_)) => continue,
                        Decoded::NeedInput | Decoded::Finished => {
                            return Ok(best.ok_or("ye 路径：解码无帧输出")?);
                        }
                    }
                }
            }
        }
    }
}

/// RGBA 出图结果（内部管线用）。
struct RgbaPng {
    png: Vec<u8>,
    width: u32,
    height: u32,
}

/// yuv420p 帧 → RGBA（BT.601 有限范围）→ 按需等比缩小 → PNG 字节。
fn frame_to_rgba_png(
    frame: &ye::codec::VideoFrame,
    max_size: Option<(u32, u32)>,
) -> Result<RgbaPng, String> {
    let (w, h) = (frame.width() as usize, frame.height() as usize);
    let layout = frame.layout();
    let view = Yuv420pView {
        y: frame.plane(0),
        y_stride: layout.plane(0).stride,
        u: frame.plane(1),
        u_stride: layout.plane(1).stride,
        v: frame.plane(2),
        v_stride: layout.plane(2).stride,
    };
    let mut rgba =
        yuv420p_to_rgba(&view, w, h, YuvRange::Limited).map_err(|e| format!("像素核失败: {e}"))?;
    let mut out_w = frame.width();
    let mut out_h = frame.height();
    if let Some((mw, mh)) = max_size
        && (out_w > mw || out_h > mh)
        && mw > 0
        && mh > 0
    {
        // 等比缩到框内（保宽高比，向下取整且 ≥1）
        let scale = (mw as f64 / out_w as f64).min(mh as f64 / out_h as f64);
        out_w = ((out_w as f64 * scale).floor() as u32).max(1);
        out_h = ((out_h as f64 * scale).floor() as u32).max(1);
        rgba = scale_rgba(&rgba, w, h, out_w as usize, out_h as usize)
            .map_err(|e| format!("缩放失败: {e}"))?;
    }
    let png =
        ye::png::encode_rgba(out_w, out_h, &rgba).map_err(|e| format!("PNG 编码失败: {e}"))?;
    Ok(RgbaPng {
        png,
        width: out_w,
        height: out_h,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // —— 测试基建 ——

    /// 生成 E2E 夹具：testsrc2 320×240 25fps 2s（libx264 ultrafast、
    /// yuv420p——CAVLC/Baseline 形态，ye H.264 主链支持域）+ 440Hz 正弦
    /// 立体声 AAC。返回夹具路径；ffmpeg 缺失即 panic（对拍测试没有
    /// oracle 就没有意义，与 probe.rs 对拍测试同策略）。
    fn ensure_fixture(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("jian-frame-e2e-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let mp4 = dir.join("fixture.mp4");
        if mp4.is_file() {
            return mp4; // 进程内复用（同 pid 同 tag）
        }
        let out = std::process::Command::new("ffmpeg")
            .args(["-y", "-hide_banner", "-loglevel", "error"])
            .args([
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x240:rate=25:duration=2",
            ])
            .args([
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=44100:duration=2",
            ])
            .args([
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
            ])
            .args(["-c:a", "aac", "-ac", "2", "-shortest"])
            .arg(&mp4)
            .output()
            .expect("spawn ffmpeg");
        assert!(
            out.status.success(),
            "ffmpeg 生成夹具失败：{}",
            String::from_utf8_lossy(&out.stderr)
        );
        mp4
    }

    /// PNG → RGB24 像素（ffmpeg 解码；PNG 无损，解码即精确回读）。
    /// 返回 (宽, 高, 像素)。
    fn decode_png_rgb(png: &std::path::Path) -> (usize, usize, Vec<u8>) {
        let bytes = std::fs::read(png).expect("读 PNG");
        // IHDR：字节 16..20 宽、20..24 高（大端）——签名 8 + 长度 4 + 类型 4
        let w = u32::from_be_bytes(bytes[16..20].try_into().unwrap()) as usize;
        let h = u32::from_be_bytes(bytes[20..24].try_into().unwrap()) as usize;
        let out = std::process::Command::new("ffmpeg")
            .args(["-y", "-hide_banner", "-loglevel", "error"])
            .arg("-i")
            .arg(png)
            .args(["-f", "rawvideo", "-pix_fmt", "rgb24"])
            .arg("-")
            .output()
            .expect("spawn ffmpeg 解 PNG");
        assert!(
            out.status.success(),
            "ffmpeg 解 PNG 失败：{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(out.stdout.len(), w * h * 3, "rawvideo 字节数应等于 w*h*3");
        (w, h, out.stdout)
    }

    /// 逐像素对拍：100% 像素 |Δ|≤tol/通道，超差即 panic 并报首个超差点。
    fn assert_pixels_within(a: &[u8], b: &[u8], tol: i32, ctx: &str) {
        assert_eq!(a.len(), b.len(), "{ctx}: 两图字节数不一致");
        for (i, (x, y)) in a.iter().zip(b).enumerate() {
            let d = (*x as i32 - *y as i32).abs();
            assert!(
                d <= tol,
                "{ctx}: 第 {} 字节（像素 {} 通道 {}）|Δ|={} > {tol}",
                i,
                i / 3,
                i % 3,
                d
            );
        }
    }

    // —— 单元：引擎开关 ——

    #[test]
    fn 引擎开关_默认ye优先() {
        assert_eq!(frame_engine_from_env(None), FrameEngine::YeFirst);
        assert_eq!(frame_engine_from_env(Some("ye")), FrameEngine::YeFirst);
        assert_eq!(frame_engine_from_env(Some("别的")), FrameEngine::YeFirst);
    }

    #[test]
    fn 引擎开关_ffmpeg强制() {
        assert_eq!(
            frame_engine_from_env(Some("ffmpeg")),
            FrameEngine::FfmpegOnly
        );
    }

    // —— E2E 对拍：同 time_us 双引擎出图，逐像素 |Δ|≤2 ——

    /// time_us 全部取帧边界（25fps → 每帧 40000µs）：ye 取「显示时刻 ≤
    /// 目标的最后一帧」、ffmpeg `-ss` 取「首帧 pts ≥ 目标」，边界点上
    /// 两语义收敛到同一帧——对拍比的是像素管线（解码→像素核→PNG），
    /// 不掺帧选择语义差。
    #[test]
    fn 对拍_ye与ffmpeg_同time_us出图逐像素一致() {
        let mp4 = ensure_fixture("parity");
        let path = mp4.to_str().unwrap();
        // 帧 0 / 9 / 18 / 49（末帧，pts 1.96s）
        for frame_us in [0i64, 9 * 40_000, 18 * 40_000, 49 * 40_000] {
            let ye_img = extract_frame_ye(path, frame_us, None)
                .unwrap_or_else(|e| panic!("ye 抽帧失败 @{frame_us}µs: {e}"));
            let ff_path = extract_frame_ffmpeg(path, frame_us)
                .unwrap_or_else(|e| panic!("ffmpeg 抽帧失败 @{frame_us}µs: {e}"));
            assert_eq!(ye_img.width, 320, "ye 出图宽 @{frame_us}µs");
            assert_eq!(ye_img.height, 240, "ye 出图高 @{frame_us}µs");
            let (yw, yh, ypix) = decode_png_rgb(std::path::Path::new(&ye_img.path));
            let (fw, fh, fpix) = decode_png_rgb(std::path::Path::new(&ff_path));
            assert_eq!((yw, yh), (320, 240), "ye PNG 尺寸 @{frame_us}µs");
            assert_eq!((fw, fh), (320, 240), "ffmpeg PNG 尺寸 @{frame_us}µs");
            assert_pixels_within(&ypix, &fpix, 2, &format!("对拍 @{frame_us}µs"));
        }
    }

    // —— E2E：ye 语义边界 ——

    #[test]
    fn ye抽帧_目标越过末帧_取末帧() {
        let mp4 = ensure_fixture("parity");
        let path = mp4.to_str().unwrap();
        // 末帧（帧 49）与「越界 5s」应产出同一帧：PNG 编码确定性 → 字节相等
        let last = extract_frame_ye(path, 49 * 40_000, None).expect("ye 抽末帧");
        let beyond = extract_frame_ye(path, 5_000_000, None).expect("ye 抽越界时刻");
        let a = std::fs::read(&last.path).expect("读末帧 PNG");
        let b = std::fs::read(&beyond.path).expect("读越界 PNG");
        assert_eq!(a, b, "越过末帧应回落到末帧（同一帧 → 同字节 PNG）");
    }

    #[test]
    fn ye抽帧_目标早于首帧_取首帧() {
        let mp4 = ensure_fixture("parity");
        let path = mp4.to_str().unwrap();
        let first = extract_frame_ye(path, 0, None).expect("ye 抽首帧");
        let before = extract_frame_ye(path, -1_000_000, None).expect("ye 抽负时刻");
        let a = std::fs::read(&first.path).expect("读首帧 PNG");
        let b = std::fs::read(&before.path).expect("读负时刻 PNG");
        assert_eq!(a, b, "负时刻钳 0 后应与首帧同图");
    }

    #[test]
    fn ye抽帧_max_size等比缩小() {
        let mp4 = ensure_fixture("parity");
        let path = mp4.to_str().unwrap();
        let img = extract_frame_ye(path, 0, Some((160, 90))).expect("ye 抽帧（缩放档）");
        // 320×240 等比进 160×90 框 → 120×90（宽受限）
        assert_eq!((img.width, img.height), (120, 90));
        let (w, h, pix) = decode_png_rgb(std::path::Path::new(&img.path));
        assert_eq!((w, h), (120, 90));
        assert_eq!(pix.len(), 120 * 90 * 3);
    }

    #[test]
    fn ye抽帧_非mp4报错() {
        let dir = std::env::temp_dir().join(format!("jian-frame-e2e-{}-txt", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let txt = dir.join("not-media.txt");
        std::fs::write(&txt, b"plain text").expect("写文本");
        let err = extract_frame_ye(txt.to_str().unwrap(), 0, None).expect_err("文本文件应报错");
        assert!(err.contains("非 MP4 系"), "错误应注明非 MP4 系：{err}");
    }
}
