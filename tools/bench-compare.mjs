#!/usr/bin/env node
// Compares two jplmm benchmark JSON files and reports regressions.
//
// Usage:
//   node tools/bench-compare.mjs <baseline.json> <current.json> [--threshold=0.10]
//
// Exits 1 if any benchmark regressed beyond the threshold (default 10%).
// The metric compared is `jplNativeArm64.ms` per result entry (lower = faster = better).

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const thresholdArg = args.find((a) => a.startsWith("--threshold="));
const THRESHOLD = thresholdArg ? parseFloat(thresholdArg.split("=")[1]) : 0.10;
const positional = args.filter((a) => !a.startsWith("--"));

if (positional.length !== 2) {
  console.error("Usage: bench-compare.mjs <baseline.json> <current.json> [--threshold=0.10]");
  process.exit(2);
}

const [baselinePath, currentPath] = positional;
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const current = JSON.parse(readFileSync(currentPath, "utf8"));

/** @param {unknown} data @returns {Map<string, number>} */
function extractMetrics(data) {
  const map = new Map();
  const results = Array.isArray(data?.results) ? data.results : [];
  for (const entry of results) {
    const name = typeof entry.name === "string" ? entry.name : null;
    if (!name) continue;
    const ms = entry.jplNativeArm64?.ms;
    if (typeof ms === "number" && isFinite(ms)) {
      map.set(name, ms);
    }
  }
  return map;
}

const baseMap = extractMetrics(baseline);
const currMap = extractMetrics(current);

let regressions = 0;
let improvements = 0;
let unchanged = 0;
let newEntries = 0;

for (const [name, currMs] of currMap) {
  const baseMs = baseMap.get(name);
  if (baseMs === undefined) {
    console.log(`[NEW]         ${name}: ${currMs.toFixed(3)}ms (no baseline)`);
    newEntries++;
    continue;
  }
  const delta = (currMs - baseMs) / baseMs;
  const sign = delta >= 0 ? "+" : "";
  const pct = `${sign}${(delta * 100).toFixed(1)}%`;
  if (delta > THRESHOLD) {
    console.log(`[REGRESSION]  ${name}: ${baseMs.toFixed(3)}ms → ${currMs.toFixed(3)}ms (${pct})`);
    regressions++;
  } else if (delta < -THRESHOLD) {
    console.log(`[IMPROVEMENT] ${name}: ${baseMs.toFixed(3)}ms → ${currMs.toFixed(3)}ms (${pct})`);
    improvements++;
  } else {
    console.log(`[OK]          ${name}: ${baseMs.toFixed(3)}ms → ${currMs.toFixed(3)}ms (${pct})`);
    unchanged++;
  }
}

// Report entries removed from baseline
for (const name of baseMap.keys()) {
  if (!currMap.has(name)) {
    console.log(`[REMOVED]     ${name}: was in baseline, not in current`);
  }
}

console.log(`\nSummary: ${unchanged} ok, ${improvements} improved, ${regressions} regressed, ${newEntries} new`);
console.log(`Threshold: ${(THRESHOLD * 100).toFixed(0)}%`);

if (regressions > 0) {
  console.error(`\n${regressions} benchmark(s) regressed beyond the ${(THRESHOLD * 100).toFixed(0)}% threshold.`);
  process.exit(1);
}
