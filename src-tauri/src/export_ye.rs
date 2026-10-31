//! ye 进程内导出引擎（M4 首轮接线）：门面 [`ye::compose::compose`]
//! （顺序拼接合成泵）的命令封装。
//!
//! 与 ffmpeg.rs 的 [`crate::ffmpeg::run_export`] 子进程轨构成「引擎二选一」
//! （引擎选择归前端 store，M4 首轮接受面由前端翻译层
//! buildYeExportParams 提前拒绝，这里只兜参数形状）：同一导出编排
//! （exportProject）按 engine 分流到 run_export / run_export_ye。
//!
//! 进度事件**复用 ffmpeg 轨的 `export-progress` 事件名与负载形态**
//! （`ExportProgress { timeUs, totalUs }`，serde camelCase）：剪同时至多
//! 一个导出任务（M1 起的导出按钮在导出中禁用），引擎在任务开始前已定、
//! 两轨不可能并发——复用事件名让前端 exportProject 的监听代码两轨合一，
//! 不给 ffmpeg 轨引入任何新事件源；ye 泵的 total = Σ片段窗口时长，
//! 缺时长（0）时退回前端按序列求值给的兜底值（duan ye_engine 同款）。
//!
//! 取消从「kill 子进程」换成「AtomicBool 置位」（ye 泵每输入包检查点
//! 检出即返回 `Cancelled`）。剪的导出无 jobId（一次一个），取消表是
//! 单槽 `Option<Arc<AtomicBool>>`（登记/摘除/置位语义与 duan 的
//! CANCEL_FLAGS 表一致，只是键省了）。
//!
//! 分层与 duan ye_engine.rs 同构：命令壳只做参数校验/事件桥/取消表；
//! 导出主体在 [`export_ye_impl`]（纯库调用，不碰 Tauri 类型），
//! pub 供集成测试（tests/export_ye_e2e.rs）直调。

use std::fs::File;
use std::io::{BufReader};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use serde::Deserialize;
use tauri::Emitter;

use crate::ffmpeg::ExportProgress;
use ye::convert::{AudioEncodeSettings, ConvertStats};

/// 取消旗标表（单槽）：run_export_ye 登记本地 Arc、收尾摘除；
/// cancel_export_ye 置位。剪同时至多一个导出任务（见模块文档）。
static CANCEL_SLOT: LazyLock<Mutex<Option<Arc<AtomicBool>>>> = LazyLock::new(|| Mutex::new(None));

/// 码率上限（kbps）：命令入参的形状校验用（对齐 duan ye_engine 的
/// MAX_KBPS——远超现实导出需求，挡住溢出/单位填错的病态值）。
const MAX_KBPS: u32 = 4_000_000;

/// 合成片段入参（前端 buildYeExportParams 产出，serde camelCase）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentArg {
    /// 片段素材绝对路径（MP4）。
    pub path: String,
    /// 源内窗口起点（µs）。
    pub trim_in_us: i64,
    /// 源内窗口终点（µs，含头不含尾）。
    pub trim_out_us: i64,
}

/// ye 导出参数（由 [`parse_export_ye_options`] 校验组装，[`export_ye_impl`]
/// 消费）。
#[derive(Debug, Clone)]
pub struct ExportYeSpec {
    /// 输出画幅（非零偶数）。
    pub size: (u32, u32),
    /// 输出恒定帧率。
    pub frame_rate: ye::time::Rational,
    /// 基准 CRF（1..=51）：对标 ffmpeg 轨 libx264 缺省（前端固定传 23）。
    pub crf: u8,
    /// 音频重编码码率（kbps；`None` + 非 strip = 前端违约，由 audio 表达）。
    pub audio_bitrate_kbps: Option<u32>,
    /// 剥音轨（输出无音轨）。
    pub strip_audio: bool,
}

