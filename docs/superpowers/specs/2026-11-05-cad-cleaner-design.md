# CAD Light Cleaner: first usable increment

User handoff is the product specification. User explicitly requests continuous implementation without approval questions. This design records implementation choices, not user endorsements.

## Intent and safety
Windows 11 standalone desktop application, Illustrator 2026 downstream. Preserve original bytes, preview decisions, approve export to a NEW directory. Backups and SQLite decisions allow independent recovery without Illustrator undo.

## Approaches
Native .NET desktop has strong Windows integration but no available .NET toolchain and requires a commercial or less mature DXF stack. A browser front end introduces server lifecycle complexity. Chosen: Python 3.12, PySide6, ezdxf, spawned worker and SQLite. Windows executable is built on Windows via PyInstaller, never claimed tested from Linux.

## First increment
Direct DXF modelspace input; current visible state by default or explicit all-objects mode. Exactly duplicate LINE entities only, with matching layer and complete rendering attributes; zero-length LINE removal optional. Preserve curves, blocks and all unmodified entities in DXF. Do not flatten blocks. For visible export conservatively omit INSERT (dynamic state, nesting and XREF not validated), viewport/clipping dependent drawings and unsupported render objects; report every omission and limitation. No guessed hidden geometry. Paper space is explicitly outside selected scope. SVG is a bounded preview of supported modelspace LINE/ARC/CIRCLE/LWPOLYLINE only, with explicit omission report; DXF is authoritative.

Controller/UI never parses DXF. Worker performs read/analysis/export. Process-level pause/resume with psutil suspends even parser/native work. Stop resumes suspended process then requests a safe boundary; controller forcibly terminates after timeout, retains committed SQLite batches. Resume rereads immutable backup and skips committed handles. Export writes only job-private staging, checks DXF audit, and approval copies into exclusively created new output directory. No source overwrite. SQLite transaction makes seen keys and entity decisions atomic.

Bounded preview and indexed disk dedup avoid all-pairs comparisons. Adaptive batches target 0.1 seconds with 16–1024 entity limits; single worker initially avoids nondeterministic duplicate ownership and extra parser memory. Automatic multiworker geometry scheduling, endpoint joining, curve approximation, DWG and Illustrator bridge are explicit later work, not simulated controls.

## Validation
Generated DXF fixtures: reversed duplicates, precision differences, layers/styles, hidden/frozen entities, blocks/XREF, curves, coordinates, unknown units, large line sets. Actual spawned-process pause/stop/restart; source hashes; audit output; UI interactions using offscreen Qt. Real customer CAD and Windows/Illustrator tests require those runtimes/data and remain unverified.
