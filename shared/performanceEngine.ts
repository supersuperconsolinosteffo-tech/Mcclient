import type {
  GarbageCollectorMode,
  GraphicsSettings,
  PerformanceModeId,
  PerformanceSettings,
} from './types';

export interface RamRecommendation {
  recommendedMb: number;
  minSafeMb: number;
  maxSafeMb: number;
  recommendedGc: GarbageCollectorMode;
  rationale: string;
}

/**
 * Computes an intelligent, hardware-aware JVM heap allocation based on detected physical RAM.
 * Avoids both heap starvation (<2 GB) and GC-pause bloat (>8 GB without Generational ZGC)
 * while reserving ample memory for Windows DWM, OpenGL driver staging buffers, and audio.
 */
export function computeRecommendedRam(
  totalSystemRamMb: number,
  javaMajor: 8 | 17 | 21 = 21,
  highResPackLoaded = false,
  shadersActive = false
): RamRecommendation {
  const workloadBonusMb = (highResPackLoaded ? 1024 : 0) + (shadersActive ? 512 : 0);

  if (totalSystemRamMb <= 4608) {
    return {
      recommendedMb: 2048,
      minSafeMb: 1536,
      maxSafeMb: 2560,
      recommendedGc: 'adaptive_g1gc',
      rationale:
        '4 GB host detected: 2,048 MB heap paired with FerriteCore keeps at least 2 GB free for Windows kernel & GPU OpenGL driver buffers.',
    };
  }

  if (totalSystemRamMb <= 8704) {
    const rec = Math.min(4096, 3328 + Math.min(512, workloadBonusMb));
    return {
      recommendedMb: rec,
      minSafeMb: 2048,
      maxSafeMb: 4608,
      recommendedGc: 'adaptive_g1gc',
      rationale:
        '8 GB host detected: ~3.25–4.0 GB heap with Adaptive G1GC prevents OS paging while leaving headroom for GPU VRAM staging.',
    };
  }

  if (totalSystemRamMb <= 16896) {
    const rec = Math.min(6144, 4096 + workloadBonusMb);
    const gc: GarbageCollectorMode = javaMajor >= 21 && rec >= 5120 ? 'generational_zgc' : 'adaptive_g1gc';
    return {
      recommendedMb: rec,
      minSafeMb: 3072,
      maxSafeMb: 8192,
      recommendedGc: gc,
      rationale:
        '16 GB host detected: 4,096–6,144 MB provides smooth 16-chunk rendering and shader headroom without triggering long old-gen GC sweeps.',
    };
  }

  const rec = Math.min(8192, 5120 + workloadBonusMb);
  return {
    recommendedMb: rec,
    minSafeMb: 4096,
    maxSafeMb: Math.min(12288, Math.floor(totalSystemRamMb * 0.45)),
    recommendedGc: javaMajor >= 21 ? 'generational_zgc' : 'adaptive_g1gc',
    rationale:
      '24 GB+ host detected: 5–8 GB paired with Java 21 Generational ZGC delivers sub-millisecond GC pauses without wasting RAM via uncompressed OOP thresholds.',
  };
}

export interface JvmFlagExplanation {
  flag: string;
  description: string;
}

