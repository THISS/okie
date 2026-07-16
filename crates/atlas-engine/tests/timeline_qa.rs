use std::collections::BTreeMap;

use atlas_engine::{
    Camera, CameraLimits, ProtocolTimelineFrame, ProtocolTimelinePlayer, Vec2, Viewport,
};
use atlas_protocol::{
    CameraKeyframeState, Easing, ObjectKeyframeState, PROTOCOL_VERSION, PathKeyframeState, Point,
    SceneSnapshot, TIMELINE_VERSION, Timeline, TimelineKeyframe,
};

const TARGET_OBJECT_ID: &str = "visual-node:lineage:system:okie";
const UNTOUCHED_OBJECT_ID: &str = "visual-node:lineage:actor:developer";
const TARGET_PATH_ID: &str = "visual-edge:context:visual-node%3Alineage%3Aactor%3Adeveloper>visual-node%3Alineage%3Asystem%3Aokie:uses";

fn fixture() -> (SceneSnapshot, Timeline, Camera) {
    let snapshot: SceneSnapshot =
        serde_json::from_str(include_str!("../../../fixtures/renderer/demo-scene.json"))
            .expect("scene fixture");
    let camera = Camera::new(
        Vec2::new(0.0, 0.0),
        1.0,
        Viewport::new(1_200.0, 800.0, 1.0),
        CameraLimits::default(),
    );
    let timeline = Timeline {
        protocol_version: PROTOCOL_VERSION,
        timeline_version: TIMELINE_VERSION,
        id: "timeline:qa".into(),
        scene_id: snapshot.scene_id.clone(),
        duration_ms: 2_500,
        looped: false,
        keyframes: vec![
            TimelineKeyframe {
                id: "keyframe:first".into(),
                at_ms: 1_000,
                easing: Easing::Linear,
                camera: Some(CameraKeyframeState {
                    center: Point { x: 100.0, y: 50.0 },
                    zoom: 2.0,
                }),
                object_states: vec![ObjectKeyframeState {
                    object_ids: vec![TARGET_OBJECT_ID.into()],
                    opacity: 0.5,
                    emphasis: 1.0,
                }],
                path_states: vec![PathKeyframeState {
                    path_ids: vec![TARGET_PATH_ID.into()],
                    opacity: 0.4,
                    emphasis: 0.8,
                    flow_speed: 2.0,
                    color: Some([1.0, 0.0, 0.0, 1.0]),
                }],
            },
            TimelineKeyframe {
                id: "keyframe:second".into(),
                at_ms: 2_000,
                easing: Easing::EaseOut,
                camera: Some(CameraKeyframeState {
                    center: Point { x: 200.0, y: 100.0 },
                    zoom: 4.0,
                }),
                object_states: vec![ObjectKeyframeState {
                    object_ids: vec![TARGET_OBJECT_ID.into()],
                    opacity: 0.0,
                    emphasis: 2.0,
                }],
                path_states: vec![PathKeyframeState {
                    path_ids: vec![TARGET_PATH_ID.into()],
                    opacity: 0.2,
                    emphasis: 1.6,
                    flow_speed: 4.0,
                    color: Some([0.0, 0.0, 1.0, 1.0]),
                }],
            },
        ],
    };
    (snapshot, timeline, camera)
}

fn sample_order(order: &[u32]) -> BTreeMap<u32, ProtocolTimelineFrame> {
    let (snapshot, timeline, camera) = fixture();
    let mut player =
        ProtocolTimelinePlayer::try_new(timeline, &snapshot, camera).expect("timeline installs");
    order
        .iter()
        .copied()
        .map(|position| {
            player.seek(position);
            (position, player.sample())
        })
        .collect()
}

fn approx(actual: f32, expected: f32) {
    assert!(
        (actual - expected).abs() <= 1e-6,
        "expected {expected}, received {actual}"
    );
}

fn approx64(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() <= 1e-9,
        "expected {expected}, received {actual}"
    );
}

