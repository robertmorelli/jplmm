import { readFileSync, readdirSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runFrontend } from "../src/pipeline.ts";

const examplesRoot = fileURLToPath(new URL("../../../examples", import.meta.url));

function collectExampleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...collectExampleFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jplmm")) {
      out.push(full);
    }
  }
  return out.sort();
}

const exampleFiles = collectExampleFiles(examplesRoot);

describe("examples corpus", () => {
  it("contains at least 100 examples", () => {
    expect(exampleFiles.length).toBeGreaterThanOrEqual(100);
  });

  for (const file of exampleFiles) {
    it(`typechecks ${relative(examplesRoot, file)}`, () => {
      const source = readFileSync(file, "utf8");
      const result = runFrontend(source);
      expect(result.diagnostics).toEqual([]);
    });
  }
});
