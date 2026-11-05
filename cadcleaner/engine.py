"""Worker-only DXF analysis. Transactions commit dedup keys with decisions."""
import json
import math
from pathlib import Path
import shutil
import time
from collections import Counter

import ezdxf
from ezdxf.addons import Importer

from .jobs import connect, digest, set_status
from .preview import write_preview

SUPPORTED_VISIBLE = {'LINE', 'ARC', 'CIRCLE', 'ELLIPSE', 'SPLINE', 'LWPOLYLINE',
                     'POLYLINE', 'POINT', 'SOLID', 'TRACE', '3DFACE', 'TEXT', 'MTEXT'}


def exclusion(entity, doc, mode):
    if mode == 'all':
        return None
    layer = doc.layers.get(entity.dxf.layer)
    if layer.is_off() or layer.is_frozen() or entity.dxf.get('invisible', 0):
        return 'hidden_layer_or_entity'
    if entity.dxftype() not in SUPPORTED_VISIBLE:
        return 'unverified_visibility:' + entity.dxftype()
    # Persistent reactors, extension data can encode visibility/associations.
    if entity.has_extension_dict or (entity.xdata is not None) or entity.get_reactors():
        return 'unverified_metadata'
    return None


def signature(entity):
    if entity.dxftype() != 'LINE':
        return None
    if (entity.xdata is not None) or entity.has_extension_dict or entity.get_reactors():
        return None
    a, b = tuple(entity.dxf.start), tuple(entity.dxf.end)
    if not all(math.isfinite(v) for v in (*a, *b)):
        return None
    attrs = entity.dxf.all_existing_dxf_attribs()
    for key in ('handle', 'owner', 'start', 'end'):
        attrs.pop(key, None)
    # No quantization. Missing/default attributes remain distinct conservatively.
    return json.dumps([sorted((a, b)), attrs], sort_keys=True, default=tuple)


def anchor_count(entity):
    kind = entity.dxftype()
    if kind == 'LINE': return 2
    if kind == 'LWPOLYLINE': return len(entity)
    if kind == 'POLYLINE': return len(entity.vertices)
    if kind == 'SPLINE': return len(entity.control_points)
    if kind == 'POINT': return 1
    return 0


