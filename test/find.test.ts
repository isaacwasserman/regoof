import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findDeclarations as findDeclarationsFromSource,
  getProjectCachePath,
  resolveProjectRoot,
  resolveProjectTsConfig,
  type FindOptions,
} from "../src/find.ts";
import { extractGlobalOptions } from "../src/global-options.ts";

const fixtureRoot = mkdtempSync(join(tmpdir(), "regoof-find-"));
const packageADirectory = join(fixtureRoot, "packages", "a");
const packageBDirectory = join(fixtureRoot, "packages", "b");
const packageAFile = join(packageADirectory, "src", "users.ts");
const cacheDirectory = mkdtempSync(join(tmpdir(), "regoof-cache-"));

writeFixture();

afterAll(() => {
  rmSync(fixtureRoot, { force: true, recursive: true });
  rmSync(cacheDirectory, { force: true, recursive: true });
});

describe("findDeclarations", () => {
  test("loads every referenced project and searches ts-morph nameable nodes", () => {
    const results = findDeclarations("user", { cwd: fixtureRoot });
    const names = results.map((result) => result.name);

    expect(names).toContain("UserService");
    expect(names).toContain("findUser");
    expect(names).toContain("localUser");
    expect(names).toContain("userSettings");
    expect(names).not.toContain("DeclaredUser");
    expect(new Set(results.map((result) => result.filePath))).toEqual(
      new Set(["packages/a/src/users.ts", "packages/b/src/settings.ts"]),
    );
  });

  test("uses case-insensitive substring matching and case-sensitive exact matching", () => {
    expect(findDeclarations("USER", { cwd: fixtureRoot }).length).toBeGreaterThan(1);
    const exactNames = findDeclarations("user", {
      cwd: fixtureRoot,
      exact: true,
    }).map((result) => result.name);
    expect(exactNames).toEqual(["user"]);
    expect(
      findDeclarations("User", {
        cwd: fixtureRoot,
        exact: true,
      }).map((result) => result.name),
    ).toEqual(["User"]);
  });

  test("filters with root-relative, absolute, and glob paths", () => {
    const rootRelative = findDeclarations("user", {
      cwd: fixtureRoot,
      filePath: "packages/a/src/**/*.ts",
    });
    const absolute = findDeclarations("user", {
      cwd: fixtureRoot,
      filePath: packageAFile,
    });
    const noMatches = findDeclarations("user", {
      cwd: fixtureRoot,
      filePath: "packages/missing/**/*.ts",
    });

    expect(rootRelative).toEqual(absolute);
    expect(rootRelative).not.toEqual([]);
    expect(rootRelative.every((result) => result.filePath.startsWith("packages/a/"))).toBe(
      true,
    );
    expect(noMatches).toEqual([]);
  });

  test("adds deterministic canonical pointers only when requested", () => {
    const first = findDeclarations("user", { cwd: fixtureRoot });
    const second = findDeclarations("user", { cwd: fixtureRoot });

    expect(first).toEqual(second);
    expect(first.every((result) => result.pointer === undefined)).toBe(true);

    const withPointers = findDeclarations("user", {
      cwd: fixtureRoot,
      includePointers: true,
    });
    expect(withPointers.every((result) => result.pointer !== undefined)).toBe(true);
    expect(withPointers).toContainEqual({
      name: "UserService",
      filePath: "packages/a/src/users.ts",
      line: 1,
      pointer: "packages/a/src/users.ts:1:UserService",
    });
    const json = JSON.stringify(withPointers, null, 2);
    expect(JSON.parse(json)).toEqual(withPointers);
    expect(json).toContain("\n  {");
  });

  test("finds the nearest project root", () => {
    expect(resolveProjectRoot(join(packageADirectory, "src"))).toBe(
      packageADirectory,
    );
  });

  test("uses an explicit project directory or tsconfig path", () => {
    expect(resolveProjectTsConfig(fixtureRoot, packageADirectory)).toBe(
      realpathSync(join(packageADirectory, "tsconfig.json")),
    );
    expect(
      findDeclarations("UserService", {
        cwd: packageBDirectory,
        projectPath: packageADirectory,
        exact: true,
      }).map((result) => result.filePath),
    ).toEqual(["src/users.ts"]);
  });

  test("refreshes only changed files and persists a complete declaration index", () => {
    const testCacheDirectory = createTestCacheDirectory();
    const cachePath = getProjectCachePath(
      resolveProjectTsConfig(fixtureRoot),
      testCacheDirectory,
    );
    const first = findDeclarations("UserService", {
      cwd: fixtureRoot,
      exact: true,
      cacheDirectory: testCacheDirectory,
    });
    const firstSnapshot = readFileSync(cachePath, "utf8");

    const second = findDeclarations("UserService", {
      cwd: fixtureRoot,
      exact: true,
      cacheDirectory: testCacheDirectory,
    });
    expect(second).toEqual(first);
    expect(readFileSync(cachePath, "utf8")).toBe(firstSnapshot);

    writeFileSync(
      packageAFile,
      `export class AccountService {}
export interface User {}
`,
    );
    expect(
      findDeclarations("AccountService", {
        cwd: fixtureRoot,
        exact: true,
        cacheDirectory: testCacheDirectory,
      }).map((result) => result.name),
    ).toEqual(["AccountService"]);
    expect(
      findDeclarations("UserService", {
        cwd: fixtureRoot,
        exact: true,
        cacheDirectory: testCacheDirectory,
      }),
    ).toEqual([]);

    writeFixtureSourceFiles();
  });

  test("invalidates the snapshot for extends changes and recovers from corrupt files", () => {
    const testCacheDirectory = createTestCacheDirectory();
    const packageConfigPath = join(packageADirectory, "tsconfig.json");
    const baseConfigPath = join(packageADirectory, "tsconfig.base.json");
    writeFileSync(baseConfigPath, JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(
      packageConfigPath,
      JSON.stringify({ extends: "./tsconfig.base.json", include: ["src/**/*.ts"] }),
    );

    findDeclarations("UserService", {
      cwd: fixtureRoot,
      exact: true,
      cacheDirectory: testCacheDirectory,
    });
    const cachePath = getProjectCachePath(
      resolveProjectTsConfig(fixtureRoot),
      testCacheDirectory,
    );
    const firstFingerprint = JSON.parse(readFileSync(cachePath, "utf8")).configFingerprint;

    writeFileSync(baseConfigPath, JSON.stringify({ compilerOptions: { strict: false } }));
    findDeclarations("UserService", {
      cwd: fixtureRoot,
      exact: true,
      cacheDirectory: testCacheDirectory,
    });
    const secondFingerprint = JSON.parse(readFileSync(cachePath, "utf8")).configFingerprint;
    expect(secondFingerprint).not.toBe(firstFingerprint);

    writeFileSync(cachePath, "not json");
    expect(
      findDeclarations("UserService", {
        cwd: fixtureRoot,
        exact: true,
        cacheDirectory: testCacheDirectory,
      }).map((result) => result.name),
    ).toEqual(["UserService"]);
    expect(() => JSON.parse(readFileSync(cachePath, "utf8"))).not.toThrow();

    writeFileSync(packageConfigPath, JSON.stringify({ include: ["src/**/*.ts"] }));
    rmSync(baseConfigPath, { force: true });
  });

  test("supports cache bypass, clear, and abandoned temporary files", () => {
    const testCacheDirectory = createTestCacheDirectory();
    const cachePath = getProjectCachePath(
      resolveProjectTsConfig(fixtureRoot),
      testCacheDirectory,
    );
    findDeclarations("UserService", {
      cwd: fixtureRoot,
      exact: true,
      cacheDirectory: testCacheDirectory,
    });
    const cachedBeforeBypass = readFileSync(cachePath, "utf8");

    writeFileSync(
      packageAFile,
      `export class BypassedService {}
export interface User {}
`,
    );
    expect(
      findDeclarations("BypassedService", {
        cwd: fixtureRoot,
        exact: true,
        cacheDirectory: testCacheDirectory,
        cacheMode: "bypass",
      }).map((result) => result.name),
    ).toEqual(["BypassedService"]);
    expect(readFileSync(cachePath, "utf8")).toBe(cachedBeforeBypass);

    writeFileSync(`${cachePath}.crashed.tmp`, "incomplete");
    expect(
      findDeclarations("BypassedService", {
        cwd: fixtureRoot,
        exact: true,
        cacheDirectory: testCacheDirectory,
        cacheMode: "clear",
      }).map((result) => result.name),
    ).toEqual(["BypassedService"]);
    expect(existsSync(`${cachePath}.crashed.tmp`)).toBe(true);

    writeFixtureSourceFiles();
  });

  test("isolates cache files by canonical project tsconfig", () => {
    const testCacheDirectory = createTestCacheDirectory();
    expect(
      getProjectCachePath(resolveProjectTsConfig(fixtureRoot), testCacheDirectory),
    ).not.toBe(
      getProjectCachePath(
        resolveProjectTsConfig(fixtureRoot, packageADirectory),
        testCacheDirectory,
      ),
    );
  });
});

describe("extractGlobalOptions", () => {
  test("removes --project before command routing", () => {
    expect(
      extractGlobalOptions(["find", "User", "--project=packages/a", "--json"]),
    ).toEqual({
      cacheMode: "default",
      commandInputs: ["find", "User", "--json"],
      projectPath: "packages/a",
    });
  });

  test("supports the short form and rejects duplicate projects", () => {
    expect(extractGlobalOptions(["-p", "packages/a", "find", "User"])).toEqual({
      cacheMode: "default",
      commandInputs: ["find", "User"],
      projectPath: "packages/a",
    });
    expect(() => extractGlobalOptions(["--project", "a", "--project", "b"])).toThrow(
      "--project may only be provided once.",
    );
  });

  test("parses cache controls and rejects conflicting ones", () => {
    expect(extractGlobalOptions(["find", "User", "--no-cache"])).toEqual({
      cacheMode: "bypass",
      commandInputs: ["find", "User"],
    });
    expect(extractGlobalOptions(["--clear-cache", "find", "User"])).toEqual({
      cacheMode: "clear",
      commandInputs: ["find", "User"],
    });
    expect(() => extractGlobalOptions(["--no-cache", "--clear-cache"])).toThrow(
      "cannot be combined",
    );
  });
});

function findDeclarations(
  searchTerm: string,
  options: FindOptions = {},
) {
  return findDeclarationsFromSource(searchTerm, {
    cacheDirectory,
    ...options,
  });
}

function createTestCacheDirectory(): string {
  return mkdtempSync(join(cacheDirectory, "case-"));
}

function writeFixture(): void {
  mkdirSync(join(packageADirectory, "src"), { recursive: true });
  mkdirSync(join(packageBDirectory, "src"), { recursive: true });
  writeFixtureSourceFiles();
}

function writeFixtureSourceFiles(): void {
  writeFileSync(
    join(fixtureRoot, "tsconfig.json"),
    JSON.stringify({
      files: [],
      references: [{ path: "./packages/a" }, { path: "./packages/b" }],
    }),
  );
  writeFileSync(
    join(packageADirectory, "tsconfig.json"),
    JSON.stringify({ include: ["src/**/*.ts"] }),
  );
  writeFileSync(
    join(packageBDirectory, "tsconfig.json"),
    JSON.stringify({ include: ["src/**/*.ts"] }),
  );
  writeFileSync(
    packageAFile,
    `export class UserService {
  findUser(user: User) {
    const localUser = {};
    return user;
  }
}

export interface User {}
`,
  );
  writeFileSync(
    join(packageBDirectory, "src", "settings.ts"),
    `export const userSettings = { userProperty: true };
`,
  );
  writeFileSync(
    join(packageADirectory, "src", "declared.d.ts"),
    `declare class DeclaredUser {}
`,
  );
}
