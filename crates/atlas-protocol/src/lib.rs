mod geometry;
mod patch;
mod scene;
mod timeline;

pub use geometry::*;
pub use patch::*;
pub use scene::*;
pub use timeline::*;

use thiserror::Error;

pub const PROTOCOL_VERSION: u16 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ProtocolError {
    #[error("unsupported protocol version {0}")]
    UnsupportedVersion(u16),
    #[error("duplicate id {0}")]
    DuplicateId(String),
    #[error("invalid bounds for {0}")]
    InvalidBounds(String),
    #[error("object {0} has no representation")]
    MissingRepresentation(String),
    #[error("duplicate or empty representation id {0}")]
    DuplicateRepresentationId(String),
    #[error("invalid LOD range for {0}")]
    InvalidLod(String),
    #[error("invalid primitive for {0}")]
    InvalidPrimitive(String),
    #[error("invalid color for {0}")]
    InvalidColor(String),
    #[error("invalid stroke for {0}")]
    InvalidStroke(String),
    #[error("unknown object {0}")]
    UnknownObject(String),
    #[error("unknown path {0}")]
    UnknownPath(String),
    #[error("invalid path {0}")]
    InvalidPath(String),
    #[error("scene mismatch: expected {expected}, received {actual}")]
    SceneMismatch { expected: String, actual: String },
    #[error("revision mismatch: expected {expected}, received {actual}")]
    RevisionMismatch { expected: u64, actual: u64 },
    #[error("patch revision {next} must be greater than base revision {base}")]
    NonIncreasingRevision { base: u64, next: u64 },
    #[error("patch contains conflicting operations for {0}")]
    ConflictingPatchOperation(String),
    #[error("transition duration must be greater than zero")]
    InvalidTransition,
    #[error("timeline cue {0} extends beyond the timeline")]
    CueOutsideTimeline(String),
    #[error("timeline keyframe {0} extends beyond the timeline")]
    KeyframeOutsideTimeline(String),
    #[error("unsupported timeline version {0}")]
    UnsupportedTimelineVersion(u16),
    #[error("timeline cue {0} has an invalid camera")]
    InvalidCamera(String),
    #[error("timeline cue {0} has an invalid effect")]
    InvalidEffect(String),
    #[error("invalid timeline: {0}")]
    InvalidTimeline(String),
    #[error("invalid visibility filter")]
    InvalidVisibility,
}
