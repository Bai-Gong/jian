// 百工·剪：官方插件 + M1 自研命令（ffprobe 探测 / ffmpeg 定位、抽帧、导出执行）。
// 命令实现见 probe.rs、ffmpeg.rs；导出参数由前端 buildExportArgs 生成，这里只负责执行与进度事件。
mod ffmpeg;
mod probe;

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
            ffmpeg::extract_frame,
            ffmpeg::run_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running jian");
}
