#!/usr/bin/env -S npx tsx

/**
 * Headless runner, content validation and offline generation scripts.
 * Placeholder `crew` command for the scaffold.
 */
export function crew(argv: readonly string[]): string {
  const [command] = argv;
  if (command === undefined) {
    return "crew: no command given (placeholder CLI)";
  }
  return `crew: unknown command "${command}" (placeholder CLI)`;
}

const isMain = process.argv[1]?.endsWith("index.ts") ?? false;
if (isMain) {
  console.log(crew(process.argv.slice(2)));
}
