use serde::{Deserialize, Serialize};

use crate::{Rect, Vec2};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Viewport {
    pub css_width: f64,
    pub css_height: f64,
    pub device_pixel_ratio: f64,
}

impl Viewport {
    #[must_use]
    pub fn new(css_width: f64, css_height: f64, device_pixel_ratio: f64) -> Self {
        Self {
            css_width: css_width.max(1.0),
            css_height: css_height.max(1.0),
            device_pixel_ratio: device_pixel_ratio.clamp(0.5, 4.0),
        }
    }

    #[must_use]
    pub fn physical_width(self) -> u32 {
        (self.css_width * self.device_pixel_ratio)
            .round()
            .clamp(1.0, u32::MAX as f64) as u32
    }

    #[must_use]
    pub fn physical_height(self) -> u32 {
        (self.css_height * self.device_pixel_ratio)
            .round()
            .clamp(1.0, u32::MAX as f64) as u32
    }
}

impl Default for Viewport {
    fn default() -> Self {
        Self::new(1.0, 1.0, 1.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CameraLimits {
    pub min_zoom: f64,
    pub max_zoom: f64,
}

impl Default for CameraLimits {
    fn default() -> Self {
        Self {
            min_zoom: 0.05,
            max_zoom: 64.0,
        }
    }
}

/// A double-precision CPU camera. `zoom` is CSS pixels per world unit.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Camera {
    center: Vec2,
    zoom: f64,
    viewport: Viewport,
    limits: CameraLimits,
}

impl Camera {
    #[must_use]
    pub fn new(center: Vec2, zoom: f64, viewport: Viewport, limits: CameraLimits) -> Self {
        let mut camera = Self {
            center,
            zoom,
            viewport,
            limits,
        };
        camera.set_zoom(zoom);
        camera
    }

    #[must_use]
    pub fn center(self) -> Vec2 {
        self.center
    }

    pub fn set_center(&mut self, center: Vec2) {
        self.center = center;
    }

    #[must_use]
    pub fn zoom(self) -> f64 {
        self.zoom
    }

    pub fn set_zoom(&mut self, zoom: f64) {
        self.zoom = zoom.clamp(self.limits.min_zoom, self.limits.max_zoom);
    }

    #[must_use]
    pub fn viewport(self) -> Viewport {
        self.viewport
    }

    pub fn set_viewport(&mut self, viewport: Viewport) {
        self.viewport = viewport;
    }

    #[must_use]
    pub fn visible_world_rect(self) -> Rect {
        let width = self.viewport.css_width / self.zoom;
        let height = self.viewport.css_height / self.zoom;
        Rect::new(
            self.center.x - width / 2.0,
            self.center.y - height / 2.0,
            width,
            height,
        )
    }

    #[must_use]
    pub fn world_to_screen(self, world: Vec2) -> Vec2 {
        Vec2::new(
            (world.x - self.center.x) * self.zoom + self.viewport.css_width / 2.0,
            (world.y - self.center.y) * self.zoom + self.viewport.css_height / 2.0,
        )
    }

    #[must_use]
    pub fn screen_to_world(self, screen: Vec2) -> Vec2 {
        Vec2::new(
            (screen.x - self.viewport.css_width / 2.0) / self.zoom + self.center.x,
            (screen.y - self.viewport.css_height / 2.0) / self.zoom + self.center.y,
        )
    }

    pub fn pan_screen(&mut self, delta: Vec2) {
        self.center.x -= delta.x / self.zoom;
        self.center.y -= delta.y / self.zoom;
    }

    pub fn zoom_at(&mut self, screen_anchor: Vec2, factor: f64) {
        let world_anchor = self.screen_to_world(screen_anchor);
        self.set_zoom(self.zoom * factor);
        let world_after = self.screen_to_world(screen_anchor);
        self.center = self.center + (world_anchor - world_after);
    }

    pub fn fit_rect(&mut self, bounds: Rect, padding_px: f64) {
        let available_width = (self.viewport.css_width - padding_px * 2.0).max(1.0);
        let available_height = (self.viewport.css_height - padding_px * 2.0).max(1.0);
        let width_zoom = available_width / bounds.width.max(f64::EPSILON);
        let height_zoom = available_height / bounds.height.max(f64::EPSILON);
        self.center = bounds.center();
        self.set_zoom(width_zoom.min(height_zoom));
    }
}

impl Default for Camera {
    fn default() -> Self {
        Self::new(
            Vec2::ZERO,
            1.0,
            Viewport::default(),
            CameraLimits::default(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn camera() -> Camera {
        Camera::new(
            Vec2::new(500.0, 250.0),
            2.0,
            Viewport::new(1000.0, 500.0, 2.0),
            CameraLimits::default(),
        )
    }

    #[test]
    fn world_screen_round_trip_is_stable() {
        let camera = camera();
        let world = Vec2::new(781.5, -12.25);
        let round_trip = camera.screen_to_world(camera.world_to_screen(world));
        assert!((round_trip.x - world.x).abs() < 1e-9);
        assert!((round_trip.y - world.y).abs() < 1e-9);
    }

    #[test]
    fn anchored_zoom_keeps_world_point_fixed() {
        let mut camera = camera();
        let anchor = Vec2::new(120.0, 90.0);
        let before = camera.screen_to_world(anchor);
        camera.zoom_at(anchor, 1.8);
        let after = camera.screen_to_world(anchor);
        assert!((before.x - after.x).abs() < 1e-9);
        assert!((before.y - after.y).abs() < 1e-9);
    }

    #[test]
    fn fit_rect_accounts_for_padding() {
        let mut camera = camera();
        camera.fit_rect(Rect::new(0.0, 0.0, 400.0, 200.0), 50.0);
        assert_eq!(camera.center(), Vec2::new(200.0, 100.0));
        assert!((camera.zoom() - 2.0).abs() < 1e-9);
    }
}
