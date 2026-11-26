# Vespera Client v1.2.3 Installation Engine — Root-Cause Audit

**Audit status:** completed from repository inspection before implementation.  
**Baseline inspected:** `61f80e7` (`Fix Fabric library metadata validation in v1.2.2`), branch `arena/f96b150b-mcclient`.  
**Code changes:** none as of this report. This document is the required audit gate; implementation has not started.  
**Evidence limitation:** no Windows diagnostic log, exact historical HTTP request/response, or exact Fabric coordinate was supplied. Therefore the two user-reported upstream failures cannot honestly be assigned to one specific historical URL/artifact from source alone.

## Executive finding

The confirmed, immediate cause of the Windows “Not Responding” behavior is architectural: the native `vesperaNativeInvoke` WebView binding calls `engine.handleRpc()` synchronously. `installVersion` then runs the full native installer inline in that binding callback. That installer performs synchronous WinHTTP requests and downloads, filesystem work, full-file hashing, JSON parsing, asset processing, and waits on `tar.exe`. Consequently, the WebView2/UI thread cannot pump messages, process `getSnapshot`, redraw progress, or dispatch the `cancelVersionDownload` RPC while installation is in progress. A UI-side timeout does not make the native operation asynchronous or cancel it.

The native path has no durable per-artifact journal. Its download/progress object is in memory; the receipt is removed at install start and only written after the completion path. A restart therefore cannot recover from an authoritative list of verified artifacts. Disk inspection can identify some partial presence, but cannot tell which artifacts were verified against their current metadata. This is the confirmed recovery gap behind unreliable partial-install reporting/resume.

The source tree does contain a Mojang manifest refresh-and-retry implementation and v1.2.2 source changes allowing absent Fabric SHA-1 values. Those are useful existing protections, but they do not establish the exact historical failing endpoint or artifact. The issue descriptions alone are not enough to name either one without inventing evidence.

## Execution trace and blocking/failure surfaces

1. The play-page UI action uses `bridge.installVersion(...)` (or launches through `launchMinecraft`). The UI polls snapshots for progress and has a cancel control.
2. In the native Windows build, `ui/src/bridge.ts` selects `window.vesperaNativeInvoke`. Its promise is only a JS-facing wrapper around the host binding; it does not offload the C++ method.
3. `native/src/vespera_launcher.cpp` binds `vesperaNativeInvoke` to a callback that parses JSON, invokes `engine.handleRpc(method, params)`, then returns JSON. The `installVersion` branch calls `installMinecraftVersionNative(...)` directly before returning.
4. `installMinecraftVersionNative` refreshes/loads Mojang manifest data; obtains version metadata from the manifest entry; parses version libraries, asset index, and (for Fabric) loader profile; builds an artifact plan; downloads assets/libraries/client JAR; hashes and validates files; extracts native archives using `CreateProcessW` plus `WaitForSingleObject`; validates and writes a receipt.
5. Launch follows a separate native/TypeScript implementation path: it verifies/installs before preparing the command, chooses/provisions Java, constructs JVM/game arguments, and spawns the process. The TypeScript path is asynchronous at its public method boundary, but the separate native Windows code remains synchronous on the WebView binding thread.
6. The non-native/server path routes RPC through `server/rpcRouter.ts` into async `stateStore` and `minecraftLauncherService` methods. That path does not cure the native UI-thread freeze in the shipped Windows launcher. It also has its own integrity/state behavior and must remain covered by regression tests.

### Operations that can block or leave state inconsistent

- Native WinHTTP calls (`winhttp_request`, `winhttp_download_verified`) are synchronous. They have finite helper timeouts/retries, but they occupy the WebView callback thread while active.
- Native `bcrypt_hash_file` reads a whole file into a vector before hashing. Asset/library validation can therefore use significant synchronous I/O and memory.
- Native archive extraction waits synchronously for an external `tar.exe`; return/timeout status handling is not sufficient to establish extraction success in the inspected flow.
- Native receipt deletion occurs at install start; a failed operation can leave artifacts but no durable completion record. `activeDownloadState` is not persistent.
- Native `handleRpc` takes `mtx` for most methods, while install is specially dispatched outside that lock. This avoids holding the central state lock across the entire installer, but does not avoid UI-thread blocking; shared install/progress fields also need explicit synchronization when moved to workers.
- The UI timer can continue scheduling polling calls, but a blocked WebView callback prevents WebView2 from servicing them. Cancellation is also an RPC and is blocked for the same reason.
- The native progress estimate uses fallback artifact sizes in planning and derives totals before all work is necessarily known. These estimates are not reliable evidence of a true byte total for unknown-size artifacts. Stages are coarse, and the state lives only in memory.
- The server-side launcher does integrity checks before launch and awaits installation when unhealthy. Its verifier/installer and Java/launch logic are distinct from native and need shared acceptance checks to prevent behavior divergence.

## Findings by reported issue

### A — Mojang metadata HTTP 404

**Confirmed current behavior:** native metadata URLs are read from the selected version entry (`manifestUrl`) originating in the Mojang manifest; the code does not build a version metadata URL from a version ID. It verifies metadata SHA-1 against the manifest and, when the metadata fetch fails specifically with HTTP 404, calls `refreshOfficialManifest(true)`, looks up the exact version ID again, and retries once using the refreshed URL/hash.

