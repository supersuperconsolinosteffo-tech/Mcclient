package gg.vespera.client

import gg.vespera.client.core.CpsRingTracker
import gg.vespera.client.core.FrameTimeAnalyzer
import gg.vespera.client.core.ServerTpsEstimator
import gg.vespera.client.features.ChatCompactProcessor
import gg.vespera.client.features.ToggleSprintController
import gg.vespera.client.features.TooltipEnhancer
import gg.vespera.client.features.ZoomController
import gg.vespera.client.hud.HudColorCodec
import gg.vespera.client.hud.HudEditorSolver
import gg.vespera.client.hud.HudFormatters
import gg.vespera.client.sync.LauncherSyncBridge
import java.nio.file.Files
import kotlin.math.abs

object VesperaModTestSuite {
    private var passed = 0
    private var failed = 0

    private fun check(name: String, condition: Boolean, detail: String = "") {
        if (condition) {
            passed++
            println("  [PASS] $name")
        } else {
            failed++
            System.err.println("  [FAIL] $name -> $detail")
        }
    }

    @JvmStatic
    fun main(args: Array<String>) {
        println("=== Vespera Client Fabric Mod (JVM 21) Unit Test Suite ===")

        // 1. FrameTimeAnalyzer: 99 frames at 4ms (250 FPS) + 1 slow spike at 20ms (50 FPS)
        val analyzer = FrameTimeAnalyzer(200)
        repeat(99) { analyzer.recordFrameDurationNs(4_000_000L) }
        analyzer.recordFrameDurationNs(20_000_000L)
        val stats = analyzer.snapshot()
        check("FrameTimeAnalyzer sample count = 100", stats.sampleCount == 100, "got ${stats.sampleCount}")
        check("FrameTimeAnalyzer 1% low detects 50 FPS tail spike", abs(stats.onePercentLowFps - 50.0) < 0.5, "got ${stats.onePercentLowFps}")
        check("FrameTimeAnalyzer avg FPS ~ 240.38", stats.avgFps in 238.0..242.0, "got ${stats.avgFps}")

        // 2. CpsRingTracker: sliding 1,000 ms window & peak tracking
        val cps = CpsRingTracker()
        for (i in 0 until 12) cps.registerLeftClick(1_000L + i * 50L)
        cps.registerRightClick(1_200L)
        cps.registerRightClick(1_400L)
        check("CpsRingTracker counts 12 LMB clicks within 1s window", cps.getLeftCps(1_600L) == 12)
        check("CpsRingTracker expires clicks older than 1000ms", cps.getLeftCps(2_250L) == 6, "got ${cps.getLeftCps(2_250L)}")
        check("CpsRingTracker preserves session peak CPS = 12", cps.peakLeftCps == 12)
        check("CpsRingTracker tracks RMB independently", cps.getRightCps(1_500L) == 2)

        // 3. ServerTpsEstimator
        val tps = ServerTpsEstimator()
        tps.onWorldTimeUpdate(1000L, 10_000L)
        tps.onWorldTimeUpdate(1015L, 11_000L) // 15 ticks in 1 second -> degraded server TPS
        check("ServerTpsEstimator smooths toward 15 TPS", tps.estimatedTps in 18.0..19.0, "got ${tps.estimatedTps}")

        // 4. HudEditorSolver magnetic center snap & bounds clamping
        val snap = HudEditorSolver.computeSnappedPosition(
            rawXpx = 883, // center for 150px wide widget on 1920px screen is (1920-150)/2 = 885
            rawYpx = -40, // out-of-bounds top
            widgetWidthPx = 150,
            widgetHeightPx = 40,
            screenWidth = 1920,
            screenHeight = 1080,
            snapThresholdPx = 6
        )
        check("HudEditorSolver snaps vertically to screen center within 6px", snap.snappedVerticalGuide)
        check("HudEditorSolver clamps negative Y to 0.0%", snap.yPercent == 0.0)

        // 5. HudColorCodec & HudFormatters
        val argb = HudColorCodec.hexToArgb("#F59E0B", 1.0)
        check("HudColorCodec encodes opaque #F59E0B to 0xFFF59E0B", argb == 0xFFF59E0B.toInt())
        val coords = HudFormatters.formatCoordinates(800.0, 64.0, -160.0, inNether = false, includePortalCounterpart = true)
        check("HudFormatters computes Nether /8 portal coordinates", coords[2].contains("100") && coords[2].contains("-20"), coords.toString())
        val (cardinal, deg) = HudFormatters.formatCompassHeading(180f)
        check("HudFormatters maps Minecraft yaw 180 to North (0 deg)", cardinal == "N" && deg == 0, "$cardinal $deg")

        // 6. ZoomController smooth FOV & proportional sensitivity scaling
        val zoom = ZoomController(defaultZoomFactor = 4.0)
        zoom.setZoomActive(true)
        var fov = 90.0
        repeat(20) { fov = zoom.updateFrame(0.016, 90.0) }
        check("ZoomController converges smoothly toward 90/4 = 22.5 deg FOV", fov in 22.4..24.0, "got $fov")
        zoom.onMouseScrollWhileZoomed(1.0)
        check("ZoomController scroll increases target magnification", zoom.targetZoomFactor > 4.0)
        check("ZoomController reduces mouse sensitivity proportionally while zoomed", zoom.effectiveMouseSensitivityScale() < 0.30)

        // 7. ToggleSprintController fair-play compliance
        val sprint = ToggleSprintController()
        check(
            "ToggleSprint allows forward sprint with sufficient hunger",
            sprint.shouldApplyVanillaSprint(1.0f, foodLevel = 20, allowFlyingOrCreative = false, isSneaking = false, isUsingSlowdownItem = false, hasBlindness = false, horizontalCollision = false)
        )
        check(
            "ToggleSprint blocks sprint when foodLevel <= 6 (vanilla rule)",
            !sprint.shouldApplyVanillaSprint(1.0f, foodLevel = 6, allowFlyingOrCreative = false, isSneaking = false, isUsingSlowdownItem = false, hasBlindness = false, horizontalCollision = false)
        )
        check(
            "ToggleSprint never omni-sprints backward (anticheat safe)",
            !sprint.shouldApplyVanillaSprint(-1.0f, foodLevel = 20, allowFlyingOrCreative = true, isSneaking = false, isUsingSlowdownItem = false, hasBlindness = false, horizontalCollision = false)
        )

        // 8. ChatCompactProcessor & TooltipEnhancer
        val chat = ChatCompactProcessor()
        chat.submitIncomingMessage("Welcome to server!", "12:00:01")
        val stacked = chat.submitIncomingMessage("Welcome to server!", "12:00:02")
        check("ChatCompactProcessor stacks duplicate messages as [x2]", stacked.repeatCount == 2 && stacked.formattedLine.endsWith("[x2]"))
        val tip = TooltipEnhancer.buildItemTelemetryLines(currentDamage = 561, maxDamage = 1561, anvilRepairCost = 31, nutritionPoints = 8, saturationModifier = 0.8f)
        check("TooltipEnhancer formats durability, anvil cap warning, and food saturation", tip.size == 3 && tip[1].contains("Near Anvil Cap"))

        // 9. LauncherSyncBridge atomic IPC write & mtime poll debounce
        val tempIpc = Files.createTempDirectory("vespera-ipc-test")
        val bridge = LauncherSyncBridge(tempIpc)
        bridge.publishTelemetryAtomic(
            LauncherSyncBridge.InGameTelemetryPayload(
                fps = 412.5,
                avgFrameTimeMs = 2.42,
                onePercentLowFps = 289.0,
                heapUsedMb = 1420,
                heapAllocatedMb = 4096,
                serverPingMs = 19,
                mcVersion = "1.21.4",
                activeModsCount = 15,
                activeProfileName = "Vespera Balanced"
            )
        )
        val written = Files.readString(bridge.telemetryPath)
        check("LauncherSyncBridge writes atomic telemetry JSON", written.contains("\"fps\": 412.5") && written.contains("\"onePercentLowFps\": 289.0"))
        Files.writeString(bridge.hudProfilePath, "{\"id\":\"hud-competitive-pvp\"}")
        val firstPoll = bridge.pollUpdatedHudProfileIfChanged(10_000L)
        val debouncedPoll = bridge.pollUpdatedHudProfileIfChanged(10_500L) // < 2000ms debounce
        check("LauncherSyncBridge loads updated HUD profile and debounces rapid polls", firstPoll != null && debouncedPoll == null)

        println("=== Summary: $passed passed, $failed failed ===")
        if (failed > 0) {
            kotlin.system.exitProcess(1)
        }
    }
}
