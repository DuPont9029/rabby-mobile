use std::ffi::{CStr, c_char};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use base64::Engine;
use resvg::{tiny_skia, usvg};
use sha2::{Digest, Sha256};

const MAX_INPUT_BYTES: usize = 5 * 1024 * 1024;
const MAX_XML_NODES: usize = 10_000;
const MAX_XML_DEPTH: usize = 64;
const MAX_ATTRIBUTES: usize = 50_000;
const MAX_ATTRIBUTE_VALUE_BYTES: usize = 64 * 1024;
const MAX_STYLESHEET_BYTES: usize = 64 * 1024;
const MAX_TEXT_CHARACTERS: usize = 16 * 1024;
const MAX_EMBEDDED_PNG_BYTES: usize = 4 * 1024 * 1024;
const MAX_EMBEDDED_PNG_PIXELS: u64 = 4 * 1024 * 1024;
const MAX_TOTAL_EMBEDDED_PNG_PIXELS: u64 = 16 * 1024 * 1024;
const MIN_MAX_EDGE: u32 = 16;
const MAX_MAX_EDGE: u32 = 4096;
const MAX_ALLOWED_PIXELS: u32 = 16 * 1024 * 1024;
const BUNDLED_FONT_BYTES: &[u8] = include_bytes!("../assets/basic/Basic-Regular.ttf");
const BUNDLED_FONT_FAMILY: &str = "Basic";

static BUNDLED_FONT_DB: OnceLock<Option<Arc<usvg::fontdb::Database>>> = OnceLock::new();

#[repr(i32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RabbySafeSvgError {
    Ok = 0,
    InvalidArgument = 1,
    InputIo = 2,
    InputTooLarge = 3,
    UnsafeContent = 4,
    ParseFailed = 5,
    InvalidSize = 6,
    PixelLimit = 7,
    EncodeFailed = 8,
    Panic = 9,
    UnsupportedContent = 10,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RabbySafeSvgRenderResult {
    pub code: i32,
    pub width: u32,
    pub height: u32,
}

impl RabbySafeSvgRenderResult {
    fn success(width: u32, height: u32) -> Self {
        Self {
            code: RabbySafeSvgError::Ok as i32,
            width,
            height,
        }
    }

    fn failure(error: RabbySafeSvgError) -> Self {
        Self {
            code: error as i32,
            width: 0,
            height: 0,
        }
    }
}

#[derive(Debug)]
struct RenderedPng {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
}

fn contains_ascii_case_insensitive(haystack: &str, needle: &str) -> bool {
    haystack
        .as_bytes()
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

fn is_local_url_reference(value: &str) -> bool {
    let value = value.trim();
    if !value.starts_with("url(") || !value.ends_with(')') {
        return false;
    }

    let reference = value[4..value.len() - 1].trim().trim_matches(['\'', '"']);
    reference.starts_with('#') && reference.len() > 1
}

fn contains_non_local_url_reference(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut offset = 0usize;
    while offset + 4 <= bytes.len() {
        let Some(relative) = bytes[offset..]
            .windows(4)
            .position(|window| window.eq_ignore_ascii_case(b"url("))
        else {
            return false;
        };
        let start = offset + relative;
        let Some(close) = value[start + 4..].find(')') else {
            return true;
        };
        let end = start + 4 + close + 1;
        if !is_local_url_reference(&value[start..end]) {
            return true;
        }
        offset = end;
    }
    false
}

fn validate_css_fragment(value: &str) -> Result<(), RabbySafeSvgError> {
    // CSS escapes can hide an at-rule, URL function, or scheme from a
    // byte-level policy check. Rabby's static profile does not need them.
    if value.contains('\\')
        || value.contains('@')
        || contains_ascii_case_insensitive(value, "expression(")
        || contains_non_local_url_reference(value)
        || contains_ascii_case_insensitive(value, "javascript:")
        || contains_ascii_case_insensitive(value, "file:")
        || contains_ascii_case_insensitive(value, "data:")
        || contains_ascii_case_insensitive(value, "http:")
        || contains_ascii_case_insensitive(value, "https:")
    {
        return Err(RabbySafeSvgError::UnsafeContent);
    }

    Ok(())
}

fn bundled_font_database() -> Result<Arc<usvg::fontdb::Database>, RabbySafeSvgError> {
    BUNDLED_FONT_DB
        .get_or_init(|| {
            let mut database = usvg::fontdb::Database::new();
            database.load_font_data(BUNDLED_FONT_BYTES.to_vec());
            if database.is_empty() {
                return None;
            }

            database.set_serif_family(BUNDLED_FONT_FAMILY);
            database.set_sans_serif_family(BUNDLED_FONT_FAMILY);
            database.set_cursive_family(BUNDLED_FONT_FAMILY);
            database.set_fantasy_family(BUNDLED_FONT_FAMILY);
            database.set_monospace_family(BUNDLED_FONT_FAMILY);
            Some(Arc::new(database))
        })
        .clone()
        .ok_or(RabbySafeSvgError::UnsupportedContent)
}

fn check_raster_dimensions(width: u32, height: u32) -> Result<(u32, u32), RabbySafeSvgError> {
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or(RabbySafeSvgError::UnsafeContent)?;
    if width == 0
        || height == 0
        || width > MAX_MAX_EDGE
        || height > MAX_MAX_EDGE
        || pixels > MAX_EMBEDDED_PNG_PIXELS
    {
        return Err(RabbySafeSvgError::UnsafeContent);
    }
    Ok((width, height))
}

fn embedded_png_dimensions(data: &[u8]) -> Result<(u32, u32), RabbySafeSvgError> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if data.len() < 24
        || data.len() > MAX_EMBEDDED_PNG_BYTES
        || &data[..8] != PNG_SIGNATURE
        || u32::from_be_bytes(data[8..12].try_into().unwrap_or_default()) != 13
        || &data[12..16] != b"IHDR"
    {
        return Err(RabbySafeSvgError::UnsafeContent);
    }

    let width = u32::from_be_bytes(data[16..20].try_into().unwrap_or_default());
    let height = u32::from_be_bytes(data[20..24].try_into().unwrap_or_default());
    check_raster_dimensions(width, height)
}

