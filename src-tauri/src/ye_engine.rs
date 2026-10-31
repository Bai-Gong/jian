//! ye 进程内抽帧引擎：门面 [`ye::frame_grab::grab_frame_png`] 的命令封装
//! （jian 缩略图双引擎轨）。
//!
//! 与 ffmpeg.rs 的 [`crate::ffmpeg::extract_frame`] 子进程轨构成「ye 优先、
//! 失败回退」：ye 轨进程内解码无子进程开销；High/CABAC 等解码能力面外、
//! 含不可解音轨打回（ye frame_grab 模块文档「音轨行为」）等**任何** Err
//! 都由前端 thumbnail.ts console.warn 后回退 ffmpeg 轨——本模块错误文案
//! 只述失败原因（能力面外原因原样透传），不声称已回退（回退动作归前端；
//! 与 probe 轨 Rust 内回退的口径不同：抽帧两轨返回值同形（临时 png 路径），
//! 回退放前端可让 warn 落在调用现场，ffmpeg 轨留作 oracle 与兜底）。
//!
//! 分层与 duan ye_engine.rs 同构：命令壳 [`extract_frame_ye`] 只转发；
//! 抽帧主体在 [`extract_frame_ye_impl`]（纯库调用，不碰 Tauri 类型），
//! pub 供单元测试直调。
//!
//! 临时 png 与 ffmpeg 轨同命名约定（%TEMP% 下 `jian-frame-{纳秒-计数}.png`，
//! 见 ffmpeg.rs 的 extract_frame）；永不删除的跨会话堆积沿用 ffmpeg 轨
//! 遗留（docs/待开发.md:29 T8 留档，双引擎后堆积翻倍，只记遗留不新增治理）。

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use ye::convert::ConvertError;

/// 时点钳 0（纯函数，供单测）：负时间对「取首个 pts ≥ 时点的帧」无意义，
/// 钳到 0——与 ffmpeg 轨 ffmpeg.rs 的 extract_frame 同语义（ye 门面内部
/// 亦有同款钳制，这里显式再做一次，保证本轨入口行为不依赖下游版本）。
fn clamp_time_us(time_us: i64) -> i64 {
    time_us.max(0)
}

/// ye 轨错误文案（纯函数，供单测）：中文述因，携带素材路径与 ye 错误
/// 原文（能力面外等原因原样透传）；不出现「回退」字样——回退动作归前端
/// thumbnail.ts，文案声称已回退即与事实不符。
fn ye_grab_error(path: &str, err: &ConvertError) -> String {
    format!("ye 抽帧失败（{path}）: {err}")
}

/// 抽帧主体（纯库调用，不碰 Tauri 类型）：打开素材 → ye 门面取帧并编码
/// PNG → 写 %TEMP% 下 `jian-frame-{纳秒-计数}.png` → 返回该文件绝对路径。
///
/// 失败（打不开 / 解码能力面外 / 音轨打回 / 落盘失败）一律 Err 中文述因，
/// 不兜底、不留半成品（落盘失败时 [`std::fs::write`] 未写出完整文件即返回，
/// 无需另删）。
pub fn extract_frame_ye_impl(path: &Path, time_us: i64) -> Result<String, String> {
    let time_us = clamp_time_us(time_us);
    let file =
        File::open(path).map_err(|e| format!("ye 打开素材失败（{}）: {e}", path.display()))?;
    let png = ye::frame_grab::grab_frame_png(Box::new(BufReader::new(file)), time_us)
        .map_err(|e| ye_grab_error(&path.display().to_string(), &e))?;
    let out = std::env::temp_dir().join(format!("jian-frame-{}.png", unique_token()));
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&out)
        .map_err(|e| format!("ye 写临时 PNG 失败（{}）: {e}", out.display()))?;
    if let Err(e) = file.write_all(&png) {
        drop(file);
        let _ = std::fs::remove_file(&out);
        return Err(e.to_string());
    }
    Ok(out.to_string_lossy().into_owned())
}

/// 进程内唯一文件名片段：纳秒时间戳 + 自增计数，足够临时文件去重。
/// 与 ffmpeg 轨 ffmpeg.rs 的 unique_token 同格式同约定（该函数私有不可
/// 复用，两轨各自计数，前缀同段保证同轨/跨轨均不撞名）。
fn unique_token() -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{nanos}-{n}")
}

/// 抽帧（ye 引擎）：取 path 在 time_us 处的一帧，写成临时目录下的 PNG，
/// 返回文件绝对路径。与 ffmpeg 轨 extract_frame 同入参同返回形状，前端
/// 可无缝二选一；任何失败由前端回退 ffmpeg 轨（见模块文档）。
#[tauri::command(async)]
pub fn extract_frame_ye(path: String, time_us: i64) -> Result<String, String> {
    extract_frame_ye_impl(Path::new(&path), time_us)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 时点钳 0：负值钳 0，0 与正值原样通过。
    #[test]
    fn 时点负值钳到零() {
        assert_eq!(clamp_time_us(-1), 0);
        assert_eq!(clamp_time_us(i64::MIN), 0);
        assert_eq!(clamp_time_us(0), 0);
        assert_eq!(clamp_time_us(123_456), 123_456);
    }

    /// 错误文案中文述因（携带路径与 ye 原文），不声称已回退——回退动作
    /// 归前端，文案出现「回退」即与事实不符。
    #[test]
    fn 错误文案述因且回退归前端() {
        let err = ConvertError::Codec(ye::codec::CodecError::InvalidData(
            "profile not supported (accepted: Baseline/Main/Extended/High family)".into(),
        ));
        let msg = ye_grab_error("C:/素材/high.mp4", &err);
        assert!(msg.contains("ye 抽帧失败"), "文案开头点明轨名：{msg}");
        assert!(msg.contains("C:/素材/high.mp4"), "携带素材路径：{msg}");
        assert!(
            msg.contains("profile not supported"),
            "能力面外原因原样透传：{msg}"
        );
        assert!(!msg.contains("回退"), "回退动作归前端，文案不得声称：{msg}");
    }

    /// 打不开素材：impl 即刻 Err 中文述因（路径原样带回），不进解码。
    #[test]
    fn 素材打不开时中文报错() {
        let missing = Path::new("jian-ye-engine-测试不存在的素材.mp4");
        let err = extract_frame_ye_impl(missing, 0).expect_err("不存在的素材必须 Err");
        assert!(err.contains("ye 打开素材失败"), "点明失败环节：{err}");
        assert!(
            err.contains("jian-ye-engine-测试不存在的素材.mp4"),
            "携带素材路径：{err}"
        );
    }
}
