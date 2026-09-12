// Note operations for patto-mobile
// Read, write, render notes using patto parser and mobile renderer

use crate::image_proxy::ImageProxy;
use crate::renderer::MobileHtmlRenderer;
use patto::parser;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Rendered note with metadata
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedNote {
    pub path: String,
    pub name: String,
    pub html: String,
    pub raw_content: String,
}

/// Read raw note content
#[tauri::command]
pub fn read_note(root: PathBuf, file_path: String) -> Result<String, String> {
    let full_path = root.join(&file_path);

    if !full_path.exists() {
        return Err(format!("File not found: {}", file_path));
    }

    fs::read_to_string(&full_path).map_err(|e| format!("Failed to read file: {}", e))
}

/// Write note content
#[tauri::command]
pub fn write_note(root: PathBuf, file_path: String, content: String) -> Result<(), String> {
    let full_path = root.join(&file_path);

    // Ensure parent directory exists
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    fs::write(&full_path, content).map_err(|e| format!("Failed to write file: {}", e))
}

/// Render note to HTML using mobile-optimized renderer
#[tauri::command]
pub fn render_note(
    root: PathBuf,
    file_path: String,
    proxy: tauri::State<'_, ImageProxy>,
) -> Result<RenderedNote, String> {
    // Images are served by the proxy, which only allows files under this root.
    proxy.set_root(&root);
    render_note_in(&root, &file_path, Some(&proxy))
}

fn render_note_in(
    root: &Path,
    file_path: &str,
    proxy: Option<&ImageProxy>,
) -> Result<RenderedNote, String> {
    let full_path = root.join(file_path);

    if !full_path.exists() {
        return Err(format!("File not found: {}", file_path));
    }

    let content =
        fs::read_to_string(&full_path).map_err(|e| format!("Failed to read file: {}", e))?;

    let html = render_html(&content, Some(root), proxy)?;

    // Get note name
    let name = full_path
        .file_stem()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    Ok(RenderedNote {
        path: file_path.to_string(),
        name,
        html,
        raw_content: content,
    })
}

/// Render content without reading from file (for preview while editing).
/// `root` lets local images resolve exactly as in `render_note`.
#[tauri::command]
pub fn render_content(
    root: Option<PathBuf>,
    content: String,
    proxy: tauri::State<'_, ImageProxy>,
) -> Result<String, String> {
    if let Some(root) = &root {
        proxy.set_root(root);
    }
    render_html(&content, root.as_deref(), Some(&proxy))
}

fn render_html(
    content: &str,
    root: Option<&Path>,
    proxy: Option<&ImageProxy>,
) -> Result<String, String> {
    let parse_result = parser::parse_text(content);
    let renderer = MobileHtmlRenderer::new(root.map(|r| r.to_string_lossy().to_string()), proxy);
    renderer
        .render(&parse_result.ast)
        .map_err(|e| format!("Failed to render: {}", e))
}

/// Link information extracted from a note
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkInfo {
    pub target: String,               // Target note name or URL
    pub anchor: Option<String>,       // Optional anchor within target
    pub is_external: bool,            // True if URL, false if internal note link
    pub display_text: Option<String>, // Display text if different from target
}

/// Extract all links from a note
#[tauri::command]
pub fn extract_links(root: PathBuf, file_path: String) -> Result<Vec<LinkInfo>, String> {
    let full_path = root.join(&file_path);

    if !full_path.exists() {
        return Err(format!("File not found: {}", file_path));
    }

    let content =
        fs::read_to_string(&full_path).map_err(|e| format!("Failed to read file: {}", e))?;

    // Parse the content
    let parse_result = parser::parse_text(&content);

    let mut links = Vec::new();
    extract_links_from_ast(&parse_result.ast, &mut links);

    Ok(links)
}

