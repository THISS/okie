use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::{Color, Easing, PROTOCOL_VERSION, Point, ProtocolError, is_valid_color};

pub const TIMELINE_VERSION: u16 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraKeyframeState {
    pub center: Point,
    pub zoom: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectKeyframeState {
    pub object_ids: Vec<String>,
    pub opacity: f32,
    pub emphasis: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathKeyframeState {
    pub path_ids: Vec<String>,
    pub opacity: f32,
    pub emphasis: f32,
    pub flow_speed: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<Color>,
}

/// A full sparse target state. Missing object/path IDs resolve to the neutral
/// defaults (opacity 1, emphasis/flow 0 and no color override).
///
/// Keyframe times must strictly increase. The incoming keyframe owns easing
/// for the segment ending at `at_ms`: before the first target the source is the
/// neutral state at t=0; `[at_i, at_i+1)` interpolates i -> i+1; exact target
/// times sample that target and the final target holds through duration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineKeyframe {
    pub id: String,
    pub at_ms: u32,
    pub easing: Easing,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera: Option<CameraKeyframeState>,
    #[serde(default)]
    pub object_states: Vec<ObjectKeyframeState>,
    #[serde(default)]
    pub path_states: Vec<PathKeyframeState>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    pub protocol_version: u16,
    pub timeline_version: u16,
    pub id: String,
    pub scene_id: String,
    pub duration_ms: u32,
    #[serde(default)]
    pub looped: bool,
    pub keyframes: Vec<TimelineKeyframe>,
}

impl Timeline {
    pub fn validate_for(&self, scene: &crate::SceneSnapshot) -> Result<(), ProtocolError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedVersion(self.protocol_version));
        }
        if self.timeline_version != TIMELINE_VERSION {
            return Err(ProtocolError::UnsupportedTimelineVersion(
                self.timeline_version,
            ));
        }
        if self.scene_id != scene.scene_id {
            return Err(ProtocolError::SceneMismatch {
                expected: scene.scene_id.clone(),
                actual: self.scene_id.clone(),
            });
        }
        if self.id.is_empty() {
            return Err(ProtocolError::InvalidTimeline(
                "timeline id is empty".into(),
            ));
        }
        if !self.keyframes.is_empty() && self.duration_ms == 0 {
            return Err(ProtocolError::InvalidTimeline(
                "timeline duration must be greater than zero".into(),
            ));
        }
        let object_ids: HashSet<_> = scene
            .objects
            .iter()
            .map(|object| object.id.as_str())
            .collect();
        let path_ids: HashSet<_> = scene.paths.iter().map(|path| path.id.as_str()).collect();
        let mut keyframe_ids = HashSet::with_capacity(self.keyframes.len());
        let mut previous_at = None;
        for keyframe in &self.keyframes {
            if keyframe.id.is_empty() || !keyframe_ids.insert(keyframe.id.as_str()) {
                return Err(ProtocolError::DuplicateId(keyframe.id.clone()));
            }
            if previous_at.is_some_and(|previous| keyframe.at_ms <= previous) {
                return Err(ProtocolError::InvalidTimeline(format!(
                    "keyframe {} time must strictly increase",
                    keyframe.id
                )));
            }
            if keyframe.at_ms > self.duration_ms {
                return Err(ProtocolError::KeyframeOutsideTimeline(keyframe.id.clone()));
            }
            previous_at = Some(keyframe.at_ms);
            if let Some(camera) = keyframe.camera {
                if !camera.center.is_finite() || !camera.zoom.is_finite() || camera.zoom <= 0.0 {
                    return Err(ProtocolError::InvalidCamera(keyframe.id.clone()));
                }
            }
            let mut keyframe_object_ids = HashSet::new();
            for state in &keyframe.object_states {
                if state.object_ids.is_empty()
                    || !state.opacity.is_finite()
                    || !(0.0..=1.0).contains(&state.opacity)
                    || !state.emphasis.is_finite()
                    || state.emphasis < 0.0
                {
                    return Err(ProtocolError::InvalidEffect(keyframe.id.clone()));
                }
                for id in &state.object_ids {
                    if !object_ids.contains(id.as_str()) {
                        return Err(ProtocolError::UnknownObject(id.clone()));
                    }
                    if !keyframe_object_ids.insert(id.as_str()) {
                        return Err(ProtocolError::DuplicateId(id.clone()));
                    }
                }
            }
            let mut keyframe_path_ids = HashSet::new();
            for state in &keyframe.path_states {
                if state.path_ids.is_empty()
                    || !state.opacity.is_finite()
                    || !(0.0..=1.0).contains(&state.opacity)
                    || !state.emphasis.is_finite()
                    || state.emphasis < 0.0
                    || !state.flow_speed.is_finite()
                    || state.flow_speed < 0.0
                {
                    return Err(ProtocolError::InvalidEffect(keyframe.id.clone()));
                }
                if state.color.is_some_and(|color| !is_valid_color(color)) {
                    return Err(ProtocolError::InvalidColor(keyframe.id.clone()));
                }
                for id in &state.path_ids {
                    if !path_ids.contains(id.as_str()) {
                        return Err(ProtocolError::UnknownPath(id.clone()));
                    }
                    if !keyframe_path_ids.insert(id.as_str()) {
                        return Err(ProtocolError::DuplicateId(id.clone()));
                    }
                }
            }
        }
        Ok(())
    }
}
