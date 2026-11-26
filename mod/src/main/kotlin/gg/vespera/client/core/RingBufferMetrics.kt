package gg.vespera.client.core

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Zero-allocation primitive nanosecond frame-time analyzer.
 * Computes instantaneous FPS, rolling average frame-time (ms), P99 frame-time,
 * standard deviation (frame-pacing jitter), and true 1% Low FPS.
 */
class FrameTimeAnalyzer(private val capacity: Int = 600) {
    private val frameDurationsNs = LongArray(capacity)
    private val scratchSortedNs = LongArray(capacity)
    private var writeIndex = 0
    private var count = 0
    private var lastFrameTimestampNs = -1L

    fun recordFrameTimestamp(nowNs: Long) {
        if (lastFrameTimestampNs >= 0L && nowNs > lastFrameTimestampNs) {
            recordFrameDurationNs(nowNs - lastFrameTimestampNs)
        }
        lastFrameTimestampNs = nowNs
    }

    fun recordFrameDurationNs(durationNs: Long) {
        if (durationNs <= 0L) return
        frameDurationsNs[writeIndex] = durationNs
        writeIndex = (writeIndex + 1) % capacity
        if (count < capacity) count++
    }

    data class FrameStats(
        val sampleCount: Int,
        val avgFps: Double,
        val avgFrameTimeMs: Double,
        val onePercentLowFps: Double,
        val p99FrameTimeMs: Double,
        val stdDevFrameTimeMs: Double
    )

    fun snapshot(): FrameStats {
        if (count == 0) {
            return FrameStats(0, 0.0, 0.0, 0.0, 0.0, 0.0)
        }

        var sumNs = 0.0
        for (i in 0 until count) {
            val v = frameDurationsNs[i]
            scratchSortedNs[i] = v
            sumNs += v.toDouble()
        }

        scratchSortedNs.sort(0, count)

        val meanNs = sumNs / count.toDouble()
        var varianceSumMs = 0.0
        val meanMs = meanNs / 1_000_000.0
        for (i in 0 until count) {
            val diffMs = (scratchSortedNs[i] / 1_000_000.0) - meanMs
            varianceSumMs += diffMs * diffMs
        }
        val stdDevMs = sqrt(varianceSumMs / count.toDouble())

        // Slowest 1% frames live at the tail of ascending-sorted frame durations
        val tailCount = max(1, count / 100)
        var tailSumNs = 0.0
        for (i in (count - tailCount) until count) {
            tailSumNs += scratchSortedNs[i].toDouble()
        }
        val meanSlowestOnePercentNs = tailSumNs / tailCount.toDouble()
        val onePercentLowFps = if (meanSlowestOnePercentNs > 0.0) {
            1_000_000_000.0 / meanSlowestOnePercentNs
        } else 0.0

        val p99Idx = min(count - 1, ((count - 1) * 0.99).roundToInt())
        val p99Ms = scratchSortedNs[p99Idx] / 1_000_000.0
        val avgFps = if (meanNs > 0.0) 1_000_000_000.0 / meanNs else 0.0

        return FrameStats(
            sampleCount = count,
            avgFps = avgFps,
            avgFrameTimeMs = meanMs,
            onePercentLowFps = onePercentLowFps,
            p99FrameTimeMs = p99Ms,
            stdDevFrameTimeMs = stdDevMs
        )
    }
}

/**
 * Sliding 1,000 ms click-per-second tracker backed by fixed-size primitive LongArray ring buffers.
 */
class CpsRingTracker(private val capacity: Int = 256, private val windowMs: Long = 1_000L) {
    private val leftClicksMs = LongArray(capacity)
    private var leftHead = 0
    private var leftSize = 0

    private val rightClicksMs = LongArray(capacity)
    private var rightHead = 0
    private var rightSize = 0

    var peakLeftCps: Int = 0
        private set
    var peakRightCps: Int = 0
        private set

    fun registerLeftClick(nowMs: Long) {
        pruneLeft(nowMs)
        if (leftSize == capacity) {
            leftHead = (leftHead + 1) % capacity
            leftSize--
        }
        val writeIdx = (leftHead + leftSize) % capacity
        leftClicksMs[writeIdx] = nowMs
        leftSize++
        if (leftSize > peakLeftCps) peakLeftCps = leftSize
    }

    fun registerRightClick(nowMs: Long) {
        pruneRight(nowMs)
        if (rightSize == capacity) {
            rightHead = (rightHead + 1) % capacity
            rightSize--
        }
        val writeIdx = (rightHead + rightSize) % capacity
        rightClicksMs[writeIdx] = nowMs
        rightSize++
        if (rightSize > peakRightCps) peakRightCps = rightSize
    }

    fun getLeftCps(nowMs: Long): Int {
        pruneLeft(nowMs)
        return leftSize
    }

    fun getRightCps(nowMs: Long): Int {
        pruneRight(nowMs)
        return rightSize
    }

    private fun pruneLeft(nowMs: Long) {
        val cutoff = nowMs - windowMs
        while (leftSize > 0 && leftClicksMs[leftHead] <= cutoff) {
            leftHead = (leftHead + 1) % capacity
            leftSize--
        }
    }

    private fun pruneRight(nowMs: Long) {
        val cutoff = nowMs - windowMs
        while (rightSize > 0 && rightClicksMs[rightHead] <= cutoff) {
            rightHead = (rightHead + 1) % capacity
            rightSize--
        }
    }
}

/**
 * Estimates multiplayer Server TPS from WorldTimeUpdateS2CPacket arrival deltas (expected 20 ticks / 1.0 sec).
 */
class ServerTpsEstimator {
    private var lastPacketWallMs: Long = -1L
    private var lastWorldAgeTicks: Long = -1L
    var estimatedTps: Double = 20.0
        private set

    fun onWorldTimeUpdate(worldAgeTicks: Long, nowWallMs: Long) {
        if (lastPacketWallMs > 0L && lastWorldAgeTicks >= 0L) {
            val deltaWallSec = (nowWallMs - lastPacketWallMs) / 1000.0
            val deltaTicks = (worldAgeTicks - lastWorldAgeTicks).coerceAtLeast(0L)
            if (deltaWallSec >= 0.25 && deltaTicks > 0L) {
                val instantTps = (deltaTicks / deltaWallSec).coerceIn(0.0, 20.0)
                estimatedTps = estimatedTps * 0.7 + instantTps * 0.3
            }
        }
        lastPacketWallMs = nowWallMs
        lastWorldAgeTicks = worldAgeTicks
    }
}
