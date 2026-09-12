// Image proxy for patto-mobile
// Serves local images to the webview over a custom `pimg` URI scheme.
// Large images are downscaled once (max MAX_EDGE px on the long side), cached on
// disk, and streamed straight from Rust, so no image bytes ever cross the IPC
// bridge and the webview never has to decode multi-megabyte originals.

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

pub const SCHEME: &str = "pimg";
pub const MAX_EDGE: u32 = 1600;
pub const JPEG_QUALITY: u8 = 85;
pub const CACHE_CAP_BYTES: u64 = 256 * 1024 * 1024;

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "svg"];

/// Shared proxy state, registered with `app.manage()`.
#[derive(Clone)]
pub struct ImageProxy(Arc<Inner>);

struct Inner {
    /// Canonical workspace root; only files below it are served.
    root: Mutex<Option<PathBuf>>,
    cache_dir: PathBuf,
    /// Bounds the number of concurrent decodes (each large PNG is ~100 MB transient).
    decode_permits: tokio::sync::Semaphore,
    /// Per-path lock so concurrent requests for the same image decode it once.
    inflight: Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
}

#[derive(Debug)]
pub struct Served {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

#[derive(Debug, PartialEq)]
pub enum ProxyError {
    Forbidden,
    NotFound,
    Internal(String),
    /// Internal: the fast path could not answer without decoding.
    NeedsDecode,
}

/// What the renderer needs to know about a local image (all header/stat-level checks).
pub struct ImagePlan {
    /// Downscaled URL (`pimg://…`) for the inline `<img>`.
    pub src: String,
    /// URL of the untouched original (`&full=1`) for the lightbox.
    pub full_src: String,
    pub dimensions: Option<(u32, u32)>,
    /// True when a request for `src` will be answered without decoding (small
    /// image, SVG/GIF, missing file, or already in the disk cache). Large
    /// uncached images are prepared out-of-band via `prepare_images` because a
    /// slow custom-protocol response blocks the WebView's request thread on
    /// Android (which also carries Tauri IPC).
    pub ready: bool,
}

impl ImageProxy {
    pub fn new(cache_dir: PathBuf) -> Self {
        if let Err(e) = fs::create_dir_all(&cache_dir) {
            log::warn!(
                "image_proxy: cannot create cache dir {}: {e}",
                cache_dir.display()
            );
        }
        let permits = if cfg!(target_os = "android") {
            2
        } else {
            std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(2)
                .clamp(2, 4)
        };
        Self(Arc::new(Inner {
            root: Mutex::new(None),
            cache_dir,
            decode_permits: tokio::sync::Semaphore::new(permits),
            inflight: Mutex::new(HashMap::new()),
        }))
    }

    /// Set the workspace root. Called by `render_note` before any `<img>` can request bytes.
    pub fn set_root(&self, root: &Path) {
        match root.canonicalize() {
            Ok(canon) => *self.0.root.lock().unwrap() = Some(canon),
            Err(e) => log::warn!(
                "image_proxy: cannot canonicalize root {}: {e}",
                root.display()
            ),
        }
    }

