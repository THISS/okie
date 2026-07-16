use std::collections::{BTreeMap, BTreeSet};

use atlas_engine::{
    Camera, CameraLimits, HitTarget, ProjectionMorphOverride, ProjectionObjectOverride,
    ProjectionOverride, ProjectionPathOverride, ProtocolEngine, ProtocolFrame, Rect,
    RendererBackend, Vec2, Viewport, VisibilityFilter, VisibilityMode,
};
use atlas_protocol::SceneSnapshot;

const FOCUS_OBJECT_ID: &str = "visual-node:lineage:container:architecture-model";
const PEER_OBJECT_ID: &str = "visual-node:lineage:container:scene-compiler";
const CONNECTING_PATH_ID: &str = "visual-edge:container:visual-node%3Alineage%3Acontainer%3Aarchitecture-model>visual-node%3Alineage%3Acontainer%3Ascene-compiler:dependsOn";
const TARGET_CHILD_OBJECT_ID: &str = "visual-node:lineage:component:model-scoping";
const TARGET_PEER_CHILD_OBJECT_ID: &str = "visual-node:lineage:component:model-normalized";
const SIBLING_CHILD_OBJECT_ID: &str = "visual-node:lineage:component:compiler-normalized";
const TARGET_PATH_ID: &str = "visual-edge:component:visual-node%3Alineage%3Acomponent%3Amodel-scoping>visual-node%3Alineage%3Acomponent%3Amodel-normalized:dependsOn";
const ROOT_OBJECT_ID: &str = "visual-node:lineage:system:okie";
const CONTEXT_SIBLING_OBJECT_ID: &str = "visual-node:lineage:actor:developer";
const FAR_CHILD_OBJECT_ID: &str = "visual-node:lineage:component:model-validation";
const FAR_PEER_CHILD_OBJECT_ID: &str = "visual-node:lineage:component:model-schema";
const FAR_PATH_ID: &str = "visual-edge:component:visual-node%3Alineage%3Acomponent%3Amodel-validation>visual-node%3Alineage%3Acomponent%3Amodel-schema:dependsOn";
const WEB_APP_OBJECT_ID: &str = "visual-node:lineage:container:web-app";
const WEB_SHELL_OBJECT_ID: &str = "visual-node:lineage:component:web-shell";
const WEB_RENDERER_HOST_OBJECT_ID: &str = "visual-node:lineage:component:web-renderer-host";
const WEB_RENDERER_PATH_ID: &str = "visual-edge:component:visual-node%3Alineage%3Acomponent%3Aweb-shell>visual-node%3Alineage%3Acomponent%3Aweb-renderer-host:uses";
const CONTEXT_FOCUS_ZOOM: f64 = 0.62;
const CONTAINER_FOCUS_ZOOM: f64 = 2.05;
const COMPONENT_FOCUS_ZOOM: f64 = 5.15;
const CODE_FOCUS_ZOOM: f64 = 14.0;

fn scene_fixture() -> SceneSnapshot {
    serde_json::from_str(include_str!("../../../fixtures/renderer/demo-scene.json"))
        .expect("scene fixture")
}

fn engine_from_snapshot(snapshot: SceneSnapshot) -> ProtocolEngine {
    let world = snapshot.world_bounds;
    let camera = Camera::new(
        Vec2::new(
            f64::from(world.x + world.width / 2.0),
            f64::from(world.y + world.height / 2.0),
        ),
        CONTAINER_FOCUS_ZOOM,
        // Keep the whole deterministic C4 scene resident so visibility, not
        // camera culling, is the only variable under test.
        Viewport::new(
            f64::from(world.width) * CODE_FOCUS_ZOOM * 1.1,
            f64::from(world.height) * CODE_FOCUS_ZOOM * 1.1,
            1.0,
        ),
        CameraLimits::default(),
    );
    ProtocolEngine::try_new(snapshot, camera).expect("valid engine")
}

fn engine() -> ProtocolEngine {
    engine_from_snapshot(scene_fixture())
}

fn drawn_object_ids(engine: &ProtocolEngine, frame: &ProtocolFrame) -> BTreeSet<String> {
    frame
        .objects
        .iter()
        .filter(|draw| draw.opacity > 0.001)
        .map(|draw| engine.snapshot().objects[draw.object_index].id.clone())
        .collect()
}

fn drawn_path_ids(engine: &ProtocolEngine, frame: &ProtocolFrame) -> BTreeSet<String> {
    frame
        .paths
        .iter()
        .filter(|draw| draw.opacity > 0.001)
        .map(|draw| engine.snapshot().paths[draw.path_index].id.clone())
        .collect()
}

fn drawn_semantic_object_ids(engine: &ProtocolEngine, frame: &ProtocolFrame) -> BTreeSet<String> {
    frame
        .objects
        .iter()
        .filter(|draw| draw.opacity > 0.001)
        .filter_map(|draw| {
            let object = &engine.snapshot().objects[draw.object_index];
            object.pickable.then(|| object.id.clone())
        })
        .collect()
}

fn snapshot_object_ids(snapshot: &SceneSnapshot) -> BTreeSet<String> {
    snapshot
        .objects
        .iter()
        .map(|object| object.id.clone())
        .collect()
}

fn snapshot_path_ids(snapshot: &SceneSnapshot) -> BTreeSet<String> {
    snapshot.paths.iter().map(|path| path.id.clone()).collect()
}

fn representation_screen_center(engine: &ProtocolEngine, id: &str, band: &str) -> Vec2 {
    let object = engine
        .snapshot()
        .objects
        .iter()
        .find(|object| object.id == id)
        .expect("object exists");
    let bounds = object
        .representations
        .iter()
        .find(|representation| representation.id.ends_with(&format!(":{band}")))
        .and_then(|representation| representation.bounds)
        .expect("band representation bounds");
    engine.camera().world_to_screen(Vec2::new(
        f64::from(bounds.x + bounds.width / 2.0),
        f64::from(bounds.y + bounds.height / 2.0),
    ))
}

fn path_screen_midpoint(engine: &ProtocolEngine, id: &str) -> Vec2 {
    let path = engine
        .snapshot()
        .paths
        .iter()
        .find(|path| path.id == id)
        .expect("path exists");
    let segment = path.points.windows(2).next().expect("path segment");
    engine.camera().world_to_screen(Vec2::new(
        f64::from((segment[0].x + segment[1].x) / 2.0),
        f64::from((segment[0].y + segment[1].y) / 2.0),
    ))
}

