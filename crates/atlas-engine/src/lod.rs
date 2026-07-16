use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticLevel {
    Context,
    Container,
    Component,
    Code,
}

impl SemanticLevel {
    pub const ALL: [Self; 4] = [Self::Context, Self::Container, Self::Component, Self::Code];

    #[must_use]
    pub const fn index(self) -> usize {
        match self {
            Self::Context => 0,
            Self::Container => 1,
            Self::Component => 2,
            Self::Code => 3,
        }
    }

    #[must_use]
    pub fn from_index(index: usize) -> Self {
        Self::ALL[index.min(Self::ALL.len() - 1)]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LodThresholds {
    /// Zoom at which containers replace the context representation.
    pub containers: f64,
    /// Zoom at which components replace containers.
    pub components: f64,
    /// Zoom at which code anchors replace components.
    pub code: f64,
    /// Fraction of each threshold used as a dead band.
    pub hysteresis: f64,
    /// Duration of representation overlap after a level change.
    pub transition_ms: f64,
}

impl Default for LodThresholds {
    fn default() -> Self {
        Self {
            containers: 1.16,
            components: 3.35,
            code: 7.1,
            hysteresis: 0.08,
            transition_ms: 180.0,
        }
    }
}

impl LodThresholds {
    fn threshold_for(self, level: SemanticLevel) -> f64 {
        match level {
            SemanticLevel::Context => 0.0,
            SemanticLevel::Container => self.containers,
            SemanticLevel::Component => self.components,
            SemanticLevel::Code => self.code,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LodSample {
    pub current: SemanticLevel,
    pub previous: Option<SemanticLevel>,
    pub progress: f32,
}

impl LodSample {
    #[must_use]
    pub fn visible_levels(self) -> Vec<SemanticLevel> {
        let mut levels = vec![self.current];
        if self.progress < 1.0 {
            if let Some(previous) = self.previous {
                if previous != self.current {
                    levels.push(previous);
                }
            }
        }
        levels
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct LodController {
    thresholds: LodThresholds,
    current: SemanticLevel,
    previous: Option<SemanticLevel>,
    transition_started_ms: f64,
}

impl LodController {
    #[must_use]
    pub fn new(thresholds: LodThresholds) -> Self {
        Self {
            thresholds,
            current: SemanticLevel::Context,
            previous: None,
            transition_started_ms: 0.0,
        }
    }

    #[must_use]
    pub fn current(self) -> SemanticLevel {
        self.current
    }

    pub fn update(&mut self, zoom: f64, now_ms: f64) -> LodSample {
        let mut next = self.current;

        while next.index() + 1 < SemanticLevel::ALL.len() {
            let higher = SemanticLevel::from_index(next.index() + 1);
            let threshold = self.thresholds.threshold_for(higher);
            if zoom >= threshold * (1.0 + self.thresholds.hysteresis) {
                next = higher;
            } else {
                break;
            }
        }

        while next != SemanticLevel::Context {
            let threshold = self.thresholds.threshold_for(next);
            if zoom < threshold * (1.0 - self.thresholds.hysteresis) {
                next = SemanticLevel::from_index(next.index() - 1);
            } else {
                break;
            }
        }

        if next != self.current {
            self.previous = Some(self.current);
            self.current = next;
            self.transition_started_ms = now_ms;
        }

        let progress = if self.previous.is_none() || self.thresholds.transition_ms <= 0.0 {
            1.0
        } else {
            ((now_ms - self.transition_started_ms) / self.thresholds.transition_ms).clamp(0.0, 1.0)
        };
        if progress >= 1.0 {
            self.previous = None;
        }

        LodSample {
            current: self.current,
            previous: self.previous,
            progress: progress as f32,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hysteresis_prevents_threshold_flicker() {
        let mut lod = LodController::new(LodThresholds::default());
        assert_eq!(lod.update(1.0, 0.0).current, SemanticLevel::Context);
        assert_eq!(lod.update(1.26, 10.0).current, SemanticLevel::Container);
        assert_eq!(lod.update(1.12, 20.0).current, SemanticLevel::Container);
        assert_eq!(lod.update(1.05, 30.0).current, SemanticLevel::Context);
    }

    #[test]
    fn old_and_new_levels_overlap_during_transition() {
        let mut lod = LodController::new(LodThresholds::default());
        lod.update(1.3, 100.0);
        let sample = lod.update(1.3, 150.0);
        assert!(sample.visible_levels().contains(&SemanticLevel::Context));
        assert!(sample.visible_levels().contains(&SemanticLevel::Container));
        let settled = lod.update(1.3, 300.0);
        assert_eq!(settled.visible_levels(), vec![SemanticLevel::Container]);
    }
}
