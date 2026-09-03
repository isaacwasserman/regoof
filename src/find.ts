import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { minimatch } from "minimatch";
import {
  getDeclarationIndex,
  type CacheMode,
  type DeclarationIndexOptions,
} from "./declaration-index.js";
import { createCanonicalPointer } from "./pointer.js";

export {
  collectTsConfigPaths,
  getProjectCachePath,
  resolveProjectRoot,
  resolveProjectTsConfig,
} from "./declaration-index.js";
export type { CacheMode, DeclarationIndex, DeclarationRecord } from "./declaration-index.js";

export type FindResult = Readonly<{
  filePath: string;
  line: number;
  name: string;
  pointer?: string;
}>;

export type FindOptions = DeclarationIndexOptions &
  Readonly<{
    exact?: boolean;
    filePath?: string;
    includePointers?: boolean;
  }>;

/** Queries the reusable declaration index for matching names and file paths. */
export function findDeclarations(
  searchTerm: string,
  options: FindOptions = {},
): readonly FindResult[] {
  const index = getDeclarationIndex(options);
  const normalizedSearchTerm = searchTerm.toLocaleLowerCase();
  const filePattern = getFilePattern(index.rootDirectory, options.filePath);

  return index.declarations
    .flatMap((declaration) => {
      if (
        !matchesName(
          declaration.name,
          searchTerm,
          normalizedSearchTerm,
          options.exact === true,
        ) ||
        (filePattern !== undefined && !minimatch(declaration.filePath, filePattern))
      ) {
        return [];
      }
      const filePath = relative(index.rootDirectory, declaration.filePath);
      return [
        Object.freeze({
          name: declaration.name,
          filePath,
          line: declaration.line,
          ...(options.includePointers === true
            ? { pointer: createCanonicalPointer(filePath, declaration) }
            : {}),
        }),
      ];
    })
    .sort(compareResults);
}

function getFilePattern(rootDirectory: string, filePath: string | undefined): string | undefined {
  if (filePath?.includes("\0")) {
    throw new Error("filePath must not contain a null byte.");
  }
  if (filePath === undefined) {
    return undefined;
  }
  const pattern = isAbsolute(filePath) ? filePath : resolve(rootDirectory, filePath);
  return canonicalizePattern(pattern);
}

function canonicalizePattern(pattern: string): string {
  const firstGlob = pattern.search(/[!*?{[]/);
  if (firstGlob === -1) {
    return existsSync(pattern) ? realpathSync(pattern) : pattern;
  }

  const staticDirectory = dirname(pattern.slice(0, firstGlob));
  if (!existsSync(staticDirectory)) {
    return pattern;
  }
  return `${realpathSync(staticDirectory)}${pattern.slice(staticDirectory.length)}`;
}

function matchesName(
  name: string,
  searchTerm: string,
  normalizedSearchTerm: string,
  exact: boolean,
): boolean {
  return exact
    ? name === searchTerm
    : name.toLocaleLowerCase().includes(normalizedSearchTerm);
}

function compareResults(left: FindResult, right: FindResult): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.line - right.line ||
    left.name.localeCompare(right.name)
  );
}
