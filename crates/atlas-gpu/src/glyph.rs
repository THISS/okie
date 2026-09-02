use atlas_engine::{Rect, Vec2};
use atlas_protocol::TextAlign;
use fontdue::{Font, FontSettings};

const IBM_PLEX_SANS_REGULAR: &[u8] =
    include_bytes!("../../../third_party/fonts/ibm-plex-v6.4.2/IBMPlexSans-Regular.ttf");
const IBM_PLEX_SANS_MEDIUM: &[u8] =
    include_bytes!("../../../third_party/fonts/ibm-plex-v6.4.2/IBMPlexSans-Medium.ttf");
const IBM_PLEX_SANS_SEMIBOLD: &[u8] =
    include_bytes!("../../../third_party/fonts/ibm-plex-v6.4.2/IBMPlexSans-SemiBold.ttf");
const IBM_PLEX_MONO_REGULAR: &[u8] =
    include_bytes!("../../../third_party/fonts/ibm-plex-v6.4.2/IBMPlexMono-Regular.ttf");
const IBM_PLEX_MONO_SEMIBOLD: &[u8] =
    include_bytes!("../../../third_party/fonts/ibm-plex-v6.4.2/IBMPlexMono-SemiBold.ttf");

const FIRST_GLYPH: u8 = 32;
const GLYPH_PIXELS: u32 = 64;
const GLYPH_PADDING: u32 = 5;
const RASTER_SIZE: f32 = 48.0;
const ATLAS_COLUMNS: u32 = 16;
const GLYPH_ROWS: u32 = 6;
const FACE_COUNT: u32 = 5;
const ATLAS_ROWS: u32 = GLYPH_ROWS * FACE_COUNT;
const ELLIPSIS_GLYPH_INDEX: u32 = 95;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FontFace {
    SansRegular = 0,
    SansMedium = 1,
    SansSemibold = 2,
    MonoRegular = 3,
    MonoSemibold = 4,
}

impl FontFace {
    fn from_family(value: &str) -> Self {
        let lower = value.to_ascii_lowercase();
        let mono = lower.contains("mono");
        let semibold =
            lower.contains("semibold") || lower.contains("600") || lower.contains("bold");
        let medium = lower.contains("medium") || lower.contains("500");
        match (mono, medium, semibold) {
            (true, _, false) => Self::MonoRegular,
            (true, _, true) => Self::MonoSemibold,
            (false, _, true) => Self::SansSemibold,
            (false, true, false) => Self::SansMedium,
            (false, false, false) => Self::SansRegular,
        }
    }

