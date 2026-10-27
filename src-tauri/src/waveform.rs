//! 波形峰值命令：素材音频轨 → 每桶每声道 min/max/rms（时间线波形显示的
//! 数据源；本模块只做数据层，UI 渲染组件由前端后续接入）。
//!
//! ## 双轨结构（probe.rs 同构：Rust 内回退 + usedEngine 盖章）
//!
//! - **ye 轨** [`waveform_peaks_ye`]：直达 [`ye::waveform::audio_peaks_with_count`]
//!   （桶数入口——收全样本后按数分桶，实桶不足时尾部以静默零值桶补齐，
//!   **返回桶数恒等于请求值**；不经 probe 时长估算——「估算时长定桶数」
//!   的路线估算误差会直接变成桶数误差，本轨不走）；
//! - **ffmpeg 轨** [`waveform_peaks_ffmpeg`]：`ffmpeg [-ignore_editlist 1] -i …
//!   -map 0:a:0 -f f32le pipe:1` 流式读 stdout（管道收字节不落临时文件；
//!   -ignore_editlist 仅 mov 家族素材添加，见下），声道数/采样率/容器名经
//!   ffprobe 取首条音频流（ffmpeg/ffprobe 定位复用 ffmpeg_info），样本喂
//!   **ye 纯核** [`ye::waveform::peaks_by_bucket_count`]
//!   ——两轨共用同一条分桶边界公式与补齐语义，桶数契约同源不分叉；
//! - **命令壳** [`waveform`]（auto）：ye 轨 Err 即回退 ffmpeg 轨，路由收在
//!   [`auto_route`] 纯函数（ye 成功时 ffmpeg 轨一次都不求值）。
//!
//! 回退口径与抽帧双轨不同、与 probe 双轨相同：抽帧（ye_engine.rs）回退
//! 归前端 thumbnail.ts（两轨返回临时文件路径，回退放前端可让 warn 落在
//! 调用现场）；波形两轨返回同构结构体，回退收在命令内，前端拿到的永远
//! 是「成功的那个」（usedEngine 只作展示/排查）——probe_media 的 auto
//! 同款分工。
//!
//! ## 两轨能力面差异（回退链的确定性）
//!
//! | 场景 | ye 轨 | 回退后 ffmpeg 轨 |
//! | --- | --- | --- |
//! | 非 mp4 容器（wav/mp3 等） | Err（ye 注册表只 mp4） | Ok（ffmpeg 全容器面） |
//! | 多音轨素材 | Err（ye 要求恰一条音频流） | Ok（-map 0:a:0 取首条，行为确定） |
//! | AAC PNS/多声道/非 LC | Err（解码能力面外） | Ok（ffmpeg 全解码面） |
//! | 无音频流 | Err | Err（ffprobe 判无可用音频轨） |
//!
//! ## 契约与边界
//!
//! - 桶数合法域 **16..=8192**（[`validate_buckets`]；两轨 pub 可独立调用，
//!   各自在入口校验，命令壳再校验一次避免无谓回退）；
//! - 成功返回时每声道桶数恒等于请求值（[`enforce_bucket_contract`] 出口
//!   守卫——契约被未来改动破坏时报错，不静默错数据）；
//! - ffmpeg 轨 0 样本但声道数已知（ffprobe 报了流、解码出 0 帧）→ 全静音
//!   桶补齐维持桶数契约（ye 轨无解码帧时 ye 纯核自身已 Err，无此支路）；
//! - 两轨都收全样本再分桶（桶长 = ceil(样本数/桶数) 依赖总样本数）：长
//!   素材内存随时长线性增长，流式化归 ye M4（ye waveform 模块文档同款
//!   遗留口径）；
//! - edit list（elst）在 ffmpeg 轨**输入侧**忽略（-ignore_editlist 1，须在
//!   -i 之前；仅 mov 家族素材添加——该选项只存在于 mov 家族 demuxer，其余
//!   容器传了 ffmpeg 直接报 Option not found，wav 实测）：ye 不应用 elst
//!   修剪，忽略后两轨样本视野一致（含 AAC priming 段），桶间数值才可对拍。
//!
//! 前端门面：src/core/media/waveform.ts（WaveformPeaks/PeakBucket 接口与
//! 本模块返回结构 serde camelCase 逐字段对齐，注释互指——改字段须两侧
//! 同步）。

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::AtomicBool;

use serde::Serialize;

use crate::ffmpeg::{ffmpeg_info, stderr_tail};

/// 引擎标识：ye 进程内轨（usedEngine 取值之一）。
const ENGINE_YE: &str = "ye";
/// 引擎标识：ffmpeg 子进程轨（usedEngine 取值之一）。
const ENGINE_FFMPEG: &str = "ffmpeg";
/// 桶数合法域下界（波形显示粒度下限：更稀的桶没有显示意义）。
const MIN_BUCKETS: usize = 16;
/// 桶数合法域上界（波形显示粒度上限：更密的桶超出时间线像素分辨率）。
const MAX_BUCKETS: usize = 8192;