/// Reads the frame size from a baseline or progressive JPEG's SOF segment.
fn embedded_jpeg_dimensions(data: &[u8]) -> Result<(u32, u32), RabbySafeSvgError> {
    if data.len() < 4 || data.len() > MAX_EMBEDDED_PNG_BYTES || data[..2] != [0xFF, 0xD8] {
        return Err(RabbySafeSvgError::UnsafeContent);
    }
    let mut offset = 2usize;
    while offset + 4 <= data.len() {
        if data[offset] != 0xFF {
            return Err(RabbySafeSvgError::UnsafeContent);
        }
        let marker = data[offset + 1];
        if marker == 0xFF {
            offset += 1;
            continue;
        }
        if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            offset += 2;
            continue;
        }
        if marker == 0xD9 || marker == 0xDA {
            break;
        }
        let length = usize::from(u16::from_be_bytes([data[offset + 2], data[offset + 3]]));
        if length < 2 || offset + 2 + length > data.len() {
            return Err(RabbySafeSvgError::UnsafeContent);
        }
        let is_start_of_frame =
            (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC;
        if is_start_of_frame {
            if length < 7 {
                return Err(RabbySafeSvgError::UnsafeContent);
            }
            let height = u16::from_be_bytes([data[offset + 5], data[offset + 6]]);
            let width = u16::from_be_bytes([data[offset + 7], data[offset + 8]]);
            return check_raster_dimensions(u32::from(width), u32::from(height));
        }
        offset += 2 + length;
    }
    Err(RabbySafeSvgError::UnsafeContent)
}

fn embedded_gif_dimensions(data: &[u8]) -> Result<(u32, u32), RabbySafeSvgError> {
    if data.len() < 10
        || data.len() > MAX_EMBEDDED_PNG_BYTES
        || !(data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a"))
    {
        return Err(RabbySafeSvgError::UnsafeContent);
    }
    let width = u16::from_le_bytes([data[6], data[7]]);
    let height = u16::from_le_bytes([data[8], data[9]]);
    check_raster_dimensions(u32::from(width), u32::from(height))
}

fn embedded_webp_dimensions(data: &[u8]) -> Result<(u32, u32), RabbySafeSvgError> {
    if data.len() < 30
        || data.len() > MAX_EMBEDDED_PNG_BYTES
        || &data[..4] != b"RIFF"
        || &data[8..12] != b"WEBP"
    {
        return Err(RabbySafeSvgError::UnsafeContent);
    }
    let le24 = |at: usize| {
        u32::from(data[at]) | (u32::from(data[at + 1]) << 8) | (u32::from(data[at + 2]) << 16)
    };
    let (width, height) = match &data[12..16] {
        b"VP8 " => {
            if data[23..26] != [0x9D, 0x01, 0x2A] {
                return Err(RabbySafeSvgError::UnsafeContent);
            }
            (
                u32::from(u16::from_le_bytes([data[26], data[27]]) & 0x3FFF),
                u32::from(u16::from_le_bytes([data[28], data[29]]) & 0x3FFF),
            )
        }
        b"VP8L" => {
            if data[20] != 0x2F {
                return Err(RabbySafeSvgError::UnsafeContent);
            }
            let bits = u32::from_le_bytes([data[21], data[22], data[23], data[24]]);
            ((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
        }
        b"VP8X" => (le24(24) + 1, le24(27) + 1),
        _ => return Err(RabbySafeSvgError::UnsafeContent),
    };
    check_raster_dimensions(width, height)
}

/// Raster formats an SVG may embed as a `data:` URL, keyed by media type.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EmbeddedRaster {
    Png,
    Jpeg,
    Gif,
    Webp,
}

impl EmbeddedRaster {
    fn from_mime(mime: &str) -> Option<Self> {
        match mime.to_ascii_lowercase().as_str() {
            "image/png" => Some(Self::Png),
            "image/jpeg" | "image/jpg" => Some(Self::Jpeg),
            "image/gif" => Some(Self::Gif),
            "image/webp" => Some(Self::Webp),
            _ => None,
        }
    }

    fn dimensions(self, data: &[u8]) -> Result<(u32, u32), RabbySafeSvgError> {
        match self {
            Self::Png => embedded_png_dimensions(data),
            Self::Jpeg => embedded_jpeg_dimensions(data),
            Self::Gif => embedded_gif_dimensions(data),
            Self::Webp => embedded_webp_dimensions(data),
        }
    }

    fn image_kind(self, data: Arc<Vec<u8>>) -> usvg::ImageKind {
        match self {
            Self::Png => usvg::ImageKind::PNG(data),
            Self::Jpeg => usvg::ImageKind::JPEG(data),
            Self::Gif => usvg::ImageKind::GIF(data),
            Self::Webp => usvg::ImageKind::WEBP(data),
        }
    }
}

const SVG_MIME: &str = "image/svg+xml";
/// Nested SVG documents may be one level deep and may not embed images.
const MAX_NESTED_SVG_DEPTH: u8 = 1;
const MAX_NESTED_SVG_BYTES: usize = 1024 * 1024;
const MAX_NESTED_SVG_DOCUMENTS: usize = 32;

fn percent_decode(value: &str) -> Option<Vec<u8>> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = value.get(index + 1..index + 3)?;
            output.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    Some(output)
}

/// Splits and decodes a `data:` URL into its media type and payload. Returns
/// `None` for anything that is not a well-formed `data:` URL.
fn decode_data_url(value: &str, max_bytes: usize) -> Option<(String, Vec<u8>)> {
    let rest = value.trim();
    let rest = rest
        .get(..5)
        .filter(|scheme| scheme.eq_ignore_ascii_case("data:"))
        .map(|_| &rest[5..])?;
    let (header, payload) = rest.split_once(',')?;
    let mut parameters = header.split(';').map(str::trim);
    let mime = parameters.next().unwrap_or_default().to_ascii_lowercase();
    let is_base64 = parameters.any(|parameter| parameter.eq_ignore_ascii_case("base64"));
    // Cheap bound before decoding: base64 is ~4/3 and percent-encoding at
    // most 3x the decoded size.
    let encoded_limit = if is_base64 {
        max_bytes.saturating_mul(4) / 3 + 64
    } else {
        max_bytes.saturating_mul(3)
    };
    if payload.len() > encoded_limit {
        return None;
    }
    let decoded = if is_base64 {
        let compact: String = payload
            .chars()
            .filter(|character| !character.is_ascii_whitespace())
            .collect();
        let compact = percent_decode(&compact)
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .unwrap_or(compact);
        base64::engine::general_purpose::STANDARD
            .decode(compact.trim_end_matches('='))
            .or_else(|_| {
                base64::engine::general_purpose::STANDARD_NO_PAD
                    .decode(compact.trim_end_matches('='))
            })
            .ok()?
    } else {
        percent_decode(payload)?
    };
    (decoded.len() <= max_bytes).then_some((mime, decoded))
}

/// Shared limits for everything embedded in one rendered SVG.
#[derive(Default)]
struct EmbeddedBudget {
    raster_pixels: u64,
    nested_documents: usize,
    nested_bytes: usize,
}

/// Checks an `image`/`feImage` `href` that is not a local `#id` reference.
/// Raster images are size-checked; SVG images are sanitized and checked with
/// the full profile one level down, where they may not embed images at all.
fn validate_embedded_image_href(
    value: &str,
    depth: u8,
    budget: &mut EmbeddedBudget,
) -> Result<(), RabbySafeSvgError> {
    if depth >= MAX_NESTED_SVG_DEPTH {
        return Err(RabbySafeSvgError::UnsafeContent);
    }
    let (mime, data) = decode_data_url(value, MAX_EMBEDDED_PNG_BYTES.max(MAX_NESTED_SVG_BYTES))
        .ok_or(RabbySafeSvgError::UnsafeContent)?;
    if let Some(raster) = EmbeddedRaster::from_mime(&mime) {
        let (width, height) = raster.dimensions(&data)?;
        budget.raster_pixels = budget
            .raster_pixels
            .checked_add(u64::from(width) * u64::from(height))
            .filter(|total| *total <= MAX_TOTAL_EMBEDDED_PNG_PIXELS)
            .ok_or(RabbySafeSvgError::UnsafeContent)?;
        return Ok(());
    }
    if mime != SVG_MIME || data.len() > MAX_NESTED_SVG_BYTES {
        return Err(RabbySafeSvgError::UnsafeContent);
    }
    budget.nested_documents += 1;
    budget.nested_bytes = budget.nested_bytes.saturating_add(data.len());
    if budget.nested_documents > MAX_NESTED_SVG_DOCUMENTS || budget.nested_bytes > MAX_INPUT_BYTES {
        return Err(RabbySafeSvgError::UnsafeContent);
    }
    let sanitized = sanitize_svg(&data);
    validate_svg_profile_at(&sanitized, depth + 1, budget).map(|_| ())
}

/// At-rules whose whole `{ ... }` block is deleted from stylesheets. Rabby
/// never loads SVG-supplied fonts, and output is a static image, so these
/// rules cannot take effect anyway.
const STRIPPED_AT_RULES: [&str; 4] = [
    "@font-face",
    "@keyframes",
    "@-webkit-keyframes",
    "@-moz-keyframes",
];

/// SMIL animation elements. They are deleted, so the static first frame is
/// rendered instead of rejecting the whole image.
const STRIPPED_ANIMATION_ELEMENTS: [&str; 4] =
    ["animate", "animateMotion", "animateTransform", "set"];

/// Removes every [`STRIPPED_AT_RULES`] rule from a stylesheet.
///
/// Returns `None` when the stylesheet has no such rule, or when a rule is not
/// followed by an optional plain name and one brace-balanced block, so the
/// caller keeps the original bytes and the profile check rejects them.
fn strip_at_rules(css: &str) -> Option<String> {
    let find_next = |text: &str| {
        STRIPPED_AT_RULES
            .iter()
            .filter_map(|rule| {
                text.as_bytes()
                    .windows(rule.len())
                    .position(|window| window.eq_ignore_ascii_case(rule.as_bytes()))
                    .map(|position| (position, rule.len()))
            })
            .min()
    };
    let mut output = String::with_capacity(css.len());
    let mut rest = css;
    let mut stripped = false;
    while let Some((start, rule_length)) = find_next(rest) {
        let after = &rest[start + rule_length..];
        // Only an identifier or quoted name may sit between the at-rule and
        // its block (e.g. `@keyframes spin {`).
        let open = after.find('{')?;
        if !after[..open].chars().all(|character| {
            character.is_ascii_alphanumeric()
                || character.is_ascii_whitespace()
                || matches!(character, '-' | '_' | '"' | '\'')
        }) {
            return None;
        }
        let block = &after[open..];
        let mut depth = 0usize;
        let mut end = None;
        for (index, character) in block.char_indices() {
            match character {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(index + 1);
                        break;
                    }
                }
                _ => {}
            }
        }
        output.push_str(&rest[..start]);
        rest = &block[end?..];
        stripped = true;
    }
    if !stripped {
        return None;
    }
    output.push_str(rest);
    Some(output)
}

