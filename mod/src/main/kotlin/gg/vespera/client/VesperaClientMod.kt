package gg.vespera.client

import gg.vespera.client.core.CpsRingTracker
import gg.vespera.client.core.FrameTimeAnalyzer
import gg.vespera.client.core.ServerTpsEstimator
import gg.vespera.client.features.ChatCompactProcessor
import gg.vespera.client.features.ToggleSprintController
import gg.vespera.client.features.ZoomController
import gg.vespera.client.hud.HudWidgetId
import gg.vespera.client.hud.HudWidgetSpec
import gg.vespera.client.sync.LauncherSyncBridge
import net.fabricmc.api.ClientModInitializer
import net.fabricmc.api.EnvType
import net.fabricmc.api.Environment
import java.nio.file.Paths

@Environment(EnvType.CLIENT)
object VesperaClientMod : ClientModInitializer {
    const val MOD_ID = "vespera-client"
    const val MOD_VERSION = "1.2.2+mc1.21.4"

    val frameAnalyzer = FrameTimeAnalyzer(600)
    val cpsTracker = CpsRingTracker(256, 1_000L)
    val serverTpsEstimator = ServerTpsEstimator()
    val zoomController = ZoomController()
    val toggleSprint = ToggleSprintController()
    val chatProcessor = ChatCompactProcessor(300)

    val widgets: MutableList<HudWidgetSpec> = mutableListOf(
        HudWidgetSpec(HudWidgetId.FPS, "FPS & 1% Low", true, 2.0, 2.5, 148, 34),
        HudWidgetSpec(HudWidgetId.CPS, "CPS Counter", true, 2.0, 8.5, 132, 32),
        HudWidgetSpec(HudWidgetId.PING, "Ping Display", true, 2.0, 14.2, 118, 32),
        HudWidgetSpec(HudWidgetId.COORDINATES, "Coordinates", true, 2.0, 20.0, 184, 58),
        HudWidgetSpec(HudWidgetId.TOGGLE_SPRINT, "Toggle Sprint", true, 2.0, 30.5, 152, 28),
        HudWidgetSpec(HudWidgetId.KEYSTROKES, "Keystrokes", true, 2.0, 64.0, 156, 162),
        HudWidgetSpec(HudWidgetId.DIRECTION_COMPASS, "Direction Compass", true, 38.0, 2.2, 240, 30),
        HudWidgetSpec(HudWidgetId.CUSTOM_CROSSHAIR, "Precision Crosshair", true, 48.8, 48.2, 28, 28),
        HudWidgetSpec(HudWidgetId.POTION_EFFECTS, "Potion Timers", true, 83.0, 24.0, 156, 112),
        HudWidgetSpec(HudWidgetId.ARMOR_STATUS, "Armor Status", true, 84.0, 68.0, 142, 124),
        HudWidgetSpec(HudWidgetId.SPEEDOMETER, "Speedometer", false, 2.0, 35.5, 128, 28),
        HudWidgetSpec(HudWidgetId.SERVER_INFO, "Server TPS", false, 82.0, 2.5, 164, 34),
        HudWidgetSpec(HudWidgetId.MEMORY_HUD, "JVM Memory", false, 82.0, 8.5, 164, 34),
        HudWidgetSpec(HudWidgetId.PACK_BADGE, "Resource Pack", false, 82.0, 14.5, 164, 32)
    )

    lateinit var syncBridge: LauncherSyncBridge
        private set

    override fun onInitializeClient() {
        val appData = System.getenv("APPDATA") ?: System.getProperty("user.home")
        val configuredIpc = System.getProperty("vespera.ipc.dir")
            ?: Paths.get(appData, "VesperaClient", "ipc").toString()
        syncBridge = LauncherSyncBridge(Paths.get(configuredIpc))
        println("[VesperaClient] Initialized $MOD_ID v$MOD_VERSION (IPC=${syncBridge.hudProfilePath.parent})")
    }

    fun onRenderFrame(nowNs: Long, serverPingMs: Int, activeProfileName: String) {
        frameAnalyzer.recordFrameTimestamp(nowNs)
        syncBridge.pollUpdatedHudProfileIfChanged(System.currentTimeMillis())
    }
}