export function synthesizeJvmArguments(
  perf: PerformanceSettings,
  javaMajor: 8 | 17 | 21,
  extraArgsRaw = ''
): { flags: string[]; explanations: JvmFlagExplanation[] } {
  const explanations: JvmFlagExplanation[] = [];
  const add = (flag: string, description: string) => {
    explanations.push({ flag, description });
  };

  const heapMb = Math.max(1024, Math.round(perf.allocatedRamMb));
  const minHeapMb = perf.alwaysPreTouch ? heapMb : Math.max(1024, Math.round(heapMb * 0.5));

  add(`-Xmx${heapMb}M`, `Caps maximum JVM heap at ${heapMb} MB to prevent runaway OS memory pressure.`);
  add(
    `-Xms${minHeapMb}M`,
    perf.alwaysPreTouch
      ? 'Matches initial heap to max heap so memory pages are committed upfront during startup rather than mid-fight.'
      : 'Commits 50% of max heap upfront for fast startup and dynamic expansion.'
  );

  add('-XX:+UnlockExperimentalVMOptions', 'Enables advanced HotSpot collector tuning parameters.');
  add(
    '-XX:+DisableExplicitGC',
    'Prevents poorly behaved mods from calling System.gc() and causing sudden multi-hundred-millisecond freezes.'
  );

  if (perf.alwaysPreTouch) {
    add('-XX:+AlwaysPreTouch', 'Zeros and maps OS physical memory pages at boot to eliminate page-fault micro-stutters in combat.');
  }

  if (perf.gcMode === 'generational_zgc' && javaMajor >= 21) {
    add('-XX:+UseZGC', 'Selects the scalable low-latency Z Garbage Collector (Java 21+).');
    add(
      '-XX:+ZGenerational',
      'Enables Generational ZGC to collect short-lived per-frame allocations in < 0.5 ms concurrent pauses.'
    );
  } else if (perf.gcMode === 'shenandoah_low_pause' && javaMajor >= 17) {
    add('-XX:+UseShenandoahGC', 'Selects concurrent low-pause Shenandoah GC when supported by the Temurin runtime.');
    add('-XX:ShenandoahGCHeuristics=compact', 'Keeps resident heap compact while pacing concurrent collection.');
  } else {
    // Client-tuned Adaptive G1GC (optimized for frame-time pacing rather than server-only throughput)
    add('-XX:+UseG1GC', 'Uses Garbage-First (G1) collector tuned for interactive client frame-time consistency.');
    add('-XX:MaxGCPauseMillis=28', 'Targets <28 ms worst-case stop-the-world GC pause budget.');
    add('-XX:G1NewSizePercent=28', 'Sizes young generation to absorb per-tick chunk & vertex temporary allocations.');
    add('-XX:G1MaxNewSizePercent=40', 'Caps young-gen growth so evacuation pauses remain short and predictable.');
    add('-XX:G1HeapRegionSize=16M', 'Uses 16 MB regions so chunk mesh byte arrays are not treated as humongous objects.');
    add('-XX:G1ReservePercent=16', 'Maintains free region headroom to avoid costly to-space exhaustion stalls.');
    add('-XX:InitiatingHeapOccupancyPercent=20', 'Starts concurrent marking early before old-generation fills up.');
  }

  if (javaMajor >= 17) {
    add('-XX:+UseStringDeduplication', 'Deduplicates identical identifier/NBT backing strings in the background.');
  }

  add('-Dfml.ignoreInvalidMinecraftCertificates=true', 'Maintains compatibility with standard modloader launch wrappers.');
  add('-Dvespera.client.mode=' + perf.mode, 'Passes active Vespera performance profile identifier to the client mod.');

  if (extraArgsRaw.trim().length > 0) {
    const customTokens = extraArgsRaw
      .trim()
      .split(/\s+/)
      .filter((tok) => tok.startsWith('-'));
    for (const tok of customTokens) {
      add(tok, 'User-supplied custom JVM flag.');
    }
  }

  return {
    flags: explanations.map((e) => e.flag),
    explanations,
  };
}

export interface PerformancePresetBundle {
  id: PerformanceModeId;
  title: string;
  subtitle: string;
  philosophy: string;
  performance: Omit<PerformanceSettings, 'allocatedRamMb' | 'autoRecommendRam'>;
  graphicsDefaults: Partial<GraphicsSettings>;
}

/**
 * The four selectable Vespera Performance Modes.
 * Notice: Even "Maximum FPS" keeps crisp 12-chunk render distance, 4x mipmaps, full smooth lighting,
 * and native textures — optimizing via multi-draw indirect rendering, async raycast entity culling,
 * foliage interior culling, immediate-mode batching, and low-latency frame pacing rather than ugly visual downgrades!
 */
