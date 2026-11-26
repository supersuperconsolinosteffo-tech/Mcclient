# Vespera Client v1.2.4 — Native Library Extraction Root-Cause Audit

**Audit performed before code changes.** Baseline: commit `a6e6d9f` (`Repair native installation engine for v1.2.3`) on `arena/f96b150b-mcclient`. Working tree was clean at the start. The audit findings below were written before implementation and remain the forensic boundary for the reported failure.

## Incident evidence available

The user reports this failure on their Windows machine:

`C:\Users\ciaoa\AppData\Roaming\VesperaClient\minecraft\libraries\org/lwjgl/lwjgl-jemalloc/3.3.3/lwjgl-jemalloc-3.3.3-natives-windows-x86.jar`  
`tar.exe exit code 1`

That `%APPDATA%` directory and JAR are not present in this checkout or attached to the workspace. This environment cannot inspect that machine's file, compute its hash/size, inspect its ZIP directory, retrieve the exact metadata response, execute Windows `tar.exe`, or capture its stderr. The v1.2.3 native process code did not redirect/capture tar stdout or stderr. Therefore the report's exact archive validity, upstream hash match, and tar diagnostic remain **unknown**, not inferred from the filename or exit code.

## Confirmed source-level cause

The native installer used a tar program as the primary extractor for downloaded JAR/ZIP native archives. For each planned `nativeJars` entry it built this command:

`tar.exe -xf "<native JAR path>" -C "<versions/<mcVersion>/natives>"`

It started the process with `CreateProcessW(..., CREATE_NO_WINDOW, ...)`, waited up to 30 seconds, and checked the exit code. It did not capture stdout/stderr, identify the archive entry that failed, or validate extracted native files. Mojang's per-library `extract.exclude` rules were also not passed into this native extraction path. The shared destination was `versions/<mcVersion>/natives`, not isolated by loader.

This establishes an **extraction-engine and diagnostics design defect**. It does not establish why this particular JAR made this particular `tar.exe` return 1: that could only be determined from the artifact and tar diagnostics.

## Archive and classifier findings

