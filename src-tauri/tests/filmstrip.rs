use jian_lib::ye_engine::timeline_thumbnail_impl;
use std::{fs, process::Command};

#[test]
fn bounded_filmstrip_images_follow_display_time_across_a_long_gop() {
    let dir = std::env::temp_dir().join(format!("jian-filmstrip-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let source = dir.join("colors.mp4");
    let made = Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=red:s=320x180:r=12:d=1",
            "-f",
            "lavfi",
            "-i",
            "color=blue:s=320x180:r=12:d=1",
            "-filter_complex",
            "[0:v][1:v]concat=n=2:v=1:a=0[v]",
            "-map",
            "[v]",
            "-c:v",
            "libx264",
            "-g",
            "48",
            "-bf",
            "3",
            "-sc_threshold",
            "0",
        ])
        .arg(&source)
        .output()
        .unwrap();
    assert!(
        made.status.success(),
        "{}",
        String::from_utf8_lossy(&made.stderr)
    );
    for (n, time) in [0, 750_000, 1_250_000, 1_900_000].into_iter().enumerate() {
        let png = timeline_thumbnail_impl(&source, time).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 170);
        assert_eq!(u32::from_be_bytes(png[20..24].try_into().unwrap()), 96);
        let image = dir.join(format!("{n}.png"));
        fs::write(&image, png).unwrap();
        let decoded = Command::new("ffmpeg")
            .args(["-v", "error", "-i"])
            .arg(&image)
            .args(["-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"])
            .output()
            .unwrap();
        assert!(decoded.status.success());
        let center = &decoded.stdout[(48 * 170 + 85) * 3..][..3];
        if time < 1_000_000 {
            assert!(center[0] > 240 && center[2] < 10, "{time}: {center:?}");
        } else {
            assert!(center[2] > 240 && center[0] < 10, "{time}: {center:?}");
        }
        fs::remove_file(image).unwrap();
    }
    assert!(timeline_thumbnail_impl(&source, 3_000_000).is_err());
    fs::remove_file(source).unwrap();
    fs::remove_dir(dir).unwrap();
}
