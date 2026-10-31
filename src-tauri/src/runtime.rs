use serde::Serialize;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub engine: &'static str,
    pub version: &'static str,
    pub compat_ffmpeg: bool,
    pub capabilities: Vec<&'static str>,
}
#[tauri::command]
pub fn media_runtime_info() -> Result<RuntimeInfo, String> {
    let mut codecs = ye::codec::CodecRegistry::new();
    ye::codec_h264::register_h264(&mut codecs);
    ye::codec_h264::register_h264_encoder(&mut codecs);
    ye::codec_aac::register_aac(&mut codecs);
    ye::codec_aac::register_aac_encoder(&mut codecs);
    for codec in [ye::codec::CodecId::H264, ye::codec::CodecId::Aac] {
        if !codecs.supports_decoder(codec) || !codecs.supports_encoder(codec) {
            return Err(format!("冶启动自检缺少 {codec:?}"));
        }
    }
    Ok(RuntimeInfo {
        engine: "ye",
        version: ye::VERSION,
        compat_ffmpeg: cfg!(feature = "compat-ffmpeg"),
        capabilities: vec![
            "MP4/M4A",
            "H.264 progressive 8-bit 4:2:0",
            "AAC-LC mono/stereo",
            "static timeline",
        ],
    })
}