    const fn atlas_row_offset(self) -> u32 {
        self as u32 * GLYPH_ROWS
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct GlyphMetric {
    width: u32,
    height: u32,
    xmin: i32,
    ymin: i32,
    advance: f32,
    atlas_x: u32,
    atlas_y: u32,
}

fn glyph_count(value: &str) -> usize {
    value.chars().count()
}

fn path_candidate(root: Option<&str>, tail: &[&str]) -> String {
    match root {
        Some(root) => format!("{root}/…/{}", tail.join("/")),
        None => format!("…/{}", tail.join("/")),
    }
}

fn fit_text_content(content: &str, capacity: usize) -> String {
    if glyph_count(content) <= capacity {
        return content.to_owned();
    }
    if capacity == 0 {
        return String::new();
    }
    if capacity == 1 {
        return "…".into();
    }

    if content.contains('/') && !content.chars().any(char::is_whitespace) {
        let segments: Vec<_> = content
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect();
        if segments.len() > 1 {
            let root = segments[0];
            for index in 1..segments.len() {
                let rooted = path_candidate(Some(root), &segments[index..]);
                if glyph_count(&rooted) <= capacity {
                    return rooted;
                }
            }
            for index in 1..segments.len() {
                let unrooted = path_candidate(None, &segments[index..]);
                if glyph_count(&unrooted) <= capacity {
                    return unrooted;
                }
            }
            let filename = segments.last().expect("path has a filename");
            let suffix: String = filename
                .chars()
                .rev()
                .take(capacity - 1)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            return format!("…{suffix}");
        }
    }

    let prefix: String = content.chars().take(capacity - 1).collect();
    if !content.chars().any(char::is_whitespace) {
        return format!("{prefix}…");
    }
    let complete_words = prefix
        .char_indices()
        .rfind(|(_, character)| character.is_whitespace())
        .map_or("", |(index, _)| prefix[..index].trim_end());
    if complete_words.is_empty() {
        "…".into()
    } else {
        format!("{complete_words}…")
    }
}

fn glyph_index(character: char) -> u32 {
    if character == '…' {
        ELLIPSIS_GLYPH_INDEX
    } else if character.is_ascii() && !character.is_ascii_control() {
        u32::from(character as u8 - FIRST_GLYPH)
    } else {
        u32::from(b'?' - FIRST_GLYPH)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GlyphQuad {
    pub rect: Rect,
    pub uv_min: [f32; 2],
    pub uv_max: [f32; 2],
}

/// A bundled, family-aware glyph atlas rasterized once from pinned OFL IBM Plex
/// Sans and IBM Plex Mono outlines. Layout uses the same retained glyph advances for
/// every frame; there is no browser/system font lookup or per-frame measure.
#[derive(Debug, Clone)]
pub struct GlyphAtlas {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
    metrics: Vec<GlyphMetric>,
}

impl Default for GlyphAtlas {
    fn default() -> Self {
        Self::new()
    }
}

impl GlyphAtlas {
    #[must_use]
    pub fn new() -> Self {
        let width = ATLAS_COLUMNS * GLYPH_PIXELS;
        let height = ATLAS_ROWS * GLYPH_PIXELS;
        let mut pixels = vec![0_u8; (width * height) as usize];
        let faces = [
            Font::from_bytes(IBM_PLEX_SANS_REGULAR, FontSettings::default())
                .expect("bundled IBM Plex Sans Regular font must parse"),
            Font::from_bytes(IBM_PLEX_SANS_MEDIUM, FontSettings::default())
                .expect("bundled IBM Plex Sans Medium font must parse"),
            Font::from_bytes(IBM_PLEX_SANS_SEMIBOLD, FontSettings::default())
                .expect("bundled IBM Plex Sans SemiBold font must parse"),
            Font::from_bytes(IBM_PLEX_MONO_REGULAR, FontSettings::default())
                .expect("bundled IBM Plex Mono Regular font must parse"),
            Font::from_bytes(IBM_PLEX_MONO_SEMIBOLD, FontSettings::default())
                .expect("bundled IBM Plex Mono SemiBold font must parse"),
        ];
        let mut metrics = vec![GlyphMetric::default(); (FACE_COUNT * 96) as usize];
        for face in [
            FontFace::SansRegular,
            FontFace::SansMedium,
            FontFace::SansSemibold,
            FontFace::MonoRegular,
            FontFace::MonoSemibold,
        ] {
            let font = &faces[face as usize];
            for slot in 0..96_u32 {
                let character = if slot == ELLIPSIS_GLYPH_INDEX {
                    '…'
                } else {
                    char::from(FIRST_GLYPH + slot as u8)
                };
                let (source_metrics, source_bitmap) = font.rasterize(character, RASTER_SIZE);
                let origin_x = (slot % ATLAS_COLUMNS) * GLYPH_PIXELS + GLYPH_PADDING;
                let origin_y =
                    (face.atlas_row_offset() + slot / ATLAS_COLUMNS) * GLYPH_PIXELS + GLYPH_PADDING;
                let draw_width = source_metrics
                    .width
                    .min((GLYPH_PIXELS - GLYPH_PADDING * 2) as usize)
                    as u32;
                let draw_height = source_metrics
                    .height
                    .min((GLYPH_PIXELS - GLYPH_PADDING * 2) as usize)
                    as u32;
                for y in 0..draw_height {
                    for x in 0..draw_width {
                        pixels[((origin_y + y) * width + origin_x + x) as usize] =
                            source_bitmap[y as usize * source_metrics.width + x as usize];
                    }
                }
                metrics[(face as u32 * 96 + slot) as usize] = GlyphMetric {
                    width: draw_width,
                    height: draw_height,
                    xmin: source_metrics.xmin,
                    ymin: source_metrics.ymin,
                    advance: source_metrics.advance_width,
                    atlas_x: origin_x,
                    atlas_y: origin_y,
                };
            }
        }
        Self {
            width,
            height,
            pixels,
            metrics,
        }
    }

    #[must_use]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[must_use]
    pub fn height(&self) -> u32 {
        self.height
    }

    #[must_use]
    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }

    #[must_use]
    pub fn layout(
        &self,
        content: &str,
        position: Vec2,
        max_width: f64,
        font_family: &str,
        font_size: f64,
        align: TextAlign,
    ) -> Vec<GlyphQuad> {
        let face = FontFace::from_family(font_family);
        let scale = font_size / f64::from(RASTER_SIZE);
        let text_width = |value: &str| {
            value
                .chars()
                .map(|character| {
                    let slot = glyph_index(character);
                    f64::from(self.metrics[(face as u32 * 96 + slot) as usize].advance) * scale
                })
                .sum::<f64>()
        };
        let mut display = content.to_owned();
        if text_width(&display) > max_width {
            for capacity in (1..glyph_count(content)).rev() {
                let candidate = fit_text_content(content, capacity);
                if text_width(&candidate) <= max_width {
                    display = candidate;
                    break;
                }
            }
        }
        let characters: Vec<_> = display.chars().collect();
        let line_width = text_width(&display);
        let start_x = match align {
            TextAlign::Start => position.x,
            TextAlign::Center => position.x - line_width / 2.0,
            TextAlign::End => position.x - line_width,
        };
        let mut pen_x = start_x;
        characters
            .into_iter()
            .map(|character| {
                let glyph_index = glyph_index(character);
                let metric = self.metrics[(face as u32 * 96 + glyph_index) as usize];
                let uv_min = [
                    metric.atlas_x as f32 / self.width as f32,
                    metric.atlas_y as f32 / self.height as f32,
                ];
                let uv_max = [
                    (metric.atlas_x + metric.width) as f32 / self.width as f32,
                    (metric.atlas_y + metric.height) as f32 / self.height as f32,
                ];
                let quad = GlyphQuad {
                    rect: Rect::new(
                        pen_x + f64::from(metric.xmin) * scale,
                        position.y - f64::from(metric.height as i32 + metric.ymin) * scale,
                        f64::from(metric.width) * scale,
                        f64::from(metric.height) * scale,
                    ),
                    uv_min,
                    uv_max,
                };
                pen_x += f64::from(metric.advance) * scale;
                quad
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "metric-table generation helper"]
    fn print_compiler_advance_tables() {
        for (name, bytes) in [
            ("sansRegular", IBM_PLEX_SANS_REGULAR),
            ("sansMedium", IBM_PLEX_SANS_MEDIUM),
            ("sansSemibold", IBM_PLEX_SANS_SEMIBOLD),
            ("monoRegular", IBM_PLEX_MONO_REGULAR),
            ("monoSemibold", IBM_PLEX_MONO_SEMIBOLD),
        ] {
            let font = Font::from_bytes(bytes, FontSettings::default()).expect("font must parse");
            let values = (0..96_u32)
                .map(|slot| {
                    let character = if slot == ELLIPSIS_GLYPH_INDEX {
                        '…'
                    } else {
                        char::from(FIRST_GLYPH + slot as u8)
                    };
                    font.rasterize(character, RASTER_SIZE).0.advance_width / RASTER_SIZE
                })
                .collect::<Vec<_>>();
            println!("{name}: {values:?}");
        }
    }

    #[test]
    fn bundled_atlas_contains_visible_pixels() {
        let atlas = GlyphAtlas::new();
        assert_eq!(atlas.width(), 1024);
        assert_eq!(atlas.height(), 1920);
        assert!(atlas.pixels().contains(&255));
    }

    #[test]
    fn layout_respects_width_and_alignment() {
        let atlas = GlyphAtlas::new();
        let glyphs = atlas.layout(
            "Architecture",
            Vec2::new(100.0, 40.0),
            30.0,
            "IBM Plex Sans",
            10.0,
            TextAlign::Center,
        );
        assert!(glyphs.len() >= 4);
        assert!(glyphs[0].rect.x < 100.0);
    }

    #[test]
    fn display_fitting_is_unicode_safe_and_matches_compiler_golden_cases() {
        assert_eq!(
            fit_text_content("Über façade compiler pipeline", 14),
            "Über façade…"
        );
        assert_eq!(fit_text_content("unbreakable", 6), "unbre…");
        assert_eq!(fit_text_content("architecture", 0), "");
        assert_eq!(fit_text_content("architecture", 1), "…");
        assert_eq!(fit_text_content("architecture", 2), "a…");
        assert_eq!(
            fit_text_content("packages/architecture/src/normalized.ts", 25),
            "packages/…/normalized.ts"
        );
        assert_eq!(
            fit_text_content("packages/architecture/src/normalized.ts", 20),
            "…/src/normalized.ts"
        );
        assert_eq!(
            fit_text_content("packages/architecture/src/normalized.ts", 8),
            "…ized.ts"
        );
        assert_eq!(
            fit_text_content("@fontsource/ibm-plex-sans", 16),
            "…/ibm-plex-sans"
        );
    }

    #[test]
    fn ellipsis_has_a_dedicated_visible_atlas_glyph() {
        let atlas = GlyphAtlas::new();
        let glyphs = atlas.layout(
            "A very long label",
            Vec2::new(0.0, 10.0),
            12.5,
            "IBM Plex Sans",
            10.0,
            TextAlign::Start,
        );
        assert_eq!(glyphs.len(), 1);
        let origin_x = 15 * GLYPH_PIXELS + GLYPH_PADDING;
        let origin_y = 5 * GLYPH_PIXELS + GLYPH_PADDING;
        assert_eq!(
            glyphs[0].uv_min,
            [
                origin_x as f32 / atlas.width as f32,
                origin_y as f32 / atlas.height as f32
            ]
        );
        let metric = atlas.metrics[ELLIPSIS_GLYPH_INDEX as usize];
        assert!((0..metric.height).any(|y| (0..metric.width).any(|x| {
            atlas.pixels[((metric.atlas_y + y) * atlas.width + metric.atlas_x + x) as usize] > 0
        })));
    }
}
