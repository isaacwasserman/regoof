import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { highlightANSI } from "@speed-highlight/core";
import theme from "@speed-highlight/core/themes/default.js";
import type { DeclarationIndexOptions, DeclarationRecord } from "./declaration-index.js";
import {
  isPointerAmbiguity,
  resolveSinglePointer,
  type PointerAmbiguity,
} from "./rename.js";

const DEFAULT_RADIUS = 5;
const TARGET_LINE_BACKGROUND = "\u001B[48;5;236m";
const RESET = "\u001B[0m";

export type PeekOptions = DeclarationIndexOptions;

export type PeekResult = Readonly<{
  endLine: number;
  filePath: string;
  line: number;
  output: string;
  pointer: string;
  startLine: number;
}>;

/** Renders a syntax-highlighted source window around a stateless project pointer. */
export async function peekSymbol(
  pointer: string,
  radius = DEFAULT_RADIUS,
  options: PeekOptions = {},
): Promise<PeekResult | PointerAmbiguity> {
  if (!Number.isSafeInteger(radius) || radius < 0) {
    throw new Error("radius must be a non-negative integer.");
  }

  const resolution = resolveSinglePointer(pointer, options);
  if (isPointerAmbiguity(resolution)) {
    return resolution;
  }

  const source = readCurrentSource(resolution.declaration);
  const lines = source.split(/\r\n|\r|\n/);
  const line = resolution.declaration.line;
  const startLine = Math.max(1, line - radius);
  const endLine = Math.min(lines.length, line + radius);
  const snippet = lines.slice(startLine - 1, endLine).join("\n");
  const highlightedLines = (await highlightANSI(snippet, "ts", theme)).split("\n");
  const lineNumberWidth = String(endLine).length;
  const filePath = relative(
    dirname(resolution.rootTsConfigPath),
    resolution.declaration.filePath,
  );
  const renderedLines = highlightedLines.map((highlightedLine, index) => {
    const sourceLine = startLine + index;
    const isTarget = sourceLine === line;
    const marker = isTarget ? "\u001B[1;33m>\u001B[0m" : " ";
    const gutter = `${marker} ${String(sourceLine).padStart(lineNumberWidth)} | `;
    return `${gutter}${isTarget ? highlightTargetLine(highlightedLine) : highlightedLine}`;
  });

  return Object.freeze({
    pointer: resolution.pointer,
    filePath,
    line,
    startLine,
    endLine,
    output: `${filePath}:${line}\n${renderedLines.join("\n")}`,
  });
}

function readCurrentSource(declaration: DeclarationRecord): string {
  if (!existsSync(declaration.filePath)) {
    throw new Error("The file recorded for this declaration no longer exists.");
  }
  const source = readFileSync(declaration.filePath, "utf8");
  const contentHash = createHash("sha256").update(source).digest("hex");
  if (contentHash !== declaration.contentHash) {
    throw new Error("The declaration file changed while resolving its pointer. Try again.");
  }
  return source;
}

function highlightTargetLine(highlightedLine: string): string {
  return `${TARGET_LINE_BACKGROUND}${highlightedLine.replaceAll(RESET, `${RESET}${TARGET_LINE_BACKGROUND}`)}${RESET}`;
}