fn longest_path_world_midpoint(engine: &ProtocolEngine, id: &str) -> Vec2 {
    let path = engine
        .snapshot()
        .paths
        .iter()
        .find(|path| path.id == id)
        .expect("path exists");
    let segment = path
        .points
        .windows(2)
        .max_by(|left, right| {
            let length = |value: &[atlas_protocol::Point]| {
                let dx = value[1].x - value[0].x;
                let dy = value[1].y - value[0].y;
                dx * dx + dy * dy
            };
            length(left).total_cmp(&length(right))
        })
        .expect("path segment");
    Vec2::new(
        f64::from((segment[0].x + segment[1].x) / 2.0),
        f64::from((segment[0].y + segment[1].y) / 2.0),
    )
}

fn object_opacity_totals(engine: &ProtocolEngine, frame: &ProtocolFrame) -> BTreeMap<String, f32> {
    let mut totals = BTreeMap::new();
    for draw in &frame.objects {
        *totals
            .entry(engine.snapshot().objects[draw.object_index].id.clone())
            .or_insert(0.0) += draw.opacity;
    }
    totals
}

fn object_content_opacity_totals(
    engine: &ProtocolEngine,
    frame: &ProtocolFrame,
) -> BTreeMap<String, f32> {
    let mut totals = BTreeMap::new();
    for draw in &frame.objects {
        *totals
            .entry(engine.snapshot().objects[draw.object_index].id.clone())
            .or_insert(0.0) += draw.content_opacity;
    }
    totals
}

fn representation_weights(engine: &ProtocolEngine, frame: &ProtocolFrame) -> BTreeMap<String, f32> {
    let mut weights = BTreeMap::new();
    for object in &engine.snapshot().objects {
        for representation in &object.representations {
            weights.insert(representation.id.clone(), 0.0);
        }
    }
    for draw in &frame.objects {
        let representation = &engine.snapshot().objects[draw.object_index].representations
            [draw.representation_index];
        weights.insert(representation.id.clone(), draw.lod_opacity);
    }
    weights
}

fn transformed_representation_bounds(
    engine: &ProtocolEngine,
    frame: &ProtocolFrame,
    object_id: &str,
    representation_suffix: &str,
) -> Rect {
    let draw = frame
        .objects
        .iter()
        .find(|draw| {
            let object = &engine.snapshot().objects[draw.object_index];
            object.id == object_id
                && object.representations[draw.representation_index]
                    .id
                    .ends_with(representation_suffix)
        })
        .expect("representation draw");
    let object = &engine.snapshot().objects[draw.object_index];
    let bounds = object.representations[draw.representation_index]
        .bounds
        .unwrap_or(object.bounds);
    Rect::new(
        f64::from(bounds.x) * f64::from(draw.transform[0]) + f64::from(draw.transform[2]),
        f64::from(bounds.y) * f64::from(draw.transform[1]) + f64::from(draw.transform[3]),
        f64::from(bounds.width) * f64::from(draw.transform[0]),
        f64::from(bounds.height) * f64::from(draw.transform[1]),
    )
}

fn transformed_representation_screen_center(
    engine: &ProtocolEngine,
    frame: &ProtocolFrame,
    object_id: &str,
    representation_suffix: &str,
) -> Vec2 {
    engine.camera().world_to_screen(
        transformed_representation_bounds(engine, frame, object_id, representation_suffix).center(),
    )
}

fn transformed_path_screen_midpoint(
    engine: &ProtocolEngine,
    frame: &ProtocolFrame,
    path_id: &str,
) -> Vec2 {
    let draw = frame
        .paths
        .iter()
        .find(|draw| engine.snapshot().paths[draw.path_index].id == path_id)
        .expect("path draw");
    let path = &engine.snapshot().paths[draw.path_index];
    let segment = path.points.windows(2).next().expect("path segment");
    let midpoint = Vec2::new(
        f64::from((segment[0].x + segment[1].x) / 2.0),
        f64::from((segment[0].y + segment[1].y) / 2.0),
    );
    engine.camera().world_to_screen(Vec2::new(
        midpoint.x * f64::from(draw.transform[0]) + f64::from(draw.transform[2]),
        midpoint.y * f64::from(draw.transform[1]) + f64::from(draw.transform[3]),
    ))
}

fn transformed_path_points(
    engine: &ProtocolEngine,
    frame: &ProtocolFrame,
    path_id: &str,
) -> Vec<Vec2> {
    let draw = frame
        .paths
        .iter()
        .find(|draw| engine.snapshot().paths[draw.path_index].id == path_id)
        .expect("path draw");
    engine.snapshot().paths[draw.path_index]
        .points
        .iter()
        .map(|point| {
            Vec2::new(
                f64::from(point.x) * f64::from(draw.transform[0]) + f64::from(draw.transform[2]),
                f64::from(point.y) * f64::from(draw.transform[1]) + f64::from(draw.transform[3]),
            )
        })
        .collect()
}

fn rect_contains_rect(container: Rect, value: Rect) -> bool {
    value.min_x() >= container.min_x() - 1e-4
        && value.max_x() <= container.max_x() + 1e-4
        && value.min_y() >= container.min_y() - 1e-4
        && value.max_y() <= container.max_y() + 1e-4
}

fn approx_rect(actual: Rect, expected: Rect) {
    for (actual, expected) in [
        (actual.x, expected.x),
        (actual.y, expected.y),
        (actual.width, expected.width),
        (actual.height, expected.height),
    ] {
        assert!(
            (actual - expected).abs() <= 1e-3,
            "expected {expected}, received {actual}"
        );
    }
}

fn authored_representation_bounds(
    engine: &ProtocolEngine,
    object_id: &str,
    representation_suffix: &str,
) -> Rect {
    let object = engine
        .snapshot()
        .objects
        .iter()
        .find(|object| object.id == object_id)
        .expect("authored object");
    let bounds = object
        .representations
        .iter()
        .find(|representation| representation.id.ends_with(representation_suffix))
        .expect("authored representation")
        .bounds
        .unwrap_or(object.bounds);
    Rect::new(
        f64::from(bounds.x),
        f64::from(bounds.y),
        f64::from(bounds.width),
        f64::from(bounds.height),
    )
}

fn lerp_rect(source: Rect, target: Rect, progress: f64) -> Rect {
    Rect::new(
        source.x + (target.x - source.x) * progress,
        source.y + (target.y - source.y) * progress,
        source.width + (target.width - source.width) * progress,
        source.height + (target.height - source.height) * progress,
    )
}

