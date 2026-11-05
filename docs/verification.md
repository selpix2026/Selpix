# Verification record — 2026-11-05

Current implementation, Linux cloud Python 3.12.14:

- `QT_QPA_PLATFORM=offscreen XDG_CACHE_HOME=/tmp/cadcleaner-cache /workspace/selpix-venv/bin/python -m pytest -q`: **17 passed**, 65 upstream pyparsing deprecation warnings, 8.70 seconds.
- `python -m compileall -q cadcleaner launcher.py`: exit 0.
- `python -m pip check`: no broken requirements.
- Exact saved requirements-lock.txt install rerun: exit 0, dependencies already satisfied.
- PyInstaller onedir Linux build with `--collect-all ezdxf --collect-all numpy`: exit 0.
- Actual bundled executable batch-run on `examples/demo.dxf`: exit 0; 50 modelspace entities → 27, 20 exact duplicate LINE removed, 1 zero LINE removed, 2 visibility exclusions. Reopened DXF with ezdxf and audit passed.
- Qt offscreen functional UI test exercises analyze, previews, changes, report and job reopening. Actual rendered window visually inspected.
- Independent read-only code review found stale Stop controller binding and stale previews after job switching. Both were reproduced by failing tests and fixed; full suite green.
- Forced process kill test opens a real uncommitted SQLite transaction, terminates its process, confirms decisions and dedup keys both rolled back, and successfully resumes cleanup.

Windows build script and GitHub workflow are present but **have not been executed on Windows** in this session. No Windows binary is claimed. No actual Illustrator or customer DWG/DXF validation was possible. The generated demo is synthetic. Linux bundle is not a Windows executable.

Cloud `install_script` and `start_skill` draft save returned `status: saved`, `requires_publish: true`. This is saved configuration, not publication or validation in a newly restored task. No secrets or extra network destinations were needed.

Remaining product requirements (not a completed overall project): full CAD display state including static/dynamic blocks/XREF/viewports/clipping, DWG converter, Illustrator bridge, mm endpoint joining/PLINE generation, straight-anchor and curve simplification, partial DXF export, automatic multicore CPU/memory scheduling, Windows/Illustrator acceptance tests.
