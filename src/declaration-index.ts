import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import envPaths from "env-paths";
import { Project, ts, type Node } from "ts-morph";

const CACHE_VERSION = 2;

export type CacheMode = "default" | "bypass" | "clear";

export type DeclarationRecord = Readonly<{
  contentHash: string;
  filePath: string;
  kind: string;
  line: number;
  name: string;
  ownerTsConfigPath: string;
  start: number;
}>;

export type DeclarationIndexOptions = Readonly<{
  cacheDirectory?: string;
  cacheMode?: CacheMode;
  cwd?: string;
  projectPath?: string;
}>;

type CachedFile = Readonly<{
  contentHash: string;
  declarations: readonly Omit<
    DeclarationRecord,
    "contentHash" | "filePath" | "ownerTsConfigPath"
  >[];
}>;

type CacheSnapshot = Readonly<{
  configFingerprint: string;
  files: Readonly<Record<string, CachedFile>>;
  rootTsConfigPath: string;
  version: number;
}>;

type ProjectConfig = Readonly<{
  filePaths: readonly string[];
  tsConfigPath: string;
}>;

export type ProjectSourceFile = Readonly<{
  filePath: string;
  tsConfigPath: string;
}>;

export type DeclarationIndex = Readonly<{
  declarations: readonly DeclarationRecord[];
  rootDirectory: string;
  rootTsConfigPath: string;
}>;

/** Finds the closest tsconfig.json at or above a working directory. */
export function resolveProjectRoot(cwd = process.cwd()): string {
  let directory = resolve(cwd);

  while (true) {
    if (existsSync(join(directory, "tsconfig.json"))) {
      return directory;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`Could not find a tsconfig.json at or above '${cwd}'.`);
    }

    directory = parent;
  }
}

/** Resolves an explicit project path or discovers the nearest tsconfig.json. */
export function resolveProjectTsConfig(
  cwd = process.cwd(),
  projectPath?: string,
): string {
  if (projectPath === undefined) {
    return canonicalPath(join(resolveProjectRoot(cwd), "tsconfig.json"));
  }

  const resolvedProjectPath = resolve(cwd, projectPath);
  const tsConfigPath = resolvedProjectPath.endsWith(".json")
    ? resolvedProjectPath
    : join(resolvedProjectPath, "tsconfig.json");
  if (!existsSync(tsConfigPath)) {
    throw new Error(`Project tsconfig does not exist: '${tsConfigPath}'.`);
  }

  return canonicalPath(tsConfigPath);
}

/** Resolves a solution tsconfig, project references, and local extends files. */
export function collectTsConfigPaths(rootTsConfigPath: string): readonly string[] {
  const collected: string[] = [];
  const visited = new Set<string>();

  const visit = (inputPath: string): void => {
    const tsConfigPath = resolveTsConfigPath(inputPath);
    if (visited.has(tsConfigPath)) {
      return;
    }
    visited.add(tsConfigPath);

    const parsed = parseTsConfig(tsConfigPath);
    collected.push(tsConfigPath);

    for (const extendedConfigPath of getExtendedConfigPaths(tsConfigPath, parsed.raw)) {
      visit(extendedConfigPath);
    }
    for (const projectReference of parsed.projectReferences ?? []) {
      visit(projectReference.path);
    }
  };

  visit(rootTsConfigPath);
  return collected;
}

/** Returns the stable cache location for a project's canonical root tsconfig. */
export function getProjectCachePath(
  rootTsConfigPath: string,
  cacheDirectory = envPaths("regoof").cache,
): string {
  const cacheKey = hashText(canonicalPath(rootTsConfigPath));
  return join(cacheDirectory, `${cacheKey}.json`);
}

/** Deletes only the snapshot belonging to the selected project. */
export function clearDeclarationIndexCache(
  options: Omit<DeclarationIndexOptions, "cacheMode"> = {},
): void {
  const rootTsConfigPath = resolveProjectTsConfig(options.cwd, options.projectPath);
  rmSync(getProjectCachePath(rootTsConfigPath, options.cacheDirectory), {
    force: true,
  });
}

/**
 * Produces a complete, reusable declaration index. Cache entries store facts,
 * never ts-morph nodes, so each command gets immutable plain data.
 */