#[test]
fn direct_forward_and_backward_seek_produce_identical_frames() {
    let ascending = [
        0, 1, 499, 500, 999, 1_000, 1_001, 1_499, 1_500, 1_999, 2_000, 2_001, 2_500,
    ];
    let descending = [
        2_500, 2_001, 2_000, 1_999, 1_500, 1_499, 1_001, 1_000, 999, 500, 499, 1, 0,
    ];
    let random = [
        1_499, 0, 2_001, 500, 1, 2_500, 999, 2_000, 1_001, 499, 1_500, 1_000, 1_999,
    ];

    assert_eq!(sample_order(&ascending), sample_order(&descending));
    assert_eq!(sample_order(&ascending), sample_order(&random));

    for position in ascending {
        assert_eq!(
            sample_order(&[position])[&position],
            sample_order(&ascending)[&position],
            "direct seek differs at {position} ms"
        );
    }
}

#[test]
fn keyframe_boundaries_sparse_defaults_and_incoming_easing_are_exact() {
    let (snapshot, timeline, camera) = fixture();
    let object_index = snapshot
        .objects
        .iter()
        .position(|object| object.id == TARGET_OBJECT_ID)
        .expect("object index");
    let untouched_object_index = snapshot
        .objects
        .iter()
        .position(|object| object.id == UNTOUCHED_OBJECT_ID)
        .expect("untouched object index");
    let path_index = snapshot
        .paths
        .iter()
        .position(|path| path.id == TARGET_PATH_ID)
        .expect("path index");
    let untouched_path_index = snapshot
        .paths
        .iter()
        .position(|path| path.id != TARGET_PATH_ID)
        .expect("untouched path index");
    let mut player =
        ProtocolTimelinePlayer::try_new(timeline, &snapshot, camera).expect("timeline installs");

    player.seek(0);
    let start = player.sample();
    assert_eq!(start.position_ms, 0);
    assert_eq!(start.keyframe_id.as_deref(), Some("keyframe:first"));
    approx(start.object_opacity[object_index], 1.0);
    approx(start.object_emphasis[object_index], 0.0);
    approx(start.path_opacity[path_index], 1.0);
    assert_eq!(start.path_color[path_index], None);
    approx64(start.camera_center.x, 0.0);
    approx64(start.camera_zoom, 1.0);

    player.seek(500);
    let halfway_first = player.sample();
    approx(halfway_first.object_opacity[object_index], 0.75);
    approx(halfway_first.object_emphasis[object_index], 0.5);
    approx(halfway_first.path_opacity[path_index], 0.7);
    approx(halfway_first.path_emphasis[path_index], 0.4);
    assert_eq!(
        halfway_first.path_color[path_index],
        Some([1.0, 0.0, 0.0, 0.5])
    );
    approx64(halfway_first.camera_center.x, 50.0);
    approx64(halfway_first.camera_center.y, 25.0);
    approx64(halfway_first.camera_zoom, 2.0_f64.sqrt());

    player.seek(1_000);
    let first = player.sample();
    assert_eq!(first.keyframe_id.as_deref(), Some("keyframe:first"));
    approx(first.object_opacity[object_index], 0.5);
    approx(first.path_opacity[path_index], 0.4);
    approx64(first.camera_center.x, 100.0);

    player.seek(1_500);
    let halfway_second = player.sample();
    // EaseOut is quartic, so its value at 0.5 is 0.9375. The incoming
    // second keyframe owns this segment's easing.
    approx(halfway_second.object_opacity[object_index], 0.03125);
    approx(halfway_second.object_emphasis[object_index], 1.9375);
    approx(halfway_second.path_opacity[path_index], 0.2125);
    approx(halfway_second.path_emphasis[path_index], 1.55);
    assert_eq!(
        halfway_second.path_color[path_index],
        Some([0.0625, 0.0, 0.9375, 1.0])
    );
    approx64(halfway_second.camera_center.x, 193.75);
    approx64(halfway_second.camera_center.y, 96.875);
    approx64(
        halfway_second.camera_zoom,
        (2.0_f64.ln() + (4.0_f64.ln() - 2.0_f64.ln()) * 0.9375).exp(),
    );

    player.seek(2_000);
    let second = player.sample();
    assert_eq!(second.keyframe_id.as_deref(), Some("keyframe:second"));
    approx(second.object_opacity[object_index], 0.0);
    approx(second.path_opacity[path_index], 0.2);
    approx64(second.camera_center.x, 200.0);
    approx64(second.camera_zoom, 4.0);

    player.seek(u32::MAX);
    let held = player.sample();
    assert_eq!(held.position_ms, 2_500);
    assert_eq!(held.object_opacity, second.object_opacity);
    assert_eq!(held.path_opacity, second.path_opacity);
    assert_eq!(held.camera_center, second.camera_center);
    assert_eq!(held.camera_zoom, second.camera_zoom);

    for frame in [
        &start,
        &halfway_first,
        &first,
        &halfway_second,
        &second,
        &held,
    ] {
        approx(frame.object_opacity[untouched_object_index], 1.0);
        approx(frame.object_emphasis[untouched_object_index], 0.0);
        approx(frame.path_opacity[untouched_path_index], 1.0);
        approx(frame.path_emphasis[untouched_path_index], 0.0);
        assert_eq!(frame.path_color[untouched_path_index], None);
    }
}