/// Makes common on-chain NFT artwork fit the static profile by deleting the
/// parts that cannot take effect in a static, font-free rendering:
/// [`STRIPPED_AT_RULES`] in `<style>` elements and
/// [`STRIPPED_ANIMATION_ELEMENTS`].
///
/// This step only deletes bytes. The full static profile check still runs on
/// its output, so anything else in the SVG is judged exactly as before. Any
/// input this step cannot handle safely is returned unchanged.
fn sanitize_svg(svg: &[u8]) -> std::borrow::Cow<'_, [u8]> {
    use std::borrow::Cow;

    if svg.len() > MAX_INPUT_BYTES {
        return Cow::Borrowed(svg);
    }
    let Ok(text) = std::str::from_utf8(svg) else {
        return Cow::Borrowed(svg);
    };
    let options = roxmltree::ParsingOptions {
        allow_dtd: false,
        ..Default::default()
    };
    let Ok(document) = roxmltree::Document::parse_with_options(text, options) else {
        return Cow::Borrowed(svg);
    };

    let mut edits: Vec<(std::ops::Range<usize>, String)> = Vec::new();
    for animation in document.descendants().filter(|node| {
        node.is_element() && STRIPPED_ANIMATION_ELEMENTS.contains(&node.tag_name().name())
    }) {
        edits.push((animation.range(), String::new()));
    }
    for style in document
        .descendants()
        .filter(|node| node.is_element() && node.tag_name().name() == "style")
    {
        for child in style.children().filter(|child| child.is_text()) {
            let Some(content) = child.text() else {
                continue;
            };
            // Only edit text whose source bytes match its parsed value, plain
            // or in a single CDATA section. Entity-encoded stylesheets are
            // left untouched for the profile check to judge.
            let range = child.range();
            let source = &text[range.clone()];
            let content_start = if source == content {
                range.start
            } else if source
                .strip_prefix("<![CDATA[")
                .and_then(|inner| inner.strip_suffix("]]>"))
                == Some(content)
            {
                range.start + "<![CDATA[".len()
            } else {
                continue;
            };
            if let Some(stripped) = strip_at_rules(content) {
                edits.push((content_start..content_start + content.len(), stripped));
            }
        }
    }
    if edits.is_empty() {
        return Cow::Borrowed(svg);
    }

    let mut output = String::with_capacity(text.len());
    let mut cursor = 0usize;
    edits.sort_by_key(|(range, _)| range.start);
    for (range, replacement) in edits {
        // An edit inside an element that is already deleted (e.g. a
        // `<style>` nested in `<set>`) is covered by that deletion.
        if range.start < cursor {
            continue;
        }
        output.push_str(&text[cursor..range.start]);
        output.push_str(&replacement);
        cursor = range.end;
    }
    output.push_str(&text[cursor..]);
    Cow::Owned(output.into_bytes())
}

