# Illustrator JSX v1.3 repair plan

User requests update of CAD_Cleaner_v1.2.jsx: faster completion, avoid long unresponsiveness, close progress boxes and show completion. Existing instruction to proceed without unnecessary confirmations and standing permission to upload to selpix2026/Selpix apply.

Architecture choice: keep a single ES3 JSX installable via Illustrator File > Scripts > Other Script. Preserve geometry features. Use existing independent Windows control UI for command exchange, with completion protocol and health checks. A full external engine is a different tool and does not fix this user's existing JSX delivery. JSX remains synchronous; no guarantee of fully responsive Illustrator during host calls.

- [x] Reproduce final-PAUSE hang, lost controller hang, excessive forced status IO and source protection in Node host-adapter tests.
- [x] Finalize in finally, never wait for PAUSE after work completes, add bounded controller close acknowledgement, final status fallback and freely closable external window. Emit ready only after form Shown and heartbeat/controller health.
- [x] Throttle IO/yield by elapsed time, cap per-phase work duration and per-item sizes. Run only actual mutation operations. Cap scanning even when all items are protected. Keep curve preview cancellable with fresh session.
- [x] Partition dedup/join candidates by compatible parent/style; bound dense scans; exact-zero endpoint tolerance. Retain geometry protection and bounded chains.
- [x] Add clear analysis-ready versus apply-completed status, terminal report, fast default joining/groups OFF, mm input 0.001 precision (0 exact).
- [x] Run Node regression and existing Python suite, review JSX ES3 syntax, package single JSX + Korean README ZIP. Publish to existing GitHub repository and verify fetched ZIP bytes.

Validation limitation: Illustrator 2026 and Windows PowerShell/WinForms are unavailable here. Host-adapter tests prove JS logic and generated PowerShell text is inspected; real Illustrator acceptance remains a separate required check. No claim of zero hangs or measured Illustrator speedup.

## Evidence
32 Node host-adapter and ES3 tests passed; existing 17 Python tests passed. Independent review findings on completion IO and partial deletion reporting were addressed. Windows controller callback test is provided in CI but is unrun in Linux. Illustrator acceptance and performance measurement remain unverified.
