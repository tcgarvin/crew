/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "sim-no-deps",
      severity: "error",
      comment:
        "packages/sim/src is the kernel and must not depend on node_modules or any other workspace package (test files may use the test runner).",
      from: {
        path: "^packages/sim/src",
        pathNot: "\\.test\\.ts$",
      },
      to: {
        path: "^(node_modules|packages/(?!sim))",
      },
    },
    {
      name: "sim-no-unresolvable-deps",
      severity: "error",
      comment:
        "packages/sim/src must not import packages that aren't installed as its own dependency (e.g. an npm package with no package.json entry in packages/sim) — that's a sign it's reaching for something it shouldn't have.",
      from: {
        path: "^packages/sim/src",
        pathNot: "\\.test\\.ts$",
      },
      to: {
        couldNotResolve: true,
      },
    },
    {
      name: "planner-boundary",
      severity: "error",
      comment:
        "packages/sim/src/planner may only import from packages/sim/src/view, packages/sim/src/core/types*, or sibling files inside planner/.",
      from: {
        path: "^packages/sim/src/planner",
      },
      to: {
        path: "^packages/sim/src",
        pathNot: [
          "^packages/sim/src/planner",
          "^packages/sim/src/view",
          "^packages/sim/src/core/types",
        ],
      },
    },
    {
      name: "content-sim-types-only",
      severity: "error",
      comment: "packages/content/src may import from packages/sim only via `import type`.",
      from: {
        path: "^packages/content/src",
      },
      to: {
        path: "^packages/sim",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "web-no-secrets",
      severity: "error",
      comment: "apps/web/src must never import @crew/narrator or @crew/server.",
      from: {
        path: "^apps/web/src",
      },
      to: {
        path: "^packages/(narrator|server)",
      },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.json",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};
