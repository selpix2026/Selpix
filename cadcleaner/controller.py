"""Responsive process control; no CAD parsing on the caller/UI thread."""
import multiprocessing as mp
import os
from pathlib import Path
import time
import psutil

from .jobs import connect, read_status, set_status


def _worker(job, stop_event):
    # OS lock survives controller crashes until the worker itself exits.
    lock = (Path(job) / 'worker.lock').open('a+b')
    try:
        if os.name == 'nt':
            import msvcrt
            lock.seek(0); lock.write(b'0'); lock.flush(); lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        lock.close()
        raise SystemExit(73)
    try:
        from .engine import run_job
        run_job(job, stop_event.is_set)
    except Exception:
        import traceback
        (Path(job) / 'worker-error.log').write_text(traceback.format_exc(), encoding='utf-8')
        raise SystemExit(1)  # Durable diagnostics also cover import/startup failures.
    finally:
        lock.close()


class Controller:
    def __init__(self, stop_grace=2.0, memory_limit_mb=4096):
        self.context = mp.get_context('spawn')
        self.process = None
        self.job = None
        self.paused = False
        self.stop_deadline = None
        self.stop_grace = stop_grace
        self.memory_limit_mb = memory_limit_mb
        self.resource_stop = False
        self._observed_exit = False

    @property
    def running(self):
        return self.process is not None and self.process.is_alive()

    def start(self, job):
        if self.running:
            raise ValueError('현재 작업을 먼저 중단하세요.')
        if self.process is not None:
            self.process.join(timeout=0)
            self.process.close()
        self.job = Path(job)
        state = read_status(job)
        if state['state'] == 'ready':
            raise ValueError('이미 검증이 완료된 작업입니다. 결과를 저장하세요.')
        self.event = self.context.Event()
        self.process = self.context.Process(target=_worker, args=(str(job), self.event), daemon=True)
        self.paused = False
        self.stop_deadline = None
        self.resource_stop = False
        self._observed_exit = False
        self.process.start()
        self.resources = psutil.Process(self.process.pid)
        self.resources.cpu_percent()

    def pause(self):
        if self.running and not self.paused and self.stop_deadline is None:
            self.resources.suspend()
            self.paused = True

    def resume(self):
        if self.running and self.paused:
            self.resources.resume()
            self.paused = False

    def stop(self):
        if self.running and self.stop_deadline is None:
            self.resume()
            self.event.set()
            self.stop_deadline = time.monotonic() + self.stop_grace

    def poll(self):
        if self.job is None:
            return dict(state='idle', processed=0, total=0)
        status = read_status(self.job)
        if self.running:
            try:
                rss = self.resources.memory_info().rss / (1024 * 1024)
                status.update(memory_mb=round(rss, 1), cpu_percent=self.resources.cpu_percent())
                if rss > self.memory_limit_mb:
                    self.resource_stop = True
                    self.stop()
            except psutil.NoSuchProcess:
                pass
            if self.stop_deadline is not None and time.monotonic() >= self.stop_deadline:
                self.process.terminate()
                # poll does not wait on a busy worker. Next UI tick collects it.
        if not self.running and not self._observed_exit:
            self.process.join(timeout=0)
            if self.process.exitcode == 73:
                # Never change another worker's status.
                return dict(status, state='error', error='이 작업은 다른 프로세스에서 실행 중입니다.')
            if status['state'] not in ('ready', 'error', 'stopped'):
                with connect(self.job) as db:
                    done = db.execute('SELECT count(*) FROM decisions').fetchone()[0]
                    set_status(db, state='stopped' if self.stop_deadline is not None else 'error',
                               processed=done,
                               error='메모리 한도로 중단됨. 더 큰 메모리에서 이어서 처리하세요.' if self.resource_stop
                               else (None if self.stop_deadline is not None else '계산 프로세스가 예기치 않게 종료되었습니다. 체크포인트에서 재개할 수 있습니다.'))
                status = read_status(self.job)
            self._observed_exit = True
        if self.paused and self.running:
            status['phase'] = status['state']
            status['state'] = 'paused'
        elif self.stop_deadline is not None and self.running:
            status['state'] = 'stopping'
        return status

    def close(self):
        if self.running:
            self.stop()
            self.process.join(timeout=self.stop_grace)
            if self.running:
                self.process.terminate()
                self.process.join(timeout=2)
            self.poll()
