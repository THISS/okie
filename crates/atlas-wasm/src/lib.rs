//! Stable browser boundary for the Rust atlas renderer.

use serde::Serialize;

use atlas_engine::HitTarget;

#[cfg(target_arch = "wasm32")]
mod browser;

#[cfg(target_arch = "wasm32")]
pub use browser::{WasmAtlasRenderer, create_atlas_renderer};

/// Mirrors the deliberately small frontend `RendererDiagnostics` contract and
/// adds deferred primitive counts useful while GPU text is being implemented.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsPayload {
    pub requested_backend: String,
    pub active_backend: String,
    pub gpu_accelerated: bool,
    pub entity_count: u32,
    pub relation_count: u32,
    pub last_frame_ms: f32,
    pub frame_p50_ms: f32,
    pub frame_p95_ms: f32,
    pub frame_p99_ms: f32,
    pub frame_sample_count: u32,
    pub total_frame_count: u64,
    pub frame_window_includes_initial_build: bool,
    pub message: String,
    pub visible_entities: u32,
    pub visible_relations: u32,
    pub candidate_entities: u32,
    pub candidate_relations: u32,
    pub resident_entities: u32,
    pub resident_relations: u32,
    pub retained_view_reused: bool,
    pub culled_entities: u32,
    pub culled_relations: u32,
    pub draw_calls: u32,
    pub mesh_rebuilt: bool,
    pub mesh_build_ms: f32,
    pub geometry_upload_bytes: u64,
    pub geometry_buffer_uploads: u32,
    pub static_mesh_revision: u64,
    pub static_geometry_upload_bytes: u64,
    pub static_geometry_buffer_uploads: u32,
    pub cumulative_static_geometry_upload_bytes: u64,
    pub cumulative_static_geometry_buffer_uploads: u64,
    pub dynamic_index_upload_bytes: u64,
    pub dynamic_index_buffer_uploads: u32,
    pub cumulative_dynamic_index_upload_bytes: u64,
    pub cumulative_dynamic_index_buffer_uploads: u64,
    pub dynamic_style_upload_bytes: u64,
    pub dynamic_style_buffer_uploads: u32,
    pub cumulative_dynamic_style_upload_bytes: u64,
    pub cumulative_dynamic_style_buffer_uploads: u64,
    pub flow_upload_bytes: u64,
    pub cumulative_flow_upload_bytes: u64,
    pub uniform_upload_bytes: u64,
    pub cumulative_uniform_upload_bytes: u64,
    pub lod_uniform_upload_bytes: u64,
    pub cumulative_lod_uniform_upload_bytes: u64,
    pub resident_partition_total: u32,
    pub resident_partition_active: u32,
    pub resident_partition_drawn: u32,
    pub resident_object_count: u32,
    pub resident_path_count: u32,
    pub partition_cache_hits: u64,
    pub partition_cache_misses: u64,
    pub partition_cache_evictions: u64,
    pub draw_range_count: u32,
    pub glyph_quads: u32,
    pub deferred_text_primitives: u32,
    pub deferred_icon_primitives: u32,
}

#[cfg(any(target_arch = "wasm32", test))]
#[derive(Debug, Clone)]
pub(crate) struct FrameTimeWindow {
    samples: [f32; Self::CAPACITY],
    len: usize,
    cursor: usize,
}

#[cfg(any(target_arch = "wasm32", test))]
impl Default for FrameTimeWindow {
    fn default() -> Self {
        Self {
            samples: [0.0; Self::CAPACITY],
            len: 0,
            cursor: 0,
        }
    }
}

#[cfg(any(target_arch = "wasm32", test))]
impl FrameTimeWindow {
    const CAPACITY: usize = 120;

    pub(crate) fn push(&mut self, value: f32) {
        if !value.is_finite() {
            return;
        }
        self.samples[self.cursor] = value.max(0.0);
        self.cursor = (self.cursor + 1) % Self::CAPACITY;
        self.len = (self.len + 1).min(Self::CAPACITY);
    }

    pub(crate) fn percentile(&self, percentile: f32) -> f32 {
        if self.len == 0 {
            return 0.0;
        }
        let mut sorted = self.samples[..self.len].to_vec();
        sorted.sort_by(f32::total_cmp);
        let index = ((sorted.len() - 1) as f32 * percentile.clamp(0.0, 1.0)).round() as usize;
        sorted[index]
    }

    pub(crate) fn len(&self) -> usize {
        self.len
    }

    pub(crate) fn includes_first_sample(total_sample_count: u64) -> bool {
        total_sample_count > 0 && total_sample_count <= Self::CAPACITY as u64
    }
}

/// Picking is discriminated so relation IDs can never be mistaken for entity
/// IDs by the host inspector.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickPayload {
    pub kind: PickKind,
    pub id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PickKind {
    Entity,
    Relation,
}

