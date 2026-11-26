import fs from 'node:fs';
import path from 'node:path';
import { VesperaStateCoordinator } from '../server/stateStore';

const coordinator = new VesperaStateCoordinator();
console.log('Running Vespera Reproducible JVM 21 & Voxel Rendering Benchmark Suite...');
const report = coordinator.runBenchmarks();
coordinator.shutdownCleanly();

const outPath = path.resolve(process.cwd(), 'docs/BENCHMARK_LATEST.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');

console.log('\n=== VESPERA REPRODUCIBLE BENCHMARK SUMMARY ===');
console.log(`Hardware: ${report.hardwareSummary}`);
console.log(`Java Runtime: ${report.javaRuntimeVersion}`);
for (const r of report.results) {
  if (!r.available) {
    console.log(`- ${r.scenarioName}: [N/A — ${r.notes}]`);
    continue;
  }
  console.log(
    `- ${r.scenarioName}:\n` +
      `    Throughput FPS: ${r.metrics.avgFps} | 1% Low: ${r.metrics.onePercentLowFps} | P99: ${r.metrics.p99FrameTimeMs} ms | StdDev: ${r.metrics.frameTimeStdDevMs} ms\n` +
      `    Chunk Meshes/s: ${r.metrics.chunkMeshThroughputPerSec} | Face/Entity Culling: ${r.metrics.cullingEfficiencyPercent}% | Cold Boot: ${r.metrics.jvmColdStartupMs} ms | Peak Heap: ${r.metrics.peakHeapUsedMb} MB`
  );
}
console.log(`\nSaved full JSON report to ${outPath}`);
