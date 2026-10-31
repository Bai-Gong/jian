//! Opt-in acceptance using an original recording, never rewriting the input.
use jian_lib::{audio_preview, export_ye, probe, ye_engine};
use serde_json::json;
use std::{fs, io::Write, path::PathBuf, sync::atomic::AtomicBool};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 {
        return Err("original recording and new output directory required".into());
    }
    let original = PathBuf::from(&args[0]);
    let dir = PathBuf::from(&args[1]);
    fs::create_dir(&dir)?;
    let info = probe::probe_media(original.to_string_lossy().into(), Some("ye".into()))?;
    println!(
        "original {}x{} @{}: {} audio streams",
        info.width,
        info.height,
        info.fps,
        info.audio_streams.len()
    );
    for time in [0, 1_250_000, 42_130_000] {
        let started = std::time::Instant::now();
        let png = ye_engine::timeline_thumbnail_impl(&original, time)?;
        let width = u32::from_be_bytes(png[16..20].try_into()?);
        let height = u32::from_be_bytes(png[20..24].try_into()?);
        assert!(width <= 192 && height <= 96);
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dir.join(format!("frame-{time}.png")))?
            .write_all(&png)?;
        println!(
            "thumbnail {time}: {width}x{height}, {:?}",
            started.elapsed()
        );
    }
    let mut clips = vec![json!({"path":original,"sourceInUs":0,"sourceOutUs":500000,
        "timelineStartUs":0,"timelineEndUs":500000,"kind":"video","scale":0.04,
        "x":0,"y":0,"rotation":0,"opacity":1,"z":0})];
    for stream in &info.audio_streams {
        let preview = audio_preview::selected_audio_preview(&original, stream.index)?;
        println!(
            "audio {} preview: origin={} valid={}..{}",
            stream.index, preview.source_origin_us, preview.valid_start_us, preview.valid_end_us
        );
        clips.push(
            json!({"path":original,"streamIndex":stream.index,"sourceInUs":0,"sourceOutUs":500000,
            "timelineStartUs":0,"timelineEndUs":500000,"kind":"audio","gain":0.1,"pan":0}),
        );
    }
    let request: export_ye::TimelineRequest =
        serde_json::from_value(json!({"width":160,"height":90,
        "fpsNum":12,"fpsDen":1,"totalUs":500000,"features":[],"clips":clips}))?;
    assert!(export_ye::timeline_issues(&request).is_empty());
    let result = export_ye::timeline_export_impl(
        &request,
        &dir.join("five-audio.mp4"),
        &AtomicBool::new(false),
        &|_, _| {},
    );
    audio_preview::cleanup();
    println!("original selected-stream export: {:?}", result?);
    Ok(())
}
