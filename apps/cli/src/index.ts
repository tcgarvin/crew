#!/usr/bin/env -S npx tsx

/**
 * `crew` CLI (W10): content validation, JSON Schema export and ASCII deck rendering.
 * Headless simulation running and offline generation scripts land here too as they're built.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ValidationIssue, contentJsonSchemas, loadBundle } from "@crew/content";
import { type ContentBundle, type DeckDefId, type DockDefId, checkDockFitsDeck } from "@crew/sim";
import { runPacingCli } from "./pacing";
import { renderDeck } from "./render-deck";
import { renderDockReadme } from "./render-dock";

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

function validationFailure(command: string, issues: readonly ValidationIssue[]): CliResult {
  return fail([`${command}: content failed validation`, ...issues.map(formatIssue)].join("\n"));
}

/** Repo root, resolved from this file's location so the CLI works from any cwd. */
function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../..");
}

/**
 * Graft every dock onto every deck with the sim's own nav builder, which `packages/content` may
 * not call (types only). Content validation applies the same rules; this catches the two
 * drifting apart, as the sim would throw at `attachDock`.
 */
export function dockGraftIssues(bundle: ContentBundle): string[] {
  const out: string[] = [];
  for (const dockId of Object.keys(bundle.docks ?? {}) as DockDefId[]) {
    for (const deckId of Object.keys(bundle.decks) as DeckDefId[]) {
      try {
        checkDockFitsDeck(bundle, deckId, dockId);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        out.push(`  [graft] docks.${dockId} on ${deckId}: ${error.message}`);
      }
    }
  }
  return out;
}

export function runContentValidate(): CliResult {
  const result = loadBundle();
  if (result.ok) {
    const b = result.bundle;
    const graft = dockGraftIssues(b);
    if (graft.length > 0) {
      return fail([`content validate: FAILED — ${graft.length} issue(s)`, ...graft].join("\n"));
    }
    const counts = [
      `${Object.keys(b.decks).length} deck(s)`,
      `${Object.keys(b.machines).length} machine(s)`,
      `${Object.keys(b.items).length} item(s)`,
      `${Object.keys(b.crew).length} crew`,
      `${Object.keys(b.traits).length} trait(s)`,
      `${Object.keys(b.ports).length} port(s)`,
      `${Object.keys(b.scenarios).length} scenario(s)`,
      `${Object.keys(b.docks ?? {}).length} dock(s)`,
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
    return validationFailure("content render-deck", result.issues);
  }
  const deck = result.bundle.decks[deckId as DeckDefId];
  if (deck === undefined) {
    return fail(`content render-deck: unknown deck "${deckId}"`);
  }
  return ok(renderDeck(deck));
}

/** `dock.crossroads_hub` → `crossroads-hub`, the dock's file name under `data/docks/`. */
export function dockFileStem(dockId: string): string {
  return dockId.replace(/^dock\./, "").replaceAll("_", "-");
}

export function docksDir(): string {
  return path.join(repoRoot(), "packages/content/data/docks");
}

/**
 * Renders a dock with every deck in the bundle composited in its berth box (one map per deck) and
 * writes `<stem>.README.md` next to its JSON (or into `outDir`).
 */
export function runContentRenderDock(dockId: string | undefined, outDir?: string): CliResult {
  if (dockId === undefined) {
    return fail("content render-dock: missing <id>");
  }
  const result = loadBundle();
  if (!result.ok) {
    return validationFailure("content render-dock", result.issues);
  }
  const bundle = result.bundle;
  const dock = bundle.docks?.[dockId as DockDefId];
  if (dock === undefined) {
    return fail(`content render-dock: unknown dock "${dockId}"`);
  }
  const decks = Object.values(bundle.decks);
  const port = bundle.ports[dock.portId];
  if (port === undefined) {
    return fail(`content render-dock: dock "${dockId}" names unknown port "${dock.portId}"`);
  }
  const stem = dockFileStem(dock.id);
  const source = path.join(docksDir(), `${stem}.json`);
  if (!existsSync(source)) {
    return fail(`content render-dock: expected "${dock.id}" in ${source}`);
  }
  const readme = renderDockReadme(dock, decks, port, `${stem}.json`);
  const dir = outDir ?? docksDir();
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${stem}.README.md`);
  writeFileSync(target, readme);
  return ok(`${readme}\ncontent render-dock: wrote ${target}`);
}

function runContent(sub: string | undefined, rest: readonly string[]): CliResult {
  switch (sub) {
    case "validate":
      return runContentValidate();
    case "schemas":
      return runContentSchemas();
    case "render-deck":
      return runContentRenderDeck(rest[0]);
    case "render-dock":
      return runContentRenderDock(rest[0]);
    case undefined:
      return fail(
        "crew content: no subcommand given (validate | schemas | render-deck <id> | render-dock <id>)",
      );
    default:
      return fail(`crew content: unknown subcommand "${sub}"`);
  }
}

export function crew(argv: readonly string[]): CliResult {
  const [command, sub, ...rest] = argv;
  if (command === undefined) {
    return fail("crew: no command given (try `crew content validate` or `crew pacing`)");
  }
  if (command === "content") {
    return runContent(sub, rest);
  }
  if (command === "pacing") {
    return runPacingCli(sub === undefined ? rest : [sub, ...rest]);
  }
  return fail(`crew: unknown command "${command}"`);
}

const isMain = process.argv[1]?.endsWith("index.ts") ?? false;
if (isMain) {
  const argv = process.argv.slice(2);
  // W9: `crew narrator …` is async (it may call a model), so it is dispatched here.
  const pending =
    argv[0] === "narrator"
      ? import("./narrator-eval").then((m) => m.runNarratorCli(argv[1], argv.slice(2)))
      : Promise.resolve(crew(argv));
  pending.then((result) => {
    console.log(result.output);
    process.exitCode = result.exitCode;
  });
}
