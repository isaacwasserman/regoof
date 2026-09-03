#!/usr/bin/env bun

import {
  buildApplication,
  buildCommand,
  buildRouteMap,
  help,
  type CommandContext,
} from "@stricli/core";
import {
  type CacheMode,
  findDeclarations,
} from "./find.js";
import { peekSymbol } from "./peek.js";
import { isPointerAmbiguity, renameSymbol } from "./rename.js";

export type RegoofContext = CommandContext &
  Readonly<{
    cacheMode: CacheMode;
    projectPath?: string;
  }>;

type FindFlags = Readonly<{
  exact: boolean;
  includePointers: boolean;
  json: boolean;
}>;

type JsonFlags = Readonly<{
  json: boolean;
}>;

const findCommand = buildCommand<FindFlags, [string, string?], RegoofContext>({
  docs: {
    brief: "Find named TypeScript declarations in a project.",
  },
  parameters: {
    flags: {
      exact: {
        kind: "boolean",
        brief: "Match the declaration name exactly and case-sensitively.",
      },
      includePointers: {
        kind: "boolean",
        brief: "Include canonical stateless pointers in the results.",
      },
      json: {
        kind: "boolean",
        brief: "Print the matching declarations as JSON.",
      },
    },
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "Case-insensitive declaration-name search term.",
          placeholder: "searchTerm",
          parse: (input) => input,
        },
        {
          brief: "Optional project-root-relative or absolute file path/glob.",
          placeholder: "filePath",
          optional: true,
          parse: (input) => input,
        },
      ],
    },
  },
  func(flags, searchTerm, filePath) {
    try {
      const results = findDeclarations(searchTerm, {
        cacheMode: this.cacheMode,
        exact: flags.exact,
        filePath,
        includePointers: flags.includePointers,
        projectPath: this.projectPath,
      });
      writeStructuredResult(this, results, flags.json);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  },
});

const renameCommand = buildCommand<JsonFlags, [string, string], RegoofContext>({
  docs: {
    brief: "Rename a declaration selected by a stateless project pointer.",
  },
  parameters: {
    flags: {
      json: {
        kind: "boolean",
        brief: "Print the result or pointer candidates as JSON.",
      },
    },
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "Project-relative symbol pointer.",
          placeholder: "pointer",
          parse: (input) => input,
        },
        {
          brief: "New TypeScript identifier name.",
          placeholder: "newName",
          parse: (input) => input,
        },
      ],
    },
  },
  func(flags, pointer, newName) {
    try {
      const result = renameSymbol(pointer, newName, {
        cacheMode: this.cacheMode,
        projectPath: this.projectPath,
      });
      writeStructuredResult(
        this,
        isPointerAmbiguity(result) ? result.candidates : result,
        flags.json,
      );
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  },
});

const peekCommand = buildCommand<JsonFlags, [string, number?], RegoofContext>({
  docs: {
    brief: "Print syntax-highlighted source surrounding a project pointer.",
  },
  parameters: {
    flags: {
      json: {
        kind: "boolean",
        brief: "Print the result or pointer candidates as JSON.",
      },
    },
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "Project-relative symbol pointer.",
          placeholder: "pointer",
          parse: (input) => input,
        },
        {
          brief: "Number of surrounding lines to print (default: 5).",
          placeholder: "radius",
          optional: true,
          parse: (input) => {
            const radius = Number(input);
            if (!Number.isSafeInteger(radius) || radius < 0) {
              throw new Error("radius must be a non-negative integer.");
            }
            return radius;
          },
        },
      ],
    },
  },
  async func(flags, pointer, radius) {
    try {
      const result = await peekSymbol(pointer, radius, {
        cacheMode: this.cacheMode,
        projectPath: this.projectPath,
      });
      if (isPointerAmbiguity(result) || flags.json) {
        writeStructuredResult(
          this,
          isPointerAmbiguity(result) ? result.candidates : result,
          flags.json,
        );
      } else {
        this.process.stdout.write(`${result.output}\n`);
      }
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  },
});

export const app = buildApplication(
  buildRouteMap({
    routes: { find: findCommand, peek: peekCommand, rename: renameCommand },
    docs: {
      brief: "TypeScript project refactoring tools.",
      fullDescription:
        "Use --project <directory-or-tsconfig> (or -p) to select a project. Use --no-cache to bypass the local find index or --clear-cache to rebuild it.",
    },
  }),
  {
    name: "regoof",
  },
  {
    help: help({
      brief: "Print help information and exit.",
      formatting: {
        caseStyle: "original",
        onlyRequiredInUsageLine: false,
        useAliasInUsageLine: false,
      },
    }),
  },
);

function writeStructuredResult(
  context: RegoofContext,
  value: Readonly<Record<string, unknown>> | readonly Readonly<Record<string, unknown>>[],
  json: boolean,
): void {
  if (json) {
    context.process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  console.table(Array.isArray(value) ? value : [value]);
}