fn validate_svg_profile(svg: &[u8]) -> Result<&str, RabbySafeSvgError> {
    validate_svg_profile_at(svg, 0, &mut EmbeddedBudget::default())
}

fn validate_svg_profile_at<'a>(
    svg: &'a [u8],
    depth: u8,
    budget: &mut EmbeddedBudget,
) -> Result<&'a str, RabbySafeSvgError> {
    if svg.len() > MAX_INPUT_BYTES {
        return Err(RabbySafeSvgError::InputTooLarge);
    }
    if svg.starts_with(&[0x1f, 0x8b]) {
        return Err(RabbySafeSvgError::UnsafeContent);
    }

    let text = std::str::from_utf8(svg).map_err(|_| RabbySafeSvgError::ParseFailed)?;
    if contains_ascii_case_insensitive(text, "<!doctype")
        || contains_ascii_case_insensitive(text, "<!entity")
        || contains_ascii_case_insensitive(text, "<?xml-stylesheet")
    {
        return Err(RabbySafeSvgError::UnsafeContent);
    }

    let options = roxmltree::ParsingOptions {
        allow_dtd: false,
        ..Default::default()
    };
    let document = roxmltree::Document::parse_with_options(text, options)
        .map_err(|_| RabbySafeSvgError::ParseFailed)?;

    let root = document.root_element();
    if root.tag_name().name() != "svg" {
        return Err(RabbySafeSvgError::ParseFailed);
    }

    let forbidden_elements = [
        "script",
        "foreignObject",
        "animate",
        "animateMotion",
        "animateTransform",
        "set",
        "audio",
        "video",
        "iframe",
    ];
    let mut node_count = 0usize;
    let mut attribute_count = 0usize;
    let mut stylesheet_bytes = 0usize;
    let mut text_characters = 0usize;

    for node in document.descendants() {
        node_count = node_count.saturating_add(1);
        if node_count > MAX_XML_NODES {
            return Err(RabbySafeSvgError::UnsafeContent);
        }
        if node.ancestors().count() > MAX_XML_DEPTH {
            return Err(RabbySafeSvgError::UnsafeContent);
        }
        if node.is_pi() {
            return Err(RabbySafeSvgError::UnsafeContent);
        }
        if node.is_text()
            && node.ancestors().any(|ancestor| {
                ancestor.is_element() && matches!(ancestor.tag_name().name(), "text" | "tspan")
            })
        {
            // Characters the bundled font has no glyph for are left out of
            // the rendering; only the amount of text work is bounded.
            let value = node.text().unwrap_or_default();
            text_characters = text_characters.saturating_add(value.chars().count());
            if text_characters > MAX_TEXT_CHARACTERS {
                return Err(RabbySafeSvgError::UnsupportedContent);
            }
        }
        if !node.is_element() {
            continue;
        }

        let element_name = node.tag_name().name();
        if forbidden_elements.contains(&element_name) {
            return Err(RabbySafeSvgError::UnsafeContent);
        }
        let is_image_element = matches!(element_name, "image" | "feImage");

        if element_name == "style" {
            if node.children().any(|child| child.is_element()) {
                return Err(RabbySafeSvgError::UnsafeContent);
            }

            let mut stylesheet = String::new();
            for content in node.children().filter_map(|child| child.text()) {
                stylesheet_bytes = stylesheet_bytes.saturating_add(content.len());
                if stylesheet_bytes > MAX_STYLESHEET_BYTES {
                    return Err(RabbySafeSvgError::UnsafeContent);
                }
                stylesheet.push_str(content);
            }
            validate_css_fragment(&stylesheet)?;
        }

        if element_name == "image"
            && node
                .attributes()
                .filter(|attribute| attribute.name() == "href")
                .count()
                != 1
        {
            return Err(RabbySafeSvgError::UnsafeContent);
        }

        for attribute in node.attributes() {
            let name = attribute.name();
            let value = attribute.value().trim();
            // `image`/`feImage` may embed a data: image; anything else in an
            // `href` must be a local `#id` reference.
            let is_embedded_image = is_image_element && name == "href" && !value.starts_with('#');

            attribute_count = attribute_count.saturating_add(1);
            // Embedded images are bounded by their own decoded-size limits
            // (and the total input size) instead of the attribute limit.
            if attribute_count > MAX_ATTRIBUTES
                || (!is_embedded_image && attribute.value().len() > MAX_ATTRIBUTE_VALUE_BYTES)
            {
                return Err(RabbySafeSvgError::UnsafeContent);
            }

            if name
                .as_bytes()
                .get(..2)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"on"))
            {
                return Err(RabbySafeSvgError::UnsafeContent);
            }
            if is_embedded_image {
                validate_embedded_image_href(value, depth, budget)?;
            } else if name == "href" && !value.starts_with('#') {
                return Err(RabbySafeSvgError::UnsafeContent);
            }
            if name == "style" {
                validate_css_fragment(value)?;
            } else if !is_embedded_image && contains_non_local_url_reference(value) {
                return Err(RabbySafeSvgError::UnsafeContent);
            }
            if !is_embedded_image
                && (contains_ascii_case_insensitive(value, "javascript:")
                    || contains_ascii_case_insensitive(value, "file:")
                    || contains_ascii_case_insensitive(value, "data:")
                    || contains_ascii_case_insensitive(value, "http:")
                    || contains_ascii_case_insensitive(value, "https:"))
            {
                return Err(RabbySafeSvgError::UnsafeContent);
            }
            if !is_embedded_image && contains_ascii_case_insensitive(value, "url(") {
                let has_unsafe_reference = if name == "style" {
                    contains_non_local_url_reference(value)
                } else {
                    !is_local_url_reference(value)
                };
                if has_unsafe_reference {
                    return Err(RabbySafeSvgError::UnsafeContent);
                }
            }
        }
    }

    Ok(text)
}