fn extract_links_from_ast(node: &parser::AstNode, links: &mut Vec<LinkInfo>) {
    use parser::AstNodeKind;

    match node.kind() {
        AstNodeKind::WikiLink { link, anchor } => {
            links.push(LinkInfo {
                target: link.clone(),
                anchor: anchor.clone(),
                is_external: false,
                display_text: None,
            });
        }
        AstNodeKind::Link { link, title } => {
            links.push(LinkInfo {
                target: link.clone(),
                anchor: None,
                is_external: true,
                display_text: title.clone(),
            });
        }
        _ => {}
    }

    // Recurse into contents
    for child in node.value().contents.lock().unwrap().iter() {
        extract_links_from_ast(child, links);
    }
    // Recurse into children
    for child in node.value().children.lock().unwrap().iter() {
        extract_links_from_ast(child, links);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "patto-mobile-notes-{name}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn render_note_numbers_lines() {
        let root = temp_root("lines");
        fs::write(
            root.join("test_lines.pn"),
            "Line 1\nLine 2\n\tNested Line 3\n",
        )
        .unwrap();

        let rendered = render_note_in(&root, "test_lines.pn", None).unwrap();
        assert!(rendered.html.contains("data-line-idx=\"0\""));
        assert!(rendered.html.contains("data-line-idx=\"1\""));
        assert!(rendered.html.contains("data-line-idx=\"2\""));
        assert!(!rendered.html.contains("data-line-idx=\"3\""));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn render_note_emits_proxy_image_with_dimensions() {
        let root = temp_root("img");
        fs::create_dir_all(root.join("assets")).unwrap();
        image::RgbImage::new(120, 80)
            .save(root.join("assets/sample.png"))
            .unwrap();
        image::RgbImage::new(2400, 1800)
            .save(root.join("assets/big.png"))
            .unwrap();
        fs::write(
            root.join("test_img.pn"),
            "[@img \"a <caption>\" ./assets/sample.png]\n[@img \"missing\" ./assets/nope.png]\n[@img \"remote\" https://example.com/x.png]\n[@img \"big\" ./assets/big.png]\n",
        )
        .unwrap();

        let proxy = ImageProxy::new(root.join("cache"));
        proxy.set_root(&root);

        let html = render_note_in(&root, "test_img.pn", Some(&proxy))
            .unwrap()
            .html;
        assert!(html.contains("localhost/"), "{html}");
        assert!(
            html.contains("sample.png") || html.contains("sample%2Epng"),
            "{html}"
        );
        assert!(html.contains("width=\"120\" height=\"80\""), "{html}");
        assert!(html.contains("alt=\"a &lt;caption&gt;\""), "{html}");
        assert!(
            html.contains("loading=\"lazy\" decoding=\"async\""),
            "{html}"
        );
        assert!(html.contains("<figure class=\"patto-figure\">"), "{html}");
        assert!(
            html.contains("<figcaption class=\"patto-figcaption\">a &lt;caption&gt;</figcaption>"),
            "{html}"
        );
        assert!(html.contains("&amp;full=1\" width=\"120\""), "{html}");
        // large + uncached: no src yet, prepared on demand
        assert!(
            html.contains("alt=\"big\" data-pending-src=\"pimg://"),
            "{html}"
        );
        assert!(html.contains("data-prepare=\""), "{html}");
        assert!(!html.contains("alt=\"big\" src="), "{html}");
        // once cached it is inlined
        tauri::async_runtime::block_on(proxy.prepare(root.join("assets/big.png"))).unwrap();
        let html2 = render_note_in(&root, "test_img.pn", Some(&proxy))
            .unwrap()
            .html;
        assert!(html2.contains("alt=\"big\" src=\"pimg://"), "{html2}");
        // missing file: URL still emitted (404 shows alt), no dimensions
        assert!(html.contains("alt=\"missing\" src=\"pimg://"), "{html}");
        assert!(
            !html.contains("nope%2Epng?v=0&amp;full=1\" width="),
            "{html}"
        );
        // remote URLs pass through untouched
        assert!(html.contains("src=\"https://example.com/x.png\""), "{html}");
        assert!(!html.contains("asset.localhost"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn youtube_links_render_as_click_to_load_facade() {
        let html = render_html(
            "[video https://www.youtube.com/watch?v=abc123XYZ&t=1]\n[clip https://youtu.be/def456]\n",
            None,
            None,
        )
        .unwrap();
        assert!(
            html.contains("class=\"video-facade\" data-youtube-id=\"abc123XYZ\""),
            "{html}"
        );
        assert!(
            html.contains("i.ytimg.com/vi/def456/hqdefault.jpg"),
            "{html}"
        );
        assert!(!html.contains("<iframe"), "{html}");
    }

    #[test]
    fn render_content_without_root_keeps_relative_src() {
        let html = render_html("[@img \"x\" ./assets/a.png]\n", None, None).unwrap();
        assert!(html.contains("src=\"./assets/a.png\""), "{html}");
    }
}
