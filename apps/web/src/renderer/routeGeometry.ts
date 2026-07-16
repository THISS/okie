export type RoutePoint = { x: number; y: number };

export const routeCornerRadiusPx = 6;
export const routeCornerSampleCount = 4;

function samePoint(left: RoutePoint, right: RoutePoint) {
  return Math.abs(left.x - right.x) <= 1e-9 && Math.abs(left.y - right.y) <= 1e-9;
}

/** Samples screen-space quadratic fillets without mutating the canonical protocol polyline. */
export function roundedOrthogonalRoute(
  points: readonly RoutePoint[],
  radiusPx = routeCornerRadiusPx,
  sampleCount = routeCornerSampleCount,
): RoutePoint[] {
  const route = points.filter((point, index) => index === 0 || !samePoint(point, points[index - 1]!));
  if (route.length < 3 || radiusPx <= 0 || sampleCount < 1) return route.map(point => ({ ...point }));
  const rounded: RoutePoint[] = [{ ...route[0]! }];
  for (let index = 1; index + 1 < route.length; index += 1) {
    const previous = route[index - 1]!;
    const corner = route[index]!;
    const next = route[index + 1]!;
    const incoming = { x: corner.x - previous.x, y: corner.y - previous.y };
    const outgoing = { x: next.x - corner.x, y: next.y - corner.y };
    const incomingLength = Math.hypot(incoming.x, incoming.y);
    const outgoingLength = Math.hypot(outgoing.x, outgoing.y);
    const dot = incoming.x * outgoing.x + incoming.y * outgoing.y;
    const orthogonal = incomingLength > 1e-9
      && outgoingLength > 1e-9
      && Math.abs(dot) <= incomingLength * outgoingLength * 1e-6;
    if (!orthogonal) {
      rounded.push({ ...corner });
      continue;
    }
    const offset = Math.min(radiusPx, incomingLength * .5, outgoingLength * .5);
    const entry = {
      x: corner.x - incoming.x / incomingLength * offset,
      y: corner.y - incoming.y / incomingLength * offset,
    };
    const exit = {
      x: corner.x + outgoing.x / outgoingLength * offset,
      y: corner.y + outgoing.y / outgoingLength * offset,
    };
    if (!samePoint(rounded.at(-1)!, entry)) rounded.push(entry);
    for (let sample = 1; sample <= sampleCount; sample += 1) {
      const amount = sample / sampleCount;
      const inverse = 1 - amount;
      rounded.push({
        x: inverse * inverse * entry.x + 2 * inverse * amount * corner.x + amount * amount * exit.x,
        y: inverse * inverse * entry.y + 2 * inverse * amount * corner.y + amount * amount * exit.y,
      });
    }
  }
  if (!samePoint(rounded.at(-1)!, route.at(-1)!)) rounded.push({ ...route.at(-1)! });
  return rounded;
}

export type RouteArrowHead = {
  tip: RoutePoint;
  base: RoutePoint;
  left: RoutePoint;
  right: RoutePoint;
};

export type RouteArrowMode = 'none' | 'end' | 'both';

export function routeArrowHead(points: readonly RoutePoint[], sizePx = 8): RouteArrowHead | undefined {
  if (points.length < 2) return undefined;
  const tip = points.at(-1)!;
  let startIndex = points.length - 2;
  while (startIndex > 0 && samePoint(points[startIndex]!, tip)) startIndex -= 1;
  const start = points[startIndex]!;
  const terminalLength = Math.hypot(tip.x - start.x, tip.y - start.y);
  if (terminalLength <= 1e-9) return undefined;
  const unit = { x: (tip.x - start.x) / terminalLength, y: (tip.y - start.y) / terminalLength };
  const depth = Math.min(Math.max(0, sizePx), terminalLength * .5);
  const base = { x: tip.x - unit.x * depth, y: tip.y - unit.y * depth };
  const normal = { x: -unit.y * depth * .55, y: unit.x * depth * .55 };
  return {
    tip: { ...tip },
    base,
    left: { x: base.x + normal.x, y: base.y + normal.y },
    right: { x: base.x - normal.x, y: base.y - normal.y },
  };
}

export function routeArrowHeads(points: readonly RoutePoint[], mode: RouteArrowMode = 'end') {
  return {
    target: mode === 'end' || mode === 'both' ? routeArrowHead(points) : undefined,
    source: mode === 'both' ? routeArrowHead([...points].reverse()) : undefined,
  };
}

export function routeShaft(
  points: readonly RoutePoint[],
  sourceArrow?: RouteArrowHead,
  targetArrow?: RouteArrowHead,
): RoutePoint[] {
  if (points.length < 2) return points.map(point => ({ ...point }));
  const shaft = points.map(point => ({ ...point }));
  if (sourceArrow) shaft[0] = { ...sourceArrow.base };
  if (targetArrow) shaft[shaft.length - 1] = { ...targetArrow.base };
  return shaft;
}
