import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { peekSymbol, type PeekResult } from "../src/peek.ts";
import { isPointerAmbiguity, type PointerAmbiguity } from "../src/rename.ts";

const fixtureRoot = mkdtempSync(join(tmpdir(), "regoof-peek-"));
const sourceFile = join(fixtureRoot, "src", "example.ts");
const cacheDirectory = mkdtempSync(join(tmpdir(), "regoof-peek-cache-"));
const canonicalPointer = "src/example.ts:11:targetValue";

beforeEach(writeFixture);

afterAll(() => {
  rmSync(fixtureRoot, { force: true, recursive: true });
  rmSync(cacheDirectory, { force: true, recursive: true });
});

describe("peekSymbol", () => {
  test("renders directly from a pointer with the requested highlighted radius", async () => {
    const result = expectSingle(
      await peekSymbol("targetValue", 2, { cacheDirectory, cwd: fixtureRoot }),
    );

    expect(result).toMatchObject({
      pointer: canonicalPointer,
      filePath: "src/example.ts",
      line: 11,
      startLine: 9,
      endLine: 13,
    });
    const plainOutput = result.output.replaceAll(/\u001B\[[0-9;]*m/g, "");
    expect(result.output).toContain("src/example.ts:11");
    expect(plainOutput).toContain("  9 | export const line9 = 9;");
    expect(result.output).toContain("\u001B[1;33m>\u001B[0m 11 | ");
    expect(result.output).toContain("\u001B[48;5;236m");
    expect(result.output).toContain("\u001B[31mconst\u001B[0m");
    expect(plainOutput).toContain("targetValue");
    expect(plainOutput).not.toContain("line8");
    expect(plainOutput).not.toContain("line14");
  });

  test("defaults to radius five and accepts a canonical pointer", async () => {
    const result = expectSingle(
      await peekSymbol(canonicalPointer, undefined, {
        cacheDirectory,
        cwd: fixtureRoot,
        cacheMode: "bypass",
      }),
    );
    expect(result.startLine).toBe(6);
    expect(result.endLine).toBe(16);
  });

  test("returns choices for ambiguous pointers and errors for missing ones", async () => {
    writeFileSync(
      sourceFile,
      `export const targetValue = 1;
export function targetValue() {}
`,
    );
    const ambiguous = await peekSymbol("targetValue", 0, {
      cacheDirectory,
      cwd: fixtureRoot,
    });
    expect(isPointerAmbiguity(ambiguous)).toBe(true);
    if (isPointerAmbiguity(ambiguous)) {
      expect(ambiguous.candidates).toHaveLength(2);
      expect(ambiguous.candidates[0]?.pointer).toBe("src/example.ts:1:targetValue");
    }
    await expect(peekSymbol("missingValue", 0, { cacheDirectory, cwd: fixtureRoot })).rejects.toThrow(
      "No declaration matches pointer",
    );
    await expect(peekSymbol("TargetValue", 0, { cacheDirectory, cwd: fixtureRoot })).rejects.toThrow(
      "No declaration matches pointer",
    );
  });
});

function expectSingle(result: PeekResult | PointerAmbiguity): PeekResult {
  if (isPointerAmbiguity(result)) {
    throw new Error("Expected a unique pointer.");
  }
  return result;
}

function writeFixture(): void {
  mkdirSync(join(fixtureRoot, "src"), { recursive: true });
  writeFileSync(
    join(fixtureRoot, "tsconfig.json"),
    JSON.stringify({ include: ["src/**/*.ts"] }),
  );
  writeFileSync(
    sourceFile,
    Array.from({ length: 20 }, (_, index) => {
      const line = index + 1;
      return line === 11
        ? "export const targetValue = line10;"
        : `export const line${line} = ${line};`;
    }).join("\n"),
  );
}
