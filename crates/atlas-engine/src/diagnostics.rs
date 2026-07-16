use serde::{Deserialize, Serialize};

use crate::SemanticLevel;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RendererBackend {
    WebGpu,
    WebGl2,
    Metal,
    Vulkan,
    DirectX12,
    OpenGl,
    #[default]
    Headless,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FrameDiagnostics {
    pub backend: RendererBackend,
    pub semantic_level: SemanticLevel,
    pub visible_nodes: u32,
    pub visible_edges: u32,
    #[serde(default)]
    pub candidate_nodes: u32,
    #[serde(default)]
    pub candidate_edges: u32,
    #[serde(default)]
    pub resident_nodes: u32,
    #[serde(default)]
    pub resident_edges: u32,
    #[serde(default)]
    pub retained_view_reused: bool,
    pub culled_nodes: u32,
    pub culled_edges: u32,
    pub draw_calls: u32,
    pub frame_time_ms: f32,
}
