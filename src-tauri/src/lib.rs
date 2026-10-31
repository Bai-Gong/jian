// 百工·剪：官方插件 + 自研命令（ffprobe/ye 双引擎探测，ffmpeg/ye 双引擎
// 抽帧与波形，ffmpeg/ye 双引擎导出执行）。
// 命令实现见 probe.rs、ffmpeg.rs、ye_engine.rs、waveform.rs、export_ye.rs；
// 导出参数由前端 buildExportArgs（ffmpeg 轨）/ buildYeExportParams（ye 轨）
// 生成，这里只负责执行与进度事件。
// ye_engine.rs 是进程内抽帧引擎、waveform.rs 是波形双引擎（ye 优先轨 +
// ffmpeg 回退轨，两轨 pub 纯库函数拆分供独立调用，回退决策在命令内
// auto_route，详见两模块文档；抽帧的回退决策归前端 thumbnail.ts）。
// export_ye.rs 是进程内导出引擎（ye::compose 顺序拼接合成泵的命令封装，
// M4 首轮：能力面外由前端翻译层提前拒绝，进度事件复用 ffmpeg 轨的
// export-progress，取消走单槽 AtomicBool 表）。
// probe/waveform/ye_engine/export_ye 四模块 pub 供单元测试与集成测试
// （tests/parity.rs 对拍、tests/export_ye_e2e.rs 端到端）直调生产路径
// （duan lib.rs 同款先例）；ffmpeg 模块无直调需求，保持私有。
pub mod export_ye;
mod ffmpeg;
#[cfg(test)]
mod frame;
pub mod probe;
pub mod runtime;
pub mod waveform;
pub mod ye_engine;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            runtime::media_runtime_info,
            probe::probe_media,
            ffmpeg::ffmpeg_info,
            ffmpeg::extract_frame,
            ye_engine::extract_frame_ye,
            // 波形命令串列于抽帧两命令之后（同段串行注册），导出执行收尾
            waveform::waveform,
            ffmpeg::run_export,
            // ye 导出引擎（M4 接线轨）：与 run_export 同一事件契约，取消单列
            export_ye::run_export_ye,
            export_ye::check_timeline_ye,
            export_ye::run_timeline_ye,
            export_ye::cancel_export_ye,
        ])
        .run(tauri::generate_context!())
        .expect("error while running jian");
}
