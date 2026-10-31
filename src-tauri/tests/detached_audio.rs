use jian_lib::{
    audio_preview::{cleanup, selected_audio_preview},
    export_ye::{TimelineRequest, timeline_export_impl, timeline_issues},
    probe::probe_media,
};
use serde_json::json;
use std::{fs, process::Command, sync::atomic::AtomicBool};
#[test]
fn five_source_tracks_probe_preview_waveform_and_export_keep_identity() {
    let root = std::env::temp_dir().join(format!("jian-detach-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let input = root.join("source.mp4");
    let made = Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=red:size=32x32:rate=12:duration=0.5",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=0.5",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:sample_rate=48000:duration=0.5",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-map",
            "2:a",
            "-map",
            "1:a",
            "-map",
            "2:a",
            "-map",
            "1:a",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            "-aac_pns",
            "0",
        ])
        .arg(&input)
        .output()
        .unwrap();
    assert!(
        made.status.success(),
        "{}",
        String::from_utf8_lossy(&made.stderr)
    );
    let probe = probe_media(input.to_string_lossy().into(), Some("ye".into())).unwrap();
    assert_eq!(probe.audio_streams.len(), 5);
    assert_eq!(
        probe
            .audio_streams
            .iter()
            .map(|s| s.index)
            .collect::<Vec<_>>(),
        [1, 2, 3, 4, 5]
    );
    let preview = selected_audio_preview(&input, 2).unwrap();
    assert_eq!(
        selected_audio_preview(&input, 2).unwrap().path,
        preview.path
    );
    assert!(selected_audio_preview(&input, 0).is_err());
    assert!(selected_audio_preview(&input, 99).is_err());
    assert!(preview.source_origin_us < 0);
    assert_eq!(preview.valid_start_us, 0);
    assert_eq!(preview.valid_end_us, 500000);
    let decode = |source: &std::path::Path, map: &str, seek: f64| {
        let result = Command::new("ffmpeg")
            .args(["-v", "error", "-i"])
            .arg(source)
            .args([
                "-map",
                map,
                "-ss",
                &format!("{seek:.9}"),
                "-t",
                "0.5",
                "-f",
                "f32le",
                "-",
            ])
            .output()
            .unwrap();
        assert!(result.status.success());
        result.stdout
    };
    let original = decode(&input, "0:2", 0.0);
    let extracted = decode(
        std::path::Path::new(&preview.path),
        "0:a:0",
        -(preview.source_origin_us as f64) / 1e6,
    );
    assert_eq!(original.len(), extracted.len());
    assert_eq!(
        original, extracted,
        "selected preview packets must decode identically after origin mapping"
    );
    let first = jian_lib::waveform::waveform_stream(input.to_string_lossy().into(), 64, 1).unwrap();
    let second =
        jian_lib::waveform::waveform_stream(input.to_string_lossy().into(), 64, 2).unwrap();
    assert_ne!(
        first.peaks[0].iter().map(|p| p.min).collect::<Vec<_>>(),
        second.peaks[0].iter().map(|p| p.min).collect::<Vec<_>>()
    );
    let mut layers = vec![
        json!({"path":input,"sourceInUs":0,"sourceOutUs":500000,"timelineStartUs":0,"timelineEndUs":500000,"kind":"video","x":0,"y":0,"scale":1,"rotation":0,"opacity":1,"z":0}),
    ];
    for stream in 1..=5 {
        layers.push(json!({"path":input,"streamIndex":stream,"sourceInUs":0,"sourceOutUs":500000,"timelineStartUs":0,"timelineEndUs":500000,"kind":"audio","gain":0.1,"pan":0}));
    }
    let mut request:TimelineRequest=serde_json::from_value(json!({"width":32,"height":32,"fpsNum":12,"fpsDen":1,"totalUs":500000,"features":[],"clips":layers})).unwrap();
    assert!(timeline_issues(&request).is_empty());
    let out = root.join("output.mp4");
    let stats = timeline_export_impl(&request, &out, &AtomicBool::new(false), &|_, _| {}).unwrap();
    assert_eq!(stats.video_frames, 6);
    assert_eq!(stats.streams, 2);
    request.clips[1].stream_index = Some(0);
    assert!(!timeline_issues(&request).is_empty());
    request.clips[1].stream_index = None;
    assert!(!timeline_issues(&request).is_empty());
    cleanup();
    assert!(!std::path::Path::new(&preview.path).exists());
    fs::remove_file(input).unwrap();
    fs::remove_file(out).unwrap();
    fs::remove_dir(root).unwrap();
}