/// Shared by the browser facade and native tests so the host-camera ownership
/// boundary cannot regress independently of the engine timeline tests.
#[cfg(any(target_arch = "wasm32", test))]
fn apply_host_camera(engine: &mut atlas_engine::ProtocolEngine, x: f64, y: f64, zoom: f64) {
    engine
        .camera_mut()
        .set_center(atlas_engine::Vec2::new(x, y));
    engine.camera_mut().set_zoom(zoom);
}

impl From<HitTarget> for PickPayload {
    fn from(target: HitTarget) -> Self {
        match target {
            HitTarget::Node(id) => Self {
                kind: PickKind::Entity,
                id,
            },
            HitTarget::Edge(id) => Self {
                kind: PickKind::Relation,
                id,
            },
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[must_use]
pub const fn target_support_message() -> &'static str {
    "atlas-wasm exports its renderer when built for wasm32-unknown-unknown"
}

#[cfg(test)]
mod tests {
    use atlas_engine::{Camera, CameraLimits, ProtocolEngine, RendererBackend, Vec2, Viewport};
    use atlas_protocol::{
        ObjectKeyframeState, PathKeyframeState, SceneSnapshot, Timeline, TimelineKeyframe,
    };

    use super::*;

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn native_build_keeps_a_clear_target_boundary() {
        assert!(target_support_message().contains("wasm32"));
    }

    #[test]
    fn pick_payload_distinguishes_entities_from_relations() {
        let entity =
            serde_json::to_value(PickPayload::from(HitTarget::Node("node".into()))).unwrap();
        let relation =
            serde_json::to_value(PickPayload::from(HitTarget::Edge("path".into()))).unwrap();
        assert_eq!(
            entity,
            serde_json::json!({ "kind": "entity", "id": "node" })
        );
        assert_eq!(
            relation,
            serde_json::json!({ "kind": "relation", "id": "path" })
        );
    }

    #[test]
    fn rolling_frame_percentiles_are_deterministic_and_bounded() {
        let mut samples = FrameTimeWindow::default();
        for value in 1..=200 {
            samples.push(value as f32);
        }
        assert_eq!(samples.len(), 120);
        assert_eq!(samples.percentile(0.5), 141.0);
        assert!(samples.percentile(0.99) >= samples.percentile(0.95));
        assert!(FrameTimeWindow::includes_first_sample(120));
        assert!(!FrameTimeWindow::includes_first_sample(121));
    }

    #[test]
    fn host_camera_preserves_a_playing_wasm_flow_timeline() {
        let snapshot: SceneSnapshot =
            serde_json::from_str(include_str!("../../../fixtures/renderer/demo-scene.json"))
                .unwrap();
        let path_id = snapshot.paths[0].id.clone();
        let timeline = Timeline {
            protocol_version: atlas_protocol::PROTOCOL_VERSION,
            timeline_version: atlas_protocol::TIMELINE_VERSION,
            id: "timeline:wasm-highlight".into(),
            scene_id: snapshot.scene_id.clone(),
            duration_ms: 1_000,
            looped: true,
            keyframes: vec![TimelineKeyframe {
                id: "cue:wasm-highlight".into(),
                at_ms: 0,
                easing: atlas_protocol::Easing::Linear,
                camera: None,
                object_states: vec![ObjectKeyframeState {
                    object_ids: vec!["visual-node:lineage:system:okie".into()],
                    opacity: 1.0,
                    emphasis: 1.0,
                }],
                path_states: vec![PathKeyframeState {
                    path_ids: vec![path_id.clone()],
                    opacity: 1.0,
                    emphasis: 1.0,
                    flow_speed: 1.0,
                    color: None,
                }],
            }],
        };
        let camera = Camera::new(
            Vec2::new(0.0, 0.0),
            0.5,
            Viewport::new(1_200.0, 800.0, 1.0),
            CameraLimits::default(),
        );
        let mut engine = ProtocolEngine::try_new(snapshot, camera).unwrap();
        engine.set_timeline(timeline).unwrap();
        engine.play_timeline();
        engine.tick(0.0);

        apply_host_camera(&mut engine, 420.0, 240.0, 1.55);
        engine.tick(500.0);
        assert_eq!(engine.camera().center(), Vec2::new(420.0, 240.0));
        assert!((engine.camera().zoom() - 1.55).abs() < f64::EPSILON);
        let frame = engine.prepare_frame(RendererBackend::Headless);
        let path_index = engine
            .snapshot()
            .paths
            .iter()
            .position(|path| path.id == path_id)
            .unwrap();
        assert!((frame.timeline.unwrap().path_flow_phase[path_index] - 0.5).abs() < 0.001);
    }
}
