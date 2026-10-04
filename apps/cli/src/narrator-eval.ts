/**
 * `crew narrator …` (W9): the narrator eval harness.
 *
 * - `crew narrator fixtures [outDir]` builds the stored `NarratorRequest` fixtures from the real
 *   content through the headless kernel and writes them as JSON (default
 *   `packages/narrator/fixtures/`).
 * - `crew narrator eval <fixture.json> [--notes <notes.json>]` runs `runNarrator` against one
 *   fixture and prints the digest, the raw model output and plan, the translated commands, the
 *   dropped intents, the card and the notes update.
 *
 * The model transport is not wired yet (W9 decision: OpenRouter transport, pending); until it is,
 * eval exercises the null fallback end to end and says so.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundle } from "@crew/content";
import {
  type ModelTransport,
  type NarratorRequest,
  approachRequest,
  farCaptainAshoreRequest,
  passengerOverdueRequest,
  quietTooLongRequest,
  runNarratorWithTrace,
  stageDockRequest,
} from "@crew/narrator";
import type { CliResult } from "./index";

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function content() {
  const result = loadBundle();
  if (!result.ok) throw new Error("content failed validation; run `crew content validate`");
  return result.bundle;
}

export function runNarratorFixtures(outDir?: string): CliResult {
  const dir = outDir ?? path.join(repoRoot(), "packages/narrator/fixtures");
  mkdirSync(dir, { recursive: true });
  const bundle = content();
  const fixtures: Record<string, NarratorRequest> = {
    "approach.json": approachRequest(bundle),
    "stage-dock.json": stageDockRequest(bundle),
    "quiet-too-long-pump.json": quietTooLongRequest(bundle),
    "far-captain-ashore.json": farCaptainAshoreRequest(bundle),
    "passenger-overdue.json": passengerOverdueRequest(bundle),
  };
  for (const [name, request] of Object.entries(fixtures)) {
    writeFileSync(path.join(dir, name), `${JSON.stringify(request, null, 2)}\n`);
  }
  return {
    output: `narrator fixtures: wrote ${Object.keys(fixtures).join(", ")} to ${dir}`,
    exitCode: 0,
  };
}

function section(title: string, body: string): string {
  return `\n=== ${title} ===\n${body}`;
}

export async function runNarratorEval(
  file: string | undefined,
  notesFile: string | undefined,
  transport?: ModelTransport,
): Promise<CliResult> {
  if (file === undefined)
    return { output: "crew narrator eval: missing <fixture.json>", exitCode: 1 };
  const request = JSON.parse(readFileSync(file, "utf8")) as NarratorRequest;
  const notes = notesFile === undefined ? undefined : JSON.parse(readFileSync(notesFile, "utf8"));
  const run = await runNarratorWithTrace(request, {
    gameId: request.gameId,
    content: content(),
    ...(notes === undefined ? {} : { notes }),
    ...(transport === undefined ? {} : { transport }),
  });
  const { response, trace } = run;
  const out = [
    `fixture: ${file} (hook ${request.hook.kind} at tick ${request.hook.tick})`,
    `model: ${response.model}  prompt: ${response.promptVersion}${response.fallback ? `  FALLBACK: ${response.fallback} (${run.error ?? ""})` : ""}`,
    section("capabilities (system prefix)", trace.capabilities),
    section("digest", trace.digest),
    section("raw model output", trace.rawContent ?? "(none)"),
    section("plan", trace.plan === undefined ? "(none)" : JSON.stringify(trace.plan, null, 2)),
    section("commands", JSON.stringify(response.commands, null, 2)),
    section("dropped", JSON.stringify(response.dropped ?? [], null, 2)),
    section("card", JSON.stringify(response.card ?? null, null, 2)),
    section("notesUpdate", JSON.stringify(response.notesUpdate ?? null, null, 2)),
    section("usage", JSON.stringify(response.usage ?? null)),
  ];
  return { output: out.join("\n"), exitCode: 0 };
}

export async function runNarratorCli(sub: string | undefined, rest: readonly string[]) {
  switch (sub) {
    case "fixtures":
      return runNarratorFixtures(rest[0]);
    case "eval": {
      const notesAt = rest.indexOf("--notes");
      return runNarratorEval(rest[0], notesAt >= 0 ? rest[notesAt + 1] : undefined);
    }
    default:
      return {
        output:
          "crew narrator: expected `fixtures [outDir]` or `eval <fixture.json> [--notes <file>]`",
        exitCode: 1 as const,
      };
  }
}