**What cannot be established:** the reported `.../v1/packages/...` URL contains a package hash, but no captured URL, manifest cache, HTTP response, timestamp, or build log was supplied. The present source cannot prove whether that URL was stale, whether the manifest itself was stale/corrupt at the time, or whether Mojang/CDN returned a transient 404. No exact historical failing entry/hash can be identified from the report. In particular, the current source already has a refresh/retry path, so claiming that the v1.2.3 repair is simply “refresh on 404” would be unsupported and redundant.

**Audit conclusion:** stale manifest metadata is a plausible failure class, not a proven exact incident cause. Implementation must retain authoritative manifest URL resolution and exercise the 404-refresh branch with deterministic tests and diagnostics; the actual endpoint must be logged in a real reproduction.

### B — Fabric library metadata validation

**Confirmed current behavior:** Fabric profile parsing uses the Fabric profile schema (`libraries` entries with Maven `name`, repository `url`, and optional `sha1`), distinct from Mojang's nested `downloads.artifact` / `downloads.classifiers` records. In the inspected v1.2.2 native code, empty SHA-1 is allowed for Fabric libraries and the constructed artifact must still have a valid HTTPS repository, safe Maven path, and valid JAR format; a published SHA-1 is checked when present. The recent v1.2.2 commit and regression work explicitly addressed optional Fabric checksums.

**What cannot be established:** the real-world message does not include a coordinate, source URL, profile JSON, or artifact bytes. The exact Fabric artifact that triggered the earlier error is therefore unknown. The source evidence supports the *class* of defect in the earlier strict validator—treating a missing optional SHA-1 as invalid—but cannot tie it to a specific library name or prove there was no separate malformed URL/schema issue.

**Audit conclusion:** do not invent an artifact name. Add source/coordinate/URL/hash-availability diagnostics and schema-level tests using actual upstream Fabric profile fixtures. Preserve validation of URLs, coordinate/path safety, downloaded content, JAR structure, and trusted hashes.

### C — Installation freezes

**Root cause confirmed by source:** synchronous native host binding executes a long synchronous installer on the WebView2 UI thread. Progress snapshots and cancellation are dispatched through the same bridge, so neither can be serviced while the installer callback is busy. This directly explains the UI hang and why the page can remain at “Preparing...” even while native work is active. It is independent of whether the network eventually succeeds.

### D — Partially Downloaded / stuck installs

**Root cause confirmed by source:** native progress is volatile, the install receipt is removed before work begins, and no durable per-artifact download journal was found in the inspected native installation path. A failure/cancellation may leave some completed files and `.part` files, while the next invocation has no persisted trusted record of artifact status. The current status classifier derives state from files/receipt and is necessarily weaker than verifying every required artifact against the selected metadata. This can explain a partial state but is not by itself evidence that partial files caused the freeze; the UI-thread blocking is sufficient to explain the freeze.

## Additional compatibility and integrity risks to address

- Official version metadata validation currently requires a `downloads.client` record and `assetIndex` object. Compatibility with all official historical/beta/alpha/snapshot schema variants must be assessed from real manifest fixtures; do not label the entire catalogue installable solely because it appears in the manifest.
- Native artifact plans support Windows Mojang rules, legacy Maven repository URLs, classifiers/natives, asset indexes, and Fabric profiles, but comprehensive rule/exclusion/classifier coverage and metadata-specific tests are needed before claiming universal catalogue support.
- Some native code uses fallback sizes for libraries/assets whose metadata omits a size; this makes aggregate progress potentially estimated rather than exact. Unknown totals should be shown as indeterminate.
- Launch is guarded by a verifier/receipt and Java preparation, but the final guarantee must be based on a complete required-artifact validation immediately before spawn—not solely on a prior status or receipt. Process creation is not equivalent to successful game startup.
- The project has both native C++ and TypeScript/server install implementations. Fixes must not leave materially different URL resolution, recovery, state, or validation semantics between them.
- Requested real Windows installation/launch matrix, crash recovery, slow/interrupted network, and Java 8/17/21 tests have **not** been run in this audit environment. No install or launch success is claimed.

## Required implementation direction (not yet applied)

1. Make native install/launch work owned by a background task/worker, with UI-thread RPCs limited to enqueue/status/cancel and short state access. Establish task lifetime, duplicate-job exclusion, cancellation, exception propagation, and synchronization before dispatching work.
2. Persist an atomically written journal keyed by installation identity and artifact. Record source, coordinate/relative destination, expected size/hash/algorithm when known, status, and failure. Revalidate files on recovery; preserve only files proven valid; discard only invalid/incomplete temporary artifacts.
3. Make status transitions explicit and recoverable, and persist meaningful failure/cancellation state. Never report Installed or launch until the full required set, natives, assets, metadata, and Java preflight pass.
4. Use real artifact byte counts and indeterminate progress for unknown totals; expose current artifact/stage, speed, and cancellation status through a thread-safe snapshot.
5. Add controlled retries and cancellation to every network operation; ensure HTTP status/network categories survive to diagnostics. No unbounded retry loops.
6. Test official manifest refresh/retry, source-aware Mojang/Fabric schemas, Maven coordinates/classifiers, valid hashless Fabric artifacts, corrupt cache, file preservation/recovery, cancellation, and duplicate job handling using unit/integration fixtures before runtime tests.
7. Keep offline-account behavior independent of Microsoft auth and retain Vespera identity/features.

## Audit artifacts and test claims

This report is the pre-implementation root-cause report. At report creation, the working tree had no v1.2.3 implementation changes; no tests/build/install/launch were run as part of the current audit. Exact historical 404 and Fabric artifact identity remain unknown pending a diagnostic capture. The Windows build and live install/launch matrix cannot be represented as verified until actually executed on Windows with the listed versions and runtime/network scenarios.
