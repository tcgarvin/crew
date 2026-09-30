#!/usr/bin/env -S npx tsx

/**
 * `crew` CLI (W10): content validation, JSON Schema export and ASCII deck rendering.
 * Headless simulation running and offline generation scripts land here too as they're built.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ValidationIssue, contentJsonSchemas, loadBundle } from "@crew/content";
import type { DeckDefId } from "@crew/sim";
import { renderDeck } from "./render-deck";

export interface CliResult {
  readonly output: string;
  readonly exitCode: 0 | 1;
}

function ok(output: string): CliResult {
  return { output, exitCode: 0 };
}

function fail(output: string): CliResult {
  return { output, exitCode: 1 };
}

function formatIssue(issue: ValidationIssue): string {
  return `  [${issue.level}] ${issue.path.join(".")}: ${issue.message}`;
}

/** Repo root, resolved from this file's location so the CLI works from any cwd. */
function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../..");
}

export function runContentValidate(): CliResult {
  const result = loadBundle();
  if (result.ok) {
    const b = result.bundle;
    const counts = [
      `${Object.keys(b.decks).length} deck(s)`,
      `${Object.keys(b.machines).length} machine(s)`,
      `${Object.keys(b.items).length} item(s)`,
      `${Object.keys(b.crew).length} crew`,
      `${Object.keys(b.traits).length} trait(s)`,
      `${Object.keys(b.ports).length} port(s)`,
      `${Object.keys(b.scenarios).length} scenario(s)`,
    ].join(", ");
    return ok(`content validate: OK — ${counts} (hash ${b.hash})`);
  }
  const header = `content validate: FAILED — ${result.issues.length} issue(s)`;
  return fail([header, ...result.issues.map(formatIssue)].join("\n"));
}

export function runContentSchemas(outDir?: string): CliResult {
  const dir = outDir ?? path.join(repoRoot(), "packages/content/schema-json");
  mkdirSync(dir, { recursive: true });
  const schemas = contentJsonSchemas();
  const names = Object.keys(schemas);
  for (const name of names) {
    const file = path.join(dir, `${name}.schema.json`);
    writeFileSync(file, `${JSON.stringify(schemas[name as keyof typeof schemas], null, 2)}\n`);
  }
  return ok(`content schemas: wrote ${names.length} schema file(s) to ${dir}`);
}

export function runContentRenderDeck(deckId: string | undefined): CliResult {
  if (deckId === undefined) {
    return fail("content render-deck: missing <id>");
  }
  const result = loadBundle();
  if (!result.ok) {
    return fail(
      ["content render-deck: content failed validation", ...result.issues.map(formatIssue)].join(
        "\n",
      ),
    );
  }
  const deck = result.bundle.decks[deckId as DeckDefId];
  if (deck === undefined) {
    return fail(`content render-deck: unknown deck "${deckId}"`);
  }
  return ok(renderDeck(deck));
}

function runContent(sub: string | undefined, rest: readonly string[]): CliResult {
  switch (sub) {
    case "validate":
      return runContentValidate();
    case "schemas":
      return runContentSchemas();
    case "render-deck":
      return runContentRenderDeck(rest[0]);
    case undefined:
      return fail("crew content: no subcommand given (validate | schemas | render-deck <id>)");
    default:
      return fail(`crew content: unknown subcommand "${sub}"`);
  }
}

export function crew(argv: readonly string[]): CliResult {
  const [command, sub, ...rest] = argv;
  if (command === undefined) {
    return fail("crew: no command given (try `crew content validate`)");
  }
  if (command === "content") {
    return runContent(sub, rest);
  }
  return fail(`crew: unknown command "${command}"`);
}

const isMain = process.argv[1]?.endsWith("index.ts") ?? false;
if (isMain) {
  const result = crew(process.argv.slice(2));
  console.log(result.output);
  process.exitCode = result.exitCode;
}
