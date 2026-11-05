"""Durable job manifests and explicit, non-overwriting publication."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import uuid


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def connect(job):
    db = sqlite3.connect(Path(job) / 'checkpoint.sqlite', timeout=5)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA synchronous=FULL')
    return db


def set_status(db, **fields):
    with db:
        for key, value in fields.items():
            db.execute('INSERT OR REPLACE INTO status VALUES (?, ?)', (key, json.dumps(value)))


def read_status(job):
    with connect(job) as db:
        return {k: json.loads(v) for k, v in db.execute('SELECT key,value FROM status')}


def create_job(source, root, mode='visible', remove_zero=True):
    source = Path(source).resolve()
    if mode not in ('visible', 'all'):
        raise ValueError('표시 모드는 visible 또는 all이어야 합니다.')
    if source.suffix.lower() != '.dxf':
        raise ValueError('현재 버전은 DXF만 지원합니다. DWG는 검증된 변환기로 DXF로 변환하세요.')
    if not source.is_file():
        raise FileNotFoundError(source)
    job = Path(root).resolve() / uuid.uuid4().hex
    job.mkdir(parents=True)
    try:
        before = source.stat()
        shutil.copyfile(source, job / 'original.dxf')
        after = source.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError('백업 도중 원본이 변경되었습니다. 저장을 완료한 뒤 다시 시도하세요.')
        config = dict(version=1, source=str(source), sha256=digest(job / 'original.dxf'),
                      mode=mode, remove_zero=remove_zero)
        (job / 'job.json').write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding='utf-8')
        with connect(job) as db:
            db.executescript('''
                CREATE TABLE status(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE decisions(handle TEXT PRIMARY KEY, action TEXT NOT NULL, reason TEXT NOT NULL);
                CREATE TABLE seen(signature TEXT PRIMARY KEY, handle TEXT NOT NULL);
            ''')
            set_status(db, state='new', processed=0, total=0)
    except Exception:
        shutil.rmtree(job)
        raise
    return job


def approve(job, destination):
    job, destination = Path(job).resolve(), Path(destination).resolve()
    if read_status(job)['state'] != 'ready':
        raise ValueError('검증이 완료된 결과만 저장할 수 있습니다.')
    hashes = json.loads((job / 'staging/hashes.json').read_text(encoding='utf-8'))
    # Fixed filenames only; never trust file paths in a manifest.
    names = ('cleaned.dxf', 'preview-before.svg', 'preview-after.svg', 'report.json')
    if any(digest(job / 'staging' / n) != hashes.get(n) for n in names):
        raise ValueError('결과 파일이 검증 이후 변경되었습니다. 다시 계산하세요.')
    if destination == job or job in destination.parents:
        raise ValueError('작업 폴더 밖의 새 결과 폴더를 선택하세요.')
    destination.mkdir(parents=False, exist_ok=False)
    try:
        for name in names:
            # Exclusive create prevents any existing path being overwritten.
            with (job / 'staging' / name).open('rb') as src, (destination / name).open('xb') as out:
                shutil.copyfileobj(src, out)
        if any(digest(destination / n) != hashes[n] for n in names):
            raise ValueError('복사된 결과의 무결성 검사에 실패했습니다.')
    except Exception:
        # Only this newly created output directory belongs to this operation.
        shutil.rmtree(destination)
        raise
    return destination
