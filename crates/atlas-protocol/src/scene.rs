use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::{Color, PROTOCOL_VERSION, Point, ProtocolError, Rect, is_valid_color};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LodRange {
    pub min_zoom: f32,
    pub max_zoom: Option<f32>,
    #[serde(default = "default_fade_width")]
    pub fade_width: f32,
    #[serde(default = "default_hysteresis")]
    pub hysteresis: f32,
}

const fn default_fade_width() -> f32 {
    0.08
}

const fn default_hysteresis() -> f32 {
    0.04
}

impl LodRange {
    #[must_use]
    pub fn is_valid(self) -> bool {
        self.min_zoom.is_finite()
            && self.min_zoom >= 0.0
            && self
                .max_zoom
                .is_none_or(|max| max.is_finite() && max > self.min_zoom)
            && self.fade_width.is_finite()
            && self.fade_width >= 0.0
            && self.hysteresis.is_finite()
            && self.hysteresis >= 0.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stroke {
    pub color: Color,
    pub width: f32,
}

impl Stroke {
    #[must_use]
    pub fn is_valid(self) -> bool {
        is_valid_color(self.color) && self.width.is_finite() && self.width > 0.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextAlign {
    Start,
    Center,
    End,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Primitive {
    RoundedRect {
        rect: Rect,
        radius: f32,
        fill: Color,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stroke: Option<Stroke>,
    },
    Circle {
        center: Point,
        radius: f32,
        fill: Color,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stroke: Option<Stroke>,
    },
    Text {
        position: Point,
        max_width: f32,
        content: String,
        font_family: String,
        font_size: f32,
        color: Color,
        align: TextAlign,
    },
    Icon {
        position: Point,
        size: f32,
        name: String,
        color: Color,
    },
}

impl Primitive {
    fn validate(&self, context: &str) -> Result<(), ProtocolError> {
        match self {
            Self::RoundedRect {
                rect,
                radius,
                fill,
                stroke,
            } => {
                if !rect.is_valid()
                    || !radius.is_finite()
                    || *radius < 0.0
                    || *radius > rect.width.min(rect.height) / 2.0
                {
                    return Err(ProtocolError::InvalidPrimitive(context.into()));
                }
                if !is_valid_color(*fill) {
                    return Err(ProtocolError::InvalidColor(context.into()));
                }
                if stroke.is_some_and(|value| !value.is_valid()) {
                    return Err(ProtocolError::InvalidStroke(context.into()));
                }
            }
            Self::Circle {
                center,
                radius,
                fill,
                stroke,
            } => {
                if !center.is_finite() || !radius.is_finite() || *radius <= 0.0 {
                    return Err(ProtocolError::InvalidPrimitive(context.into()));
                }
                if !is_valid_color(*fill) {
                    return Err(ProtocolError::InvalidColor(context.into()));
                }
                if stroke.is_some_and(|value| !value.is_valid()) {
                    return Err(ProtocolError::InvalidStroke(context.into()));
                }
            }
            Self::Text {
                position,
                max_width,
                font_size,
                color,
                ..
            } => {
                if !position.is_finite()
                    || !max_width.is_finite()
                    || *max_width <= 0.0
                    || !font_size.is_finite()
                    || *font_size <= 0.0
                {
                    return Err(ProtocolError::InvalidPrimitive(context.into()));
                }
                if !is_valid_color(*color) {
                    return Err(ProtocolError::InvalidColor(context.into()));
                }
            }
            Self::Icon {
                position,
                size,
                color,
                ..
            } => {
                if !position.is_finite() || !size.is_finite() || *size <= 0.0 {
                    return Err(ProtocolError::InvalidPrimitive(context.into()));
                }
                if !is_valid_color(*color) {
                    return Err(ProtocolError::InvalidColor(context.into()));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Representation {
    pub id: String,
    pub lod: LodRange,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Rect>,
    pub primitives: Vec<Primitive>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneObject {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub z_index: i32,
    pub bounds: Rect,
    #[serde(default)]
    pub pickable: bool,
    pub representations: Vec<Representation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArrowHead {
    None,
    End,
    Both,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenePath {
    pub id: String,
    pub from_object_id: String,
    pub to_object_id: String,
    pub points: Vec<Point>,
    pub stroke: Color,
    pub width: f32,
    pub arrow: ArrowHead,
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub pickable: bool,
    pub lod: LodRange,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneSnapshot {
    pub protocol_version: u16,
    pub scene_id: String,
    pub revision: u64,
    pub world_bounds: Rect,
    pub objects: Vec<SceneObject>,
    pub paths: Vec<ScenePath>,
}

impl SceneSnapshot {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedVersion(self.protocol_version));
        }
        if !self.world_bounds.is_valid() {
            return Err(ProtocolError::InvalidBounds("worldBounds".into()));
        }

        let mut object_ids = HashSet::with_capacity(self.objects.len());
        let mut representation_ids = HashSet::new();
        for object in &self.objects {
            if object.id.is_empty() || !object_ids.insert(object.id.as_str()) {
                return Err(ProtocolError::DuplicateId(object.id.clone()));
            }
            if !object.bounds.is_valid() {
                return Err(ProtocolError::InvalidBounds(object.id.clone()));
            }
            if object.representations.is_empty() {
                return Err(ProtocolError::MissingRepresentation(object.id.clone()));
            }
            for representation in &object.representations {
                if representation.id.is_empty()
                    || !representation_ids.insert(representation.id.as_str())
                {
                    return Err(ProtocolError::DuplicateRepresentationId(
                        representation.id.clone(),
                    ));
                }
                if !representation.lod.is_valid() {
                    return Err(ProtocolError::InvalidLod(format!(
                        "{}:{}",
                        object.id, representation.id
                    )));
                }
                if representation
                    .bounds
                    .is_some_and(|bounds| !bounds.is_valid())
                {
                    return Err(ProtocolError::InvalidBounds(format!(
                        "{}:{}",
                        object.id, representation.id
                    )));
                }
                if representation.primitives.is_empty() {
                    return Err(ProtocolError::InvalidPrimitive(format!(
                        "{}:{}",
                        object.id, representation.id
                    )));
                }
                for (index, primitive) in representation.primitives.iter().enumerate() {
                    primitive.validate(&format!(
                        "{}:{}:primitive[{index}]",
                        object.id, representation.id
                    ))?;
                }
            }
        }

        for object in &self.objects {
            if let Some(parent_id) = &object.parent_id {
                if !object_ids.contains(parent_id.as_str()) {
                    return Err(ProtocolError::UnknownObject(parent_id.clone()));
                }
            }
        }

        let mut path_ids = HashSet::with_capacity(self.paths.len());
        for path in &self.paths {
            if path.id.is_empty() || !path_ids.insert(path.id.as_str()) {
                return Err(ProtocolError::DuplicateId(path.id.clone()));
            }
            if !object_ids.contains(path.from_object_id.as_str()) {
                return Err(ProtocolError::UnknownObject(path.from_object_id.clone()));
            }
            if !object_ids.contains(path.to_object_id.as_str()) {
                return Err(ProtocolError::UnknownObject(path.to_object_id.clone()));
            }
            if path.points.len() < 2 {
                return Err(ProtocolError::InvalidPath(path.id.clone()));
            }
            if path.points.iter().any(|point| !point.is_finite()) {
                return Err(ProtocolError::InvalidPath(path.id.clone()));
            }
            if !is_valid_color(path.stroke) {
                return Err(ProtocolError::InvalidColor(path.id.clone()));
            }
            if !path.width.is_finite() || path.width <= 0.0 {
                return Err(ProtocolError::InvalidStroke(path.id.clone()));
            }
            if !path.lod.is_valid() {
                return Err(ProtocolError::InvalidLod(path.id.clone()));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn representation_bounds_are_optional_for_protocol_v1_compatibility() {
        let value = serde_json::json!({
            "id": "node:overview",
            "lod": { "minZoom": 0.0, "maxZoom": null, "fadeWidth": 0.1, "hysteresis": 0.04 },
            "primitives": [{
                "kind": "roundedRect",
                "rect": { "x": 0.0, "y": 0.0, "width": 10.0, "height": 10.0 },
                "radius": 2.0,
                "fill": [0.0, 0.0, 0.0, 1.0]
            }]
        });
        let representation: Representation = serde_json::from_value(value).unwrap();
        assert_eq!(representation.bounds, None);
    }

    #[test]
    fn malformed_representation_bounds_are_rejected() {
        let snapshot = SceneSnapshot {
            protocol_version: PROTOCOL_VERSION,
            scene_id: "scene:test".into(),
            revision: 1,
            world_bounds: Rect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
            objects: vec![SceneObject {
                id: "node".into(),
                parent_id: None,
                z_index: 0,
                bounds: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 100.0,
                    height: 100.0,
                },
                pickable: true,
                representations: vec![Representation {
                    id: "node:detail".into(),
                    lod: LodRange {
                        min_zoom: 0.0,
                        max_zoom: None,
                        fade_width: 0.1,
                        hysteresis: 0.04,
                    },
                    bounds: Some(Rect {
                        x: 0.0,
                        y: 0.0,
                        width: -1.0,
                        height: 10.0,
                    }),
                    primitives: vec![Primitive::RoundedRect {
                        rect: Rect {
                            x: 0.0,
                            y: 0.0,
                            width: 10.0,
                            height: 10.0,
                        },
                        radius: 2.0,
                        fill: [0.0, 0.0, 0.0, 1.0],
                        stroke: None,
                    }],
                }],
            }],
            paths: Vec::new(),
        };
        assert!(matches!(
            snapshot.validate(),
            Err(ProtocolError::InvalidBounds(_))
        ));
    }
}