/// Builds the `usvg` options for one document level. Embedded data is
/// re-checked here on the exact bytes `usvg` decoded, against limits shared
/// by every image in the rendering: rasters must pass the dimension checks,
/// and nested SVGs must pass sanitizing and the full profile check one level
/// down, where image resolving is disabled entirely.
fn safe_usvg_options(
    fontdb: Arc<usvg::fontdb::Database>,
    font_id: usvg::fontdb::ID,
    depth: u8,
    budget: Arc<std::sync::Mutex<EmbeddedBudget>>,
) -> usvg::Options<'static> {
    let nested_fontdb = Arc::clone(&fontdb);
    let resolve_data: usvg::ImageHrefDataResolverFn<'static> = Box::new(move |mime, data, _| {
        if depth >= MAX_NESTED_SVG_DEPTH {
            return None;
        }
        let mut shared = budget.lock().ok()?;
        if let Some(raster) = EmbeddedRaster::from_mime(mime) {
            let (width, height) = raster.dimensions(&data).ok()?;
            shared.raster_pixels = shared
                .raster_pixels
                .checked_add(u64::from(width) * u64::from(height))
                .filter(|total| *total <= MAX_TOTAL_EMBEDDED_PNG_PIXELS)?;
            return Some(raster.image_kind(data));
        }
        if !mime.eq_ignore_ascii_case(SVG_MIME) || data.len() > MAX_NESTED_SVG_BYTES {
            return None;
        }
        shared.nested_documents += 1;
        shared.nested_bytes = shared.nested_bytes.saturating_add(data.len());
        if shared.nested_documents > MAX_NESTED_SVG_DOCUMENTS
            || shared.nested_bytes > MAX_INPUT_BYTES
        {
            return None;
        }
        let sanitized = sanitize_svg(&data).into_owned();
        validate_svg_profile_at(&sanitized, depth + 1, &mut shared).ok()?;
        drop(shared);
        let nested_options = safe_usvg_options(
            Arc::clone(&nested_fontdb),
            font_id,
            depth + 1,
            Arc::clone(&budget),
        );
        usvg::Tree::from_data(&sanitized, &nested_options)
            .ok()
            .map(usvg::ImageKind::SVG)
    });
    usvg::Options {
        resources_dir: None,
        font_family: BUNDLED_FONT_FAMILY.to_owned(),
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data,
            resolve_string: Box::new(|_, _| None),
        },
        font_resolver: usvg::FontResolver {
            // Ignore untrusted font-family names. Every accepted glyph is
            // converted to paths with this one app-bundled font.
            select_font: Box::new(move |_, _| Some(font_id)),
            select_fallback: Box::new(|_, _, _| None),
        },
        fontdb,
        ..usvg::Options::default()
    }
}

fn render_svg_to_png(
    svg: &[u8],
    max_edge: u32,
    max_pixels: u32,
) -> Result<RenderedPng, RabbySafeSvgError> {
    let svg = sanitize_svg(svg);
    let svg = svg.as_ref();
    validate_svg_profile(svg)?;
    if !(MIN_MAX_EDGE..=MAX_MAX_EDGE).contains(&max_edge)
        || max_pixels == 0
        || max_pixels > MAX_ALLOWED_PIXELS
    {
        return Err(RabbySafeSvgError::InvalidArgument);
    }

    let fontdb = bundled_font_database()?;
    let font_id = fontdb
        .faces()
        .next()
        .map(|face| face.id)
        .ok_or(RabbySafeSvgError::UnsupportedContent)?;
    let budget = Arc::new(std::sync::Mutex::new(EmbeddedBudget::default()));
    let options = safe_usvg_options(fontdb, font_id, 0, budget);
    let tree = usvg::Tree::from_data(svg, &options).map_err(|error| match error {
        usvg::Error::ElementsLimitReached => RabbySafeSvgError::UnsafeContent,
        usvg::Error::InvalidSize => RabbySafeSvgError::InvalidSize,
        _ => RabbySafeSvgError::ParseFailed,
    })?;

    let source_size = tree.size();
    let source_width = source_size.width();
    let source_height = source_size.height();
    if !source_width.is_finite()
        || !source_height.is_finite()
        || source_width <= 0.0
        || source_height <= 0.0
    {
        return Err(RabbySafeSvgError::InvalidSize);
    }

    let requested_scale = max_edge as f32 / source_width.max(source_height);
    if !requested_scale.is_finite() || requested_scale <= 0.0 {
        return Err(RabbySafeSvgError::InvalidSize);
    }

    let requested_width = (source_width * requested_scale).round().max(1.0) as u32;
    let requested_height = (source_height * requested_scale).round().max(1.0) as u32;
    let requested_pixels = requested_width
        .checked_mul(requested_height)
        .ok_or(RabbySafeSvgError::PixelLimit)?;
    let final_scale = if requested_pixels > max_pixels {
        requested_scale * (max_pixels as f32 / requested_pixels as f32).sqrt()
    } else {
        requested_scale
    };

    let width = (source_width * final_scale).round().max(1.0) as u32;
    let height = (source_height * final_scale).round().max(1.0) as u32;
    let pixels = width
        .checked_mul(height)
        .ok_or(RabbySafeSvgError::PixelLimit)?;
    if pixels > max_pixels {
        return Err(RabbySafeSvgError::PixelLimit);
    }

    let mut pixmap = tiny_skia::Pixmap::new(width, height).ok_or(RabbySafeSvgError::PixelLimit)?;
    let transform = tiny_skia::Transform::from_scale(final_scale, final_scale);
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    let bytes = pixmap
        .encode_png()
        .map_err(|_| RabbySafeSvgError::EncodeFailed)?;

    Ok(RenderedPng {
        bytes,
        width,
        height,
    })
}

