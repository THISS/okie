use std::collections::{HashMap, HashSet};

use atlas_protocol::{
    Color as ProtocolColor, Easing, LodRange, Primitive, ProtocolError, SceneObject, ScenePatch,
    ScenePath, SceneSnapshot, Timeline, Transition,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::spatial::{SpatialIndex, SpatialQueryScratch};
use crate::{Camera, FrameDiagnostics, HitTarget, Rect, RendererBackend, Vec2, Viewport};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ObjectDraw {
    pub object_index: usize,
    pub representation_index: usize,
    pub opacity: f32,
    /// Absolute Text/Icon opacity after projection, timeline, and visibility.
    pub content_opacity: f32,
    pub lod_opacity: f32,
    pub base_opacity: f32,
    pub emphasis: f32,
    pub resident: bool,
    /// `[scale_x, scale_y, translate_x, translate_y]` applied in world space.
    pub transform: [f32; 4],
    /// World-space clip `[x, y, width, height]`; zero size disables clipping.
    pub clip: [f32; 4],
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PathDraw {
    pub path_index: usize,
    pub opacity: f32,
    pub emphasis: f32,
    pub flow_phase: f32,
    pub color_override: Option<ProtocolColor>,
    pub resident: bool,
    pub transform: [f32; 4],
    pub clip: [f32; 4],
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProtocolFrame {
    pub geometry_epoch: u64,
    pub objects: Vec<ObjectDraw>,
    pub paths: Vec<PathDraw>,
    pub timeline: Option<ProtocolTimelineFrame>,
    pub lod: Option<ProtocolLodFrame>,
    pub diagnostics: FrameDiagnostics,
}

pub const PROTOCOL_LOD_HANDOFF_DURATION_MS: u32 = 200;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolLodFrame {
    pub object_id: String,
    pub current_representation_id: String,
    pub current_representation_index: u32,
    pub previous_representation_id: Option<String>,
    pub previous_representation_index: Option<u32>,
    pub transition_progress: f32,
    pub current_weight: f32,
    pub previous_weight: f32,
    pub transitioning: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProtocolTimelineFrame {
    pub keyframe_id: Option<String>,
    pub position_ms: u32,
    /// True when the active cue explicitly owns the camera track. Object/path
    /// effects may be sampled without taking camera ownership.
    pub camera_active: bool,
    pub camera_center: Vec2,
    pub camera_zoom: f64,
    pub object_emphasis: Vec<f32>,
    pub object_opacity: Vec<f32>,
    pub path_emphasis: Vec<f32>,
    pub path_opacity: Vec<f32>,
    pub path_flow_phase: Vec<f32>,
    pub path_color: Vec<Option<ProtocolColor>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum VisibilityMode {
    #[default]
    All,
    Dim,
    Isolate,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VisibilityFilter {
    pub mode: VisibilityMode,
    pub object_ids: Vec<String>,
    pub dim_opacity: f32,
}

/// Dynamic, renderer-generic ownership of authored representations. This is
/// intentionally expressed in stable protocol IDs rather than C4 levels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionOverride {
    pub id: String,
    pub progress: f32,
    pub objects: Vec<ProjectionObjectOverride>,
    pub paths: Vec<ProjectionPathOverride>,
    #[serde(default)]
    pub morph: Option<ProjectionMorphOverride>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionObjectOverride {
    pub object_id: String,
    pub source_representation_id: Option<String>,
    pub target_representation_id: Option<String>,
    #[serde(default)]
    pub source_opacity: Option<f32>,
    #[serde(default)]
    pub target_opacity: Option<f32>,
    #[serde(default)]
    pub source_content_opacity: Option<f32>,
    #[serde(default)]
    pub target_content_opacity: Option<f32>,
    #[serde(default)]
    pub source_pickable: Option<bool>,
    #[serde(default)]
    pub target_pickable: Option<bool>,
    #[serde(default)]
    pub source_pick_priority: Option<i32>,
    #[serde(default)]
    pub target_pick_priority: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionPathOverride {
    pub path_id: String,
    pub source_opacity: f32,
    pub target_opacity: f32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionMorphOverride {
    pub boundary_object_id: String,
    pub object_ids: Vec<String>,
    pub path_ids: Vec<String>,
}

impl Default for VisibilityFilter {
    fn default() -> Self {
        Self {
            mode: VisibilityMode::All,
            object_ids: Vec::new(),
            dim_opacity: 0.18,
        }
    }
}

#[derive(Debug, Clone)]
struct ResolvedVisibility {
    filter: VisibilityFilter,
    focused_objects: Vec<bool>,
    focused_paths: Vec<bool>,
    visible_objects: Vec<bool>,
    visible_paths: Vec<bool>,
}

#[derive(Debug, Clone)]
struct ResolvedProjectionOverride {
    value: ProjectionOverride,
    objects: HashMap<usize, ResolvedProjectionObject>,
    paths: HashMap<usize, (f32, f32)>,
    morph: Option<ResolvedProjectionMorph>,
}

#[derive(Debug, Clone, Copy)]
struct ResolvedProjectionObject {
    source: Option<usize>,
    target: Option<usize>,
    source_opacity: f32,
    target_opacity: f32,
    source_content_opacity: f32,
    target_content_opacity: f32,
    source_pickable: bool,
    target_pickable: bool,
    source_pick_priority: i32,
    target_pick_priority: i32,
}

#[derive(Debug, Clone)]
struct ResolvedProjectionMorph {
    boundary_object_index: usize,
    object_indices: HashSet<usize>,
    path_indices: HashSet<usize>,
}

#[derive(Debug, Clone, Copy)]
struct ProjectionSpatialState {
    transform: [f32; 4],
    clip: [f32; 4],
}

impl ProjectionSpatialState {
    const IDENTITY: Self = Self {
        transform: [1.0, 1.0, 0.0, 0.0],
        clip: [0.0; 4],
    };
}

impl ResolvedProjectionOverride {
    fn resolve(
        value: ProjectionOverride,
        snapshot: &SceneSnapshot,
    ) -> Result<Self, ProtocolEngineError> {
        if value.id.is_empty()
            || !value.progress.is_finite()
            || !(0.0..=1.0).contains(&value.progress)
        {
            return Err(ProtocolEngineError::InvalidProjectionOverride(
                "id/progress".into(),
            ));
        }
        let object_by_id: HashMap<_, _> = snapshot
            .objects
            .iter()
            .enumerate()
            .map(|(index, object)| (object.id.as_str(), index))
            .collect();
        let path_by_id: HashMap<_, _> = snapshot
            .paths
            .iter()
            .enumerate()
            .map(|(index, path)| (path.id.as_str(), index))
            .collect();
        let mut objects = HashMap::new();
        for object_override in &value.objects {
            let Some(object_index) = object_by_id
                .get(object_override.object_id.as_str())
                .copied()
            else {
                return Err(ProtocolError::UnknownObject(object_override.object_id.clone()).into());
            };
            if objects.contains_key(&object_index) {
                return Err(ProtocolEngineError::InvalidProjectionOverride(format!(
                    "duplicate object {}",
                    object_override.object_id
                )));
            }
            let object = &snapshot.objects[object_index];
            let representation_index =
                |id: &Option<String>| -> Result<Option<usize>, ProtocolEngineError> {
                    id.as_ref()
                        .map(|id| {
                            object
                                .representations
                                .iter()
                                .position(|representation| representation.id == *id)
                                .ok_or_else(|| {
                                    ProtocolEngineError::InvalidProjectionOverride(format!(
                                        "unknown representation {id} for {}",
                                        object.id
                                    ))
                                })
                        })
                        .transpose()
                };
            let source = representation_index(&object_override.source_representation_id)?;
            let target = representation_index(&object_override.target_representation_id)?;
            let source_opacity = object_override
                .source_opacity
                .unwrap_or(f32::from(source.is_some()));
            let target_opacity = object_override
                .target_opacity
                .unwrap_or(f32::from(target.is_some()));
            let source_content_opacity = object_override
                .source_content_opacity
                .unwrap_or(source_opacity);
            let target_content_opacity = object_override
                .target_content_opacity
                .unwrap_or(target_opacity);
            if !source_opacity.is_finite()
                || !target_opacity.is_finite()
                || !source_content_opacity.is_finite()
                || !target_content_opacity.is_finite()
                || !(0.0..=1.0).contains(&source_opacity)
                || !(0.0..=1.0).contains(&target_opacity)
                || !(0.0..=1.0).contains(&source_content_opacity)
                || !(0.0..=1.0).contains(&target_content_opacity)
            {
                return Err(ProtocolEngineError::InvalidProjectionOverride(format!(
                    "invalid object opacity {}",
                    object_override.object_id
                )));
            }
            objects.insert(
                object_index,
                ResolvedProjectionObject {
                    source,
                    target,
                    source_opacity,
                    target_opacity,
                    source_content_opacity,
                    target_content_opacity,
                    source_pickable: object_override.source_pickable.unwrap_or(source.is_some()),
                    target_pickable: object_override.target_pickable.unwrap_or(target.is_some()),
                    source_pick_priority: object_override.source_pick_priority.unwrap_or(0),
                    target_pick_priority: object_override.target_pick_priority.unwrap_or(0),
                },
            );
        }
        let mut paths = HashMap::new();
        for path_override in &value.paths {
            let Some(path_index) = path_by_id.get(path_override.path_id.as_str()).copied() else {
                return Err(ProtocolError::UnknownPath(path_override.path_id.clone()).into());
            };
            if paths.contains_key(&path_index)
                || !path_override.source_opacity.is_finite()
                || !path_override.target_opacity.is_finite()
                || !(0.0..=1.0).contains(&path_override.source_opacity)
                || !(0.0..=1.0).contains(&path_override.target_opacity)
            {
                return Err(ProtocolEngineError::InvalidProjectionOverride(format!(
                    "invalid path {}",
                    path_override.path_id
                )));
            }
            paths.insert(
                path_index,
                (path_override.source_opacity, path_override.target_opacity),
            );
        }
        let morph = value
            .morph
            .as_ref()
            .map(|morph| {
                let boundary_object_index = object_by_id
                    .get(morph.boundary_object_id.as_str())
                    .copied()
                    .ok_or_else(|| {
                        ProtocolEngineError::InvalidProjectionOverride(format!(
                            "unknown morph boundary {}",
                            morph.boundary_object_id
                        ))
                    })?;
                let Some(ResolvedProjectionObject {
                    source: Some(source),
                    target: Some(target),
                    ..
                }) = objects.get(&boundary_object_index)
                else {
                    return Err(ProtocolEngineError::InvalidProjectionOverride(
                        "morph boundary requires source and target representations".into(),
                    ));
                };
                if source == target {
                    return Err(ProtocolEngineError::InvalidProjectionOverride(
                        "morph boundary representations must differ".into(),
                    ));
                }
                let object_indices = morph
                    .object_ids
                    .iter()
                    .map(|id| {
                        object_by_id.get(id.as_str()).copied().ok_or_else(|| {
                            ProtocolEngineError::InvalidProjectionOverride(format!(
                                "unknown morph object {id}"
                            ))
                        })
                    })
                    .collect::<Result<HashSet<_>, _>>()?;
                let path_indices = morph
                    .path_ids
                    .iter()
                    .map(|id| {
                        path_by_id.get(id.as_str()).copied().ok_or_else(|| {
                            ProtocolEngineError::InvalidProjectionOverride(format!(
                                "unknown morph path {id}"
                            ))
                        })
                    })
                    .collect::<Result<HashSet<_>, _>>()?;
                if !object_indices.contains(&boundary_object_index) {
                    return Err(ProtocolEngineError::InvalidProjectionOverride(
                        "morph objects must include boundary".into(),
                    ));
                }
                Ok(ResolvedProjectionMorph {
                    boundary_object_index,
                    object_indices,
                    path_indices,
                })
            })
            .transpose()?;
        Ok(Self {
            value,
            objects,
            paths,
            morph,
        })
    }

    fn progress(&self, reduced_motion: bool) -> f32 {
        if reduced_motion {
            f32::from(self.value.progress >= 0.5)
        } else {
            self.value.progress
        }
    }

    fn object_weights(
        &self,
        object_index: usize,
        representation_count: usize,
        reduced_motion: bool,
    ) -> Option<Vec<f32>> {
        let object = self.objects.get(&object_index)?;
        let progress = self.progress(reduced_motion);
        let mut weights = vec![0.0; representation_count];
        if let Some(source) = object.source {
            weights[source] += (1.0 - progress) * object.source_opacity;
        }
        if let Some(target) = object.target {
            weights[target] += progress * object.target_opacity;
        }
        Some(weights)
    }

    fn object_content_weights(
        &self,
        object_index: usize,
        representation_count: usize,
        reduced_motion: bool,
    ) -> Option<Vec<f32>> {
        let object = self.objects.get(&object_index)?;
        let progress = self.progress(reduced_motion);
        let mut weights = vec![0.0; representation_count];
        if let Some(source) = object.source {
            weights[source] += (1.0 - progress) * object.source_content_opacity;
        }
        if let Some(target) = object.target {
            weights[target] += progress * object.target_content_opacity;
        }
        Some(weights)
    }

    fn owned_representation(
        &self,
        object_index: usize,
        reduced_motion: bool,
    ) -> Option<Option<usize>> {
        let object = self.objects.get(&object_index)?;
        Some(if self.progress(reduced_motion) >= 0.5 {
            object.target
        } else {
            object.source
        })
    }

    fn object_opacity(&self, object_index: usize, reduced_motion: bool) -> Option<f32> {
        let object = self.objects.get(&object_index)?;
        let progress = self.progress(reduced_motion);
        Some(object.source_opacity + (object.target_opacity - object.source_opacity) * progress)
    }

    fn object_pick(&self, object_index: usize, reduced_motion: bool) -> Option<(bool, i32)> {
        let object = self.objects.get(&object_index)?;
        let result = if self.progress(reduced_motion) >= 0.5 {
            (object.target_pickable, object.target_pick_priority)
        } else {
            (object.source_pickable, object.source_pick_priority)
        };
        Some((
            result.0 && self.object_opacity(object_index, reduced_motion)? >= 0.12,
            result.1,
        ))
    }

    fn path_opacity(&self, path_index: usize, reduced_motion: bool) -> Option<f32> {
        let (source, target) = self.paths.get(&path_index)?;
        let progress = self.progress(reduced_motion);
        Some(source + (target - source) * progress)
    }

    fn lod_frame(
        &self,
        snapshot: &SceneSnapshot,
        reduced_motion: bool,
    ) -> Option<ProtocolLodFrame> {
        let progress = self.progress(reduced_motion);
        let (&object_index, object_override) = self
            .objects
            .iter()
            .filter(|(_, object)| {
                object.source.is_some() && object.target.is_some() && object.source != object.target
            })
            .min_by_key(|(object_index, _)| *object_index)?;
        let object = &snapshot.objects[object_index];
        let source = object_override.source?;
        let target = object_override.target?;
        let (current, previous, current_weight, previous_weight) = if progress >= 0.5 {
            (target, source, progress, 1.0 - progress)
        } else {
            (source, target, 1.0 - progress, progress)
        };
        Some(ProtocolLodFrame {
            object_id: object.id.clone(),
            current_representation_id: object.representations[current].id.clone(),
            current_representation_index: current as u32,
            previous_representation_id: (progress > 0.0 && progress < 1.0)
                .then(|| object.representations[previous].id.clone()),
            previous_representation_index: (progress > 0.0 && progress < 1.0)
                .then_some(previous as u32),
            transition_progress: progress,
            current_weight,
            previous_weight,
            transitioning: progress > 0.0 && progress < 1.0,
        })
    }

    fn morph_bounds(
        &self,
        snapshot: &SceneSnapshot,
        reduced_motion: bool,
    ) -> Option<(Rect, Rect, Rect)> {
        let morph = self.morph.as_ref()?;
        let object = &snapshot.objects[morph.boundary_object_index];
        let ResolvedProjectionObject {
            source: Some(source),
            target: Some(target),
            ..
        } = self.objects[&morph.boundary_object_index]
        else {
            return None;
        };
        let source = protocol_rect(
            object.representations[source]
                .bounds
                .unwrap_or(object.bounds),
        );
        let target = protocol_rect(
            object.representations[target]
                .bounds
                .unwrap_or(object.bounds),
        );
        let progress = f64::from(self.progress(reduced_motion));
        let current = Rect::new(
            source.x + (target.x - source.x) * progress,
            source.y + (target.y - source.y) * progress,
            source.width + (target.width - source.width) * progress,
            source.height + (target.height - source.height) * progress,
        );
        Some((source, target, current))
    }

    fn affine(from: Rect, to: Rect) -> [f32; 4] {
        let scale_x = if from.width.abs() > f64::EPSILON {
            to.width / from.width
        } else {
            1.0
        };
        let scale_y = if from.height.abs() > f64::EPSILON {
            to.height / from.height
        } else {
            1.0
        };
        [
            scale_x as f32,
            scale_y as f32,
            (to.x - from.x * scale_x) as f32,
            (to.y - from.y * scale_y) as f32,
        ]
    }

    fn spatial_for_object(
        &self,
        snapshot: &SceneSnapshot,
        object_index: usize,
        representation_index: usize,
        reduced_motion: bool,
    ) -> ProjectionSpatialState {
        let Some(morph) = &self.morph else {
            return ProjectionSpatialState::IDENTITY;
        };
        if !morph.object_indices.contains(&object_index) {
            return ProjectionSpatialState::IDENTITY;
        }
        let Some((source_group, target_group, current_group)) =
            self.morph_bounds(snapshot, reduced_motion)
        else {
            return ProjectionSpatialState::IDENTITY;
        };
        if object_index == morph.boundary_object_index {
            let object = &snapshot.objects[object_index];
            let base = protocol_rect(
                object.representations[representation_index]
                    .bounds
                    .unwrap_or(object.bounds),
            );
            return ProjectionSpatialState {
                transform: Self::affine(base, current_group),
                clip: [0.0; 4],
            };
        }
        let (source, target) = self
            .objects
            .get(&object_index)
            .map_or((None, None), |object| (object.source, object.target));
        let basis = if target == Some(representation_index) {
            target_group
        } else if source == Some(representation_index) {
            source_group
        } else {
            return ProjectionSpatialState::IDENTITY;
        };
        ProjectionSpatialState {
            transform: Self::affine(basis, current_group),
            clip: [
                current_group.x as f32,
                current_group.y as f32,
                current_group.width as f32,
                current_group.height as f32,
            ],
        }
    }

    fn spatial_for_path(
        &self,
        snapshot: &SceneSnapshot,
        path_index: usize,
        reduced_motion: bool,
    ) -> ProjectionSpatialState {
        let Some(morph) = &self.morph else {
            return ProjectionSpatialState::IDENTITY;
        };
        if !morph.path_indices.contains(&path_index) {
            return ProjectionSpatialState::IDENTITY;
        }
        let Some((source_group, target_group, current_group)) =
            self.morph_bounds(snapshot, reduced_motion)
        else {
            return ProjectionSpatialState::IDENTITY;
        };
        let (source_opacity, target_opacity) =
            self.paths.get(&path_index).copied().unwrap_or((0.0, 0.0));
        let basis = if target_opacity > source_opacity {
            target_group
        } else {
            source_group
        };
        ProjectionSpatialState {
            transform: Self::affine(basis, current_group),
            clip: [
                current_group.x as f32,
                current_group.y as f32,
                current_group.width as f32,
                current_group.height as f32,
            ],
        }
    }
}

impl ResolvedVisibility {
    fn resolve(filter: VisibilityFilter, snapshot: &SceneSnapshot) -> Result<Self, ProtocolError> {
        if !filter.dim_opacity.is_finite() || !(0.0..=1.0).contains(&filter.dim_opacity) {
            return Err(ProtocolError::InvalidVisibility);
        }
        let object_by_id: HashMap<_, _> = snapshot
            .objects
            .iter()
            .enumerate()
            .map(|(index, object)| (object.id.as_str(), index))
            .collect();
        let mut focused_objects = vec![false; snapshot.objects.len()];
        for id in &filter.object_ids {
            let Some(index) = object_by_id.get(id.as_str()).copied() else {
                return Err(ProtocolError::UnknownObject(id.clone()));
            };
            focused_objects[index] = true;
        }
        let visible_objects = match filter.mode {
            VisibilityMode::Isolate => focused_objects.clone(),
            VisibilityMode::All | VisibilityMode::Dim => vec![true; snapshot.objects.len()],
        };
        let focused_paths: Vec<_> = snapshot
            .paths
            .iter()
            .map(|path| {
                let from = object_by_id[path.from_object_id.as_str()];
                let to = object_by_id[path.to_object_id.as_str()];
                focused_objects[from] && focused_objects[to]
            })
            .collect();
        let visible_paths = snapshot
            .paths
            .iter()
            .map(|path| {
                let from = object_by_id[path.from_object_id.as_str()];
                let to = object_by_id[path.to_object_id.as_str()];
                visible_objects[from] && visible_objects[to]
            })
            .collect();
        Ok(Self {
            filter,
            focused_objects,
            focused_paths,
            visible_objects,
            visible_paths,
        })
    }

    fn object_opacity(&self, index: usize) -> f32 {
        match self.filter.mode {
            VisibilityMode::All => 1.0,
            VisibilityMode::Dim if !self.focused_objects[index] => self.filter.dim_opacity,
            VisibilityMode::Dim => 1.0,
            VisibilityMode::Isolate => f32::from(self.visible_objects[index]),
        }
    }

    fn path_opacity(&self, index: usize) -> f32 {
        match self.filter.mode {
            VisibilityMode::All => 1.0,
            VisibilityMode::Dim if !self.focused_paths[index] => self.filter.dim_opacity,
            VisibilityMode::Dim => 1.0,
            VisibilityMode::Isolate => f32::from(self.visible_paths[index]),
        }
    }
}

#[derive(Debug, Error)]
pub enum ProtocolEngineError {
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error("invalid projection override: {0}")]
    InvalidProjectionOverride(String),
}

/// Runtime for the canonical renderer protocol. This is the path used by the
/// browser facade; the simpler semantic `AtlasEngine` remains useful for story
/// compilation tests and non-protocol clients.
#[derive(Debug, Clone)]
pub struct ProtocolEngine {
    snapshot: SceneSnapshot,
    camera: Camera,
    lod: ProtocolLodState,
    selected: Option<HitTarget>,
    timeline: Option<ProtocolTimelinePlayer>,
    patch_transition: Option<PatchPlayback>,
    spatial: SpatialIndex,
    object_query_scratch: SpatialQueryScratch,
    path_query_scratch: SpatialQueryScratch,
    lod_keys: ProtocolLodKeys,
    retained_view: Option<RetainedView>,
    geometry_epoch: u64,
    visibility: ResolvedVisibility,
    reduced_motion: bool,
    projection_override: Option<ResolvedProjectionOverride>,
}

#[derive(Debug, Clone)]
struct ProtocolLodKeys {
    objects: Vec<Vec<String>>,
    paths: Vec<String>,
}

impl ProtocolLodKeys {
    fn build(snapshot: &SceneSnapshot) -> Self {
        Self {
            objects: snapshot
                .objects
                .iter()
                .map(|object| {
                    object
                        .representations
                        .iter()
                        .map(|representation| representation_key(&object.id, &representation.id))
                        .collect()
                })
                .collect(),
            paths: snapshot
                .paths
                .iter()
                .map(|path| path_key(&path.id))
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct RetainedView {
    bounds: Rect,
    lod_zoom: f32,
    geometry_epoch: u64,
}

const RETAINED_VIEW_MARGIN: f64 = 0.35;
const RETAINED_ZOOM_MIN_RATIO: f32 = 0.88;
const RETAINED_ZOOM_MAX_RATIO: f32 = 1.14;

#[derive(Debug, Clone)]
struct PatchPlayback {
    target: SceneSnapshot,
    object_changes: Vec<ObjectPatchAnimation>,
    path_changes: Vec<PathPatchAnimation>,
    from_world_bounds: atlas_protocol::Rect,
    transition: Transition,
    position_ms: f64,
    last_tick_ms: Option<f64>,
}

#[derive(Debug, Clone)]
struct ObjectPatchAnimation {
    snapshot_index: usize,
    from: Option<SceneObject>,
    target: Option<SceneObject>,
}

#[derive(Debug, Clone)]
struct PathPatchAnimation {
    snapshot_index: usize,
    from: Option<ScenePath>,
    target: Option<ScenePath>,
}

impl ProtocolEngine {
    pub fn try_new(snapshot: SceneSnapshot, camera: Camera) -> Result<Self, ProtocolEngineError> {
        snapshot.validate()?;
        let spatial = SpatialIndex::build(&snapshot);
        let lod_keys = ProtocolLodKeys::build(&snapshot);
        let visibility = ResolvedVisibility::resolve(VisibilityFilter::default(), &snapshot)?;
        Ok(Self {
            snapshot,
            camera,
            lod: ProtocolLodState::default(),
            selected: None,
            timeline: None,
            patch_transition: None,
            spatial,
            object_query_scratch: SpatialQueryScratch::default(),
            path_query_scratch: SpatialQueryScratch::default(),
            lod_keys,
            retained_view: None,
            geometry_epoch: 0,
            visibility,
            reduced_motion: false,
            projection_override: None,
        })
    }

    #[must_use]
    pub fn snapshot(&self) -> &SceneSnapshot {
        &self.snapshot
    }

    #[must_use]
    pub fn camera(&self) -> &Camera {
        &self.camera
    }

    pub fn camera_mut(&mut self) -> &mut Camera {
        &mut self.camera
    }

    #[must_use]
    pub fn selected(&self) -> Option<&HitTarget> {
        self.selected.as_ref()
    }

    pub fn resize(&mut self, viewport: Viewport) {
        self.camera.set_viewport(viewport);
    }

    pub fn pan_screen(&mut self, delta: Vec2) {
        self.pause_timeline();
        self.camera.pan_screen(delta);
    }

    pub fn zoom_at(&mut self, screen_anchor: Vec2, factor: f64) {
        self.pause_timeline();
        self.camera.zoom_at(screen_anchor, factor);
    }

    pub fn fit_world(&mut self, padding_px: f64) {
        self.pause_timeline();
        self.camera
            .fit_rect(protocol_rect(self.snapshot.world_bounds), padding_px);
    }

    pub fn apply_patch(&mut self, patch: &ScenePatch) -> Result<(), ProtocolEngineError> {
        let visual_from = self.snapshot.clone();
        let canonical_base = self
            .patch_transition
            .take()
            .map_or_else(|| visual_from.clone(), |previous| previous.target);
        let target = patch.apply_to(&canonical_base)?;
        if let Some(transition) = patch.transition {
            let prepared = prepare_patch_animation(visual_from, target, transition);
            self.snapshot = prepared.snapshot;
            self.spatial =
                SpatialIndex::build_with_target(&self.snapshot, Some(&prepared.playback.target));
            self.patch_transition = Some(prepared.playback);
        } else {
            self.snapshot = target;
            self.spatial = SpatialIndex::build(&self.snapshot);
        }
        self.geometry_epoch = self.geometry_epoch.wrapping_add(1);
        self.lod_keys = ProtocolLodKeys::build(&self.snapshot);
        self.retained_view = None;
        self.lod.retain_snapshot_members(&self.snapshot);
        self.timeline = None;
        self.visibility =
            ResolvedVisibility::resolve(self.visibility.filter.clone(), &self.snapshot)
                .unwrap_or_else(|_| {
                    ResolvedVisibility::resolve(VisibilityFilter::default(), &self.snapshot)
                        .expect("default visibility resolves")
                });
        if self
            .selected
            .as_ref()
            .is_some_and(|target| !self.target_exists(target))
        {
            self.selected = None;
        }
        self.reresolve_projection_override();
        Ok(())
    }

    fn reresolve_projection_override(&mut self) {
        let value = self
            .projection_override
            .take()
            .map(|resolved| resolved.value);
        self.projection_override =
            value.and_then(|value| ResolvedProjectionOverride::resolve(value, &self.snapshot).ok());
    }

    pub fn set_timeline(&mut self, timeline: Timeline) -> Result<(), ProtocolEngineError> {
        self.timeline = Some(ProtocolTimelinePlayer::try_new(
            timeline,
            &self.snapshot,
            self.camera,
        )?);
        self.seek_timeline(0.0);
        Ok(())
    }

    pub fn set_visibility(&mut self, filter: VisibilityFilter) -> Result<(), ProtocolEngineError> {
        self.visibility = ResolvedVisibility::resolve(filter, &self.snapshot)?;
        Ok(())
    }

    pub fn set_projection_override(
        &mut self,
        value: Option<ProjectionOverride>,
    ) -> Result<(), ProtocolEngineError> {
        self.projection_override = value
            .map(|value| ResolvedProjectionOverride::resolve(value, &self.snapshot))
            .transpose()?;
        Ok(())
    }

    #[must_use]
    pub fn projection_override(&self) -> Option<&ProjectionOverride> {
        self.projection_override.as_ref().map(|value| &value.value)
    }

    pub fn set_projection_override_progress(
        &mut self,
        id: &str,
        progress: f32,
    ) -> Result<(), ProtocolEngineError> {
        if !progress.is_finite() || !(0.0..=1.0).contains(&progress) {
            return Err(ProtocolEngineError::InvalidProjectionOverride(
                "progress".into(),
            ));
        }
        let Some(projection) = &mut self.projection_override else {
            return Err(ProtocolEngineError::InvalidProjectionOverride(
                "no active override".into(),
            ));
        };
        if projection.value.id != id {
            return Err(ProtocolEngineError::InvalidProjectionOverride(format!(
                "expected {}, received {id}",
                projection.value.id
            )));
        }
        projection.value.progress = progress;
        Ok(())
    }

    #[must_use]
    pub fn visibility(&self) -> &VisibilityFilter {
        &self.visibility.filter
    }

    /// Canonical export/accessibility projection. Isolate removes hidden
    /// objects and every path without two visible endpoints. Every mode is
    /// constrained to the dynamic projection owner when present, otherwise the
    /// dominant authored semantic LOD projection.
    #[must_use]
    pub fn visible_snapshot(&self) -> SceneSnapshot {
        let dominant_lod = dominant_lod_range(&self.snapshot, self.camera.zoom() as f32);
        let visible_ids: HashSet<_> =
            self.snapshot
                .objects
                .iter()
                .enumerate()
                .filter(|(index, object)| {
                    self.visibility.visible_objects[*index]
                        && match self.projection_override.as_ref().and_then(|value| {
                            value.owned_representation(*index, self.reduced_motion)
                        }) {
                            Some(owner) => {
                                owner.is_some()
                                    && self
                                        .projection_override
                                        .as_ref()
                                        .and_then(|value| {
                                            value.object_opacity(*index, self.reduced_motion)
                                        })
                                        .is_some_and(|opacity| opacity > 0.001)
                            }
                            None => dominant_lod.is_some_and(|lod| {
                                object
                                    .representations
                                    .iter()
                                    .any(|representation| same_lod_range(representation.lod, lod))
                            }),
                        }
                })
                .map(|(_, object)| object.id.as_str())
                .collect();
        let mut objects: Vec<_> = self
            .snapshot
            .objects
            .iter()
            .enumerate()
            .filter(|(_, object)| visible_ids.contains(object.id.as_str()))
            .map(|(index, object)| {
                let mut object = object.clone();
                if let Some(Some(owner)) = self
                    .projection_override
                    .as_ref()
                    .and_then(|value| value.owned_representation(index, self.reduced_motion))
                {
                    object.representations = vec![object.representations[owner].clone()];
                    object.bounds = object.representations[0].bounds.unwrap_or(object.bounds);
                }
                if object
                    .parent_id
                    .as_ref()
                    .is_some_and(|parent| !visible_ids.contains(parent.as_str()))
                {
                    object.parent_id = None;
                }
                object
            })
            .collect();
        let paths = self
            .snapshot
            .paths
            .iter()
            .enumerate()
            .filter(|(index, path)| {
                self.visibility.visible_paths[*index]
                    && match self
                        .projection_override
                        .as_ref()
                        .and_then(|value| value.path_opacity(*index, self.reduced_motion))
                    {
                        Some(opacity) => opacity >= 0.5,
                        None => dominant_lod.is_some_and(|lod| same_lod_range(path.lod, lod)),
                    }
                    && visible_ids.contains(path.from_object_id.as_str())
                    && visible_ids.contains(path.to_object_id.as_str())
            })
            .map(|(_, path)| path.clone())
            .collect();
        objects.sort_by(|left, right| left.id.cmp(&right.id));
        SceneSnapshot {
            objects,
            paths,
            ..self.snapshot.clone()
        }
    }

    pub fn play_timeline(&mut self) {
        if let Some(timeline) = &mut self.timeline {
            if self.reduced_motion {
                timeline.pause();
            } else {
                timeline.play();
            }
        }
    }

    pub fn set_reduced_motion(&mut self, reduced_motion: bool) {
        self.reduced_motion = reduced_motion;
        if reduced_motion {
            self.pause_timeline();
        }
    }

    pub fn pause_timeline(&mut self) {
        if let Some(timeline) = &mut self.timeline {
            timeline.pause();
        }
    }

    pub fn seek_timeline(&mut self, position_ms: f64) {
        let camera = self.timeline.as_mut().and_then(|timeline| {
            timeline.seek(quantize_milliseconds(position_ms));
            timeline.sample_camera_with_motion(self.reduced_motion)
        });
        if let Some((center, zoom)) = camera {
            self.camera.set_center(center);
            self.camera.set_zoom(zoom);
        }
    }

    pub fn tick(&mut self, now_ms: f64) {
        self.lod.tick(now_ms);
        self.tick_patch_transition(now_ms);
        let camera = self.timeline.as_mut().and_then(|timeline| {
            let was_playing = timeline.is_playing();
            timeline.tick(now_ms);
            // A paused timeline remains available for highlight/effect
            // sampling, but no longer owns the camera. The `was_playing`
            // check still applies the final sample on the tick that ends play.
            was_playing
                .then(|| timeline.sample_camera_with_motion(self.reduced_motion))
                .flatten()
        });
        if let Some((center, zoom)) = camera {
            self.camera.set_center(center);
            self.camera.set_zoom(zoom);
        }
    }

    fn tick_patch_transition(&mut self, now_ms: f64) {
        let Some(playback) = &mut self.patch_transition else {
            return;
        };
        if let Some(previous) = playback.last_tick_ms {
            playback.position_ms += (now_ms - previous).max(0.0);
        }
        playback.last_tick_ms = Some(now_ms);
        let duration = f64::from(playback.transition.duration_ms).max(1.0);
        let linear = (playback.position_ms / duration).clamp(0.0, 1.0);
        let eased = apply_easing(playback.transition.easing, linear) as f32;
        for change in &playback.object_changes {
            self.snapshot.objects[change.snapshot_index] =
                interpolate_optional_object(change.from.as_ref(), change.target.as_ref(), eased);
        }
        for change in &playback.path_changes {
            self.snapshot.paths[change.snapshot_index] =
                interpolate_optional_path(change.from.as_ref(), change.target.as_ref(), eased);
        }
        self.snapshot.world_bounds = lerp_protocol_rect(
            playback.from_world_bounds,
            playback.target.world_bounds,
            eased,
        );
        self.spatial.refresh_path_bounds(
            &self.snapshot,
            playback
                .path_changes
                .iter()
                .map(|change| change.snapshot_index),
        );
        self.geometry_epoch = self.geometry_epoch.wrapping_add(1);
        if linear >= 1.0 {
            self.snapshot = playback.target.clone();
            self.patch_transition = None;
            self.lod_keys = ProtocolLodKeys::build(&self.snapshot);
            self.retained_view = None;
            self.lod.retain_snapshot_members(&self.snapshot);
            self.spatial = SpatialIndex::build(&self.snapshot);
            self.reresolve_projection_override();
        }
    }

    pub fn select_at(&mut self, screen_point: Vec2, tolerance_px: f64) -> Option<HitTarget> {
        let world_point = self.camera.screen_to_world(screen_point);
        let zoom = self.camera.zoom() as f32;
        let dominant_lod = dominant_lod_range(&self.snapshot, zoom);
        let tolerance_world = tolerance_px.max(1.0) / self.camera.zoom();
        let pick_bounds = Rect::new(
            world_point.x - tolerance_world,
            world_point.y - tolerance_world,
            tolerance_world * 2.0,
            tolerance_world * 2.0,
        );

        let mut object_candidates = self.spatial.query_objects(pick_bounds);
        if let Some(morph) = self
            .projection_override
            .as_ref()
            .and_then(|value| value.morph.as_ref())
        {
            object_candidates.extend(morph.object_indices.iter().copied());
            object_candidates.sort_unstable();
            object_candidates.dedup();
        }
        let mut objects: Vec<_> = object_candidates
            .into_iter()
            .filter(|index| self.visibility.visible_objects[*index])
            .filter(|index| {
                let object = &self.snapshot.objects[*index];
                object.pickable
                    && self
                        .projection_override
                        .as_ref()
                        .and_then(|value| value.object_pick(*index, self.reduced_motion))
                        .is_none_or(|(pickable, _)| pickable)
                    && object.representations.iter().enumerate().any(
                        |(representation_index, representation)| {
                            let projection_owned =
                                self.projection_override.as_ref().and_then(|value| {
                                    value.owned_representation(*index, self.reduced_motion)
                                });
                            let active = match projection_owned {
                                Some(owner) => owner == Some(representation_index),
                                None => {
                                    dominant_lod
                                        .is_some_and(|lod| same_lod_range(representation.lod, lod))
                                        && self.lod.is_active(
                                            &representation_key(&object.id, &representation.id),
                                            representation.lod,
                                            zoom,
                                        )
                                }
                            };
                            let spatial = self.projection_override.as_ref().map_or(
                                ProjectionSpatialState::IDENTITY,
                                |value| {
                                    value.spatial_for_object(
                                        &self.snapshot,
                                        *index,
                                        representation_index,
                                        self.reduced_motion,
                                    )
                                },
                            );
                            let inside_clip = spatial.clip[2] <= 0.0
                                || Rect::new(
                                    f64::from(spatial.clip[0]),
                                    f64::from(spatial.clip[1]),
                                    f64::from(spatial.clip[2]),
                                    f64::from(spatial.clip[3]),
                                )
                                .contains(world_point);
                            active
                                && inside_clip
                                && transform_rect(
                                    protocol_rect(representation.bounds.unwrap_or(object.bounds)),
                                    spatial.transform,
                                )
                                .contains(world_point)
                        },
                    )
            })
            .collect();
        objects.sort_by(|left, right| {
            let left_object = &self.snapshot.objects[*left];
            let right_object = &self.snapshot.objects[*right];
            let left_priority = self
                .projection_override
                .as_ref()
                .and_then(|value| value.object_pick(*left, self.reduced_motion))
                .map_or(0, |(_, priority)| priority);
            let right_priority = self
                .projection_override
                .as_ref()
                .and_then(|value| value.object_pick(*right, self.reduced_motion))
                .map_or(0, |(_, priority)| priority);
            let left_area = left_object.bounds.width * left_object.bounds.height;
            let right_area = right_object.bounds.width * right_object.bounds.height;
            if self.projection_override.is_some() {
                left_priority
                    .cmp(&right_priority)
                    .then_with(|| right_area.total_cmp(&left_area))
                    .then_with(|| right_object.id.cmp(&left_object.id))
            } else {
                left_object
                    .z_index
                    .cmp(&right_object.z_index)
                    .then_with(|| left_object.id.cmp(&right_object.id))
            }
        });
        let object_index = objects.last().copied();

        let mut path_candidates = self.spatial.query_paths(pick_bounds);
        if let Some(morph) = self
            .projection_override
            .as_ref()
            .and_then(|value| value.morph.as_ref())
        {
            path_candidates.extend(morph.path_indices.iter().copied());
            path_candidates.sort_unstable();
            path_candidates.dedup();
        }
        path_candidates.reverse();
        let mut matched_path_index = None;
        for path_index in path_candidates {
            let path = &self.snapshot.paths[path_index];
            if !self.visibility.visible_paths[path_index] || !path.pickable {
                continue;
            }
            let projection_opacity = self
                .projection_override
                .as_ref()
                .and_then(|value| value.path_opacity(path_index, self.reduced_motion));
            if projection_opacity.map_or_else(
                || !dominant_lod.is_some_and(|lod| same_lod_range(path.lod, lod)),
                |opacity| opacity < 0.5,
            ) {
                continue;
            }
            if projection_opacity.is_none()
                && !self.lod.is_active(&path_key(&path.id), path.lod, zoom)
            {
                continue;
            }
            let near_path = path.points.windows(2).any(|segment| {
                let spatial = self
                    .projection_override
                    .as_ref()
                    .map_or(ProjectionSpatialState::IDENTITY, |value| {
                        value.spatial_for_path(&self.snapshot, path_index, self.reduced_motion)
                    });
                let inside_clip = spatial.clip[2] <= 0.0
                    || Rect::new(
                        f64::from(spatial.clip[0]),
                        f64::from(spatial.clip[1]),
                        f64::from(spatial.clip[2]),
                        f64::from(spatial.clip[3]),
                    )
                    .contains(world_point);
                inside_clip
                    && point_to_segment_distance(
                        world_point,
                        transform_point(
                            Vec2::new(f64::from(segment[0].x), f64::from(segment[0].y)),
                            spatial.transform,
                        ),
                        transform_point(
                            Vec2::new(f64::from(segment[1].x), f64::from(segment[1].y)),
                            spatial.transform,
                        ),
                    ) <= tolerance_world
            });
            if near_path {
                matched_path_index = Some(path_index);
                break;
            }
        }

        if let Some(path_index) = matched_path_index {
            let path = &self.snapshot.paths[path_index];
            let path_beats_object = object_index.is_none_or(|object_index| {
                let object = &self.snapshot.objects[object_index];
                object.id != path.from_object_id
                    && object.id != path.to_object_id
                    && (object_is_ancestor_of(&self.snapshot, &object.id, &path.from_object_id)
                        || object_is_ancestor_of(&self.snapshot, &object.id, &path.to_object_id))
            });
            if path_beats_object {
                let target = HitTarget::Edge(path.id.clone());
                self.selected = Some(target.clone());
                return Some(target);
            }
        }
        if let Some(object_index) = object_index {
            let object = &self.snapshot.objects[object_index];
            let target = HitTarget::Node(object.id.clone());
            self.selected = Some(target.clone());
            return Some(target);
        }
        if let Some(path_index) = matched_path_index {
            let target = HitTarget::Edge(self.snapshot.paths[path_index].id.clone());
            self.selected = Some(target.clone());
            return Some(target);
        }
        self.selected = None;
        None
    }

    #[must_use]
    pub fn prepare_frame(&mut self, backend: RendererBackend) -> ProtocolFrame {
        let zoom = self.camera.zoom() as f32;
        let dominant_lod = dominant_lod_range(&self.snapshot, zoom);
        let world_view = self.camera.visible_world_rect();
        let (resident_view, _retained_lod_zoom, retained_view_reused) =
            self.retained_query_view(world_view, zoom);
        let timeline_frame = self
            .timeline
            .as_ref()
            .map(|timeline| timeline.sample_with_motion(self.reduced_motion));

        let mut object_candidates = self
            .spatial
            .query_objects_into(resident_view, &mut self.object_query_scratch)
            .to_vec();
        let mut path_candidates = self
            .spatial
            .query_paths_into(resident_view, &mut self.path_query_scratch)
            .to_vec();
        if let Some(morph) = self
            .projection_override
            .as_ref()
            .and_then(|value| value.morph.as_ref())
        {
            object_candidates.extend(morph.object_indices.iter().copied());
            object_candidates.sort_unstable();
            object_candidates.dedup();
            path_candidates.extend(morph.path_indices.iter().copied());
            path_candidates.sort_unstable();
            path_candidates.dedup();
        }
        let object_candidate_count = object_candidates.len();
        let path_candidate_count = path_candidates.len();
        let mut objects = Vec::with_capacity(object_candidate_count.saturating_mul(2));
        let mut visible_nodes = 0_u32;
        let mut visible_object_count = 0_u32;
        for candidate_index in 0..object_candidate_count {
            let object_index = object_candidates[candidate_index];
            let object = &self.snapshot.objects[object_index];
            let projection_weights = self.projection_override.as_ref().and_then(|value| {
                value.object_weights(
                    object_index,
                    object.representations.len(),
                    self.reduced_motion,
                )
            });
            let projection_content_weights = self.projection_override.as_ref().and_then(|value| {
                value.object_content_weights(
                    object_index,
                    object.representations.len(),
                    self.reduced_motion,
                )
            });
            if projection_weights.is_none()
                && !dominant_lod.is_some_and(|lod| {
                    object
                        .representations
                        .iter()
                        .any(|representation| same_lod_range(representation.lod, lod))
                })
            {
                continue;
            }
            let object_in_morph = self
                .projection_override
                .as_ref()
                .and_then(|value| value.morph.as_ref())
                .is_some_and(|morph| morph.object_indices.contains(&object_index));
            let object_bounds = protocol_rect(object.bounds);
            if !object_in_morph && !object_bounds.intersects(resident_view) {
                continue;
            }
            let mut object_visible = false;
            let projection_owned = projection_weights.is_some();
            let mut lod_weights: Vec<_> = projection_weights.unwrap_or_else(|| {
                object
                    .representations
                    .iter()
                    .enumerate()
                    .map(|(representation_index, representation)| {
                        let key = &self.lod_keys.objects[object_index][representation_index];
                        self.lod.visibility(key, representation.lod, zoom)
                    })
                    .collect()
            });
            if !projection_owned && lod_weights.len() > 1 {
                let total: f32 = lod_weights.iter().sum();
                if total > f32::EPSILON {
                    for weight in &mut lod_weights {
                        *weight /= total;
                    }
                }
            }
            let lod_weights = if projection_owned {
                lod_weights
            } else {
                self.lod
                    .resolve_object_weights(&object.id, &lod_weights, self.reduced_motion)
            };
            let content_weights = if projection_owned {
                projection_content_weights.unwrap_or_else(|| lod_weights.clone())
            } else {
                lod_weights.clone()
            };
            let timeline_opacity = timeline_frame
                .as_ref()
                .and_then(|frame| frame.object_opacity.get(object_index))
                .copied()
                .unwrap_or(1.0);
            let emphasis = timeline_frame
                .as_ref()
                .and_then(|frame| frame.object_emphasis.get(object_index))
                .copied()
                .unwrap_or(0.0);
            let visibility_opacity = self.visibility.object_opacity(object_index);
            let base_opacity = timeline_opacity * visibility_opacity;
            for (representation_index, lod_opacity) in lod_weights.into_iter().enumerate() {
                let key = &self.lod_keys.objects[object_index][representation_index];
                let spatial = self.projection_override.as_ref().map_or(
                    ProjectionSpatialState::IDENTITY,
                    |value| {
                        value.spatial_for_object(
                            &self.snapshot,
                            object_index,
                            representation_index,
                            self.reduced_motion,
                        )
                    },
                );
                let representation_bounds = transform_rect(
                    protocol_rect(
                        object.representations[representation_index]
                            .bounds
                            .unwrap_or(object.bounds),
                    ),
                    spatial.transform,
                );
                let representation_resident = representation_bounds.intersects(resident_view);
                debug_assert_eq!(
                    key,
                    &self.lod_keys.objects[object_index][representation_index]
                );
                let opacity = lod_opacity * timeline_opacity * visibility_opacity;
                let content_opacity =
                    content_weights[representation_index] * timeline_opacity * visibility_opacity;
                objects.push(ObjectDraw {
                    object_index,
                    representation_index,
                    opacity,
                    content_opacity,
                    lod_opacity,
                    base_opacity,
                    emphasis,
                    resident: representation_resident,
                    transform: spatial.transform,
                    clip: spatial.clip,
                });
                if opacity > 0.001 && representation_bounds.intersects(world_view) {
                    object_visible = true;
                }
            }
            if object_visible {
                visible_nodes += 1;
                visible_object_count += 1;
            }
        }
        let culled_nodes = self.snapshot.objects.len() as u32 - visible_object_count;

        let mut paths = Vec::with_capacity(path_candidate_count);
        let mut visible_edges = 0_u32;
        for candidate_index in 0..path_candidate_count {
            let path_index = path_candidates[candidate_index];
            let path = &self.snapshot.paths[path_index];
            let projection_opacity = self
                .projection_override
                .as_ref()
                .and_then(|value| value.path_opacity(path_index, self.reduced_motion));
            if projection_opacity.is_none()
                && !dominant_lod.is_some_and(|lod| same_lod_range(path.lod, lod))
            {
                continue;
            }
            let key = &self.lod_keys.paths[path_index];
            let opacity = projection_opacity
                .unwrap_or_else(|| self.lod.visibility(key, path.lod, zoom))
                * timeline_frame
                    .as_ref()
                    .and_then(|frame| frame.path_opacity.get(path_index))
                    .copied()
                    .unwrap_or(1.0)
                * self.visibility.path_opacity(path_index);
            let bounds = self.spatial.path_bounds(path_index).map(|bounds| {
                let spatial = self
                    .projection_override
                    .as_ref()
                    .map_or(ProjectionSpatialState::IDENTITY, |value| {
                        value.spatial_for_path(&self.snapshot, path_index, self.reduced_motion)
                    });
                transform_rect(bounds, spatial.transform).expand(f64::from(path.width))
            });
            let resident = bounds.is_some_and(|bounds| bounds.intersects(resident_view));
            if !resident {
                continue;
            }
            paths.push(PathDraw {
                path_index,
                opacity,
                emphasis: timeline_frame
                    .as_ref()
                    .and_then(|frame| frame.path_emphasis.get(path_index))
                    .copied()
                    .unwrap_or(0.0),
                flow_phase: timeline_frame
                    .as_ref()
                    .and_then(|frame| frame.path_flow_phase.get(path_index))
                    .copied()
                    .unwrap_or(0.0),
                color_override: timeline_frame
                    .as_ref()
                    .and_then(|frame| frame.path_color.get(path_index))
                    .copied()
                    .flatten(),
                resident,
                transform: self
                    .projection_override
                    .as_ref()
                    .map_or(ProjectionSpatialState::IDENTITY, |value| {
                        value.spatial_for_path(&self.snapshot, path_index, self.reduced_motion)
                    })
                    .transform,
                clip: self
                    .projection_override
                    .as_ref()
                    .map_or(ProjectionSpatialState::IDENTITY, |value| {
                        value.spatial_for_path(&self.snapshot, path_index, self.reduced_motion)
                    })
                    .clip,
            });
            if opacity > 0.001 && bounds.is_some_and(|bounds| bounds.intersects(world_view)) {
                visible_edges += 1;
            }
        }
        let culled_edges = self.snapshot.paths.len() as u32 - visible_edges;

        let diagnostics = FrameDiagnostics {
            backend,
            // The protocol supports arbitrary overlapping ranges; diagnostics use
            // the nearest conventional level solely for a compact UI readout.
            semantic_level: diagnostic_level(zoom),
            visible_nodes,
            visible_edges,
            candidate_nodes: object_candidate_count as u32,
            candidate_edges: path_candidate_count as u32,
            resident_nodes: object_candidate_count as u32,
            resident_edges: path_candidate_count as u32,
            retained_view_reused,
            culled_nodes,
            culled_edges,
            draw_calls: u32::from(!objects.is_empty()) + u32::from(!paths.is_empty()),
            frame_time_ms: 0.0,
        };
        ProtocolFrame {
            geometry_epoch: self.geometry_epoch,
            objects,
            paths,
            timeline: timeline_frame,
            lod: self
                .projection_override
                .as_ref()
                .and_then(|value| value.lod_frame(&self.snapshot, self.reduced_motion))
                .or_else(|| {
                    self.snapshot
                        .objects
                        .iter()
                        .find(|object| (2..=4).contains(&object.representations.len()))
                        .or_else(|| self.snapshot.objects.first())
                        .and_then(|object| self.lod.frame_for(object))
                }),
            diagnostics,
        }
    }

    fn retained_query_view(&mut self, world_view: Rect, zoom: f32) -> (Rect, f32, bool) {
        if let Some(retained) = self.retained_view {
            let zoom_ratio = zoom / retained.lod_zoom.max(f32::EPSILON);
            if retained.geometry_epoch == self.geometry_epoch
                && contains_rect(retained.bounds, world_view)
                && (RETAINED_ZOOM_MIN_RATIO..=RETAINED_ZOOM_MAX_RATIO).contains(&zoom_ratio)
            {
                return (retained.bounds, retained.lod_zoom, true);
            }
        }

        let margin_x = world_view.width * RETAINED_VIEW_MARGIN;
        let margin_y = world_view.height * RETAINED_VIEW_MARGIN;
        let retained = RetainedView {
            bounds: Rect::new(
                world_view.x - margin_x,
                world_view.y - margin_y,
                world_view.width + margin_x * 2.0,
                world_view.height + margin_y * 2.0,
            ),
            lod_zoom: zoom,
            geometry_epoch: self.geometry_epoch,
        };
        self.retained_view = Some(retained);
        (retained.bounds, retained.lod_zoom, false)
    }

    fn target_exists(&self, target: &HitTarget) -> bool {
        match target {
            HitTarget::Node(id) => self.snapshot.objects.iter().any(|object| object.id == *id),
            HitTarget::Edge(id) => self.snapshot.paths.iter().any(|path| path.id == *id),
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct ProtocolLodHandoff {
    from: usize,
    to: usize,
    started_ms: f64,
}

#[derive(Debug, Clone, Default)]
struct ProtocolLodState {
    active: HashMap<String, bool>,
    handoffs: HashMap<String, ProtocolLodHandoff>,
    now_ms: f64,
}

impl ProtocolLodState {
    fn tick(&mut self, now_ms: f64) {
        if now_ms.is_finite() {
            self.now_ms = self.now_ms.max(now_ms);
        }
    }

    fn is_active(&self, key: &str, range: LodRange, zoom: f32) -> bool {
        self.active
            .get(key)
            .copied()
            .unwrap_or_else(|| inside_range(range, zoom))
    }

    fn visibility(&mut self, key: &str, range: LodRange, zoom: f32) -> f32 {
        let was_active = self.is_active(key, range, zoom);
        let lower_enter = if range.min_zoom == 0.0 {
            0.0
        } else {
            range.min_zoom + range.hysteresis
        };
        let upper_enter = range
            .max_zoom
            .map(|max| (max - range.hysteresis).max(range.min_zoom));
        let next_active = if was_active {
            zoom >= (range.min_zoom - range.hysteresis).max(0.0)
                && range
                    .max_zoom
                    .is_none_or(|max| zoom <= max + range.hysteresis)
        } else {
            zoom >= lower_enter && upper_enter.is_none_or(|max| zoom <= max)
        };
        self.active.insert(key.to_owned(), next_active);
        if next_active {
            fade_alpha(range, zoom)
        } else {
            0.0
        }
    }

    fn resolve_object_weights(
        &mut self,
        object_id: &str,
        raw_weights: &[f32],
        reduced_motion: bool,
    ) -> Vec<f32> {
        if raw_weights.is_empty() {
            return Vec::new();
        }
        if raw_weights.iter().all(|weight| *weight <= f32::EPSILON) {
            self.handoffs.remove(object_id);
            return vec![0.0; raw_weights.len()];
        }
        if raw_weights.len() == 1 {
            self.handoffs.remove(object_id);
            return vec![raw_weights[0].clamp(0.0, 1.0)];
        }
        let strongest = raw_weights
            .iter()
            .enumerate()
            .max_by(|(_, left), (_, right)| left.total_cmp(right))
            .map_or(0, |(index, _)| index);
        let handoff = self
            .handoffs
            .entry(object_id.to_owned())
            .or_insert(ProtocolLodHandoff {
                from: strongest,
                to: strongest,
                started_ms: self.now_ms,
            });
        let target = if raw_weights
            .get(handoff.to)
            .is_some_and(|current| *current + 0.05 >= raw_weights[strongest] && *current > 0.0)
        {
            handoff.to
        } else {
            strongest
        };
        if reduced_motion {
            *handoff = ProtocolLodHandoff {
                from: target,
                to: target,
                started_ms: self.now_ms,
            };
        } else if target != handoff.to {
            let progress = lod_handoff_progress(*handoff, self.now_ms);
            let visible = if progress < 0.5 {
                handoff.from
            } else {
                handoff.to
            };
            *handoff = ProtocolLodHandoff {
                from: visible,
                to: target,
                started_ms: self.now_ms,
            };
        }
        let progress = if reduced_motion {
            1.0
        } else {
            lod_handoff_progress(*handoff, self.now_ms)
        };
        if progress >= 1.0 {
            handoff.from = handoff.to;
        }
        let mut weights = vec![0.0; raw_weights.len()];
        if handoff.from == handoff.to {
            weights[handoff.to] = 1.0;
        } else {
            let eased = apply_easing(Easing::EaseInOut, f64::from(progress)) as f32;
            weights[handoff.from] = 1.0 - eased;
            weights[handoff.to] = eased;
        }
        weights
    }

    fn frame_for(&self, object: &SceneObject) -> Option<ProtocolLodFrame> {
        let handoff = self.handoffs.get(&object.id)?;
        let progress = lod_handoff_progress(*handoff, self.now_ms);
        let transitioning = handoff.from != handoff.to && progress < 1.0;
        let current = object.representations.get(handoff.to)?;
        let previous = transitioning
            .then(|| object.representations.get(handoff.from))
            .flatten();
        let current_weight = if transitioning {
            apply_easing(Easing::EaseInOut, f64::from(progress)) as f32
        } else {
            1.0
        };
        Some(ProtocolLodFrame {
            object_id: object.id.clone(),
            current_representation_id: current.id.clone(),
            current_representation_index: handoff.to as u32,
            previous_representation_id: previous.map(|representation| representation.id.clone()),
            previous_representation_index: previous.map(|_| handoff.from as u32),
            transition_progress: if transitioning { progress } else { 1.0 },
            current_weight,
            previous_weight: 1.0 - current_weight,
            transitioning,
        })
    }

    fn retain_snapshot_members(&mut self, snapshot: &SceneSnapshot) {
        let mut keys = HashSet::new();
        for object in &snapshot.objects {
            for representation in &object.representations {
                keys.insert(representation_key(&object.id, &representation.id));
            }
        }
        for path in &snapshot.paths {
            keys.insert(path_key(&path.id));
        }
        self.active.retain(|key, _| keys.contains(key));
        self.handoffs.retain(|object_id, _| {
            snapshot
                .objects
                .iter()
                .any(|object| object.id == *object_id)
        });
    }
}

fn lod_handoff_progress(handoff: ProtocolLodHandoff, now_ms: f64) -> f32 {
    ((now_ms - handoff.started_ms).max(0.0) / f64::from(PROTOCOL_LOD_HANDOFF_DURATION_MS))
        .clamp(0.0, 1.0) as f32
}

fn inside_range(range: LodRange, zoom: f32) -> bool {
    zoom >= range.min_zoom && range.max_zoom.is_none_or(|max| zoom <= max)
}

fn fade_alpha(range: LodRange, zoom: f32) -> f32 {
    if range.fade_width <= f32::EPSILON {
        return f32::from(inside_range(range, zoom));
    }
    let lower = ((zoom - range.min_zoom) / range.fade_width).clamp(0.0, 1.0);
    let upper = range
        .max_zoom
        .map_or(1.0, |max| ((max - zoom) / range.fade_width).clamp(0.0, 1.0));
    lower.min(upper)
}

fn same_lod_range(left: LodRange, right: LodRange) -> bool {
    left.min_zoom.to_bits() == right.min_zoom.to_bits()
        && left.max_zoom.map(f32::to_bits) == right.max_zoom.map(f32::to_bits)
        && left.fade_width.to_bits() == right.fade_width.to_bits()
        && left.hysteresis.to_bits() == right.hysteresis.to_bits()
}

fn dominant_lod_range(snapshot: &SceneSnapshot, zoom: f32) -> Option<LodRange> {
    let mut ranges = Vec::new();
    for range in snapshot
        .objects
        .iter()
        .flat_map(|object| {
            object
                .representations
                .iter()
                .map(|representation| representation.lod)
        })
        .chain(snapshot.paths.iter().map(|path| path.lod))
    {
        if !ranges
            .iter()
            .any(|candidate| same_lod_range(*candidate, range))
        {
            ranges.push(range);
        }
    }
    ranges
        .into_iter()
        .filter_map(|range| {
            let weight = fade_alpha(range, zoom);
            (weight > f32::EPSILON).then_some((range, weight))
        })
        .max_by(|(left_range, left_weight), (right_range, right_weight)| {
            left_weight
                .total_cmp(right_weight)
                .then_with(|| left_range.min_zoom.total_cmp(&right_range.min_zoom))
        })
        .map(|(range, _)| range)
}

fn representation_key(object_id: &str, representation_id: &str) -> String {
    format!("object:{object_id}:{representation_id}")
}

fn path_key(path_id: &str) -> String {
    format!("path:{path_id}")
}

fn protocol_rect(rect: atlas_protocol::Rect) -> Rect {
    Rect::new(
        f64::from(rect.x),
        f64::from(rect.y),
        f64::from(rect.width),
        f64::from(rect.height),
    )
}

fn transform_point(point: Vec2, transform: [f32; 4]) -> Vec2 {
    Vec2::new(
        point.x * f64::from(transform[0]) + f64::from(transform[2]),
        point.y * f64::from(transform[1]) + f64::from(transform[3]),
    )
}

fn transform_rect(rect: Rect, transform: [f32; 4]) -> Rect {
    let top_left = transform_point(Vec2::new(rect.x, rect.y), transform);
    Rect::new(
        top_left.x,
        top_left.y,
        rect.width * f64::from(transform[0]),
        rect.height * f64::from(transform[1]),
    )
}

fn contains_rect(container: Rect, value: Rect) -> bool {
    value.min_x() >= container.min_x()
        && value.max_x() <= container.max_x()
        && value.min_y() >= container.min_y()
        && value.max_y() <= container.max_y()
}

fn object_is_ancestor_of(snapshot: &SceneSnapshot, ancestor_id: &str, descendant_id: &str) -> bool {
    let mut current_id = descendant_id;
    for _ in 0..snapshot.objects.len() {
        let Some(parent_id) = snapshot
            .objects
            .iter()
            .find(|object| object.id == current_id)
            .and_then(|object| object.parent_id.as_deref())
        else {
            return false;
        };
        if parent_id == ancestor_id {
            return true;
        }
        current_id = parent_id;
    }
    false
}

fn point_to_segment_distance(point: Vec2, start: Vec2, end: Vec2) -> f64 {
    let segment = end - start;
    let length_squared = segment.x * segment.x + segment.y * segment.y;
    if length_squared <= f64::EPSILON {
        return point.distance(start);
    }
    let from_start = point - start;
    let projection =
        ((from_start.x * segment.x + from_start.y * segment.y) / length_squared).clamp(0.0, 1.0);
    point.distance(start + segment * projection)
}

struct PreparedPatchAnimation {
    snapshot: SceneSnapshot,
    playback: PatchPlayback,
}

fn prepare_patch_animation(
    mut from: SceneSnapshot,
    mut target: SceneSnapshot,
    transition: Transition,
) -> PreparedPatchAnimation {
    normalize_snapshot_order(&mut from);
    normalize_snapshot_order(&mut target);
    let mut objects = Vec::with_capacity(from.objects.len().max(target.objects.len()));
    let mut object_changes = Vec::new();
    let (mut from_index, mut target_index) = (0, 0);
    while from_index < from.objects.len() || target_index < target.objects.len() {
        let from_object = from.objects.get(from_index);
        let target_object = target.objects.get(target_index);
        match (from_object, target_object) {
            (Some(from_object), Some(target_object)) => {
                use std::cmp::Ordering;
                match from_object.id.cmp(&target_object.id) {
                    Ordering::Equal => {
                        let snapshot_index = objects.len();
                        if from_object == target_object {
                            objects.push(target_object.clone());
                        } else {
                            objects.push(interpolate_object(from_object, target_object, 0.0));
                            object_changes.push(ObjectPatchAnimation {
                                snapshot_index,
                                from: Some(from_object.clone()),
                                target: Some(target_object.clone()),
                            });
                        }
                        from_index += 1;
                        target_index += 1;
                    }
                    Ordering::Less => {
                        let snapshot_index = objects.len();
                        objects.push(from_object.clone());
                        object_changes.push(ObjectPatchAnimation {
                            snapshot_index,
                            from: Some(from_object.clone()),
                            target: None,
                        });
                        from_index += 1;
                    }
                    Ordering::Greater => {
                        let snapshot_index = objects.len();
                        objects.push(fade_object(target_object.clone(), 0.0));
                        object_changes.push(ObjectPatchAnimation {
                            snapshot_index,
                            from: None,
                            target: Some(target_object.clone()),
                        });
                        target_index += 1;
                    }
                }
            }
            (Some(from_object), None) => {
                let snapshot_index = objects.len();
                objects.push(from_object.clone());
                object_changes.push(ObjectPatchAnimation {
                    snapshot_index,
                    from: Some(from_object.clone()),
                    target: None,
                });
                from_index += 1;
            }
            (None, Some(target_object)) => {
                let snapshot_index = objects.len();
                objects.push(fade_object(target_object.clone(), 0.0));
                object_changes.push(ObjectPatchAnimation {
                    snapshot_index,
                    from: None,
                    target: Some(target_object.clone()),
                });
                target_index += 1;
            }
            (None, None) => break,
        }
    }

    let mut paths = Vec::with_capacity(from.paths.len().max(target.paths.len()));
    let mut path_changes = Vec::new();
    let (mut from_index, mut target_index) = (0, 0);
    while from_index < from.paths.len() || target_index < target.paths.len() {
        let from_path = from.paths.get(from_index);
        let target_path = target.paths.get(target_index);
        match (from_path, target_path) {
            (Some(from_path), Some(target_path)) => {
                use std::cmp::Ordering;
                match from_path.id.cmp(&target_path.id) {
                    Ordering::Equal => {
                        let snapshot_index = paths.len();
                        if from_path == target_path {
                            paths.push(target_path.clone());
                        } else {
                            paths.push(interpolate_path(from_path, target_path, 0.0));
                            path_changes.push(PathPatchAnimation {
                                snapshot_index,
                                from: Some(from_path.clone()),
                                target: Some(target_path.clone()),
                            });
                        }
                        from_index += 1;
                        target_index += 1;
                    }
                    Ordering::Less => {
                        let snapshot_index = paths.len();
                        paths.push(from_path.clone());
                        path_changes.push(PathPatchAnimation {
                            snapshot_index,
                            from: Some(from_path.clone()),
                            target: None,
                        });
                        from_index += 1;
                    }
                    Ordering::Greater => {
                        let snapshot_index = paths.len();
                        paths.push(fade_path(target_path.clone(), 0.0));
                        path_changes.push(PathPatchAnimation {
                            snapshot_index,
                            from: None,
                            target: Some(target_path.clone()),
                        });
                        target_index += 1;
                    }
                }
            }
            (Some(from_path), None) => {
                let snapshot_index = paths.len();
                paths.push(from_path.clone());
                path_changes.push(PathPatchAnimation {
                    snapshot_index,
                    from: Some(from_path.clone()),
                    target: None,
                });
                from_index += 1;
            }
            (None, Some(target_path)) => {
                let snapshot_index = paths.len();
                paths.push(fade_path(target_path.clone(), 0.0));
                path_changes.push(PathPatchAnimation {
                    snapshot_index,
                    from: None,
                    target: Some(target_path.clone()),
                });
                target_index += 1;
            }
            (None, None) => break,
        }
    }

    let snapshot = SceneSnapshot {
        protocol_version: target.protocol_version,
        scene_id: target.scene_id.clone(),
        revision: target.revision,
        world_bounds: from.world_bounds,
        objects,
        paths,
    };
    let playback = PatchPlayback {
        target,
        object_changes,
        path_changes,
        from_world_bounds: from.world_bounds,
        transition,
        position_ms: 0.0,
        last_tick_ms: None,
    };
    PreparedPatchAnimation { snapshot, playback }
}

fn normalize_snapshot_order(snapshot: &mut SceneSnapshot) {
    snapshot
        .objects
        .sort_by(|left, right| left.id.cmp(&right.id));
    for object in &mut snapshot.objects {
        object
            .representations
            .sort_by(|left, right| left.id.cmp(&right.id));
    }
    snapshot.paths.sort_by(|left, right| left.id.cmp(&right.id));
}

fn interpolate_optional_object(
    from: Option<&SceneObject>,
    target: Option<&SceneObject>,
    amount: f32,
) -> SceneObject {
    match (from, target) {
        (Some(from), Some(target)) => interpolate_object(from, target, amount),
        (Some(from), None) => fade_object(from.clone(), 1.0 - amount),
        (None, Some(target)) => fade_object(target.clone(), amount),
        (None, None) => unreachable!("a patch animation always has at least one endpoint"),
    }
}

fn interpolate_optional_path(
    from: Option<&ScenePath>,
    target: Option<&ScenePath>,
    amount: f32,
) -> ScenePath {
    match (from, target) {
        (Some(from), Some(target)) => interpolate_path(from, target, amount),
        (Some(from), None) => fade_path(from.clone(), 1.0 - amount),
        (None, Some(target)) => fade_path(target.clone(), amount),
        (None, None) => unreachable!("a patch animation always has at least one endpoint"),
    }
}

fn interpolate_object(from: &SceneObject, target: &SceneObject, amount: f32) -> SceneObject {
    let mut representations =
        Vec::with_capacity(from.representations.len().max(target.representations.len()));
    let (mut from_index, mut target_index) = (0, 0);
    while from_index < from.representations.len() || target_index < target.representations.len() {
        let from_representation = from.representations.get(from_index);
        let target_representation = target.representations.get(target_index);
        match (from_representation, target_representation) {
            (Some(from_representation), Some(target_representation)) => {
                use std::cmp::Ordering;
                match from_representation.id.cmp(&target_representation.id) {
                    Ordering::Equal => {
                        let mut representation = target_representation.clone();
                        representation.primitives = interpolate_primitives(
                            &from_representation.primitives,
                            &target_representation.primitives,
                            amount,
                        );
                        representation.bounds =
                            match (from_representation.bounds, target_representation.bounds) {
                                (Some(from), Some(target)) => {
                                    Some(lerp_protocol_rect(from, target, amount))
                                }
                                (Some(from), None) if amount < 0.5 => Some(from),
                                (None, Some(target)) if amount >= 0.5 => Some(target),
                                _ => None,
                            };
                        representations.push(representation);
                        from_index += 1;
                        target_index += 1;
                    }
                    Ordering::Less => {
                        let mut representation = from_representation.clone();
                        fade_primitives(&mut representation.primitives, 1.0 - amount);
                        representations.push(representation);
                        from_index += 1;
                    }
                    Ordering::Greater => {
                        let mut representation = target_representation.clone();
                        fade_primitives(&mut representation.primitives, amount);
                        representations.push(representation);
                        target_index += 1;
                    }
                }
            }
            (Some(from_representation), None) => {
                let mut representation = from_representation.clone();
                fade_primitives(&mut representation.primitives, 1.0 - amount);
                representations.push(representation);
                from_index += 1;
            }
            (None, Some(target_representation)) => {
                let mut representation = target_representation.clone();
                fade_primitives(&mut representation.primitives, amount);
                representations.push(representation);
                target_index += 1;
            }
            (None, None) => break,
        }
    }
    SceneObject {
        id: target.id.clone(),
        parent_id: if amount < 0.5 {
            from.parent_id.clone()
        } else {
            target.parent_id.clone()
        },
        z_index: if amount < 0.5 {
            from.z_index
        } else {
            target.z_index
        },
        bounds: lerp_protocol_rect(from.bounds, target.bounds, amount),
        pickable: if amount < 0.5 {
            from.pickable
        } else {
            target.pickable
        },
        representations,
    }
}

fn fade_object(mut object: SceneObject, opacity: f32) -> SceneObject {
    for representation in &mut object.representations {
        fade_primitives(&mut representation.primitives, opacity);
    }
    object.pickable &= opacity > 0.5;
    object
}

fn interpolate_primitives(from: &[Primitive], target: &[Primitive], amount: f32) -> Vec<Primitive> {
    let mut primitives = Vec::with_capacity(from.len().max(target.len()));
    let count = from.len().max(target.len());
    for index in 0..count {
        match (from.get(index), target.get(index)) {
            (Some(from), Some(target)) => {
                if let Some(primitive) = interpolate_primitive(from, target, amount) {
                    primitives.push(primitive);
                } else {
                    let mut old = from.clone();
                    fade_primitive(&mut old, 1.0 - amount);
                    primitives.push(old);
                    let mut new = target.clone();
                    fade_primitive(&mut new, amount);
                    primitives.push(new);
                }
            }
            (Some(from), None) => {
                let mut primitive = from.clone();
                fade_primitive(&mut primitive, 1.0 - amount);
                primitives.push(primitive);
            }
            (None, Some(target)) => {
                let mut primitive = target.clone();
                fade_primitive(&mut primitive, amount);
                primitives.push(primitive);
            }
            (None, None) => {}
        }
    }
    primitives
}

fn interpolate_primitive(from: &Primitive, target: &Primitive, amount: f32) -> Option<Primitive> {
    match (from, target) {
        (
            Primitive::RoundedRect {
                rect: from_rect,
                radius: from_radius,
                fill: from_fill,
                stroke: from_stroke,
            },
            Primitive::RoundedRect {
                rect: target_rect,
                radius: target_radius,
                fill: target_fill,
                stroke: target_stroke,
            },
        ) => Some(Primitive::RoundedRect {
            rect: lerp_protocol_rect(*from_rect, *target_rect, amount),
            radius: lerp_f32(*from_radius, *target_radius, amount),
            fill: lerp_color(*from_fill, *target_fill, amount),
            stroke: interpolate_stroke(*from_stroke, *target_stroke, amount),
        }),
        (
            Primitive::Circle {
                center: from_center,
                radius: from_radius,
                fill: from_fill,
                stroke: from_stroke,
            },
            Primitive::Circle {
                center: target_center,
                radius: target_radius,
                fill: target_fill,
                stroke: target_stroke,
            },
        ) => Some(Primitive::Circle {
            center: lerp_point(*from_center, *target_center, amount),
            radius: lerp_f32(*from_radius, *target_radius, amount),
            fill: lerp_color(*from_fill, *target_fill, amount),
            stroke: interpolate_stroke(*from_stroke, *target_stroke, amount),
        }),
        (
            Primitive::Text {
                position: from_position,
                max_width: from_width,
                content: from_content,
                font_family: from_family,
                font_size: from_size,
                color: from_color,
                align: from_align,
            },
            Primitive::Text {
                position: target_position,
                max_width: target_width,
                content: target_content,
                font_family: target_family,
                font_size: target_size,
                color: target_color,
                align: target_align,
            },
        ) if from_content == target_content
            && from_family == target_family
            && from_align == target_align =>
        {
            Some(Primitive::Text {
                position: lerp_point(*from_position, *target_position, amount),
                max_width: lerp_f32(*from_width, *target_width, amount),
                content: target_content.clone(),
                font_family: target_family.clone(),
                font_size: lerp_f32(*from_size, *target_size, amount),
                color: lerp_color(*from_color, *target_color, amount),
                align: *target_align,
            })
        }
        (
            Primitive::Icon {
                position: from_position,
                size: from_size,
                name: from_name,
                color: from_color,
            },
            Primitive::Icon {
                position: target_position,
                size: target_size,
                name: target_name,
                color: target_color,
            },
        ) if from_name == target_name => Some(Primitive::Icon {
            position: lerp_point(*from_position, *target_position, amount),
            size: lerp_f32(*from_size, *target_size, amount),
            name: target_name.clone(),
            color: lerp_color(*from_color, *target_color, amount),
        }),
        _ => None,
    }
}

fn interpolate_stroke(
    from: Option<atlas_protocol::Stroke>,
    target: Option<atlas_protocol::Stroke>,
    amount: f32,
) -> Option<atlas_protocol::Stroke> {
    match (from, target) {
        (Some(from), Some(target)) => Some(atlas_protocol::Stroke {
            color: lerp_color(from.color, target.color, amount),
            width: lerp_f32(from.width, target.width, amount),
        }),
        (Some(mut from), None) => {
            from.color[3] *= 1.0 - amount;
            Some(from)
        }
        (None, Some(mut target)) => {
            target.color[3] *= amount;
            Some(target)
        }
        (None, None) => None,
    }
}

fn fade_primitives(primitives: &mut [Primitive], opacity: f32) {
    for primitive in primitives {
        fade_primitive(primitive, opacity);
    }
}

fn fade_primitive(primitive: &mut Primitive, opacity: f32) {
    match primitive {
        Primitive::RoundedRect { fill, stroke, .. } | Primitive::Circle { fill, stroke, .. } => {
            fill[3] *= opacity;
            if let Some(stroke) = stroke {
                stroke.color[3] *= opacity;
            }
        }
        Primitive::Text { color, .. } | Primitive::Icon { color, .. } => color[3] *= opacity,
    }
}

fn interpolate_path(from: &ScenePath, target: &ScenePath, amount: f32) -> ScenePath {
    let points = if from.points.len() == target.points.len() {
        from.points
            .iter()
            .zip(&target.points)
            .map(|(from, target)| lerp_point(*from, *target, amount))
            .collect()
    } else if amount < 0.5 {
        from.points.clone()
    } else {
        target.points.clone()
    };
    ScenePath {
        id: target.id.clone(),
        from_object_id: target.from_object_id.clone(),
        to_object_id: target.to_object_id.clone(),
        points,
        stroke: lerp_color(from.stroke, target.stroke, amount),
        width: lerp_f32(from.width, target.width, amount),
        arrow: if amount < 0.5 {
            from.arrow
        } else {
            target.arrow
        },
        optional: if amount < 0.5 {
            from.optional
        } else {
            target.optional
        },
        pickable: if amount < 0.5 {
            from.pickable
        } else {
            target.pickable
        },
        lod: target.lod,
    }
}

fn fade_path(mut path: ScenePath, opacity: f32) -> ScenePath {
    path.stroke[3] *= opacity;
    path.pickable &= opacity > 0.5;
    path
}

fn lerp_protocol_rect(
    from: atlas_protocol::Rect,
    target: atlas_protocol::Rect,
    amount: f32,
) -> atlas_protocol::Rect {
    atlas_protocol::Rect {
        x: lerp_f32(from.x, target.x, amount),
        y: lerp_f32(from.y, target.y, amount),
        width: lerp_f32(from.width, target.width, amount),
        height: lerp_f32(from.height, target.height, amount),
    }
}

fn lerp_point(
    from: atlas_protocol::Point,
    target: atlas_protocol::Point,
    amount: f32,
) -> atlas_protocol::Point {
    atlas_protocol::Point {
        x: lerp_f32(from.x, target.x, amount),
        y: lerp_f32(from.y, target.y, amount),
    }
}

fn lerp_color(from: ProtocolColor, target: ProtocolColor, amount: f32) -> ProtocolColor {
    [
        lerp_f32(from[0], target[0], amount),
        lerp_f32(from[1], target[1], amount),
        lerp_f32(from[2], target[2], amount),
        lerp_f32(from[3], target[3], amount),
    ]
}

fn lerp_f32(from: f32, target: f32, amount: f32) -> f32 {
    from + (target - from) * amount
}

fn diagnostic_level(zoom: f32) -> crate::SemanticLevel {
    if zoom >= 7.1 {
        crate::SemanticLevel::Code
    } else if zoom >= 3.35 {
        crate::SemanticLevel::Component
    } else if zoom >= 1.16 {
        crate::SemanticLevel::Container
    } else {
        crate::SemanticLevel::Context
    }
}

#[derive(Debug, Clone)]
pub struct ProtocolTimelinePlayer {
    duration_ms: u32,
    looped: bool,
    keyframes: Vec<ResolvedTimelineKeyframe>,
    position_ms: u32,
    exact_position_ms: f64,
    playing: bool,
    last_tick_ms: Option<f64>,
    initial_camera: Camera,
}

#[derive(Debug, Clone, Copy)]
struct ResolvedObjectState {
    opacity: f32,
    emphasis: f32,
}

impl Default for ResolvedObjectState {
    fn default() -> Self {
        Self {
            opacity: 1.0,
            emphasis: 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct ResolvedPathState {
    opacity: f32,
    emphasis: f32,
    flow_speed: f32,
    color: Option<ProtocolColor>,
}

impl Default for ResolvedPathState {
    fn default() -> Self {
        Self {
            opacity: 1.0,
            emphasis: 0.0,
            flow_speed: 0.0,
            color: None,
        }
    }
}

#[derive(Debug, Clone)]
struct ResolvedTimelineKeyframe {
    id: String,
    at_ms: u32,
    easing: Easing,
    camera: Option<(Vec2, f64)>,
    objects: Vec<ResolvedObjectState>,
    paths: Vec<ResolvedPathState>,
}

impl ProtocolTimelinePlayer {
    #[must_use]
    pub fn try_new(
        timeline: Timeline,
        snapshot: &SceneSnapshot,
        initial_camera: Camera,
    ) -> Result<Self, ProtocolEngineError> {
        timeline.validate_for(snapshot)?;
        let object_by_id: HashMap<_, _> = snapshot
            .objects
            .iter()
            .enumerate()
            .map(|(index, object)| (object.id.as_str(), index))
            .collect();
        let path_by_id: HashMap<_, _> = snapshot
            .paths
            .iter()
            .enumerate()
            .map(|(index, path)| (path.id.as_str(), index))
            .collect();
        let mut keyframes = Vec::with_capacity(timeline.keyframes.len());
        for keyframe in timeline.keyframes {
            let mut objects = vec![ResolvedObjectState::default(); snapshot.objects.len()];
            for state in keyframe.object_states {
                for id in state.object_ids {
                    let index = object_by_id[&id.as_str()];
                    objects[index] = ResolvedObjectState {
                        opacity: state.opacity,
                        emphasis: state.emphasis,
                    };
                }
            }
            let mut paths = vec![ResolvedPathState::default(); snapshot.paths.len()];
            for state in keyframe.path_states {
                for id in state.path_ids {
                    let index = path_by_id[&id.as_str()];
                    paths[index] = ResolvedPathState {
                        opacity: state.opacity,
                        emphasis: state.emphasis,
                        flow_speed: state.flow_speed,
                        color: state.color,
                    };
                }
            }
            keyframes.push(ResolvedTimelineKeyframe {
                id: keyframe.id,
                at_ms: keyframe.at_ms,
                easing: keyframe.easing,
                camera: keyframe.camera.map(|camera| {
                    (
                        Vec2::new(f64::from(camera.center.x), f64::from(camera.center.y)),
                        f64::from(camera.zoom),
                    )
                }),
                objects,
                paths,
            });
        }
        Ok(Self {
            duration_ms: timeline.duration_ms,
            looped: timeline.looped,
            keyframes,
            position_ms: 0,
            exact_position_ms: 0.0,
            playing: false,
            last_tick_ms: None,
            initial_camera,
        })
    }

    pub fn play(&mut self) {
        self.playing = true;
        self.last_tick_ms = None;
    }

    pub fn pause(&mut self) {
        self.playing = false;
        self.last_tick_ms = None;
    }

    #[must_use]
    pub fn is_playing(&self) -> bool {
        self.playing
    }

    pub fn seek(&mut self, position_ms: u32) {
        self.position_ms = position_ms.min(self.duration_ms);
        self.exact_position_ms = f64::from(self.position_ms);
        self.last_tick_ms = None;
    }

    pub fn tick(&mut self, now_ms: f64) {
        if !self.playing {
            return;
        }
        if let Some(previous) = self.last_tick_ms {
            let elapsed = (now_ms - previous).max(0.0);
            self.exact_position_ms += elapsed;
            let duration = f64::from(self.duration_ms);
            if self.exact_position_ms >= duration {
                if self.looped && duration > 0.0 {
                    self.exact_position_ms %= duration;
                } else {
                    self.exact_position_ms = duration;
                    self.playing = false;
                }
            }
            self.position_ms = self.exact_position_ms.floor() as u32;
        }
        self.last_tick_ms = Some(now_ms);
    }

    #[must_use]
    pub fn sample(&self) -> ProtocolTimelineFrame {
        self.sample_with_motion(false)
    }

    #[must_use]
    pub fn sample_with_motion(&self, reduced_motion: bool) -> ProtocolTimelineFrame {
        let (source, target, linear) = self.sample_segment();
        let amount = if reduced_motion {
            1.0
        } else {
            target.map_or(0.0, |target| apply_easing(target.easing, linear))
        };
        let camera = target.and_then(|target| {
            target.camera.map(|target_camera| {
                let source_camera = source
                    .and_then(|source| source.camera)
                    .unwrap_or((self.initial_camera.center(), self.initial_camera.zoom()));
                (
                    source_camera.0.lerp(target_camera.0, amount),
                    interpolate_log_zoom(source_camera.1, target_camera.1, amount),
                )
            })
        });
        let (camera_center, camera_zoom) =
            camera.unwrap_or((self.initial_camera.center(), self.initial_camera.zoom()));
        let object_count = target
            .map(|target| target.objects.len())
            .or_else(|| source.map(|source| source.objects.len()))
            .unwrap_or(0);
        let path_count = target
            .map(|target| target.paths.len())
            .or_else(|| source.map(|source| source.paths.len()))
            .unwrap_or(0);
        let mut object_emphasis = Vec::with_capacity(object_count);
        let mut object_opacity = Vec::with_capacity(object_count);
        for index in 0..object_count {
            let from = source
                .map(|source| source.objects[index])
                .unwrap_or_default();
            let to = target.map(|target| target.objects[index]).unwrap_or(from);
            object_opacity.push(lerp_f32(from.opacity, to.opacity, amount as f32));
            object_emphasis.push(lerp_f32(from.emphasis, to.emphasis, amount as f32));
        }
        let mut path_emphasis = Vec::with_capacity(path_count);
        let mut path_opacity = Vec::with_capacity(path_count);
        let mut path_flow_phase = Vec::with_capacity(path_count);
        let mut path_color = Vec::with_capacity(path_count);
        for index in 0..path_count {
            let from = source.map(|source| source.paths[index]).unwrap_or_default();
            let to = target.map(|target| target.paths[index]).unwrap_or(from);
            let amount = amount as f32;
            path_opacity.push(lerp_f32(from.opacity, to.opacity, amount));
            path_emphasis.push(lerp_f32(from.emphasis, to.emphasis, amount));
            let speed = lerp_f32(from.flow_speed, to.flow_speed, amount);
            let phase = if reduced_motion || speed <= f32::EPSILON {
                0.0
            } else {
                ((f64::from(self.position_ms) / 1_000.0) * f64::from(speed)).fract() as f32
            };
            path_flow_phase.push(phase);
            path_color.push(interpolate_optional_color(from.color, to.color, amount));
        }
        ProtocolTimelineFrame {
            keyframe_id: target.or(source).map(|keyframe| keyframe.id.clone()),
            position_ms: self.position_ms,
            camera_active: camera.is_some(),
            camera_center,
            camera_zoom,
            object_emphasis,
            object_opacity,
            path_emphasis,
            path_opacity,
            path_flow_phase,
            path_color,
        }
    }

    /// Returns a camera sample only when the active cue contains an explicit
    /// camera effect. Highlight-only timelines therefore never acquire camera
    /// ownership merely because they are installed or sampled.
    #[must_use]
    pub fn sample_camera(&self) -> Option<(Vec2, f64)> {
        self.sample_camera_with_motion(false)
    }

    #[must_use]
    pub fn sample_camera_with_motion(&self, reduced_motion: bool) -> Option<(Vec2, f64)> {
        let frame = self.sample_with_motion(reduced_motion);
        frame
            .camera_active
            .then_some((frame.camera_center, frame.camera_zoom))
    }

    fn sample_segment(
        &self,
    ) -> (
        Option<&ResolvedTimelineKeyframe>,
        Option<&ResolvedTimelineKeyframe>,
        f64,
    ) {
        if self.keyframes.is_empty() {
            return (None, None, 0.0);
        }
        let target_index = self
            .keyframes
            .partition_point(|keyframe| keyframe.at_ms < self.position_ms);
        if target_index >= self.keyframes.len() {
            let final_keyframe = self.keyframes.last();
            return (final_keyframe, final_keyframe, 1.0);
        }
        let target = &self.keyframes[target_index];
        let source = target_index
            .checked_sub(1)
            .and_then(|index| self.keyframes.get(index));
        let source_at = source.map_or(0, |source| source.at_ms);
        let duration = target.at_ms.saturating_sub(source_at);
        let linear = if duration == 0 {
            1.0
        } else {
            f64::from(self.position_ms.saturating_sub(source_at)) / f64::from(duration)
        };
        (source, Some(target), linear.clamp(0.0, 1.0))
    }
}

fn interpolate_optional_color(
    from: Option<ProtocolColor>,
    target: Option<ProtocolColor>,
    amount: f32,
) -> Option<ProtocolColor> {
    match (from, target) {
        (Some(from), Some(target)) => Some(lerp_color(from, target, amount)),
        (None, Some(target)) if amount > 0.0 => {
            Some([target[0], target[1], target[2], target[3] * amount])
        }
        (Some(from), None) if amount < 1.0 => {
            Some([from[0], from[1], from[2], from[3] * (1.0 - amount)])
        }
        _ => None,
    }
}

fn interpolate_log_zoom(source: f64, target: f64, amount: f64) -> f64 {
    (source.ln() + (target.ln() - source.ln()) * amount).exp()
}

fn quantize_milliseconds(value: f64) -> u32 {
    if !value.is_finite() || value <= 0.0 {
        0
    } else if value >= f64::from(u32::MAX) {
        u32::MAX
    } else {
        value.round() as u32
    }
}

fn apply_easing(easing: Easing, value: f64) -> f64 {
    match easing {
        Easing::Linear => value,
        Easing::EaseInOut => {
            if value < 0.5 {
                4.0 * value.powi(3)
            } else {
                1.0 - (-2.0 * value + 2.0).powi(3) / 2.0
            }
        }
        Easing::EaseOut => 1.0 - (1.0 - value).powi(4),
    }
}

#[cfg(test)]
mod tests {
    use atlas_protocol::{
        CameraKeyframeState, ObjectKeyframeState, Point, TIMELINE_VERSION, TimelineKeyframe,
    };

    use super::*;
    use crate::CameraLimits;

    const SYSTEM_OBJECT_ID: &str = "visual-node:lineage:system:okie";
    const ARCHITECTURE_MODEL_OBJECT_ID: &str = "visual-node:lineage:container:architecture-model";

    fn fixture() -> (SceneSnapshot, Timeline, Camera) {
        let snapshot: SceneSnapshot =
            serde_json::from_str(include_str!("../../../fixtures/renderer/demo-scene.json"))
                .unwrap();
        let timeline: Timeline = serde_json::from_str(include_str!(
            "../../../fixtures/renderer/demo-timeline.json"
        ))
        .unwrap();
        let camera = Camera::new(
            Vec2::new(0.0, 0.0),
            0.5,
            Viewport::new(1200.0, 800.0, 1.0),
            CameraLimits::default(),
        );
        (snapshot, timeline, camera)
    }

    #[test]
    fn protocol_fixture_prepares_overlapping_representations() {
        let (snapshot, _, camera) = fixture();
        let mut engine = ProtocolEngine::try_new(snapshot, camera).unwrap();
        engine.camera_mut().set_center(Vec2::new(1060.0, 245.0));
        engine.camera_mut().set_zoom(0.62);
        engine.tick(0.0);
        let _ = engine.prepare_frame(RendererBackend::Headless);
        engine.camera_mut().set_zoom(1.25);
        engine.tick(10.0);
        let _ = engine.prepare_frame(RendererBackend::Headless);
        engine.tick(110.0);
        let frame = engine.prepare_frame(RendererBackend::Headless);
        let system_representations = frame
            .objects
            .iter()
            .filter(|draw| engine.snapshot().objects[draw.object_index].id == SYSTEM_OBJECT_ID)
            .collect::<Vec<_>>();
        assert_eq!(system_representations.len(), 4);
        assert_eq!(
            system_representations
                .iter()
                .filter(|draw| draw.opacity > f32::EPSILON)
                .count(),
            2
        );
        assert!(system_representations.iter().any(|draw| draw.resident));
    }

    #[test]
    fn retained_view_reuses_small_frames_and_boundary_crossing_updates_sparse_residency() {
        let (snapshot, _, camera) = fixture();
        let mut engine = ProtocolEngine::try_new(snapshot, camera).unwrap();
        let first = engine.prepare_frame(RendererBackend::Headless);
        assert!(!first.diagnostics.retained_view_reused);

        engine.pan_screen(Vec2::new(1.0, 1.0));
        let small_pan = engine.prepare_frame(RendererBackend::Headless);
        assert!(small_pan.diagnostics.retained_view_reused);
        assert_eq!(small_pan.objects, first.objects);
        assert_eq!(small_pan.paths, first.paths);
        assert_eq!(small_pan.geometry_epoch, first.geometry_epoch);

        engine.pan_screen(Vec2::new(500.0, 0.0));
        let boundary_crossing = engine.prepare_frame(RendererBackend::Headless);
        assert!(!boundary_crossing.diagnostics.retained_view_reused);
        assert_ne!(
            boundary_crossing
                .objects
                .iter()
                .map(|draw| (draw.object_index, draw.representation_index))
                .collect::<Vec<_>>(),
            first
                .objects
                .iter()
                .map(|draw| (draw.object_index, draw.representation_index))
                .collect::<Vec<_>>()
        );
        assert!(boundary_crossing.objects.iter().any(|draw| draw.resident));
        assert!(boundary_crossing.paths.iter().all(|draw| draw.resident));
        assert_eq!(boundary_crossing.geometry_epoch, first.geometry_epoch);
        assert!(boundary_crossing.diagnostics.visible_nodes <= first.diagnostics.visible_nodes);

        // Persistent C4 owner shells intentionally use identical bounds across
        // bands. Give this residency-specific fixture a distant code extent so
        // the test continues to exercise mixed sparse residency independently
        // of the product fixture's persistent-shell geometry.
        let (mut residency_snapshot, _, residency_camera) = fixture();
        let system = residency_snapshot
            .objects
            .iter_mut()
            .find(|object| object.id == SYSTEM_OBJECT_ID)
            .unwrap();
        let mut code_bounds = system.representations[3].bounds.unwrap();
        code_bounds.width = 5_408.0;
        code_bounds.height = 2_126.0;
        system.representations[3].bounds = Some(code_bounds);
        system.bounds = code_bounds;
        let mut engine = ProtocolEngine::try_new(residency_snapshot, residency_camera).unwrap();
        let system = engine
            .snapshot()
            .objects
            .iter()
            .find(|object| object.id == SYSTEM_OBJECT_ID)
            .unwrap();
        let code_bounds = system.representations[3].bounds.unwrap();
        engine.camera_mut().set_center(Vec2::new(
            f64::from(code_bounds.x + code_bounds.width - 100.0),
            f64::from(code_bounds.y + 100.0),
        ));
        engine.camera_mut().set_zoom(2.05);
        let representation_edge = engine.prepare_frame(RendererBackend::Headless);
        let system_draws = representation_edge
            .objects
            .iter()
            .filter(|draw| engine.snapshot().objects[draw.object_index].id == SYSTEM_OBJECT_ID)
            .collect::<Vec<_>>();
        assert!(system_draws.iter().any(|draw| draw.resident));
        assert!(system_draws.iter().any(|draw| !draw.resident));
    }

    #[test]
    fn patch_animation_tracks_only_changed_members() {
        let (snapshot, _, _) = fixture();
        let mut target = snapshot.clone();
        target.revision += 1;
        target.objects[0].bounds.x += 200.0;
        let prepared = prepare_patch_animation(
            snapshot.clone(),
            target,
            Transition {
                duration_ms: 1_000,
                easing: Easing::Linear,
            },
        );

        assert_eq!(prepared.playback.object_changes.len(), 1);
        assert!(prepared.playback.path_changes.is_empty());
        assert_eq!(prepared.snapshot.objects.len(), snapshot.objects.len());
        assert_eq!(prepared.snapshot.paths, snapshot.paths);
    }

    #[test]
    fn timeline_sampling_is_reproducible() {
        let (snapshot, timeline, camera) = fixture();
        let expected_path_id = timeline
            .keyframes
            .iter()
            .find(|keyframe| keyframe.id == "step:containers:hold")
            .and_then(|keyframe| keyframe.path_states.first())
            .and_then(|state| state.path_ids.first())
            .cloned()
            .unwrap();
        let mut player = ProtocolTimelinePlayer::try_new(timeline, &snapshot, camera).unwrap();
        player.seek(4_926);
        let first = player.sample();
        let second = player.sample();
        assert_eq!(first, second);
        assert_eq!(first.keyframe_id.as_deref(), Some("step:containers:hold"));
        let path_index = snapshot
            .paths
            .iter()
            .position(|path| path.id == expected_path_id)
            .unwrap();
        assert!(first.path_flow_phase[path_index] > 0.0);
        assert!(first.path_color[path_index].is_some());
    }

    #[test]
    fn effect_sampling_preserves_compiler_values() {
        let (snapshot, mut timeline, camera) = fixture();
        timeline.keyframes = vec![TimelineKeyframe {
            id: "cue".into(),
            at_ms: 1_000,
            easing: Easing::Linear,
            camera: Some(CameraKeyframeState {
                center: Point { x: 50.0, y: 30.0 },
                zoom: 2.0,
            }),
            object_states: vec![ObjectKeyframeState {
                object_ids: vec![SYSTEM_OBJECT_ID.into()],
                opacity: 0.25,
                emphasis: 0.8,
            }],
            path_states: vec![],
        }];
        timeline.duration_ms = 1_000;
        let mut player = ProtocolTimelinePlayer::try_new(timeline, &snapshot, camera).unwrap();
        player.seek(1_000);
        let sample = player.sample();
        let object_index = snapshot
            .objects
            .iter()
            .position(|object| object.id == SYSTEM_OBJECT_ID)
            .unwrap();
        assert_eq!(sample.object_opacity[object_index], 0.25);
        assert_eq!(sample.object_emphasis[object_index], 0.8);
        assert!((sample.camera_center.x - 50.0).abs() < 1e-6);
    }

    #[test]
    fn paused_highlight_timeline_never_overwrites_host_camera() {
        let (snapshot, _, camera) = fixture();
        let scene_id = snapshot.scene_id.clone();
        let mut engine = ProtocolEngine::try_new(snapshot, camera).unwrap();
        let highlight_timeline = Timeline {
            protocol_version: atlas_protocol::PROTOCOL_VERSION,
            timeline_version: TIMELINE_VERSION,
            id: "timeline:highlight-only".into(),
            scene_id,
            duration_ms: 1_000,
            looped: false,
            keyframes: vec![TimelineKeyframe {
                id: "cue:highlight-only".into(),
                at_ms: 0,
                easing: Easing::Linear,
                camera: None,
                object_states: vec![ObjectKeyframeState {
                    object_ids: vec![SYSTEM_OBJECT_ID.into()],
                    opacity: 1.0,
                    emphasis: 1.0,
                }],
                path_states: vec![],
            }],
        };

        engine.set_timeline(highlight_timeline).unwrap();
        engine.camera_mut().set_center(Vec2::new(420.0, 240.0));
        engine.camera_mut().set_zoom(1.55);
        engine.tick(100.0);
        engine.tick(200.0);

        assert_eq!(engine.camera().center(), Vec2::new(420.0, 240.0));
        assert!((engine.camera().zoom() - 1.55).abs() < f64::EPSILON);
        let frame = engine.prepare_frame(RendererBackend::Headless);
        assert_eq!(
            frame
                .timeline
                .as_ref()
                .map(|timeline| timeline.camera_active),
            Some(false)
        );
    }

    #[test]
    fn paused_camera_timeline_releases_camera_ownership() {
        let (snapshot, _, camera) = fixture();
        let scene_id = snapshot.scene_id.clone();
        let mut engine = ProtocolEngine::try_new(snapshot, camera).unwrap();
        let camera_timeline = Timeline {
            protocol_version: atlas_protocol::PROTOCOL_VERSION,
            timeline_version: TIMELINE_VERSION,
            id: "timeline:camera".into(),
            scene_id,
            duration_ms: 1_000,
            looped: false,
            keyframes: vec![TimelineKeyframe {
                id: "cue:camera".into(),
                at_ms: 1_000,
                easing: Easing::Linear,
                camera: Some(CameraKeyframeState {
                    center: Point { x: 500.0, y: 300.0 },
                    zoom: 2.0,
                }),
                object_states: vec![],
                path_states: vec![],
            }],
        };

        engine.set_timeline(camera_timeline).unwrap();
        engine.play_timeline();
        engine.tick(0.0);
        engine.tick(500.0);
        assert!((engine.camera().zoom() - 1.0).abs() < 1e-6);

        engine.pause_timeline();
        engine.camera_mut().set_center(Vec2::new(700.0, 500.0));
        engine.camera_mut().set_zoom(1.7);
        engine.tick(1_000.0);
        assert_eq!(engine.camera().center(), Vec2::new(700.0, 500.0));
        assert!((engine.camera().zoom() - 1.7).abs() < f64::EPSILON);
    }

    #[test]
    fn interrupted_patch_transition_keeps_visual_continuity() {
        let (snapshot, _, camera) = fixture();
        let mut engine = ProtocolEngine::try_new(snapshot, camera).unwrap();
        let original = engine
            .snapshot()
            .objects
            .iter()
            .find(|object| object.id == ARCHITECTURE_MODEL_OBJECT_ID)
            .unwrap()
            .clone();
        let mut first_target = original.clone();
        first_target.bounds.x += 200.0;
        let first_patch = ScenePatch {
            protocol_version: atlas_protocol::PROTOCOL_VERSION,
            scene_id: engine.snapshot().scene_id.clone(),
            base_revision: 1,
            revision: 2,
            world_bounds: None,
            upsert_objects: vec![first_target.clone()],
            remove_object_ids: vec![],
            upsert_paths: vec![],
            remove_path_ids: vec![],
            transition: Some(Transition {
                duration_ms: 1_000,
                easing: Easing::Linear,
            }),
        };
        engine.apply_patch(&first_patch).unwrap();
        engine.tick(0.0);
        engine.tick(500.0);
        let halfway_x = engine
            .snapshot()
            .objects
            .iter()
            .find(|object| object.id == ARCHITECTURE_MODEL_OBJECT_ID)
            .unwrap()
            .bounds
            .x;
        assert!((halfway_x - (original.bounds.x + 100.0)).abs() < 1e-5);

        let mut second_target = first_target;
        second_target.bounds.x = original.bounds.x + 400.0;
        let second_patch = ScenePatch {
            protocol_version: atlas_protocol::PROTOCOL_VERSION,
            scene_id: engine.snapshot().scene_id.clone(),
            base_revision: 2,
            revision: 3,
            world_bounds: None,
            upsert_objects: vec![second_target],
            remove_object_ids: vec![],
            upsert_paths: vec![],
            remove_path_ids: vec![],
            transition: Some(Transition {
                duration_ms: 1_000,
                easing: Easing::Linear,
            }),
        };
        engine.apply_patch(&second_patch).unwrap();
        let after_interrupt_x = engine
            .snapshot()
            .objects
            .iter()
            .find(|object| object.id == ARCHITECTURE_MODEL_OBJECT_ID)
            .unwrap()
            .bounds
            .x;
        assert!((after_interrupt_x - halfway_x).abs() < 1e-5);
    }

    #[test]
    fn crossfade_picking_uses_only_active_representation_bounds() {
        let (mut snapshot, _, camera) = fixture();
        // Persistent owner geometry makes the checked C4 representation bounds
        // identical. Expand this object's later representations locally so the
        // test still proves that picking consults active, not union-only, bounds.
        let system = snapshot
            .objects
            .iter_mut()
            .find(|object| object.id == SYSTEM_OBJECT_ID)
            .unwrap();
        let context_bounds = system.representations[0].bounds.unwrap();
        let mut container_bounds = context_bounds;
        container_bounds.width += 80.0;
        let mut inactive_bounds = context_bounds;
        inactive_bounds.width += 160.0;
        system.representations[1].bounds = Some(container_bounds);
        system.representations[2].bounds = Some(inactive_bounds);
        system.representations[3].bounds = Some(inactive_bounds);
        system.bounds = inactive_bounds;
        let mut engine = ProtocolEngine::try_new(snapshot, camera).unwrap();
        engine.camera_mut().set_zoom(1.25);
        let system = engine
            .snapshot()
            .objects
            .iter()
            .find(|object| object.id == SYSTEM_OBJECT_ID)
            .unwrap();
        let context_bounds = system.representations[0].bounds.unwrap();
        let container_bounds = system.representations[1].bounds.unwrap();

        // The container representation is active in the context/container
        // crossfade and extends beyond the smaller context representation.
        let inside_active_container_representation = engine.camera().world_to_screen(Vec2::new(
            f64::from(context_bounds.x + context_bounds.width + 20.0),
            f64::from(context_bounds.y + 80.0),
        ));
        assert_eq!(
            engine.select_at(inside_active_container_representation, 1.0),
            Some(HitTarget::Node(SYSTEM_OBJECT_ID.into()))
        );

        // This point is inside the object's union bounds, but only inside
        // component/code representations that are inactive at this zoom.
        let inside_inactive_representation_only = engine.camera().world_to_screen(Vec2::new(
            f64::from(container_bounds.x + container_bounds.width + 20.0),
            f64::from(container_bounds.y + 80.0),
        ));
        assert_eq!(
            engine.select_at(inside_inactive_representation_only, 1.0),
            None
        );
    }

    #[test]
    fn reduced_motion_snaps_semantic_lod_to_the_target_representation() {
        let (snapshot, _, camera) = fixture();
        let mut engine = ProtocolEngine::try_new(snapshot, camera).unwrap();
        engine.camera_mut().set_center(Vec2::new(1060.0, 245.0));
        engine.camera_mut().set_zoom(0.62);
        engine.tick(0.0);
        let _ = engine.prepare_frame(RendererBackend::Headless);

        engine.set_reduced_motion(true);
        engine.camera_mut().set_zoom(2.05);
        engine.tick(10.0);
        let frame = engine.prepare_frame(RendererBackend::Headless);
        let weights = frame
            .objects
            .iter()
            .filter(|draw| engine.snapshot().objects[draw.object_index].id == SYSTEM_OBJECT_ID)
            .map(|draw| {
                (
                    engine.snapshot().objects[draw.object_index].representations
                        [draw.representation_index]
                        .id
                        .as_str(),
                    draw.opacity,
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(
            weights
                .iter()
                .filter(|(_, opacity)| *opacity > f32::EPSILON)
                .collect::<Vec<_>>(),
            vec![&("visual-node:lineage:system:okie:container", 1.0)]
        );
        assert!(!frame.lod.expect("LOD diagnostics").transitioning);
    }
}