/// 命令入参校验（纯函数，供单测）：画幅偶数、帧率正整数域、CRF 值域、
/// 窗口形状、剥轨与码率互斥。
// 8 个参数（超 clippy 默认上限 1 个）：命令入参的逐一映射（Tauri 命令
// 形态），收拢成结构体反而要造一层中转类型——与 duan ye_engine 的
// parse_ye_options 同款取舍。
#[allow(clippy::too_many_arguments)]
fn parse_export_ye_options(
    segments: &[SegmentArg],
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    crf: u8,
    audio_bitrate_kbps: Option<u32>,
    strip_audio: bool,
) -> Result<ExportYeSpec, String> {
    if segments.is_empty() {
        return Err("片段列表为空，无从导出".to_string());
    }
    if width == 0 || height == 0 || !width.is_multiple_of(2) || !height.is_multiple_of(2) {
        return Err(format!(
            "输出画幅须为正偶数，收到 {width}x{height}（H.264 4:2:0 要求）"
        ));
    }
    if fps_num == 0 || fps_den == 0 {
        return Err(format!("输出帧率须为正，收到 {fps_num}/{fps_den}"));
    }
    let frame_rate = ye::time::Rational::new(
        i32::try_from(fps_num).map_err(|_| format!("帧率分子超 i32：{fps_num}"))?,
        i32::try_from(fps_den).map_err(|_| format!("帧率分母超 i32：{fps_den}"))?,
    );
    if frame_rate.num() <= 0 {
        return Err(format!("输出帧率须为正，收到 {fps_num}/{fps_den}"));
    }
    if !(1..=51).contains(&crf) {
        return Err(format!("CRF 须在 1..=51，收到 {crf}"));
    }
    if let Some(kbps) = audio_bitrate_kbps
        && (kbps == 0 || kbps > MAX_KBPS)
    {
        return Err(format!("音频码率须在 1..={MAX_KBPS} kbps，收到 {kbps}"));
    }
    if strip_audio && audio_bitrate_kbps.is_some() {
        return Err("剥音轨与音频重编码码率互斥（二选一）".to_string());
    }
    if !strip_audio && audio_bitrate_kbps.is_none() {
        return Err("非剥音轨导出须给出音频码率".to_string());
    }
    for (i, seg) in segments.iter().enumerate() {
        if seg.trim_in_us < 0 {
            return Err(format!(
                "第 {} 段窗口起点为负（{}µs）",
                i + 1,
                seg.trim_in_us
            ));
        }
        if seg.trim_out_us <= seg.trim_in_us {
            return Err(format!(
                "第 {} 段窗口为空（[{}, {}）µs，须终点 > 起点）",
                i + 1,
                seg.trim_in_us,
                seg.trim_out_us
            ));
        }
    }
    Ok(ExportYeSpec {
        size: (width, height),
        frame_rate,
        crf,
        audio_bitrate_kbps,
        strip_audio,
    })
}

/// 导出主体（纯库调用，不碰 Tauri 类型）：注册表组装 → 片段文件打开 →
/// 门面合成泵 → 统计；失败即删半成品（ye 泵不持有路径概念，输出文件
/// 清理归调用方——duan ye_engine 同款约定）。
///
/// 进度回调 `(processed_us, total_us)` 由泵逐输出包上报；total = Σ窗口
/// 时长，前端按序列求值传兜底值（pump total 为 0 时由命令壳接管）。
pub fn export_ye_impl(
    segments: &[SegmentArg],
    output: &Path,
    spec: &ExportYeSpec,
    cancel: &AtomicBool,
    progress: &dyn Fn(i64, i64),
) -> Result<ConvertStats, String> {
    let result = run_ye_export(segments, output, spec, cancel, progress);

    result
}

