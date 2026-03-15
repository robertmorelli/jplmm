import { describe, expect, it } from "vitest";

import { buildDocumentIndex, findDefinition, getCompletions } from "../src/analysis.ts";

describe("document analysis", () => {
  it("finds definitions for locals, params, and functions", () => {
    const source = `
      fun add_one(x:int): int {
        let y = x + 1;
        ret y;
      }

      out add_one(4);
    `;
    const index = buildDocumentIndex(source);
    const localRef = source.lastIndexOf("y;");
    const paramRef = source.indexOf("x + 1");
    const callRef = source.lastIndexOf("add_one");

    expect(findDefinition(index, localRef)?.name).toBe("y");
    expect(findDefinition(index, paramRef)?.name).toBe("x");
    expect(findDefinition(index, callRef)?.kind).toBe("function");
  });

  it("offers scope-aware completions", () => {
    const source = `
      struct Pair { left:int, right:int }

      fun add_one(x:int): int {
        let y = x + 1;
        ret 
      }
    `;
    const index = buildDocumentIndex(source);
    const offset = source.lastIndexOf("ret ") + 4;
    const labels = new Set(getCompletions(index, offset).map((entry) => entry.label));

    expect(labels.has("x")).toBe(true);
    expect(labels.has("y")).toBe(true);
    expect(labels.has("Pair")).toBe(true);
    expect(labels.has("ret")).toBe(true);
    expect(labels.has("ref")).toBe(true);
  });

  it("resolves struct field definitions when unique", () => {
    const source = `
      struct Pair { left:int, right:int }

      fun second(p:Pair): int {
        ret p.right;
      }
    `;
    const index = buildDocumentIndex(source);
    const fieldRef = source.lastIndexOf("right");

    expect(findDefinition(index, fieldRef)?.kind).toBe("field");
  });

  it("indexes ref definitions as functions", () => {
    const source = `
      fun shrink(x:int): int {
        ret max(x, 0);
      }

      ref shrink(y:int): int {
        ret clamp(y, 0, 2147483647);
      }

      out shrink(4);
    `;
    const index = buildDocumentIndex(source);
    const callRef = source.lastIndexOf("shrink");

    expect(findDefinition(index, callRef)?.kind).toBe("function");
  });

  it("indexes named array extents as parameter-like symbols", () => {
    const source = `
      fun dims(a:int[n][m]): int {
        ret n + m;
      }
    `;
    const index = buildDocumentIndex(source);
    const nRef = source.lastIndexOf("n +");
    const mRef = source.lastIndexOf("m;");
    const offset = source.indexOf("ret ") + 4;
    const labels = new Set(getCompletions(index, offset).map((entry) => entry.label));

    expect(findDefinition(index, nRef)?.name).toBe("n");
    expect(findDefinition(index, mRef)?.name).toBe("m");
    expect(labels.has("n")).toBe(true);
    expect(labels.has("m")).toBe(true);
  });
});
