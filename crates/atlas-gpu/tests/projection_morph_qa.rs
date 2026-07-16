use atlas_engine::{
    Camera, CameraLimits, ProjectionMorphOverride, ProjectionObjectOverride, ProjectionOverride,
    ProjectionPathOverride, ProtocolEngine, RendererBackend, Vec2, Viewport,
};
use atlas_gpu::build_flow_vertices;
use atlas_protocol::{ScenePath, SceneSnapshot};

const BOUNDARY_ID: &str = "visual-node:lineage:container:architecture-model";
const CHILD_ID: &str = "visual-node:lineage:component:model-validation";
const PEER_CHILD_ID: &str = "visual-node:lineage:component:model-schema";
const PATH_ID: &str = "visual-edge:component:visual-node%3Alineage%3Acomponent%3Amodel-validation>visual-node%3Alineage%3Acomponent%3Amodel-schema:dependsOn";

fn point_along_path(path: &ScenePath, phase: f32) -> Vec2 {
    let lengths: Vec<_> = path
        .points
        .windows(2)
        .map(|segment| {
            let dx = f64::from(segment[1].x - segment[0].x);
            let dy = f64::from(segment[1].y - segment[0].y);
            (dx * dx + dy * dy).sqrt()
        })
        .collect();
    let total: f64 = lengths.iter().sum();
    let mut remaining = total * f64::from(phase.clamp(0.0, 1.0));
    for (segment, length) in path.points.windows(2).zip(lengths) {
        if remaining <= length || length <= f64::EPSILON {
            let amount = if length <= f64::EPSILON {
                0.0
            } else {
                remaining / length
            };
            return Vec2::new(
                f64::from(segment[0].x) + f64::from(segment[1].x - segment[0].x) * amount,
                f64::from(segment[0].y) + f64::from(segment[1].y - segment[0].y) * amount,
            );
        }
        remaining -= length;
    }
    let point = path.points.last().expect("path point");
    Vec2::new(f64::from(point.x), f64::from(point.y))
}

#[test]
fn flow_particle_applies_the_path_morph_transform_clip_and_opacity() {
    let snapshot: SceneSnapshot =
        serde_json::from_str(include_str!("../../../fixtures/renderer/demo-scene.json"))
            .expect("scene fixture");
    let camera = Camera::new(
        Vec2::new(1_200.0, 450.0),
        0.78,
        Viewport::new(2_000.0, 1_200.0, 1.0),
        CameraLimits::default(),
    );
    let mut engine = ProtocolEngine::try_new(snapshot.clone(), camera).expect("engine");
    engine
        .set_projection_override(Some(ProjectionOverride {
            id: "semantic-lens:flow-morph".into(),
            progress: 0.5,
            objects: vec![
                ProjectionObjectOverride {
                    object_id: BOUNDARY_ID.into(),
                    source_representation_id: Some(format!("{BOUNDARY_ID}:container")),
                    target_representation_id: Some(format!("{BOUNDARY_ID}:component")),
                    ..ProjectionObjectOverride::default()
                },
                ProjectionObjectOverride {
                    object_id: CHILD_ID.into(),
                    source_representation_id: None,
                    target_representation_id: Some(format!("{CHILD_ID}:component")),
                    ..ProjectionObjectOverride::default()
                },
                ProjectionObjectOverride {
                    object_id: PEER_CHILD_ID.into(),
                    source_representation_id: None,
                    target_representation_id: Some(format!("{PEER_CHILD_ID}:component")),
                    ..ProjectionObjectOverride::default()
                },
            ],
            paths: vec![ProjectionPathOverride {
                path_id: PATH_ID.into(),
                source_opacity: 0.0,
                target_opacity: 0.8,
            }],
            morph: Some(ProjectionMorphOverride {
                boundary_object_id: BOUNDARY_ID.into(),
                object_ids: vec![BOUNDARY_ID.into(), CHILD_ID.into(), PEER_CHILD_ID.into()],
                path_ids: vec![PATH_ID.into()],
            }),
        }))
        .expect("morph override");

    let mut frame = engine.prepare_frame(RendererBackend::Headless);
    let path_index = snapshot
        .paths
        .iter()
        .position(|path| path.id == PATH_ID)
        .expect("path");
    let draw = frame
        .paths
        .iter_mut()
        .find(|draw| draw.path_index == path_index)
        .expect("path draw");
    draw.flow_phase = 0.5;
    assert!(draw.clip[2] > 0.0 && draw.clip[3] > 0.0);
    let transform = draw.transform;
    let opacity = draw.opacity;

    let authored = point_along_path(&snapshot.paths[path_index], 0.5);
    let expected = Vec2::new(
        authored.x * f64::from(transform[0]) + f64::from(transform[2]),
        authored.y * f64::from(transform[1]) + f64::from(transform[3]),
    );
    let vertices = build_flow_vertices(&snapshot, &frame, Vec::new());
    assert!(!vertices.is_empty());
    let sum = vertices.iter().fold(Vec2::ZERO, |sum, vertex| {
        sum + Vec2::new(f64::from(vertex.position[0]), f64::from(vertex.position[1]))
    });
    let center = Vec2::new(sum.x / vertices.len() as f64, sum.y / vertices.len() as f64);
    assert!((center.x - expected.x).abs() <= 1e-3);
    assert!((center.y - expected.y).abs() <= 1e-3);
    assert!(
        vertices
            .iter()
            .all(|vertex| (vertex.color[3] - opacity).abs() <= 1e-6)
    );

    let draw = frame
        .paths
        .iter_mut()
        .find(|draw| draw.path_index == path_index)
        .expect("path draw");
    draw.clip = [0.0, 0.0, 1.0, 1.0];
    assert!(
        build_flow_vertices(&snapshot, &frame, Vec::new()).is_empty(),
        "a morphed particle outside the path clip must not be emitted"
    );
}