fn run_ye_export(
    segments: &[SegmentArg],
    output: &Path,
    spec: &ExportYeSpec,
    cancel: &AtomicBool,
    progress: &dyn Fn(i64, i64),
) -> Result<ConvertStats, String> {
    // 注册表显式构造（与 ye-cli/duan 同款）：MP4 容器 + H.264/AAC 解码
    // 编码真工厂（compose 音频轨 Aac 需要全套）。
    let mut containers = ye::container::ContainerRegistry::new();
    ye::container::mp4::register_mp4(&mut containers);
    let mut codecs = ye::codec::CodecRegistry::new();
    ye::codec_h264::register_h264(&mut codecs);
    ye::codec_h264::register_h264_encoder(&mut codecs);
    ye::codec_aac::register_aac(&mut codecs);
    ye::codec_aac::register_aac_encoder(&mut codecs);

    let compose_segments: Result<Vec<ye::compose::ComposeSegment>, String> = segments
        .iter()
        .map(|seg| {
            let file = File::open(&seg.path).map_err(|e| format!("{}: {e}", seg.path))?;
            Ok(ye::compose::ComposeSegment {
                input: Box::new(BufReader::new(file)),
                trim_in_us: seg.trim_in_us,
                trim_out_us: seg.trim_out_us,
            })
        })
        .collect();
    let compose_segments = compose_segments?;

    let transaction = ye::output::OutputTransaction::new(output).map_err(|e| format!("{}: {e}", output.display()))?;
    let out_file = transaction.writer().map_err(|e| e.to_string())?;
    let settings = ye::compose::ComposeSettings {
        width: spec.size.0,
        height: spec.size.1,
        frame_rate: spec.frame_rate,
        // GOP 250 对齐 x264 缺省（ffmpeg 轨未显式设 GOP）。
        gop: 250,
        quality: ye::codec::QualityMode::Crf(spec.crf),
        bit_rate: None,
        audio: if spec.strip_audio {
            AudioEncodeSettings::Drop
        } else {
            AudioEncodeSettings::Aac {
                bitrate_bps: spec.audio_bitrate_kbps.unwrap_or(128) * 1_000,
            }
        },
    };
    let stats = ye::compose::compose(
        &containers,
        &codecs,
        compose_segments,
        "mp4",
        Box::new(out_file),
        &settings,
        ye::convert::filter_ops(),
        progress,
        cancel,
    )
    .map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(stats)
}

/// 跑导出（ye 引擎）：与 ffmpeg.rs 的 run_export 同一事件契约（复用
/// export-progress 事件名，见模块文档）与取消语义（cancel_export_ye 置位
/// → 泵返回 Cancelled → 本函数走 Err 分支；「用户取消」与「真失败」的
/// 区分由前端判断，Rust 不猜——与 ffmpeg/duan 轨口径一致）。
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn run_export_ye(
    app: tauri::AppHandle,
    segments: Vec<SegmentArg>,
    out_path: String,
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    crf: u8,
    audio_bitrate_kbps: Option<u32>,
    strip_audio: bool,
    total_us: i64,
) -> Result<(), String> {
    let spec = parse_export_ye_options(
        &segments,
        width,
        height,
        fps_num,
        fps_den,
        crf,
        audio_bitrate_kbps,
        strip_audio,
    )?;
    let output = Path::new(&out_path);
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建输出目录失败（{}）: {e}", parent.display()))?;
    }

    let cancel = Arc::new(AtomicBool::new(false));
    CANCEL_SLOT
        .lock()
        .map_err(|_| "取消旗标表锁已中毒".to_string())?
        .replace(Arc::clone(&cancel));

    let fallback_total = total_us;
    let result = export_ye_impl(
        &segments,
        output,
        &spec,
        &cancel,
        &move |processed, total| {
            // 泵的 total 为 0（极端缺时长）时退回前端兜底值。
            let total = if total > 0 { total } else { fallback_total };
            let _ = app.emit(
                "export-progress",
                ExportProgress {
                    time_us: processed,
                    total_us: total,
                },
            );
        },
    );

    // 摘除取消旗标：只摘自己登记的那份（后继导出覆盖槽位的极端情形不误摘）。
    let mut mine = CANCEL_SLOT
        .lock()
        .map_err(|_| "取消旗标表锁已中毒".to_string())?;
    if mine.as_ref().is_some_and(|r| Arc::ptr_eq(r, &cancel)) {
        *mine = None;
    }
    result.map(|_| ())
}

