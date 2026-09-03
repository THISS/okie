use std::time::Instant;

use atlas_engine::{Camera, CameraLimits, ProtocolEngine, RendererBackend, Vec2, Viewport};
use atlas_protocol::{
    ArrowHead, Color, LodRange, Point, Primitive, Rect, SceneObject, ScenePath, SceneSnapshot, Stroke,
};

/// CLA-67: GPU-engine CPU frame cost vs node/edge count (ProtocolEngine cull/LOD/draw-list).
/// Rasterization is browser wgpu; this is the work that always runs before GPU submit.

const COUNTS: [usize; 6] = [25, 50, 100, 200, 400, 800];
const VIEWPORT: Viewport = Viewport {
    css_width: 1280.0,
    css_height: 720.0,
    device_pixel_ratio: 1.0,
};

fn grid_scene(nodes: usize, edges: usize) -> SceneSnapshot {
    let columns = ((nodes as f32) * (16.0 / 9.0)).sqrt().ceil() as usize;
    let columns = columns.max(1);
    let cell_width = 118.0;
    let cell_height = 82.0;
    let node_width = 78.0;
    let node_height = 48.0;
    let fill: Color = [0.094, 0.216, 0.38, 1.0];
    let stroke_color: Color = [0.957, 0.969, 1.0, 1.0];
    let objects: Vec<SceneObject> = (0..nodes)
        .map(|index| {
            let column = (index % columns) as f32;
            let row = (index / columns) as f32;
            let x = column * cell_width + 20.0;
            let y = row * cell_height + 20.0;
            let bounds = Rect {
                x,
                y,
                width: node_width,
                height: node_height,
            };
            let id = format!("stress:node:{index:05}");
            SceneObject {
                id: id.clone(),
                parent_id: None,
                z_index: 1,
                bounds,
                pickable: true,
                representations: vec![atlas_protocol::Representation {
                    id: format!("{id}:overview"),
                    lod: LodRange {
                        min_zoom: 0.0,
                        max_zoom: Some(8.0),
                        fade_width: 0.1,
                        hysteresis: 0.04,
                    },
                    bounds: None,
                    primitives: vec![Primitive::RoundedRect {
                        rect: bounds,
                        radius: 7.0,
                        fill,
                        stroke: Some(Stroke {
                            color: stroke_color,
                            width: 1.0,
                        }),
                    }],
                }],
            }
        })
        .collect();
    let paths: Vec<ScenePath> = (0..edges)
        .map(|index| {
            let from = index % nodes;
            let to = (from + 1 + (index / nodes)) % nodes;
            let from_object = &objects[from];
            let to_object = &objects[to];
            ScenePath {
                id: format!("stress:edge:{index:05}"),
                from_object_id: from_object.id.clone(),
                to_object_id: to_object.id.clone(),
                points: vec![
                    Point {
                        x: from_object.bounds.x + from_object.bounds.width,
                        y: from_object.bounds.y + from_object.bounds.height / 2.0,
                    },
                    Point {
                        x: to_object.bounds.x,
                        y: to_object.bounds.y + to_object.bounds.height / 2.0,
                    },
                ],
                stroke: stroke_color,
                width: 1.5,
                arrow: ArrowHead::End,
                optional: false,
                pickable: true,
                lod: LodRange {
                    min_zoom: 0.0,
                    max_zoom: None,
                    fade_width: 0.1,
                    hysteresis: 0.04,
                },
            }
        })
        .collect();
    let width = columns as f32 * cell_width + 40.0;
    let rows = nodes.div_ceil(columns);
    let height = rows as f32 * cell_height + 40.0;
    SceneSnapshot {
        protocol_version: atlas_protocol::PROTOCOL_VERSION,
        scene_id: format!("scene:band-cost:{nodes}"),
        revision: 1,
        world_bounds: Rect {
            x: 0.0,
            y: 0.0,
            width,
            height,
        },
        objects,
        paths,
    }
}

fn engine_for(nodes: usize, edges: usize) -> ProtocolEngine {
    let snapshot = grid_scene(nodes, edges);
    let world = snapshot.world_bounds;
    let camera = Camera::new(
        Vec2::new(
            f64::from(world.x + world.width / 2.0),
            f64::from(world.y + world.height / 2.0),
        ),
        1.0,
        VIEWPORT,
        CameraLimits::default(),
    );
    ProtocolEngine::try_new(snapshot, camera).expect("valid band-cost scene")
}

fn median_ms(mut run: impl FnMut(), samples: usize, warmup: usize) -> f64 {
    for _ in 0..warmup {
        run();
    }
    let mut times = Vec::with_capacity(samples);
    for _ in 0..samples {
        let started = Instant::now();
        run();
        times.push(started.elapsed().as_secs_f64() * 1_000.0);
    }
    times.sort_by(|left, right| left.total_cmp(right));
    times[times.len() / 2]
}

#[test]
fn protocol_engine_frame_cost_grows_with_band_size_and_stays_interactive_at_healthy_count() {
    let mut first_frames = Vec::new();
    for nodes in COUNTS {
        let edges = nodes;
        let mut engine = engine_for(nodes, edges);
        engine.tick(0.0);
        let load_ms = median_ms(
            || {
                engine_for(nodes, edges);
            },
            3,
            1,
        );
        let first_ms = median_ms(
            || {
                engine.tick(16.0);
                let _ = engine.prepare_frame(RendererBackend::Headless);
            },
            5,
            1,
        );
        let pan_ms = median_ms(
            || {
                engine.pan_screen(Vec2::new(24.0, 16.0));
                engine.tick(32.0);
                let _ = engine.prepare_frame(RendererBackend::Headless);
            },
            5,
            1,
        );
        let zoom_ms = median_ms(
            || {
                engine.zoom_at(Vec2::new(640.0, 360.0), 1.1);
                engine.tick(48.0);
                let _ = engine.prepare_frame(RendererBackend::Headless);
            },
            5,
            1,
        );
        first_frames.push(first_ms);
        eprintln!(
            "engine nodes={nodes} edges={edges} load={load_ms:.3}ms first={first_ms:.3}ms pan={pan_ms:.3}ms zoom={zoom_ms:.3}ms"
        );
        assert!(
            first_ms < 50.0,
            "GPU-engine CPU first frame at {nodes} nodes was {first_ms}ms; hang-level cost is a CLA-67 table miss"
        );
        assert!(pan_ms < 50.0, "pan at {nodes} was {pan_ms}ms");
        assert!(zoom_ms < 50.0, "zoom at {nodes} was {zoom_ms}ms");
        if nodes <= 200 {
            assert!(
                first_ms < 8.0,
                "healthy GPU-engine CPU frame at {nodes} was {first_ms}ms (want < 8ms headroom under 16.7ms)"
            );
        }
    }
    assert!(
        first_frames[0] <= first_frames[first_frames.len() - 1] + 1.0,
        "largest band should not be cheaper than the smallest beyond noise"
    );
}
