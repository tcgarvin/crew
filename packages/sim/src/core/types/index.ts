/**
 * Shared kernel contracts (W0). `planner/**` may import only from here (and `view/**`) per the
 * SD §4.3 boundary enforced by dependency-cruiser. Types plus a few `as const` vocabularies and
 * tables; no behaviour. See docs/CONTRACTS.md for the index and rules.
 */
export * from "./actor";
export * from "./commands";
export * from "./commands/authority";
export * from "./common";
export * from "./content";
export * from "./decisions";
export * from "./events";
export * from "./ids";
export * from "./kernel";
export * from "./pipeline";
export * from "./protocol";
export * from "./save";
export * from "./ship";
export * from "./state";
export * from "./travel";
export * from "./view";
export * from "./work";
