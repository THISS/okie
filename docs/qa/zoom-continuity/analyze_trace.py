"""Summarize recorded inputs and suspicious frame pairs; never grants a QA pass."""
import json
import math
import sys


def summarize(path):
    trace = json.load(open(path))
    inputs = [s for s in trace['samples'] if s['kind'] == 'input']
    frames = [s for s in trace['samples'] if s['kind'] == 'frame']
    directions = {1 if s['deltaY'] > 0 else -1 for s in inputs if s['deltaY']}
    direction = next(iter(directions)) if len(directions) == 1 else None
    contrary = []
    split_pairs = []
    for index, (before, after) in enumerate(zip(frames, frames[1:])):
        change = after['camera']['zoom'] - before['camera']['zoom']
        if direction and change * direction > 1e-7:
            contrary.append([before['sequence'], after['sequence']])
        old_projection = (before.get('projectionId'), before.get('projectionProgress'))
        new_projection = (after.get('projectionId'), after.get('projectionProgress'))
        if before['camera'] == after['camera'] or old_projection != new_projection:
            continue
        for following in frames[index + 2:]:
            if following['camera'] != after['camera']:
                break
            later_projection = (following.get('projectionId'), following.get('projectionProgress'))
            if later_projection != new_projection:
                split_pairs.append({
                    'newCameraOldProjectionSequence': after['sequence'],
                    'sameCameraNewProjectionSequence': following['sequence'],
                    'delayMs': round(following['timeMs'] - after['timeMs'], 3),
                    'progressBefore': after.get('projectionProgress'),
                    'progressAfter': following.get('projectionProgress'),
                })
                break
    gaps = [b['timeMs'] - a['timeMs'] for a, b in zip(inputs, inputs[1:])]
    largest_step = max(zip(frames, frames[1:]),
                       key=lambda pair: abs(math.log(pair[1]['camera']['zoom'] / pair[0]['camera']['zoom'])),
                       default=None)
    residency_changes = []
    previous_residency = None
    for frame in frames:
        counts = frame.get('residentCountsByDetail')
        if counts is None:
            continue
        residency = (frame.get('sceneRootId'), counts)
        if residency != previous_residency:
            residency_changes.append({
                'sequence': frame['sequence'], 'timeMs': frame['timeMs'],
                'camera': frame['camera'], 'sceneRootId': frame.get('sceneRootId'),
                'residentCountsByDetail': counts,
            })
            previous_residency = residency
    return {
        'path': path,
        'inputs': len(inputs), 'frames': len(frames),
        'singleDirection': 'inward' if direction == -1 else 'outward' if direction == 1 else None,
        'inputGapMs': {'min': min(gaps), 'max': max(gaps)} if gaps else None,
        'contraryZoomFramePairs': contrary,
        'cameraBeforeProjectionCandidates': split_pairs,
        'largestZoomStep': {
            'fromSequence': largest_step[0]['sequence'],
            'toSequence': largest_step[1]['sequence'],
            'changePercent': 100 * (largest_step[1]['camera']['zoom'] / largest_step[0]['camera']['zoom'] - 1),
            'frameTimeGapMs': largest_step[1]['timeMs'] - largest_step[0]['timeMs'],
        } if largest_step else None,
        'truncated': trace.get('truncated', False),
        'residencyChanges': residency_changes,
        'limitation': 'Candidate detection only; video, anchoring, geometry and minimap review remain required.',
    }


if __name__ == '__main__':
    for filename in sys.argv[1:]:
        print(json.dumps(summarize(filename), indent=2))
