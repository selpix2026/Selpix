"""Bounded XY SVG preview. Never represents unsupported geometry as complete."""
from pathlib import Path
import math
from ezdxf.path import make_path


def write_preview(path, entities, should_stop=lambda: False, limit=20000):
    paths = []
    points = []
    counts = dict(drawn=0, omitted=0, truncated=False, projection='XY')
    segments = 0
    for entity in entities:
        if should_stop(): break
        if counts['drawn'] >= limit or segments >= 200000:
            counts['omitted'] += 1
            counts['truncated'] = True
            continue
        if entity.dxftype() not in {'LINE', 'ARC', 'CIRCLE', 'ELLIPSE', 'SPLINE', 'LWPOLYLINE', 'POLYLINE'}:
            counts['omitted'] += 1
            continue
        try:
            vertices = []
            for v in make_path(entity).flattening(distance=0.05, segments=4):
                if len(vertices) >= 4096:
                    vertices = []
                    break
                if not math.isfinite(v.x) or not math.isfinite(v.y):
                    vertices = []
                    break
                vertices.append((v.x, -v.y))
            if len(vertices) < 2:
                counts['omitted'] += 1
                continue
            paths.append(vertices)
            points.extend(vertices)
            counts['drawn'] += 1
            segments += len(vertices)
        except (ValueError, TypeError, AttributeError, ZeroDivisionError):
            counts['omitted'] += 1
    if points:
        lo_x, lo_y = min(p[0] for p in points), min(p[1] for p in points)
        width = max(max(p[0] for p in points) - lo_x, 1)
        height = max(max(p[1] for p in points) - lo_y, 1)
    else:
        lo_x = lo_y = 0
        width = height = 100
    margin = max(width, height) * 0.02
    with Path(path).open('w', encoding='utf-8') as out:
        out.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{lo_x-margin} {lo_y-margin} {width+2*margin} {height+2*margin}">')
        out.write('<g fill="none" stroke="#264b73" stroke-width="1">')
        for vertices in paths:
            data = ' '.join(f'{x:.12g},{y:.12g}' for x, y in vertices)
            out.write(f'<polyline points="{data}" vector-effect="non-scaling-stroke"/>')
        out.write('</g></svg>')
    return counts