    /// Delete stale temp files and evict oldest cache entries until under CACHE_CAP_BYTES.
    pub fn prune_cache(&self) {
        let Ok(entries) = fs::read_dir(&self.0.cache_dir) else {
            return;
        };
        let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let is_tmp = path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.contains(".tmp-"))
                .unwrap_or(false);
            if is_tmp {
                let _ = fs::remove_file(&path);
                continue;
            }
            let mtime = meta.modified().unwrap_or(UNIX_EPOCH);
            files.push((path, meta.len(), mtime));
        }
        let mut total: u64 = files.iter().map(|f| f.1).sum();
        if total <= CACHE_CAP_BYTES {
            return;
        }
        files.sort_by_key(|f| f.2);
        for (path, size, _) in files {
            if total <= CACHE_CAP_BYTES {
                break;
            }
            if fs::remove_file(&path).is_ok() {
                total -= size;
            }
        }
    }

    /// Existing cache file for this image, if any (uses the non-canonical path;
    /// `produce` canonicalizes, so only call with the path the renderer used).
    fn cached_path(&self, abs_path: &Path, meta: &fs::Metadata) -> Option<PathBuf> {
        let canon = abs_path.canonicalize().ok()?;
        let key = cache_key(&canon, meta);
        ["jpg", "png"]
            .iter()
            .map(|ext| self.0.cache_dir.join(format!("{key}.{ext}")))
            .find(|p| p.exists())
    }

    /// Make sure a later request for `requested` is a fast cache hit.
    pub async fn prepare(&self, requested: PathBuf) -> Result<(), ProxyError> {
        self.run(requested, false, false).await.map(|_| ())
    }

    async fn serve(&self, requested: PathBuf, full: bool) -> Result<Served, ProxyError> {
        self.run(requested, full, true).await
    }

    async fn run(&self, requested: PathBuf, full: bool, read: bool) -> Result<Served, ProxyError> {
        let root = self
            .0
            .root
            .lock()
            .unwrap()
            .clone()
            .ok_or(ProxyError::Forbidden)?;

        // Fast path: raw files and cache hits need neither the decode permit nor the
        // per-path lock. This must stay quick — on Android the WebView's request
        // thread (shared with Tauri IPC) is blocked until we respond.
        {
            let (root, cache_dir, path) =
                (root.clone(), self.0.cache_dir.clone(), requested.clone());
            let fast = tauri::async_runtime::spawn_blocking(move || {
                produce_fast(&root, &cache_dir, &path, full, read)
            })
            .await
            .map_err(|e| ProxyError::Internal(e.to_string()))?;
            if let Some(result) = fast {
                return result;
            }
        }

        let key_lock = {
            let mut inflight = self.0.inflight.lock().unwrap();
            inflight.entry(requested.clone()).or_default().clone()
        };
        let result = {
            let _same_path = key_lock.lock().await;
            let _permit = self
                .0
                .decode_permits
                .acquire()
                .await
                .map_err(|e| ProxyError::Internal(e.to_string()))?;
            let cache_dir = self.0.cache_dir.clone();
            let path = requested.clone();
            tauri::async_runtime::spawn_blocking(move || {
                lower_thread_priority();
                produce(&root, &cache_dir, &path, full, read)
            })
            .await
            .map_err(|e| ProxyError::Internal(e.to_string()))?
        };
        {
            let mut inflight = self.0.inflight.lock().unwrap();
            // Only the map and this task hold the lock: nobody else is waiting on it.
            if Arc::strong_count(&key_lock) <= 2 {
                inflight.remove(&requested);
            }
        }
        result
    }
}

/// URL the renderer embeds in HTML. Mirrors `convertFileSrc` in Tauri's core.js:
/// `pimg://localhost/<encoded>` everywhere except Windows/Android, which use
/// `http://pimg.localhost/<encoded>` (wry maps it back to `pimg://` before `handle`).
/// `full` requests the untouched original instead of the downscaled version.
pub fn image_url(abs_path: &Path, version: u64, full: bool) -> String {
    let path_str = abs_path.to_string_lossy();
    let encoded =
        percent_encoding::utf8_percent_encode(&path_str, percent_encoding::NON_ALPHANUMERIC);
    let full = if full { "&full=1" } else { "" };
    if cfg!(any(windows, target_os = "android")) {
        format!("http://{SCHEME}.localhost/{encoded}?v={version:x}{full}")
    } else {
        format!("{SCHEME}://localhost/{encoded}?v={version:x}{full}")
    }
}

fn wants_full(query: Option<&str>) -> bool {
    query
        .map(|q| q.split('&').any(|kv| kv == "full=1"))
        .unwrap_or(false)
}