export function getDeclarationIndex(
  options: DeclarationIndexOptions = {},
): DeclarationIndex {
  const cacheMode = options.cacheMode ?? "default";
  const rootTsConfigPath = resolveProjectTsConfig(options.cwd, options.projectPath);
  const rootDirectory = dirname(rootTsConfigPath);
  const projectConfigs = getProjectConfigs(rootTsConfigPath);
  const configFingerprint = getConfigFingerprint(rootTsConfigPath);
  const cachePath = getProjectCachePath(rootTsConfigPath, options.cacheDirectory);

  if (cacheMode === "clear") {
    rmSync(cachePath, { force: true });
  }

  const snapshot =
    cacheMode === "default" ? readSnapshot(cachePath, rootTsConfigPath, configFingerprint) : undefined;
  const nextFiles: Record<string, CachedFile> = {};
  const sourceFiles = new Map<string, string>();

  for (const projectConfig of projectConfigs) {
    for (const sourceFilePath of projectConfig.filePaths) {
      sourceFiles.set(sourceFilePath, projectConfig.tsConfigPath);
    }
  }

  const projects = new Map<string, Project>();
  let changed = snapshot === undefined;
  for (const [sourceFilePath, tsConfigPath] of sourceFiles) {
    const contentHash = hashFile(sourceFilePath);
    const cachedFile = snapshot?.files[sourceFilePath];
    if (cachedFile?.contentHash === contentHash) {
      nextFiles[sourceFilePath] = cachedFile;
      continue;
    }

    changed = true;
    const project =
      projects.get(tsConfigPath) ??
      new Project({ tsConfigFilePath: tsConfigPath, skipAddingFilesFromTsConfig: true });
    projects.set(tsConfigPath, project);

    const sourceFile = project.addSourceFileAtPath(sourceFilePath);
    nextFiles[sourceFilePath] = {
      contentHash,
      declarations:
        sourceFile.isDeclarationFile() || sourceFile.isFromExternalLibrary()
          ? []
          : extractDeclarations(sourceFile),
    };
    sourceFile.forget();
  }

  if (snapshot !== undefined && Object.keys(snapshot.files).length !== sourceFiles.size) {
    changed = true;
  }
  const nextSnapshot: CacheSnapshot = {
    version: CACHE_VERSION,
    rootTsConfigPath,
    configFingerprint,
    files: nextFiles,
  };
  if (cacheMode !== "bypass" && changed) {
    writeSnapshot(cachePath, nextSnapshot);
  }

  const declarations = Object.entries(nextFiles)
    .flatMap(([filePath, cachedFile]) => {
      const ownerTsConfigPath = sourceFiles.get(filePath);
      if (ownerTsConfigPath === undefined) {
        throw new Error(`Missing owning tsconfig for '${filePath}'.`);
      }
      return cachedFile.declarations.map((declaration) => ({
        ...declaration,
        contentHash: cachedFile.contentHash,
        filePath,
        ownerTsConfigPath,
      }));
    })
    .sort(compareDeclarations)
    .map((declaration) => Object.freeze(declaration));

  return Object.freeze({
    declarations: Object.freeze(declarations),
    rootDirectory,
    rootTsConfigPath,
  });
}

/** Returns each project source once, paired with the tsconfig that owns it. */
export function getProjectSourceFiles(
  rootTsConfigPath: string,
): readonly ProjectSourceFile[] {
  return getProjectConfigs(rootTsConfigPath).flatMap((projectConfig) =>
    projectConfig.filePaths.map((filePath) => ({
      filePath,
      tsConfigPath: projectConfig.tsConfigPath,
    })),
  );
}

function getProjectConfigs(rootTsConfigPath: string): readonly ProjectConfig[] {
  const configPaths = collectProjectReferencePaths(rootTsConfigPath);
  const seenSourceFiles = new Set<string>();

  return configPaths.map((tsConfigPath) => {
    const filePaths = parseTsConfig(tsConfigPath).fileNames
      .map(canonicalPath)
      .filter((filePath) => !filePath.endsWith(".d.ts"))
      .filter((filePath) => {
        if (seenSourceFiles.has(filePath)) {
          return false;
        }
        seenSourceFiles.add(filePath);
        return true;
      });
    return { tsConfigPath, filePaths };
  });
}

function getConfigFingerprint(rootTsConfigPath: string): string {
  return hashText(
    collectTsConfigPaths(rootTsConfigPath)
      .map((tsConfigPath) => `${tsConfigPath}\0${hashFile(tsConfigPath)}`)
      .join("\n"),
  );
}

function collectProjectReferencePaths(rootTsConfigPath: string): readonly string[] {
  const collected: string[] = [];
  const visited = new Set<string>();

  const visit = (inputPath: string): void => {
    const tsConfigPath = resolveTsConfigPath(inputPath);
    if (visited.has(tsConfigPath)) {
      return;
    }
    visited.add(tsConfigPath);
    collected.push(tsConfigPath);
    for (const projectReference of parseTsConfig(tsConfigPath).projectReferences ?? []) {
      visit(projectReference.path);
    }
  };

  visit(rootTsConfigPath);
  return collected;
}

