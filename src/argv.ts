const COMMAND_NAMES = new Set(["find", "recent", "open", "inspect", "export", "admin"]);
const VALUE_OPTIONS = new Set(["--source", "--source-root", "--source-kind", "--index-db"]);
const BOOLEAN_OPTIONS = new Set(["--json", "--json-pretty", "--refresh"]);

function readOptionTokens(
  args: string[],
  startIndex: number,
): { tokens: string[]; nextIndex: number; incomplete?: boolean } | null {
  const token = args[startIndex];
  if (!token) {
    return null;
  }

  const [optionName] = token.split("=", 1);
  if (!optionName) {
    return null;
  }

  if (BOOLEAN_OPTIONS.has(optionName)) {
    return { tokens: [token], nextIndex: startIndex + 1 };
  }

  if (VALUE_OPTIONS.has(optionName)) {
    if (token.includes("=")) {
      return { tokens: [token], nextIndex: startIndex + 1 };
    }
    const value = args[startIndex + 1];
    if (value === undefined) {
      return { tokens: [token], nextIndex: startIndex + 1, incomplete: true };
    }
    return { tokens: [token, value], nextIndex: startIndex + 2 };
  }

  return null;
}

export function normalizeCliArgs(argv: string[]): string[] {
  const commandIndex = argv.findIndex((token) => COMMAND_NAMES.has(token));
  if (commandIndex <= 2) {
    return argv;
  }

  const prefix = argv.slice(0, 2);
  const beforeCommand = argv.slice(2, commandIndex);
  const commandAndRest = argv.slice(commandIndex);

  const hoistedOptions: string[] = [];
  const untouchedPrefixArgs: string[] = [];

  for (let index = 0; index < beforeCommand.length;) {
    const parsed = readOptionTokens(beforeCommand, index);
    if (!parsed) {
      untouchedPrefixArgs.push(beforeCommand[index] ?? "");
      index += 1;
      continue;
    }
    if (parsed.incomplete) {
      return argv;
    }
    hoistedOptions.push(...parsed.tokens);
    index = parsed.nextIndex;
  }

  if (hoistedOptions.length === 0) {
    return argv;
  }

  return [...prefix, ...untouchedPrefixArgs, ...commandAndRest, ...hoistedOptions];
}