/// Plan how to embed a local image. `proxy` is `None` only outside the app (tests).
pub fn plan_image(proxy: Option<&ImageProxy>, abs_path: &Path) -> ImagePlan {
    let meta = fs::metadata(abs_path).ok();
    let version = meta.as_ref().map(file_version).unwrap_or(0);
    let dimensions = imagesize::size(abs_path)
        .ok()
        .map(|s| (s.width as u32, s.height as u32));
    let ready = match (&meta, proxy) {
        (None, _) | (_, None) => true,
        (Some(meta), Some(proxy)) => {
            let ext = extension_of(abs_path);
            let small = dimensions
                .map(|(w, h)| w.max(h) <= MAX_EDGE)
                .unwrap_or(true);
            ext == "svg" || ext == "gif" || small || proxy.cached_path(abs_path, meta).is_some()
        }
    };
    ImagePlan {
        src: image_url(abs_path, version, false),
        full_src: image_url(abs_path, version, true),
        dimensions,
        ready,
    }
}

/// URI scheme handler registered in lib.rs.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    // Same shape on every platform: the path is "/<percent-encoded absolute path>".
    // The query string (?v=) is not part of `path()`.
    let raw = request.uri().path();
    let decoded = percent_encoding::percent_decode_str(raw.strip_prefix('/').unwrap_or(raw))
        .decode_utf8_lossy()
        .into_owned();
    let full = wants_full(request.uri().query());

    tauri::async_runtime::spawn(async move {
        let proxy = app.state::<ImageProxy>().inner().clone();
        let response = match proxy.serve(PathBuf::from(decoded), full).await {
            Ok(served) => ok_response(served),
            Err(e) => error_response(e),
        };
        responder.respond(response);
    });
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageReady {
    path: String,
    ok: bool,
}

/// Decode/cache the given images in the background and emit `image-ready`
/// for each one. Returns immediately so no WebView request thread is held.
#[tauri::command]
pub async fn prepare_images(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ImageProxy>,
    paths: Vec<String>,
) -> Result<(), String> {
    use tauri::Emitter;
    for path in paths {
        let proxy = proxy.inner().clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let ok = proxy.prepare(PathBuf::from(&path)).await.is_ok();
            let _ = app.emit("image-ready", ImageReady { path, ok });
        });
    }
    Ok(())
}

fn ok_response(served: Served) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, served.mime)
        .header(header::CONTENT_LENGTH, served.bytes.len())
        // Safe: the URL carries ?v=<file version>, so edits produce a new URL.
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .body(served.bytes)
        .unwrap()
}

fn error_response(err: ProxyError) -> Response<Vec<u8>> {
    let (status, message) = match err {
        ProxyError::Forbidden => (StatusCode::FORBIDDEN, "forbidden".to_string()),
        ProxyError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
        ProxyError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m),
        ProxyError::NeedsDecode => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "decode required".to_string(),
        ),
    };
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain")
        .body(message.into_bytes())
        .unwrap()
}

/// Everything `produce` can answer without decoding: validation errors, raw files
/// and cache hits. `None` means a decode is required.
fn produce_fast(
    root: &Path,
    cache_dir: &Path,
    requested: &Path,
    full: bool,
    read: bool,
) -> Option<Result<Served, ProxyError>> {
    match produce_inner(root, cache_dir, requested, full, read, false) {
        Err(ProxyError::NeedsDecode) => None,
        other => Some(other),
    }
}

/// Synchronous worker: validate the path, then serve raw bytes or a cached downscale.
/// `full` skips downscaling (used by the lightbox to show the original).
/// `read = false` only makes sure the cache is populated and returns empty bytes.
fn produce(
    root: &Path,
    cache_dir: &Path,
    requested: &Path,
    full: bool,
    read: bool,
) -> Result<Served, ProxyError> {
    produce_inner(root, cache_dir, requested, full, read, true)
}

