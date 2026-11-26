# Vespera Client v1.2.5 — Launch Engine Root-Cause Audit

**Baseline audit and repair record.** The initial investigation began at `fd0ed19` (`Repair native ZIP extraction for v1.2.4`) on `arena/f96b150b-mcclient`, with a clean worktree. It separates source-confirmed behavior from user-machine evidence; subsequent implementation and verification are recorded below.

## Evidence boundary

The reported Windows machine, its `%APPDATA%\VesperaClient` logs, Java runtime, process table, Minecraft `latest.log`, crash reports, and actual WebView RPC trace are not available in this workspace. I cannot claim that Windows called `CreateProcessW`, that a Java PID was created on that machine, or that the process exited. The exact user-observed stop point is therefore **not yet identified**. The native code does, however, contain a launch lifecycle that cannot produce the evidence needed to identify that stop point.

## Trace from Play click to launch RPC

1. **UI Play click:** `ui/src/main.ts` sets `state.launchingGame = true`, renders, and polls `bridge.getSnapshot()` every 500 ms while awaiting `bridge.launchMinecraft()`. It clears that poll as soon as the RPC resolves or rejects. The button is disabled while the RPC is pending.
2. **Frontend transport:** `ui/src/bridge.ts` sends the `launchMinecraft` request through `window.vesperaNativeInvoke` in the embedded Windows app (or HTTP `/api/rpc` in preview); its launch RPC timeout is ten minutes. A timeout rejects the UI promise, but does not prove the native worker or spawned process was stopped.
3. **Native binding:** `native/src/vespera_launcher.cpp` routes launch to a worker thread. It begins a background task, runs `handleRpc("launchMinecraft", ...)`, and resolves the WebView promise on return. The WebView backend `resolve()` dispatches a callback onto its UI message window, so the worker-to-WebView resolution is explicitly asynchronous. No evidence from the user's machine shows whether this callback was delivered there.
4. **Install / metadata:** the selected profile's Minecraft version and loader are read; `getVersionInstallStatusOnDisk()` is checked and `installMinecraftVersionNative()` is called if needed. That installation path verifies metadata/artifact hashes, Fabric loader profile, classpath libraries, and loader-specific native DLL output before creating the receipt. It is not the Windows process-launch result.
5. **Java selection:** `buildLaunchPreparation()` reads `javaVersion.majorVersion` when present, otherwise uses the existing fallback version inference; it selects custom `javaw.exe` when configured or `runtimes/temurin-<major>/bin/javaw.exe`. The code checks only file existence before spawn. It does not run `java -version`, confirm the reported major, inspect Java architecture, or validate the executable by launching a short process.
6. **Argument construction:** the Fabric main class is read from the loader profile/receipt; vanilla uses Mojang `mainClass`. The classpath is built from receipt `verifiedLibraries` plus `<versions>/<version>/<version>.jar`, using `;` separators. JVM args include heap/GC, `java.library.path`, IPC property and classpath. Game args include username/version/gameDir/assetsDir/assetIndex/uuid/accessToken/userType/width/height. Fabric Loader and intermediary libraries are installed through the Fabric profile. The main class is emitted unquoted (normally safe as a Java class name); Java and each argument are surrounded by quotes, but no Windows argument escaping routine handles embedded quotes/backslashes. No complete non-secret launch record is preserved.
7. **Working directory/environment:** the current directory is the materialized profile instance directory. Environment is inherited (`lpEnvironment == nullptr`). No launch-time environment adjustments are applied.
8. **Process creation:** code calls `CreateProcessW(nullptr, mutableCommandLine, ..., FALSE, CREATE_NO_WINDOW, nullptr, instanceDir, ...)`, requesting the `javaw.exe` from the command line. If creation fails it throws with `GetLastError()`. On success it closes the thread handle, stores the process handle/PID, logs only a short “Spawned” line, calls telemetry refresh, and immediately returns `launched=true` with `stageReached=process_spawned_*`.
9. **Output and process lifetime:** `STARTUPINFOW` has no redirected standard handles; `javaw.exe` is started with `CREATE_NO_WINDOW`; stdout/stderr are not captured. The native code does not wait for the Java process or run a persistent process-monitor thread. `refreshTelemetry()` polls `GetExitCodeProcess()` only when some RPC invokes telemetry refresh; when the process is no longer active it closes the handle and clears the PID without recording the exit code or a failure event.
10. **UI status:** after the RPC returns, `launchingGame` becomes false and the frontend reports the backend's `launched` boolean as success. There is no continuing frontend poll or event subscription for Minecraft process exit. So source-level `launched=true` means only “CreateProcess returned success at one instant”; it does not mean Minecraft initialized, reached its main menu, or remained alive. A fast crash can be silent, and the UI has no durable status transition to show it.