/// 单桶单声道峰值统计。
///
/// derive 清单：`Debug, Clone, Copy, Serialize`（f32 三元组纯值载荷；
/// camelCase 对单字段名是恒等，声明保持与模块内其它结构一致）。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeakBucket {
    /// 桶内最小样本值。
    pub min: f32,
    /// 桶内最大样本值。
    pub max: f32,
    /// 桶内均方根 `sqrt(mean(x²))`。
    pub rms: f32,
}

/// 波形峰值结果（camelCase 序列化；与前端 src/core/media/waveform.ts 的
/// `WaveformPeaks` 接口逐字段对齐，注释互指）。
///
/// derive 清单：`Debug, Clone, Serialize`（含峰值矩阵按值返回；无 `Copy`
/// ——peaks 矩阵非纯值标量）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformPeaks {
    /// 实际产出本结果的引擎（"ye" | "ffmpeg"；auto 回退后即回退轨名）。
    pub used_engine: String,
    /// 采样率（Hz）。
    pub sample_rate: u32,
    /// 声道数。
    pub channels: usize,
    /// 桶长（名义帧数 = `ceil(每声道样本数/桶数)`；实际桶边界按共享公式，
    /// 桶间可有 ±1 帧差）。
    pub bucket_samples: usize,
    /// 桶数（恒等于请求值——实桶不足时尾部以静默零值桶补齐）。
    pub buckets: usize,
    /// 峰值矩阵 `[声道][桶]`。
    pub peaks: Vec<Vec<PeakBucket>>,
}

/// 桶数域校验（纯函数，供单测）：16..=8192 之外中文报错。
fn validate_buckets(buckets: usize) -> Result<(), String> {
    if !(MIN_BUCKETS..=MAX_BUCKETS).contains(&buckets) {
        return Err(format!(
            "波形桶数须在 {MIN_BUCKETS}..={MAX_BUCKETS}，收到 {buckets}"
        ));
    }
    Ok(())
}

/// ye 纯核桶 → 命令返回桶（纯映射：字段同名同义，仅类型来源不同）。
fn peak_from_ye(src: ye::waveform::PeakBucket) -> PeakBucket {
    PeakBucket {
        min: src.min,
        max: src.max,
        rms: src.rms,
    }
}

/// 桶数契约出口守卫（纯函数，供单测）：成功返回的每声道桶数必须等于
/// 请求值。ye 纯核补齐语义下恒通过；守的是未来改动破坏契约的回归
/// （误伤只是报错重试，漏判才是静默错数据）。
fn enforce_bucket_contract(peaks: &WaveformPeaks, requested: usize) -> Result<(), String> {
    if peaks.buckets != requested {
        return Err(format!(
            "波形桶数契约破裂：buckets 字段 {} ≠ 请求 {requested}",
            peaks.buckets
        ));
    }
    for (channel, row) in peaks.peaks.iter().enumerate() {
        if row.len() != requested {
            return Err(format!(
                "波形桶数契约破裂：声道 {channel} 返回 {} 桶 ≠ 请求 {requested}",
                row.len()
            ));
        }
    }
    Ok(())
}

/// 全静音桶矩阵（ffmpeg 轨 0 样本支路：声道数已知，按请求桶数补零值，
/// 维持桶数契约；纯函数，供单测）。
fn silence_columns(channels: usize, buckets: usize) -> Vec<Vec<PeakBucket>> {
    vec![
        vec![
            PeakBucket {
                min: 0.0,
                max: 0.0,
                rms: 0.0
            };
            buckets
        ];
        channels
    ]
}

/// auto 路由（纯流程，无 IO）：ye 轨 Ok 直取；**任何** Err（容器不识/
/// 多音轨打回/解码能力面外/打开失败）即回退 ffmpeg 轨。ffmpeg 轨以闭包
/// 惰性求值——ye 成功时一次都不碰。抽成独立纯函数供单测**构造性模拟**
/// ye Err（不必真造一个 ye 解不开的素材）。
fn auto_route(
    ye_track: Result<WaveformPeaks, String>,
    ffmpeg_track: impl FnOnce() -> Result<WaveformPeaks, String>,
) -> Result<WaveformPeaks, String> {
    match ye_track {
        Ok(peaks) => Ok(peaks),
        Err(_) => ffmpeg_track(),
    }
}