function getExtendedConfigPaths(tsConfigPath: string, rawConfig: unknown): readonly string[] {
  if (
    rawConfig === null ||
    typeof rawConfig !== "object" ||
    !("extends" in rawConfig)
  ) {
    return [];
  }
  const rawExtends = rawConfig.extends;
  const extendsValues = Array.isArray(rawExtends) ? rawExtends : [rawExtends];

  return extendsValues.flatMap((value) => {
    if (typeof value !== "string") {
      return [];
    }
    const candidate = value.endsWith(".json") ? value : `${value}.json`;
    const resolved = resolve(dirname(tsConfigPath), candidate);
    return existsSync(resolved) ? [resolved] : [];
  });
}

function readSnapshot(
  cachePath: string,
  rootTsConfigPath: string,
  configFingerprint: string,
): CacheSnapshot | undefined {
  try {
    const snapshot: unknown = JSON.parse(readFileSync(cachePath, "utf8"));
    if (!isValidSnapshot(snapshot, rootTsConfigPath, configFingerprint)) {
      return undefined;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function isValidSnapshot(
  value: unknown,
  rootTsConfigPath: string,
  configFingerprint: string,
): value is CacheSnapshot {
  return (
    value !== null &&
    typeof value === "object" &&
    "version" in value &&
    value.version === CACHE_VERSION &&
    "rootTsConfigPath" in value &&
    value.rootTsConfigPath === rootTsConfigPath &&
    "configFingerprint" in value &&
    value.configFingerprint === configFingerprint &&
    "files" in value &&
    value.files !== null &&
    typeof value.files === "object" &&
    Object.values(value.files).every(isValidCachedFile)
  );
}

function isValidCachedFile(value: unknown): value is CachedFile {
  return (
    value !== null &&
    typeof value === "object" &&
    "contentHash" in value &&
    typeof value.contentHash === "string" &&
    "declarations" in value &&
    Array.isArray(value.declarations) &&
    value.declarations.every(
      (declaration) =>
        declaration !== null &&
        typeof declaration === "object" &&
        "kind" in declaration &&
        typeof declaration.kind === "string" &&
        "line" in declaration &&
        typeof declaration.line === "number" &&
        "name" in declaration &&
        typeof declaration.name === "string" &&
        "start" in declaration &&
        typeof declaration.start === "number",
    )
  );
}

function writeSnapshot(cachePath: string, snapshot: CacheSnapshot): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(snapshot));
  renameSync(temporaryPath, cachePath);
}

function extractDeclarations(
  sourceFile: ReturnType<Project["addSourceFileAtPath"]>,
): CachedFile["declarations"] {
  const declarations: CachedFile["declarations"][number][] = [];
  for (const node of sourceFile.getDescendants()) {
    if (!isNamedDeclaration(node)) {
      continue;
    }
    const name = node.getName();
    if (name === undefined) {
      continue;
    }
    declarations.push({
      name,
      kind: node.getKindName(),
      start: node.getStart(),
      line: node.getStartLineNumber(),
    });
  }
  return declarations;
}

function resolveTsConfigPath(inputPath: string): string {
  const absolutePath = resolve(inputPath);
  const tsConfigPath = absolutePath.endsWith(".json")
    ? absolutePath
    : join(absolutePath, "tsconfig.json");
  if (!existsSync(tsConfigPath)) {
    throw new Error(`Referenced tsconfig does not exist: '${tsConfigPath}'.`);
  }
  return canonicalPath(tsConfigPath);
}

function parseTsConfig(tsConfigPath: string): ts.ParsedCommandLine {
  const readResult = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
  if (readResult.error !== undefined) {
    throw new Error(
      `Could not read '${tsConfigPath}': ${formatDiagnostic(readResult.error)}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    dirname(tsConfigPath),
    undefined,
    tsConfigPath,
  );
  const errors = parsed.errors.filter((error) => error.code !== 18003);
  if (errors.length > 0) {
    throw new Error(
      `Could not parse '${tsConfigPath}': ${errors
        .map(formatDiagnostic)
        .join("\n")}`,
    );
  }
  return parsed;
}

function canonicalPath(filePath: string): string {
  return realpathSync(resolve(filePath));
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

function isNamedDeclaration(
  node: Node,
): node is Node & { getName(): string | undefined } {
  const isDeclaration = (ts as unknown as {
    isDeclaration(compilerNode: ts.Node): boolean;
  }).isDeclaration;
  return (
    isDeclaration(node.compilerNode) &&
    "getName" in node &&
    typeof (node as { getName?: unknown }).getName === "function"
  );
}

function compareDeclarations(left: DeclarationRecord, right: DeclarationRecord): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.start - right.start ||
    left.name.localeCompare(right.name) ||
    left.kind.localeCompare(right.kind)
  );
}
