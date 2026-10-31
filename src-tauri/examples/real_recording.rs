//! Opt-in recording acceptance. Ambiguous audio without a source choice is blocked.
//! See multitrack_recording for explicit source selection on the original file.
use jian_lib::export_ye::{TimelineRequest, timeline_export_impl, timeline_issues};
use serde_json::json;
use std::{path::PathBuf, sync::atomic::AtomicBool};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 3 {
        return Err("original, derived clip, output required".into());
    }
    let original = PathBuf::from(&args[0]);
    let clip = PathBuf::from(&args[1]);
    let output = PathBuf::from(&args[2]);
    let info = jian_lib::probe::probe_media(original.to_string_lossy().into(), Some("ye".into()))?;
    println!(
        "original probe: {}x{} @{} engine={}",
        info.width, info.height, info.fps, info.used_engine
    );
    let layers = |path: &std::path::Path| {
        json!([
 {"path":path,"sourceInUs":0,"sourceOutUs":500000,"timelineStartUs":0,"timelineEndUs":500000,"kind":"video","x":0,"y":0,"scale":0.04,"rotation":0,"opacity":1,"z":0},
 {"path":path,"sourceInUs":500000,"sourceOutUs":1000000,"timelineStartUs":250000,"timelineEndUs":750000,"kind":"video","x":30,"y":10,"scale":0.02,"rotation":15,"opacity":0.6,"z":1},
 {"path":path,"sourceInUs":0,"sourceOutUs":500000,"timelineStartUs":0,"timelineEndUs":500000,"kind":"audio","gain":0.5,"pan":-0.5},
 {"path":path,"sourceInUs":500000,"sourceOutUs":1000000,"timelineStartUs":250000,"timelineEndUs":750000,"kind":"audio","gain":0.25,"pan":0.5}])
    };
    let mut request: TimelineRequest = serde_json::from_value(
        json!({"width":160,"height":90,"fpsNum":12,"fpsDen":1,"totalUs":1000000,"features":[],"clips":layers(&original)}),
    )?;
    let issues = timeline_issues(&request);
    assert!(
        issues.iter().any(|i| i.contains("5")),
        "multi-audio must require a track choice: {issues:?}"
    );
    println!("original blockers: {issues:?}");
    request.clips = serde_json::from_value(layers(&clip))?;
    let waveform = jian_lib::waveform::waveform(clip.to_string_lossy().into(), 64)?;
    println!(
        "derived waveform: {} buckets, engine={}",
        waveform.buckets, waveform.used_engine
    );
    let stats = timeline_export_impl(&request, &output, &AtomicBool::new(false), &|_, _| {})?;
    println!("derived 2V+2A output: {stats:?}");
    Ok(())
}
