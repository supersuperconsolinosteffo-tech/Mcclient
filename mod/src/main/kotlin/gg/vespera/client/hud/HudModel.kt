package gg.vespera.client.hud

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.roundToInt

enum class HudWidgetId {
    FPS,
    CPS,
    KEYSTROKES,
    PING,
    ARMOR_STATUS,
    POTION_EFFECTS,
    COORDINATES,
    DIRECTION_COMPASS,
    SPEEDOMETER,
    TOGGLE_SPRINT,
    CUSTOM_CROSSHAIR,
    SERVER_INFO,
    MEMORY_HUD,
    PACK_BADGE
}

data class HudWidgetSpec(
    val id: HudWidgetId,
    val title: String,
    var enabled: Boolean,
    var xPercent: Double,
    var yPercent: Double,
    var baseWidth: Int,
    var baseHeight: Int,
    var scale: Double = 1.0,
    var fgHex: String = "#F8FAFC",
    var bgHex: String = "#0B0D11",
    var accentHex: String = "#F59E0B",
    var bgOpacity: Double = 0.72,
    var showBorder: Boolean = true,
    var showShadow: Boolean = true
) {
    fun pixelX(screenWidth: Int): Int = ((xPercent.coerceIn(0.0, 100.0) / 100.0) * screenWidth).roundToInt()
    fun pixelY(screenHeight: Int): Int = ((yPercent.coerceIn(0.0, 100.0) / 100.0) * screenHeight).roundToInt()
    fun scaledWidth(): Int = (baseWidth * scale.coerceIn(0.5, 2.5)).roundToInt()
    fun scaledHeight(): Int = (baseHeight * scale.coerceIn(0.5, 2.5)).roundToInt()

    fun containsPoint(mx: Int, my: Int, screenWidth: Int, screenHeight: Int): Boolean {
        val x = pixelX(screenWidth)
        val y = pixelY(screenHeight)
        return mx >= x && mx <= x + scaledWidth() && my >= y && my <= y + scaledHeight()
    }
}

object HudColorCodec {
    fun hexToArgb(hex: String, opacity: Double = 1.0): Int {
        val clean = hex.trim().removePrefix("#")
        val rgb = clean.toLongOrNull(16)?.toInt() ?: 0xFFFFFF
        val alpha = ((opacity.coerceIn(0.0, 1.0)) * 255.0).roundToInt() and 0xFF
        return (alpha shl 24) or (rgb and 0x00FFFFFF)
    }
}

data class SnapResult(
    val xPercent: Double,
    val yPercent: Double,
    val snappedVerticalGuide: Boolean,
    val snappedHorizontalGuide: Boolean
)

/**
 * Interactive HUD Editor Layout & Magnetic Snap Engine.
 * Supports pixel-accurate dragging, viewport boundary clamping, center-line magnetic snap,
 * and 1% grid snapping when Shift is held.
 */
object HudEditorSolver {
    fun computeSnappedPosition(
        rawXpx: Int,
        rawYpx: Int,
        widgetWidthPx: Int,
        widgetHeightPx: Int,
        screenWidth: Int,
        screenHeight: Int,
        snapThresholdPx: Int = 6,
        gridSnapActive: Boolean = false
    ): SnapResult {
        if (screenWidth <= 0 || screenHeight <= 0) {
            return SnapResult(0.0, 0.0, false, false)
        }

        val maxX = (screenWidth - widgetWidthPx).coerceAtLeast(0)
        val maxY = (screenHeight - widgetHeightPx).coerceAtLeast(0)
        var clampedX = rawXpx.coerceIn(0, maxX)
        var clampedY = rawYpx.coerceIn(0, maxY)

        val centerTargetX = (screenWidth - widgetWidthPx) / 2
        val centerTargetY = (screenHeight - widgetHeightPx) / 2

        var snapV = false
        var snapH = false

        if (abs(clampedX - centerTargetX) <= snapThresholdPx) {
            clampedX = centerTargetX
            snapV = true
        }
        if (abs(clampedY - centerTargetY) <= snapThresholdPx) {
            clampedY = centerTargetY
            snapH = true
        }

        var xPct = (clampedX.toDouble() / screenWidth.toDouble()) * 100.0
        var yPct = (clampedY.toDouble() / screenHeight.toDouble()) * 100.0

        if (gridSnapActive && !snapV) {
            xPct = (xPct * 2.0).roundToInt() / 2.0
        }
        if (gridSnapActive && !snapH) {
            yPct = (yPct * 2.0).roundToInt() / 2.0
        }

        return SnapResult(
            xPercent = xPct.coerceIn(0.0, 98.0),
            yPercent = yPct.coerceIn(0.0, 98.0),
            snappedVerticalGuide = snapV,
            snappedHorizontalGuide = snapH
        )
    }
}

/**
 * Pure presentation formatters for Vespera's built-in HUD modules.
 */
object HudFormatters {
    fun formatCoordinates(
        x: Double,
        y: Double,
        z: Double,
        inNether: Boolean,
        includePortalCounterpart: Boolean
    ): List<String> {
        val primary = String.format("XYZ: %.1f / %.1f / %.1f", x, y, z)
        val chunk = "Chunk: ${floor(x).toInt() shr 4}, ${floor(z).toInt() shr 4}"
        if (!includePortalCounterpart) return listOf(primary, chunk)

        val counterpart = if (inNether) {
            String.format("Overworld: %.0f / %.0f", x * 8.0, z * 8.0)
        } else {
            String.format("Nether: %.0f / %.0f", x / 8.0, z / 8.0)
        }
        return listOf(primary, chunk, counterpart)
    }

    fun formatCompassHeading(yawDegrees: Float): Pair<String, Int> {
        var normalized = ((yawDegrees % 360f) + 360f) % 360f
        // Minecraft yaw 0 = South (+Z), 90 = West (-X), 180 = North (-Z), 270 = East (+X)
        val compassBearing = ((normalized + 180f) % 360f)
        val cardinals = arrayOf("N", "NE", "E", "SE", "S", "SW", "W", "NW")
        val idx = (((compassBearing + 22.5f) % 360f) / 45f).toInt().coerceIn(0, 7)
        return cardinals[idx] to compassBearing.roundToInt()
    }

    fun computeHorizontalSpeedBps(dxPerTick: Double, dzPerTick: Double): Double {
        return hypot(dxPerTick, dzPerTick) * 20.0
    }

    fun formatArmorDurabilityPercent(currentDamage: Int, maxDamage: Int): Int {
        if (maxDamage <= 0) return 100
        val remaining = (maxDamage - currentDamage).coerceIn(0, maxDamage)
        return ((remaining.toDouble() / maxDamage.toDouble()) * 100.0).roundToInt()
    }

    fun formatPotionDuration(ticksRemaining: Int): String {
        val totalSeconds = (ticksRemaining.coerceAtLeast(0)) / 20
        val mins = totalSeconds / 60
        val secs = totalSeconds % 60
        return String.format("%d:%02d", mins, secs)
    }
}
