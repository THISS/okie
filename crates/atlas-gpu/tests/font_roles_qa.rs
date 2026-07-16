use atlas_engine::Vec2;
use atlas_gpu::GlyphAtlas;
use atlas_protocol::TextAlign;

fn repeated_glyph_advance(atlas: &GlyphAtlas, content: &str, family: &str) -> f64 {
    let glyphs = atlas.layout(
        content,
        Vec2::new(0.0, 80.0),
        2_000.0,
        family,
        48.0,
        TextAlign::Start,
    );
    assert!(glyphs.len() >= 2, "font QA sample must produce two glyphs");
    glyphs[1].rect.x - glyphs[0].rect.x
}

#[test]
fn ibm_plex_roles_are_proportional_for_diagrams_and_fixed_for_code() {
    let atlas = GlyphAtlas::new();
    let sans_i = repeated_glyph_advance(&atlas, "iiii", "IBM Plex Sans");
    let sans_w = repeated_glyph_advance(&atlas, "WWWW", "IBM Plex Sans");
    let mono_i = repeated_glyph_advance(&atlas, "iiii", "IBM Plex Mono");
    let mono_w = repeated_glyph_advance(&atlas, "WWWW", "IBM Plex Mono");

    assert!(
        sans_w > sans_i * 2.0,
        "IBM Plex Sans must render visibly proportional advances"
    );
    assert!(
        (mono_w - mono_i).abs() < 0.001,
        "IBM Plex Mono must retain fixed code/path advances"
    );
}
