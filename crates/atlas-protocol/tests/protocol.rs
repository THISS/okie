use atlas_protocol::{
    Easing, Primitive, ProtocolError, ScenePatch, SceneSnapshot, Timeline, Transition,
};

const SCENE: &str = include_str!("../../../fixtures/renderer/demo-scene.json");
const TIMELINE: &str = include_str!("../../../fixtures/renderer/demo-timeline.json");

#[test]
fn demo_scene_deserializes_and_validates() {
    let scene: SceneSnapshot = serde_json::from_str(SCENE).expect("fixture must deserialize");
    scene.validate().expect("fixture must validate");
    let encoded = serde_json::to_string(&scene).expect("fixture must serialize");
    let round_trip: SceneSnapshot = serde_json::from_str(&encoded).expect("round trip");
    assert_eq!(round_trip, scene);
}

#[test]
fn demo_timeline_deserializes_and_validates() {
    let scene: SceneSnapshot = serde_json::from_str(SCENE).expect("scene fixture");
    let timeline: Timeline = serde_json::from_str(TIMELINE).expect("timeline fixture");
    timeline
        .validate_for(&scene)
        .expect("timeline must validate");
}

#[test]
fn rejects_out_of_order_patch() {
    let scene: SceneSnapshot = serde_json::from_str(SCENE).expect("scene fixture");
    let patch = ScenePatch {
        protocol_version: 1,
        scene_id: scene.scene_id.clone(),
        base_revision: scene.revision + 1,
        revision: scene.revision + 2,
        world_bounds: None,
        upsert_objects: vec![],
        remove_object_ids: vec![],
        upsert_paths: vec![],
        remove_path_ids: vec![],
        transition: None,
    };
    assert!(matches!(
        patch.validate_against(&scene),
        Err(ProtocolError::RevisionMismatch { .. })
    ));
}

#[test]
fn applies_a_coherent_patch_deterministically() {
    let scene: SceneSnapshot = serde_json::from_str(SCENE).expect("scene fixture");
    let removed_id = "visual-node:lineage:actor:developer";
    let removed_path_ids: Vec<_> = scene
        .paths
        .iter()
        .filter(|path| path.from_object_id == removed_id || path.to_object_id == removed_id)
        .map(|path| path.id.clone())
        .collect();
    let patch = ScenePatch {
        protocol_version: 1,
        scene_id: scene.scene_id.clone(),
        base_revision: scene.revision,
        revision: scene.revision + 1,
        world_bounds: None,
        upsert_objects: vec![],
        remove_object_ids: vec![removed_id.into()],
        upsert_paths: vec![],
        remove_path_ids: removed_path_ids,
        transition: None,
    };
    let next = patch.apply_to(&scene).expect("coherent patch");
    assert_eq!(next.revision, scene.revision + 1);
    assert!(!next.objects.iter().any(|object| object.id == removed_id));
    assert!(next.objects.windows(2).all(|pair| pair[0].id < pair[1].id));
}

#[test]
fn scene_rejects_non_finite_geometry_and_invalid_dimensions() {
    let scene: SceneSnapshot = serde_json::from_str(SCENE).expect("scene fixture");
    for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let mut candidate = scene.clone();
        candidate.objects[0].bounds.x = invalid;
        assert!(
            candidate.validate().is_err(),
            "accepted object coordinate {invalid}"
        );

        let mut candidate = scene.clone();
        candidate.paths[0].points[0].y = invalid;
        assert!(
            candidate.validate().is_err(),
            "accepted path coordinate {invalid}"
        );
    }

    for invalid in [0.0, -1.0, f32::INFINITY] {
        let mut candidate = scene.clone();
        candidate.objects[0].bounds.width = invalid;
        assert!(
            candidate.validate().is_err(),
            "accepted object width {invalid}"
        );

        let mut candidate = scene.clone();
        candidate.paths[0].width = invalid;
        assert!(
            candidate.validate().is_err(),
            "accepted path width {invalid}"
        );
    }
}

