// Mobile-optimized HTML renderer for patto notes
// Generates clean HTML without inline styles for easier CSS styling

use crate::image_proxy;
use patto::parser::{AstNode, AstNodeKind, Property, TaskStatus};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub struct MobileHtmlRenderer {
    workspace_path: Option<String>,
}

impl MobileHtmlRenderer {
    pub fn new(workspace_path: Option<String>) -> Self {
        Self { workspace_path }
    }

    pub fn render(&self, ast: &AstNode) -> io::Result<String> {
        let mut output = Vec::new();
        let mut line_idx = 0;
        self.render_node(ast, &mut output, 0, &mut line_idx)?;
        Ok(String::from_utf8_lossy(&output).to_string())
    }

    /// `line_idx` numbers every rendered `.patto-line` in document order; the
    /// frontend uses it (`data-line-idx`) to re-find search matches.
    fn render_node(
        &self,
        ast: &AstNode,
        output: &mut dyn Write,
        depth: usize,
        line_idx: &mut usize,
    ) -> io::Result<()> {
        match &ast.kind() {
            AstNodeKind::Dummy => {
                write!(output, "<div class=\"patto-root\">")?;
                let children = ast.value().children.lock().unwrap();
                for child in children.iter() {
                    self.render_node(child, output, depth, line_idx)?;
                }
                write!(output, "</div>")?;
            }
            AstNodeKind::Line { properties } | AstNodeKind::QuoteContent { properties } => {
                let class = self.get_line_class(properties);
                let current_idx = *line_idx;
                *line_idx += 1;
                write!(
                    output,
                    "<div class=\"patto-line{}\" data-depth=\"{}\" data-line-idx=\"{}\">",
                    class, depth, current_idx
                )?;

                // Task checkbox
                for property in properties {
                    if let Property::Task { status, .. } = property {
                        let (checked, status_class) = match status {
                            TaskStatus::Done => ("checked", "done"),
                            TaskStatus::Doing => ("", "doing"),
                            TaskStatus::Paused => ("", "paused"),
                            TaskStatus::Todo => ("", "todo"),
                        };
                        write!(
                            output,
                            "<span class=\"task-checkbox task-{}\"><input type=\"checkbox\" {} disabled/></span>",
                            status_class, checked
                        )?;
                    }
                }

                // Line contents
                write!(output, "<span class=\"line-content\">")?;
                let contents = ast.value().contents.lock().unwrap();
                for content in contents.iter() {
                    self.render_node(content, output, depth, line_idx)?;
                }
                write!(output, "</span>")?;

                // Properties (deadline, anchors)
                if !properties.is_empty() {
                    write!(output, "<span class=\"line-properties\">")?;
                    for property in properties {
                        match property {
                            Property::Anchor { name, .. } => {
                                write!(
                                    output,
                                    "<span id=\"{}\" class=\"anchor\">#{}</span>",
                                    name, name
                                )?;
                            }
                            Property::Task { status, due, .. } => {
                                if !matches!(status, TaskStatus::Done) {
                                    write!(output, "<span class=\"deadline\">{}</span>", due)?;
                                }
                            }
                        }
                    }
                    write!(output, "</span>")?;
                }

                write!(output, "</div>")?;

                // Children (indented)
                let children = ast.value().children.lock().unwrap();
                if !children.is_empty() {
                    write!(output, "<div class=\"patto-children\">")?;
                    for child in children.iter() {
                        self.render_node(child, output, depth + 1, line_idx)?;
                    }
                    write!(output, "</div>")?;
                }
            }
            AstNodeKind::Quote => {
                write!(output, "<blockquote class=\"patto-quote\">")?;
                let children = ast.value().children.lock().unwrap();
                for child in children.iter() {
                    self.render_node(child, output, depth, line_idx)?;
                }
                write!(output, "</blockquote>")?;
            }
            AstNodeKind::Code { lang, inline } => {
                if *inline {
                    write!(output, "<code class=\"inline-code\">")?;
                    let contents = ast.value().contents.lock().unwrap();
                    if let Some(content) = contents.first() {
                        write!(output, "{}", html_escape(content.extract_str()))?;
                    }
                    write!(output, "</code>")?;
                } else {
                    write!(
                        output,
                        "<pre class=\"code-block\" data-lang=\"{}\"><code>",
                        lang
                    )?;
                    let children = ast.value().children.lock().unwrap();
                    for child in children.iter() {
                        writeln!(output, "{}", html_escape(child.extract_str()))?;
                    }
                    write!(output, "</code></pre>")?;
                }
            }
            AstNodeKind::Math { inline } => {
                if *inline {
                    write!(output, "<span class=\"math-inline\">\\(")?;
                    let contents = ast.value().contents.lock().unwrap();
                    if let Some(content) = contents.first() {
                        write!(output, "{}", content.extract_str())?;
                    }
                    write!(output, "\\)</span>")?;
                } else {
                    write!(output, "<div class=\"math-block\">\\[")?;
                    let children = ast.value().children.lock().unwrap();
                    for child in children.iter() {
                        write!(output, "{}", child.extract_str())?;
                    }
                    write!(output, "\\]</div>")?;
                }
            }
            AstNodeKind::Image { src, alt } => {
                let alt_text = html_escape(alt.as_deref().unwrap_or(""));
                // Local images go through the `pimg` proxy (downscaled + cached).
                // width/height come from the file header so layout is stable
                // before the image loads (no jumps while scrolling/searching).
                // `data-full` points at the untouched original for the lightbox.
                let (resolved_src, full_src, dimensions) = match self.resolve_image_path(src) {
                    ImageSource::Remote(url) => (url, None, None),
                    ImageSource::Local(abs) => {
                        let probe = image_proxy::probe(&abs);
                        let version = probe.as_ref().map(|p| p.version).unwrap_or(0);
                        (
                            image_proxy::image_url(&abs, version, false),
                            Some(image_proxy::image_url(&abs, version, true)),
                            probe.and_then(|p| p.dimensions),
                        )
                    }
                    ImageSource::Unresolved(raw) => (raw, None, None),
                };
                write!(output, "<figure class=\"patto-figure\">")?;
                write!(
                    output,
                    "<img class=\"patto-image\" src=\"{}\" alt=\"{}\"",
                    html_escape(&resolved_src),
                    alt_text
                )?;
                if let Some(full) = full_src {
                    write!(output, " data-full=\"{}\"", html_escape(&full))?;
                }
                if let Some((w, h)) = dimensions {
                    write!(output, " width=\"{}\" height=\"{}\"", w, h)?;
                }
                write!(output, " loading=\"lazy\" decoding=\"async\"/>")?;
                if !alt_text.is_empty() {
                    write!(
                        output,
                        "<figcaption class=\"patto-figcaption\">{}</figcaption>",
                        alt_text
                    )?;
                }
                write!(output, "</figure>")?;
            }
            AstNodeKind::WikiLink { link, anchor } => {
                let href = if let Some(anchor) = anchor {
                    if link.is_empty() {
                        format!("#{}", anchor)
                    } else {
                        format!("{}.pn#{}", link, anchor)
                    }
                } else {
                    format!("{}.pn", link)
                };
                let display = if let Some(anchor) = anchor {
                    if link.is_empty() {
                        format!("#{}", anchor)
                    } else {
                        format!("{}#{}", link, anchor)
                    }
                } else {
                    link.clone()
                };
                write!(
                    output,
                    "<a class=\"wikilink\" href=\"{}\">{}</a>",
                    href, display
                )?;
            }
            AstNodeKind::Link { link, title } | AstNodeKind::Embed { link, title } => {
                let display = title.as_deref().unwrap_or(link);
                // Check for YouTube, Twitter embeds
                if link.contains("youtube.com") || link.contains("youtu.be") {
                    if let Some(video_id) = extract_youtube_id(link) {
                        write!(
                            output,
                            "<div class=\"video-embed\"><iframe src=\"https://www.youtube.com/embed/{}\" frameborder=\"0\" allowfullscreen></iframe></div>",
                            video_id
                        )?;
                    } else {
                        write!(
                            output,
                            "<a class=\"external-link\" href=\"{}\">{}</a>",
                            link, display
                        )?;
                    }
                } else {
                    write!(
                        output,
                        "<a class=\"external-link\" href=\"{}\">{}</a>",
                        link, display
                    )?;
                }
            }
            AstNodeKind::Decoration {
                fontsize,
                italic,
                underline,
                deleted,
            } => {
                let mut classes = Vec::new();
                if *fontsize > 0 {
                    classes.push("bold");
                }
                if *fontsize < 0 {
                    classes.push("small");
                }
                if *italic {
                    classes.push("italic");
                }
                if *underline {
                    classes.push("underline");
                }
                if *deleted {
                    classes.push("deleted");
                }

                let class_str = classes.join(" ");
                write!(output, "<span class=\"decoration {}\">", class_str)?;
                let contents = ast.value().contents.lock().unwrap();
                for content in contents.iter() {
                    self.render_node(content, output, depth, line_idx)?;
                }
                write!(output, "</span>")?;
            }
            AstNodeKind::Text | AstNodeKind::CodeContent | AstNodeKind::MathContent => {
                write!(output, "{}", html_escape(ast.extract_str()))?;
            }
            AstNodeKind::HorizontalLine => {
                write!(output, "<hr class=\"patto-hr\"/>")?;
            }
            AstNodeKind::Table { caption } => {
                write!(output, "<table class=\"patto-table\">")?;
                if let Some(caption) = caption {
                    write!(output, "<caption>{}</caption>", html_escape(caption))?;
                }
                write!(output, "<tbody>")?;
                let children = ast.value().children.lock().unwrap();
                for child in children.iter() {
                    self.render_node(child, output, depth, line_idx)?;
                }
                write!(output, "</tbody></table>")?;
            }
            AstNodeKind::TableRow => {
                write!(output, "<tr>")?;
                let contents = ast.value().contents.lock().unwrap();
                for content in contents.iter() {
                    self.render_node(content, output, depth, line_idx)?;
                }
                write!(output, "</tr>")?;
            }
            AstNodeKind::TableColumn => {
                write!(output, "<td>")?;
                let contents = ast.value().contents.lock().unwrap();
                for content in contents.iter() {
                    self.render_node(content, output, depth, line_idx)?;
                }
                write!(output, "</td>")?;
            }
        }
        Ok(())
    }

