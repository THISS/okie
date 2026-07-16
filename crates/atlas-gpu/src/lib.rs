//! WebGPU-first rendering for the atlas protocol, constrained to WebGL2-safe
//! vertex/index/uniform capabilities. No compute or storage buffers are used.

mod glyph;
mod mesh;
mod surface;

pub use glyph::{GlyphAtlas, GlyphQuad};
pub use mesh::{
    ActiveMeshStream, GpuMesh, MeshStats, Vertex, VertexStyle, build_active_mesh_stream,
    build_flow_vertices, build_mesh, build_style_vertices,
};
pub use surface::{BackendPreference, GpuError, GpuRenderReport, GpuRenderer};