fn map_rect(rect: Rect, from: Rect, to: Rect) -> Rect {
    let scale_x = to.width / from.width;
    let scale_y = to.height / from.height;
    Rect::new(
        to.x + (rect.x - from.x) * scale_x,
        to.y + (rect.y - from.y) * scale_y,
        rect.width * scale_x,
        rect.height * scale_y,
    )
}

fn path_weights(engine: &ProtocolEngine, frame: &ProtocolFrame) -> BTreeMap<String, f32> {
    let mut weights: BTreeMap<_, _> = engine
        .snapshot()
        .paths
        .iter()
        .map(|path| (path.id.clone(), 0.0))
        .collect();
    for draw in &frame.paths {
        weights.insert(
            engine.snapshot().paths[draw.path_index].id.clone(),
            draw.opacity,
        );
    }
    weights
}

fn branch_override(progress: f32) -> ProjectionOverride {
    let next_only = |object_id: &str| ProjectionObjectOverride {
        object_id: object_id.into(),
        source_representation_id: None,
        target_representation_id: Some(format!("{object_id}:component")),
        ..ProjectionObjectOverride::default()
    };
    ProjectionOverride {
        id: "semantic-lens:architecture-model".into(),
        progress,
        objects: vec![
            ProjectionObjectOverride {
                object_id: FOCUS_OBJECT_ID.into(),
                source_representation_id: Some(format!("{FOCUS_OBJECT_ID}:container")),
                target_representation_id: Some(format!("{FOCUS_OBJECT_ID}:component")),
                ..ProjectionObjectOverride::default()
            },
            next_only(TARGET_CHILD_OBJECT_ID),
            next_only(TARGET_PEER_CHILD_OBJECT_ID),
        ],
        paths: vec![ProjectionPathOverride {
            path_id: TARGET_PATH_ID.into(),
            source_opacity: 0.0,
            target_opacity: 1.0,
        }],
        morph: Some(ProjectionMorphOverride {
            boundary_object_id: FOCUS_OBJECT_ID.into(),
            object_ids: vec![
                FOCUS_OBJECT_ID.into(),
                TARGET_CHILD_OBJECT_ID.into(),
                TARGET_PEER_CHILD_OBJECT_ID.into(),
            ],
            path_ids: vec![TARGET_PATH_ID.into()],
        }),
    }
}

fn far_branch_override(progress: f32) -> ProjectionOverride {
    ProjectionOverride {
        id: "semantic-lens:far-side-spatial".into(),
        progress,
        objects: vec![
            ProjectionObjectOverride {
                object_id: FOCUS_OBJECT_ID.into(),
                source_representation_id: Some(format!("{FOCUS_OBJECT_ID}:container")),
                target_representation_id: Some(format!("{FOCUS_OBJECT_ID}:component")),
                ..ProjectionObjectOverride::default()
            },
            ProjectionObjectOverride {
                object_id: FAR_CHILD_OBJECT_ID.into(),
                source_representation_id: None,
                target_representation_id: Some(format!("{FAR_CHILD_OBJECT_ID}:component")),
                ..ProjectionObjectOverride::default()
            },
            ProjectionObjectOverride {
                object_id: FAR_PEER_CHILD_OBJECT_ID.into(),
                source_representation_id: None,
                target_representation_id: Some(format!("{FAR_PEER_CHILD_OBJECT_ID}:component")),
                ..ProjectionObjectOverride::default()
            },
        ],
        paths: vec![ProjectionPathOverride {
            path_id: FAR_PATH_ID.into(),
            source_opacity: 0.0,
            target_opacity: 1.0,
        }],
        morph: Some(ProjectionMorphOverride {
            boundary_object_id: FOCUS_OBJECT_ID.into(),
            object_ids: vec![
                FOCUS_OBJECT_ID.into(),
                FAR_CHILD_OBJECT_ID.into(),
                FAR_PEER_CHILD_OBJECT_ID.into(),
            ],
            path_ids: vec![FAR_PATH_ID.into()],
        }),
    }
}

fn path_opacity(engine: &ProtocolEngine, frame: &ProtocolFrame, id: &str) -> f32 {
    frame
        .paths
        .iter()
        .find(|draw| engine.snapshot().paths[draw.path_index].id == id)
        .map_or(0.0, |draw| draw.opacity)
}

fn approx(actual: f32, expected: f32) {
    assert!(
        (actual - expected).abs() <= 1e-5,
        "expected {expected}, received {actual}"
    );
}

#[test]
fn isolate_draw_pick_and_visible_snapshot_use_the_same_object_and_path_mask() {
    let mut engine = engine();
    let full_frame = engine.prepare_frame(RendererBackend::Headless);
    let full_epoch = full_frame.geometry_epoch;
    let focus_screen = representation_screen_center(&engine, FOCUS_OBJECT_ID, "container");
    let peer_screen = representation_screen_center(&engine, PEER_OBJECT_ID, "container");

    engine
        .set_visibility(VisibilityFilter {
            mode: VisibilityMode::Isolate,
            object_ids: vec![FOCUS_OBJECT_ID.into()],
            dim_opacity: 0.18,
        })
        .expect("isolate resolves");
    let isolated = engine.prepare_frame(RendererBackend::Headless);
    let isolated_snapshot = engine.visible_snapshot();

    assert_eq!(isolated.geometry_epoch, full_epoch);
    assert_eq!(
        drawn_object_ids(&engine, &isolated),
        snapshot_object_ids(&isolated_snapshot)
    );
    assert_eq!(
        drawn_path_ids(&engine, &isolated),
        snapshot_path_ids(&isolated_snapshot)
    );
    assert_eq!(
        snapshot_object_ids(&isolated_snapshot),
        BTreeSet::from([FOCUS_OBJECT_ID.into()])
    );
    assert!(isolated_snapshot.paths.is_empty());
    assert_eq!(
        engine.select_at(focus_screen, 3.0),
        Some(HitTarget::Node(FOCUS_OBJECT_ID.into()))
    );
    assert_eq!(engine.select_at(peer_screen, 3.0), None);

    engine
        .set_visibility(VisibilityFilter {
            mode: VisibilityMode::Isolate,
            object_ids: vec![FOCUS_OBJECT_ID.into(), PEER_OBJECT_ID.into()],
            dim_opacity: 0.18,
        })
        .expect("two-object isolate resolves");
    let relation_screen = path_screen_midpoint(&engine, CONNECTING_PATH_ID);
    let isolated_pair = engine.prepare_frame(RendererBackend::Headless);
    let isolated_pair_snapshot = engine.visible_snapshot();
    assert_eq!(
        drawn_object_ids(&engine, &isolated_pair),
        snapshot_object_ids(&isolated_pair_snapshot)
    );
    assert_eq!(
        drawn_path_ids(&engine, &isolated_pair),
        snapshot_path_ids(&isolated_pair_snapshot)
    );
    assert_eq!(
        snapshot_path_ids(&isolated_pair_snapshot),
        BTreeSet::from([CONNECTING_PATH_ID.into()])
    );
    assert_eq!(
        engine.select_at(relation_screen, 5.0),
        Some(HitTarget::Edge(CONNECTING_PATH_ID.into()))
    );
}

