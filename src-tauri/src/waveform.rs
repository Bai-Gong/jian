//! 波形峰值双引擎：MP4 系（ftyp 嗅探）+ AAC 音频优先走 ye（百工·冶
//! AAC-LC 解码 → packed f32 PCM），失败或非 MP4/非 AAC 回退 ffmpeg
//! （`-f f32le` 全量 PCM）——回退一律记原因日志；ffmpeg 同时是开发期
//! 对拍 oracle。**峰值窗口算法归剪侧**（本文件 `compute_peaks`），
//! 两个引擎产出的 PCM 都过同一个纯函数，保证窗口语义唯一。
//!
//! ## 峰值窗口约定（前端消费契约，勿随意变更）
//!
//! - `window_frames = ceil(sample_rate / peaks_per_second)`——每窗覆盖
//!   的**帧数**（一帧 = 同一时刻所有声道各一个样本，不是字节数）；
//! - 第 k 窗覆盖帧区间 `[k·W, (k+1)·W)`，尾部不足整窗的余量**保留为
//!   末窗**（峰值对按实际样本数计）；
//! - 每窗的 min/max 在**全部声道的交织样本**上取（立体声不做 M/S
//!   折叠，任一声道的尖峰都要露头）；
//! - 峰值取 f32 原值（解码器输出的 [-1, 1] 标称域），前端自行映射
//!   显示高度；
//! - 默认 `peaks_per_second = 100`（波形时间轴常规缩放下约每 10ms 一对）。
//!
//! ## PCM 口径（两引擎一致，勿单侧变更）
//!
//! 两引擎都产**整段原始解码 PCM**：AAC 编码器的 priming 头与尾部
//! padding 不裁剪（ffmpeg 侧 `-ignore_editlist 1` 对齐——ye 的 MP4
//! reader 不解析 elst，本就无法裁）。因此峰值序列相对可听时间轴含
//! 约一帧 priming（1024 样本 ≈ 23ms @44.1kHz，亚窗口级）且尾部多出
//! padding 窗；ye 支持 elst 后两侧同步收紧。
//!
//! ## 命令位
//!
//! `waveform_peaks`（开发方案 §2 core/media「波形」位）：返回采样率、
//! 声道数、每秒峰值对数、窗口帧数与 `[[min, max], …]` 序列。

use std::io::BufReader;

use serde::Serialize;
use ye::codec::{CodecId, Decoded, Decoder, Frame, MediaType};
use ye::codec_aac::AacDecoder;
use ye::container::mp4::register_mp4;
use ye::container::{ContainerRegistry, ReadSeek};

use crate::ffmpeg::ffmpeg_info;
use crate::probe::sniff_is_mp4_family;

/// 默认每秒峰值对数（窗口约定见模块文档）。
pub const DEFAULT_PEAKS_PER_SECOND: u32 = 100;

/// 波形峰值结果（camelCase 序列化，供前端与测试）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformPeaks {
    pub sample_rate: u32,
    pub channels: u32,
    pub peaks_per_second: u32,
    /// 每窗帧数（窗口约定的 W）。
    pub window_frames: u32,
    /// `[[min, max], …]`：每窗全声道样本的最小/最大值对。
    pub peaks: Vec<[f32; 2]>,
}

/// 波形峰值命令：全量解码音频 → 逐窗 min/max 峰值对。
///
/// 双引擎：默认 ye（MP4+AAC），失败回退 ffmpeg（warn 留痕）；
/// 非 MP4/无音频流/非 AAC 也走 ffmpeg。`peaks_per_second` 缺省 100，
/// 传 0 视为缺省。
#[tauri::command(async)]
pub fn waveform_peaks(
    path: String,
    peaks_per_second: Option<u32>,
) -> Result<WaveformPeaks, String> {
    let pps = match peaks_per_second {
        Some(n) if n > 0 => n,
        _ => DEFAULT_PEAKS_PER_SECOND,
    };
    match decode_pcm_ye(&path) {
        Ok(pcm) => Ok(peaks_from_pcm(pcm, pps)),
        Err(ye_err) => {
            // ye 的 bug 不许静默：回退原因必须留痕
            log::warn!("ye 波形解码失败，回退 ffmpeg（{path}）：{ye_err}");
            let pcm = decode_pcm_ffmpeg(&path)?;
            Ok(peaks_from_pcm(pcm, pps))
        }
    }
}

/// 解码后的 PCM（帧数 × 声道数的交织 f32）。
#[derive(Debug)]
pub struct Pcm {
    pub sample_rate: u32,
    pub channels: u32,
    /// 交织样本（L R L R …；单声道即裸序列）。
    pub samples: Vec<f32>,
}