#[test]
fn scene_rejects_non_finite_primitives_colors_lod_and_duplicate_representations() {
    let scene: SceneSnapshot = serde_json::from_str(SCENE).expect("scene fixture");

    let mut invalid_color = scene.clone();
    let color_primitive = invalid_color
        .objects
        .iter_mut()
        .flat_map(|object| object.representations.iter_mut())
        .flat_map(|representation| representation.primitives.iter_mut())
        .find(|primitive| matches!(primitive, Primitive::RoundedRect { .. }))
        .expect("fixture rounded rectangle");
    match color_primitive {
        Primitive::RoundedRect { fill, .. } => fill[0] = f32::NAN,
        other => panic!("unexpected fixture primitive: {other:?}"),
    }
    assert!(matches!(
        invalid_color.validate(),
        Err(ProtocolError::InvalidColor(_))
    ));

    let mut invalid_primitive = scene.clone();
    let geometry_primitive = invalid_primitive
        .objects
        .iter_mut()
        .flat_map(|object| object.representations.iter_mut())
        .flat_map(|representation| representation.primitives.iter_mut())
        .find(|primitive| matches!(primitive, Primitive::RoundedRect { .. }))
        .expect("fixture rounded rectangle");
    match geometry_primitive {
        Primitive::RoundedRect { radius, .. } => *radius = f32::INFINITY,
        other => panic!("unexpected fixture primitive: {other:?}"),
    }
    assert!(matches!(
        invalid_primitive.validate(),
        Err(ProtocolError::InvalidPrimitive(_))
    ));

    let mut invalid_lod = scene.clone();
    invalid_lod.objects[0].representations[0].lod.fade_width = f32::NEG_INFINITY;
    assert!(matches!(
        invalid_lod.validate(),
        Err(ProtocolError::InvalidLod(_))
    ));

    let mut duplicate_representation = scene.clone();
    let representation_id = duplicate_representation.objects[0].representations[0]
        .id
        .clone();
    duplicate_representation.objects[1].representations[0].id = representation_id;
    assert!(matches!(
        duplicate_representation.validate(),
        Err(ProtocolError::DuplicateRepresentationId(_))
    ));

    let mut invalid_path_color = scene.clone();
    invalid_path_color.paths[0].stroke[3] = 1.1;
    assert!(matches!(
        invalid_path_color.validate(),
        Err(ProtocolError::InvalidColor(_))
    ));
}

#[test]
fn timeline_rejects_non_finite_camera_and_effect_values() {
    let scene: SceneSnapshot = serde_json::from_str(SCENE).expect("scene fixture");
    let timeline: Timeline = serde_json::from_str(TIMELINE).expect("timeline fixture");

    for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let mut candidate = timeline.clone();
        candidate.keyframes[0]
            .camera
            .as_mut()
            .expect("camera")
            .center
            .x = invalid;
        assert!(
            candidate.validate_for(&scene).is_err(),
            "accepted camera center {invalid}"
        );

        let mut candidate = timeline.clone();
        candidate.keyframes[0].camera.as_mut().expect("camera").zoom = invalid;
        assert!(
            candidate.validate_for(&scene).is_err(),
            "accepted camera zoom {invalid}"
        );

        let mut candidate = timeline.clone();
        candidate.keyframes[0].object_states[0].opacity = invalid;
        assert!(
            candidate.validate_for(&scene).is_err(),
            "accepted opacity {invalid}"
        );

        let mut candidate = timeline.clone();
        let path_keyframe = candidate
            .keyframes
            .iter_mut()
            .find(|keyframe| !keyframe.path_states.is_empty())
            .expect("path keyframe");
        path_keyframe.path_states[0].flow_speed = invalid;
        assert!(
            candidate.validate_for(&scene).is_err(),
            "accepted flow speed {invalid}"
        );
    }

    let mut invalid_opacity = timeline.clone();
    invalid_opacity.keyframes[0].object_states[0].opacity = 1.1;
    assert!(matches!(
        invalid_opacity.validate_for(&scene),
        Err(ProtocolError::InvalidEffect(_))
    ));

    let mut invalid_color = timeline.clone();
    invalid_color
        .keyframes
        .iter_mut()
        .find(|keyframe| !keyframe.path_states.is_empty())
        .expect("path keyframe")
        .path_states[0]
        .color = Some([0.0, f32::INFINITY, 0.0, 1.0]);
    assert!(matches!(
        invalid_color.validate_for(&scene),
        Err(ProtocolError::InvalidColor(_))
    ));
}

#[test]
fn patch_validation_rejects_non_finite_payloads_duplicates_and_invalid_timing() {
    let scene: SceneSnapshot = serde_json::from_str(SCENE).expect("scene fixture");
    let mut patch = empty_patch(&scene);
    let mut invalid_object = scene.objects[0].clone();
    invalid_object.bounds.height = f32::NAN;
    patch.upsert_objects.push(invalid_object);
    assert!(patch.validate_against(&scene).is_err());

    let mut patch = empty_patch(&scene);
    patch.world_bounds = Some(atlas_protocol::Rect {
        x: 0.0,
        y: f32::INFINITY,
        width: 100.0,
        height: 100.0,
    });
    assert!(patch.validate_against(&scene).is_err());

    let mut patch = empty_patch(&scene);
    patch.upsert_objects = vec![scene.objects[0].clone(), scene.objects[0].clone()];
    assert!(matches!(
        patch.validate_against(&scene),
        Err(ProtocolError::DuplicateId(_))
    ));

    let mut patch = empty_patch(&scene);
    patch.transition = Some(Transition {
        duration_ms: 0,
        easing: Easing::Linear,
    });
    assert!(matches!(
        patch.validate_against(&scene),
        Err(ProtocolError::InvalidTransition)
    ));
}

fn empty_patch(scene: &SceneSnapshot) -> ScenePatch {
    ScenePatch {
        protocol_version: 1,
        scene_id: scene.scene_id.clone(),
        base_revision: scene.revision,
        revision: scene.revision + 1,
        world_bounds: None,
        upsert_objects: vec![],
        remove_object_ids: vec![],
        upsert_paths: vec![],
        remove_path_ids: vec![],
        transition: None,
    }
}
