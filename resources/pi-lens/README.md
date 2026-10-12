# Pi Lens analysis integration

The bridge targets Pi Lens **4.3.0**. It patches both the bundled extension and
its unbundled modules. Unknown versions or changed patch anchors fail explicitly;
there is no synchronous native/WASM fallback in the Pi process.

## Execution boundary

- Native ast-grep and Tree-sitter run in one supervised, read-only child process.
  A fixed operation allowlist covers queries, symbols, file facts, graph data,
  module reports, complexity and read expansion. AST/WASM objects never cross IPC.
- Original matching and extraction algorithms, trust policy and grammar policy
  remain in use. The native preflight rejects only impossible positive conditions;
  the final match is still performed by ast-grep.
- Jobs are serialized and input is snapshotted on enqueue. Advanced IPC preserves
  `undefined`, infinite values and result health metadata. Warm parse/query caches
  retain their existing bounded capacities; the idle executor is retired.
- Parent deadlines include queue time. Scope cancellation affects only its jobs;
  global Stop increments the execution epoch, aborts Pi and terminates the owned
  executor. A stopped tool-result scope cannot start late analysis or publish
  stale findings/facts.
- An independent watchdog thread terminates a blocked executor after its deadline
  or when its owner disappears. A poisoned WASM heap is retired rather than reused.
  Work is never automatically replayed after a crash.

## Results and failures

Analyzer exceptions, timeouts and rejected rules are incomplete checks, not clean
reports. Valid partial findings are retained. Dispatch exposes incomplete coverage
to the model, does not record native fallback coverage for rejected rules, and
project scans do not overwrite the durable complete cache with partial results.
Intentional cancellation remains cancellation, not an analyzer exception.

Child telemetry is replayed into the actual parent/session sinks, including the
bundled extension's ledger. Source consistency is checked before publishing native
findings and file-local fact updates. Cache measurements tolerate executor restart.

`applyPiLensGrammarCache` reapplies this bridge during dependency preparation,
module upgrades and rollback. The RPC abort integration is in
`resources/pi-rpc-bridge/rpc-mode.js` and installed by the existing bridge script.

## Verification (no project compilation)

Run the `scripts/pi-lens-*.test.mjs` Node tests and
`scripts/runtime-compatibility.test.mjs`. The ASAR test packages only a disposable
analyzer fixture and exercises it with the installed Electron executable; it does
not build or replace Pi Desktop. `scripts/pi-lens-hang-repro.mjs --optimized
--stress` reads the original problematic catalog into a disposable fixture and
never executes its site's commands.

Tests exercise matching parity, Unicode coordinates, warm caches, scope isolation,
deadlines, real blocking/fault paths, orphan cleanup and runtime recovery. They do
not establish that arbitrary analyzers or the operating system can never fail.
External CLI runners and ordinary upstream filesystem/configuration routines are
not moved into this native/WASM executor.

## Packaged executable paths

LSP executables resolved into an ASAR archive are redirected to a verified
physical `app.asar.unpacked` binary before launching. Missing binaries and
JavaScript arguments are not silently rewritten.
