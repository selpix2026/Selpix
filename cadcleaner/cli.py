"""Source and packaged batch entry; uses the same isolated worker as the UI."""
import argparse
import json
from pathlib import Path
import sys
import time
from . import __version__


def main():
    parser = argparse.ArgumentParser(description='CAD Light Cleaner — DXF 안전 정리')
    parser.add_argument('--version', action='version', version=__version__)
    parser.add_argument('--batch', type=Path, help='UI 없이 DXF 처리. --output은 명시적 결과 승인입니다.')
    parser.add_argument('--output', type=Path, help='존재하지 않는 새 결과 폴더')
    parser.add_argument('--jobs-root', type=Path, default=Path.home() / 'CADLightCleaner-jobs')
    parser.add_argument('--all', action='store_true', help='숨김 객체를 포함한 전체 도면')
    parser.add_argument('--keep-zero', action='store_true')
    args = parser.parse_args()
    if args.batch is None:
        if args.output: parser.error('--output에는 --batch가 필요합니다.')
        from .ui import main as ui_main
        return ui_main()
    if args.output is None: parser.error('--batch에는 --output 새 폴더가 필요합니다.')
    from .jobs import create_job, approve
    from .controller import Controller
    controller = Controller()
    try:
        if args.output.exists(): raise FileExistsError(f'결과 폴더가 이미 있습니다: {args.output}')
        job = create_job(args.batch, args.jobs_root, 'all' if args.all else 'visible', not args.keep_zero)
        controller.start(job)
        while True:
            status = controller.poll()
            if status['state'] in ('ready', 'error', 'stopped'): break
            time.sleep(0.05)
        if status['state'] != 'ready':
            raise ValueError(f'{status.get("error") or status["state"]} — 체크포인트: {job}')
        result = approve(job, args.output)
        if sys.stdout:
            print(json.dumps(dict(output=str(result), job=str(job), summary=status['summary']), ensure_ascii=False))
        return 0
    except KeyboardInterrupt:
        controller.stop()
        return 130
    except Exception as exc:
        if sys.stderr: print(str(exc), file=sys.stderr)
        return 1
    finally:
        controller.close()
