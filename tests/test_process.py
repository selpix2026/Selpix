import time
import ezdxf
import pytest
from cadcleaner.jobs import create_job, read_status
from cadcleaner.controller import Controller


def wait_for(controller, predicate, timeout=30):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        status = controller.poll()
        if predicate(status): return status
        time.sleep(0.02)
    raise AssertionError(controller.poll())


def test_real_worker_pause_stop_reopen_and_resume(tmp_path):
    doc = ezdxf.new()
    m = doc.modelspace()
    for i in range(12000):
        m.add_line((i, 0), (i, 1))
        m.add_line((i, 1), (i, 0))
    source = tmp_path / 'large.dxf'; doc.saveas(source)
    job = create_job(source, tmp_path / 'jobs')
    c = Controller(stop_grace=0.1)
    try:
        c.start(job)
        wait_for(c, lambda s: s['state'] == 'analyzing' and s['processed'] > 0)
        c.pause()
        frozen = c.poll()['processed']
        assert c.poll()['state'] == 'paused'
        time.sleep(0.2)
        assert c.poll()['processed'] == frozen
        c.resume()
        wait_for(c, lambda s: s['processed'] > frozen)
        c.stop()
        stopped = wait_for(c, lambda s: s['state'] == 'stopped' and not c.running)
        assert stopped['processed'] > 0
    finally:
        c.close()
    reopened = Controller()
    try:
        reopened.start(job)
        status = wait_for(reopened, lambda s: s['state'] in ('ready', 'error'), 60)
        assert status['state'] == 'ready', status
        output = ezdxf.readfile(job / 'staging/cleaned.dxf')
        assert len(output.modelspace()) == 12000
        assert status['summary']['duplicates_removed'] == 12000
    finally:
        reopened.close()


def test_bad_input_reports_error_and_controller_remains_usable(tmp_path):
    source = tmp_path / 'bad.dxf'; source.write_text('not DXF')
    job = create_job(source, tmp_path / 'jobs')
    c = Controller()
    try:
        c.start(job)
        state = wait_for(c, lambda s: s['state'] == 'error')
        assert state['error']
    finally:
        c.close()