/// ye 轨（pub 纯库函数，不碰 Tauri 类型；pub 供单元测试直调）：
/// 打开素材 → [`ye::waveform::audio_peaks_with_count`]（桶数入口，收全
/// 样本按数分桶 + 静默零值桶补齐——返回桶数恒等于请求值）。
///
/// 任何 Err（容器不识/无音频流/多音轨/PNS 等解码能力面外）原样透传给
/// 调用方——auto 壳据此回退 ffmpeg 轨。
pub fn waveform_peaks_ye(path: &Path, buckets: usize) -> Result<WaveformPeaks, String> {
    validate_buckets(buckets)?;
    let file =
        File::open(path).map_err(|e| format!("ye 打开素材失败（{}）: {e}", path.display()))?;
    let cancel = AtomicBool::new(false);
    let src =
        ye::waveform::audio_peaks_with_count(Box::new(BufReader::new(file)), buckets, &cancel)
            .map_err(|e| format!("ye 波形失败（{}）: {e}", path.display()))?;
    let result = WaveformPeaks {
        used_engine: ENGINE_YE.to_string(),
        sample_rate: src.sample_rate,
        channels: src.channels,
        bucket_samples: src.bucket_samples,
        buckets: src.buckets,
        peaks: src
            .peaks
            .into_iter()
            .map(|row| row.into_iter().map(peak_from_ye).collect())
            .collect(),
    };
    enforce_bucket_contract(&result, buckets)
        .map_err(|e| format!("ye 波形失败（{}）: {e}", path.display()))?;
    Ok(result)
}

/// ffprobe 摘要（ffmpeg 轨专用）：首条音频流的声道数/采样率 + 容器名表。
///
/// derive 清单：`Debug, PartialEq`（私有测试断言用纯值载荷）。
#[derive(Debug, PartialEq)]
struct AudioStreamInfo {
    /// 声道数（≥ 1，解析时已拒 0）。
    channels: usize,
    /// 采样率（Hz）。
    sample_rate: u32,
    /// 容器 demuxer 名表（ffprobe 的 format_name，逗号分隔，如
    /// "mov,mp4,m4a,3gp,3g2,mj2"；缺 format 节时为空串＝按非 mov 家族
    /// 处理，不加 -ignore_editlist）。
    format_name: String,
}

/// ffprobe JSON → 首条音频流摘要（纯函数，供单测）。无 streams / 空表 /
/// 声道数 0 / 字段缺失 → None（调用方按「无可用音频轨」报错）。ffprobe
/// 的 sample_rate 是 JSON 字符串（"48000"），channels 是数字。
fn parse_first_audio_stream(json: &serde_json::Value) -> Option<AudioStreamInfo> {
    let stream = json.get("streams")?.as_array()?.first()?;
    let channels = stream.get("channels")?.as_u64()?;
    if channels == 0 {
        return None;
    }
    let sample_rate = stream.get("sample_rate")?.as_str()?.parse::<u32>().ok()?;
    let format_name = json
        .get("format")
        .and_then(|format| format.get("format_name"))
        .and_then(|name| name.as_str())
        .unwrap_or("")
        .to_string();
    Some(AudioStreamInfo {
        channels: channels as usize,
        sample_rate,
        format_name,
    })
}

/// mov 家族判定（纯函数，供单测）：edit list 仅存在于 mov 家族容器，
/// `-ignore_editlist` 也只在该家族 demuxer 上存在——其余容器（wav 实测）
/// 传了 ffmpeg 直接报 `Option ignore_editlist not found`，故按名表精确
/// 匹配后再决定是否加该输入侧选项。
fn is_mov_family(format_name: &str) -> bool {
    format_name
        .split(',')
        .any(|name| matches!(name.trim(), "mov" | "mp4" | "m4a" | "3gp" | "3g2" | "mj2"))
}

/// ffprobe 取首条音频流摘要（ffmpeg 轨专用；定位复用 ffmpeg_info 的
/// ffprobe_path）。
fn probe_first_audio(ffprobe: &Path, path: &Path) -> Result<AudioStreamInfo, String> {
    let out = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=channels,sample_rate:format=format_name",
        ])
        .arg(path)
        .output()
        .map_err(|e| format!("启动 ffprobe 失败（{}）: {e}", ffprobe.display()))?;
    if !out.status.success() {
        return Err(format!(
            "ffprobe 探测失败（{}）: {}",
            path.display(),
            stderr_tail(&out.stderr)
        ));
    }
    let json: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("解析 ffprobe 输出失败（{}）: {e}", path.display()))?;
    parse_first_audio_stream(&json).ok_or_else(|| format!("素材无可用音频轨（{}）", path.display()))
}

/// f32 小端解包（纯函数，供单测；与 ye scaled_samples 同款）：4 字节一组
/// 转 f32。尾字节不足 4 的余数丢弃——stdout 字节数恒为 4 的整倍数（ffmpeg
/// 整帧写出），尾巴理论上不存在；样本数/声道数整倍数交叉校验在 ye 纯核。
fn decode_f32le(bytes: &[u8]) -> Vec<f32> {
    bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect()
}

