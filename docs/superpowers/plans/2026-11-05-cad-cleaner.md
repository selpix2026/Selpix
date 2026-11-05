# CAD Light Cleaner Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline; user requests continuous implementation.

**Goal:** usable DXF cleanup desktop with independent worker and resumable jobs.
**Architecture:** Qt controller → spawned worker → SQLite decisions → audited staging → explicit approval.
**Tech Stack:** Python 3.12, PySide6, ezdxf, psutil, pytest, PyInstaller.
**Spec:** docs/superpowers/specs/2026-11-05-cad-cleaner-design.md

## Global Constraints
Never overwrite original. Visibility defaults conservative. Report unsupported CAD semantics. No Illustrator work on computation path. Existing cloud checkout is isolated; no worktree.

## Review Focus
Source/destination collisions; worker killed inside transaction; hidden block content; misleading partial previews; resume after original changes.

### Task 1: DXF analysis and persistence
Files: cadcleaner/engine.py, cadcleaner/jobs.py, tests/test_engine.py.
Interfaces: create_job(source, root, mode, remove_zero) -> Path; run_job(job) -> None; read_status(job) -> dict; approve(job, destination) -> Path.
- [x] Write real fixture tests for duplicate/visibility/source preservation and observe failure.
- [x] Implement disk-backed exact LINE decisions, immutable source snapshot, conservative visibility, validated output/report.
- [x] Run engine suite, expect passing with output entity counts and source bytes unchanged.

### Task 2: independent controller
Files: cadcleaner/controller.py, tests/test_process.py.
Interfaces: Controller.start(job), pause(), resume(), stop(), poll(), close().
- [x] Test real spawned worker pause/progress freeze, stop/checkpoint/restart and malformed DXF errors; observe missing implementation.
- [x] Implement spawn, suspension, timeout termination, crash reporting and resource status.
- [x] Run engine and process tests.

### Task 3: desktop and distribution
Files: cadcleaner/ui.py, launcher.py, tests/test_ui.py, README.md, requirements*.txt, .github/workflows/windows.yml.
- [x] Write offscreen UI workflow tests, observe missing module.
- [x] Implement file/mode selection, job opening, pause/stop/resume, two previews, report and approval export.
- [x] Run whole suite, compile modules, make local runnable bundle and Windows CI recipe.
- [x] Save cloud install/start draft after executing those operations.

## Completion evidence
See docs/verification.md for 17 passing tests, actual Linux bundled-worker processing, and saved cloud draft. Windows build is provided but remains unrun on Windows. No merge/push/publication performed.