/// 取消进行中的 ye 导出：置位旗标。返回是否真的置位——false 表示当前
/// 没有进行中的 ye 导出（已结束/从未启动/走的是 ffmpeg 引擎）。
#[tauri::command]
pub fn cancel_export_ye() -> Result<bool, String> {
    let slot = CANCEL_SLOT
        .lock()
        .map_err(|_| "取消旗标表锁已中毒".to_string())?;
    match slot.as_ref() {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            Ok(true)
        }
        None => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(path: &str, in_us: i64, out_us: i64) -> SegmentArg {
        SegmentArg {
            path: path.to_string(),
            trim_in_us: in_us,
            trim_out_us: out_us,
        }
    }

    #[test]
    fn 合法参数组装() {
        let segments = vec![
            seg("a.mp4", 0, 2_000_000),
            seg("b.mp4", 1_000_000, 3_000_000),
        ];
        let spec =
            parse_export_ye_options(&segments, 320, 240, 15, 1, 23, Some(128), false).unwrap();
        assert_eq!(spec.size, (320, 240));
        assert_eq!(spec.frame_rate, ye::time::Rational::new(15, 1));
        assert_eq!(spec.crf, 23);
        assert_eq!(spec.audio_bitrate_kbps, Some(128));
        assert!(!spec.strip_audio);

        let spec = parse_export_ye_options(&segments, 176, 144, 30, 1, 18, None, true).unwrap();
        assert!(spec.strip_audio);
        assert_eq!(spec.audio_bitrate_kbps, None);
    }

    #[test]
    fn 非法参数全拒() {
        let ok_seg = vec![seg("a.mp4", 0, 2_000_000)];
        // 空片段表
        assert!(parse_export_ye_options(&[], 320, 240, 15, 1, 23, Some(128), false).is_err());
        // 奇数/零画幅
        assert!(parse_export_ye_options(&ok_seg, 321, 240, 15, 1, 23, Some(128), false).is_err());
        assert!(parse_export_ye_options(&ok_seg, 320, 0, 15, 1, 23, Some(128), false).is_err());
        // 零帧率 / 分母超 i32
        assert!(parse_export_ye_options(&ok_seg, 320, 240, 0, 1, 23, Some(128), false).is_err());
        assert!(parse_export_ye_options(&ok_seg, 320, 240, 15, 0, 23, Some(128), false).is_err());
        assert!(
            parse_export_ye_options(&ok_seg, 320, 240, 15, u32::MAX, 23, Some(128), false).is_err()
        );
        // CRF 越界
        assert!(parse_export_ye_options(&ok_seg, 320, 240, 15, 1, 0, Some(128), false).is_err());
        assert!(parse_export_ye_options(&ok_seg, 320, 240, 15, 1, 52, Some(128), false).is_err());
        // 码率越界 / 剥轨互斥 / 非剥轨缺码率
        assert!(parse_export_ye_options(&ok_seg, 320, 240, 15, 1, 23, Some(0), false).is_err());
        assert!(
            parse_export_ye_options(&ok_seg, 320, 240, 15, 1, 23, Some(4_000_001), false).is_err()
        );
        assert!(parse_export_ye_options(&ok_seg, 320, 240, 15, 1, 23, Some(128), true).is_err());
        assert!(parse_export_ye_options(&ok_seg, 320, 240, 15, 1, 23, None, false).is_err());
        // 窗口形状：负起点 / 空窗
        let bad = vec![seg("a.mp4", -1, 2_000_000)];
        assert!(parse_export_ye_options(&bad, 320, 240, 15, 1, 23, Some(128), false).is_err());
        let bad = vec![seg("a.mp4", 2_000_000, 2_000_000)];
        assert!(parse_export_ye_options(&bad, 320, 240, 15, 1, 23, Some(128), false).is_err());
    }

    /// 失败即删半成品：不存在的素材路径 → Err 且输出文件被清理。
    #[test]
    fn 失败删除半成品() {
        let spec = parse_export_ye_options(
            &[seg("jian-export-ye-测试不存在的素材.mp4", 0, 2_000_000)],
            320,
            240,
            15,
            1,
            23,
            Some(128),
            false,
        )
        .unwrap();
        let out = std::env::temp_dir().join("jian-export-ye-halfwritten-test.mp4");
        let result = export_ye_impl(
            &[seg("jian-export-ye-测试不存在的素材.mp4", 0, 2_000_000)],
            &out,
            &spec,
            &AtomicBool::new(false),
            &|_, _| {},
        );
        assert!(result.is_err(), "不存在的素材必须 Err：{result:?}");
        assert!(
            !out.exists(),
            "失败后半成品输出文件应被删除：{}",
            out.display()
        );
    }
}
