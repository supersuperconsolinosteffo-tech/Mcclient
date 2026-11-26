package gg.vespera.client.sync

import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.time.Instant

/**
 * Decoupled local filesystem IPC bridge between Vespera Desktop Launcher and the in-game Fabric mod.
 *
 * Design guarantees:
 * - Never blocks the Minecraft render thread: checks mtime at most once every 2,000 ms.
 * - Uses atomic write-temp-then-rename so neither side ever reads a torn JSON file.
 * - Zero direct coupling between Minecraft classes and the Windows WebView2 UI.
 */
class LauncherSyncBridge(private val ipcDirectory: Path) {
    private var lastHudProfileMtimeMs: Long = -1L
    private var lastPollEpochMs: Long = 0L

    val telemetryPath: Path = ipcDirectory.resolve("telemetry.json")
    val hudProfilePath: Path = ipcDirectory.resolve("hud-profile.json")
    val performancePresetPath: Path = ipcDirectory.resolve("performance-preset.json")

    init {
        Files.createDirectories(ipcDirectory)
    }

    data class InGameTelemetryPayload(
        val fps: Double,
        val avgFrameTimeMs: Double,
        val onePercentLowFps: Double,
        val heapUsedMb: Long,
        val heapAllocatedMb: Long,
        val serverPingMs: Int,
        val mcVersion: String,
        val activeModsCount: Int,
        val activeProfileName: String
    )

    fun publishTelemetryAtomic(payload: InGameTelemetryPayload) {
        Files.createDirectories(ipcDirectory)
        val tmpPath = ipcDirectory.resolve("telemetry.json.tmp")
        val json = buildString(384) {
            append("{\n")
            append("  \"updatedAt\": \"").append(Instant.now().toString()).append("\",\n")
            append("  \"measured\": true,\n")
            append("  \"fps\": ").append(String.format("%.1f", payload.fps)).append(",\n")
            append("  \"avgFrameTimeMs\": ").append(String.format("%.3f", payload.avgFrameTimeMs)).append(",\n")
            append("  \"onePercentLowFps\": ").append(String.format("%.1f", payload.onePercentLowFps)).append(",\n")
            append("  \"jvmHeapUsedMb\": ").append(payload.heapUsedMb).append(",\n")
            append("  \"jvmHeapAllocatedMb\": ").append(payload.heapAllocatedMb).append(",\n")
            append("  \"serverPingMs\": ").append(payload.serverPingMs).append(",\n")
            append("  \"mcVersion\": \"").append(escapeJson(payload.mcVersion)).append("\",\n")
            append("  \"activeModsCount\": ").append(payload.activeModsCount).append(",\n")
            append("  \"activeProfileName\": \"").append(escapeJson(payload.activeProfileName)).append("\"\n")
            append("}\n")
        }
        Files.writeString(tmpPath, json, StandardCharsets.UTF_8)
        Files.move(tmpPath, telemetryPath, StandardCopyOption.REPLACE_EXISTING)
    }

    fun pollUpdatedHudProfileIfChanged(nowEpochMs: Long, minPollIntervalMs: Long = 2_000L): String? {
        if (nowEpochMs - lastPollEpochMs < minPollIntervalMs) return null
        lastPollEpochMs = nowEpochMs
        if (!Files.exists(hudProfilePath)) return null
        val mtime = Files.getLastModifiedTime(hudProfilePath).toMillis()
        if (mtime <= lastHudProfileMtimeMs) return null
        lastHudProfileMtimeMs = mtime
        return Files.readString(hudProfilePath, StandardCharsets.UTF_8)
    }

    private fun escapeJson(raw: String): String {
        return raw.replace("\\", "\\\\").replace("\"", "\\\"")
    }
}
