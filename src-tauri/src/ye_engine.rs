//! 纯冶抽帧：素材箱返回原尺寸临时 PNG，时间线返回尺寸受限的 PNG 字节。
//! 只解码视频，忽略无关音轨；能力不足或损坏素材如实报错，不回退外部工具。
//! 时间线不生成临时图片文件，前端负责可视窗口调度与有界缓存。

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

/// 错误保留素材路径与冶的原始原因，不声称回退成功。
fn ye_grab_error(path: &str, err: &ConvertError) -> String {
    format!("ye 抽帧失败（{path}）: {err}")
}

/// 抽帧主体（纯库调用，不碰 Tauri 类型）：打开素材 → ye 门面取帧并编码
/// PNG → 写 %TEMP% 下 `jian-frame-{纳秒-计数}.png` → 返回该文件绝对路径。
///
/// 打开、视频解码或落盘失败时返回错误；写入失败只删除自有半成品。
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
/// 返回文件绝对路径；失败直接交给前端显示。
#[tauri::command(async)]
pub fn extract_frame_ye(path: String, time_us: i64) -> Result<String, String> {
    extract_frame_ye_impl(Path::new(&path), time_us)
}

/// Bounded in-memory filmstrip images: no full-resolution PNG or temporary file
/// is retained for each visible cell. Audio streams do not participate in decode.
pub fn timeline_thumbnail_impl(path: &Path, time_us: i64) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|e| format!("无法打开视频（{}）：{e}", path.display()))?;
    let frame = ye::frame_grab::decode_frame_rgba(Box::new(BufReader::new(file)), time_us)
        .map_err(|e| ye_grab_error(&path.display().to_string(), &e))?;
    let scale = (192.0 / frame.width as f64)
        .min(96.0 / frame.height as f64)
        .min(1.0);
    let width = ((frame.width as f64 * scale).floor() as u32).max(1);
    let height = ((frame.height as f64 * scale).floor() as u32).max(1);
    let rgba = ye::filter::scale_rgba(
        &frame.rgba,
        frame.width as usize,
        frame.height as usize,
        width as usize,
        height as usize,
    )
    .map_err(|e| format!("缩略图缩放失败：{e}"))?;
    ye::png::encode_rgba(width, height, &rgba).map_err(|e| format!("缩略图编码失败：{e}"))
}

#[tauri::command(async)]
pub fn timeline_thumbnail(path: String, time_us: i64) -> Result<Vec<u8>, String> {
    timeline_thumbnail_impl(Path::new(&path), time_us)
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
