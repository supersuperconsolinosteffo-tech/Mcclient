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
- The game starts with stdout and stderr redirected to a combined pipe drained by a background reader thread, capped at 4 MiB and token-redacted before saving. The WebView thread does not wait for game output.
- Each successful process creation writes `%APPDATA%\VesperaClient\logs\launches\launch-<timestamp>-<pid>.json` and a sibling `.stdout-stderr.log`. The JSON records the version/loader, Java path, expected and reported major, PE architecture, version output, working directory, redacted full command line, PID, process creation result, output-log path, `latest.log` path, crash-report directory and (after observed exit) the actual process exit code/time. The rolling `launcher.log` also gets process-spawn and exit-code events.
- `CreateProcessW` now names the Java executable explicitly and returns/logs its Win32 error on failure. A process-handle query failure is logged as an unknown state and does not get misreported as a process exit.
- After the launch RPC returns, the UI continues refreshing native snapshots while the Java process is monitored. A detected exit is surfaced as a status toast. Success messaging now explicitly says only that Java started; it does not claim Minecraft reached its menu.

### Important limitations still present

- “Running” currently means that the Java process handle remains active. The launcher has no authoritative signal that Minecraft has reached the visible main menu. The user must visually confirm that acceptance criterion.
- Process liveness and exit reporting are refreshed when native snapshots are requested. The UI now polls continuously after Play, but if the launcher itself is closed before the game, it will not write the final exit code.
- `latest.log` and crash-report paths are recorded, not copied into the launch bundle. They are written by Minecraft when available.
- The saved output combines stdout and stderr. No stdout/stderr ordering distinction is available in this implementation.
- Java compatibility has been validated by source/build and a parser check for Java 8/17/21 text forms, not by running Windows Java here.

## Reproducible Windows diagnostic and acceptance procedure

These steps use the existing installation/data directory and do not ask you to delete profiles, accounts, or game artifacts.

1. From this branch, run `npm ci` (if dependencies are absent) and `npm run build:windows`. Copy the generated `release/bin/VesperaClient.exe` to a distinct filename such as `VesperaClient-launch-diagnostic.exe`; run it side-by-side rather than uninstalling the existing client. The older `release/VesperaClient-1.2.4-win64-setup.exe` is historical and does not contain this patch.
2. In the diagnostic launcher, select **Minecraft 1.21.4 / Vanilla**, click Play once, and record whether a window appears and whether the visible main menu is reached. Do not mark process creation as a pass for this criterion.
3. If the menu appears, close Minecraft through its normal in-game Quit control. Wait for the launcher to report process exit. Repeat the same procedure with **Fabric Loader 0.16.10** selected.
4. For each run, preserve the matching `%APPDATA%\VesperaClient\logs\launches\launch-*.json`, sibling `*.stdout-stderr.log`, `%APPDATA%\VesperaClient\logs\launcher.log`, and the `latest.log` / crash report paths named in the JSON. These contain the Java executable/version/architecture, redacted arguments, cwd, PID, output and observed exit code. Do not post account tokens or unredacted command lines.
5. To independently check an active process in PowerShell while testing, run `Get-Process -Id <PID> -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime`; after normal Quit it should return no process, while the launch JSON and launcher log should record the actual exit code. Compare that result against the UI status.

Record per mode: `main menu reached (yes/no)`, `normal close detected (yes/no)`, PID, Java major/architecture, process exit code, diagnostic JSON path, output log path, Minecraft latest.log/crash-report result, and any observed stage/error. Do not include tokens in the report.

**Acceptance outcome in this environment:** Windows execution is unavailable. Windows 1.21.4 Vanilla and Fabric 0.16.10 visible-main-menu tests, plus normal-close detection, are **UNVERIFIED**. The Windows PE cross-build and automated tests are not substitutes for these acceptance checks.