#[test]
fn visible_nested_path_wins_over_its_enclosing_owner_shell() {
    let mut engine = engine();
    let midpoint = longest_path_world_midpoint(&engine, WEB_RENDERER_PATH_ID);
    engine.camera_mut().set_center(midpoint);
    engine.camera_mut().set_zoom(5.15);
    engine.tick(0.0);

    let owner = authored_representation_bounds(&engine, WEB_APP_OBJECT_ID, ":component");
    let source = authored_representation_bounds(&engine, WEB_SHELL_OBJECT_ID, ":component");
    let target = authored_representation_bounds(&engine, WEB_RENDERER_HOST_OBJECT_ID, ":component");
    assert!(owner.contains(midpoint));
    assert!(!source.contains(midpoint));
    assert!(!target.contains(midpoint));

    let screen_point = engine.camera().world_to_screen(midpoint);
    assert_eq!(
        engine.select_at(screen_point, 7.0),
        Some(HitTarget::Edge(WEB_RENDERER_PATH_ID.into()))
    );
    assert_eq!(
        engine.select_at(
            representation_screen_center(&engine, WEB_SHELL_OBJECT_ID, "component"),
            7.0,
        ),
        Some(HitTarget::Node(WEB_SHELL_OBJECT_ID.into()))
    );
}

#[test]
fn dim_changes_dynamic_style_only_and_retains_draw_pick_and_snapshot_context() {
    let mut engine = engine();
    let full_frame = engine.prepare_frame(RendererBackend::Headless);
    let full_epoch = full_frame.geometry_epoch;
    let full_path_opacity = path_opacity(&engine, &full_frame, CONNECTING_PATH_ID);
    let active_snapshot = engine.visible_snapshot();
    let peer_screen = representation_screen_center(&engine, PEER_OBJECT_ID, "container");

    engine
        .set_visibility(VisibilityFilter {
            mode: VisibilityMode::Dim,
            object_ids: vec![FOCUS_OBJECT_ID.into()],
            dim_opacity: 0.2,
        })
        .expect("dim resolves");
    let dimmed = engine.prepare_frame(RendererBackend::Headless);
    let totals = object_opacity_totals(&engine, &dimmed);

    assert_eq!(dimmed.geometry_epoch, full_epoch);
    assert_eq!(engine.visible_snapshot(), active_snapshot);
    assert_eq!(
        drawn_object_ids(&engine, &dimmed),
        snapshot_object_ids(&active_snapshot)
    );
    assert_eq!(
        drawn_path_ids(&engine, &dimmed),
        snapshot_path_ids(&active_snapshot)
    );
    approx(totals[FOCUS_OBJECT_ID], 1.0);
    approx(totals[PEER_OBJECT_ID], 0.2);
    approx(
        path_opacity(&engine, &dimmed, CONNECTING_PATH_ID),
        full_path_opacity * 0.2,
    );
    assert_eq!(
        engine.select_at(peer_screen, 3.0),
        Some(HitTarget::Node(PEER_OBJECT_ID.into()))
    );
}

#[test]
fn c4_focus_presets_draw_exact_semantic_membership_without_rebuilding_geometry() {
    let mut runtime = engine();
    let expected = [
        (CONTEXT_FOCUS_ZOOM, 4, 3),
        (CONTAINER_FOCUS_ZOOM, 9, 5),
        (COMPONENT_FOCUS_ZOOM, 29, 23),
        (CODE_FOCUS_ZOOM, 70, 12),
    ];
    let mut geometry_epoch = None;
    let mut now = 0.0;

    for (zoom, object_count, path_count) in expected {
        runtime.camera_mut().set_zoom(zoom);
        runtime.tick(now);
        let _ = runtime.prepare_frame(RendererBackend::Headless);
        now += 250.0;
        runtime.tick(now);
        let frame = runtime.prepare_frame(RendererBackend::Headless);

        assert_eq!(
            drawn_semantic_object_ids(&runtime, &frame).len(),
            object_count
        );
        assert_eq!(drawn_path_ids(&runtime, &frame).len(), path_count);
        assert_eq!(
            geometry_epoch.get_or_insert(frame.geometry_epoch),
            &frame.geometry_epoch
        );
        now += 50.0;
    }
}

fn focus_weights(engine: &ProtocolEngine, frame: &ProtocolFrame) -> Vec<(usize, f32)> {
    frame
        .objects
        .iter()
        .filter(|draw| engine.snapshot().objects[draw.object_index].id == FOCUS_OBJECT_ID)
        .map(|draw| (draw.representation_index, draw.opacity))
        .collect()
}