fn render_file(
    input_path: &Path,
    output_path: &Path,
    max_edge: u32,
    max_pixels: u32,
) -> Result<RabbySafeSvgRenderResult, RabbySafeSvgError> {
    let metadata = std::fs::metadata(input_path).map_err(|_| RabbySafeSvgError::InputIo)?;
    if !metadata.is_file() {
        return Err(RabbySafeSvgError::InputIo);
    }
    if metadata.len() > MAX_INPUT_BYTES as u64 {
        return Err(RabbySafeSvgError::InputTooLarge);
    }

    let svg = std::fs::read(input_path).map_err(|_| RabbySafeSvgError::InputIo)?;
    let rendered = render_svg_to_png(&svg, max_edge, max_pixels)?;
    std::fs::write(output_path, rendered.bytes).map_err(|_| RabbySafeSvgError::EncodeFailed)?;
    Ok(RabbySafeSvgRenderResult::success(
        rendered.width,
        rendered.height,
    ))
}

fn c_path(path: *const c_char) -> Result<PathBuf, RabbySafeSvgError> {
    if path.is_null() {
        return Err(RabbySafeSvgError::InvalidArgument);
    }
    let value = unsafe { CStr::from_ptr(path) }
        .to_str()
        .map_err(|_| RabbySafeSvgError::InvalidArgument)?;
    if value.is_empty() {
        return Err(RabbySafeSvgError::InvalidArgument);
    }
    Ok(PathBuf::from(value))
}

#[unsafe(no_mangle)]
/// # Safety
///
/// Both path pointers must be non-null, NUL-terminated UTF-8 strings that
/// remain valid for the duration of this call.
pub unsafe extern "C" fn rabby_safe_svg_render_file(
    input_path: *const c_char,
    output_path: *const c_char,
    max_edge: u32,
    max_pixels: u32,
) -> RabbySafeSvgRenderResult {
    match catch_unwind(AssertUnwindSafe(|| {
        let input_path = c_path(input_path)?;
        let output_path = c_path(output_path)?;
        render_file(&input_path, &output_path, max_edge, max_pixels)
    })) {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => RabbySafeSvgRenderResult::failure(error),
        Err(_) => RabbySafeSvgRenderResult::failure(RabbySafeSvgError::Panic),
    }
}