## Source-confirmed root cause

The launch pipeline has **no observable, supervised startup lifecycle**. It hides the Java console, captures no output, treats process creation as launch success, does not continuously monitor the process, and does not persist an exit code or crash path. This is a confirmed design defect that can explain a launcher appearing to do nothing after an immediate JVM/game failure. It does **not** prove that this was the specific failure on the user's computer; no Windows logs/process evidence was supplied.

Other confirmed gaps that prevent a precise diagnosis today:

- no `java -version` / runtime architecture validation before building the command;
- no reliable Windows argument quoting/escaping helper;
- no launch-specific file log with full redacted arguments, selected runtime, cwd, `CreateProcessW` result, PID, stdout/stderr, exit code, or crash-report association;
- current telemetry's process poll is opportunistic, not an autonomous monitor;
- `stageReached=process_spawned_*` is the only successful stage emitted, and is returned before any initialization confirmation.

## Exact current command shape

The C++ launch command is assembled as:

`"<javaw.exe>" "<jvmArg1>" "<jvmArg2>" ... <mainClass> "<gameArg1>" "<gameArg2>" ...`

The Java path is `<customJavaPath>` if configured, otherwise `%APPDATA%\VesperaClient\runtimes\temurin-<metadata major>\bin\javaw.exe`. The classpath JVM argument is `-cp` followed by the `;`-joined verified library JARs and version client JAR. The working directory is the profile's resolved instance directory. The Windows process receives inherited environment, no console window and no redirected stdio. Secret token placeholder is substituted with the live access token immediately before process creation; command/diagnostic logging must redact it.

The exact expanded 1.21.4 Fabric command, executable, library paths, profile directory and auth values cannot be reconstructed from this workspace because the user's data/account/runtime are unavailable. The user asked that secrets not be exposed; a reproducible diagnostic should keep the command token-redacted.

## Runtime compatibility and metadata boundary

The code honors Mojang `javaVersion.majorVersion` when present and otherwise uses `infer_java_major_cpp()`. This audit did not run the selected Windows Java executable, inspect its bitness, or compare a real 1.21.4 Fabric profile's resulting arguments. Do not claim Java 8/17/21 execution or Fabric/Vanilla launch success on the basis of source inspection or a PE cross-build.

## Planned v1.2.5 repair and tests (not yet applied at audit time)

