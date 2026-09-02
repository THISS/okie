use atlas_engine::{ProtocolFrame, Rect, Vec2};
use atlas_protocol::{ArrowHead, Primitive, SceneSnapshot, Stroke};
use bytemuck::{Pod, Zeroable};

use crate::{GlyphAtlas, GlyphQuad};

#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct Vertex {
    pub position: [f32; 2],
    pub color: [f32; 4],
    pub uv: [f32; 2],
    pub glyph: f32,
    pub lod_slot: f32,
    /// CSS-pixel offset from `position` after the world anchor is projected.
    /// Paths and flow particles use this to remain legible under semantic zoom.
    pub screen_offset: [f32; 2],
    /// Authored world-space tangent used to place dynamic arrow bases.
    pub screen_tangent: [f32; 2],
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable, PartialEq)]
pub struct VertexStyle {
    pub opacity_emphasis_override: [f32; 4],
    pub override_color: [f32; 4],
    pub transform: [f32; 4],
    pub clip: [f32; 4],
}

impl VertexStyle {
    pub const ATTRIBUTES: [wgpu::VertexAttribute; 4] =
        wgpu::vertex_attr_array![5 => Float32x4, 6 => Float32x4, 7 => Float32x4, 8 => Float32x4];

    #[must_use]
    pub fn layout() -> wgpu::VertexBufferLayout<'static> {
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Self>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &Self::ATTRIBUTES,
        }
    }

    fn new(
        opacity: f32,
        emphasis: f32,
        color: Option<[f32; 4]>,
        transform: [f32; 4],
        clip: [f32; 4],
    ) -> Self {
        Self {
            opacity_emphasis_override: [
                opacity.clamp(0.0, 1.0),
                emphasis.max(0.0),
                f32::from(color.is_some()),
                0.0,
            ],
            override_color: color.unwrap_or([0.0; 4]),
            transform,
            clip,
        }
    }

    #[must_use]
    pub fn visible() -> Self {
        Self::new(1.0, 0.0, None, [1.0, 1.0, 0.0, 0.0], [0.0; 4])
    }

    #[must_use]
    pub fn hidden() -> Self {
        Self::new(0.0, 0.0, None, [1.0, 1.0, 0.0, 0.0], [0.0; 4])
    }
}

impl Vertex {
    pub const ATTRIBUTES: [wgpu::VertexAttribute; 7] = wgpu::vertex_attr_array![
        0 => Float32x2,
        1 => Float32x4,
        2 => Float32x2,
        3 => Float32,
        4 => Float32,
        9 => Float32x2,
        10 => Float32x2,
    ];

    #[must_use]
    pub fn layout() -> wgpu::VertexBufferLayout<'static> {
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Self>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &Self::ATTRIBUTES,
        }
    }
}

const PATH_CORNER_RADIUS_PX: f64 = 6.0;
const PATH_CORNER_SAMPLES: usize = 4;
const PATH_JOIN_SEGMENTS: usize = 8;
const FLOW_PARTICLE_RADIUS_PX: f64 = 3.5;
const FLOW_PARTICLE_SEGMENTS: usize = 12;
const FLOW_PARTICLE_COLOR: [f32; 4] = [0.851, 1.0, 0.439, 1.0];
// Ten chords per quarter circle keep the largest authored owner shell below
// 0.18 CSS px of chord error at the supported 32x camera limit. This remains
// fixed retained geometry: camera-only frames never retessellate the outline.
const ROUNDED_RECT_SAMPLES_PER_CORNER: usize = 11;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MeshStats {
    pub path_vertices: u32,
    pub object_vertices: u32,
    pub text_primitives_deferred: u32,
    pub icon_primitives_deferred: u32,
    pub glyph_quads: u32,
}

#[derive(Debug, Clone, Default)]
pub struct GpuMesh {
    pub vertices: Vec<Vertex>,
    /// Paths occupy `[0, path_vertex_count)` and objects follow them, allowing
    /// deterministic two-pass ordering without separate buffers.
    pub path_vertex_count: u32,
    pub stats: MeshStats,
    pub style_spans: Vec<StyleSpan>,
    pub object_style_spans: Vec<Vec<Vec<usize>>>,
    pub path_style_spans: Vec<Vec<usize>>,
}

#[derive(Debug, Clone, Copy)]
pub struct StyleSpan {
    pub start: usize,
    pub end: usize,
    pub target: StyleTarget,
    pub text: bool,
    /// Text and Icon primitives whose opacity can differ from object chrome.
    pub content: bool,
}

#[derive(Debug, Clone, Copy)]
pub enum StyleTarget {
    Object {
        object_index: usize,
        representation_index: usize,
    },
    Path {
        path_index: usize,
    },
}

