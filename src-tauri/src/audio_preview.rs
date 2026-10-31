//! 独立音轨预览：只重封装指定 AAC 流，WebView 继续原生解码。
//! 返回首包对应的源时点，前端据此定位并排除 edit list 外的 priming/padding。
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::{self, File},
    io::BufReader,
    path::{Path, PathBuf},
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::UNIX_EPOCH,
};
use ye::{
    codec::MediaType,
    container::mp4::{Layout, Mp4Reader, Mp4Writer, Mp4WriterOptions, TrackConfig},
    time::{Rational, Timestamp},
};
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioPreview {
    pub path: String,
    pub source_origin_us: i64,
    pub valid_start_us: i64,
    pub valid_end_us: i64,
}
static CACHE: OnceLock<Mutex<HashMap<String, AudioPreview>>> = OnceLock::new();
static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
static NEXT: AtomicU64 = AtomicU64::new(0);
pub fn selected_audio_preview(path: &Path, stream_index: u32) -> Result<AudioPreview, String> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    let stamp = metadata
        .modified()
        .ok()
        .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
        .map(|v| v.as_nanos())
        .unwrap_or(0);
    let key = format!(
        "{}:{stream_index}:{}:{stamp}",
        path.display(),
        metadata.len()
    );
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = cache
        .lock()
        .map_err(|_| "音轨缓存锁失败")?
        .get(&key)
        .cloned()
    {
        return Ok(hit);
    }
    let descriptor = build(path, stream_index)?;
    let mut guard = cache.lock().map_err(|_| "音轨缓存锁失败")?;
    if let Some(existing) = guard.get(&key) {
        let _ = fs::remove_file(&descriptor.path);
        return Ok(existing.clone());
    }
    guard.insert(key, descriptor.clone());
    Ok(descriptor)
}
fn build(path: &Path, stream_index: u32) -> Result<AudioPreview, String> {
    let header = ye::media::inspect(Box::new(BufReader::new(
        File::open(path).map_err(|e| e.to_string())?,
    )))
    .map_err(|e| e.to_string())?;
    let stream = ye::timeline::select_stream(&header, MediaType::Audio, Some(stream_index))
        .map_err(|e| e.to_string())?;
    let mut codecs = ye::codec::CodecRegistry::new();
    ye::codec_aac::register_aac(&mut codecs);
    codecs
        .create_decoder(&stream.codec)
        .map_err(|e| e.to_string())?;
    let micro = Rational::new(1, 1000000);
    let start = stream
        .start_time
        .unwrap_or(Timestamp::new(0, stream.time_base));
    let end = start
        .checked_add(stream.duration.ok_or("音轨缺少时长")?)
        .map_err(|e| e.to_string())?;
    let mut reader = Mp4Reader::from_reader(BufReader::with_capacity(
        262144,
        File::open(path).map_err(|e| e.to_string())?,
    ))
    .map_err(|e| e.to_string())?;
    let count = reader
        .sample_count(stream_index as usize)
        .map_err(|e| e.to_string())?;
    if count == 0 {
        return Err("音轨没有采样包".into());
    }
    let mut first = reader
        .read_packet(stream_index as usize, 0)
        .map_err(|e| e.to_string())?;
    let shift = first.dts.ok_or("音轨缺少DTS")?;
    let edit = stream
        .metadata
        .get("mp4.edit.shift_ticks")
        .unwrap_or("0")
        .parse::<i64>()
        .map_err(|e| e.to_string())?;
    let origin = first
        .pts
        .ok_or("音轨缺少PTS")?
        .checked_add(Timestamp::new(edit, stream.time_base))
        .map_err(|e| e.to_string())?;
    let directory = DIRECTORY.get_or_init(|| {
        std::env::temp_dir().join(format!(
            "jian-audio-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    });
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let output = directory.join(format!("{}.m4a", NEXT.fetch_add(1, Ordering::Relaxed)));
    let transaction = ye::output::OutputTransaction::new(&output).map_err(|e| e.to_string())?;
    let mut writer = Mp4Writer::new(
        transaction.writer().map_err(|e| e.to_string())?,
        Mp4WriterOptions {
            layout: Layout::Progressive,
            ..Default::default()
        },
    );
    writer
        .add_stream(TrackConfig::from_stream(stream))
        .map_err(|e| e.to_string())?;
    for index in 0..count {
        let mut packet = if index == 0 {
            std::mem::replace(&mut first, ye::codec::Packet::empty(0))
        } else {
            reader
                .read_packet(stream_index as usize, index)
                .map_err(|e| e.to_string())?
        };
        packet.stream_index = 0;
        packet.dts = packet
            .dts
            .map(|t| t.checked_sub(shift))
            .transpose()
            .map_err(|e| e.to_string())?;
        packet.pts = packet
            .pts
            .map(|t| t.checked_sub(shift))
            .transpose()
            .map_err(|e| e.to_string())?;
        writer.write_packet(&packet).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(AudioPreview {
        path: output.to_string_lossy().into(),
        source_origin_us: origin.rescale(micro).map_err(|e| e.to_string())?.ticks(),
        valid_start_us: start.rescale(micro).map_err(|e| e.to_string())?.ticks(),
        valid_end_us: end.rescale(micro).map_err(|e| e.to_string())?.ticks(),
    })
}
#[tauri::command(async)]
pub fn audio_stream_preview(path: String, stream_index: u32) -> Result<AudioPreview, String> {
    selected_audio_preview(Path::new(&path), stream_index)
}
pub fn cleanup() {
    if let Some(cache) = CACHE.get()
        && let Ok(mut guard) = cache.lock()
    {
        for (_, preview) in guard.drain() {
            let _ = fs::remove_file(preview.path);
        }
    }
    if let Some(directory) = DIRECTORY.get() {
        let _ = fs::remove_dir(directory);
    }
}