- `is_valid_jar_archive` verifies a ZIP end-of-central-directory record and central-directory shape (and selected required entries for certain Fabric JARs), but it does not decompress every entry or verify each ZIP CRC. A structurally parseable archive can therefore still fail during extraction.
- The native error path is a Maven classifier-suffixed artifact path. In this code, an explicit `downloads.artifact.path` is taken from Mojang metadata; a separate `natives.windows` template substitutes `${arch}` with `64`. The reported `-x86.jar` suffix alone does not reveal which metadata field produced it.
- A Mojang-derived 1.21.4 metadata mirror is now available for forensic comparison: [`net.minecraft/1.21.4.json`](https://raw.githubusercontent.com/pine-pw/meta/main/v1/net.minecraft/1.21.4.json) links `org.lwjgl3` version `3.3.3`, and the corresponding [`org.lwjgl3/3.3.3.json`](https://raw.githubusercontent.com/pine-pw/meta/main/v1/org.lwjgl3/3.3.3.json) publishes the Windows classifiers. This is a generated component mirror, not the exact JSON response/cache used by the user's failed install.
- In that generated component metadata, `lwjgl-jemalloc` Windows x86 is declared as size **148,612 bytes**, SHA-1 `f6063b6e0f23be483c5c88d84ce51b39dc69126c`, URL `https://libraries.minecraft.net/org/lwjgl/lwjgl-jemalloc/3.3.3/lwjgl-jemalloc-3.3.3-natives-windows-x86.jar`, with an OS-only `allow windows` rule and no `os.arch` restriction. The plain `natives-windows` (x64) entry is declared size **180,344 bytes**, SHA-1 `426222fc027602a5f21b9c0fe79cde6a4c7a011f`. Direct official Maven `.sha1` sidecar fetches matched both declared SHA-1 values. Thus `natives-windows-x86` is a real, plausibly sized, checksum-published 32-bit artifact—not intrinsically corrupt—but it is not the matching classifier for this project's x86_64 launcher/Java target.
- The old native rule evaluator accepted any library whose only OS rule was `windows`; it did not match classifier architecture. Therefore a Windows-only x86 (and ARM64) classifier record can be included in the x64 install plan when the resolved metadata enumerates platform classifiers as separate library entries. This is a confirmed classifier-selection defect and explains why an x86 JAR can appear in a Windows x64 install without treating its filename as evidence of corruption. The user's path alone still does not prove that the local bytes matched the official SHA-1/size or which exact metadata object planned it.
- The native rule evaluator targets Windows and excludes an explicit `os.arch == "x86"`; the new resolver additionally filters explicit classifier suffixes (`x86`, `arm64`, etc.) against the compiled target. This project currently builds a Windows x86_64 launcher; it is not an ARM64 or cross-OS native launcher.
- The TypeScript/server implementation has a separate ZIP/JAR parser based on Node zlib. It is not the native WebView Windows extraction implementation and is not copied as-is.

## Exact root-cause status

1. **Why the launch failed:** the native installer aborted when the external tar process returned non-zero; confirmed from source.
2. **Why tar returned 1:** unknown from available evidence. No stderr was captured, and the exact file/metadata is on the user's machine, not in the workspace.
3. **Whether the JAR is valid/corrupt/truncated:** unknown until the exact file is supplied or inspected on that Windows installation.
4. **Whether `natives-windows-x86` is correct for this product:** it is a valid upstream 32-bit classifier, but it is not the matching native for this x86_64 launcher/Java target. The selected metadata object from the user's failed attempt remains unavailable; the generated 1.21.4 component metadata shows why the old OS-only rule logic could select it.
5. **Why `tar.exe` was used:** it was chosen as an available system extractor for both downloaded Java archives and native libraries, but it is not an appropriate, sufficiently observable ZIP/JAR extraction subsystem for Minecraft native libraries.

## Implemented v1.2.4 repair

- Native Minecraft JAR extraction now uses the bundled miniz ZIP/DEFLATE/CRC implementation; it does not shell out to `tar.exe`. `tar.exe` remains in the separate Temurin Java ZIP provisioning path and was not replaced by this native-library change.
- The extractor checks EOCD/central-directory bounds and counts, local/central-header agreement, supported compression (stored/deflate), data bounds, uncompressed-size safety limits, decompressed lengths and CRC-32. It rejects ZIP64/multi-disk, encrypted or unsupported native entries with a contextual error. Native file outputs are restricted to `.dll`, safely path-checked, flattened to the Windows library-path root, and collisions (including ASCII case-insensitive names) are rejected unless content is identical.
- Mojang `extract.exclude` prefixes are honored. Downloaded JARs are inputs only; upstream SHA-1 and declared size checks remain in the existing artifact download path. When SHA-1 is absent, size/ZIP structure/selected DLL CRC validation still apply; no checksum is fabricated.
- Native output is staged, then swapped into a loader-isolated `natives-<loader>` directory. A previous native folder is retained until a loader-specific verified receipt is committed; startup recovery can restore an old folder if replacement was interrupted. Receipts record hashes of extracted DLLs, and installation status checks those hashes before reporting ready.
- Launch arguments continue to point `-Djava.library.path` at the selected loader's native directory. A missing/invalid receipt or native DLL hash causes the selected profile to be reinstalled/revalidated before game launch; failed preparation does not report a successful game launch.
- Vendored dependency: miniz 3.0.2, upstream commit `293d4db1b7d0ffee9756d035b9ac6f7431ef8492`, MIT license. Provenance is in `native/third_party/miniz/UPSTREAM.md`.

## Automated verification performed in this workspace

- Native ZIP/classifier regression suite: **6 tests passed** covering stored and deflated DLLs, nested/UTF-8 names, exclusions, CRC mismatch, truncated/missing archives, traversal, exact and case-insensitive duplicate conflicts, repeat extraction, x64/x86/ARM64 classifier matching, merging multiple archive/classifier fixtures, and preservation of existing output after an interrupted/invalid archive.
- Full `npm test`: **50 Vitest tests passed**, **23 Kotlin/JVM mod tests passed**, and the release artifact verifier passed.
- `npm run build:windows`: cross-compiled the x86_64 Windows launcher, uninstaller and v1.2.4 setup installer. PE64 GUI headers/resources and SHA-256 release manifest passed automated verification. This is a cross-build, not Windows execution.
- The user's local archive's actual size, SHA-1, ZIP validity, and original tar stderr remain unknown because that file/log were unavailable. We did independently confirm the official Maven SHA-1 sidecars match the expected x86 and plain Windows native hashes published in the generated 1.21.4 component metadata; that validates the expected upstream hashes, not the user's cached bytes. No exact 1.21.4 metadata response from the failed attempt was captured.

## Required live-test limitation

No real Windows installation or Minecraft game process was executed in this environment. The requested Windows tests for Minecraft 1.21.4 Vanilla, 1.21.4 Fabric 0.16.10, another modern release, and a historical release **reaching the main menu remain outstanding**. Likewise, Java selection/architecture and actual Windows stdout/stderr/process behavior have only source/build-level coverage here. Compilation and synthetic tests do not prove a game launch.