export const PERFORMANCE_MODE_PRESETS: Record<PerformanceModeId, PerformancePresetBundle> = {
  max_fps: {
    id: 'max_fps',
    title: 'Maximum FPS & Low Latency',
    subtitle: 'Competitive frame pacing & sub-millisecond input response without degrading core visuals',
    philosophy:
      'Maximizes GPU indirect batching, async entity/block-entity occlusion culling, interior leaf face rejection, and Generational ZGC pre-touch while preserving crisp 12-chunk visibility, smooth lighting, and 4x mipmaps.',
    performance: {
      mode: 'max_fps',
      gcMode: 'generational_zgc',
      alwaysPreTouch: true,
      chunkBuilderThreads: 0,
      deferChunkUpdates: true,
      useBlockFaceCulling: true,
      useCompactVertexFormat: true,
      useFogOcclusion: true,
      useEntityCulling: true,
      entityCullingMaxDistance: 64,
      ImmediatelyFastBatching: true,
      ferriteMemoryDeduplication: true,
      dynamicBackgroundFpsLimit: 15,
      keepLauncherIdleOnRun: true,
      lowLatencyFramePacing: true,
    },
    graphicsDefaults: {
      renderDistanceChunks: 12,
      simulationDistanceChunks: 8,
      vsync: false,
      maxFps: 0,
      particles: 'decreased',
      entityDistancePercent: 100,
      clouds: 'fast',
      smoothLighting: 'maximum',
      entityShadows: false,
      biomeBlendRadius: 3,
      mipmapLevels: 4,
      connectedTextures: false,
      shaderQualityPreset: 'off',
    },
  },
  balanced: {
    id: 'balanced',
    title: 'Balanced (Default Recommended)',
    subtitle: 'High frame rates, rock-solid 1% lows, and rich visual polish',
    philosophy:
      'Runs the complete Sodium + Lithium + FerriteCore + ImmediatelyFast + EntityCulling + Continuity pipeline with 16-chunk render distance, fancy clouds, connected textures, entity shadows, and full animations.',
    performance: {
      mode: 'balanced',
      gcMode: 'adaptive_g1gc',
      alwaysPreTouch: false,
      chunkBuilderThreads: 0,
      deferChunkUpdates: true,
      useBlockFaceCulling: true,
      useCompactVertexFormat: true,
      useFogOcclusion: true,
      useEntityCulling: true,
      entityCullingMaxDistance: 96,
      ImmediatelyFastBatching: true,
      ferriteMemoryDeduplication: true,
      dynamicBackgroundFpsLimit: 30,
      keepLauncherIdleOnRun: true,
      lowLatencyFramePacing: true,
    },
    graphicsDefaults: {
      renderDistanceChunks: 16,
      simulationDistanceChunks: 10,
      vsync: false,
      maxFps: 240,
      particles: 'all',
      entityDistancePercent: 125,
      clouds: 'fancy',
      smoothLighting: 'maximum',
      entityShadows: true,
      biomeBlendRadius: 5,
      mipmapLevels: 4,
      connectedTextures: true,
      customEntityModels: true,
      emissiveTextures: true,
      animationsAllEnabled: true,
      shaderQualityPreset: 'off',
    },
  },
  visual_quality: {
    id: 'visual_quality',
    title: 'Visual Quality & Shaders',
    subtitle: 'Cinematic Iris shader pipeline, connected textures, and custom entity models',
    philosophy:
      'Enables Iris Shaders with Sodium shadow-pass frustum culling, Continuity CTM, Entity Model/Texture Features, 20-chunk horizons, 7x7 biome blend, and anisotropic mipmapping while retaining FerriteCore & Lithium optimizations.',
    performance: {
      mode: 'visual_quality',
      gcMode: 'generational_zgc',
      alwaysPreTouch: true,
      chunkBuilderThreads: 0,
      deferChunkUpdates: false,
      useBlockFaceCulling: true,
      useCompactVertexFormat: true,
      useFogOcclusion: true,
      useEntityCulling: true,
      entityCullingMaxDistance: 128,
      ImmediatelyFastBatching: true,
      ferriteMemoryDeduplication: true,
      dynamicBackgroundFpsLimit: 30,
      keepLauncherIdleOnRun: true,
      lowLatencyFramePacing: false,
    },
    graphicsDefaults: {
      renderDistanceChunks: 20,
      simulationDistanceChunks: 12,
      vsync: true,
      maxFps: 165,
      particles: 'all',
      entityDistancePercent: 150,
      clouds: 'fancy',
      smoothLighting: 'maximum',
      entityShadows: true,
      biomeBlendRadius: 7,
      mipmapLevels: 4,
      anisotropicFiltering: 8,
      connectedTextures: true,
      customEntityModels: true,
      emissiveTextures: true,
      animationsAllEnabled: true,
      shaderQualityPreset: 'balanced_pbr',
    },
  },
  custom: {
    id: 'custom',
    title: 'Custom Engineering Profile',
    subtitle: 'Full manual authority over every rendering, culling, and JVM collector parameter',
    philosophy:
      'Unlocks independent control of every rendering optimization, culling distance, GC collector heuristic, and graphics parameter without preset overrides.',
    performance: {
      mode: 'custom',
      gcMode: 'adaptive_g1gc',
      alwaysPreTouch: false,
      chunkBuilderThreads: 0,
      deferChunkUpdates: true,
      useBlockFaceCulling: true,
      useCompactVertexFormat: true,
      useFogOcclusion: true,
      useEntityCulling: true,
      entityCullingMaxDistance: 96,
      ImmediatelyFastBatching: true,
      ferriteMemoryDeduplication: true,
      dynamicBackgroundFpsLimit: 30,
      keepLauncherIdleOnRun: true,
      lowLatencyFramePacing: true,
    },
    graphicsDefaults: {},
  },
};
