"""Desktop controller; expensive file copies use a background thread."""
import json
from pathlib import Path
import time

from PySide6.QtCore import QThread, Signal, QTimer, Qt, QStandardPaths
from PySide6.QtSvgWidgets import QSvgWidget
from PySide6.QtWidgets import (QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QLabel, QLineEdit, QPushButton, QFileDialog, QComboBox, QCheckBox, QProgressBar,
    QSplitter, QTabWidget, QPlainTextEdit, QTableWidget, QTableWidgetItem, QMessageBox)
from .controller import Controller
from .jobs import create_job, read_status, approve, connect


class FileTask(QThread):
    completed = Signal(object)
    failed = Signal(str)

    def __init__(self, function):
        super().__init__()
        self.function = function

    def run(self):
        try:
            self.completed.emit(self.function())
        except Exception as exc:
            self.failed.emit(str(exc))


class MainWindow(QMainWindow):
    def __init__(self, jobs_root=None):
        super().__init__()
        self.setWindowTitle('CAD Light Cleaner 0.1 — DXF 안전 정리')
        self.resize(1200, 820)
        self.jobs_root = Path(jobs_root) if jobs_root else Path(QStandardPaths.writableLocation(QStandardPaths.AppLocalDataLocation)) / 'jobs'
        self.controller = Controller()
        self.job = None
        self.file_task = None
        self.loaded_preview = None
        root = QWidget(); self.setCentralWidget(root)
        layout = QVBoxLayout(root)
        title = QLabel('CAD Light Cleaner  |  원본 보존 · 외부 계산 · 체크포인트 재개')
        title.setStyleSheet('font-size:20px;font-weight:600;padding:12px;color:#183c59')
        layout.addWidget(title)
        row = QHBoxLayout(); layout.addLayout(row)
        self.source = QLineEdit(); self.source.setPlaceholderText('DWG는 먼저 DXF로 변환하세요. DXF 파일 선택')
        row.addWidget(self.source)
        self.browse = QPushButton('DXF 열기'); self.browse.clicked.connect(self.choose_file); row.addWidget(self.browse)
        self.load_button = QPushButton('이전 작업 열기'); self.load_button.clicked.connect(self.choose_job); row.addWidget(self.load_button)
        row = QHBoxLayout(); layout.addLayout(row)
        self.mode = QComboBox()
        self.mode.addItem('현재 표시 상태만 — 지원 범위 내, 불확실 객체 제외 (기본)', 'visible')
        self.mode.addItem('전체 도면 — 숨김 객체 포함', 'all')
        row.addWidget(self.mode)
        self.zero = QCheckBox('정확한 0 길이 LINE 제거'); self.zero.setChecked(True); row.addWidget(self.zero)
        warning = QLabel('현재 표시는 모델 공간의 레이어 OFF/Freeze·객체 숨김만 지원합니다. 블록/XREF·HATCH·미확인 객체는 기본 모드에서 제외됩니다.\n'
                         '뷰포트·클리핑의 CAD 표시 재현은 보장하지 않습니다. SVG는 XY 일부 형상 미리보기이며, 저장 전 제외 내역을 확인하세요.')
        warning.setWordWrap(True); warning.setStyleSheet('background:#fff1d4;padding:10px;color:#624600'); layout.addWidget(warning)
        row = QHBoxLayout(); layout.addLayout(row)
        self.run_button = QPushButton('분석 / 결과 준비'); self.run_button.clicked.connect(self.begin); row.addWidget(self.run_button)
        self.pause_button = QPushButton('일시정지'); self.pause_button.clicked.connect(self.toggle_pause); row.addWidget(self.pause_button)
        self.stop_button = QPushButton('안전 중단'); self.stop_button.clicked.connect(lambda: self.controller.stop()); row.addWidget(self.stop_button)
        self.resume_button = QPushButton('체크포인트에서 계속'); self.resume_button.clicked.connect(self.restart); row.addWidget(self.resume_button)
        self.save_button = QPushButton('결과 승인 · 새 폴더에 저장'); self.save_button.clicked.connect(self.save_result); row.addWidget(self.save_button)
        self.progress = QProgressBar(); layout.addWidget(self.progress)
        self.status = QLabel('DXF를 선택하세요. 원본 파일은 덮어쓰지 않습니다.'); layout.addWidget(self.status)
        self.tabs = QTabWidget(); layout.addWidget(self.tabs, 1)
        previews = QSplitter(Qt.Horizontal)
        self.before, self.after = QSvgWidget(), QSvgWidget()
        for label, widget in [('전 — 원본 모델 공간, 숨김 포함 / 지원 형상만', self.before), ('후 — 정리 결과 / 지원 형상만', self.after)]:
            box = QWidget(); col = QVBoxLayout(box); col.addWidget(QLabel(label)); col.addWidget(widget, 1); previews.addWidget(box)
            widget.setMinimumSize(200, 200)
        self.tabs.addTab(previews, '전 / 후 미리보기')
        self.changes = QTableWidget(0, 3); self.changes.setHorizontalHeaderLabels(['원본 handle', '처리', '사유'])
        self.changes.horizontalHeader().setStretchLastSection(True)
        self.tabs.addTab(self.changes, '변경된 객체 (최대 500개)')
        self.report = QPlainTextEdit(); self.report.setReadOnly(True); self.tabs.addTab(self.report, '수치 · 제한 사항 보고서')
        self.timer = QTimer(self); self.timer.timeout.connect(self.refresh); self.timer.start(100)
        self.refresh()

    def busy(self):
        return self.file_task is not None and self.file_task.isRunning()

    def task(self, function, done):
        if self.busy(): return
        self.file_task = FileTask(function)
        self.file_task.completed.connect(done)
        self.file_task.failed.connect(self.show_error)
        self.file_task.start()
        self.status.setText('파일을 안전하게 복사/검증하는 중…')

    def show_error(self, error):
        self.status.setText(error)
        QMessageBox.warning(self, '작업 안내', error)

    def choose_file(self):
        name, _ = QFileDialog.getOpenFileName(self, 'DXF 선택', '', 'DXF (*.dxf *.DXF)')
        if name: self.source.setText(name)

    def choose_job(self):
        folder = QFileDialog.getExistingDirectory(self, 'job.json이 있는 작업 폴더', str(self.jobs_root))
        if folder:
            try: self.open_job(Path(folder))
            except Exception as exc: self.show_error(str(exc))

    def open_job(self, job):
        if self.controller.running:
            if self.controller.poll()['state'] == 'ready':
                self.controller.close()
            else:
                raise ValueError('실행 중인 작업을 먼저 중단하세요.')
        config = json.loads((Path(job) / 'job.json').read_text(encoding='utf-8'))
        read_status(job)  # Validate checkpoint before switching.
        self.controller = Controller()
        self.controller.job = Path(job)
        self.controller._observed_exit = True
        self.job = Path(job)
        self.source.setText(config['source'])
        self.loaded_preview = None
        self.before.load(b''); self.after.load(b''); self.report.clear(); self.changes.setRowCount(0)
        self.refresh()

    def begin(self):
        if self.controller.running or self.busy(): return
        source, mode, zero = self.source.text(), self.mode.currentData(), self.zero.isChecked()
        def done(job):
            self.job = job
            self.loaded_preview = None
            self.before.load(b''); self.after.load(b''); self.report.clear(); self.changes.setRowCount(0)
            self.controller.start(job)
        self.task(lambda: create_job(source, self.jobs_root, mode, zero), done)

    def restart(self):
        if self.job and not self.controller.running:
            try: self.controller.start(self.job)
            except Exception as exc: self.show_error(str(exc))

    def toggle_pause(self):
        if self.controller.paused: self.controller.resume()
        else: self.controller.pause()
        self.refresh()

    def save_result(self):
        if not self.job: return
        parent = QFileDialog.getExistingDirectory(self, '새 결과 폴더를 만들 상위 폴더 선택')
        if not parent: return
        job = self.job
        destination = Path(parent) / f'CAD-Cleaned-{time.strftime("%Y%m%d-%H%M%S")}-{job.name[:6]}'
        self.task(lambda: approve(job, destination), lambda path: QMessageBox.information(self, '저장 완료', f'{path}\n원본 백업 및 체크포인트: {job}'))

    def refresh(self):
        try: state = self.controller.poll()
        except Exception as exc:
            self.status.setText(f'체크포인트 읽기 실패: {exc}'); return
        name = state['state']
        running, busy = self.controller.running, self.busy()
        for widget in (self.run_button, self.browse, self.load_button, self.mode, self.zero, self.source):
            widget.setEnabled(not running and not busy)
        self.pause_button.setEnabled(running and name != 'stopping')
        self.pause_button.setText('재개' if self.controller.paused else '일시정지')
        self.stop_button.setEnabled(running and name != 'stopping')
        self.resume_button.setEnabled(self.job is not None and not running and not busy and name in ('stopped', 'error', 'new', 'reading', 'analyzing', 'exporting'))
        self.save_button.setEnabled(name == 'ready' and not busy)
        total, done = state.get('total', 0), state.get('processed', 0)
        self.progress.setRange(0, total or (0 if running else 1)); self.progress.setValue(done)
        labels = dict(idle='대기', new='준비', reading='DXF 읽기', analyzing='분석 중', exporting='출력 검증 / 미리보기 생성', ready='검증 완료 — 결과를 확인하고 승인하세요',
                      paused='일시정지', stopping='안전 중단 중', stopped='중단됨 — 완료 체크포인트 보존', error='오류')
        if not busy:
            self.status.setText(f'{labels.get(name, name)} | {done:,}/{total:,} | CPU {state.get("cpu_percent", 0)}% · {state.get("memory_mb", 0)} MB\n'
                                f'{state.get("error") or ""}  작업 폴더: {self.job or "—"}')
        if name == 'ready' and self.loaded_preview != self.job:
            self.loaded_preview = self.job
            for widget, file in [(self.before, 'preview-before.svg'), (self.after, 'preview-after.svg')]:
                widget.load(str(self.job / 'staging' / file))
            self.report.setPlainText(json.dumps(state['summary'], ensure_ascii=False, indent=2))
            with connect(self.job) as db:
                rows = db.execute("SELECT handle,action,reason FROM decisions WHERE action != 'keep' LIMIT 500").fetchall()
            self.changes.setRowCount(len(rows))
            for r, row in enumerate(rows):
                for c, value in enumerate(row): self.changes.setItem(r, c, QTableWidgetItem(value))

    def closeEvent(self, event):
        if self.busy():
            self.status.setText('파일 복사/저장이 완료된 후 창을 닫을 수 있습니다.'); event.ignore(); return
        self.controller.close()
        event.accept()


def main():
    app = QApplication.instance() or QApplication([])
    app.setApplicationName('CADLightCleaner')
    window = MainWindow(); window.show()
    return app.exec()
