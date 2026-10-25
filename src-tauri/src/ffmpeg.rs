//! ffmpeg 执行封装：路径解析（M1 施工契约 §1）、抽帧、导出执行。
//! 路径解析三档：BJ_FFMPEG_DIR → src-tauri/binaries（sidecar）→ 系统 PATH。

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use serde::Serialize;
use tauri::Emitter;

/// ffmpeg 可执行文件定位结果。source ∈ {"env","sidecar","path"}。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegInfo {
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    pub source: String,
}

/// 导出进度事件负载（事件名 export-progress）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub time_us: i64,
    pub total_us: i64,
}

/// 定位结果缓存：进程内只查一次，失败也缓存（换 PATH 得重启应用）。
static FFMPEG_INFO: OnceLock<Result<FfmpegInfo, String>> = OnceLock::new();

/// 解析 ffmpeg/ffprobe 位置。错误信息直接给前端看，不 panic。
#[tauri::command]
pub fn ffmpeg_info() -> Result<FfmpegInfo, String> {
    FFMPEG_INFO.get_or_init(resolve_ffmpeg_info).clone()
}

fn resolve_ffmpeg_info() -> Result<FfmpegInfo, String> {
    // ① BJ_FFMPEG_DIR：要求两个 exe 都在，缺一视为未配置，走下一档
    if let Some(dir) = std::env::var_os("BJ_FFMPEG_DIR").map(PathBuf::from) {
        let pair = exe_pair_in(&dir);
        if let Some((ff, fp)) = pair {
            return ok_info(ff, fp, "env");
        }
    }
    // ② sidecar 目录：dev 时 cwd=src-tauri；打包后在 exe 同目录的 binaries/
    for base in sidecar_dirs() {
        if let Some((ff, fp)) = exe_pair_in(&base) {
            return ok_info(ff, fp, "sidecar");
        }
    }
    // ③ 系统 PATH（which 逻辑，Windows 补 .exe/.cmd/.bat 后缀）
    let hint = "请安装 FFmpeg、设置 BJ_FFMPEG_DIR，或运行 node scripts/fetch-ffmpeg.mjs 下载到 src-tauri/binaries/";
    let ff = find_in_path("ffmpeg").ok_or_else(|| format!("PATH 里找不到 ffmpeg，{hint}"))?;
    let fp = find_in_path("ffprobe").ok_or_else(|| format!("PATH 里找不到 ffprobe，{hint}"))?;
    ok_info(ff, fp, "path")
}

/// 目录下找 ffmpeg/ffprobe 两个可执行文件，缺一返回 None。
fn exe_pair_in(dir: &Path) -> Option<(PathBuf, PathBuf)> {
    let ff = dir.join(exe_file_name("ffmpeg"));
    let fp = dir.join(exe_file_name("ffprobe"));
    (ff.is_file() && fp.is_file()).then_some((ff, fp))
}

/// sidecar 候选目录：cwd/binaries（dev）与 exe 同目录/binaries（打包后）。
fn sidecar_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd.join("binaries"));
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        dirs.push(dir.join("binaries"));
    }
    dirs
}

