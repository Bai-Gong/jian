// 百工·剪：M0 骨架阶段 Rust 侧保持轻量，仅注册官方插件，无自研命令（docs/开发方案.md 第 3 节）。
// M1 起 ffprobe / ffmpeg 封装（sidecar 执行、进度事件）在本 crate 落地。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        .run(tauri::generate_context!())
        .expect("error while running jian");
}
