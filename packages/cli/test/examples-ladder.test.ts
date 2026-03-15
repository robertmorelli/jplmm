import { readFileSync, readdirSync } from "node:fs";
import { basename, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runOnSource } from "../src/index.ts";

const examplesRoot = fileURLToPath(new URL("../../../examples/control", import.meta.url));

const gridRelaxExamples = readdirSync(examplesRoot)
  .filter((name) => /^0?\d+_grid_relax_.*\.jplmm$/.test(name))
  .sort()
  .map((name) => `${examplesRoot}/${name}`);

const trackerSettleExamples = readdirSync(examplesRoot)
  .filter((name) => /^0?\d+_tracker_settle_.*\.jplmm$/.test(name))
  .sort()
  .map((name) => `${examplesRoot}/${name}`);

describe("examples ladder", () => {
  it("proves raw-to-canonical relax equivalence for grid_relax examples", () => {
    const failures: string[] = [];

    for (const file of gridRelaxExamples) {
      const source = readFileSync(file, "utf8");
      const report = runOnSource(source, "semantics");
      if (!report.ok) {
        failures.push(`${basename(file)} diagnostics: ${report.diagnostics.join(" | ")}`);
        continue;
      }

      const data = JSON.parse(report.semantics ?? "{}");
      const edge = data.compiler?.edges?.find(
        (candidate: { from: string; to: string }) =>
          candidate.from === "raw_ir" && candidate.to === "canonical_ir",
      );
      const relax = edge?.functions?.find((fn: { name: string; status: string; message?: string }) => fn.name === "relax");
      if (relax?.status !== "equivalent") {
        failures.push(
          `${relative(examplesRoot, file)} relax ${relax?.status ?? "missing"}${relax?.message ? `: ${relax.message}` : ""}`,
        );
      }
    }

    expect(failures).toEqual([]);
  });

  it("proves raw-to-canonical score equivalence for tracker_settle examples", () => {
    const failures: string[] = [];

    for (const file of trackerSettleExamples) {
      const source = readFileSync(file, "utf8");
      const report = runOnSource(source, "semantics");
      if (!report.ok) {
        failures.push(`${basename(file)} diagnostics: ${report.diagnostics.join(" | ")}`);
        continue;
      }

      const data = JSON.parse(report.semantics ?? "{}");
      const edge = data.compiler?.edges?.find(
        (candidate: { from: string; to: string }) =>
          candidate.from === "raw_ir" && candidate.to === "canonical_ir",
      );
      const score = edge?.functions?.find((fn: { name: string; status: string; message?: string }) => fn.name === "score");
      if (score?.status !== "equivalent") {
        failures.push(
          `${relative(examplesRoot, file)} score ${score?.status ?? "missing"}${score?.message ? `: ${score.message}` : ""}`,
        );
      }
    }

    expect(failures).toEqual([]);
  });
});