#[unsafe(no_mangle)]
/// # Safety
///
/// `data` must point to `data_len` readable bytes. `output_hex` must point to
/// at least `output_hex_len` writable bytes, with a minimum length of 65.
pub unsafe extern "C" fn rabby_safe_svg_sha256(
    data: *const u8,
    data_len: usize,
    output_hex: *mut c_char,
    output_hex_len: usize,
) -> i32 {
    let result = catch_unwind(AssertUnwindSafe(|| {
        if data.is_null() || output_hex.is_null() || output_hex_len < 65 {
            return Err(RabbySafeSvgError::InvalidArgument);
        }
        let bytes = unsafe { std::slice::from_raw_parts(data, data_len) };
        let digest = Sha256::digest(bytes);
        let mut encoded = [0u8; 64];
        const HEX: &[u8; 16] = b"0123456789abcdef";
        for (index, byte) in digest.iter().copied().enumerate() {
            encoded[index * 2] = HEX[(byte >> 4) as usize];
            encoded[index * 2 + 1] = HEX[(byte & 0x0f) as usize];
        }
        unsafe {
            std::ptr::copy_nonoverlapping(encoded.as_ptr(), output_hex.cast::<u8>(), encoded.len());
            *output_hex.add(encoded.len()) = 0;
        }
        Ok(())
    }));

    match result {
        Ok(Ok(())) => RabbySafeSvgError::Ok as i32,
        Ok(Err(error)) => error as i32,
        Err(_) => RabbySafeSvgError::Panic as i32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAFE_SVG: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><defs><linearGradient id="g"><stop stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient></defs><rect width="100" height="50" fill="url(#g)"/></svg>"##;

    #[test]
    fn renders_a_bounded_static_svg_to_png() {
        let rendered = render_svg_to_png(SAFE_SVG, 256, 1_000_000).unwrap();
        assert_eq!((rendered.width, rendered.height), (256, 128));
        assert!(rendered.bytes.starts_with(&[0x89, b'P', b'N', b'G']));
    }

    #[test]
    fn permits_local_style_references_but_rejects_unsafe_stylesheets() {
        let inline = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop stop-color="#fff"/></linearGradient></defs><rect width="10" height="10" style="fill:url(#g);stroke:#000"/></svg>"##;
        assert!(render_svg_to_png(inline, 64, 100_000).is_ok());

        for stylesheet in [
            br#"<svg xmlns="http://www.w3.org/2000/svg"><style>rect { fill: url(https://example.com/a.svg); }</style><rect width="1" height="1"/></svg>"#.as_slice(),
            br#"<svg xmlns="http://www.w3.org/2000/svg"><style>@import "theme.css"; rect { fill: red; }</style><rect width="1" height="1"/></svg>"#.as_slice(),
            br#"<svg xmlns="http://www.w3.org/2000/svg"><style>.x { fill: u\72l(https://example.com/a.svg); }</style><rect class="x" width="1" height="1"/></svg>"#.as_slice(),
        ] {
            assert_eq!(
                render_svg_to_png(stylesheet, 64, 100_000).unwrap_err(),
                RabbySafeSvgError::UnsafeContent
            );
        }
    }

    #[test]
    fn rejects_active_and_external_content() {
        for svg in [
            br#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#.as_slice(),
            br#"<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>"#.as_slice(),
            br#"<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="run()" width="1" height="1"/></svg>"#.as_slice(),
            br#"<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"/>"#.as_slice(),
        ] {
            assert_eq!(
                render_svg_to_png(svg, 256, 1_000_000).unwrap_err(),
                RabbySafeSvgError::UnsafeContent
            );
        }
    }

    #[test]
    fn renders_a_bounded_embedded_png_but_rejects_other_image_sources() {
        let embedded_png = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><image width="240" height="240" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAPAAAADwBAMAAADMe/ShAAAAG1BMVEUAAACui2FjhZb/9o5ZWVmGWB5fHQmnfEcAQP8C9EmFAAABQElEQVR42u3by23DMBAFQLWQFtyCWkgLaSEtpIWUHUgHC1isGZJY00Ay7yaR4OzpQfJnu70oGxgMBoPBYDAYDAaD/x68HwmX4R4YDAa/Gs6O3pNkY4HBYPBKeH+UjlUwGAxeDg9J48OAwWBwLTzEdQzTXZlgMBg8A+91GXvYA4PB4Gm4Y4S3JOMjgMFgcC3c5jL9utf7TQEYDAaXwUNFmc2xHZmoTDAYDJ6Gg34ec536cU/Qr4UMnuhqMBgM7ofD7gCfl19HAnwtgMFg8HI4q8ygt1P5sAcGg8HTr6mTcPtn/GAwGFwGh93tD9iyiTpMMBgMfhY8VJnb7wGDweCnwqHxMvjznnP1/VG+j4DBYPAiOG5s9mZlZYLBYHA9nI2QHT37tyMwGAyuh7OOvA0HDAaDl8OTRQkGg8FgMBj8L+Efqp8TFlZDe5MAAAAASUVORK5CYII="/></svg>"#;
        let rendered = render_svg_to_png(embedded_png, 64, 100_000).unwrap();
        let pixmap = tiny_skia::Pixmap::decode_png(&rendered.bytes).unwrap();
        assert!(pixmap.pixels().iter().any(|pixel| pixel.alpha() > 0));

        for svg in [
            br#"<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>"#.as_slice(),
            br#"<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxpbWFnZSBocmVmPSJkYXRhOmltYWdlL3BuZztiYXNlNjQsaVZCT1J3MEtHZ289Ii8+PC9zdmc+"/></svg>"#.as_slice(),
            br#"<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/bmp;base64,Qk0="/></svg>"#.as_slice(),
            br#"<svg xmlns="http://www.w3.org/2000/svg"><image href="data:text/html,%3Cscript%3E"/></svg>"#.as_slice(),
            br#"<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,not-base64"/></svg>"#.as_slice(),
        ] {
            assert_eq!(
                render_svg_to_png(svg, 64, 100_000).unwrap_err(),
                RabbySafeSvgError::UnsafeContent
            );
        }
    }

    #[test]
    fn rejects_malformed_svg_without_panicking() {
        assert_eq!(
            render_svg_to_png(b"<svg><", 256, 1_000_000).unwrap_err(),
            RabbySafeSvgError::ParseFailed
        );
    }

    #[test]
    fn renders_bounded_static_text_with_the_bundled_font() {
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMinYMin meet" viewBox="0 0 350 350"><style>.base { fill: black; font-family: Impact; font-size: 50px; }</style><rect width="100%" height="100%" fill="#E8D33E"/><text x="10" y="60" class="base">token 1398</text><text x="10" y="150" class="base">balanceOf 15721239218291655</text><text x="10" y="230" class="base">locked_end 1680739200</text><text x="10" y="310" class="base">value 4000000000000000000</text></svg>"##;
        let rendered = render_svg_to_png(svg, 350, 350 * 350).unwrap();
        let pixmap = tiny_skia::Pixmap::decode_png(&rendered.bytes).unwrap();

        assert_eq!((rendered.width, rendered.height), (350, 350));
        assert!(pixmap.pixels().iter().any(|pixel| {
            pixel.alpha() > 0 && pixel.red() < 64 && pixel.green() < 64 && pixel.blue() < 64
        }));
    }

    #[test]
    fn renders_text_with_glyphs_the_bundled_font_lacks_by_leaving_them_out() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" fill="#123"/><text x="1" y="10">🙂 NFT</text></svg>"##;
        assert!(render_svg_to_png(svg.as_bytes(), 64, 100_000).is_ok());
    }

    #[test]
    fn renders_text_with_the_bundled_font_when_the_svg_embeds_its_own_font() {
        for svg in [
            br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><style>@font-face { font-family: NftFont; src: url("data:font/otf;base64,T1RUTwAJAIAAAwAQ") format("opentype"); } .t { font-family: NftFont; fill: #000; }</style><text x="1" y="12" class="t">NFT</text></svg>"#.as_slice(),
            br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><style><![CDATA[@FONT-FACE{font-family:A;src:url(data:font/woff2;base64,d09GMgAB)} .t{fill:#000}]]></style><text x="1" y="12" class="t">NFT</text></svg>"#.as_slice(),
        ] {
            let rendered = render_svg_to_png(svg, 64, 100_000).unwrap();
            let pixmap = tiny_skia::Pixmap::decode_png(&rendered.bytes).unwrap();
            assert!(pixmap.pixels().iter().any(|pixel| pixel.alpha() > 0));
        }
    }

    #[test]
    fn still_rejects_unsafe_stylesheets_next_to_a_font_face_rule() {
        for svg in [
            br#"<svg xmlns="http://www.w3.org/2000/svg"><style>@font-face { font-family: A; src: url(data:font/otf;base64,AA) } @import "theme.css";</style><rect width="1" height="1"/></svg>"#.as_slice(),
            br#"<svg xmlns="http://www.w3.org/2000/svg"><style>@font-face { font-family: A; src: url(data:font/otf;base64,AA) } rect { fill: url(https://example.com/a.svg); }</style><rect width="1" height="1"/></svg>"#.as_slice(),
            br#"<svg xmlns="http://www.w3.org/2000/svg"><style>@font-face { font-family: A; src: url(data:font/otf;base64,AA)</style><rect width="1" height="1"/></svg>"#.as_slice(),
            br#"<svg xmlns="http://www.w3.org/2000/svg"><style>@font-face;</style><rect width="1" height="1"/></svg>"#.as_slice(),
            br#"<svg xmlns="http://www.w3.org/2000/svg"><style>&#64;font-face { src: url(data:font/otf;base64,AA) }</style><rect width="1" height="1"/></svg>"#.as_slice(),
            br#"<svg xmlns="http://www.w3.org/2000/svg"><style>@font-face { src: url(data:font/otf;base64,AA) }</style><script>alert(1)</script></svg>"#.as_slice(),
        ] {
            assert_eq!(
                render_svg_to_png(svg, 64, 100_000).unwrap_err(),
                RabbySafeSvgError::UnsafeContent
            );
        }
    }

    #[test]
    fn renders_local_text_paths_but_rejects_excessive_text_work() {
        let text_path = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path id="p" d="M0 10h20"/><text><textPath href="#p">NFT</textPath></text></svg>"##;
        let rendered = render_svg_to_png(text_path, 64, 100_000).unwrap();
        let pixmap = tiny_skia::Pixmap::decode_png(&rendered.bytes).unwrap();
        assert!(pixmap.pixels().iter().any(|pixel| pixel.alpha() > 0));

        let external_text_path = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><text><textPath href="https://example.com/p.svg#p">NFT</textPath></text></svg>"#;
        assert_eq!(
            render_svg_to_png(external_text_path, 64, 100_000).unwrap_err(),
            RabbySafeSvgError::UnsafeContent
        );

        let oversized_text = format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 20 20\"><text>{}</text></svg>",
            "a".repeat(MAX_TEXT_CHARACTERS + 1)
        );
        assert_eq!(
            render_svg_to_png(oversized_text.as_bytes(), 64, 100_000).unwrap_err(),
            RabbySafeSvgError::UnsupportedContent
        );
    }

    #[test]
    fn renders_the_first_frame_of_smil_and_css_animations() {
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>@keyframes spin { from { opacity: 0; } to { opacity: 1; } } @-webkit-keyframes "x" { 0% { fill: red; } } rect { fill: #0a0; }</style><rect width="10" height="10"><animate attributeName="width" values="1;10" dur="2s" repeatCount="indefinite"/><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="1s"/><set attributeName="fill" to="blue"/></rect><g><animateMotion dur="1s"><mpath href="#r"/></animateMotion></g></svg>"##;
        let rendered = render_svg_to_png(svg, 64, 100_000).unwrap();
        let pixmap = tiny_skia::Pixmap::decode_png(&rendered.bytes).unwrap();
        assert!(pixmap.pixels().iter().any(|pixel| pixel.alpha() > 0));
    }

    #[test]
    fn still_rejects_animations_that_point_outside_the_document() {
        // The animation itself is deleted, but anything else unsafe in the
        // document is still judged by the profile check.
        for svg in [
            br#"<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.com"><set attributeName="href" to="javascript:alert(1)"/></a></svg>"#.as_slice(),
            br#"<svg xmlns="http://www.w3.org/2000/svg"><style>@keyframes a { to { fill: red; } } @import "x.css";</style></svg>"#.as_slice(),
            br#"<svg xmlns="http://www.w3.org/2000/svg"><style>@keyframes ;x { }</style></svg>"#.as_slice(),
        ] {
            assert_eq!(
                render_svg_to_png(svg, 64, 100_000).unwrap_err(),
                RabbySafeSvgError::UnsafeContent
            );
        }
    }

    #[test]
    fn renders_nested_svg_images_one_level_deep() {
        for href in [
            "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMCAxMCI+PHJlY3Qgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjZjAwIj48YW5pbWF0ZSBhdHRyaWJ1dGVOYW1lPSJmaWxsIiB2YWx1ZXM9IiNmMDA7IzAwZiIgZHVyPSIxcyIvPjwvcmVjdD48L3N2Zz4=",
            "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2010%2010%22%3E%3Crect%20width%3D%2210%22%20height%3D%2210%22%20fill%3D%22%23f00%22%3E%3Canimate%20attributeName%3D%22fill%22%20values%3D%22%23f00%3B%2300f%22%20dur%3D%221s%22%2F%3E%3C%2Frect%3E%3C%2Fsvg%3E",
        ] {
            let svg = format!(
                r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image width="10" height="10" href="{href}"/></svg>"#
            );
            let rendered = render_svg_to_png(svg.as_bytes(), 64, 100_000).unwrap();
            let pixmap = tiny_skia::Pixmap::decode_png(&rendered.bytes).unwrap();
            assert!(
                pixmap.pixels().iter().any(|pixel| pixel.alpha() > 0),
                "nested image did not render for {href}"
            );
        }
    }

    #[test]
    fn nested_svg_images_cannot_reach_outside_the_document() {
        // An unsafe nested document makes the whole image fail the check.
        for inner in [
            r#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://example.com/a.css";</style></svg>"#,
        ] {
            let encoded = base64::engine::general_purpose::STANDARD.encode(inner);
            let svg = format!(
                r#"<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml;base64,{encoded}"/></svg>"#
            );
            assert_eq!(
                render_svg_to_png(svg.as_bytes(), 64, 100_000).unwrap_err(),
                RabbySafeSvgError::UnsafeContent
            );
        }
    }

    #[test]
    fn reads_embedded_raster_dimensions_and_rejects_oversized_ones() {
        // 1x1 GIF, a JPEG SOF0 header (2x3) and a VP8L WebP header (5x7).
        let gif = base64::engine::general_purpose::STANDARD
            .decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
            .unwrap();
        assert_eq!(embedded_gif_dimensions(&gif).unwrap(), (1, 1));
        let jpeg = [
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00,
            0x03, 0x00, 0x02, 0x01, 0x01, 0x11, 0x00, 0xFF, 0xD9,
        ];
        assert_eq!(embedded_jpeg_dimensions(&jpeg).unwrap(), (2, 3));
        let mut webp = b"RIFF\x00\x00\x00\x00WEBPVP8L\x00\x00\x00\x00\x2F".to_vec();
        let bits: u32 = 4 | (6 << 14);
        webp.extend_from_slice(&bits.to_le_bytes());
        webp.resize(32, 0);
        assert_eq!(embedded_webp_dimensions(&webp).unwrap(), (5, 7));

        let huge_gif = [
            b'G', b'I', b'F', b'8', b'9', b'a', 0xFF, 0xFF, 0xFF, 0xFF, 0, 0,
        ];
        assert_eq!(
            embedded_gif_dimensions(&huge_gif).unwrap_err(),
            RabbySafeSvgError::UnsafeContent
        );
        assert!(embedded_jpeg_dimensions(&[0xFF, 0xD8, 0xFF]).is_err());
        assert!(embedded_webp_dimensions(b"RIFF").is_err());

        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><image width="1" height="1" href="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"/></svg>"#;
        assert!(render_svg_to_png(svg.as_bytes(), 64, 100_000).is_ok());
    }

    #[test]
    fn decodes_data_urls_strictly() {
        assert_eq!(
            decode_data_url("data:image/svg+xml;utf8,%3Csvg%2F%3E", 1024).unwrap(),
            ("image/svg+xml".to_owned(), b"<svg/>".to_vec())
        );
        assert_eq!(
            decode_data_url("DATA:Image/PNG;base64,AAEC", 1024).unwrap(),
            ("image/png".to_owned(), vec![0, 1, 2])
        );
        assert!(decode_data_url("https://example.com/a.png", 1024).is_none());
        assert!(decode_data_url("data:image/png;base64,AAAA", 2).is_none());
        assert!(decode_data_url("data:image/svg+xml,%zz", 1024).is_none());
    }

    #[test]
    fn clamps_output_by_edge_and_pixel_budget() {
        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10000 10000"><rect width="10000" height="10000"/></svg>"#;
        let rendered = render_svg_to_png(svg, 4096, 1_000_000).unwrap();
        assert!(rendered.width <= 1000);
        assert!(rendered.height <= 1000);
        assert!(rendered.width * rendered.height <= 1_000_000);
    }
}
