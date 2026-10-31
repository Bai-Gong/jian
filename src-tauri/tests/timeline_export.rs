#![cfg(not(feature = "compat-ffmpeg"))]
use jian_lib::export_ye::{TimelineRequest, timeline_export_impl, timeline_issues};
use serde_json::json;
use std::{fs::File, process::Command, sync::atomic::AtomicBool};

#[test]
fn static_timeline_runs_through_product_backend_and_preserves_existing_output() {
    let worker_root = std::env::var_os("JIAN_PURE_WORKER").map(std::path::PathBuf::from);
    let root = worker_root.clone().unwrap_or_else(|| {
        std::env::temp_dir().join(format!(
            "jian-timeline-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    });
    std::fs::create_dir_all(&root).unwrap();
    let (input, output) = (root.join("source.mp4"), root.join("output.mp4"));
    if worker_root.is_none() {
        let made = Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=red:size=32x32:rate=10:duration=1",
                "-f",
                "lavfi",
                "-i",
                "sine=sample_rate=44100:duration=1",
                "-c:v",
                "libx264",
                "-profile:v",
                "high",
                "-bf",
                "2",
                "-c:a",
                "aac",
                "-y",
            ])
            .arg(&input)
            .status()
            .unwrap();
        assert!(made.success());
        let result = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "static_timeline_runs_through_product_backend_and_preserves_existing_output",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("JIAN_PURE_WORKER", &root)
            .env("PATH", "")
            .env("BJ_FFMPEG_DIR", root.join("missing-tools"))
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        return;
    }
    assert_eq!(std::env::var_os("PATH").unwrap(), "");
    assert!(
        !jian_lib::runtime::media_runtime_info()
            .unwrap()
            .compat_ffmpeg
    );
    let probe = jian_lib::probe::probe_media(input.to_string_lossy().into(), None).unwrap();
    assert_eq!(probe.used_engine, "ye");
    assert_eq!(probe.width, 32);
    let png = jian_lib::ye_engine::extract_frame_ye_impl(&input, 250000).unwrap();
    assert!(std::fs::read(&png).unwrap().starts_with(b"\x89PNG"));
    std::fs::remove_file(png).unwrap();
    let waveform = jian_lib::waveform::waveform(input.to_string_lossy().into(), 64).unwrap();
    assert_eq!(waveform.used_engine, "ye");
    assert_eq!(waveform.buckets, 64);
    let window = json!({"path":input,"sourceInUs":0,"sourceOutUs":1000000,"timelineStartUs":0,"timelineEndUs":1000000});
    let layer = |kind: &str, extra: serde_json::Value| {
        let mut l = window.clone();
        l["kind"] = json!(kind);
        for (k, v) in extra.as_object().unwrap() {
            l[k] = v.clone();
        }
        l
    };
    let mut request:TimelineRequest=serde_json::from_value(json!({"width":32,"height":32,"fpsNum":10,"fpsDen":1,"totalUs":1000000,"features":[],"clips":[
        layer("video",json!({"x":0,"y":0,"scale":1,"rotation":0,"opacity":1,"z":0})),
        layer("video",json!({"x":8,"y":0,"scale":0.5,"rotation":45,"opacity":0.5,"z":1})),
        layer("audio",json!({"gain":0.5,"pan":-1})),layer("audio",json!({"gain":0.25,"pan":1}))]})).unwrap();
    assert!(timeline_issues(&request).is_empty());
    let stats =
        timeline_export_impl(&request, &output, &AtomicBool::new(false), &|_, _| {}).unwrap();
    assert_eq!(stats.video_frames, 10);
    let before = std::fs::read(&output).unwrap();
    assert!(timeline_export_impl(&request, &output, &AtomicBool::new(false), &|_, _| {}).is_err());
    assert_eq!(std::fs::read(&output).unwrap(), before);
    let canceled = root.join("canceled.mp4");
    assert!(timeline_export_impl(&request, &canceled, &AtomicBool::new(true), &|_, _| {}).is_err());
    assert!(!canceled.exists());
    request.features=serde_json::from_value(json!([{"label":"clip","sourceKind":"image","speed":2,"animated":["x"],"effects":1,"transition":true}])).unwrap();
    let issues = timeline_issues(&request);
    assert_eq!(issues.len(), 5);
    assert!(issues.iter().any(|i| i.contains("关键帧")));
    let _ = File::open(&output).unwrap();
    std::fs::remove_file(input).unwrap();
    std::fs::remove_file(output).unwrap();
    std::fs::remove_dir(root).unwrap();
}
