// 百工·剪：官方插件 + M1 自研命令（ffprobe 探测 / ffmpeg 定位、抽帧、波形峰值、导出执行）。
// 命令实现见 probe.rs、ffmpeg.rs、frame.rs、waveform.rs；导出参数由前端
// buildExportArgs 生成，这里只负责执行与进度事件。抽帧默认 ye（百工·冶）
// 主链、ffmpeg 回退（frame.rs）；波形峰值默认 ye AAC 主链、ffmpeg 回退
// （waveform.rs）。
mod ffmpeg;
mod frame;
mod probe;
mod waveform;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            probe::probe_media,
            ffmpeg::ffmpeg_info,
            frame::extract_frame,
            waveform::waveform_peaks,
            ffmpeg::run_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running jian");
}
