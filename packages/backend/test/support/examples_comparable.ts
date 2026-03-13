import type { Cmd, Program } from "@jplmm/ast";

import { ENTRY_NAME } from "./examples_common.ts";

function lastFunction(program: Program): Extract<Cmd, { tag: "fn_def" }> {
  const functions = program.commands.filter((cmd): cmd is Extract<Cmd, { tag: "fn_def" }> => cmd.tag === "fn_def");
  const fn = functions.findLast((cmd) => cmd.name !== "main") ?? functions.at(-1);
  if (!fn) {
    throw new Error("Comparable wrapper generation requires at least one function");
  }
  return fn;
}

export function buildComparableWrapperSource(source: string, program: Program, category: string): string {
  const entry = lastFunction(program);
  switch (category) {
    case "image":
      return `${source.trimEnd()}\n${imageWrapper(entry.name)}\n`;
    case "sort":
      return `${source.trimEnd()}\n${sortWrapper(entry.name, source.includes("struct Vec8"))}\n`;
    case "showcase":
      return `${source.trimEnd()}\n${showcaseWrapper(entry.name)}\n`;
    default:
      throw new Error(`Unsupported comparable category '${category}'`);
  }
}

function imageWrapper(targetName: string): string {
  return `
fun ${ENTRY_NAME}(seed:int): int {
  let h = 4;
  let w = 5;
  let img = array [y:h, x:w] Pixel {
    clamp(abs(seed + 5 + y * 7 + x * 11), 0, 255),
    clamp(abs(seed + 9 + y * 5 + x * 13), 0, 255),
    clamp(abs(seed + 13 + y * 3 + x * 17), 0, 255)
  };
  let out = ${targetName}(img, h, w);
  ret sum [i:w] out[i];
}`;
}

function sortWrapper(targetName: string, isVec8: boolean): string {
  const ctor = isVec8
    ? `Vec8 {
    clamp(abs(seed + 3 + i * 5), 0, 255),
    clamp(abs(seed + 7 + i * 7), 0, 255),
    clamp(abs(seed + 11 + i * 9), 0, 255),
    clamp(abs(seed + 13 + i * 11), 0, 255),
    clamp(abs(seed + 17 + i * 13), 0, 255),
    clamp(abs(seed + 19 + i * 15), 0, 255),
    clamp(abs(seed + 23 + i * 17), 0, 255),
    clamp(abs(seed + 29 + i * 19), 0, 255)
  }`
    : `Vec4 {
    clamp(abs(seed + 3 + i * 5), 0, 255),
    clamp(abs(seed + 7 + i * 7), 0, 255),
    clamp(abs(seed + 11 + i * 9), 0, 255),
    clamp(abs(seed + 13 + i * 11), 0, 255)
  }`;
  return `
fun ${ENTRY_NAME}(seed:int): int {
  let n = 6;
  let blocks = array [i:n] ${ctor};
  ret ${targetName}(blocks, n);
}`;
}

function showcaseWrapper(targetName: string): string {
  return `
fun ${ENTRY_NAME}(seed:int): int {
  let h = 4;
  let w = 5;
  let img = array [y:h * 2 + 1, x:w * 2 + 1] Pixel {
    clamp(abs(seed + 5 + y * 7 + x * 11), 0, 255),
    clamp(abs(seed + 9 + y * 5 + x * 13), 0, 255),
    clamp(abs(seed + 13 + y * 3 + x * 17), 0, 255)
  };
  let out = ${targetName}(img, h, w);
  ret sum [i:h] out[i];
}`;
}