fn produce_inner(
    root: &Path,
    cache_dir: &Path,
    requested: &Path,
    full: bool,
    read: bool,
    may_decode: bool,
) -> Result<Served, ProxyError> {
    // canonicalize resolves `..` and symlinks, so `starts_with` is a real containment check.
    let canon = requested.canonicalize().map_err(|_| ProxyError::NotFound)?;
    if !canon.starts_with(root) {
        return Err(ProxyError::Forbidden);
    }
    let ext = extension_of(&canon);
    if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(ProxyError::Forbidden);
    }
    let mime = mime_for(&ext);
    let meta = fs::metadata(&canon).map_err(|_| ProxyError::NotFound)?;
    let raw = || {
        if !read {
            return Ok(Served {
                bytes: Vec::new(),
                mime,
            });
        }
        fs::read(&canon)
            .map(|bytes| Served { bytes, mime })
            .map_err(|_| ProxyError::NotFound)
    };

    // SVG is vector; GIF may be animated. Serve both untouched, as is any explicit
    // request for the original.
    if full || ext == "svg" || ext == "gif" {
        return raw();
    }
    if let Ok(size) = imagesize::size(&canon) {
        if size.width.max(size.height) as u32 <= MAX_EDGE {
            return raw();
        }
    }

    let key = cache_key(&canon, &meta);
    for (suffix, cached_mime) in [("jpg", "image/jpeg"), ("png", "image/png")] {
        let cached = cache_dir.join(format!("{key}.{suffix}"));
        if !read && cached.exists() {
            return Ok(Served {
                bytes: Vec::new(),
                mime: cached_mime,
            });
        }
        if let Ok(bytes) = fs::read(&cached) {
            return Ok(Served {
                bytes,
                mime: cached_mime,
            });
        }
    }

    if !may_decode {
        return Err(ProxyError::NeedsDecode);
    }
    match downscale(&canon) {
        Ok((bytes, out_mime, suffix)) => {
            atomic_write(&cache_dir.join(format!("{key}.{suffix}")), &bytes);
            Ok(Served {
                bytes,
                mime: out_mime,
            })
        }
        Err(e) => {
            // Let the webview try the original rather than showing nothing.
            log::warn!("image_proxy: downscale failed for {}: {e}", canon.display());
            raw()
        }
    }
}

/// Decode, honour EXIF orientation, shrink to MAX_EDGE, re-encode (JPEG unless transparent).
fn downscale(path: &Path) -> image::ImageResult<(Vec<u8>, &'static str, &'static str)> {
    use image::codecs::jpeg::JpegEncoder;
    use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
    use image::imageops::FilterType;
    use image::{DynamicImage, ImageDecoder, ImageReader, Limits};

    let mut reader = ImageReader::open(path)?.with_guessed_format()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(384 * 1024 * 1024);
    reader.limits(limits);

    let mut decoder = reader.into_decoder()?;
    let orientation = decoder.orientation()?;
    let mut img = DynamicImage::from_decoder(decoder)?;
    img.apply_orientation(orientation);

    let (w, h) = (img.width(), img.height());
    let scale = MAX_EDGE as f64 / w.max(h) as f64;
    let nw = ((w as f64 * scale).round() as u32).max(1);
    let nh = ((h as f64 * scale).round() as u32).max(1);
    // Triangle is several times faster than Lanczos3 on 20+ MP inputs and indistinguishable at this size.
    let img = img.resize_exact(nw, nh, FilterType::Triangle);

    let mut out = Cursor::new(Vec::new());
    if has_transparency(&img) {
        let rgba = img.to_rgba8();
        let encoder =
            PngEncoder::new_with_quality(&mut out, CompressionType::Fast, PngFilter::Adaptive);
        rgba.write_with_encoder(encoder)?;
        Ok((out.into_inner(), "image/png", "png"))
    } else {
        let rgb = img.to_rgb8();
        let encoder = JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
        rgb.write_with_encoder(encoder)?;
        Ok((out.into_inner(), "image/jpeg", "jpg"))
    }
}