#[test]
fn lod_crossfade_weights_are_normalized_hysteretic_and_topology_stable() {
    let mut runtime = engine();
    let focus = runtime
        .snapshot()
        .objects
        .iter()
        .find(|object| object.id == FOCUS_OBJECT_ID)
        .expect("focus object")
        .representations[0]
        .bounds
        .expect("container bounds");
    runtime.camera_mut().set_center(Vec2::new(
        f64::from(focus.x + focus.width / 2.0),
        f64::from(focus.y + focus.height / 2.0),
    ));

    runtime.camera_mut().set_zoom(CONTAINER_FOCUS_ZOOM);
    runtime.tick(0.0);
    let overview = runtime.prepare_frame(RendererBackend::Headless);

    runtime.camera_mut().set_zoom(COMPONENT_FOCUS_ZOOM);
    runtime.tick(10.0);
    let started = runtime.prepare_frame(RendererBackend::Headless);
    // A small move back inside the overlapping ranges must not reverse the
    // target selected at the component focus preset.
    runtime.camera_mut().set_zoom(COMPONENT_FOCUS_ZOOM - 0.07);
    runtime.tick(110.0);
    let halfway = runtime.prepare_frame(RendererBackend::Headless);
    runtime.tick(210.0);
    let completed = runtime.prepare_frame(RendererBackend::Headless);

    let samples = [&overview, &started, &halfway, &completed];
    let expected_topology: Vec<_> = focus_weights(&runtime, &overview)
        .iter()
        .map(|(index, _)| *index)
        .collect();
    assert_eq!(expected_topology.len(), 3);
    for frame in samples {
        let weights = focus_weights(&runtime, frame);
        assert_eq!(frame.geometry_epoch, overview.geometry_epoch);
        assert_eq!(
            weights.iter().map(|(index, _)| *index).collect::<Vec<_>>(),
            expected_topology
        );
        approx(weights.iter().map(|(_, opacity)| *opacity).sum(), 1.0);
    }

    assert_eq!(
        focus_weights(&runtime, &overview),
        vec![(0, 1.0), (1, 0.0), (2, 0.0)]
    );
    assert_eq!(
        focus_weights(&runtime, &started),
        vec![(0, 1.0), (1, 0.0), (2, 0.0)]
    );
    let midpoint = focus_weights(&runtime, &halfway);
    approx(midpoint[0].1, 0.5);
    approx(midpoint[1].1, 0.5);
    assert_eq!(
        focus_weights(&runtime, &completed),
        vec![(0, 0.0), (1, 1.0), (2, 0.0)]
    );

    let started_lod = started.lod.as_ref().expect("LOD diagnostics at start");
    assert!(started_lod.transitioning);
    assert_eq!(
        started_lod
            .previous_representation_id
            .as_deref()
            .map(|id| id.ends_with(":container")),
        Some(true)
    );
    assert!(
        started_lod
            .current_representation_id
            .ends_with(":component")
    );
    approx(
        started_lod.previous_weight + started_lod.current_weight,
        1.0,
    );
    let midpoint_lod = halfway.lod.as_ref().expect("LOD diagnostics at midpoint");
    approx(midpoint_lod.transition_progress, 0.5);
    approx(
        midpoint_lod.previous_weight + midpoint_lod.current_weight,
        1.0,
    );
    let completed_lod = completed
        .lod
        .as_ref()
        .expect("LOD diagnostics at completion");
    assert!(!completed_lod.transitioning);
    assert_eq!(completed_lod.previous_representation_id, None);
    assert_eq!(completed_lod.current_weight, 1.0);

    let mut reduced = engine();
    reduced.camera_mut().set_center(Vec2::new(
        f64::from(focus.x + focus.width / 2.0),
        f64::from(focus.y + focus.height / 2.0),
    ));
    reduced.camera_mut().set_zoom(CONTAINER_FOCUS_ZOOM);
    reduced.tick(0.0);
    let _ = reduced.prepare_frame(RendererBackend::Headless);
    reduced.set_reduced_motion(true);
    reduced.camera_mut().set_zoom(COMPONENT_FOCUS_ZOOM);
    reduced.tick(10.0);
    let snapped = reduced.prepare_frame(RendererBackend::Headless);
    assert_eq!(
        focus_weights(&reduced, &snapped),
        vec![(0, 0.0), (1, 1.0), (2, 0.0)]
    );
    assert!(
        !snapped
            .lod
            .expect("reduced-motion LOD diagnostics")
            .transitioning
    );
}

#[test]
fn branch_override_is_local_reversible_pickable_and_preserves_global_fallback() {
    let mut runtime = engine();
    runtime.tick(0.0);
    let baseline = runtime.prepare_frame(RendererBackend::Headless);
    let baseline_objects = representation_weights(&runtime, &baseline);
    let baseline_paths = path_weights(&runtime, &baseline);
    let geometry_epoch = baseline.geometry_epoch;

    // The camera never moves: only the target branch receives next-slot
    // ownership while the sibling branch stays on the global container LOD.
    runtime
        .set_projection_override(Some(branch_override(0.5)))
        .expect("branch override resolves");
    let blended = runtime.prepare_frame(RendererBackend::Headless);
    let objects = representation_weights(&runtime, &blended);
    let paths = path_weights(&runtime, &blended);

    assert_eq!(blended.geometry_epoch, geometry_epoch);
    approx(objects[&format!("{FOCUS_OBJECT_ID}:container")], 0.5);
    approx(objects[&format!("{FOCUS_OBJECT_ID}:component")], 0.5);
    approx(objects[&format!("{TARGET_CHILD_OBJECT_ID}:component")], 0.5);
    approx(
        objects[&format!("{TARGET_PEER_CHILD_OBJECT_ID}:component")],
        0.5,
    );
    assert_eq!(objects[&format!("{PEER_OBJECT_ID}:container")], 1.0);
    assert_eq!(objects[&format!("{PEER_OBJECT_ID}:component")], 0.0);
    assert_eq!(
        objects[&format!("{SIBLING_CHILD_OBJECT_ID}:component")],
        0.0
    );
    approx(paths[TARGET_PATH_ID], 0.5);

    let visible = runtime.visible_snapshot();
    assert!(
        visible
            .objects
            .iter()
            .any(|object| object.id == TARGET_CHILD_OBJECT_ID)
    );
    assert!(
        !visible
            .objects
            .iter()
            .any(|object| object.id == SIBLING_CHILD_OBJECT_ID)
    );
    assert!(visible.paths.iter().any(|path| path.id == TARGET_PATH_ID));
    assert_eq!(
        runtime.select_at(
            transformed_representation_screen_center(
                &runtime,
                &blended,
                TARGET_CHILD_OBJECT_ID,
                ":component",
            ),
            3.0,
        ),
        Some(HitTarget::Node(TARGET_CHILD_OBJECT_ID.into()))
    );
    runtime
        .set_visibility(VisibilityFilter {
            mode: VisibilityMode::Isolate,
            object_ids: vec![
                TARGET_CHILD_OBJECT_ID.into(),
                TARGET_PEER_CHILD_OBJECT_ID.into(),
            ],
            dim_opacity: 0.18,
        })
        .expect("target branch isolate resolves");
    assert_eq!(
        runtime.select_at(
            transformed_path_screen_midpoint(&runtime, &blended, TARGET_PATH_ID),
            5.0
        ),
        Some(HitTarget::Edge(TARGET_PATH_ID.into()))
    );
    runtime
        .set_visibility(VisibilityFilter::default())
        .expect("visibility fallback restores");

    // An exact outward return to progress zero reproduces the source weights;
    // clearing the override then proves omitted overrides retain global LOD.
    runtime
        .set_projection_override(Some(branch_override(0.0)))
        .expect("reverse override resolves");
    let reversed = runtime.prepare_frame(RendererBackend::Headless);
    assert_eq!(
        representation_weights(&runtime, &reversed),
        baseline_objects
    );
    assert_eq!(path_weights(&runtime, &reversed), baseline_paths);
    assert_eq!(reversed.geometry_epoch, geometry_epoch);

    runtime
        .set_projection_override(None)
        .expect("global fallback restores");
    let fallback = runtime.prepare_frame(RendererBackend::Headless);
    assert_eq!(
        representation_weights(&runtime, &fallback),
        baseline_objects
    );
    assert_eq!(path_weights(&runtime, &fallback), baseline_paths);
    assert_eq!(fallback.geometry_epoch, geometry_epoch);
}

