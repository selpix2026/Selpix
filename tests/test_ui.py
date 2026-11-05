import os
os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
import time
import ezdxf
from PySide6.QtWidgets import QApplication
from cadcleaner.ui import MainWindow


def test_desktop_analyze_preview_approve_and_reopen(tmp_path):
    app = QApplication.instance() or QApplication([])
    doc = ezdxf.new(); m = doc.modelspace()
    m.add_line((0, 0), (1, 0)); m.add_line((1, 0), (0, 0))
    doc.saveas(tmp_path / 'fixture.dxf')
    w = MainWindow(jobs_root=tmp_path / 'jobs'); w.show()
    try:
        w.source.setText(str(tmp_path / 'fixture.dxf'))
        assert w.mode.currentData() == 'visible'
        w.begin()
        end = time.monotonic() + 30
        while time.monotonic() < end:
            app.processEvents()
            if w.job and w.controller.poll()['state'] in ('ready', 'error'):
                w.refresh(); break
            time.sleep(0.02)
        assert w.controller.poll()['state'] == 'ready'
        assert w.save_button.isEnabled()
        assert w.before.renderer().isValid()
        assert w.after.renderer().isValid()
        assert w.changes.rowCount() == 1
        assert 'duplicates_removed' in w.report.toPlainText()
        job = w.job
        from cadcleaner.jobs import approve
        approve(job, tmp_path / 'approved')
        assert len(ezdxf.readfile(tmp_path / 'approved/cleaned.dxf').modelspace()) == 1
        w.open_job(job)
        assert w.save_button.isEnabled()
    finally:
        w.close(); app.processEvents()


def test_stop_button_controls_worker_after_opening_saved_job(tmp_path):
    from cadcleaner.jobs import create_job
    app = QApplication.instance() or QApplication([])
    doc = ezdxf.new(); doc.modelspace().add_line((0, 0), (2, 0))
    source = tmp_path / 'resume.dxf'; doc.saveas(source)
    job = create_job(source, tmp_path / 'jobs')
    w = MainWindow(jobs_root=tmp_path / 'jobs')
    try:
        w.open_job(job)
        w.restart(); w.refresh()
        w.stop_button.click()
        end = time.monotonic() + 10
        while w.controller.running and time.monotonic() < end:
            app.processEvents(); w.controller.poll(); time.sleep(0.02)
        assert not w.controller.running
        assert w.controller.poll()['state'] == 'stopped'
    finally:
        w.close(); app.processEvents()


def test_switching_to_unfinished_job_clears_previous_results(tmp_path):
    from cadcleaner.jobs import create_job
    from cadcleaner.engine import run_job
    app = QApplication.instance() or QApplication([])
    doc = ezdxf.new(); doc.modelspace().add_circle((0, 0), 3)
    source = tmp_path / 'drawing.dxf'; doc.saveas(source)
    a = create_job(source, tmp_path / 'jobs'); run_job(a)
    b = create_job(source, tmp_path / 'jobs')
    w = MainWindow(jobs_root=tmp_path / 'jobs')
    try:
        w.open_job(a)
        assert w.after.renderer().isValid()
        assert w.report.toPlainText()
        w.open_job(b)
        assert not w.after.renderer().isValid()
        assert not w.before.renderer().isValid()
        assert not w.report.toPlainText()
        assert w.changes.rowCount() == 0
    finally:
        w.close(); app.processEvents()
