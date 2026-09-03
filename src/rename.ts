import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Project, Node, ts } from "ts-morph";
import {
  clearDeclarationIndexCache,
  getProjectSourceFiles,
  type DeclarationIndexOptions,
  type DeclarationRecord,
} from "./declaration-index.js";
import {
  resolvePointer,
  toPointerCandidate,
  type PointerCandidate,
  type ResolvedPointer,
} from "./pointer.js";

export type RenameOptions = DeclarationIndexOptions;

export type RenameResult = Readonly<{
  filesChanged: number;
  newName: string;
  oldName: string;
  referencesRenamed: number;
  pointer: string;
}>;

export type PointerAmbiguity = Readonly<{
  candidates: readonly PointerCandidate[];
}>;

export function isPointerAmbiguity(result: unknown): result is PointerAmbiguity {
  return (
    result !== null &&
    typeof result === "object" &&
    "candidates" in result
  );
}

/** Renames the declaration selected by a stateless project pointer. */
export function renameSymbol(
  pointer: string,
  newName: string,
  options: RenameOptions = {},
): RenameResult | PointerAmbiguity {
  if (!isTypeScriptIdentifier(newName)) {
    throw new Error(`'${newName}' is not a valid TypeScript identifier.`);
  }

  const resolution = resolveSinglePointer(pointer, options);
  if (isPointerAmbiguity(resolution)) {
    return resolution;
  }
  const { declaration } = resolution;

  ensureDeclarationIsCurrent(declaration);
  const project = new Project({
    tsConfigFilePath: declaration.ownerTsConfigPath,
    skipAddingFilesFromTsConfig: true,
  });
  for (const sourceFile of getProjectSourceFiles(resolution.rootTsConfigPath)) {
    project.addSourceFileAtPath(sourceFile.filePath);
  }

  const target = findTarget(project, declaration);
  if (target === undefined) {
    throw new Error(`Pointer '${pointer}' no longer identifies the recorded declaration.`);
  }
  if (!Node.isRenameable(target)) {
    throw new Error(`The declaration for pointer '${pointer}' cannot be renamed.`);
  }

  const referencesRenamed = project
    .getLanguageService()
    .findReferencesAsNodes(target).length;
  target.rename(newName, {
    renameInComments: false,
    renameInStrings: false,
    usePrefixAndSuffixText: true,
  });
  const filesChanged = project.getSourceFiles().filter((sourceFile) => !sourceFile.isSaved());
  project.saveSync();

  clearDeclarationIndexCache({
    cacheDirectory: options.cacheDirectory,
    cwd: options.cwd,
    projectPath: resolution.rootTsConfigPath,
  });

  return Object.freeze({
    pointer: resolution.pointer,
    oldName: declaration.name,
    newName,
    filesChanged: filesChanged.length,
    referencesRenamed,
  });
}

export function resolveSinglePointer(
  pointer: string,
  options: DeclarationIndexOptions = {},
): ResolvedPointer | PointerAmbiguity {
  const candidates = resolvePointer(pointer, options);
  if (candidates.length === 0) {
    throw new Error(`No declaration matches pointer '${pointer}'.`);
  }
  if (candidates.length > 1) {
    return Object.freeze({
      candidates: Object.freeze(candidates.map(toPointerCandidate)),
    });
  }
  return candidates[0]!;
}

function isTypeScriptIdentifier(value: string): boolean {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    value,
  );
  return (
    scanner.scan() === ts.SyntaxKind.Identifier &&
    scanner.getTokenText() === value &&
    scanner.scan() === ts.SyntaxKind.EndOfFileToken
  );
}

function ensureDeclarationIsCurrent(declaration: DeclarationRecord): void {
  if (!existsSync(declaration.filePath)) {
    throw new Error("The file recorded for this declaration no longer exists.");
  }
  const contentHash = createHash("sha256")
    .update(readFileSync(declaration.filePath))
    .digest("hex");
  if (contentHash !== declaration.contentHash) {
    throw new Error("The declaration file changed while resolving its pointer. Try again.");
  }
}

function findTarget(project: Project, declaration: DeclarationRecord): Node | undefined {
  const sourceFile = project.getSourceFile(declaration.filePath);
  if (sourceFile === undefined) {
    return undefined;
  }
  return sourceFile
    .getDescendants()
    .find((node) => isRecordedDeclaration(node, declaration));
}

function isRecordedDeclaration(
  node: Node,
  declaration: DeclarationRecord,
): node is Node & { getName(): string | undefined } {
  return (
    node.getKindName() === declaration.kind &&
    node.getStart() === declaration.start &&
    "getName" in node &&
    typeof (node as { getName?: unknown }).getName === "function" &&
    (node as { getName(): string | undefined }).getName() === declaration.name
  );
}