#[must_use]
pub fn build_mesh(snapshot: &SceneSnapshot, glyph_atlas: &GlyphAtlas) -> GpuMesh {
    let mut builder = MeshBuilder::with_capacity(
        snapshot.paths.len().saturating_mul(12) + snapshot.objects.len().saturating_mul(192),
    );
    let mut style_spans = Vec::with_capacity(snapshot.paths.len() + snapshot.objects.len() * 4);
    let mut path_style_spans = vec![Vec::new(); snapshot.paths.len()];
    let mut object_style_spans: Vec<Vec<Vec<usize>>> = snapshot
        .objects
        .iter()
        .map(|object| vec![Vec::new(); object.representations.len()])
        .collect();
    builder.lod_slot = -1.0;
    for (path_index, path) in snapshot.paths.iter().enumerate() {
        let start = builder.vertices.len();
        let mut color = path.stroke;
        if path.optional {
            color[3] *= 0.58;
        }
        let points: Vec<_> = path
            .points
            .iter()
            .map(|point| Vec2::new(f64::from(point.x), f64::from(point.y)))
            .collect();
        let route = rounded_screen_path(&points);
        let source_arrow = (path.arrow == ArrowHead::Both)
            .then(|| arrow_endpoint(points.get(1).copied()?, points.first().copied()?))
            .flatten();
        let target_arrow = (path.arrow != ArrowHead::None)
            .then(|| {
                arrow_endpoint(
                    points.get(points.len().checked_sub(2)?).copied()?,
                    points.last().copied()?,
                )
            })
            .flatten();
        // Compiled C4 bands historically normalized widths by their focus
        // zoom. One CSS pixel is the readability floor for the retained GPU
        // path, while aggregate widths above that remain authored values.
        builder.screen_path(
            &route,
            f64::from(path.width).max(1.0),
            color,
            source_arrow,
            target_arrow,
        );
        if let Some(arrow) = target_arrow {
            builder.arrow_head(arrow, color);
        }
        if let Some(arrow) = source_arrow {
            builder.arrow_head(arrow, color);
        }
        let span_index = style_spans.len();
        style_spans.push(StyleSpan {
            start,
            end: builder.vertices.len(),
            target: StyleTarget::Path { path_index },
            text: false,
            content: false,
        });
        path_style_spans[path_index].push(span_index);
    }
    let path_vertex_count = builder.vertices.len() as u32;

    let mut object_indices: Vec<_> = (0..snapshot.objects.len()).collect();
    object_indices.sort_by(|left, right| {
        let left_object = &snapshot.objects[*left];
        let right_object = &snapshot.objects[*right];
        left_object
            .z_index
            .cmp(&right_object.z_index)
            .then_with(|| left_object.id.cmp(&right_object.id))
    });
    for object_index in object_indices {
        let object = &snapshot.objects[object_index];
        let managed_lod = (2..=4).contains(&object.representations.len());
        for (representation_index, representation) in object.representations.iter().enumerate() {
            builder.lod_slot = if managed_lod {
                representation_index as f32
            } else {
                -1.0
            };
            for primitive in &representation.primitives {
                let start = builder.vertices.len();
                match primitive {
                    Primitive::RoundedRect {
                        rect,
                        radius,
                        fill,
                        stroke,
                    } => {
                        let color = *fill;
                        let rect = protocol_rect(*rect);
                        builder.rounded_rect(rect, f64::from(*radius), color);
                        if let Some(stroke) = stroke {
                            builder.rounded_rect_stroke(
                                rect,
                                f64::from(*radius),
                                protocol_stroke(*stroke),
                            );
                        }
                    }
                    Primitive::Circle {
                        center,
                        radius,
                        fill,
                        stroke,
                    } => {
                        let center = Vec2::new(f64::from(center.x), f64::from(center.y));
                        builder.circle(center, f64::from(*radius), *fill, 24);
                        if let Some(stroke) = stroke {
                            builder.circle_stroke(
                                center,
                                f64::from(*radius),
                                protocol_stroke(*stroke),
                                24,
                            );
                        }
                    }
                    Primitive::Text {
                        position,
                        max_width,
                        content,
                        font_family,
                        font_size,
                        color,
                        align,
                        ..
                    } => {
                        let color = *color;
                        for glyph in glyph_atlas.layout(
                            content,
                            Vec2::new(f64::from(position.x), f64::from(position.y)),
                            f64::from(*max_width),
                            font_family,
                            f64::from(*font_size),
                            *align,
                        ) {
                            builder.glyph_quad(glyph, color);
                        }
                    }
                    Primitive::Icon { .. } => builder.stats.icon_primitives_deferred += 1,
                }
                let span_index = style_spans.len();
                style_spans.push(StyleSpan {
                    start,
                    end: builder.vertices.len(),
                    target: StyleTarget::Object {
                        object_index,
                        representation_index,
                    },
                    text: matches!(primitive, Primitive::Text { .. }),
                    content: matches!(primitive, Primitive::Text { .. } | Primitive::Icon { .. }),
                });
                object_style_spans[object_index][representation_index].push(span_index);
            }
        }
    }

    builder.stats.path_vertices = path_vertex_count;
    builder.stats.object_vertices = builder.vertices.len() as u32 - path_vertex_count;
    GpuMesh {
        vertices: builder.vertices,
        path_vertex_count,
        stats: builder.stats,
        style_spans,
        object_style_spans,
        path_style_spans,
    }
}

/// Builds the small dynamic visual-state stream. Positions/base colors remain
/// in the retained static mesh while LOD, timelines and visibility change.
#[must_use]
pub fn build_style_vertices(mesh: &GpuMesh, frame: &ProtocolFrame) -> Vec<VertexStyle> {
    let mut styles = vec![VertexStyle::hidden(); mesh.vertices.len()];
    let stream = build_active_mesh_stream(mesh, frame);
    for (span_index, style) in stream.span_styles.into_iter().enumerate() {
        let Some(style) = style else {
            continue;
        };
        let span = &mesh.style_spans[span_index];
        styles[span.start..span.end].fill(style);
    }
    styles
}

#[derive(Debug, Clone, Default)]
pub struct ActiveMeshStream {
    pub indices: Vec<u32>,
    pub path_index_count: u32,
    pub span_styles: Vec<Option<VertexStyle>>,
    pub partition_total: u32,
    pub partition_active: u32,
    pub resident_object_count: u32,
    pub resident_path_count: u32,
}

/// Collapses resident per-object handoff weights into four representation-slot
/// maxima. The shader applies these compact weights globally; objects whose
/// authored LOD ranges diverge are corrected by a sparse per-span style ratio.
pub(crate) fn lod_uniform_weights(mesh: &GpuMesh, frame: &ProtocolFrame) -> [f32; 4] {
    let mut weights = [0.0_f32; 4];
    let mut managed_lod_present = false;
    for draw in &frame.objects {
        let managed_lod = mesh
            .object_style_spans
            .get(draw.object_index)
            .is_some_and(|representations| (2..=4).contains(&representations.len()));
        if !managed_lod {
            continue;
        }
        managed_lod_present = true;
        if let Some(weight) = weights.get_mut(draw.representation_index) {
            *weight = weight.max(draw.lod_opacity);
        }
    }
    if managed_lod_present {
        weights
    } else {
        [1.0; 4]
    }
}