#[test]
fn projection_object_opacity_and_pick_policy_keep_ghosts_visible_without_ancestor_or_relation_hits()
{
    let mut runtime = engine();
    let object = |id: &str,
                  detail: &str,
                  opacity: f32,
                  content_opacity: f32,
                  pickable: bool,
                  priority: i32| ProjectionObjectOverride {
        object_id: id.into(),
        source_representation_id: Some(format!("{id}:{detail}")),
        target_representation_id: Some(format!("{id}:{detail}")),
        source_opacity: Some(opacity),
        target_opacity: Some(opacity),
        source_content_opacity: Some(content_opacity),
        target_content_opacity: Some(content_opacity),
        source_pickable: Some(pickable),
        target_pickable: Some(pickable),
        source_pick_priority: Some(priority),
        target_pick_priority: Some(priority),
        ..ProjectionObjectOverride::default()
    };
    runtime
        .set_projection_override(Some(ProjectionOverride {
            id: "semantic-ghost-policy".into(),
            progress: 1.0,
            objects: vec![
                object(FOCUS_OBJECT_ID, "container", 1.0, 1.0, true, 1_100),
                object(PEER_OBJECT_ID, "container", 0.24, 0.24, true, 600),
                object(ROOT_OBJECT_ID, "context", 0.32, 0.0, false, 0),
            ],
            paths: vec![ProjectionPathOverride {
                path_id: CONNECTING_PATH_ID.into(),
                source_opacity: 0.10,
                target_opacity: 0.10,
            }],
            morph: None,
        }))
        .expect("ghost policy resolves");
    let frame = runtime.prepare_frame(RendererBackend::Headless);
    let opacity = object_opacity_totals(&runtime, &frame);
    approx(opacity[FOCUS_OBJECT_ID], 1.0);
    approx(opacity[PEER_OBJECT_ID], 0.24);
    approx(opacity[ROOT_OBJECT_ID], 0.32);
    let content_opacity = object_content_opacity_totals(&runtime, &frame);
    approx(content_opacity[FOCUS_OBJECT_ID], 1.0);
    approx(content_opacity[PEER_OBJECT_ID], 0.24);
    approx(content_opacity[ROOT_OBJECT_ID], 0.0);
    approx(path_weights(&runtime, &frame)[CONNECTING_PATH_ID], 0.10);

    assert_eq!(
        runtime.select_at(
            representation_screen_center(&runtime, PEER_OBJECT_ID, "container"),
            3.0
        ),
        Some(HitTarget::Node(PEER_OBJECT_ID.into())),
    );
    assert_ne!(
        runtime.select_at(
            representation_screen_center(&runtime, ROOT_OBJECT_ID, "context"),
            3.0
        ),
        Some(HitTarget::Node(ROOT_OBJECT_ID.into())),
    );
    assert_ne!(
        runtime.select_at(path_screen_midpoint(&runtime, CONNECTING_PATH_ID), 5.0),
        Some(HitTarget::Edge(CONNECTING_PATH_ID.into())),
    );
    let visible = runtime.visible_snapshot();
    assert!(
        visible
            .objects
            .iter()
            .any(|object| object.id == PEER_OBJECT_ID)
    );
    assert!(
        visible
            .objects
            .iter()
            .any(|object| object.id == ROOT_OBJECT_ID)
    );
    assert!(
        !visible
            .paths
            .iter()
            .any(|path| path.id == CONNECTING_PATH_ID)
    );

    runtime
        .set_projection_override(Some(ProjectionOverride {
            id: "semantic-focus-transfer".into(),
            progress: 0.5,
            objects: vec![ProjectionObjectOverride {
                object_id: FOCUS_OBJECT_ID.into(),
                source_representation_id: Some(format!("{FOCUS_OBJECT_ID}:container")),
                target_representation_id: Some(format!("{FOCUS_OBJECT_ID}:container")),
                source_opacity: Some(1.0),
                target_opacity: Some(0.24),
                source_content_opacity: Some(1.0),
                target_content_opacity: Some(0.24),
                ..ProjectionObjectOverride::default()
            }],
            paths: vec![],
            morph: None,
        }))
        .expect("content transfer resolves");
    let transfer = runtime.prepare_frame(RendererBackend::Headless);
    approx(
        object_opacity_totals(&runtime, &transfer)[FOCUS_OBJECT_ID],
        0.62,
    );
    approx(
        object_content_opacity_totals(&runtime, &transfer)[FOCUS_OBJECT_ID],
        0.62,
    );
}