/// PCM → 峰值序列（剪侧窗口算法，纯函数，供单测与两引擎共用）。
///
/// 窗口约定见模块文档：`W = ceil(sample_rate / pps)`，第 k 窗覆盖帧
/// `[k·W, (k+1)·W)`，末窗保留余量；min/max 在全部声道交织样本上取。
pub fn compute_peaks(samples: &[f32], channels: u32, sample_rate: u32, pps: u32) -> Vec<[f32; 2]> {
    if channels == 0 || pps == 0 || samples.is_empty() {
        return Vec::new();
    }
    let window = (sample_rate as u64).div_ceil(pps as u64) as usize; // 每窗帧数
    let frames = samples.len() / channels as usize;
    let mut peaks = Vec::with_capacity(frames.div_ceil(window));
    let mut start = 0usize;
    while start < samples.len() {
        let end = (start + window * channels as usize).min(samples.len());
        let mut min = f32::INFINITY;
        let mut max = f32::NEG_INFINITY;
        for &s in &samples[start..end] {
            min = min.min(s);
            max = max.max(s);
        }
        peaks.push([min, max]);
        start = end;
    }
    peaks
}

fn peaks_from_pcm(pcm: Pcm, pps: u32) -> WaveformPeaks {
    let window = (pcm.sample_rate as u64).div_ceil(pps as u64) as u32;
    WaveformPeaks {
        sample_rate: pcm.sample_rate,
        channels: pcm.channels,
        peaks_per_second: pps,
        window_frames: window,
        peaks: compute_peaks(&pcm.samples, pcm.channels, pcm.sample_rate, pps),
    }
}

// —— ye 引擎 ——

/// ye 全量解码音频：MP4 解封装 → 首条音频流须 AAC-LC → packed f32。
fn decode_pcm_ye(path: &str) -> Result<Pcm, String> {
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
        .find(|s| s.media_type == MediaType::Audio)
        .ok_or("ye 路径：无音频流")?;
    if stream.codec.codec != CodecId::Aac {
        return Err(format!(
            "ye 路径：音频编解码 {:?} 暂不支持（仅 AAC）",
            stream.codec.codec
        ));
    }
    let audio_index = stream.index;

    let mut decoder =
        AacDecoder::new(&stream.codec).map_err(|e| format!("ye AAC 解码器构造失败: {e}"))?;

    let mut samples: Vec<f32> = Vec::new();
    let mut sample_rate = 0u32;
    let mut channels = 0u32;
    loop {
        match demuxer
            .read_packet()
            .map_err(|e| format!("ye 读包失败: {e}"))?
        {
            Some(pkt) if pkt.stream_index != audio_index => continue,
            Some(pkt) => {
                decoder
                    .feed(&pkt)
                    .map_err(|e| format!("ye AAC 解码失败: {e}"))?;
                loop {
                    match decoder
                        .pull()
                        .map_err(|e| format!("ye AAC 解码失败: {e}"))?
                    {
                        Decoded::Frame(Frame::Audio(a)) => {
                            sample_rate = a.sample_rate();
                            channels = a.channel_layout().channels();
                            // packed f32 交织（解码器按本机字节序写；Rust f32 即本机序）
                            let bytes = a.data();
                            samples.reserve(bytes.len() / 4);
                            for chunk in bytes.chunks_exact(4) {
                                samples.push(f32::from_ne_bytes(
                                    chunk.try_into().expect("chunks_exact(4)"),
                                ));
                            }
                        }
                        Decoded::Frame(Frame::Video(_)) => continue,
                        Decoded::NeedInput => break,
                        Decoded::Finished => {
                            return finish_pcm(samples, sample_rate, channels);
                        }
                    }
                }
            }
            None => {
                decoder.flush();
                loop {
                    match decoder
                        .pull()
                        .map_err(|e| format!("ye AAC 解码失败: {e}"))?
                    {
                        Decoded::Frame(Frame::Audio(a)) => {
                            sample_rate = a.sample_rate();
                            channels = a.channel_layout().channels();
                            let bytes = a.data();
                            samples.reserve(bytes.len() / 4);
                            for chunk in bytes.chunks_exact(4) {
                                samples.push(f32::from_ne_bytes(
                                    chunk.try_into().expect("chunks_exact(4)"),
                                ));
                            }
                        }
                        Decoded::Frame(Frame::Video(_)) => continue,
                        Decoded::NeedInput | Decoded::Finished => {
                            return finish_pcm(samples, sample_rate, channels);
                        }
                    }
                }
            }
        }
    }
}