fn exe_file_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// 在 PATH 各目录里找可执行文件（Windows 上按裸名→.exe→.cmd→.bat 依次试）。找不到返回 None。
fn find_in_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let candidates: Vec<String> = if cfg!(windows) {
        vec![
            name.to_string(),
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
        ]
    } else {
        vec![name.to_string()]
    };
    for dir in std::env::split_paths(&path_var) {
        for cand in &candidates {
            let p = dir.join(cand);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn ok_info(ff: PathBuf, fp: PathBuf, source: &str) -> Result<FfmpegInfo, String> {
    Ok(FfmpegInfo {
        ffmpeg_path: ff.to_string_lossy().into_owned(),
        ffprobe_path: fp.to_string_lossy().into_owned(),
        source: source.to_string(),
    })
}

/// 抽帧（ffmpeg 引擎，oracle 与回退路径）：取 path 在 time_us 处的一帧，
/// 写成临时目录下的 PNG，返回文件绝对路径。微秒换算成秒（6 位小数保住
/// 微秒精度）；-frames:v 1 只要一帧。命令位（`extract_frame`）在 frame.rs，
/// 默认走 ye、失败回退到本函数。
pub(crate) fn extract_frame_ffmpeg(path: &str, time_us: i64) -> Result<String, String> {
    let ffmpeg = ffmpeg_info()?.ffmpeg_path;
    let time_us = time_us.max(0); // 负时间对 -ss 无意义，钳到 0
    let time_s = format!("{:.6}", time_us as f64 / 1e6);
    let out = std::env::temp_dir().join(format!("jian-frame-{}.png", unique_token()));
    let result = Command::new(&ffmpeg)
        .arg("-y")
        .arg("-ss")
        .arg(&time_s)
        .arg("-i")
        .arg(path)
        .arg("-frames:v")
        .arg("1")
        .arg(&out)
        .output()
        .map_err(|e| format!("启动 ffmpeg 失败（{ffmpeg}）: {e}"))?;
    if !result.status.success() {
        return Err(format!(
            "抽帧失败（{path}）: {}",
            stderr_tail(&result.stderr)
        ));
    }
    Ok(out.to_string_lossy().into_owned())
}

/// 进程内唯一文件名片段：纳秒时间戳 + 自增计数，足够临时文件去重。
pub(crate) fn unique_token() -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{nanos}-{n}")
}

/// 跑导出：args 由前端 buildExportArgs 生成（已含 -progress pipe:1 -nostats 与输出路径）。
/// 逐行读 stdout，见 out_time_us=N 就发 export-progress 事件；退出码非零回传 stderr 尾部。
/// out_path 此处只用来兜底建父目录，不追加进 args（args 已带，重复追加会报错）。
#[tauri::command(async)]
pub fn run_export(
    app: tauri::AppHandle,
    args: Vec<String>,
    out_path: String,
    total_us: i64,
) -> Result<(), String> {
    let ffmpeg = ffmpeg_info()?.ffmpeg_path;
    if let Some(parent) = std::path::Path::new(&out_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建输出目录失败（{}）: {e}", parent.display()))?;
    }
    let mut child = Command::new(&ffmpeg)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 ffmpeg 失败（{ffmpeg}）: {e}"))?;

    // stderr 单开线程收，防它塞满管道把 ffmpeg 卡死
    let stderr = child.stderr.take().ok_or("拿不到 ffmpeg 的 stderr")?;
    let stderr_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut reader = stderr;
        let _ = reader.read_to_end(&mut buf);
        buf
    });

    let stdout = child.stdout.take().ok_or("拿不到 ffmpeg 的 stdout")?;
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|e| format!("读 ffmpeg 进度失败: {e}"))?;
        if let Some(time_us) = parse_out_time_us(&line) {
            let _ = app.emit("export-progress", ExportProgress { time_us, total_us });
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("等待 ffmpeg 退出失败: {e}"))?;
    let stderr_buf = stderr_handle
        .join()
        .map_err(|_| "stderr 读取线程崩溃".to_string())?;
    if !status.success() {
        return Err(format!(
            "ffmpeg 导出失败（退出码 {:?}）: {}",
            status.code(),
            stderr_tail(&stderr_buf)
        ));
    }
    Ok(())
}

/// 解析 ffmpeg -progress 输出里的 `out_time_us=N` 行（微秒整数）。
/// 无关行或 N/A 返回 None。纯函数，供单测。
fn parse_out_time_us(line: &str) -> Option<i64> {
    let value = line.strip_prefix("out_time_us=")?.trim();
    value.parse::<i64>().ok()
}

/// 取 stderr 尾部（约 500 字符）转成字符串，报错时给前端看原因。
pub(crate) fn stderr_tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let chars: Vec<char> = text.chars().collect();
    let start = chars.len().saturating_sub(500);
    chars[start..].iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn out_time_us_行解析出微秒整数() {
        assert_eq!(parse_out_time_us("out_time_us=123"), Some(123));
        assert_eq!(parse_out_time_us("out_time_us=-456"), Some(-456));
        assert_eq!(parse_out_time_us("out_time_us=123\r\n"), Some(123)); // Windows 换行
    }

    #[test]
    fn 无关行与非法值返回_none() {
        assert_eq!(parse_out_time_us("frame=42"), None);
        assert_eq!(parse_out_time_us("out_time=00:00:01.000000"), None);
        assert_eq!(parse_out_time_us("out_time_us=N/A"), None);
        assert_eq!(parse_out_time_us(""), None);
    }
}
