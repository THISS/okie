use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{Camera, Rect, Scene, Vec2};

fn default_step_duration() -> u32 {
    1_200
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Story {
    pub id: String,
    pub title: String,
    pub steps: Vec<StoryStep>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoryStep {
    #[serde(default)]
    pub narration: String,
    #[serde(default)]
    pub focus_node_ids: Vec<String>,
    #[serde(default)]
    pub trace_edge_ids: Vec<String>,
    #[serde(default = "default_step_duration")]
    pub duration_ms: u32,
    #[serde(default)]
    pub hold_ms: u32,
    #[serde(default = "default_story_padding")]
    pub padding_px: f64,
}

const fn default_story_padding() -> f64 {
    96.0
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum StoryCompileError {
    #[error("story `{0}` has no steps")]
    Empty(String),
    #[error("story step {step} references missing node `{id}`")]
    MissingNode { step: usize, id: String },
    #[error("story step {step} references missing edge `{id}`")]
    MissingEdge { step: usize, id: String },
    #[error("story step {0} has no focus nodes")]
    EmptyFocus(usize),
}

#[derive(Debug, Clone, PartialEq)]
struct StoryKeyframe {
    start_ms: f64,
    transition_end_ms: f64,
    end_ms: f64,
    camera_center: Vec2,
    camera_zoom: f64,
    narration: String,
    highlighted_node_ids: Vec<String>,
    highlighted_edge_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompiledStory {
    id: String,
    keyframes: Vec<StoryKeyframe>,
    duration_ms: f64,
    initial_center: Vec2,
    initial_zoom: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StoryFrame {
    pub step_index: usize,
    pub camera_center: Vec2,
    pub camera_zoom: f64,
    pub narration: String,
    pub highlighted_node_ids: Vec<String>,
    pub highlighted_edge_ids: Vec<String>,
    pub edge_flow_phase: f32,
}

pub struct StoryCompiler;

impl StoryCompiler {
    pub fn compile(
        scene: &Scene,
        camera: &Camera,
        story: &Story,
    ) -> Result<CompiledStory, StoryCompileError> {
        if story.steps.is_empty() {
            return Err(StoryCompileError::Empty(story.id.clone()));
        }

        let mut cursor_ms = 0.0;
        let mut keyframes = Vec::with_capacity(story.steps.len());
        for (index, step) in story.steps.iter().enumerate() {
            let mut focus_bounds: Option<Rect> = None;
            if step.focus_node_ids.is_empty() {
                return Err(StoryCompileError::EmptyFocus(index));
            }
            for id in &step.focus_node_ids {
                let node = scene
                    .node(id)
                    .ok_or_else(|| StoryCompileError::MissingNode {
                        step: index,
                        id: id.clone(),
                    })?;
                focus_bounds = Some(match focus_bounds {
                    Some(bounds) => bounds.union(node.bounds),
                    None => node.bounds,
                });
            }
            for id in &step.trace_edge_ids {
                if scene.edge(id).is_none() {
                    return Err(StoryCompileError::MissingEdge {
                        step: index,
                        id: id.clone(),
                    });
                }
            }

            let bounds = focus_bounds.expect("focus is validated above");
            let available_width = (camera.viewport().css_width - step.padding_px * 2.0).max(1.0);
            let available_height = (camera.viewport().css_height - step.padding_px * 2.0).max(1.0);
            let zoom = (available_width / bounds.width.max(1.0))
                .min(available_height / bounds.height.max(1.0));
            let transition_end_ms = cursor_ms + f64::from(step.duration_ms);
            let end_ms = transition_end_ms + f64::from(step.hold_ms);
            keyframes.push(StoryKeyframe {
                start_ms: cursor_ms,
                transition_end_ms,
                end_ms,
                camera_center: bounds.center(),
                camera_zoom: zoom,
                narration: step.narration.clone(),
                highlighted_node_ids: step.focus_node_ids.clone(),
                highlighted_edge_ids: step.trace_edge_ids.clone(),
            });
            cursor_ms = end_ms;
        }

        Ok(CompiledStory {
            id: story.id.clone(),
            keyframes,
            duration_ms: cursor_ms,
            initial_center: camera.center(),
            initial_zoom: camera.zoom(),
        })
    }
}

impl CompiledStory {
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    #[must_use]
    pub fn duration_ms(&self) -> f64 {
        self.duration_ms
    }

    #[must_use]
    pub fn sample(&self, position_ms: f64) -> StoryFrame {
        let position = position_ms.clamp(0.0, self.duration_ms);
        let mut index = self.keyframes.len() - 1;
        for (candidate, keyframe) in self.keyframes.iter().enumerate() {
            if position <= keyframe.end_ms {
                index = candidate;
                break;
            }
        }
        let keyframe = &self.keyframes[index];
        let previous_center = if index == 0 {
            self.initial_center
        } else {
            self.keyframes[index - 1].camera_center
        };
        let previous_zoom = if index == 0 {
            self.initial_zoom
        } else {
            self.keyframes[index - 1].camera_zoom
        };
        let duration = (keyframe.transition_end_ms - keyframe.start_ms).max(1.0);
        let linear = ((position - keyframe.start_ms) / duration).clamp(0.0, 1.0);
        let eased = ease_in_out_cubic(linear);
        let edge_flow_phase = ((position / 900.0).fract()) as f32;
        StoryFrame {
            step_index: index,
            camera_center: previous_center.lerp(keyframe.camera_center, eased),
            camera_zoom: previous_zoom + (keyframe.camera_zoom - previous_zoom) * eased,
            narration: keyframe.narration.clone(),
            highlighted_node_ids: keyframe.highlighted_node_ids.clone(),
            highlighted_edge_ids: keyframe.highlighted_edge_ids.clone(),
            edge_flow_phase,
        }
    }
}

fn ease_in_out_cubic(value: f64) -> f64 {
    if value < 0.5 {
        4.0 * value * value * value
    } else {
        1.0 - (-2.0 * value + 2.0).powi(3) / 2.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CameraLimits, Edge, Node, SemanticLevel, Viewport};

    fn fixture() -> (Scene, Camera, Story) {
        let scene = Scene::try_new(
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
                    Rect::new(300.0, 0.0, 100.0, 60.0),
                    SemanticLevel::Context,
                ),
            ],
            vec![Edge::new("ab", "a", "b", SemanticLevel::Context)],
        )
        .unwrap();
        let camera = Camera::new(
            Vec2::new(200.0, 30.0),
            1.0,
            Viewport::new(800.0, 600.0, 1.0),
            CameraLimits::default(),
        );
        let story = Story {
            id: "flow".into(),
            title: "Flow".into(),
            steps: vec![
                StoryStep {
                    narration: "Start".into(),
                    focus_node_ids: vec!["a".into()],
                    trace_edge_ids: vec![],
                    duration_ms: 1_000,
                    hold_ms: 200,
                    padding_px: 100.0,
                },
                StoryStep {
                    narration: "Travel".into(),
                    focus_node_ids: vec!["a".into(), "b".into()],
                    trace_edge_ids: vec!["ab".into()],
                    duration_ms: 1_000,
                    hold_ms: 0,
                    padding_px: 100.0,
                },
            ],
        };
        (scene, camera, story)
    }

    #[test]
    fn compilation_is_deterministic_and_seekable() {
        let (scene, camera, story) = fixture();
        let first = StoryCompiler::compile(&scene, &camera, &story).unwrap();
        let second = StoryCompiler::compile(&scene, &camera, &story).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.duration_ms(), 2_200.0);
        assert_eq!(first.sample(1_700.0), second.sample(1_700.0));
        assert_eq!(first.sample(1_700.0).highlighted_edge_ids, vec!["ab"]);
    }

    #[test]
    fn reports_bad_story_references() {
        let (scene, camera, mut story) = fixture();
        story.steps[0].focus_node_ids = vec!["missing".into()];
        assert_eq!(
            StoryCompiler::compile(&scene, &camera, &story).unwrap_err(),
            StoryCompileError::MissingNode {
                step: 0,
                id: "missing".into()
            }
        );
    }
}