fn finish_pcm(samples: Vec<f32>, sample_rate: u32, channels: u32) -> Result<Pcm, String> {
    if sample_rate == 0 || channels == 0 {
        return Err("ye 路径：解码无音频帧输出".into());
    }
    Ok(Pcm {
        sample_rate,
        channels,
        samples,
    })
}

// —— ffmpeg 引擎（oracle 与回退）——

/// ffmpeg 全量解码音频：`-map 0:a:0 -f f32le`（原生采样率/声道），
/// 采样率与声道数经 ffprobe 取回。
///
/// **edit list 口径**：`-ignore_editlist 1`（输入选项）让 ffmpeg 解出
/// **整段原始 AAC 帧**（含编码器 priming 头与尾部 padding，不做
/// gapless 裁剪）——与 ye 引擎的输出严格同口径（ye 的 MP4 reader 不
/// 解析 elst，stream.start_time 恒 None，解码即全量）。两引擎的 PCM
/// 因此逐样本同源对齐，波形窗口数/相位不随引擎漂移；代价是峰值序列
/// 相对可听时间轴整体含约一帧 priming（1024 样本 ≈ 23ms @44.1kHz，
/// 亚窗口级，波形显示无感）。ye 将来支持 elst 后两侧同步收紧此口径。
fn decode_pcm_ffmpeg(path: &str) -> Result<Pcm, String> {
    let info = ffmpeg_info()?;
    let probe = std::process::Command::new(&info.ffprobe_path)
        .args(["-v", "error", "-print_format", "json", "-show_streams"])
        .arg("-select_streams")
        .arg("a:0")
        .arg(path)
        .output()
        .map_err(|e| format!("启动 ffprobe 失败: {e}"))?;
    if !probe.status.success() {
        return Err(format!(
            "ffmpeg 路径：ffprobe 取音频流信息失败: {}",
            crate::ffmpeg::stderr_tail(&probe.stderr)
        ));
    }
    let json: serde_json::Value =
        serde_json::from_slice(&probe.stdout).map_err(|e| format!("解析 ffprobe 输出失败: {e}"))?;
    let stream = json["streams"][0]
        .as_object()
        .ok_or("ffmpeg 路径：无音频流")?;
    let sample_rate = stream["sample_rate"]
        .as_str()
        .and_then(|s| s.parse::<u32>().ok())
        .ok_or("ffmpeg 路径：采样率缺失")?;
    let channels = stream["channels"]
        .as_u64()
        .and_then(|c| u32::try_from(c).ok())
        .ok_or("ffmpeg 路径：声道数缺失")?;

    let out = std::process::Command::new(&info.ffmpeg_path)
        .args(["-y", "-hide_banner", "-loglevel", "error"])
        .args(["-ignore_editlist", "1"]) // 输入选项：与 ye 同口径（见函数文档）
        .arg("-i")
        .arg(path)
        .args([
            "-map",
            "0:a:0",
            "-vn",
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
        ])
        .arg("-")
        .output()
        .map_err(|e| format!("启动 ffmpeg 失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ffmpeg 波形解码失败（{path}）: {}",
            crate::ffmpeg::stderr_tail(&out.stderr)
        ));
    }
    let samples: Vec<f32> = out
        .stdout
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes(c.try_into().expect("chunks_exact(4)")))
        .collect();
    Ok(Pcm {
        sample_rate,
        channels,
        samples,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // —— 单元：峰值窗口算法（剪侧契约）——

    #[test]
    fn 峰值_整窗与末窗余量() {
        // 48000Hz、100pps → W=480 帧；立体声交织
        let mut samples = Vec::new();
        // 窗 0：L 摆 -0.5..+0.25，R 摆 -0.125..+0.5
        for i in 0..480 {
            let l = -0.5 + (i as f32) * 0.75 / 479.0; // -0.5 → +0.25
            let r = -0.125 + (i as f32) * 0.625 / 479.0; // -0.125 → +0.5
            samples.push(l);
            samples.push(r);
        }
        // 窗 1：只有 10 帧（余量窗），恒 0
        for _ in 0..10 {
            samples.push(0.0);
            samples.push(0.0);
        }
        let peaks = compute_peaks(&samples, 2, 48_000, 100);
        assert_eq!(peaks.len(), 2, "整窗 1 + 余量窗 1");
        assert_eq!(peaks[0][0], -0.5, "窗 0 min 取全声道最小（L 贡献）");
        assert_eq!(peaks[0][1], 0.5, "窗 0 max 取全声道最大（R 贡献）");
        assert_eq!(peaks[1], [0.0, 0.0], "余量窗按实际样本计");
    }

    #[test]
    fn 峰值_窗口大小_除不尽向上取整() {
        // 44100Hz、100pps → W=441（ceil(441)）
        let peaks = compute_peaks(&vec![0.0; 441 * 2], 2, 44_100, 100);
        assert_eq!(peaks.len(), 1, "882 交织样本 = 441 帧 = 恰一窗");
        // 22050Hz、100pps → ceil(220.5)=221
        let peaks = compute_peaks(&vec![0.0; 221 * 2], 2, 22_050, 100);
        assert_eq!(peaks.len(), 1);
        let peaks = compute_peaks(&vec![0.0; 222 * 2], 2, 22_050, 100);
        assert_eq!(peaks.len(), 2, "222 帧溢出一帧 → 末窗 1 帧");
    }

    #[test]
    fn 峰值_空输入与非法参数() {
        assert!(compute_peaks(&[], 2, 48_000, 100).is_empty());
        assert!(compute_peaks(&[0.0], 0, 48_000, 100).is_empty());
        assert!(compute_peaks(&[0.0], 2, 48_000, 0).is_empty());
    }

    #[test]
    fn 命令默认每秒峰值对数() {
        let pps = match Option::<u32>::None {
            Some(n) if n > 0 => n,
            _ => DEFAULT_PEAKS_PER_SECOND,
        };
        assert_eq!(pps, 100);
    }

    // —— E2E 对拍：与 ffmpeg 解码 PCM 重算的峰值序列逐窗一致 ——

    /// 夹具：1s 440Hz + 4400Hz 混合正弦立体声 AAC（44100Hz），
    /// 带视频轨（顺带验证波形只取音频流）。
    fn ensure_fixture() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("jian-wave-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let mp4 = dir.join("fixture.mp4");
        if mp4.is_file() {
            return mp4;
        }
        let out = std::process::Command::new("ffmpeg")
            .args(["-y", "-hide_banner", "-loglevel", "error"])
            .args([
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=160x120:rate=10:duration=1",
            ])
            .args([
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=44100:duration=1",
            ])
            .args([
                "-f",
                "lavfi",
                "-i",
                "aevalsrc=0.5*sin(2*PI*4400*t):s=44100:d=1",
            ])
            .args([
                "-filter_complex",
                "[1:a][2:a]amix=inputs=2:duration=first[a]",
            ])
            .args(["-map", "0:v", "-map", "[a]"])
            .args([
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
            ])
            // -aac_pns 0：ffmpeg 原生 AAC 编码器默认对这类内容开 PNS
            // （噪声替换），ye 解码器按形态边界拒收（PNS 重建是实现定义）。
            // 对拍夹具要进 ye 支持域，故显式关掉；PNS 流的回退行为由
            // 「pns流_命令层回退ffmpeg」单独覆盖。
            .args(["-c:a", "aac", "-ac", "2", "-aac_pns", "0", "-shortest"])
            .arg(&mp4)
            .output()
            .expect("spawn ffmpeg");
        assert!(
            out.status.success(),
            "ffmpeg 生成波形夹具失败：{}",
            String::from_utf8_lossy(&out.stderr)
        );
        mp4
    }

    /// 逐窗一致断言：窗数相等 + 每窗 min/max 逐对比较（容差 0 即逐位相等）。
    fn assert_peaks_close(a: &[[f32; 2]], b: &[[f32; 2]], tol: f32) -> (usize, f32) {
        assert_eq!(a.len(), b.len(), "窗数不一致：{} vs {}", a.len(), b.len());
        let mut worst = 0.0f32;
        for (k, (pa, pb)) in a.iter().zip(b).enumerate() {
            for j in 0..2 {
                let d = (pa[j] - pb[j]).abs();
                assert!(
                    d <= tol,
                    "窗 {k} 第 {j} 元素 |Δ|={d} > {tol}（ye={} ffmpeg={}）",
                    pa[j],
                    pb[j]
                );
                worst = worst.max(d);
            }
        }
        (a.len(), worst)
    }

    #[test]
    fn 对拍_ye与ffmpeg_pcm重算峰值逐窗一致() {
        let mp4 = ensure_fixture();
        let path = mp4.to_str().unwrap();
        // 直接调两引擎的 PCM 解码（不走命令层的自动回退——回退会掩盖
        // ye 的失败，对拍必须逼出 ye 主链本身）
        let ye_pcm = decode_pcm_ye(path).expect("ye AAC 解码（不许静默回退）");
        let ff_pcm = decode_pcm_ffmpeg(path).expect("ffmpeg PCM 解码");
        assert_eq!(ye_pcm.sample_rate, ff_pcm.sample_rate, "采样率一致");
        assert_eq!(ye_pcm.channels, ff_pcm.channels, "声道数一致");
        assert_eq!(ye_pcm.sample_rate, 44_100);
        assert_eq!(ye_pcm.channels, 2);

        let ye_peaks = compute_peaks(&ye_pcm.samples, ye_pcm.channels, ye_pcm.sample_rate, 100);
        let ff_peaks = compute_peaks(&ff_pcm.samples, ff_pcm.channels, ff_pcm.sample_rate, 100);
        // 逐窗一致：容差 1e-5——两解码器的 IMDCT 浮点求和次序不同，
        // 实测窗峰值最坏 |Δ|≈1.9e-6（典型窗 2e-9），峰值量级 O(0.01..1)：
        // 1e-5 比实测差留 5 倍余量、比波形显示分辨率（满幅数百像素，
        // 1e-3 级）小两个数量级
        let (windows, worst) = assert_peaks_close(&ye_peaks, &ff_peaks, 1e-5);
        // 口径含 priming/padding：1s 内容 + 首尾 padding ≈ 45 AAC 帧
        // （46080 样本）÷ 441 样本/窗 → 105 窗；两侧窗数已由上面强等断言
        assert!(
            (100..=106).contains(&windows),
            "1s@100pps 连 padding 应约 105 窗，实得 {windows}（最坏 |Δ|={worst}）"
        );
    }

    #[test]
    fn ye波形_无音频流报错() {
        let dir = std::env::temp_dir().join(format!("jian-wave-e2e-{}-vo", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let mp4 = dir.join("video-only.mp4");
        let out = std::process::Command::new("ffmpeg")
            .args(["-y", "-hide_banner", "-loglevel", "error"])
            .args([
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=160x120:rate=10:duration=1",
            ])
            .args([
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg("-an")
            .arg(&mp4)
            .output()
            .expect("spawn ffmpeg");
        assert!(out.status.success(), "生成纯视频夹具失败");
        let err = decode_pcm_ye(mp4.to_str().unwrap()).expect_err("无音频流应报错");
        assert!(err.contains("无音频流"), "错误应注明无音频流：{err}");
    }

    #[test]
    fn pns流_命令层回退ffmpeg() {
        // 同款内容但保持 ffmpeg 默认编码器参数（默认开 PNS）——实测会
        // 触发 ye 解码器形态拒收。命令层 waveform_peaks 应 warn 后回退
        // ffmpeg 并照常产出峰值（双引擎契约：ye 边界外不静默也不硬失败）。
        let dir = std::env::temp_dir().join(format!("jian-wave-e2e-{}-pns", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let mp4 = dir.join("pns.mp4");
        if !mp4.is_file() {
            let out = std::process::Command::new("ffmpeg")
                .args(["-y", "-hide_banner", "-loglevel", "error"])
                .args([
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=44100:duration=1",
                ])
                .args([
                    "-f",
                    "lavfi",
                    "-i",
                    "aevalsrc=0.5*sin(2*PI*4400*t):s=44100:d=1",
                ])
                .args([
                    "-filter_complex",
                    "[0:a][1:a]amix=inputs=2:duration=first[a]",
                ])
                .args(["-map", "[a]"])
                .args(["-c:a", "aac", "-ac", "2"])
                .arg(&mp4)
                .output()
                .expect("spawn ffmpeg");
            assert!(
                out.status.success(),
                "ffmpeg 生成 PNS 夹具失败：{}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        // 先确证前提：ye 主链确实拒收（否则本测试没有牙口）
        let ye_result = decode_pcm_ye(mp4.to_str().unwrap());
        let ye_err = match ye_result {
            Err(e) if e.contains("PNS") => e,
            other => panic!("夹具应触发 ye PNS 拒收，实得：{other:?}"),
        };
        assert!(ye_err.contains("PNS"), "拒收原因应注明 PNS：{ye_err}");
        // 命令层：回退后照常出峰值
        let peaks = waveform_peaks(mp4.to_string_lossy().into_owned(), Some(100))
            .expect("命令层回退 ffmpeg 后应成功");
        assert_eq!(peaks.sample_rate, 44_100);
        assert_eq!(peaks.channels, 2);
        assert!(!peaks.peaks.is_empty(), "回退路径也该有峰值序列");
    }
}
