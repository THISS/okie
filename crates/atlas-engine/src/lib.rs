//! Deterministic, renderer-independent state for the Okie architecture canvas.
//!
//! This crate intentionally has no browser or GPU dependencies. It owns camera
//! math, semantic zoom, hit testing, story compilation, and frame diagnostics so
//! those behaviours can be unit-tested on every target, including wasm32.

mod camera;
mod diagnostics;
mod geometry;
mod hit_test;
mod lod;
mod protocol_runtime;
mod scene;
mod spatial;
mod story;

pub use camera::{Camera, CameraLimits, Viewport};
pub use diagnostics::{FrameDiagnostics, RendererBackend};
pub use geometry::{Color, Rect, Vec2};
pub use hit_test::{HitTarget, hit_test};
pub use lod::{LodController, LodThresholds, SemanticLevel};
pub use protocol_runtime::{
    ObjectDraw, PROTOCOL_LOD_HANDOFF_DURATION_MS, PathDraw, ProjectionMorphOverride,
    ProjectionObjectOverride, ProjectionOverride, ProjectionPathOverride, ProtocolEngine,
    ProtocolEngineError, ProtocolFrame, ProtocolLodFrame, ProtocolTimelineFrame,
    ProtocolTimelinePlayer, VisibilityFilter, VisibilityMode,
};
pub use scene::{Edge, EdgeKind, Node, Scene, SceneError};
pub use story::{CompiledStory, Story, StoryCompileError, StoryCompiler, StoryFrame, StoryStep};

/// Complete deterministic state needed to prepare a render frame.
#[derive(Debug, Clone)]
pub struct AtlasEngine {
    scene: Scene,
    camera: Camera,
    lod: LodController,
    selected: Option<String>,
    story: Option<StoryPlayback>,
}

#[derive(Debug, Clone)]
struct StoryPlayback {
    compiled: CompiledStory,
    position_ms: f64,
    playing: bool,
    last_tick_ms: Option<f64>,
}

/// Immutable result of preparing an engine frame.
#[derive(Debug, Clone)]
pub struct PreparedFrame {
    pub level: SemanticLevel,
    pub previous_level: Option<SemanticLevel>,
    pub transition_progress: f32,
    pub visible_node_indices: Vec<usize>,
    pub visible_edge_indices: Vec<usize>,
    pub highlighted_node_ids: Vec<String>,
    pub highlighted_edge_ids: Vec<String>,
    pub diagnostics: FrameDiagnostics,
}

impl AtlasEngine {
    #[must_use]
    pub fn new(scene: Scene, camera: Camera, thresholds: LodThresholds) -> Self {
        let mut lod = LodController::new(thresholds);
        lod.update(camera.zoom(), 0.0);
        Self {
            scene,
            camera,
            lod,
            selected: None,
            story: None,
        }
    }

    #[must_use]
    pub fn scene(&self) -> &Scene {
        &self.scene
    }

    #[must_use]
    pub fn camera(&self) -> &Camera {
        &self.camera
    }

    pub fn camera_mut(&mut self) -> &mut Camera {
        &mut self.camera
    }

    #[must_use]
    pub fn selected(&self) -> Option<&str> {
        self.selected.as_deref()
    }

    pub fn resize(&mut self, viewport: Viewport) {
        self.camera.set_viewport(viewport);
    }

    pub fn pan_screen(&mut self, delta: Vec2) {
        self.stop_story();
        self.camera.pan_screen(delta);
    }

    pub fn zoom_at(&mut self, screen_anchor: Vec2, factor: f64) {
        self.stop_story();
        self.camera.zoom_at(screen_anchor, factor);
    }

    pub fn fit_world(&mut self, padding_px: f64) {
        self.stop_story();
        self.camera.fit_rect(self.scene.world_bounds(), padding_px);
    }

    pub fn select_at(&mut self, screen_point: Vec2, tolerance_px: f64) -> Option<HitTarget> {
        let target = hit_test(
            &self.scene,
            &self.camera,
            self.lod.current(),
            screen_point,
            tolerance_px,
        );
        self.selected = target.as_ref().map(|hit| hit.id().to_owned());
        target
    }

    pub fn clear_selection(&mut self) {
        self.selected = None;
    }

    pub fn set_story(&mut self, story: &Story) -> Result<(), StoryCompileError> {
        let compiled = StoryCompiler::compile(&self.scene, &self.camera, story)?;
        self.story = Some(StoryPlayback {
            compiled,
            position_ms: 0.0,
            playing: false,
            last_tick_ms: None,
        });
        self.apply_story_position();
        Ok(())
    }

    pub fn play_story(&mut self) {
        if let Some(story) = &mut self.story {
            story.playing = true;
            story.last_tick_ms = None;
        }
    }

    pub fn pause_story(&mut self) {
        if let Some(story) = &mut self.story {
            story.playing = false;
            story.last_tick_ms = None;
        }
    }

