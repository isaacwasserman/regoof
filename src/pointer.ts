import { relative } from "node:path";
import { minimatch } from "minimatch";
import {
  getDeclarationIndex,
  type DeclarationIndexOptions,
  type DeclarationRecord,
} from "./declaration-index.js";

export type ParsedPointer = Readonly<{
  filePattern?: string;
  line?: number;
  name: string;
}>;

export type PointerCandidate = Readonly<{
  filePath: string;
  line: number;
  name: string;
  pointer: string;
}>;

export type ResolvedPointer = PointerCandidate &
  Readonly<{
    declaration: DeclarationRecord;
    rootTsConfigPath: string;
  }>;

/** Parses a self-contained pointer into its optional file and line selectors. */
export function parsePointer(pointer: string): ParsedPointer {
  if (pointer.length === 0 || pointer.includes("\0")) {
    throw new Error("pointer must contain a symbol name and no null bytes.");
  }

  const nameSeparator = pointer.lastIndexOf(":");
  if (nameSeparator === -1) {
    return { name: pointer };
  }
  const name = pointer.slice(nameSeparator + 1);
  const prefix = pointer.slice(0, nameSeparator);
  if (name.length === 0 || prefix.length === 0) {
    throw new Error("pointer must use SymbolName, globPattern:SymbolName, or globPattern:line:SymbolName.");
  }

  const lineSeparator = prefix.lastIndexOf(":");
  if (lineSeparator === -1) {
    return { filePattern: prefix, name };
  }
  const possibleLine = prefix.slice(lineSeparator + 1);
  if (!/^\d+$/.test(possibleLine)) {
    return { filePattern: prefix, name };
  }
  const line = Number(possibleLine);
  const filePattern = prefix.slice(0, lineSeparator);
  if (!Number.isSafeInteger(line) || line < 1 || filePattern.length === 0) {
    throw new Error("pointer line numbers must be positive integers.");
  }
  return { filePattern, line, name };
}

/** Resolves a pointer against the current project declaration index. */
export function resolvePointer(
  pointer: string,
  options: DeclarationIndexOptions = {},
): readonly ResolvedPointer[] {
  const parsed = parsePointer(pointer);
  const index = getDeclarationIndex(options);

  return index.declarations
    .flatMap((declaration) => {
      const filePath = relative(index.rootDirectory, declaration.filePath);
      if (
        declaration.name !== parsed.name ||
        (parsed.line !== undefined && declaration.line !== parsed.line) ||
        (parsed.filePattern !== undefined && !minimatch(filePath, parsed.filePattern))
      ) {
        return [];
      }
      return [
        Object.freeze({
          declaration,
          rootTsConfigPath: index.rootTsConfigPath,
          filePath,
          line: declaration.line,
          name: declaration.name,
          pointer: createCanonicalPointer(filePath, declaration),
        }),
      ];
    })
    .sort(compareCandidates);
}

/** Creates an unambiguous, project-root-relative pointer for a declaration. */
export function createCanonicalPointer(
  filePath: string,
  declaration: Pick<DeclarationRecord, "line" | "name">,
): string {
  return `${filePath}:${declaration.line}:${declaration.name}`;
}

export function toPointerCandidate(candidate: ResolvedPointer): PointerCandidate {
  const { declaration: _declaration, rootTsConfigPath: _rootTsConfigPath, ...result } = candidate;
  return Object.freeze(result);
}

function compareCandidates(left: ResolvedPointer, right: ResolvedPointer): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.declaration.start - right.declaration.start ||
    left.name.localeCompare(right.name) ||
    left.declaration.kind.localeCompare(right.declaration.kind)
  );
}
