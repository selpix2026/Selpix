import hashlib
import json
import sqlite3
from pathlib import Path

import ezdxf
import pytest

from cadcleaner.jobs import create_job, read_status, approve
from cadcleaner.engine import run_job


def drawing(tmp_path):
    doc = ezdxf.new('R2013', units=4)
    return doc, doc.modelspace(), tmp_path / 'source.dxf'


def result(job):
    return ezdxf.readfile(job / 'staging' / 'cleaned.dxf')


def test_exact_duplicates_preserve_layers_styles_curves_and_source(tmp_path):
    doc, m, source = drawing(tmp_path)
    doc.layers.new('Other')
    m.add_line((0, 0), (10, 0))
    m.add_line((10, 0), (0, 0))
    m.add_line((0, 0), (10.000000001, 0))
    m.add_line((0, 0), (10, 0), dxfattribs={'layer': 'Other'})
    m.add_line((0, 0), (10, 0), dxfattribs={'color': 1})
    m.add_line((1, 1), (1, 1))
    m.add_circle((4, 4), 2)
    m.add_arc((3, 3), 1, 0, 90)
    m.add_lwpolyline([(0, 0, 1), (3, 0, 0)], format='xyb')
    doc.saveas(source)
    original = source.read_bytes()
    job = create_job(source, tmp_path / 'jobs', mode='visible', remove_zero=True)
    run_job(job)
    assert read_status(job)['state'] == 'ready'
    out = result(job)
    assert len(out.modelspace().query('LINE')) == 4
    assert len(out.modelspace().query('CIRCLE ARC LWPOLYLINE')) == 3
    assert not out.audit().has_errors
    report = json.loads((job / 'staging/report.json').read_text())
    assert report['duplicates_removed'] == 1
    assert report['zero_removed'] == 1
    assert report['before_entities'] == 9
    assert report['after_entities'] == 7
    assert source.read_bytes() == original
    assert (job / 'original.dxf').read_bytes() == original
    target = approve(job, tmp_path / 'approved')
    assert (target / 'cleaned.dxf').exists()
    assert (target / 'preview-after.svg').exists()
    assert source.read_bytes() == original
    with pytest.raises(FileExistsError):
        approve(job, target)


@pytest.mark.parametrize('mode,expected', [('visible', 1), ('all', 5)])
def test_visibility_does_not_leak_hidden_or_unverified_blocks(tmp_path, mode, expected):
    doc, m, source = drawing(tmp_path)
    doc.layers.new('Off'); doc.layers.get('Off').off()
    doc.layers.new('Frozen'); doc.layers.get('Frozen').freeze()
    m.add_line((0, 0), (1, 0))
    m.add_line((0, 1), (1, 1), dxfattribs={'layer': 'Off'})
    m.add_line((0, 2), (1, 2), dxfattribs={'layer': 'Frozen'})
    m.add_line((0, 3), (1, 3), dxfattribs={'invisible': 1})
    b = doc.blocks.new('Block'); b.add_circle((0, 0), 1)
    m.add_blockref('Block', (10, 10))
    doc.saveas(source)
    job = create_job(source, tmp_path / 'jobs', mode=mode)
    run_job(job)
    assert len(result(job).modelspace()) == expected
    report = json.loads((job / 'staging/report.json').read_text())
    assert report['excluded_entities'] == (4 if mode == 'visible' else 0)
    assert report['limitations']


def test_dedup_does_not_remove_metadata_or_z_coordinates(tmp_path):
    doc, m, source = drawing(tmp_path)
    doc.appids.new('TEST')
    m.add_line((0, 0, 1), (1, 0, 1))
    m.add_line((0, 0, 0), (1, 0, 0))
    line = m.add_line((0, 0, 0), (1, 0, 0))
    line.set_xdata('TEST', [(1000, 'keep')])
    doc.saveas(source)
    job = create_job(source, tmp_path / 'jobs', mode='all')
    run_job(job)
    assert len(result(job).modelspace()) == 3


def test_original_can_change_after_snapshot_and_invalid_modes_rejected(tmp_path):
    doc, m, source = drawing(tmp_path)
    m.add_line((0, 0), (1, 0)); doc.saveas(source)
    job = create_job(source, tmp_path / 'jobs')
    source.write_text('changed by another application')
    run_job(job)
    assert len(result(job).modelspace()) == 1
    assert source.read_text() == 'changed by another application'
    with pytest.raises(ValueError):
        create_job(source, tmp_path / 'jobs', mode='bogus')
    with pytest.raises(ValueError):
        create_job(source.with_suffix('.dwg'), tmp_path / 'jobs')


def test_interrupted_checkpoint_resume_exactly_matches_one_shot(tmp_path):
    doc, m, source = drawing(tmp_path)
    for i in range(300):
        m.add_line((i, 0), (i, 1))
        m.add_line((i, 1), (i, 0))
    doc.saveas(source)
    job = create_job(source, tmp_path / 'jobs')
    def control():
        return read_status(job).get('processed', 0) >= 16
    run_job(job, should_stop=control)
    assert read_status(job)['state'] == 'stopped'
    assert 0 < read_status(job)['processed'] < 600
    run_job(job)
    assert len(result(job).modelspace()) == 300
    report = json.loads((job / 'staging/report.json').read_text())
    assert report['duplicates_removed'] == 300


def test_approval_requires_ready_and_rejects_tampered_staging(tmp_path):
    doc, m, source = drawing(tmp_path)
    m.add_line((0, 0), (1, 1)); doc.saveas(source)
    job = create_job(source, tmp_path / 'jobs')
    with pytest.raises(ValueError):
        approve(job, tmp_path / 'no')
    run_job(job)
    (job / 'staging/cleaned.dxf').write_text('bad')
    with pytest.raises(ValueError):
        approve(job, tmp_path / 'no')
    assert not (tmp_path / 'no').exists()


def _unfinished_batch(job, entered):
    from cadcleaner.jobs import connect
    from cadcleaner.engine import signature
    import ezdxf
    import time
    doc = ezdxf.readfile(Path(job) / 'original.dxf')
    entity = next(iter(doc.modelspace()))
    db = connect(job)
    db.execute('INSERT INTO seen VALUES (?, ?)', (signature(entity), entity.dxf.handle))
    db.execute('INSERT INTO decisions VALUES (?, ?, ?)', (entity.dxf.handle, 'keep', ''))
    entered.set()
    time.sleep(60)  # Parent terminates this process while transaction is open.


def test_process_kill_inside_batch_rolls_back_and_resumes_without_lost_geometry(tmp_path):
    import multiprocessing
    doc, m, source = drawing(tmp_path)
    m.add_line((0, 0), (1, 0)); m.add_line((1, 0), (0, 0)); doc.saveas(source)
    job = create_job(source, tmp_path / 'jobs')
    ctx = multiprocessing.get_context('spawn')
    entered = ctx.Event()
    p = ctx.Process(target=_unfinished_batch, args=(str(job), entered))
    p.start()
    try:
        assert entered.wait(timeout=10)
    finally:
        p.terminate(); p.join(timeout=5)
    assert not p.is_alive()
    with sqlite3.connect(job / 'checkpoint.sqlite') as db:
        assert db.execute('SELECT count(*) FROM decisions').fetchone()[0] == 0
        assert db.execute('SELECT count(*) FROM seen').fetchone()[0] == 0
    run_job(job)
    assert len(result(job).modelspace()) == 1
    assert read_status(job)['summary']['duplicates_removed'] == 1
