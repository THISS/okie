struct CameraUniform {
    center_viewport: vec4<f32>,
    zoom_padding: vec4<f32>,
}

@group(0) @binding(0)
var<uniform> camera: CameraUniform;

@group(0) @binding(1)
var glyph_texture: texture_2d<f32>;

@group(0) @binding(2)
var glyph_sampler: sampler;

struct LodUniform {
    weights: vec4<f32>,
}

@group(0) @binding(3)
var<uniform> lod_state: LodUniform;

struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) glyph: f32,
    @location(4) lod_slot: f32,
    @location(9) screen_offset: vec2<f32>,
    @location(10) screen_tangent: vec2<f32>,
    @location(5) opacity_emphasis_override: vec4<f32>,
    @location(6) override_color: vec4<f32>,
    @location(7) transform: vec4<f32>,
    @location(8) world_clip: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) glyph: f32,
    @location(3) opacity_emphasis_override: vec4<f32>,
    @location(4) override_color: vec4<f32>,
    @location(5) world_position: vec2<f32>,
    @location(6) world_clip: vec4<f32>,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let center = camera.center_viewport.xy;
    let viewport = camera.center_viewport.zw;
    let zoom = camera.zoom_padding.x;
    let world_position = input.position * input.transform.xy + input.transform.zw;
    var screen = (world_position - center) * zoom + viewport * 0.5;
    // Negative glyph roles are retained path geometry whose presentation size
    // is measured in CSS pixels. World anchors still receive camera/projection
    // transforms, so semantic morphs do not rebuild the static mesh.
    if input.glyph < -2.5 {
        // Terminal shaft cross-sections share the arrow's dynamic base depth.
        let transformed_tangent = input.screen_tangent * input.transform.xy;
        let tangent_scale = length(transformed_tangent);
        if tangent_scale > 0.000001 {
            let tangent = transformed_tangent / tangent_scale;
            let terminal_half_screen = input.uv.x * tangent_scale * zoom;
            let arrow_radius_px = min(8.0, terminal_half_screen);
            screen += input.screen_offset - tangent * arrow_radius_px;
        }
    } else if input.glyph < -1.5 {
        // Stroke thickness, rounded joins and flow particles are exact pixels.
        screen += input.screen_offset;
    } else if input.glyph < -0.5 {
        // Arrow triangles use local tangent/normal factors in screen_offset.
        // Their tip stays on the authored endpoint; the base consumes no more
        // than half a short terminal segment and is otherwise 8 CSS px deep.
        let transformed_tangent = input.screen_tangent * input.transform.xy;
        let tangent_scale = length(transformed_tangent);
        if tangent_scale > 0.000001 {
            let tangent = transformed_tangent / tangent_scale;
            let normal = vec2<f32>(-tangent.y, tangent.x);
            let terminal_half_screen = input.uv.x * tangent_scale * zoom;
            let arrow_radius_px = min(8.0, terminal_half_screen);
            screen += tangent * input.screen_offset.x * arrow_radius_px
                + normal * input.screen_offset.y * arrow_radius_px;
        }
    }
    let ndc = vec2<f32>(screen.x / viewport.x * 2.0 - 1.0, 1.0 - screen.y / viewport.y * 2.0);
    output.position = vec4<f32>(ndc, 0.0, 1.0);
    output.color = input.color;
    output.uv = input.uv;
    output.glyph = input.glyph;
    var lod_weight = 1.0;
    if input.lod_slot >= 0.0 && input.lod_slot < 4.0 {
        lod_weight = lod_state.weights[u32(input.lod_slot)];
    }
    output.opacity_emphasis_override = vec4<f32>(
        input.opacity_emphasis_override.x * lod_weight,
        input.opacity_emphasis_override.yzw,
    );
    output.override_color = input.override_color;
    output.world_position = world_position;
    output.world_clip = input.world_clip;
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    if input.world_clip.z > 0.0 && input.world_clip.w > 0.0
        && (input.world_position.x < input.world_clip.x
            || input.world_position.y < input.world_clip.y
            || input.world_position.x > input.world_clip.x + input.world_clip.z
            || input.world_position.y > input.world_clip.y + input.world_clip.w) {
        discard;
    }
    var coverage = 1.0;
    if input.glyph > 0.5 {
        coverage = textureSampleLevel(glyph_texture, glyph_sampler, input.uv, 0.0).r;
        // At L1 context zoom, coverage-as-alpha washes 8–12 px titles into the
        // dark atlas. Sharpen the coverage edge so unselected labels keep contrast.
        let zoom = camera.zoom_padding.x;
        if zoom < 1.30 && coverage > 0.01 {
            let t = clamp((1.30 - zoom) / 0.98, 0.0, 1.0);
            let edge = 0.14 * t;
            coverage = clamp((coverage - edge) / max(1.0 - edge * 1.45, 0.2), 0.0, 1.0);
        }
        if coverage < 0.01 {
            discard;
        }
    }
    let use_override = input.opacity_emphasis_override.z;
    let base = mix(input.color, input.override_color, use_override);
    let emphasis = clamp(input.opacity_emphasis_override.y, 0.0, 1.0) * 0.28;
    let emphasized = base.rgb + (vec3<f32>(1.0) - base.rgb) * emphasis;
    return vec4<f32>(emphasized, base.a * input.opacity_emphasis_override.x * coverage);
}
