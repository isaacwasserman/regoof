# regoof

A CLI for discovering and refactoring TypeScript declarations across projects and monorepos.

## Usage

Run directly with `npx` or `bunx` — no installation required:

```bash
npx regoof <command>
bunx regoof <command>
```

### `find` — search for declarations

```bash
npx regoof find <searchTerm> [filePath] [--exact] [--json] [--includePointers]
```

Searches for named declarations matching `searchTerm` (case-insensitive substring by default). Pass `--exact` for case-sensitive exact matching. Optionally narrow by file path or glob.

Results include the declaration name, file path, and line number. Add `--includePointers` to get canonical pointers (e.g. `src/types.ts:21:UserConfig`) for use with `rename` and `peek`.

### `rename` — rename a declaration and its references

```bash
npx regoof rename <pointer> <newName> [--json]
```

Renames a declaration and all its references across the project, including across package boundaries in monorepos. Uses ts-morph for accurate TypeScript-aware renaming.

### `peek` — view a declaration in context

```bash
npx regoof peek <pointer> [radius] [--json]
```

Prints a syntax-highlighted window around a declaration. `radius` controls the number of surrounding lines (default: 5).

### Pointers

`rename` and `peek` accept stateless pointers in three forms:

| Form | Example |
|------|---------|
| `SymbolName` | `UserConfig` |
| `glob:SymbolName` | `**/types.ts:UserConfig` |
| `glob:line:SymbolName` | `src/types.ts:21:UserConfig` |

Use the shortest form that resolves to a single declaration. If a pointer is ambiguous, regoof prints the matching candidates.

## Global options

| Flag | Description |
|------|-------------|
| `--project`, `-p` | Set the project directory or tsconfig path |
| `--no-cache` | Bypass the declaration index cache for this run |
| `--clear-cache` | Discard and rebuild the project's cached index |

Regoof loads the nearest `tsconfig.json` and follows project references automatically. The declaration index is stored in the OS cache directory for fast repeat queries.
