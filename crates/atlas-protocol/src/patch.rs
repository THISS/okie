use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::{PROTOCOL_VERSION, ProtocolError, Rect, SceneObject, ScenePath, SceneSnapshot};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Easing {
    Linear,
    EaseInOut,
    EaseOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub duration_ms: u32,
    pub easing: Easing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenePatch {
    pub protocol_version: u16,
    pub scene_id: String,
    pub base_revision: u64,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub world_bounds: Option<Rect>,
    #[serde(default)]
    pub upsert_objects: Vec<SceneObject>,
    #[serde(default)]
    pub remove_object_ids: Vec<String>,
    #[serde(default)]
    pub upsert_paths: Vec<ScenePath>,
    #[serde(default)]
    pub remove_path_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition: Option<Transition>,
}

impl ScenePatch {
    pub fn validate_against(&self, scene: &SceneSnapshot) -> Result<(), ProtocolError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedVersion(self.protocol_version));
        }
        if self.scene_id != scene.scene_id {
            return Err(ProtocolError::SceneMismatch {
                expected: scene.scene_id.clone(),
                actual: self.scene_id.clone(),
            });
        }
        if self.base_revision != scene.revision {
            return Err(ProtocolError::RevisionMismatch {
                expected: scene.revision,
                actual: self.base_revision,
            });
        }
        if self.revision <= self.base_revision {
            return Err(ProtocolError::NonIncreasingRevision {
                base: self.base_revision,
                next: self.revision,
            });
        }
        self.validate_payload()?;
        self.apply_to_validated(scene).map(|_| ())
    }

    pub fn apply_to(&self, scene: &SceneSnapshot) -> Result<SceneSnapshot, ProtocolError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedVersion(self.protocol_version));
        }
        if self.scene_id != scene.scene_id {
            return Err(ProtocolError::SceneMismatch {
                expected: scene.scene_id.clone(),
                actual: self.scene_id.clone(),
            });
        }
        if self.base_revision != scene.revision {
            return Err(ProtocolError::RevisionMismatch {
                expected: scene.revision,
                actual: self.base_revision,
            });
        }
        if self.revision <= self.base_revision {
            return Err(ProtocolError::NonIncreasingRevision {
                base: self.base_revision,
                next: self.revision,
            });
        }
        self.validate_payload()?;
        self.apply_to_validated(scene)
    }

    fn validate_payload(&self) -> Result<(), ProtocolError> {
        if self
            .transition
            .is_some_and(|transition| transition.duration_ms == 0)
        {
            return Err(ProtocolError::InvalidTransition);
        }

        let mut upsert_object_ids = HashSet::new();
        for object in &self.upsert_objects {
            if object.id.is_empty() || !upsert_object_ids.insert(object.id.as_str()) {
                return Err(ProtocolError::DuplicateId(object.id.clone()));
            }
        }
        let mut remove_object_ids = HashSet::new();
        for id in &self.remove_object_ids {
            if id.is_empty() || !remove_object_ids.insert(id.as_str()) {
                return Err(ProtocolError::DuplicateId(id.clone()));
            }
            if upsert_object_ids.contains(id.as_str()) {
                return Err(ProtocolError::ConflictingPatchOperation(id.clone()));
            }
        }

        let mut upsert_path_ids = HashSet::new();
        for path in &self.upsert_paths {
            if path.id.is_empty() || !upsert_path_ids.insert(path.id.as_str()) {
                return Err(ProtocolError::DuplicateId(path.id.clone()));
            }
        }
        let mut remove_path_ids = HashSet::new();
        for id in &self.remove_path_ids {
            if id.is_empty() || !remove_path_ids.insert(id.as_str()) {
                return Err(ProtocolError::DuplicateId(id.clone()));
            }
            if upsert_path_ids.contains(id.as_str()) {
                return Err(ProtocolError::ConflictingPatchOperation(id.clone()));
            }
        }
        Ok(())
    }

    fn apply_to_validated(&self, scene: &SceneSnapshot) -> Result<SceneSnapshot, ProtocolError> {
        let mut objects: BTreeMap<_, _> = scene
            .objects
            .iter()
            .cloned()
            .map(|object| (object.id.clone(), object))
            .collect();
        for id in &self.remove_object_ids {
            objects.remove(id);
        }
        for object in &self.upsert_objects {
            objects.insert(object.id.clone(), object.clone());
        }

        let mut paths: BTreeMap<_, _> = scene
            .paths
            .iter()
            .cloned()
            .map(|path| (path.id.clone(), path))
            .collect();
        for id in &self.remove_path_ids {
            paths.remove(id);
        }
        for path in &self.upsert_paths {
            paths.insert(path.id.clone(), path.clone());
        }

        let next = SceneSnapshot {
            protocol_version: self.protocol_version,
            scene_id: self.scene_id.clone(),
            revision: self.revision,
            world_bounds: self.world_bounds.unwrap_or(scene.world_bounds),
            objects: objects.into_values().collect(),
            paths: paths.into_values().collect(),
        };
        next.validate()?;
        Ok(next)
    }
}