/// 跑 `ffmpeg [-ignore_editlist 1] -i path -map 0:a:0 -f f32le pipe:1`，
/// 流式收全 stdout 原始字节（管道分块读，不落临时文件）。`-ignore_editlist 1`
/// 是 mov 家族 demuxer 的输入侧选项，仅 [`is_mov_family`] 素材添加（其余
/// 容器无此选项，传了直接报错——wav 实测）。
///
/// stderr 单开线程收（防它塞满管道把 ffmpeg 卡死，run_export 同款）；
/// 退出码非零回传 stderr 尾部。
fn run_ffmpeg_f32le(ffmpeg: &Path, path: &Path, ignore_editlist: bool) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-v").arg("error");
    if ignore_editlist {
        cmd.arg("-ignore_editlist").arg("1");
    }
    cmd.arg("-i")
        .arg(path)
        .arg("-map")
        .arg("0:a:0")
        .arg("-c:a")
        .arg("pcm_f32le")
        .arg("-f")
        .arg("f32le")
        .arg("pipe:1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 ffmpeg 失败（{}）: {e}", ffmpeg.display()))?;
    let mut stderr = child.stderr.take().ok_or("拿不到 ffmpeg 的 stderr")?;
    let stderr_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });
    let mut stdout = child.stdout.take().ok_or("拿不到 ffmpeg 的 stdout")?;
    let mut raw = Vec::new();
    stdout
        .read_to_end(&mut raw)
        .map_err(|e| format!("读 ffmpeg 波形流失败: {e}"))?;
    let status = child
        .wait()
        .map_err(|e| format!("等待 ffmpeg 退出失败: {e}"))?;
    let stderr_buf = stderr_handle
        .join()
        .map_err(|_| "stderr 读取线程崩溃".to_string())?;
    if !status.success() {
        return Err(format!(
            "ffmpeg 波形提取失败（{}）: {}",
            path.display(),
            stderr_tail(&stderr_buf)
        ));
    }
    Ok(raw)
}

/// ffmpeg 轨（pub 纯库函数，不碰 Tauri 类型；pub 供单元测试直调）：
/// ① ffprobe（ffmpeg_info 定位复用）取首条音频流声道数/采样率；
/// ② ffmpeg `-ignore_editlist 1`（输入侧）+ `-map 0:a:0 -f f32le` 流式读
///    stdout；
/// ③ 小端解包 → 喂 ye 纯核 [`ye::waveform::peaks_by_bucket_count`]（与
///    ye 轨同一条分桶边界公式，桶数契约同源）。
pub fn waveform_peaks_ffmpeg(path: &Path, buckets: usize) -> Result<WaveformPeaks, String> {
    validate_buckets(buckets)?;
    let info = ffmpeg_info()?;
    let stream = probe_first_audio(Path::new(&info.ffprobe_path), path)?;
    let raw = run_ffmpeg_f32le(
        Path::new(&info.ffmpeg_path),
        path,
        is_mov_family(&stream.format_name),
    )?;
    let samples = decode_f32le(&raw);
    let (channels, sample_rate) = (stream.channels, stream.sample_rate);
    let columns = if samples.is_empty() {
        // 0 样本但声道数已知：全静音桶补齐（模块文档「契约与边界」）。
        silence_columns(channels, buckets)
    } else {
        ye::waveform::peaks_by_bucket_count(&samples, channels, buckets)
            .map_err(|e| format!("ffmpeg 波形失败（{}）: {e}", path.display()))?
            .into_iter()
            .map(|row| row.into_iter().map(peak_from_ye).collect())
            .collect()
    };
    let frames = samples.len() / channels;
    let result = WaveformPeaks {
        used_engine: ENGINE_FFMPEG.to_string(),
        sample_rate,
        channels,
        bucket_samples: if frames > 0 {
            frames.div_ceil(buckets)
        } else {
            0
        },
        buckets: columns.first().map_or(0, Vec::len),
        peaks: columns,
    };
    enforce_bucket_contract(&result, buckets)
        .map_err(|e| format!("ffmpeg 波形失败（{}）: {e}", path.display()))?;
    Ok(result)
}

