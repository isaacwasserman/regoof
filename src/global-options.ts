export type GlobalOptions = Readonly<{
  cacheMode: "default" | "bypass" | "clear";
  commandInputs: readonly string[];
  projectPath?: string;
}>;

/**
 * Extracts options that apply to every Regoof command before Stricli routes the
 * remaining inputs. Add future CLI-wide options here instead of duplicating
 * them in every command definition.
 */
export function extractGlobalOptions(
  inputs: readonly string[],
): GlobalOptions {
  const commandInputs: string[] = [];
  let cacheMode: GlobalOptions["cacheMode"] = "default";
  let projectPath: string | undefined;
  let argumentsEscaped = false;

  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    if (input === undefined) {
      continue;
    }

    if (argumentsEscaped) {
      commandInputs.push(input);
      continue;
    }
    if (input === "--") {
      argumentsEscaped = true;
      commandInputs.push(input);
      continue;
    }

    if (input === "--project" || input === "-p") {
      const value = inputs[index + 1];
      if (value === undefined) {
        throw new Error(`${input} requires a tsconfig path or project directory.`);
      }
      if (projectPath !== undefined) {
        throw new Error("--project may only be provided once.");
      }
      projectPath = value;
      index += 1;
      continue;
    }

    if (input.startsWith("--project=")) {
      const value = input.slice("--project=".length);
      if (value.length === 0) {
        throw new Error("--project requires a tsconfig path or project directory.");
      }
      if (projectPath !== undefined) {
        throw new Error("--project may only be provided once.");
      }
      projectPath = value;
      continue;
    }

    if (input === "--no-cache") {
      if (cacheMode === "clear") {
        throw new Error("--no-cache cannot be combined with --clear-cache.");
      }
      cacheMode = "bypass";
      continue;
    }

    if (input === "--clear-cache") {
      if (cacheMode === "bypass") {
        throw new Error("--clear-cache cannot be combined with --no-cache.");
      }
      cacheMode = "clear";
      continue;
    }

    commandInputs.push(input);
  }

  return { cacheMode, commandInputs, projectPath };
}