#[test]
fn branch_override_owns_explicit_slots_even_when_camera_global_lod_is_code() {
    let mut runtime = engine();
    runtime.camera_mut().set_zoom(CODE_FOCUS_ZOOM);
    runtime.tick(0.0);
    let _ = runtime.prepare_frame(RendererBackend::Headless);
    runtime.tick(250.0);
    let global_code = runtime.prepare_frame(RendererBackend::Headless);
    let global_weights = representation_weights(&runtime, &global_code);
    let geometry_epoch = global_code.geometry_epoch;

    assert_eq!(global_weights[&format!("{ROOT_OBJECT_ID}:code")], 1.0);
    assert_eq!(
        global_weights[&format!("{CONTEXT_SIBLING_OBJECT_ID}:code")],
        1.0
    );
    assert_eq!(
        global_weights[&format!("{TARGET_CHILD_OBJECT_ID}:code")],
        1.0
    );

    runtime
        .set_projection_override(Some(ProjectionOverride {
            id: "semantic-lens:context-to-container".into(),
            progress: 0.5,
            objects: vec![
                ProjectionObjectOverride {
                    object_id: ROOT_OBJECT_ID.into(),
                    source_representation_id: Some(format!("{ROOT_OBJECT_ID}:context")),
                    target_representation_id: Some(format!("{ROOT_OBJECT_ID}:container")),
                    ..ProjectionObjectOverride::default()
                },
                ProjectionObjectOverride {
                    object_id: FOCUS_OBJECT_ID.into(),
                    source_representation_id: None,
                    target_representation_id: Some(format!("{FOCUS_OBJECT_ID}:container")),
                    ..ProjectionObjectOverride::default()
                },
                ProjectionObjectOverride {
                    object_id: CONTEXT_SIBLING_OBJECT_ID.into(),
                    source_representation_id: Some(format!("{CONTEXT_SIBLING_OBJECT_ID}:context")),
                    target_representation_id: Some(format!("{CONTEXT_SIBLING_OBJECT_ID}:context")),
                    ..ProjectionObjectOverride::default()
                },
                ProjectionObjectOverride {
                    object_id: TARGET_CHILD_OBJECT_ID.into(),
                    source_representation_id: None,
                    target_representation_id: None,
                    ..ProjectionObjectOverride::default()
                },
            ],
            paths: vec![],
            morph: None,
        }))
        .expect("cross-band ownership resolves independently of camera LOD");
    let lens = runtime.prepare_frame(RendererBackend::Headless);
    let lens_weights = representation_weights(&runtime, &lens);
    assert!(
        lens.objects
            .iter()
            .all(|draw| (draw.content_opacity - draw.opacity).abs() < 0.0001)
    );

    assert_eq!(lens.geometry_epoch, geometry_epoch);
    approx(lens_weights[&format!("{ROOT_OBJECT_ID}:context")], 0.5);
    approx(lens_weights[&format!("{ROOT_OBJECT_ID}:container")], 0.5);
    approx(lens_weights[&format!("{FOCUS_OBJECT_ID}:container")], 0.5);
    assert_eq!(
        lens_weights[&format!("{CONTEXT_SIBLING_OBJECT_ID}:context")],
        1.0
    );
    assert_eq!(
        lens_weights[&format!("{CONTEXT_SIBLING_OBJECT_ID}:code")],
        0.0
    );
    assert_eq!(
        lens_weights[&format!("{TARGET_CHILD_OBJECT_ID}:component")],
        0.0
    );
    assert_eq!(lens_weights[&format!("{TARGET_CHILD_OBJECT_ID}:code")], 0.0);

    runtime
        .set_projection_override(None)
        .expect("global L4 fallback restores");
    let restored = runtime.prepare_frame(RendererBackend::Headless);
    assert_eq!(representation_weights(&runtime, &restored), global_weights);
    assert_eq!(restored.geometry_epoch, geometry_epoch);
}

#[test]
fn branch_morph_is_monotonic_contained_and_exactly_reversible() {
    let mut runtime = engine();
    runtime.tick(0.0);
    let baseline = runtime.prepare_frame(RendererBackend::Headless);
    let geometry_epoch = baseline.geometry_epoch;

    let mut frames = Vec::new();
    for progress in [0.0, 0.5, 1.0, 0.5, 0.0] {
        runtime
            .set_projection_override(Some(branch_override(progress)))
            .expect("morph override resolves");
        frames.push(runtime.prepare_frame(RendererBackend::Headless));
    }

    let boundaries: Vec<_> = frames
        .iter()
        .map(|frame| {
            let source =
                transformed_representation_bounds(&runtime, frame, FOCUS_OBJECT_ID, ":container");
            let target =
                transformed_representation_bounds(&runtime, frame, FOCUS_OBJECT_ID, ":component");
            approx_rect(target, source);
            source
        })
        .collect();

    let source = boundaries[0];
    let midpoint = boundaries[1];
    let target = boundaries[2];
    approx_rect(
        midpoint,
        Rect::new(
            (source.x + target.x) / 2.0,
            (source.y + target.y) / 2.0,
            (source.width + target.width) / 2.0,
            (source.height + target.height) / 2.0,
        ),
    );
    assert!(source.width <= midpoint.width && midpoint.width <= target.width);
    assert!(source.height <= midpoint.height && midpoint.height <= target.height);
    approx_rect(boundaries[3], midpoint);
    approx_rect(boundaries[4], source);

    for (frame, boundary) in frames.iter().zip(&boundaries) {
        assert_eq!(frame.geometry_epoch, geometry_epoch);
        for object_id in [TARGET_CHILD_OBJECT_ID, TARGET_PEER_CHILD_OBJECT_ID] {
            let child = transformed_representation_bounds(&runtime, frame, object_id, ":component");
            assert!(
                rect_contains_rect(*boundary, child),
                "{object_id} must remain inside the morph boundary"
            );
        }
        for point in transformed_path_points(&runtime, frame, TARGET_PATH_ID) {
            assert!(point.x >= boundary.min_x() - 1e-4 && point.x <= boundary.max_x() + 1e-4);
            assert!(point.y >= boundary.min_y() - 1e-4 && point.y <= boundary.max_y() + 1e-4);
        }
    }

    let object_transforms = |frame: &ProtocolFrame| {
        frame
            .objects
            .iter()
            .filter_map(|draw| {
                let object = &runtime.snapshot().objects[draw.object_index];
                [
                    FOCUS_OBJECT_ID,
                    TARGET_CHILD_OBJECT_ID,
                    TARGET_PEER_CHILD_OBJECT_ID,
                ]
                .contains(&object.id.as_str())
                .then(|| {
                    (
                        object.representations[draw.representation_index].id.clone(),
                        (draw.transform, draw.clip),
                    )
                })
            })
            .collect::<BTreeMap<_, _>>()
    };
    let path_transform = |frame: &ProtocolFrame| {
        frame
            .paths
            .iter()
            .find_map(|draw| {
                (runtime.snapshot().paths[draw.path_index].id == TARGET_PATH_ID)
                    .then_some((draw.transform, draw.clip))
            })
            .expect("morph path draw")
    };
    assert_eq!(object_transforms(&frames[0]), object_transforms(&frames[4]));
    assert_eq!(object_transforms(&frames[1]), object_transforms(&frames[3]));
    assert_eq!(path_transform(&frames[0]), path_transform(&frames[4]));
    assert_eq!(path_transform(&frames[1]), path_transform(&frames[3]));
}

