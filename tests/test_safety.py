import json
import ezdxf
import pytest
from cadcleaner.jobs import create_job, read_status
from cadcleaner.engine import run_job


def test_visible_rejects_active_paper_viewport_and_all_preserves_layout(tmp_path):
    doc = ezdxf.new(); doc.header['$TILEMODE'] = 0
    doc.modelspace().add_line((0, 0), (1, 0))
    doc.layout().add_line((5, 5), (9, 9))
    source = tmp_path / 'layout.dxf'; doc.saveas(source)
    visible = create_job(source, tmp_path / 'jobs')
    with pytest.raises(ValueError, match='뷰포트'):
        run_job(visible)
    assert read_status(visible)['state'] == 'error'
    all_job = create_job(source, tmp_path / 'jobs', mode='all')
    run_job(all_job)
    out = ezdxf.readfile(all_job / 'staging/cleaned.dxf')
    assert len(out.layout()) == 1


def test_curves_intersections_parallel_lines_and_crossing_midpoints_unchanged(tmp_path):
    doc = ezdxf.new(); m = doc.modelspace()
    m.add_line((0, 0), (10, 0))
    m.add_line((5, -5), (5, 5))
    m.add_line((0, 0.001), (10, 0.001))
    m.add_line((5, 0), (7, 2))
    m.add_spline([(0, 0), (2, 5), (4, 0)])
    m.add_lwpolyline([(0, 0, 1), (4, 0, 0)], format='xyb')
    source = tmp_path / 'curves.dxf'; doc.saveas(source)
    job = create_job(source, tmp_path / 'jobs'); run_job(job)
    out = ezdxf.readfile(job / 'staging/cleaned.dxf')
    assert len(out.modelspace()) == 6
    assert list(out.modelspace().query('LWPOLYLINE'))[0].get_points('xyb')[0][2] == 1
    assert list(out.modelspace().query('SPLINE'))[0].dxf.degree == 3
    assert json.loads((job / 'staging/report.json').read_text())['duplicates_removed'] == 0


def test_backup_tampering_fails_before_export(tmp_path):
    doc = ezdxf.new(); source = tmp_path / 'empty.dxf'; doc.saveas(source)
    job = create_job(source, tmp_path / 'jobs')
    (job / 'original.dxf').write_text('tampered')
    with pytest.raises(ValueError, match='백업'):
        run_job(job)
    assert read_status(job)['state'] == 'error'
    assert not (job / 'staging/cleaned.dxf').exists()
