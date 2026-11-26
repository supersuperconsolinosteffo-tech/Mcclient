package gg.vespera.client.mixin

import gg.vespera.client.VesperaClientMod
import org.spongepowered.asm.mixin.Mixin

@Mixin(targets = ["net.minecraft.client.gui.hud.InGameHud"])
class HudRenderCallbackMixin {
    fun vesperaAfterHudRender(tickDelta: Float) {
        VesperaClientMod.onRenderFrame(System.nanoTime(), 24, System.getProperty("vespera.client.mode", "balanced"))
    }
}

@Mixin(targets = ["net.minecraft.client.Mouse"])
class MouseClickMetricMixin {
    fun vesperaOnMouseButton(button: Int, action: Int) {
        if (action == 1) {
            val nowMs = System.currentTimeMillis()
            if (button == 0) VesperaClientMod.cpsTracker.registerLeftClick(nowMs)
            else if (button == 1) VesperaClientMod.cpsTracker.registerRightClick(nowMs)
        }
    }
}

@Mixin(targets = ["net.minecraft.client.render.GameRenderer"])
class CameraZoomFovMixin {
    fun vesperaModifyFov(baseFov: Double, deltaSec: Double): Double {
        return VesperaClientMod.zoomController.updateFrame(deltaSec, baseFov)
    }
}