def run_job(job, should_stop=lambda: False):
    job = Path(job)
    config = json.loads((job / 'job.json').read_text(encoding='utf-8'))
    if config.get('version') != 1:
        raise ValueError('지원되지 않는 체크포인트 버전입니다.')
    db = connect(job)
    start = time.monotonic()
    def stopped():
        if should_stop():
            set_status(db, state='stopped')
            return True
        return False
    try:
        set_status(db, state='reading', error=None)
        if digest(job / 'original.dxf') != config['sha256']:
            raise ValueError('작업 백업이 변경되었습니다. 원본으로 새 작업을 만드세요.')
        if stopped(): return
        doc = ezdxf.readfile(job / 'original.dxf')
        if config['mode'] == 'visible' and doc.header.get('$TILEMODE', 1) == 0:
            raise ValueError('현재 종이 공간/뷰포트 표시는 재현할 수 없습니다. 모델 공간 DXF 또는 전체 모드를 사용하세요.')
        msp = doc.modelspace()
        total = len(msp)
        processed = db.execute('SELECT count(*) FROM decisions').fetchone()[0]
        set_status(db, state='analyzing', total=total, processed=processed)
        batch_size, batch = 16, []
        checkpoint_time = time.monotonic()
        for entity in msp:
            if stopped(): return
            handle = entity.dxf.handle
            if db.execute('SELECT 1 FROM decisions WHERE handle=?', (handle,)).fetchone():
                continue
            reason = exclusion(entity, doc, config['mode'])
            action = 'exclude' if reason else 'keep'
            sig = None
            if action == 'keep':
                sig = signature(entity)
                # Metadata-bearing geometry is protected from all cleanup.
                if sig and config['remove_zero'] and entity.dxf.start == entity.dxf.end:
                    action, reason, sig = 'zero', 'exact_zero_length', None
                elif sig:
                    # Check keys in this transaction; rollback undoes both tables.
                    found = db.execute('INSERT OR IGNORE INTO seen VALUES (?, ?)', (sig, handle))
                    if found.rowcount == 0:
                        action, reason = 'duplicate', 'exact_line_same_attributes'
            db.execute('INSERT INTO decisions VALUES (?, ?, ?)', (handle, action, reason or ''))
            batch.append(handle)
            if len(batch) >= batch_size:
                processed += len(batch)
                set_status(db, processed=processed, batch_size=batch_size)
                elapsed = max(time.monotonic() - checkpoint_time, 0.001)
                batch_size = max(16, min(1024, int(batch_size * 0.1 / elapsed)))
                checkpoint_time = time.monotonic()
                batch.clear()
        processed += len(batch)
        set_status(db, processed=processed, state='exporting')
        if stopped(): return
        # Export into a separate document: no orphaned hidden block definitions
        # in visible mode, no mutation of the immutable backup.
        output = ezdxf.new(doc.dxfversion)
        output.units = doc.units
        importer = Importer(doc, output)
        counts = Counter()
        reasons = Counter()
        before_anchors = after_anchors = 0
        kept = []
        for entity in msp:
            if stopped(): return
            action, reason = db.execute('SELECT action,reason FROM decisions WHERE handle=?', (entity.dxf.handle,)).fetchone()
            counts[action] += 1
            if reason: reasons[reason] += 1
            before_anchors += anchor_count(entity)
            if action == 'keep':
                kept.append(entity)
                after_anchors += anchor_count(entity)
        # All mode must preserve arbitrary CAD records/associations losslessly.
        if config['mode'] == 'all':
            output = doc
        else:
            importer.import_entities(kept, output.modelspace())
            importer.finalize()
        staging = job / 'staging'
        staging.mkdir(exist_ok=True)
        before_preview = write_preview(staging / 'preview-before.svg', msp, should_stop)
        if stopped(): return
        if config['mode'] == 'all':
            for entity in list(output.modelspace()):
                action = db.execute('SELECT action FROM decisions WHERE handle=?', (entity.dxf.handle,)).fetchone()[0]
                if action != 'keep': output.modelspace().delete_entity(entity)
        if stopped(): return
        after_preview = write_preview(staging / 'preview-after.svg', output.modelspace(), should_stop)
        if stopped(): return
        output.saveas(staging / 'cleaned.dxf')
        if stopped(): return
        checked = ezdxf.readfile(staging / 'cleaned.dxf')
        audit = checked.audit()
        if audit.has_errors or audit.has_fixes:
            raise ValueError('출력 DXF 무결성 검사가 수정/오류를 보고했습니다. 결과를 저장하지 않습니다.')
        if len(checked.modelspace()) != counts['keep']:
            raise ValueError('내보낸 객체 수가 계획과 다릅니다. 지원되지 않는 DXF 변환입니다.')
        report = dict(version=1, mode=config['mode'], scope='modelspace',
                      source_sha256=config['sha256'], before_entities=total,
                      after_entities=counts['keep'], duplicates_removed=counts['duplicate'],
                      zero_removed=counts['zero'], excluded_entities=counts['exclude'],
                      before_anchors=before_anchors, after_anchors=after_anchors,
                      anchor_scope='LINE / polyline vertices / SPLINE control points / POINT only',
                      before_bytes=(job / 'original.dxf').stat().st_size,
                      after_bytes=(staging / 'cleaned.dxf').stat().st_size,
                      processing_seconds=time.monotonic() - start,
                      exclusion_reasons=dict(reasons), preview_before=before_preview, preview_after=after_preview,
                      units=int(doc.units), scheduler='single worker, adaptive 16–1024 entity transactions',
                      limitations=[
                          'Current display means modelspace layer OFF/Freeze and entity invisible flags only; not a CAD viewport renderer.',
                          'Visible mode omits all INSERT/XREF, HATCH and other unsupported entities; metadata-bearing objects are omitted.',
                          'All mode retains hidden objects, paper layouts, block definitions and unsupported CAD data.',
                          'SVG previews project XY only and omit text/blocks/unsupported geometry; see preview counts. DXF is authoritative.',
                          'No DWG, Illustrator bridge, endpoint joining, curve simplification or parallel geometry scheduling in v0.1.',
                          'Read/export use full ezdxf documents in worker memory; process-level pause/stop remains available.',
                          'Visible export uses ezdxf Importer; global document settings and paper layouts are not reproduced.',
                      ])
        (staging / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        names = ('cleaned.dxf', 'preview-before.svg', 'preview-after.svg', 'report.json')
        hashes = {n: digest(staging / n) for n in names}
        (staging / 'hashes.json').write_text(json.dumps(hashes), encoding='utf-8')
        if stopped(): return
        set_status(db, state='ready', summary=report)
    except Exception as exc:
        db.rollback()
        set_status(db, state='error', error=f'{type(exc).__name__}: {exc}')
        raise
    finally:
        db.rollback()
        db.close()