fn has_transparency(img: &image::DynamicImage) -> bool {
    img.color().has_alpha() && img.to_rgba8().pixels().any(|p| p[3] != 255)
}

/// Decoding a 20 MP PNG saturates a core for hundreds of ms; on a phone that
/// competes with the WebView and Tauri IPC. Nice the (pooled) worker thread.
fn lower_thread_priority() {
    #[cfg(unix)]
    unsafe {
        // PRIO_PROCESS with id 0 targets the calling thread on Linux/Android.
        libc::setpriority(libc::PRIO_PROCESS, 0, 10);
    }
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn mime_for(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn file_version(meta: &fs::Metadata) -> u64 {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    mtime.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ meta.len()
}

fn cache_key(canon: &Path, meta: &fs::Metadata) -> String {
    let mut hasher = Sha256::new();
    hasher.update(canon.to_string_lossy().as_bytes());
    hasher.update(file_version(meta).to_le_bytes());
    if let Ok(d) = meta.modified().and_then(|t| {
        t.duration_since(UNIX_EPOCH)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
    }) {
        hasher.update(d.subsec_nanos().to_le_bytes());
    }
    hasher.finalize()[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Write via a temp file + rename so a concurrent reader never sees a partial file.
fn atomic_write(dst: &Path, bytes: &[u8]) {
    let nanos = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dst.with_extension(format!("tmp-{nanos}"));
    if fs::write(&tmp, bytes).is_ok() && fs::rename(&tmp, dst).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "patto-mobile-{name}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn write_png(path: &Path, w: u32, h: u32) {
        let img = image::RgbImage::from_fn(w, h, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 7])
        });
        img.save(path).unwrap();
    }

    #[test]
    fn image_url_round_trips_through_percent_decoding() {
        let path = Path::new("/home/me/ノート/assets/a b&c.png");
        let url = image_url(path, 0x1234, false);
        assert!(
            url.starts_with(&format!("{SCHEME}://localhost/"))
                || url.starts_with(&format!("http://{SCHEME}.localhost/"))
        );
        let path_part = url
            .split("localhost/")
            .nth(1)
            .unwrap()
            .split('?')
            .next()
            .unwrap();
        let decoded = percent_encoding::percent_decode_str(path_part)
            .decode_utf8()
            .unwrap();
        assert_eq!(decoded, path.to_string_lossy());
        assert!(url.ends_with("?v=1234"));
        let full = image_url(path, 0x1234, true);
        assert!(full.ends_with("?v=1234&full=1"));
        assert!(wants_full(Some("v=1234&full=1")));
        assert!(!wants_full(Some("v=1234")));
        assert!(!wants_full(None));
    }

    #[test]
    fn large_png_is_downscaled_to_jpeg_and_cached() {
        let root = temp_root("large");
        let cache = root.join("cache");
        fs::create_dir_all(&cache).unwrap();
        let src = root.join("big.png");
        write_png(&src, 3000, 2000);

        let served = produce(&root, &cache, &src, false, true).unwrap();
        assert_eq!(served.mime, "image/jpeg");
        assert_eq!(&served.bytes[..2], &[0xFF, 0xD8]);
        let decoded = image::load_from_memory(&served.bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (1600, 1067));

        let cached: Vec<_> = fs::read_dir(&cache).unwrap().flatten().collect();
        assert_eq!(cached.len(), 1);
        assert_eq!(cached[0].path().extension().unwrap(), "jpg");

        let again = produce(&root, &cache, &src, false, true).unwrap();
        assert_eq!(again.bytes, served.bytes);

        // full=1 returns the untouched original
        let original = produce(&root, &cache, &src, true, true).unwrap();
        assert_eq!(original.mime, "image/png");
        assert_eq!(original.bytes, fs::read(&src).unwrap());

        // read=false on a cache hit returns no bytes but succeeds
        let ensured = produce(&root, &cache, &src, false, false).unwrap();
        assert!(ensured.bytes.is_empty());
        // fast path answers cache hits and originals, but not cold decodes
        assert!(produce_fast(&root, &cache, &src, false, true).is_some());
        assert!(produce_fast(&root, &cache, &src, true, true).is_some());
        fs::remove_dir_all(&cache).unwrap();
        fs::create_dir_all(&cache).unwrap();
        assert!(produce_fast(&root, &cache, &src, false, true).is_none());
        assert_eq!(
            produce_fast(&root, &cache, &root.join("nope.png"), false, true)
                .unwrap()
                .unwrap_err(),
            ProxyError::NotFound
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn plan_reports_readiness_and_prepare_populates_cache() {
        let root = temp_root("plan");
        let cache = root.join("cache");
        fs::create_dir_all(&cache).unwrap();
        let big = root.join("big.png");
        write_png(&big, 2000, 1500);
        let small = root.join("small.png");
        write_png(&small, 300, 200);
        let proxy = ImageProxy::new(cache.clone());
        proxy.set_root(&root);

        let plan = plan_image(Some(&proxy), &big);
        assert!(!plan.ready, "large uncached image must not be ready");
        assert_eq!(plan.dimensions, Some((2000, 1500)));
        assert!(plan.full_src.ends_with("&full=1"));
        assert!(plan_image(Some(&proxy), &small).ready);
        assert!(plan_image(Some(&proxy), &root.join("missing.png")).ready);
        assert!(plan_image(None, &big).ready, "no proxy: always inline");

        tauri::async_runtime::block_on(proxy.prepare(big.clone())).unwrap();
        assert!(plan_image(Some(&proxy), &big).ready, "cached after prepare");
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 1);
        assert_eq!(
            tauri::async_runtime::block_on(proxy.prepare(root.join("nope.png"))).unwrap_err(),
            ProxyError::NotFound
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn small_png_and_svg_are_served_raw() {
        let root = temp_root("raw");
        let cache = root.join("cache");
        fs::create_dir_all(&cache).unwrap();
        let png = root.join("small.png");
        write_png(&png, 800, 600);
        let svg = root.join("v.svg");
        fs::write(&svg, "<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap();

        let served = produce(&root, &cache, &png, false, true).unwrap();
        assert_eq!(served.mime, "image/png");
        assert_eq!(served.bytes, fs::read(&png).unwrap());
        let served = produce(&root, &cache, &svg, false, true).unwrap();
        assert_eq!(served.mime, "image/svg+xml");
        assert_eq!(served.bytes, fs::read(&svg).unwrap());
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn paths_outside_root_are_forbidden() {
        let root = temp_root("root");
        let outside = temp_root("outside");
        let cache = root.join("cache");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::create_dir_all(&cache).unwrap();
        let secret = outside.join("secret.png");
        write_png(&secret, 10, 10);

        assert_eq!(
            produce(&root, &cache, &secret, false, true).unwrap_err(),
            ProxyError::Forbidden
        );
        let traversal = root
            .join("sub")
            .join("..")
            .join("..")
            .join(outside.file_name().unwrap())
            .join("secret.png");
        assert_eq!(
            produce(&root, &cache, &traversal, false, true).unwrap_err(),
            ProxyError::Forbidden
        );
        assert_eq!(
            produce(&root, &cache, &root.join("missing.png"), false, true).unwrap_err(),
            ProxyError::NotFound
        );
        assert_eq!(
            produce(&root, &cache, &root.join("notes.pn"), false, true).unwrap_err(),
            ProxyError::NotFound
        );
        fs::write(root.join("notes.pn"), "x").unwrap();
        assert_eq!(
            produce(&root, &cache, &root.join("notes.pn"), false, true).unwrap_err(),
            ProxyError::Forbidden
        );
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }
}
