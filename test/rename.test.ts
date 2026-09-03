import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProjectCachePath, resolveProjectTsConfig } from "../src/find.ts";
import {
  isPointerAmbiguity,
  renameSymbol,
} from "../src/rename.ts";

const fixtureRoot = mkdtempSync(join(tmpdir(), "regoof-rename-"));
const sharedDirectory = join(fixtureRoot, "packages", "shared");
const consumerDirectory = join(fixtureRoot, "packages", "consumer");
const sharedFile = join(sharedDirectory, "src", "shared.ts");
const consumerFile = join(consumerDirectory, "src", "consumer.ts");
const cacheDirectory = mkdtempSync(join(tmpdir(), "regoof-rename-cache-"));
const sharedPointer = "**/shared.ts:sharedValue";
const canonicalSharedPointer = "packages/shared/src/shared.ts:1:sharedValue";

beforeEach(writeFixture);

afterAll(() => {
  rmSync(fixtureRoot, { force: true, recursive: true });
  rmSync(cacheDirectory, { force: true, recursive: true });
});

describe("renameSymbol", () => {
  test("renames directly from a pointer across package boundaries", () => {
    const result = renameSymbol(sharedPointer, "renamedValue", {
      cacheDirectory,
      cwd: fixtureRoot,
    });

    expect(isPointerAmbiguity(result)).toBe(false);
    expect(result).toEqual({
      pointer: canonicalSharedPointer,
      oldName: "sharedValue",
      newName: "renamedValue",
      filesChanged: 2,
      referencesRenamed: 2,
    });
    expect(readFileSync(sharedFile, "utf8")).toContain("renamedValue");
    expect(readFileSync(consumerFile, "utf8")).toContain(
      'import { renamedValue } from "../../shared/src/shared";',
    );
    expect(readFileSync(consumerFile, "utf8")).toContain("= renamedValue;");
  });

  test("accepts a canonical line pointer and invalidates the declaration cache", () => {
    const indexCachePath = getProjectCachePath(
      resolveProjectTsConfig(fixtureRoot),
      cacheDirectory,
    );
    const result = renameSymbol(canonicalSharedPointer, "renamedValue", {
      cacheDirectory,
      cwd: fixtureRoot,
      cacheMode: "clear",
    });

    expect(isPointerAmbiguity(result)).toBe(false);
    expect(existsSync(indexCachePath)).toBe(false);
    expect(() =>
      renameSymbol(canonicalSharedPointer, "anotherValue", {
        cacheDirectory,
        cwd: fixtureRoot,
      }),
    ).toThrow("No declaration matches pointer");
    expect(() =>
      renameSymbol("**/shared.ts:renamedValue", "anotherValue", {
        cacheDirectory,
        cwd: fixtureRoot,
        cacheMode: "bypass",
      }),
    ).not.toThrow();
  });

  test("returns pointer choices without mutating ambiguous declarations", () => {
    const result = renameSymbol("sharedValue", "renamedValue", {
      cacheDirectory,
      cwd: fixtureRoot,
    });

    expect(isPointerAmbiguity(result)).toBe(true);
    if (isPointerAmbiguity(result)) {
      expect(result.candidates).toContainEqual({
        name: "sharedValue",
        filePath: "packages/shared/src/shared.ts",
        line: 1,
        pointer: canonicalSharedPointer,
      });
    }
    expect(readFileSync(sharedFile, "utf8")).toContain("sharedValue");
    expect(readFileSync(consumerFile, "utf8")).toContain("sharedValue");
  });

  test("rejects invalid names and missing pointers", () => {
    expect(() =>
      renameSymbol(sharedPointer, "not-valid", { cacheDirectory, cwd: fixtureRoot }),
    ).toThrow("valid TypeScript identifier");
    expect(() =>
      renameSymbol("missingValue", "renamedValue", { cacheDirectory, cwd: fixtureRoot }),
    ).toThrow("No declaration matches pointer");
  });
});

function writeFixture(): void {
  mkdirSync(join(sharedDirectory, "src"), { recursive: true });
  mkdirSync(join(consumerDirectory, "src"), { recursive: true });
  writeFileSync(
    join(fixtureRoot, "tsconfig.json"),
    JSON.stringify({
      files: [],
      references: [{ path: "./packages/shared" }, { path: "./packages/consumer" }],
    }),
  );
  writeFileSync(
    join(sharedDirectory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { composite: true, module: "ESNext", moduleResolution: "Bundler" },
      include: ["src/**/*.ts"],
    }),
  );
  writeFileSync(
    join(consumerDirectory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { composite: true, module: "ESNext", moduleResolution: "Bundler" },
      references: [{ path: "../shared" }],
      include: ["src/**/*.ts"],
    }),
  );
  writeFileSync(sharedFile, "export const sharedValue = 1;\n");
  writeFileSync(
    consumerFile,
    'import { sharedValue } from "../../shared/src/shared";\nexport const consumerValue = sharedValue;\n',
  );
}
