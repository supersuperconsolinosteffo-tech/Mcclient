package gg.vespera.client.features

import kotlin.math.exp

/**
 * Smooth frame-rate-independent cinematic Zoom controller.
 * Scales mouse sensitivity proportionally to active FOV ratio so fine aiming never feels jerky.
 */
class ZoomController(
    var defaultZoomFactor: Double = 4.0,
    var minZoomFactor: Double = 1.5,
    var maxZoomFactor: Double = 20.0,
    var smoothingSpeed: Double = 16.0
) {
    var zoomKeyHeld: Boolean = false
        private set
    var targetZoomFactor: Double = defaultZoomFactor
        private set
    var currentInterpolatedFactor: Double = 1.0
        private set

    fun setZoomActive(active: Boolean) {
        if (active && !zoomKeyHeld) {
            targetZoomFactor = defaultZoomFactor
        }
        zoomKeyHeld = active
    }

    fun onMouseScrollWhileZoomed(scrollDelta: Double): Boolean {
        if (!zoomKeyHeld) return false
        val step = if (scrollDelta > 0) 1.18 else (1.0 / 1.18)
        targetZoomFactor = (targetZoomFactor * step).coerceIn(minZoomFactor, maxZoomFactor)
        return true
    }

    fun updateFrame(deltaTimeSeconds: Double, baseFovDegrees: Double): Double {
        val goal = if (zoomKeyHeld) targetZoomFactor else 1.0
        val alpha = 1.0 - exp(-smoothingSpeed * deltaTimeSeconds.coerceIn(0.0, 0.25))
        currentInterpolatedFactor += (goal - currentInterpolatedFactor) * alpha
        if (!zoomKeyHeld && currentInterpolatedFactor < 1.005) {
            currentInterpolatedFactor = 1.0
        }
        return (baseFovDegrees / currentInterpolatedFactor).coerceIn(3.0, 130.0)
    }

    fun effectiveMouseSensitivityScale(): Double {
        return (1.0 / currentInterpolatedFactor).coerceIn(0.05, 1.0)
    }
}

/**
 * Fair-play Toggle Sprint controller.
 * Enforces vanilla sprinting legality rules (forward movement > 0, foodLevel > 6 or creative,
 * not sneaking, not using shield/bow/food item, not blinded) so it never triggers anticheats.
 */
class ToggleSprintController {
    var sprintToggledOn: Boolean = true

    fun toggle(): Boolean {
        sprintToggledOn = !sprintToggledOn
        return sprintToggledOn
    }

    fun shouldApplyVanillaSprint(
        forwardImpulse: Float,
        foodLevel: Int,
        allowFlyingOrCreative: Boolean,
        isSneaking: Boolean,
        isUsingSlowdownItem: Boolean,
        hasBlindness: Boolean,
        horizontalCollision: Boolean
    ): Boolean {
        if (!sprintToggledOn) return false
        if (forwardImpulse <= 0.01f) return false
        if (isSneaking || isUsingSlowdownItem || hasBlindness || horizontalCollision) return false
        if (!allowFlyingOrCreative && foodLevel <= 6) return false
        return true
    }

    fun statusBadgeText(manuallyHoldingSprint: Boolean, isSneaking: Boolean): String {
        return when {
            isSneaking -> "[Sneaking (Held)]"
            manuallyHoldingSprint -> "[Sprinting (Key Held)]"
            sprintToggledOn -> "[Sprinting (Toggled)]"
            else -> "[Sprint: Vanilla]"
        }
    }
}

/**
 * Compact duplicate chat message stacker with optional HH:mm:ss timestamps.
 */
class ChatCompactProcessor(private val maxHistoryEntries: Int = 250) {
    data class ChatEntry(val baseMessage: String, val repeatCount: Int, val formattedLine: String)

    private val entries = ArrayDeque<ChatEntry>()

    fun submitIncomingMessage(rawMessage: String, timestampPrefix: String? = null): ChatEntry {
        val normalized = rawMessage.trim()
        val last = entries.lastOrNull()
        val updated = if (last != null && last.baseMessage == normalized) {
            entries.removeLast()
            val nextCount = last.repeatCount + 1
            val prefix = if (!timestampPrefix.isNullOrBlank()) "[$timestampPrefix] " else ""
            ChatEntry(normalized, nextCount, "$prefix$normalized [x$nextCount]")
        } else {
            val prefix = if (!timestampPrefix.isNullOrBlank()) "[$timestampPrefix] " else ""
            ChatEntry(normalized, 1, "$prefix$normalized")
        }
        entries.addLast(updated)
        while (entries.size > maxHistoryEntries) {
            entries.removeFirst()
        }
        return updated
    }

    fun historySnapshot(): List<ChatEntry> = entries.toList()
}

/**
 * Rich Survival & PvP tooltip formatter.
 */
object TooltipEnhancer {
    fun buildItemTelemetryLines(
        currentDamage: Int,
        maxDamage: Int,
        anvilRepairCost: Int,
        nutritionPoints: Int,
        saturationModifier: Float
    ): List<String> {
        val lines = mutableListOf<String>()
        if (maxDamage > 0) {
            val remaining = (maxDamage - currentDamage).coerceIn(0, maxDamage)
            val pct = (remaining.toDouble() / maxDamage.toDouble()) * 100.0
            lines += String.format("Durability: %d / %d (%.1f%%)", remaining, maxDamage, pct)
        }
        if (anvilRepairCost > 0) {
            val tooExpensiveWarning = if (anvilRepairCost >= 31) " [Near Anvil Cap]" else ""
            lines += "Anvil Work Penalty: $anvilRepairCost XP Levels$tooExpensiveWarning"
        }
        if (nutritionPoints > 0) {
            val saturationRestored = nutritionPoints * saturationModifier * 2.0f
            lines += String.format("Hunger: +%.1f shanks | Saturation: +%.1f", nutritionPoints / 2.0, saturationRestored)
        }
        return lines
    }
}
