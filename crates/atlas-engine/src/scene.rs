use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{Color, Rect, SemanticLevel};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub label: String,
    pub bounds: Rect,
    pub level: SemanticLevel,
    #[serde(default)]
    pub color: Color,
    #[serde(default)]
    pub z_index: i32,
}

impl Node {
    #[must_use]
    pub fn new(
        id: impl Into<String>,
        label: impl Into<String>,
        bounds: Rect,
        level: SemanticLevel,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            bounds,
            level,
            color: Color::default(),
            z_index: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    #[default]
    Calls,
    Data,
    Optional,
    Feedback,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Edge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub level: SemanticLevel,
    #[serde(default)]
    pub kind: EdgeKind,
    #[serde(default = "default_edge_color")]
    pub color: Color,
    #[serde(default = "default_edge_width")]
    pub width_px: f32,
}

const fn default_edge_color() -> Color {
    Color::EDGE
}

const fn default_edge_width() -> f32 {
    1.5
}

impl Edge {
    #[must_use]
    pub fn new(
        id: impl Into<String>,
        from: impl Into<String>,
        to: impl Into<String>,
        level: SemanticLevel,
    ) -> Self {
        Self {
            id: id.into(),
            from: from.into(),
            to: to.into(),
            level,
            kind: EdgeKind::default(),
            color: default_edge_color(),
            width_px: default_edge_width(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Scene {
    nodes: Vec<Node>,
    edges: Vec<Edge>,
    #[serde(skip)]
    node_indices: HashMap<String, usize>,
    world_bounds: Rect,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum SceneError {
    #[error("scene node id `{0}` is duplicated")]
    DuplicateNodeId(String),
    #[error("scene edge id `{0}` is duplicated")]
    DuplicateEdgeId(String),
    #[error("edge `{edge}` references missing node `{node}`")]
    MissingEdgeNode { edge: String, node: String },
    #[error("node `{0}` has non-positive bounds")]
    InvalidNodeBounds(String),
    #[error("scene must contain at least one node")]
    Empty,
}

impl Scene {
    pub fn try_new(nodes: Vec<Node>, edges: Vec<Edge>) -> Result<Self, SceneError> {
        if nodes.is_empty() {
            return Err(SceneError::Empty);
        }

        let mut node_indices = HashMap::with_capacity(nodes.len());
        let mut world_bounds = nodes[0].bounds;
        for (index, node) in nodes.iter().enumerate() {
            if node.bounds.width <= 0.0 || node.bounds.height <= 0.0 {
                return Err(SceneError::InvalidNodeBounds(node.id.clone()));
            }
            if node_indices.insert(node.id.clone(), index).is_some() {
                return Err(SceneError::DuplicateNodeId(node.id.clone()));
            }
            world_bounds = world_bounds.union(node.bounds);
        }

        let mut edge_ids = HashSet::with_capacity(edges.len());
        for edge in &edges {
            if !edge_ids.insert(edge.id.clone()) {
                return Err(SceneError::DuplicateEdgeId(edge.id.clone()));
            }
            if !node_indices.contains_key(&edge.from) {
                return Err(SceneError::MissingEdgeNode {
                    edge: edge.id.clone(),
                    node: edge.from.clone(),
                });
            }
            if !node_indices.contains_key(&edge.to) {
                return Err(SceneError::MissingEdgeNode {
                    edge: edge.id.clone(),
                    node: edge.to.clone(),
                });
            }
        }

        Ok(Self {
            nodes,
            edges,
            node_indices,
            world_bounds,
        })
    }

    #[must_use]
    pub fn nodes(&self) -> &[Node] {
        &self.nodes
    }

    #[must_use]
    pub fn edges(&self) -> &[Edge] {
        &self.edges
    }

    #[must_use]
    pub fn node(&self, id: &str) -> Option<&Node> {
        self.node_indices.get(id).map(|index| &self.nodes[*index])
    }

    #[must_use]
    pub fn edge(&self, id: &str) -> Option<&Edge> {
        self.edges.iter().find(|edge| edge.id == id)
    }

    #[must_use]
    pub fn world_bounds(&self) -> Rect {
        self.world_bounds
    }

    #[must_use]
    pub fn edge_bounds(&self, edge: &Edge) -> Option<Rect> {
        let from = self.node(&edge.from)?.bounds.center();
        let to = self.node(&edge.to)?.bounds.center();
        Some(Rect::new(
            from.x.min(to.x),
            from.y.min(to.y),
            (from.x - to.x).abs().max(1.0),
            (from.y - to.y).abs().max(1.0),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_dangling_edges() {
        let nodes = vec![Node::new(
            "a",
            "A",
            Rect::new(0.0, 0.0, 10.0, 10.0),
            SemanticLevel::Context,
        )];
        let error = Scene::try_new(
            nodes,
            vec![Edge::new("bad", "a", "missing", SemanticLevel::Context)],
        )
        .unwrap_err();
        assert_eq!(
            error,
            SceneError::MissingEdgeNode {
                edge: "bad".into(),
                node: "missing".into(),
            }
        );
    }
}