/// Compacts only resident, non-zero-opacity primitive ranges into a small
/// dynamic index stream. The indices reference the immutable full-scene mesh;
/// camera/LOD/filter changes therefore never rewrite static vertex geometry.
#[must_use]
pub fn build_active_mesh_stream(mesh: &GpuMesh, frame: &ProtocolFrame) -> ActiveMeshStream {
    use std::collections::{HashMap, HashSet};

    let lod_uniform_weights = lod_uniform_weights(mesh, frame);
    let mut dominant = HashMap::<usize, (usize, f32)>::new();
    for draw in &frame.objects {
        dominant
            .entry(draw.object_index)
            .and_modify(|current| {
                if draw.content_opacity > current.1 {
                    *current = (draw.representation_index, draw.content_opacity);
                }
            })
            .or_insert((draw.representation_index, draw.content_opacity));
    }
    let mut selected_spans = Vec::<(usize, VertexStyle)>::new();
    let mut resident_objects = HashSet::new();
    let mut resident_paths = 0_u32;
    for draw in &frame.paths {
        if !draw.resident || draw.opacity <= 0.001 {
            continue;
        }
        resident_paths += 1;
        let style = VertexStyle::new(
            draw.opacity,
            draw.emphasis,
            draw.color_override,
            draw.transform,
            draw.clip,
        );
        for span_index in mesh
            .path_style_spans
            .get(draw.path_index)
            .into_iter()
            .flatten()
        {
            selected_spans.push((*span_index, style));
        }
    }
    for draw in &frame.objects {
        if !draw.resident {
            continue;
        }
        let representations = mesh.object_style_spans.get(draw.object_index);
        let managed_lod = representations.is_some_and(|value| (2..=4).contains(&value.len()));
        let active = if managed_lod {
            draw.lod_opacity > 0.001
        } else {
            draw.opacity > 0.001
        };
        if !active {
            continue;
        }
        resident_objects.insert(draw.object_index);
        let opacity = if managed_lod {
            let uniform_weight = lod_uniform_weights[draw.representation_index];
            if uniform_weight > f32::EPSILON {
                draw.base_opacity * (draw.lod_opacity / uniform_weight)
            } else {
                0.0
            }
        } else {
            draw.opacity
        };
        let style = VertexStyle::new(opacity, draw.emphasis, None, draw.transform, draw.clip);
        let content_opacity = if managed_lod {
            let uniform_weight = lod_uniform_weights[draw.representation_index];
            if uniform_weight > f32::EPSILON {
                draw.content_opacity / uniform_weight
            } else {
                0.0
            }
        } else {
            draw.content_opacity
        };
        let content_style = VertexStyle::new(
            content_opacity,
            draw.emphasis,
            None,
            draw.transform,
            draw.clip,
        );
        let text_owner = dominant
            .get(&draw.object_index)
            .is_some_and(|(representation, _)| *representation == draw.representation_index);
        for span_index in representations
            .and_then(|value| value.get(draw.representation_index))
            .into_iter()
            .flatten()
        {
            let span = &mesh.style_spans[*span_index];
            if !span.content {
                selected_spans.push((*span_index, style));
            } else if text_owner {
                selected_spans.push((*span_index, content_style));
            }
        }
    }
    selected_spans.sort_unstable_by_key(|(span_index, _)| *span_index);
    let mut stream = ActiveMeshStream {
        indices: Vec::new(),
        path_index_count: 0,
        span_styles: vec![None; mesh.style_spans.len()],
        partition_total: mesh.style_spans.len() as u32,
        partition_active: selected_spans.len() as u32,
        resident_object_count: resident_objects.len() as u32,
        resident_path_count: resident_paths,
    };
    for (span_index, style) in selected_spans {
        let span = &mesh.style_spans[span_index];
        stream.span_styles[span_index] = Some(style);
        stream
            .indices
            .extend((span.start..span.end).map(|index| index as u32));
        if matches!(span.target, StyleTarget::Path { .. }) {
            stream.path_index_count = stream.indices.len() as u32;
        }
    }
    stream
}

/// Builds only the small animated flow-particle stream. Static path/object
/// geometry remains retained while timeline position advances.
pub fn build_flow_vertices(
    snapshot: &SceneSnapshot,
    frame: &ProtocolFrame,
    mut vertices: Vec<Vertex>,
) -> Vec<Vertex> {
    vertices.clear();
    let mut builder = MeshBuilder {
        vertices,
        stats: MeshStats::default(),
        lod_slot: -1.0,
    };
    for draw in &frame.paths {
        if draw.flow_phase <= 0.0 || !draw.resident || draw.opacity <= 0.001 {
            continue;
        }
        let path = &snapshot.paths[draw.path_index];
        if let Some(point) = point_along_screen_path(path, draw.flow_phase) {
            let point = ScreenPathPoint::new(
                Vec2::new(
                    point.anchor.x * f64::from(draw.transform[0]) + f64::from(draw.transform[2]),
                    point.anchor.y * f64::from(draw.transform[1]) + f64::from(draw.transform[3]),
                ),
                point.offset,
            );
            if draw.clip[2] > 0.0
                && draw.clip[3] > 0.0
                && (point.anchor.x < f64::from(draw.clip[0])
                    || point.anchor.y < f64::from(draw.clip[1])
                    || point.anchor.x > f64::from(draw.clip[0] + draw.clip[2])
                    || point.anchor.y > f64::from(draw.clip[1] + draw.clip[3]))
            {
                continue;
            }
            builder.screen_circle(
                point,
                FLOW_PARTICLE_RADIUS_PX,
                emphasized_color(FLOW_PARTICLE_COLOR, draw.opacity, 0.0),
                FLOW_PARTICLE_SEGMENTS,
            );
        }
    }
    builder.vertices
}

#[derive(Debug, Clone, Copy)]
struct RenderStroke {
    color: [f32; 4],
    width_world: f64,
}

fn protocol_stroke(stroke: Stroke) -> RenderStroke {
    RenderStroke {
        color: stroke.color,
        width_world: f64::from(stroke.width),
    }
}

fn protocol_rect(rect: atlas_protocol::Rect) -> Rect {
    Rect::new(
        f64::from(rect.x),
        f64::from(rect.y),
        f64::from(rect.width),
        f64::from(rect.height),
    )
}

fn emphasized_color(mut color: [f32; 4], opacity: f32, emphasis: f32) -> [f32; 4] {
    let amount = emphasis.clamp(0.0, 1.0) * 0.28;
    for channel in &mut color[..3] {
        *channel += (1.0 - *channel) * amount;
    }
    color[3] *= opacity.clamp(0.0, 1.0);
    color
}