#[test]
fn reduced_motion_snaps_to_incoming_targets_without_losing_time_or_starting_flow() {
    let (snapshot, timeline, camera) = fixture();
    let object_index = snapshot
        .objects
        .iter()
        .position(|object| object.id == TARGET_OBJECT_ID)
        .expect("object index");
    let path_index = snapshot
        .paths
        .iter()
        .position(|path| path.id == TARGET_PATH_ID)
        .expect("path index");
    let mut player =
        ProtocolTimelinePlayer::try_new(timeline, &snapshot, camera).expect("timeline installs");

    player.seek(500);
    let first = player.sample_with_motion(true);
    assert_eq!(first.position_ms, 500);
    assert_eq!(first.keyframe_id.as_deref(), Some("keyframe:first"));
    approx(first.object_opacity[object_index], 0.5);
    approx(first.path_opacity[path_index], 0.4);
    approx(first.path_flow_phase[path_index], 0.0);
    approx64(first.camera_center.x, 100.0);
    approx64(first.camera_zoom, 2.0);

    player.seek(1_500);
    let second = player.sample_with_motion(true);
    assert_eq!(second.position_ms, 1_500);
    assert_eq!(second.keyframe_id.as_deref(), Some("keyframe:second"));
    approx(second.object_opacity[object_index], 0.0);
    approx(second.path_opacity[path_index], 0.2);
    approx(second.path_flow_phase[path_index], 0.0);
    approx64(second.camera_center.x, 200.0);
    approx64(second.camera_zoom, 4.0);
}

#[test]
fn timeline_install_rejects_unknown_ids_duplicate_targets_and_non_increasing_times() {
    let (snapshot, timeline, camera) = fixture();

    let mut unknown = timeline.clone();
    unknown.keyframes[0].object_states[0].object_ids = vec!["object:missing".into()];
    assert!(
        ProtocolTimelinePlayer::try_new(unknown, &snapshot, camera)
            .expect_err("unknown object must fail")
            .to_string()
            .contains("unknown object object:missing")
    );

    let mut duplicate_target = timeline.clone();
    duplicate_target.keyframes[0]
        .object_states
        .push(ObjectKeyframeState {
            object_ids: vec![TARGET_OBJECT_ID.into()],
            opacity: 1.0,
            emphasis: 0.0,
        });
    assert!(
        ProtocolTimelinePlayer::try_new(duplicate_target, &snapshot, camera)
            .expect_err("duplicate target must fail")
            .to_string()
            .contains(&format!("duplicate id {TARGET_OBJECT_ID}"))
    );

    let mut duplicate_time = timeline;
    duplicate_time.keyframes[1].at_ms = duplicate_time.keyframes[0].at_ms;
    assert!(
        ProtocolTimelinePlayer::try_new(duplicate_time, &snapshot, camera)
            .expect_err("non-increasing keyframe time must fail")
            .to_string()
            .contains("time must strictly increase")
    );
}