    fn get_line_class(&self, properties: &[Property]) -> String {
        let mut classes = Vec::new();
        for property in properties {
            match property {
                Property::Task { status, .. } => {
                    classes.push(match status {
                        TaskStatus::Todo => " task todo",
                        TaskStatus::Doing => " task doing",
                        TaskStatus::Paused => " task paused",
                        TaskStatus::Done => " task done",
                    });
                }
                Property::Anchor { .. } => {
                    classes.push(" has-anchor");
                }
            }
        }
        classes.join("")
    }

    fn resolve_image_path(&self, src: &str) -> ImageSource {
        if src.starts_with("http://") || src.starts_with("https://") || src.starts_with("data:") {
            return ImageSource::Remote(src.to_string());
        }
        match &self.workspace_path {
            Some(workspace) => {
                ImageSource::Local(Path::new(workspace).join(src.strip_prefix("./").unwrap_or(src)))
            }
            None => ImageSource::Unresolved(src.to_string()),
        }
    }
}

enum ImageSource {
    /// http(s)/data: URL, passed through untouched
    Remote(String),
    /// Absolute path inside the workspace, served via the image proxy
    Local(PathBuf),
    /// No workspace known: emit the raw src
    Unresolved(String),
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn extract_youtube_id(url: &str) -> Option<String> {
    // Handle youtube.com/watch?v=ID
    if let Some(pos) = url.find("v=") {
        let id_start = pos + 2;
        let id = &url[id_start..];
        let id_end = id.find('&').unwrap_or(id.len());
        return Some(id[..id_end].to_string());
    }
    // Handle youtu.be/ID
    if url.contains("youtu.be/") {
        if let Some(pos) = url.rfind('/') {
            let id = &url[pos + 1..];
            let id_end = id.find('?').unwrap_or(id.len());
            return Some(id[..id_end].to_string());
        }
    }
    None
}
