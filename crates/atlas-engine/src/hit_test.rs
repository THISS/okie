use serde::{Deserialize, Serialize};

use crate::{Camera, Scene, SemanticLevel, Vec2};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum HitTarget {
    Node(String),
    Edge(String),
}

impl HitTarget {
    #[must_use]
    pub fn id(&self) -> &str {
        match self {
            Self::Node(id) | Self::Edge(id) => id,
        }
    }
}

#[must_use]
pub fn hit_test(
    scene: &Scene,
    camera: &Camera,
    level: SemanticLevel,
    screen_point: Vec2,
    tolerance_px: f64,
) -> Option<HitTarget> {
    let world_point = camera.screen_to_world(screen_point);

    let mut nodes: Vec<_> = scene
        .nodes()
        .iter()
        .filter(|node| node.level == level && node.bounds.contains(world_point))
        .collect();
    nodes.sort_by_key(|node| (node.z_index, node.id.as_str()));
    if let Some(node) = nodes.last() {
        return Some(HitTarget::Node(node.id.clone()));
    }

    let tolerance_world = tolerance_px.max(1.0) / camera.zoom();
    for edge in scene
        .edges()
        .iter()
        .rev()
        .filter(|edge| edge.level == level)
    {
        let Some(from) = scene.node(&edge.from) else {
            continue;
        };
        let Some(to) = scene.node(&edge.to) else {
            continue;
        };
        if point_to_segment_distance(world_point, from.bounds.center(), to.bounds.center())
            <= tolerance_world
        {
            return Some(HitTarget::Edge(edge.id.clone()));
        }
    }
    None
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CameraLimits, Edge, Node, Rect, Viewport};

    fn fixture() -> (Scene, Camera) {
        let scene = Scene::try_new(
            vec![
                Node::new(
                    "back",
                    "Back",
                    Rect::new(0.0, 0.0, 100.0, 100.0),
                    SemanticLevel::Context,
                ),
                Node {
                    z_index: 2,
                    ..Node::new(
                        "front",
                        "Front",
                        Rect::new(20.0, 20.0, 60.0, 60.0),
                        SemanticLevel::Context,
                    )
                },
                Node::new(
                    "right",
                    "Right",
                    Rect::new(200.0, 0.0, 100.0, 100.0),
                    SemanticLevel::Context,
                ),
            ],
            vec![Edge::new(
                "connection",
                "back",
                "right",
                SemanticLevel::Context,
            )],
        )
        .unwrap();
        let camera = Camera::new(
            Vec2::new(150.0, 50.0),
            1.0,
            Viewport::new(300.0, 100.0, 1.0),
            CameraLimits::default(),
        );
        (scene, camera)
    }

    #[test]
    fn topmost_node_wins_deterministically() {
        let (scene, camera) = fixture();
        assert_eq!(
            hit_test(
                &scene,
                &camera,
                SemanticLevel::Context,
                Vec2::new(50.0, 50.0),
                5.0
            ),
            Some(HitTarget::Node("front".into()))
        );
    }
}