    pub fn seek_story(&mut self, position_ms: f64) {
        if let Some(story) = &mut self.story {
            story.position_ms = position_ms.clamp(0.0, story.compiled.duration_ms());
            story.last_tick_ms = None;
        }
        self.apply_story_position();
    }

    pub fn stop_story(&mut self) {
        if let Some(story) = &mut self.story {
            story.playing = false;
            story.last_tick_ms = None;
        }
    }

    pub fn tick(&mut self, now_ms: f64) {
        let mut should_apply = false;
        if let Some(story) = &mut self.story {
            if story.playing {
                if let Some(previous) = story.last_tick_ms {
                    let elapsed = (now_ms - previous).max(0.0);
                    story.position_ms =
                        (story.position_ms + elapsed).min(story.compiled.duration_ms());
                    if story.position_ms >= story.compiled.duration_ms() {
                        story.playing = false;
                    }
                    should_apply = true;
                }
                story.last_tick_ms = Some(now_ms);
            }
        }
        if should_apply {
            self.apply_story_position();
        }
    }

    fn apply_story_position(&mut self) {
        let Some(playback) = &self.story else {
            return;
        };
        let frame = playback.compiled.sample(playback.position_ms);
        self.camera.set_center(frame.camera_center);
        self.camera.set_zoom(frame.camera_zoom);
    }

    #[must_use]
    pub fn prepare_frame(&mut self, now_ms: f64, backend: RendererBackend) -> PreparedFrame {
        let lod_sample = self.lod.update(self.camera.zoom(), now_ms);
        let world_view = self.camera.visible_world_rect();
        let levels = lod_sample.visible_levels();

        let mut visible_node_indices = Vec::new();
        let mut culled_nodes = 0_u32;
        for (index, node) in self.scene.nodes().iter().enumerate() {
            if levels.contains(&node.level) && node.bounds.intersects(world_view) {
                visible_node_indices.push(index);
            } else {
                culled_nodes += 1;
            }
        }

        let mut visible_edge_indices = Vec::new();
        let mut culled_edges = 0_u32;
        for (index, edge) in self.scene.edges().iter().enumerate() {
            let visible_level = levels.contains(&edge.level);
            let visible_bounds = self
                .scene
                .edge_bounds(edge)
                .is_some_and(|bounds| bounds.intersects(world_view));
            if visible_level && visible_bounds {
                visible_edge_indices.push(index);
            } else {
                culled_edges += 1;
            }
        }

        let story_frame = self
            .story
            .as_ref()
            .map(|story| story.compiled.sample(story.position_ms));
        let highlighted_node_ids = story_frame
            .as_ref()
            .map(|frame| frame.highlighted_node_ids.clone())
            .unwrap_or_default();
        let highlighted_edge_ids = story_frame
            .as_ref()
            .map(|frame| frame.highlighted_edge_ids.clone())
            .unwrap_or_default();

        let diagnostics = FrameDiagnostics {
            backend,
            semantic_level: lod_sample.current,
            visible_nodes: visible_node_indices.len() as u32,
            visible_edges: visible_edge_indices.len() as u32,
            candidate_nodes: self.scene.nodes().len() as u32,
            candidate_edges: self.scene.edges().len() as u32,
            resident_nodes: visible_node_indices.len() as u32,
            resident_edges: visible_edge_indices.len() as u32,
            retained_view_reused: false,
            culled_nodes,
            culled_edges,
            draw_calls: u32::from(!visible_node_indices.is_empty())
                + u32::from(!visible_edge_indices.is_empty()),
            frame_time_ms: 0.0,
        };

        PreparedFrame {
            level: lod_sample.current,
            previous_level: lod_sample.previous,
            transition_progress: lod_sample.progress,
            visible_node_indices,
            visible_edge_indices,
            highlighted_node_ids,
            highlighted_edge_ids,
            diagnostics,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Scene {
        Scene::try_new(
            vec![
                Node::new(
                    "a",
                    "A",
                    Rect::new(0.0, 0.0, 100.0, 60.0),
                    SemanticLevel::Context,
                ),
                Node::new(
                    "b",
                    "B",
                    Rect::new(200.0, 0.0, 100.0, 60.0),
                    SemanticLevel::Context,
                ),
            ],
            vec![Edge::new("ab", "a", "b", SemanticLevel::Context)],
        )
        .unwrap()
    }

    #[test]
    fn prepares_only_visible_scene_members() {
        let camera = Camera::new(
            Vec2::new(150.0, 30.0),
            2.0,
            Viewport::new(800.0, 600.0, 1.0),
            CameraLimits::default(),
        );
        let mut engine = AtlasEngine::new(fixture(), camera, LodThresholds::default());
        let frame = engine.prepare_frame(0.0, RendererBackend::Headless);
        assert_eq!(frame.visible_node_indices.len(), 2);
        assert_eq!(frame.visible_edge_indices.len(), 1);
        assert_eq!(frame.diagnostics.draw_calls, 2);
    }
}
