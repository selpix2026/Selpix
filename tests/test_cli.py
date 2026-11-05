import subprocess
import sys
from pathlib import Path
import ezdxf


def test_command_line_runs_real_worker_and_never_overwrites(tmp_path):
    source = tmp_path / 'source.dxf'
    doc = ezdxf.new(); m = doc.modelspace()
    m.add_line((1, 1), (2, 2)); m.add_line((2, 2), (1, 1)); doc.saveas(source)
    original = source.read_bytes()
    args = [sys.executable, str(Path(__file__).parents[1] / 'launcher.py'), '--batch', str(source),
            '--output', str(tmp_path / 'out'), '--jobs-root', str(tmp_path / 'jobs')]
    completed = subprocess.run(args, capture_output=True, text=True, timeout=30)
    assert completed.returncode == 0, completed.stderr
    assert len(ezdxf.readfile(tmp_path / 'out/cleaned.dxf').modelspace()) == 1
    assert source.read_bytes() == original
    again = subprocess.run(args, capture_output=True, text=True, timeout=30)
    assert again.returncode != 0
    assert source.read_bytes() == original
