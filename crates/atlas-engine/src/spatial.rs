use std::collections::HashMap;

use atlas_protocol::{ScenePath, SceneSnapshot};

use crate::Rect;

const DEFAULT_CELL_SIZE: f64 = 512.0;
type Cell = (i32, i32);

#[derive(Debug, Clone)]
pub(crate) struct SpatialIndex {
    cell_size: f64,
    object_cells: HashMap<Cell, Vec<usize>>,
    path_cells: HashMap<Cell, Vec<usize>>,
    object_count: usize,
    path_count: usize,
    path_bounds: Vec<Option<Rect>>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct SpatialQueryScratch {
    marks: Vec<u32>,
    generation: u32,
    results: Vec<usize>,
}

impl SpatialQueryScratch {
    fn begin(&mut self, count: usize) {
        if self.marks.len() < count {
            self.marks.resize(count, 0);
        }
        self.generation = self.generation.wrapping_add(1);
        if self.generation == 0 {
            self.marks.fill(0);
            self.generation = 1;
        }
        self.results.clear();
    }

    fn insert(&mut self, index: usize) {
        if self.marks[index] == self.generation {
            return;
        }
        self.marks[index] = self.generation;
        self.results.push(index);
    }
}

impl SpatialIndex {
    pub(crate) fn build(snapshot: &SceneSnapshot) -> Self {
        Self::build_with_target(snapshot, None)
    }

    /// During a transition, index the swept union so moving geometry remains a
    /// candidate without rebuilding the grid on every animation frame.
    pub(crate) fn build_with_target(
        snapshot: &SceneSnapshot,
        target: Option<&SceneSnapshot>,
    ) -> Self {
        let target_object_bounds: HashMap<_, _> = target
            .into_iter()
            .flat_map(|snapshot| &snapshot.objects)
            .map(|object| (object.id.as_str(), protocol_rect(object.bounds)))
            .collect();
        let target_path_bounds: HashMap<_, _> = target
            .into_iter()
            .flat_map(|snapshot| &snapshot.paths)
            .filter_map(|path| path_bounds(path).map(|bounds| (path.id.as_str(), bounds)))
            .collect();
        let mut index = Self {
            cell_size: DEFAULT_CELL_SIZE,
            object_cells: HashMap::new(),
            path_cells: HashMap::new(),
            object_count: snapshot.objects.len(),
            path_count: snapshot.paths.len(),
            path_bounds: snapshot.paths.iter().map(path_bounds).collect(),
        };
        for (object_index, object) in snapshot.objects.iter().enumerate() {
            let mut bounds = protocol_rect(object.bounds);
            if let Some(target_bounds) = target_object_bounds.get(object.id.as_str()) {
                bounds = bounds.union(*target_bounds);
            }
            insert_bounds(
                &mut index.object_cells,
                bounds,
                object_index,
                index.cell_size,
            );
        }
        for (path_index, path) in snapshot.paths.iter().enumerate() {
            let Some(mut bounds) = path_bounds(path) else {
                continue;
            };
            if let Some(target_bounds) = target_path_bounds.get(path.id.as_str()) {
                bounds = bounds.union(*target_bounds);
            }
            insert_bounds(
                &mut index.path_cells,
                bounds.expand(f64::from(path.width)),
                path_index,
                index.cell_size,
            );
        }
        index
    }

    pub(crate) fn query_objects(&self, bounds: Rect) -> Vec<usize> {
        let mut scratch = SpatialQueryScratch::default();
        self.query_objects_into(bounds, &mut scratch);
        scratch.results
    }

    pub(crate) fn query_objects_into<'a>(
        &self,
        bounds: Rect,
        scratch: &'a mut SpatialQueryScratch,
    ) -> &'a [usize] {
        query_cells_into(
            &self.object_cells,
            bounds,
            self.cell_size,
            self.object_count,
            scratch,
        );
        &scratch.results
    }

    pub(crate) fn query_paths(&self, bounds: Rect) -> Vec<usize> {
        let mut scratch = SpatialQueryScratch::default();
        self.query_paths_into(bounds, &mut scratch);
        scratch.results
    }

    pub(crate) fn query_paths_into<'a>(
        &self,
        bounds: Rect,
        scratch: &'a mut SpatialQueryScratch,
    ) -> &'a [usize] {
        query_cells_into(
            &self.path_cells,
            bounds,
            self.cell_size,
            self.path_count,
            scratch,
        );
        &scratch.results
    }

    pub(crate) fn path_bounds(&self, index: usize) -> Option<Rect> {
        self.path_bounds.get(index).copied().flatten()
    }

    pub(crate) fn refresh_path_bounds(
        &mut self,
        snapshot: &SceneSnapshot,
        indices: impl IntoIterator<Item = usize>,
    ) {
        for index in indices {
            if let (Some(stored), Some(path)) =
                (self.path_bounds.get_mut(index), snapshot.paths.get(index))
            {
                *stored = path_bounds(path);
            }
        }
    }
}