/// 取波形（命令壳，auto）：path 素材音频轨的峰值矩阵；buckets ∈ 16..=8192
/// （域校验在本壳一次、两轨入口各一次）。auto：ye 轨 Err 即回退 ffmpeg 轨
/// （[`auto_route`]）；两轨成功时桶数恒等于请求值。
#[tauri::command(async)]
pub fn waveform(path: String, buckets: usize) -> Result<WaveformPeaks, String> {
    validate_buckets(buckets)?;
    auto_route(waveform_peaks_ye(Path::new(&path), buckets), || {
        waveform_peaks_ffmpeg(Path::new(&path), buckets)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::OnceLock;

    /// 构造极小成功载荷（纯逻辑组测试用；桶数契约守卫测试按需改字段）。
    fn fixture(engine: &str) -> WaveformPeaks {
        WaveformPeaks {
            used_engine: engine.to_string(),
            sample_rate: 48_000,
            channels: 1,
            bucket_samples: 4,
            buckets: 2,
            peaks: vec![vec![
                PeakBucket {
                    min: -0.5,
                    max: 0.5,
                    rms: 0.3,
                };
                2
            ]],
        }
    }

    // ---- 纯逻辑组（无外部工具依赖） ----

    /// 桶数域校验：0 与超界（15/8193）中文报错并写明合法域，边界值
    /// （16/8192）与域内值放行。
    #[test]
    fn 桶数域校验中文报错() {
        for bad in [0usize, 15, 8193] {
            let err = validate_buckets(bad).expect_err("越界桶数必须 Err");
            assert!(err.contains("波形桶数须在 16..=8192"), "写明合法域：{err}");
            assert!(err.contains(&bad.to_string()), "携带收到的值：{err}");
        }
        for good in [16usize, 137, 8192] {
            assert!(validate_buckets(good).is_ok(), "域内 {good} 应放行");
        }
    }

    /// 命令壳与两轨入口都在碰文件之前拒绝越界桶数：拿不存在的路径也
    /// 报域错误而非打开失败（证明校验先于 IO，独立调用同样受保护）。
    #[test]
    fn 越界桶数在打开文件之前被拒() {
        let missing = Path::new("jian-waveform-测试不存在的素材.m4a");
        for buckets in [0usize, 15, 8193] {
            let err =
                waveform(missing.to_string_lossy().into_owned(), buckets).expect_err("须 Err");
            assert!(
                err.contains("波形桶数须在 16..=8192"),
                "命令壳域错误：{err}"
            );
            assert!(!err.contains("打开"), "校验先于 IO：{err}");
            let ye_err = waveform_peaks_ye(missing, buckets).expect_err("ye 轨须 Err");
            assert!(
                ye_err.contains("波形桶数须在 16..=8192"),
                "ye 轨域错误：{ye_err}"
            );
            let ff_err = waveform_peaks_ffmpeg(missing, buckets).expect_err("ffmpeg 轨须 Err");
            assert!(
                ff_err.contains("波形桶数须在 16..=8192"),
                "ffmpeg 轨域错误：{ff_err}"
            );
        }
    }

    /// auto 路由：构造性模拟 ye Err（手搓 Result，不必真造 ye 解不开的
    /// 素材）→ ffmpeg 轨被调用且其结果原样返回。
    #[test]
    fn auto路由ye失败即回退ffmpeg轨() {
        let called = std::rc::Rc::new(std::cell::Cell::new(false));
        let mark = called.clone();
        let ffmpeg = move || {
            mark.set(true);
            Ok(fixture(ENGINE_FFMPEG))
        };
        let got = auto_route(
            Err("ye 波形失败（模拟）: profile not supported".into()),
            ffmpeg,
        )
        .expect("回退后应成功");
        assert!(called.get(), "ye Err 必须触发 ffmpeg 轨");
        assert_eq!(got.used_engine, ENGINE_FFMPEG, "回退轨盖章：{got:?}");
    }

    /// auto 路由：ye Ok 直取，ffmpeg 轨一次都不求值。
    #[test]
    fn auto路由ye成功不碰ffmpeg轨() {
        let called = std::rc::Rc::new(std::cell::Cell::new(false));
        let mark = called.clone();
        let ffmpeg = move || {
            mark.set(true);
            Ok(fixture(ENGINE_FFMPEG))
        };
        let got = auto_route(Ok(fixture(ENGINE_YE)), ffmpeg).expect("ye 成功应直取");
        assert!(!called.get(), "ye 成功时 ffmpeg 轨不得求值");
        assert_eq!(got.used_engine, ENGINE_YE);
    }

    /// 桶数契约守卫：行数或 buckets 字段 ≠ 请求值即 Err（防回归）；合法
    /// 载荷放行。
    #[test]
    fn 桶数契约守卫拒绝错桶数() {
        let ok = fixture(ENGINE_YE);
        assert!(enforce_bucket_contract(&ok, 2).is_ok());
        let mut wrong_row = fixture(ENGINE_YE);
        wrong_row.peaks[0].pop();
        assert!(
            enforce_bucket_contract(&wrong_row, 2).is_err(),
            "行短一桶必须报错"
        );
        let mut wrong_field = fixture(ENGINE_YE);
        wrong_field.buckets = 3;
        let err = enforce_bucket_contract(&wrong_field, 2).expect_err("字段不一致必须报错");
        assert!(err.contains("契约破裂"), "述因：{err}");
    }

    /// 全静音补齐矩阵：行数=声道数、列数=请求桶数、值全零（ffmpeg 轨
    /// 0 样本支路的桶数契约来源）。
    #[test]
    fn 静音补齐矩阵桶数等于请求值() {
        let columns = silence_columns(2, 100);
        assert_eq!(columns.len(), 2, "两声道两行");
        for row in &columns {
            assert_eq!(row.len(), 100, "每行恰为请求桶数");
            assert!(
                row.iter()
                    .all(|p| p.min == 0.0 && p.max == 0.0 && p.rms == 0.0)
            );
        }
    }

    /// ffprobe 首音频流解析：取第一条流的 channels/sample_rate 与容器名
    /// 表；空表/缺字段/声道数 0 → None；缺 format 节时容器名落空串。
    #[test]
    fn ffprobe首音频流解析() {
        let json: serde_json::Value = serde_json::json!({
            "streams": [
                { "channels": 2, "sample_rate": "48000" },
                { "channels": 6, "sample_rate": "44100" }
            ],
            "format": { "format_name": "mov,mp4,m4a,3gp,3g2,mj2" }
        });
        let got = parse_first_audio_stream(&json).expect("首流应解析");
        assert_eq!((got.channels, got.sample_rate), (2, 48_000), "只取第一条流");
        assert_eq!(got.format_name, "mov,mp4,m4a,3gp,3g2,mj2");
        assert_eq!(
            parse_first_audio_stream(&serde_json::json!({ "streams": [] })),
            None
        );
        assert_eq!(parse_first_audio_stream(&serde_json::json!({})), None);
        assert_eq!(
            parse_first_audio_stream(&serde_json::json!({
                "streams": [ { "channels": 0, "sample_rate": "48000" } ]
            })),
            None,
            "声道数 0 不可用"
        );
        assert_eq!(
            parse_first_audio_stream(&serde_json::json!({
                "streams": [ { "channels": 2 } ]
            })),
            None,
            "缺 sample_rate 不可用"
        );
        let no_format = parse_first_audio_stream(&serde_json::json!({
            "streams": [ { "channels": 1, "sample_rate": "44100" } ]
        }))
        .expect("缺 format 节仍应给出流信息");
        assert_eq!(no_format.format_name, "", "容器名落空串＝非 mov 家族处理");
    }

    /// mov 家族判定：名表任一命中即真；wav/空串/未知名不命中（决定
    /// -ignore_editlist 是否加入命令行）。
    #[test]
    fn mov家族判定() {
        assert!(is_mov_family("mov,mp4,m4a,3gp,3g2,mj2"), "mp4/m4a 家族");
        assert!(is_mov_family("mov"), "单一 mov");
        assert!(!is_mov_family("wav"), "wav 不认 editlist 选项");
        assert!(!is_mov_family(""), "缺容器信息按非 mov 家族");
        assert!(!is_mov_family("wv,mp4s"), "子串不误判（按整名匹配）");
    }

    /// f32 小端解包：已知字节转已知浮点；尾字节不足 4 的余数丢弃。
    #[test]
    fn f32le小端解包() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&1.0_f32.to_le_bytes());
        bytes.extend_from_slice(&(-0.5_f32).to_le_bytes());
        bytes.extend_from_slice(&[0xFF, 0xFF, 0x7F]); // 3 字节尾巴：丢弃
        assert_eq!(decode_f32le(&bytes), vec![1.0, -0.5]);
    }

    // ---- 真跑组（ffmpeg/ffprobe 须可定位；缺席判失败不跳过） ----
    // 口径与 probe.rs 对拍向量组一致：生产轨 ffmpeg_info（BJ_FFMPEG_DIR →
    // sidecar → PATH）定位 ffmpeg/ffprobe，向量生成走本模块定位器
    // （BJ_FFMPEG_DIR → PATH → 仓相对 ../../duan/src-tauri/binaries）。
    // 本机把 duan/src-tauri/binaries 加进 PATH 即全中；jian CI 只跑
    // cargo check，不跑本组测试。

    /// 定位 ffmpeg/ffprobe 所在目录（向量生成用）；全落空 → panic（测试
    /// 失败，不假绿跳过）。
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
        if let Some(dir) = std::env::var_os("BJ_FFMPEG_DIR").map(PathBuf::from)
            && has_pair(&dir)
        {
            return dir;
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
             波形真跑测试工具缺席判失败，不跳过"
        );
    }

    /// 跑 ffmpeg 生成一条向量；非零退出即 panic。
    fn run_ffmpeg_gen(ffmpeg: &Path, args: &[&str], out: &Path) {
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

    /// 生成全套真跑向量（进程内一次，lavfi 确定性源；AAC 配方对齐 probe.rs
    /// 的 vec-audio.m4a——PNS 关闭保证 ye 可解）：wave.m4a（单音频轨，
    /// 0.8 幅正弦见下）/ wave.wav（非 mp4 容器回退用）/ wave-dual.m4a
    /// （双音频轨打回用）。
    fn ensure_vectors() -> PathBuf {
        static DIR: OnceLock<PathBuf> = OnceLock::new();
        DIR.get_or_init(|| {
            let ffmpeg = locate_binaries_dir().join(if cfg!(windows) {
                "ffmpeg.exe"
            } else {
                "ffmpeg"
            });
            let dir = std::env::temp_dir().join(format!("jian-wave-vec-{}", std::process::id()));
            std::fs::create_dir_all(&dir).expect("创建向量目录失败");
            // 主向量：2s 立体声 0.8 幅正弦 48k AAC（PNS 关，ye AAC 解码面内）。
            // 用 aevalsrc 显式给幅度而非 sine 源——后者固定约 0.0885 幅
            // （-21dBFS 量级），波形测试的峰值就是产品本身，要真实幅值。
            run_ffmpeg_gen(
                &ffmpeg,
                &[
                    "-f",
                    "lavfi",
                    "-i",
                    "aevalsrc=0.8*sin(2*PI*440*t):s=48000:d=2",
                    "-ac",
                    "2",
                    "-c:a",
                    "aac",
                    "-aac_pns",
                    "0",
                    "-b:a",
                    "128k",
                ],
                &dir.join("wave.m4a"),
            );
            // 非 mp4 容器：wav（ye 注册表只 mp4 → ye 轨必 Err，回退链用）
            run_ffmpeg_gen(
                &ffmpeg,
                &[
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=48000:duration=2",
                    "-ac",
                    "2",
                ],
                &dir.join("wave.wav"),
            );
            // 双音频轨：两条正弦各自成流（ye 轨「恰一条音频流」打回用）
            run_ffmpeg_gen(
                &ffmpeg,
                &[
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=48000:duration=2",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=880:sample_rate=48000:duration=2",
                    "-map",
                    "0:a",
                    "-map",
                    "1:a",
                    "-c:a",
                    "aac",
                    "-aac_pns",
                    "0",
                    "-b:a",
                    "64k",
                ],
                &dir.join("wave-dual.m4a"),
            );
            dir
        })
        .clone()
    }

    /// 正弦稳态断言：素材是 0.8 幅正弦，但 -ignore_editlist 1 口径下 AAC
    /// priming/padding 静音段保留在两轨样本视野里（开头约 44ms、结尾不足
    /// 一帧组），故断言稳态区而非逐桶——① 正中桶必在稳态区，min/max 过
    /// ±0.3、rms ∈ (0.1, 1]；② ≥ 90% 的桶 rms > 0.1（正弦占绝对时长）。
    /// 不锁精确值——两解码器实现差异属正常（对拍另有两轨逐桶测试）。
    fn assert_sine_sane(peaks: &WaveformPeaks) {
        for row in &peaks.peaks {
            let mid = &row[row.len() / 2];
            assert!(
                mid.min <= -0.3 && mid.max >= 0.3,
                "正中桶（稳态区）峰值异常：{mid:?}"
            );
            assert!((0.1..=1.0).contains(&mid.rms), "正中桶 rms 异常：{mid:?}");
            let energetic = row.iter().filter(|p| p.rms > 0.1).count();
            assert!(
                energetic * 10 >= row.len() * 9,
                "有能量桶占比过低（{energetic}/{}），解码结果可疑",
                row.len()
            );
        }
    }

    /// ye 轨桶数契约真跑：奇数桶数 137（不整除样本数，逼出补齐路径的
    /// 邻居）→ 桶数恒等于请求值，立体声两行、48k、正弦值健全。
    #[test]
    fn ye轨桶数恒等于请求值() {
        let dir = ensure_vectors();
        let got = waveform_peaks_ye(&dir.join("wave.m4a"), 137).expect("ye 轨应成功");
        assert_eq!(got.used_engine, ENGINE_YE);
        assert_eq!(got.buckets, 137, "桶数=请求值");
        assert_eq!(got.peaks.len(), 2, "立体声两行");
        for (channel, row) in got.peaks.iter().enumerate() {
            assert_eq!(row.len(), 137, "声道 {channel} 桶数=请求值");
        }
        assert_eq!(got.channels, 2);
        assert_eq!(got.sample_rate, 48_000);
        assert_sine_sane(&got);
    }

    /// ffmpeg 轨桶数契约真跑：同向量同桶数 137 → 与 ye 轨同一条契约。
    #[test]
    fn ffmpeg轨桶数恒等于请求值() {
        let dir = ensure_vectors();
        let got = waveform_peaks_ffmpeg(&dir.join("wave.m4a"), 137).expect("ffmpeg 轨应成功");
        assert_eq!(got.used_engine, ENGINE_FFMPEG);
        assert_eq!(got.buckets, 137, "桶数=请求值");
        assert_eq!(got.peaks.len(), 2, "立体声两行");
        for (channel, row) in got.peaks.iter().enumerate() {
            assert_eq!(row.len(), 137, "声道 {channel} 桶数=请求值");
        }
        assert_eq!(got.channels, 2);
        assert_eq!(got.sample_rate, 48_000);
        assert_sine_sane(&got);
    }

    /// ye 轨桶数超样本数：8192 桶对 2s 素材（约 9.6 万帧 → 实桶约 8000）
    /// → 尾部静音零值桶补齐，末桶全零且桶数仍 = 请求值。
    #[test]
    fn ye轨桶数超样本数补齐静音桶() {
        let dir = ensure_vectors();
        let got = waveform_peaks_ye(&dir.join("wave.m4a"), 8192).expect("ye 轨应成功");
        assert_eq!(got.buckets, 8192, "桶数=请求值");
        let last = got.peaks[0].last().expect("补齐后必有末桶");
        assert!(
            last.min == 0.0 && last.max == 0.0 && last.rms == 0.0,
            "末桶应为静音零值补齐桶：{last:?}"
        );
    }

    /// ffmpeg 轨桶数超样本数：同 ye 轨支路——静音补齐来自 ye 纯核同款
    /// 语义，两轨契约一致。
    #[test]
    fn ffmpeg轨桶数超样本数补齐静音桶() {
        let dir = ensure_vectors();
        let got = waveform_peaks_ffmpeg(&dir.join("wave.m4a"), 8192).expect("ffmpeg 轨应成功");
        assert_eq!(got.buckets, 8192, "桶数=请求值");
        let last = got.peaks[0].last().expect("补齐后必有末桶");
        assert!(
            last.min == 0.0 && last.max == 0.0 && last.rms == 0.0,
            "末桶应为静音零值补齐桶：{last:?}"
        );
    }

    /// auto 命令：mp4 向量 ye 轨直接拿下（usedEngine=ye，桶数契约照常）。
    #[test]
    fn auto命令mp4优先ye轨() {
        let dir = ensure_vectors();
        let got = waveform(dir.join("wave.m4a").to_string_lossy().into_owned(), 100)
            .expect("auto 应经 ye 轨成功");
        assert_eq!(got.used_engine, ENGINE_YE);
        assert_eq!(got.buckets, 100);
        assert_eq!(got.peaks[0].len(), 100);
    }

    /// auto 命令：非 mp4 容器（wav）ye 轨 Err → 回退 ffmpeg 轨成功，
    /// usedEngine=ffmpeg，桶数契约照常。
    #[test]
    fn auto命令非mp4回退ffmpeg轨() {
        let dir = ensure_vectors();
        let got = waveform(dir.join("wave.wav").to_string_lossy().into_owned(), 64)
            .expect("auto 应回退 ffmpeg 轨成功");
        assert_eq!(got.used_engine, ENGINE_FFMPEG);
        assert_eq!(got.buckets, 64);
        assert_eq!(got.peaks.len(), 2, "立体声两行");
    }

    /// auto 命令：双音频轨素材 ye 轨打回（恰一条音频流约束）→ 回退
    /// ffmpeg 轨 -map 0:a:0 取首条（行为确定），桶数契约照常。
    #[test]
    fn auto命令多音轨ye打回ffmpeg取首轨() {
        let dir = ensure_vectors();
        // 证据锁定：ye 轨确实 Err（回退不是误打误撞）
        let ye_err =
            waveform_peaks_ye(&dir.join("wave-dual.m4a"), 64).expect_err("双音轨 ye 轨应打回");
        assert!(ye_err.contains("恰一条音频流"), "打回原因透传：{ye_err}");
        let got = waveform(dir.join("wave-dual.m4a").to_string_lossy().into_owned(), 64)
            .expect("auto 应回退 ffmpeg 轨成功");
        assert_eq!(got.used_engine, ENGINE_FFMPEG);
        assert_eq!(got.buckets, 64);
    }

    /// 两轨对拍：同向量同桶数（100），正弦稳态信号逐桶 min/max/rms 应
    /// 一致（稳态信号桶统计与样本相位无关，容差覆盖两解码器实现差异
    /// 与 priming 段错位）。
    #[test]
    fn 两轨逐桶对拍正弦稳态一致() {
        let dir = ensure_vectors();
        let ye_got = waveform_peaks_ye(&dir.join("wave.m4a"), 100).expect("ye 轨应成功");
        let ff_got = waveform_peaks_ffmpeg(&dir.join("wave.m4a"), 100).expect("ffmpeg 轨应成功");
        assert_eq!(ye_got.peaks.len(), ff_got.peaks.len(), "声道数一致");
        for (channel, (ye_row, ff_row)) in ye_got.peaks.iter().zip(&ff_got.peaks).enumerate() {
            assert_eq!(ye_row.len(), ff_row.len(), "桶数一致");
            for (k, (a, b)) in ye_row.iter().zip(ff_row).enumerate() {
                assert!(
                    (a.min - b.min).abs() <= 0.15,
                    "声道 {channel} 桶 {k} min 分歧：ye={} ff={}",
                    a.min,
                    b.min
                );
                assert!(
                    (a.max - b.max).abs() <= 0.15,
                    "声道 {channel} 桶 {k} max 分歧：ye={} ff={}",
                    a.max,
                    b.max
                );
                assert!(
                    (a.rms - b.rms).abs() <= 0.05,
                    "声道 {channel} 桶 {k} rms 分歧：ye={} ff={}",
                    a.rms,
                    b.rms
                );
            }
        }
    }
}
