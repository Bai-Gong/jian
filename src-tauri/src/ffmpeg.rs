//! Compatibility engines are compiled only into explicit development builds or unit tests.
#[cfg(any(feature = "compat-ffmpeg", test))]
#[path = "compat_ffmpeg.rs"]
mod compatibility;
#[cfg(any(feature = "compat-ffmpeg", test))]
pub use compatibility::*;
#[cfg(not(any(feature = "compat-ffmpeg", test)))]
#[path = "pure_runtime.rs"]
mod pure;
#[cfg(not(any(feature = "compat-ffmpeg", test)))]
pub use pure::*;