fn insert_bounds(
    cells: &mut HashMap<Cell, Vec<usize>>,
    bounds: Rect,
    index: usize,
    cell_size: f64,
) {
    let (min_x, min_y, max_x, max_y) = cell_range(bounds, cell_size);
    for y in min_y..=max_y {
        for x in min_x..=max_x {
            cells.entry((x, y)).or_default().push(index);
        }
    }
}

fn query_cells_into(
    cells: &HashMap<Cell, Vec<usize>>,
    bounds: Rect,
    cell_size: f64,
    total_count: usize,
    scratch: &mut SpatialQueryScratch,
) {
    scratch.begin(total_count);
    let (min_x, min_y, max_x, max_y) = cell_range(bounds, cell_size);
    let width = i64::from(max_x) - i64::from(min_x) + 1;
    let height = i64::from(max_y) - i64::from(min_y) + 1;
    if width.saturating_mul(height) > cells.len().saturating_mul(4) as i64 {
        scratch.results.extend(0..total_count);
        return;
    }
    for y in min_y..=max_y {
        for x in min_x..=max_x {
            if let Some(indices) = cells.get(&(x, y)) {
                for index in indices.iter().copied() {
                    scratch.insert(index);
                }
            }
        }
    }
    scratch.results.sort_unstable();
}

fn cell_range(bounds: Rect, cell_size: f64) -> (i32, i32, i32, i32) {
    (
        floor_to_i32(bounds.min_x() / cell_size),
        floor_to_i32(bounds.min_y() / cell_size),
        floor_to_i32(bounds.max_x() / cell_size),
        floor_to_i32(bounds.max_y() / cell_size),
    )
}

fn floor_to_i32(value: f64) -> i32 {
    value
        .floor()
        .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
}

fn protocol_rect(rect: atlas_protocol::Rect) -> Rect {
    Rect::new(
        f64::from(rect.x),
        f64::from(rect.y),
        f64::from(rect.width),
        f64::from(rect.height),
    )
}

fn path_bounds(path: &ScenePath) -> Option<Rect> {
    let first = path.points.first()?;
    let mut min_x = first.x;
    let mut max_x = first.x;
    let mut min_y = first.y;
    let mut max_y = first.y;
    for point in &path.points[1..] {
        min_x = min_x.min(point.x);
        max_x = max_x.max(point.x);
        min_y = min_y.min(point.y);
        max_y = max_y.max(point.y);
    }
    Some(Rect::new(
        f64::from(min_x),
        f64::from(min_y),
        f64::from((max_x - min_x).max(1.0)),
        f64::from((max_y - min_y).max(1.0)),
    ))
}

#[cfg(test)]
mod tests {
    use atlas_protocol::SceneSnapshot;

    use super::*;

    #[test]
    fn fixture_query_reduces_candidates_for_local_view() {
        let snapshot: SceneSnapshot =
            serde_json::from_str(include_str!("../../../fixtures/renderer/demo-scene.json"))
                .unwrap();
        let index = SpatialIndex::build(&snapshot);
        let candidates = index.query_objects(Rect::new(430.0, 190.0, 400.0, 260.0));
        assert!(!candidates.is_empty());
        assert!(candidates.len() < snapshot.objects.len());
    }

    #[test]
    fn transition_index_covers_destination_bounds() {
        let snapshot: SceneSnapshot =
            serde_json::from_str(include_str!("../../../fixtures/renderer/demo-scene.json"))
                .unwrap();
        let mut target = snapshot.clone();
        target.objects[0].bounds.x += 5_000.0;
        let index = SpatialIndex::build_with_target(&snapshot, Some(&target));
        let candidates = index.query_objects(protocol_rect(target.objects[0].bounds));
        assert!(candidates.contains(&0));
    }

    #[test]
    fn repeated_queries_reuse_scratch_storage_and_match_allocating_query() {
        let snapshot: SceneSnapshot =
            serde_json::from_str(include_str!("../../../fixtures/renderer/demo-scene.json"))
                .unwrap();
        let index = SpatialIndex::build(&snapshot);
        let bounds = Rect::new(430.0, 190.0, 400.0, 260.0);
        let expected = index.query_objects(bounds);
        let mut scratch = SpatialQueryScratch::default();

        assert_eq!(index.query_objects_into(bounds, &mut scratch), expected);
        let marks_capacity = scratch.marks.capacity();
        let results_capacity = scratch.results.capacity();
        assert_eq!(index.query_objects_into(bounds, &mut scratch), expected);
        assert_eq!(scratch.marks.capacity(), marks_capacity);
        assert_eq!(scratch.results.capacity(), results_capacity);
    }
}
