//! Reproduce the timeline's concurrent decode workload without opening a window.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("original recording required")?;
    std::thread::scope(|scope| {
        let mut jobs = Vec::new();
        for index in 1..=5 {
            let path = &path;
            jobs.push(scope.spawn(move || {
                eprintln!("waveform {index} start");
                let result = jian_lib::waveform::waveform_stream(path.clone(), 1024, index);
                eprintln!(
                    "waveform {index}: {:?}",
                    result
                        .as_ref()
                        .map(|p| (p.sample_rate, p.channels, p.buckets))
                );
                result.map(|_| ())
            }));
        }
        for time in [0, 1_080_000] {
            let path = &path;
            jobs.push(scope.spawn(move || {
                eprintln!("thumbnail {time} start");
                let result =
                    jian_lib::ye_engine::timeline_thumbnail_impl(std::path::Path::new(path), time);
                eprintln!("thumbnail {time}: {:?}", result.as_ref().map(Vec::len));
                result.map(|_| ())
            }));
        }
        for job in jobs {
            job.join().expect("decode worker panicked")?;
        }
        Ok::<_, String>(())
    })?;
    Ok(())
}