#[test]
fn branch_morph_queries_and_picks_far_authored_members_at_transformed_positions() {
    // The checked semantic-lens fixture now keeps owner bounds persistent
    // across bands. Expand only this test's target owner representation so the
    // hostile-broadphase regression still exercises a genuinely transformed
    // child without changing product geometry.
    let mut snapshot = scene_fixture();
    let focus = snapshot
        .objects
        .iter_mut()
        .find(|object| object.id == FOCUS_OBJECT_ID)
        .expect("focus object");
    let mut expanded_target = focus
        .representations
        .iter()
        .find(|representation| representation.id.ends_with(":component"))
        .and_then(|representation| representation.bounds)
        .expect("component bounds");
    expanded_target.width = 740.0;
    expanded_target.height = 478.0;
    focus
        .representations
        .iter_mut()
        .find(|representation| representation.id.ends_with(":component"))
        .expect("component representation")
        .bounds = Some(expanded_target);
    focus.bounds = expanded_target;
    let mut runtime = engine_from_snapshot(snapshot);
    let source_group = authored_representation_bounds(&runtime, FOCUS_OBJECT_ID, ":container");
    let target_group = authored_representation_bounds(&runtime, FOCUS_OBJECT_ID, ":component");
    let authored_child =
        authored_representation_bounds(&runtime, FAR_CHILD_OBJECT_ID, ":component");

    let early_progress = 0.01;
    let early_group = lerp_rect(source_group, target_group, early_progress);
    let early_child = map_rect(authored_child, target_group, early_group);
    runtime
        .camera_mut()
        .set_viewport(Viewport::new(60.0, 60.0, 1.0));
    runtime.camera_mut().set_zoom(CONTAINER_FOCUS_ZOOM);
    runtime.camera_mut().set_center(early_child.center());
    assert!(
        !authored_child.intersects(runtime.camera().visible_world_rect()),
        "hostile setup requires static child bounds outside the current viewport"
    );

    runtime
        .set_projection_override(Some(far_branch_override(early_progress as f32)))
        .expect("early far-side morph resolves");
    let early = runtime.prepare_frame(RendererBackend::Headless);
    let child_draw = early
        .objects
        .iter()
        .find(|draw| {
            let object = &runtime.snapshot().objects[draw.object_index];
            object.id == FAR_CHILD_OBJECT_ID
                && object.representations[draw.representation_index]
                    .id
                    .ends_with(":component")
        })
        .expect("morphed child must be a frame candidate despite static broadphase miss");
    assert!(child_draw.resident);
    assert!(child_draw.opacity > 0.0 && child_draw.opacity < 0.5);
    let path_draw = early
        .paths
        .iter()
        .find(|draw| runtime.snapshot().paths[draw.path_index].id == FAR_PATH_ID)
        .expect("morphed path must be a frame candidate despite static broadphase miss");
    assert!(path_draw.resident);
    assert!(path_draw.opacity > 0.0 && path_draw.opacity < 0.5);
    assert_ne!(
        runtime.select_at(
            transformed_representation_screen_center(
                &runtime,
                &early,
                FAR_CHILD_OBJECT_ID,
                ":component",
            ),
            3.0,
        ),
        Some(HitTarget::Node(FAR_CHILD_OBJECT_ID.into())),
        "target-only descendants remain source-side unpickable before 50%",
    );

    let midpoint_group = lerp_rect(source_group, target_group, 0.5);
    let midpoint_child = map_rect(authored_child, target_group, midpoint_group);
    runtime.camera_mut().set_center(midpoint_child.center());
    runtime
        .set_projection_override(Some(far_branch_override(0.5)))
        .expect("midpoint far-side morph resolves");
    let midpoint = runtime.prepare_frame(RendererBackend::Headless);
    assert_eq!(
        runtime.select_at(
            transformed_representation_screen_center(
                &runtime,
                &midpoint,
                FAR_CHILD_OBJECT_ID,
                ":component",
            ),
            3.0,
        ),
        Some(HitTarget::Node(FAR_CHILD_OBJECT_ID.into())),
    );

    runtime
        .set_visibility(VisibilityFilter {
            mode: VisibilityMode::Isolate,
            object_ids: vec![FAR_CHILD_OBJECT_ID.into(), FAR_PEER_CHILD_OBJECT_ID.into()],
            dim_opacity: 0.18,
        })
        .expect("far branch isolate resolves");
    assert_eq!(
        runtime.select_at(
            transformed_path_screen_midpoint(&runtime, &midpoint, FAR_PATH_ID),
            5.0,
        ),
        Some(HitTarget::Edge(FAR_PATH_ID.into())),
    );
}

#[test]
fn projection_progress_fast_path_preserves_topology_and_geometry_epoch() {
    let mut runtime = engine();
    runtime
        .set_projection_override(Some(branch_override(0.0)))
        .expect("projection topology resolves once");
    let topology = runtime
        .projection_override()
        .expect("active projection")
        .clone();
    let geometry_epoch = runtime
        .prepare_frame(RendererBackend::Headless)
        .geometry_epoch;

    for step in 1..=100 {
        let progress = step as f32 / 100.0;
        runtime
            .set_projection_override_progress("semantic-lens:architecture-model", progress)
            .expect("numeric progress update");
        let current = runtime.projection_override().expect("active projection");
        assert_eq!(current.id, topology.id);
        assert_eq!(current.objects, topology.objects);
        assert_eq!(current.paths, topology.paths);
        assert_eq!(current.morph, topology.morph);
        assert_eq!(current.progress, progress);
        assert_eq!(
            runtime
                .prepare_frame(RendererBackend::Headless)
                .geometry_epoch,
            geometry_epoch
        );
    }

    let before_invalid = runtime
        .projection_override()
        .expect("active projection")
        .clone();
    assert!(
        runtime
            .set_projection_override_progress("semantic-lens:other", 0.5)
            .is_err()
    );
    assert!(
        runtime
            .set_projection_override_progress("semantic-lens:architecture-model", f32::NAN)
            .is_err()
    );
    assert_eq!(runtime.projection_override(), Some(&before_invalid));
}

#[test]
fn visibility_rejects_unknown_ids_and_invalid_dim_opacity_atomically() {
    let mut engine = engine();
    let original = engine.visibility().clone();

    assert!(
        engine
            .set_visibility(VisibilityFilter {
                mode: VisibilityMode::Isolate,
                object_ids: vec!["object:missing".into()],
                dim_opacity: 0.18,
            })
            .is_err()
    );
    assert_eq!(engine.visibility(), &original);

    assert!(
        engine
            .set_visibility(VisibilityFilter {
                mode: VisibilityMode::Dim,
                object_ids: vec![FOCUS_OBJECT_ID.into()],
                dim_opacity: f32::NAN,
            })
            .is_err()
    );
    assert_eq!(engine.visibility(), &original);
}