fn point_along_screen_path(
    path: &atlas_protocol::ScenePath,
    phase: f32,
) -> Option<ScreenPathPoint> {
    let points: Vec<_> = path
        .points
        .iter()
        .map(|point| Vec2::new(f64::from(point.x), f64::from(point.y)))
        .collect();
    let route = rounded_screen_path(&points);
    let mut total = 0.0_f64;
    let lengths: Vec<_> = route
        .windows(2)
        .map(|segment| {
            let length = segment[0].logical().distance(segment[1].logical());
            total += length;
            length
        })
        .collect();
    if total <= f64::EPSILON {
        return None;
    }
    let mut remaining = total * f64::from(phase.clamp(0.0, 1.0));
    for (segment, length) in route.windows(2).zip(lengths) {
        if remaining <= length {
            let amount = remaining / length.max(f64::EPSILON);
            return Some(ScreenPathPoint::new(
                segment[0].anchor.lerp(segment[1].anchor, amount),
                segment[0].offset.lerp(segment[1].offset, amount),
            ));
        }
        remaining -= length;
    }
    route.last().copied()
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ScreenPathPoint {
    anchor: Vec2,
    offset: Vec2,
}

impl ScreenPathPoint {
    const fn new(anchor: Vec2, offset: Vec2) -> Self {
        Self { anchor, offset }
    }

    fn logical(self) -> Vec2 {
        self.anchor + self.offset
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ArrowEndpoint {
    tip: Vec2,
    tangent: Vec2,
    half_segment_world: f64,
}

fn normalized(vector: Vec2) -> Option<Vec2> {
    let length = vector.distance(Vec2::ZERO);
    (length > f64::EPSILON).then(|| vector * (1.0 / length))
}

fn arrow_endpoint(from: Vec2, to: Vec2) -> Option<ArrowEndpoint> {
    let delta = to - from;
    let length = delta.distance(Vec2::ZERO);
    Some(ArrowEndpoint {
        tip: to,
        tangent: normalized(delta)?,
        half_segment_world: length * 0.5,
    })
}

/// Converts hard authored corners to render-only quadratic samples. World
/// anchors remain the protocol vertices; their offsets are CSS pixels, so the
/// bend stays smooth and compact at every semantic zoom level.
fn rounded_screen_path(points: &[Vec2]) -> Vec<ScreenPathPoint> {
    let points: Vec<_> = points
        .iter()
        .copied()
        .fold(Vec::new(), |mut unique, point| {
            if unique.last().is_none_or(|last| *last != point) {
                unique.push(point);
            }
            unique
        });
    if points.len() < 3 {
        return points
            .into_iter()
            .map(|point| ScreenPathPoint::new(point, Vec2::ZERO))
            .collect();
    }
    let mut rounded = Vec::with_capacity(points.len() * (PATH_CORNER_SAMPLES + 1));
    rounded.push(ScreenPathPoint::new(points[0], Vec2::ZERO));
    for window in points.windows(3) {
        let previous = window[0];
        let corner = window[1];
        let next = window[2];
        let Some(incoming) = normalized(corner - previous) else {
            continue;
        };
        let Some(outgoing) = normalized(next - corner) else {
            continue;
        };
        let cross = incoming.x * outgoing.y - incoming.y * outgoing.x;
        let dot = incoming.x * outgoing.x + incoming.y * outgoing.y;
        if cross.abs() <= 1e-6 || dot.abs() >= 1.0 - 1e-6 {
            rounded.push(ScreenPathPoint::new(corner, Vec2::ZERO));
            continue;
        }
        let entry = incoming * -PATH_CORNER_RADIUS_PX;
        let exit = outgoing * PATH_CORNER_RADIUS_PX;
        for sample in 0..=PATH_CORNER_SAMPLES {
            let amount = sample as f64 / PATH_CORNER_SAMPLES as f64;
            let inverse = 1.0 - amount;
            let offset = entry * inverse.powi(2) + exit * amount.powi(2);
            rounded.push(ScreenPathPoint::new(corner, offset));
        }
    }
    rounded.push(ScreenPathPoint::new(
        *points.last().expect("non-empty path"),
        Vec2::ZERO,
    ));
    rounded
}

struct MeshBuilder {
    vertices: Vec<Vertex>,
    stats: MeshStats,
    lod_slot: f32,
}

impl MeshBuilder {
    fn with_capacity(capacity: usize) -> Self {
        Self {
            vertices: Vec::with_capacity(capacity),
            stats: MeshStats::default(),
            lod_slot: -1.0,
        }
    }

    fn vertex(&self, world: Vec2, color: [f32; 4]) -> Vertex {
        Vertex {
            position: [world.x as f32, world.y as f32],
            color,
            uv: [0.0, 0.0],
            glyph: 0.0,
            lod_slot: self.lod_slot,
            screen_offset: [0.0; 2],
            screen_tangent: [0.0; 2],
        }
    }

    fn glyph_vertex(&self, world: Vec2, color: [f32; 4], uv: [f32; 2]) -> Vertex {
        Vertex {
            position: [world.x as f32, world.y as f32],
            color,
            uv,
            glyph: 1.0,
            lod_slot: self.lod_slot,
            screen_offset: [0.0; 2],
            screen_tangent: [0.0; 2],
        }
    }

    fn screen_vertex(&self, point: ScreenPathPoint, offset: Vec2, color: [f32; 4]) -> Vertex {
        Vertex {
            position: [point.anchor.x as f32, point.anchor.y as f32],
            color,
            uv: [0.0; 2],
            glyph: -2.0,
            lod_slot: self.lod_slot,
            screen_offset: [
                (point.offset.x + offset.x) as f32,
                (point.offset.y + offset.y) as f32,
            ],
            screen_tangent: [0.0; 2],
        }
    }

    fn arrow_vertex(&self, arrow: ArrowEndpoint, local_offset: Vec2, color: [f32; 4]) -> Vertex {
        Vertex {
            position: [arrow.tip.x as f32, arrow.tip.y as f32],
            color,
            // Non-glyph arrow vertices store half the authored terminal
            // segment here. The shader caps the visible depth at 8 CSS px.
            uv: [arrow.half_segment_world as f32, 0.0],
            glyph: -1.0,
            lod_slot: self.lod_slot,
            screen_offset: [local_offset.x as f32, local_offset.y as f32],
            screen_tangent: [arrow.tangent.x as f32, arrow.tangent.y as f32],
        }
    }

    fn terminal_shaft_vertex(&self, arrow: ArrowEndpoint, offset: Vec2, color: [f32; 4]) -> Vertex {
        Vertex {
            position: [arrow.tip.x as f32, arrow.tip.y as f32],
            color,
            uv: [arrow.half_segment_world as f32, 0.0],
            glyph: -3.0,
            lod_slot: self.lod_slot,
            screen_offset: [offset.x as f32, offset.y as f32],
            screen_tangent: [arrow.tangent.x as f32, arrow.tangent.y as f32],
        }
    }

    fn triangle(&mut self, a: Vec2, b: Vec2, c: Vec2, color: [f32; 4]) {
        self.vertices.push(self.vertex(a, color));
        self.vertices.push(self.vertex(b, color));
        self.vertices.push(self.vertex(c, color));
    }

    fn quad(&mut self, a: Vec2, b: Vec2, c: Vec2, d: Vec2, color: [f32; 4]) {
        self.triangle(a, b, c, color);
        self.triangle(a, c, d, color);
    }

    fn glyph_quad(&mut self, glyph: GlyphQuad, color: [f32; 4]) {
        let min = Vec2::new(glyph.rect.min_x(), glyph.rect.min_y());
        let max = Vec2::new(glyph.rect.max_x(), glyph.rect.max_y());
        let vertices = [
            self.glyph_vertex(min, color, glyph.uv_min),
            self.glyph_vertex(
                Vec2::new(max.x, min.y),
                color,
                [glyph.uv_max[0], glyph.uv_min[1]],
            ),
            self.glyph_vertex(max, color, glyph.uv_max),
            self.glyph_vertex(min, color, glyph.uv_min),
            self.glyph_vertex(max, color, glyph.uv_max),
            self.glyph_vertex(
                Vec2::new(min.x, max.y),
                color,
                [glyph.uv_min[0], glyph.uv_max[1]],
            ),
        ];
        self.vertices.extend(vertices);
        self.stats.glyph_quads += 1;
    }

    fn line(&mut self, from: Vec2, to: Vec2, width_world: f64, color: [f32; 4]) {
        let direction = to - from;
        let length = direction.distance(Vec2::ZERO);
        if length <= f64::EPSILON || width_world <= 0.0 {
            return;
        }
        let half_world = width_world / 2.0;
        let normal = Vec2::new(-direction.y / length, direction.x / length) * half_world;
        self.quad(
            from + normal,
            to + normal,
            to - normal,
            from - normal,
            color,
        );
    }

    fn arrow_head(&mut self, arrow: ArrowEndpoint, color: [f32; 4]) {
        self.vertices
            .push(self.arrow_vertex(arrow, Vec2::ZERO, color));
        self.vertices
            .push(self.arrow_vertex(arrow, Vec2::new(-1.0, 0.55), color));
        self.vertices
            .push(self.arrow_vertex(arrow, Vec2::new(-1.0, -0.55), color));
    }

    fn screen_path(
        &mut self,
        points: &[ScreenPathPoint],
        width_px: f64,
        color: [f32; 4],
        source_arrow: Option<ArrowEndpoint>,
        target_arrow: Option<ArrowEndpoint>,
    ) {
        if points.len() < 2 {
            return;
        }
        let half_width = width_px.max(0.5) * 0.5;
        for (index, segment) in points.windows(2).enumerate() {
            let from = segment[0];
            let to = segment[1];
            let Some(direction) = normalized(to.logical() - from.logical()) else {
                continue;
            };
            let normal = Vec2::new(-direction.y, direction.x) * half_width;
            let from_positive = if index == 0 {
                source_arrow.map_or_else(
                    || self.screen_vertex(from, normal, color),
                    |arrow| self.terminal_shaft_vertex(arrow, normal, color),
                )
            } else {
                self.screen_vertex(from, normal, color)
            };
            let from_negative = if index == 0 {
                source_arrow.map_or_else(
                    || self.screen_vertex(from, normal * -1.0, color),
                    |arrow| self.terminal_shaft_vertex(arrow, normal * -1.0, color),
                )
            } else {
                self.screen_vertex(from, normal * -1.0, color)
            };
            let terminal = index + 1 == points.len() - 1;
            let to_positive = if terminal {
                target_arrow.map_or_else(
                    || self.screen_vertex(to, normal, color),
                    |arrow| self.terminal_shaft_vertex(arrow, normal, color),
                )
            } else {
                self.screen_vertex(to, normal, color)
            };
            let to_negative = if terminal {
                target_arrow.map_or_else(
                    || self.screen_vertex(to, normal * -1.0, color),
                    |arrow| self.terminal_shaft_vertex(arrow, normal * -1.0, color),
                )
            } else {
                self.screen_vertex(to, normal * -1.0, color)
            };
            self.vertices.extend([
                from_positive,
                to_positive,
                to_negative,
                from_positive,
                to_negative,
                from_negative,
            ]);
        }
        // A small retained fan at every sample covers the outer wedge between
        // adjoining quads. This removes single-pixel cracks without requiring
        // camera-dependent mesh rebuilds.
        for point in &points[1..points.len() - 1] {
            self.screen_circle(*point, half_width, color, PATH_JOIN_SEGMENTS);
        }
    }

    fn screen_circle(
        &mut self,
        center: ScreenPathPoint,
        radius: f64,
        color: [f32; 4],
        segments: usize,
    ) {
        let points = circle_points(Vec2::ZERO, radius, segments);
        for index in 0..points.len() {
            self.vertices
                .push(self.screen_vertex(center, Vec2::ZERO, color));
            self.vertices
                .push(self.screen_vertex(center, points[index], color));
            self.vertices.push(self.screen_vertex(
                center,
                points[(index + 1) % points.len()],
                color,
            ));
        }
    }

    fn rounded_rect(&mut self, rect: Rect, radius: f64, color: [f32; 4]) {
        let points = rounded_rect_points(rect, radius, ROUNDED_RECT_SAMPLES_PER_CORNER);
        let center = rect.center();
        for index in 0..points.len() {
            self.triangle(
                center,
                points[index],
                points[(index + 1) % points.len()],
                color,
            );
        }
    }

    fn rounded_rect_stroke(&mut self, rect: Rect, radius: f64, stroke: RenderStroke) {
        let max_half_width = rect.width.max(0.0).min(rect.height.max(0.0)) / 2.0;
        let half_width = (stroke.width_world.max(0.0) / 2.0).min(max_half_width);
        if half_width <= f64::EPSILON {
            return;
        }
        let outer = rounded_rect_points(
            rect.expand(half_width),
            radius + half_width,
            ROUNDED_RECT_SAMPLES_PER_CORNER,
        );
        let inner = rounded_rect_points(
            rect.expand(-half_width),
            (radius - half_width).max(0.0),
            ROUNDED_RECT_SAMPLES_PER_CORNER,
        );
        debug_assert_eq!(outer.len(), inner.len());
        for index in 0..outer.len() {
            let next = (index + 1) % outer.len();
            // A shared closed ring gives every join the same outer and inner
            // vertices. Independent segment quads left wedges and overlaps at
            // the sampled corners, which became spikes under deep zoom.
            self.quad(
                outer[index],
                outer[next],
                inner[next],
                inner[index],
                stroke.color,
            );
        }
    }

    fn circle(&mut self, center: Vec2, radius: f64, color: [f32; 4], segments: usize) {
        let points = circle_points(center, radius, segments);
        for index in 0..points.len() {
            self.triangle(
                center,
                points[index],
                points[(index + 1) % points.len()],
                color,
            );
        }
    }

    fn circle_stroke(&mut self, center: Vec2, radius: f64, stroke: RenderStroke, segments: usize) {
        let points = circle_points(center, radius, segments);
        for index in 0..points.len() {
            self.line(
                points[index],
                points[(index + 1) % points.len()],
                stroke.width_world,
                stroke.color,
            );
        }
    }
}

fn rounded_rect_points(rect: Rect, radius: f64, segments_per_corner: usize) -> Vec<Vec2> {
    let radius = radius.max(0.0).min(rect.width / 2.0).min(rect.height / 2.0);
    let corners = [
        (
            Vec2::new(rect.max_x() - radius, rect.min_y() + radius),
            -90.0_f64,
        ),
        (Vec2::new(rect.max_x() - radius, rect.max_y() - radius), 0.0),
        (
            Vec2::new(rect.min_x() + radius, rect.max_y() - radius),
            90.0,
        ),
        (
            Vec2::new(rect.min_x() + radius, rect.min_y() + radius),
            180.0,
        ),
    ];
    let mut points = Vec::with_capacity(segments_per_corner * 4);
    for (center, start_degrees) in corners {
        for segment in 0..segments_per_corner {
            let amount = segment as f64 / (segments_per_corner - 1).max(1) as f64;
            let radians = (start_degrees + amount * 90.0).to_radians();
            points.push(Vec2::new(
                center.x + radians.cos() * radius,
                center.y + radians.sin() * radius,
            ));
        }
    }
    points
}

fn circle_points(center: Vec2, radius: f64, segments: usize) -> Vec<Vec2> {
    (0..segments.max(3))
        .map(|index| {
            let radians = index as f64 / segments.max(3) as f64 * std::f64::consts::TAU;
            Vec2::new(
                center.x + radians.cos() * radius,
                center.y + radians.sin() * radius,
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use atlas_engine::{
        Camera, CameraLimits, ProjectionObjectOverride, ProjectionOverride, ProtocolEngine,
        RendererBackend, Viewport,
    };

    use super::*;

    #[test]
    fn rounded_rect_tessellation_is_smooth_at_the_supported_max_zoom() {
        // The largest L4 outline is an owner boundary: 20 authored px at a
        // 1.25 presentation scale, normalized by its 13.96 focus zoom.
        let radius_world = 20.0 * 1.25 / 13.96;
        let radius_at_max_zoom = radius_world * 32.0;
        let chord_angle =
            std::f64::consts::FRAC_PI_2 / (ROUNDED_RECT_SAMPLES_PER_CORNER - 1) as f64;
        let chord_error = radius_at_max_zoom * (1.0 - (chord_angle / 2.0).cos());

        assert!(chord_error <= 0.18, "max chord error was {chord_error}");
        let points = rounded_rect_points(
            Rect::new(0.0, 0.0, 200.0, 100.0),
            radius_world,
            ROUNDED_RECT_SAMPLES_PER_CORNER,
        );
        assert_eq!(points.len(), ROUNDED_RECT_SAMPLES_PER_CORNER * 4);
        for index in 0..points.len() {
            assert!(
                points[index].distance(points[(index + 1) % points.len()]) > f64::EPSILON,
                "outline contained a duplicate neighbor at sample {index}"
            );
        }
    }

    #[test]
    fn rounded_rect_stroke_is_one_continuous_authored_width_ring() {
        let rect = Rect::new(0.0, 0.0, 200.0, 100.0);
        let half_width = 0.1;
        let outer = rounded_rect_points(
            rect.expand(half_width),
            20.0 + half_width,
            ROUNDED_RECT_SAMPLES_PER_CORNER,
        );
        let inner = rounded_rect_points(
            rect.expand(-half_width),
            20.0 - half_width,
            ROUNDED_RECT_SAMPLES_PER_CORNER,
        );
        for (outer_point, inner_point) in outer.iter().zip(&inner) {
            assert!((outer_point.distance(*inner_point) - 0.2).abs() < 1e-10);
        }

        let mut builder = MeshBuilder::with_capacity(264);
        builder.rounded_rect_stroke(
            rect,
            20.0,
            RenderStroke {
                color: [1.0; 4],
                width_world: 0.2,
            },
        );

        let segment_count = ROUNDED_RECT_SAMPLES_PER_CORNER * 4;
        assert_eq!(builder.vertices.len(), segment_count * 6);
        for index in 0..segment_count {
            let segment = &builder.vertices[index * 6..index * 6 + 6];
            let next = &builder.vertices[((index + 1) % segment_count) * 6..][..6];
            assert_eq!(segment[1].position, next[0].position);
            assert_eq!(segment[2].position, next[5].position);
        }
        for triangle in builder.vertices.chunks_exact(3) {
            assert!(triangle.iter().all(|vertex| {
                vertex.position[0].is_finite() && vertex.position[1].is_finite()
            }));
            let [a, b, c] = [
                triangle[0].position,
                triangle[1].position,
                triangle[2].position,
            ];
            let twice_area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
            assert!(twice_area.abs() > f32::EPSILON);
        }
        // The old 0.5-world-unit floor would have expanded this to +/-0.25.
        assert!((f64::from(builder.vertices[0].position[1]) + 0.1).abs() < 1e-5);
        assert!((f64::from(builder.vertices[5].position[1]) - 0.1).abs() < 1e-5);
    }

    #[test]
    fn rounded_rect_geometry_growth_is_bounded_and_camera_independent() {
        let mut builder = MeshBuilder::with_capacity(396);
        let rect = Rect::new(0.0, 0.0, 200.0, 100.0);
        builder.rounded_rect(rect, 20.0, [1.0; 4]);
        builder.rounded_rect_stroke(
            rect,
            20.0,
            RenderStroke {
                color: [1.0; 4],
                width_world: 2.0,
            },
        );

        // 44 fill triangles vertices + 44 stroke quads. The former five-sample
        // outline used 180 vertices, so smooth retained geometry adds 216.
        assert_eq!(builder.vertices.len(), 396);
    }

    #[test]
    fn fixture_produces_paths_before_object_geometry() {
        let snapshot: SceneSnapshot =
            serde_json::from_str(include_str!("../../../fixtures/renderer/demo-scene.json"))
                .unwrap();
        let camera = Camera::new(
            Vec2::new(810.0, 450.0),
            0.8,
            Viewport::new(1200.0, 800.0, 1.0),
            CameraLimits::default(),
        );
        let mut engine = ProtocolEngine::try_new(snapshot.clone(), camera).unwrap();
        let _ = engine.prepare_frame(RendererBackend::Headless);
        let mesh = build_mesh(&snapshot, &GlyphAtlas::new());
        assert!(!mesh.vertices.is_empty());
        assert!(mesh.path_vertex_count > 0);
        assert!(mesh.stats.object_vertices > 0);
        assert_eq!(mesh.stats.text_primitives_deferred, 0);
        assert!(mesh.stats.glyph_quads > 0);
        assert_eq!(mesh.vertices.len() % 3, 0);
    }

    #[test]
    fn vertex_layout_keeps_screen_space_attributes_stable() {
        assert_eq!(std::mem::size_of::<Vertex>(), 56);
        assert_eq!(std::mem::offset_of!(Vertex, position), 0);
        assert_eq!(std::mem::offset_of!(Vertex, color), 8);
        assert_eq!(std::mem::offset_of!(Vertex, uv), 24);
        assert_eq!(std::mem::offset_of!(Vertex, glyph), 32);
        assert_eq!(std::mem::offset_of!(Vertex, lod_slot), 36);
        assert_eq!(std::mem::offset_of!(Vertex, screen_offset), 40);
        assert_eq!(std::mem::offset_of!(Vertex, screen_tangent), 48);
        assert_eq!(Vertex::ATTRIBUTES[5].shader_location, 9);
        assert_eq!(Vertex::ATTRIBUTES[5].offset, 40);
        assert_eq!(Vertex::ATTRIBUTES[6].shader_location, 10);
        assert_eq!(Vertex::ATTRIBUTES[6].offset, 48);
    }

    #[test]
    fn arrow_vertices_retain_tip_tangent_and_short_segment_limit() {
        let snapshot: SceneSnapshot =
            serde_json::from_str(include_str!("../../../fixtures/renderer/demo-scene.json"))
                .unwrap();
        let mesh = build_mesh(&snapshot, &GlyphAtlas::new());
        let arrow_vertices: Vec<_> = mesh.vertices[..mesh.path_vertex_count as usize]
            .iter()
            .filter(|vertex| vertex.glyph < -0.5 && vertex.glyph > -1.5)
            .collect();
        let arrow_count: usize = snapshot
            .paths
            .iter()
            .map(|path| match path.arrow {
                ArrowHead::None => 0,
                ArrowHead::End => 1,
                ArrowHead::Both => 2,
            })
            .sum();

        assert_eq!(arrow_vertices.len(), arrow_count * 3);
        for triangle in arrow_vertices.chunks_exact(3) {
            let tip = triangle[0].position;
            assert!(triangle.iter().all(|vertex| vertex.position == tip));
            assert!(triangle.iter().all(|vertex| vertex.uv[0] > 0.0));
            assert!(
                triangle
                    .iter()
                    .all(|vertex| vertex.screen_tangent != [0.0; 2])
            );
            assert_eq!(triangle[0].screen_offset, [0.0, 0.0]);
            assert_eq!(triangle[1].screen_offset, [-1.0, 0.55]);
            assert_eq!(triangle[2].screen_offset, [-1.0, -0.55]);
        }

        let shader = include_str!("shaders/primitives.wgsl");
        assert!(shader.contains("@location(9) screen_offset: vec2<f32>"));
        assert!(shader.contains("@location(10) screen_tangent: vec2<f32>"));
        assert!(shader.contains("arrow_radius_px = min(8.0, terminal_half_screen)"));
        assert!(shader.contains("screen += input.screen_offset - tangent * arrow_radius_px"));
        assert!(shader.contains("zoom < 1.30"));
    }

    #[test]
    fn short_path_arrow_leaves_half_the_terminal_segment_as_shaft() {
        let mut builder = MeshBuilder::with_capacity(3);
        let arrow = arrow_endpoint(Vec2::new(0.0, 0.0), Vec2::new(16.0, 0.0)).unwrap();
        builder.arrow_head(arrow, [1.0; 4]);
        assert!(
            builder
                .vertices
                .iter()
                .all(|vertex| vertex.position == [16.0, 0.0])
        );
        assert!(
            builder
                .vertices
                .iter()
                .all(|vertex| vertex.uv == [8.0, 0.0])
        );
        assert_eq!(builder.vertices[1].screen_offset[0], -1.0);
        assert_eq!(builder.vertices[2].screen_offset[0], -1.0);
    }

    #[test]
    fn orthogonal_corner_uses_six_pixel_quadratic_samples() {
        let route = rounded_screen_path(&[
            Vec2::new(0.0, 0.0),
            Vec2::new(20.0, 0.0),
            Vec2::new(20.0, 20.0),
        ]);
        assert_eq!(route.len(), PATH_CORNER_SAMPLES + 3);
        assert_eq!(
            route[1],
            ScreenPathPoint::new(Vec2::new(20.0, 0.0), Vec2::new(-6.0, 0.0))
        );
        assert_eq!(
            route[3],
            ScreenPathPoint::new(Vec2::new(20.0, 0.0), Vec2::new(-1.5, 1.5))
        );
        assert_eq!(
            route[5],
            ScreenPathPoint::new(Vec2::new(20.0, 0.0), Vec2::new(0.0, 6.0))
        );

        let mut builder = MeshBuilder::with_capacity(128);
        builder.screen_path(&route, 2.0, [1.0; 4], None, None);
        let segment_vertices = (route.len() - 1) * 6;
        let join_vertices = (route.len() - 2) * PATH_JOIN_SEGMENTS * 3;
        assert_eq!(builder.vertices.len(), segment_vertices + join_vertices);
        assert!(builder.vertices.iter().all(|vertex| vertex.glyph == -2.0));
    }

    #[test]
    fn end_arrow_leaves_source_plain_while_both_trims_each_end() {
        let route = rounded_screen_path(&[Vec2::new(0.0, 0.0), Vec2::new(40.0, 0.0)]);
        let source = arrow_endpoint(Vec2::new(40.0, 0.0), Vec2::new(0.0, 0.0)).unwrap();
        let target = arrow_endpoint(Vec2::new(0.0, 0.0), Vec2::new(40.0, 0.0)).unwrap();
        let mut end = MeshBuilder::with_capacity(6);
        end.screen_path(&route, 2.0, [1.0; 4], None, Some(target));
        assert_eq!(
            end.vertices
                .iter()
                .filter(|vertex| vertex.glyph == -3.0)
                .count(),
            3
        );
        assert!(
            end.vertices
                .iter()
                .filter(|vertex| vertex.position == [0.0, 0.0])
                .all(|vertex| vertex.glyph == -2.0)
        );

        let mut both = MeshBuilder::with_capacity(6);
        both.screen_path(&route, 2.0, [1.0; 4], Some(source), Some(target));
        assert_eq!(
            both.vertices
                .iter()
                .filter(|vertex| vertex.glyph == -3.0)
                .count(),
            6
        );
    }

    #[test]
    fn flow_particle_is_lime_and_three_and_a_half_screen_pixels() {
        let snapshot: SceneSnapshot =
            serde_json::from_str(include_str!("../../../fixtures/renderer/demo-scene.json"))
                .unwrap();
        let camera = Camera::new(
            Vec2::new(810.0, 450.0),
            0.8,
            Viewport::new(1200.0, 800.0, 1.0),
            CameraLimits::default(),
        );
        let mut engine = ProtocolEngine::try_new(snapshot.clone(), camera).unwrap();
        let mut frame = engine.prepare_frame(RendererBackend::Headless);
        let draw = frame.paths.first_mut().unwrap();
        draw.resident = true;
        draw.flow_phase = 0.5;
        draw.opacity = 0.72;
        let vertices = build_flow_vertices(&snapshot, &frame, Vec::new());

        assert_eq!(vertices.len(), FLOW_PARTICLE_SEGMENTS * 3);
        assert!(vertices.iter().all(|vertex| vertex.glyph == -2.0));
        assert!(vertices.iter().all(|vertex| {
            (vertex.color[0] - FLOW_PARTICLE_COLOR[0]).abs() <= f32::EPSILON
                && (vertex.color[1] - FLOW_PARTICLE_COLOR[1]).abs() <= f32::EPSILON
                && (vertex.color[2] - FLOW_PARTICLE_COLOR[2]).abs() <= f32::EPSILON
                && (vertex.color[3] - 0.72).abs() <= f32::EPSILON
        }));
        for triangle in vertices.chunks_exact(3) {
            let center = triangle[0].screen_offset;
            for outer in &triangle[1..] {
                let radius = f64::from(outer.screen_offset[0] - center[0])
                    .hypot(f64::from(outer.screen_offset[1] - center[1]));
                assert!((radius - FLOW_PARTICLE_RADIUS_PX).abs() <= 1e-5);
            }
        }
    }

    #[test]
    fn object_draw_order_is_deterministic_by_z_index_then_id() {
        let snapshot: SceneSnapshot =
            serde_json::from_str(include_str!("../../../fixtures/renderer/demo-scene.json"))
                .unwrap();
        let camera = Camera::new(
            Vec2::new(810.0, 450.0),
            0.8,
            Viewport::new(1200.0, 800.0, 1.0),
            CameraLimits::default(),
        );
        let mut engine = ProtocolEngine::try_new(snapshot.clone(), camera).unwrap();
        let _ = engine.prepare_frame(RendererBackend::Headless);
        let first = build_mesh(&snapshot, &GlyphAtlas::new());
        let second = build_mesh(&snapshot, &GlyphAtlas::new());
        assert_eq!(first.vertices.len(), second.vertices.len());
        for (left, right) in first.vertices.iter().zip(&second.vertices) {
            assert_eq!(left.position, right.position);
            assert_eq!(left.color, right.color);
        }
    }

    #[test]
    fn only_the_dominant_lod_representation_owns_text_during_handoff() {
        let snapshot: SceneSnapshot =
            serde_json::from_str(include_str!("../../../fixtures/renderer/demo-scene.json"))
                .unwrap();
        let camera = Camera::new(
            Vec2::new(810.0, 450.0),
            0.4,
            Viewport::new(1200.0, 800.0, 1.0),
            CameraLimits::default(),
        );
        let mut engine = ProtocolEngine::try_new(snapshot.clone(), camera).unwrap();
        let object_index = snapshot
            .objects
            .iter()
            .position(|object| object.id == "visual-node:lineage:system:okie")
            .unwrap();
        engine.tick(0.0);
        let _ = engine.prepare_frame(RendererBackend::Headless);
        let mesh = build_mesh(&snapshot, &GlyphAtlas::new());
        engine.camera_mut().set_zoom(1.44);
        engine.tick(0.0);
        let _ = engine.prepare_frame(RendererBackend::Headless);
        engine.tick(150.0);
        let handoff = engine.prepare_frame(RendererBackend::Headless);
        let styles = build_style_vertices(&mesh, &handoff);
        let dominant_representation_index = handoff
            .objects
            .iter()
            .filter(|draw| draw.object_index == object_index)
            .max_by(|left, right| left.opacity.total_cmp(&right.opacity))
            .map(|draw| draw.representation_index)
            .unwrap();
        assert_ne!(dominant_representation_index, 0);

        let compact_text = mesh
            .style_spans
            .iter()
            .find(|span| {
                span.text
                    && matches!(
                        span.target,
                        StyleTarget::Object {
                            object_index: index,
                            representation_index: 0
                        } if index == object_index
                    )
            })
            .unwrap();
        let detail_text = mesh
            .style_spans
            .iter()
            .find(|span| {
                span.text
                    && matches!(
                        span.target,
                        StyleTarget::Object {
                            object_index: index,
                            representation_index
                        } if index == object_index && representation_index == dominant_representation_index
                    )
            })
            .unwrap();
        assert_eq!(styles[compact_text.start].opacity_emphasis_override[0], 0.0);
        assert!(styles[detail_text.start].opacity_emphasis_override[0] > 0.0);
    }

    #[test]
    fn projection_content_opacity_hides_text_without_hiding_object_chrome() {
        let snapshot: SceneSnapshot =
            serde_json::from_str(include_str!("../../../fixtures/renderer/demo-scene.json"))
                .unwrap();
        let camera = Camera::new(
            Vec2::new(810.0, 450.0),
            0.8,
            Viewport::new(1200.0, 800.0, 1.0),
            CameraLimits::default(),
        );
        let mut engine = ProtocolEngine::try_new(snapshot.clone(), camera).unwrap();
        let object_id = "visual-node:lineage:system:okie";
        engine
            .set_projection_override(Some(ProjectionOverride {
                id: "ancestor-shell-content".into(),
                progress: 1.0,
                objects: vec![ProjectionObjectOverride {
                    object_id: object_id.into(),
                    source_representation_id: Some(format!("{object_id}:context")),
                    target_representation_id: Some(format!("{object_id}:context")),
                    source_opacity: Some(0.32),
                    target_opacity: Some(0.32),
                    source_content_opacity: Some(0.0),
                    target_content_opacity: Some(0.0),
                    ..ProjectionObjectOverride::default()
                }],
                paths: vec![],
                morph: None,
            }))
            .unwrap();
        let frame = engine.prepare_frame(RendererBackend::Headless);
        let object_index = snapshot
            .objects
            .iter()
            .position(|object| object.id == object_id)
            .unwrap();
        let draw = frame
            .objects
            .iter()
            .find(|draw| {
                draw.object_index == object_index
                    && snapshot.objects[object_index].representations[draw.representation_index]
                        .id
                        .ends_with(":context")
            })
            .unwrap();
        assert!((draw.opacity - 0.32).abs() < 0.0001);
        assert_eq!(draw.content_opacity, 0.0);

        let mesh = build_mesh(&snapshot, &GlyphAtlas::new());
        let styles = build_style_vertices(&mesh, &frame);
        let weights = lod_uniform_weights(&mesh, &frame);
        let spans = &mesh.object_style_spans[object_index][draw.representation_index];
        let chrome = spans
            .iter()
            .map(|index| &mesh.style_spans[*index])
            .find(|span| !span.content)
            .unwrap();
        let text = spans
            .iter()
            .map(|index| &mesh.style_spans[*index])
            .find(|span| span.text)
            .unwrap();
        let effective_chrome =
            styles[chrome.start].opacity_emphasis_override[0] * weights[draw.representation_index];
        assert!((effective_chrome - 0.32).abs() < 0.0001);
        assert_eq!(styles[text.start].opacity_emphasis_override[0], 0.0);
    }

    #[test]
    fn compact_lod_uniform_uses_slot_maxima_and_sparse_styles_correct_divergence() {
        let snapshot: SceneSnapshot =
            serde_json::from_str(include_str!("../../../fixtures/renderer/demo-scene.json"))
                .unwrap();
        let camera = Camera::new(
            Vec2::new(810.0, 450.0),
            0.8,
            Viewport::new(1200.0, 800.0, 1.0),
            CameraLimits::default(),
        );
        let mut engine = ProtocolEngine::try_new(snapshot.clone(), camera).unwrap();
        let mut frame = engine.prepare_frame(RendererBackend::Headless);
        let mesh = build_mesh(&snapshot, &GlyphAtlas::new());
        let managed_objects: Vec<_> = frame
            .objects
            .iter()
            .map(|draw| draw.object_index)
            .filter(|object_index| (2..=4).contains(&mesh.object_style_spans[*object_index].len()))
            .fold(Vec::new(), |mut unique, object_index| {
                if !unique.contains(&object_index) {
                    unique.push(object_index);
                }
                unique
            });
        assert!(managed_objects.len() >= 2);
        let first = managed_objects[0];
        let second = managed_objects[1];
        for draw in &mut frame.objects {
            if (2..=4).contains(&mesh.object_style_spans[draw.object_index].len()) {
                draw.lod_opacity = 0.0;
                draw.opacity = 0.0;
            }
            let weight = match (draw.object_index, draw.representation_index) {
                (object, 0) if object == first => 0.25,
                (object, 1) if object == first => 0.75,
                (object, 0) if object == second => 0.60,
                (object, 1) if object == second => 0.40,
                _ => continue,
            };
            draw.lod_opacity = weight;
            draw.opacity = weight * draw.base_opacity;
        }

        let weights = lod_uniform_weights(&mesh, &frame);
        assert_eq!(weights, [0.60, 0.75, 0.0, 0.0]);
        let stream = build_active_mesh_stream(&mesh, &frame);
        let first_shape_span = mesh.object_style_spans[first][0]
            .iter()
            .find(|span_index| !mesh.style_spans[**span_index].text)
            .copied()
            .unwrap();
        let corrected = stream.span_styles[first_shape_span].unwrap();
        assert!((corrected.opacity_emphasis_override[0] - 0.25 / 0.60).abs() < 0.0001);
    }
}
