import { describe, expect, it } from 'vitest';
import { roundedOrthogonalRoute, routeArrowHead, routeArrowHeads, routeShaft } from './routeGeometry';

describe('screen-space relationship route geometry', () => {
  it('samples bounded quadratic corners while preserving protocol endpoints', () => {
    const canonical = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }];
    const rounded = roundedOrthogonalRoute(canonical, 6, 4);

    expect(rounded[0]).toEqual(canonical[0]);
    expect(rounded.at(-1)).toEqual(canonical.at(-1));
    expect(rounded).toContainEqual({ x: 14, y: 0 });
    expect(rounded).toContainEqual({ x: 20, y: 6 });
    expect(rounded).not.toContainEqual({ x: 20, y: 0 });
    expect(canonical).toEqual([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }]);
  });

  it('leaves smooth non-orthogonal sampled routes unchanged', () => {
    const sampledCurve = [{ x: 0, y: 0 }, { x: 5, y: 2 }, { x: 10, y: 6 }];
    expect(roundedOrthogonalRoute(sampledCurve)).toEqual(sampledCurve);
  });

  it('stops the shaft at the target arrow base while keeping its tip at the endpoint', () => {
    const route = [{ x: 0, y: 0 }, { x: 20, y: 0 }];
    const target = routeArrowHead(route, 8)!;
    const shaft = routeShaft(route, undefined, target);

    expect(target.tip).toEqual({ x: 20, y: 0 });
    expect(target.base).toEqual({ x: 12, y: 0 });
    expect(shaft.at(-1)).toEqual(target.base);
  });

  it('trims both shaft ends only for an explicitly bidirectional route', () => {
    const route = [{ x: 0, y: 0 }, { x: 30, y: 0 }];
    const target = routeArrowHead(route)!;
    const source = routeArrowHead([...route].reverse())!;
    const shaft = routeShaft(route, source, target);

    expect(source.tip).toEqual(route[0]);
    expect(shaft[0]).toEqual(source.base);
    expect(shaft.at(-1)).toEqual(target.base);
  });

  it('adds a source marker only for an explicitly bidirectional relationship', () => {
    const route = [{ x: 0, y: 0 }, { x: 30, y: 0 }];

    expect(routeArrowHeads(route, 'none')).toEqual({ source: undefined, target: undefined });
    expect(routeArrowHeads(route, 'end').source).toBeUndefined();
    expect(routeArrowHeads(route, 'end').target?.tip).toEqual(route[1]);
    expect(routeArrowHeads(route, 'both').source?.tip).toEqual(route[0]);
    expect(routeArrowHeads(route, 'both').target?.tip).toEqual(route[1]);
  });
});
