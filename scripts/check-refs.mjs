// Fails when a `§<anchor>` names no heading in docs/spec/ or a `D<n>` names no entry in
// docs/DECISIONS.md, and when two spec headings share an anchor. Run by `pnpm lint`.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SPEC_DIR = "docs/spec";
const DECISIONS = "docs/DECISIONS.md";
// Dated records that describe the project as it was; their citations are not maintained.
const HISTORICAL = ["docs/review/", "docs/playtests/"];
const SCANNED = /\.(ts|tsx|mts|mjs|cjs|js|md|json|sh)$/;

function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/ /g, "-");
}

function specAnchors(problems) {
  const anchors = new Map();
  for (const file of readdirSync(SPEC_DIR).filter((name) => name.endsWith(".md"))) {
    const path = join(SPEC_DIR, file);
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((line, index) => {
        const heading = /^#{2,3} (.+)$/.exec(line);
        if (heading === null) return;
        const anchor = slug(heading[1]);
        const where = `${path}:${index + 1}`;
        const previous = anchors.get(anchor);
        if (previous !== undefined) {
          problems.push(`${where}: anchor §${anchor} also at ${previous}`);
        }
        anchors.set(anchor, where);
      });
  }
  return anchors;
}

function decisionNumbers() {
  const text = readFileSync(DECISIONS, "utf8");
  return new Set([...text.matchAll(/^\*\*D(\d+)\./gm)].map((match) => match[1]));
}

function scannedFiles() {
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  });
  return listed
    .split("\n")
    .filter((path) => SCANNED.test(path))
    .filter((path) => !HISTORICAL.some((prefix) => path.startsWith(prefix)));
}

const problems = [];
const anchors = specAnchors(problems);
const decisions = decisionNumbers();

for (const path of scannedFiles()) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    // A listed file deleted in the working tree is not an error; anything else is.
    if (error.code === "ENOENT") continue;
    throw error;
  }
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/§([a-z][a-z0-9-]*[a-z0-9])/g)) {
      if (!anchors.has(match[1])) {
        problems.push(`${path}:${index + 1}: §${match[1]} is not a heading in ${SPEC_DIR}/`);
      }
    }
    for (const match of line.matchAll(/\bD(\d{1,3})\b/g)) {
      if (!decisions.has(match[1])) {
        problems.push(`${path}:${index + 1}: D${match[1]} is not an entry in ${DECISIONS}`);
      }
    }
  });
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`check-refs: ${problems.length} unresolved reference(s)`);
  process.exit(1);
}