- Replace the one-shot `javaw.exe` spawn with a supervised Java process lifecycle that captures stdout/stderr without blocking WebView, stores PID/exit code, and reports distinct preparing/starting/created/initializing/running/exited/failed states. “Running” must not be inferred from `CreateProcessW` success alone.
- Centralize correct Windows command-line quoting; log executable, redacted args, cwd, expected Java major, process creation error, PID, and exit status. Verify runtime major/architecture with a bounded `java.exe -version` / property probe before game spawn.
- Persist one diagnostic bundle per launch under `%APPDATA%\VesperaClient\logs\launches\`, including stdout/stderr and paths to available `latest.log`/crash reports; redact access/refresh tokens and other secrets.
- Add durable process status to snapshots and continue polling/subscribing after the launch RPC resolves. Ensure WebView work stays on its dispatcher and timeouts cannot leave a permanent “launching” UI state.
- Add native tests for argument quoting, redaction, lifecycle transitions and immediate nonzero exit, plus existing TypeScript/native test and cross-build checks.

## Required Windows acceptance tests remain outstanding

This workspace has no Windows game runtime or the user's existing 506 MB install. No actual process creation, Java stdout/stderr, vanilla/Fabric game initialization, main-menu confirmation, or normal-close detection has occurred here. The requested Windows 1.21.4 Vanilla and Fabric 0.16.10 main-menu tests remain required after implementation; compiling an installer will not satisfy them.

## Implemented after the baseline audit

The source changes now address the confirmed observability/lifecycle gaps without reinstalling or changing the managed game directory:

- Launch arguments are built with Windows CRT-compatible quoting for the executable and every argument. The secret token is substituted only into the live process command; the saved command line keeps the metadata placeholder.
- Before launch, the selected Java executable is inspected for its PE machine architecture and probed using `-version` with a ten-second bound. The reported major must match the metadata major (therefore Java 8/17/21 are selected/checked from the version metadata rather than hard-coded to one game version); this x64 client rejects non-x64 Java because its native libraries are x64.
- The game starts with stdout and stderr redirected to separate pipes, each drained by a background reader thread, capped at 4 MiB and token-redacted before saving. The WebView thread does not wait for game output.
- Each successful process creation writes `%APPDATA%\VesperaClient\logs\launches\launch-<timestamp>-<pid>.json` and sibling `.stdout.log` / `.stderr.log` files. The JSON records version/loader version, Java path and reported major, PE architecture, working directory, redacted full command and classpath, PID, native directory/DLL list, whether `latest.log` and actual crash-report files exist, stdout/stderr paths, and (after observed exit) the actual exit code/time plus a heuristic first-exception candidate. The rolling `launcher.log` also gets process-spawn and exit-code events.
- `CreateProcessW` now names the Java executable explicitly and returns/logs its Win32 error on failure. A process-handle query failure is logged as an unknown state and does not get misreported as a process exit.
- After the launch RPC returns, the UI continues refreshing native snapshots while the Java process is monitored. A detected exit is surfaced as a status toast. Success messaging now explicitly says only that Java started; it does not claim Minecraft reached its menu.

### Important limitations still present

- “Running” currently means that the Java process handle remains active. The launcher has no authoritative signal that Minecraft has reached the visible main menu. The user must visually confirm that acceptance criterion.
- Process liveness and exit reporting are refreshed when native snapshots are requested. The UI now polls continuously after Play, but if the launcher itself is closed before the game, it will not write the final exit code.
- `latest.log` and crash-report paths are recorded, not copied into the launch bundle. They are written by Minecraft when available.
- stdout and stderr are saved separately; their cross-stream ordering cannot be reconstructed. The first-exception field is a heuristic pointer only, not a root-cause verdict.
- Java compatibility has been validated by source/build and a parser check for Java 8/17/21 text forms, not by running Windows Java here.

## Follow-up: reported instant exit (logs not present in this checkout)

The user reports that v1.2.5 now shows the process-exited toast without a game window. I searched the repository workspace for `latest.log`, crash reports, `launch-*.json`, and `*.stdout-stderr.log`; none are present. The Windows `%APPDATA%` directory is not mounted into this Linux build workspace, so I cannot inspect the user's actual runtime, command, exit code, Minecraft log, or first exception. **No root cause is established, and no speculative command/classpath/native/graphics fix has been applied.**

For the next Windows run, this revision records separate Java stdout/stderr, the exact redacted classpath and command, metadata-selected Java details, native path and extracted DLL list, actual existence (rather than invented paths) of `latest.log` and crash report files, the process exit code in decimal and hex, and a heuristic exception candidate. It does not claim that an exception candidate is the root cause.

A source-only command audit also confirms that native `buildLaunchPreparation()` hand-assembles a limited game-argument list instead of applying the Mojang metadata `arguments.jvm` / `arguments.game` rule sets. The Node preview service includes `--versionType`; the native Windows path currently does not. The Fabric main class and library list are taken from the installation receipt when present, and the classpath is verified libraries followed by the client JAR with Windows `;` separators. This is a confirmed difference, **not evidence that it caused the observed exit**; I have not changed these arguments without the actual crash output.

Please provide these exact files from the failing Fabric 1.21.4 / Loader 0.16.10 run:

- `%APPDATA%\VesperaClient\logs\launches\launch-<timestamp>-<pid>.json`
- The matching `.stdout-stderr.log` sibling from the initial 1.2.5 build, or `.stdout.log` and `.stderr.log` if rerun using the updated diagnostic build
- `%APPDATA%\VesperaClient\logs\launcher.log` (especially `[NativeZip]` lines)
- The Fabric instance's `logs\latest.log` if it exists; otherwise confirm the diagnostic JSON says `latestLogExists: false`
- Any actual file under that instance's `crash-reports` directory; otherwise confirm `crashReportFiles` is empty
- `%APPDATA%\VesperaClient\versions\1.21.4\vespera-install-receipt-fabric.json`

The command line is token-redacted, but review all files before sharing and remove any account secrets. With those artifacts, the first failing stage and whether the cause is JVM, arguments/classpath, Fabric, natives, graphics, or another component can be determined.

## Reproducible Windows diagnostic and acceptance procedure

These steps use the existing installation/data directory and do not ask you to delete profiles, accounts, or game artifacts.

1. From this branch, run `npm ci` (if dependencies are absent) and `npm run build:windows`. Copy the generated `release/bin/VesperaClient.exe` to a distinct filename such as `VesperaClient-launch-diagnostic.exe`; run it side-by-side rather than uninstalling the existing client. The older `release/VesperaClient-1.2.4-win64-setup.exe` is historical and does not contain this patch.
2. In the diagnostic launcher, select **Minecraft 1.21.4 / Vanilla**, click Play once, and record whether a window appears and whether the visible main menu is reached. Do not mark process creation as a pass for this criterion.
3. If the menu appears, close Minecraft through its normal in-game Quit control. Wait for the launcher to report process exit. Repeat the same procedure with **Fabric Loader 0.16.10** selected.
4. For each run, preserve the matching `%APPDATA%\VesperaClient\logs\launches\launch-*.json`, sibling `*.stdout.log` and `*.stderr.log`, `%APPDATA%\VesperaClient\logs\launcher.log`, and any `latest.log` / crash-report files that actually exist. The JSON explicitly records when those Minecraft files are absent. Also include the installation receipt `versions\1.21.4\vespera-install-receipt-fabric.json` and native extraction lines from `launcher.log`. Do not post account tokens or unredacted command lines.
5. To independently check an active process in PowerShell while testing, run `Get-Process -Id <PID> -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime`; after normal Quit it should return no process, while the launch JSON and launcher log should record the actual exit code. Compare that result against the UI status.

Record per mode: `main menu reached (yes/no)`, `normal close detected (yes/no)`, PID, Java major/architecture, process exit code, diagnostic JSON path, output log path, Minecraft latest.log/crash-report result, and any observed stage/error. Do not include tokens in the report.

**Acceptance outcome in this environment:** Windows execution is unavailable. Windows 1.21.4 Vanilla and Fabric 0.16.10 visible-main-menu tests, plus normal-close detection, are **UNVERIFIED**. The Windows PE cross-build and automated tests are not substitutes for these acceptance checks.

## Follow-up: fresh exit-code report and capture-race audit

The user reports another attempt exits almost immediately with a reported code `-1`, with empty/no-useful diagnostics and no Minecraft `latest.log`. That report alone does not identify a Java/Minecraft cause. In this C++ source, process monitoring calls `GetExitCodeProcess()` into a Windows `DWORD`; a successful query records the returned DWORD in decimal and hex. `STILL_ACTIVE` (259) is treated as running, and query failure is logged as an unknown state rather than a process exit. There is no generic `-1` process-exit sentinel in this monitor. A displayed `-1` could be an actual `0xFFFFFFFF` exit status or a conversion/reporting issue elsewhere; the exact source of the user's display cannot be established without that attempt's JSON or machine-side UI trace.

This source review did establish two diagnostics defects and fixed them on this branch:

- Previously, launch JSON and stdout/stderr paths were initialized only after `CreateProcessW` succeeded, so failures while creating pipes or starting Java had no per-attempt JSON record. The code now writes a token-redacted pre-launch record before `CreateProcessW`; a direct process-creation failure updates it with the numeric `GetLastError()` immediately captured after the failed API call. Successful starts update that same attempt record with PID and result fields. The diagnostic filename uses a unique attempt ID rather than assuming a child PID exists before process creation.
- Previously, output reader threads were detached and the exit monitor immediately inspected output paths. Since the readers only wrote their capture files after reaching EOF, a fast process could be marked exited before those files were saved; the JSON then reported absent/empty captures and was never enriched again. Capture workers now signal completion only after closing/flushing their files. The exit path waits up to five seconds for each stream before inspecting the saved output and records whether capture completed or timed out. Empty output after a completed capture is therefore distinguishable from a capture still pending.

The native Windows argument builder remains a separate confirmed launch-engine gap: it manually assembles a limited list and does not evaluate Mojang `arguments.jvm` / `arguments.game`, feature flags, or version argument rules; the current native game args also omit `--versionType`. This is source evidence of incomplete metadata compliance, but without the matching crash output it is not proven to be the cause of this user's specific exit. No speculative argument change was made. Vanilla/Fabric launch behavior must be validated before attributing or fixing that user's failure.

### Verification after the diagnostic changes

- Linux x86_64 sandbox confirmed by `uname`; neither `wine` nor `wine64` is installed, and this environment has no Windows desktop/game runtime. The available Zig toolchain cross-compiled the x86_64 Windows PE release but cannot execute WebView2 or Minecraft.
- `npm run build:windows`: **PASS** (Windows x64 PE cross-build only; not runtime validation).
- Native `launchCommandHarness.cpp`, compiled for the Linux host using Zig, including quoting cases with spaces, embedded quotes, Unicode and shell metacharacters: **PASS** (string construction tests only; not a Windows process round-trip).
- `npm test`: **PASS** — 50 unit tests, 23 mod tests, release artifact/signature/hash verification. These do not prove process creation or a game launch.
- Java version/process tests, Windows argument round-trip, JVM initialization, actual Vanilla 1.21.4 launch, actual Fabric 1.21.4 / 0.16.10 launch, main-menu arrival and normal-close detection: **NOT TESTED** here.

The installer was regenerated at `release/VesperaClient-1.2.5-win64-setup.exe`; the launcher is `release/bin/VesperaClient.exe`. Do not use these build artifacts as evidence of runtime acceptance.
