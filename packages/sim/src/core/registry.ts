import { registerCoreCommandHandlers } from "./command-handlers";
/**
 * The kernel registry: the one way other workstreams plug systems, planners, command handlers,
 * the AgentView builder and cache builders into the kernel.
 *
 * W2 decision: registration is explicit but the resulting pipeline is still static per registry:
 * entries are ordered by `PHASES` and, within a phase, by registration order (core entries
 * first). `createKernel(registry)` binds a kernel to one registry; the exported `kernel` uses
 * `defaultRegistry`, which the `register*` free functions write to. Tests build isolated
 * registries with `createRegistry()` so nothing leaks between them.
 */
import type { CommandHandler } from "./commands";
import { coreSystems } from "./pipeline";
import type { CommandKind } from "./types/commands";
import type { ActorId } from "./types/ids";
import type { World } from "./types/kernel";
import {
  PHASES,
  type Pipeline,
  type PipelineEntry,
  type Planner,
  type System,
} from "./types/pipeline";
import type { AgentView } from "./types/view";

export type AgentViewBuilder = (world: World, actorId: ActorId) => AgentView;

/** Rebuilds one workstream's derived cache from `world.state` + content (e.g. W3 nav). */
export interface CacheBuilder {
  readonly name: string;
  build(world: World): void;
}

export type Unregister = () => void;

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}

export interface KernelRegistry {
  registerSystem(system: System): Unregister;
  registerPlanner(planner: Planner): Unregister;
  registerCommandHandler<K extends CommandKind, P>(
    kind: K,
    handler: CommandHandler<K, P>,
  ): Unregister;
  commandHandler<K extends CommandKind>(kind: K): CommandHandler<K, unknown> | undefined;
  /** Install the AgentView builder (W4a). Default throws `NotImplementedError`. */
  setAgentViewBuilder(builder: AgentViewBuilder): Unregister;
  buildAgentView(world: World, actorId: ActorId): AgentView;
  registerCacheBuilder(builder: CacheBuilder): Unregister;
  cacheBuilders(): readonly CacheBuilder[];
  /** Entries in phase order, stable within a phase. */
  pipeline(): Pipeline;
}

const PHASE_INDEX = Object.fromEntries(PHASES.map((phase, index) => [phase, index])) as Record<
  (typeof PHASES)[number],
  number
>;

const notImplementedBuilder: AgentViewBuilder = () => {
  throw new NotImplementedError("buildAgentView (W4a)");
};

export interface CreateRegistryOptions {
  /** Register the kernel-core systems and command handlers (default true). */
  readonly core?: boolean;
}

export function createRegistry(options: CreateRegistryOptions = {}): KernelRegistry {
  const entries: PipelineEntry[] = [];
  let sorted: Pipeline | null = null;
  const handlers = new Map<CommandKind, CommandHandler<CommandKind, unknown>>();
  const cacheBuilders: CacheBuilder[] = [];
  let agentViewBuilder = notImplementedBuilder;

  const addEntry = (entry: PipelineEntry): Unregister => {
    entries.push(entry);
    sorted = null;
    return () => {
      const index = entries.indexOf(entry);
      if (index >= 0) {
        entries.splice(index, 1);
        sorted = null;
      }
    };
  };

  const registry: KernelRegistry = {
    registerSystem(system) {
      if (entries.some((e) => e.kind === "system" && e.name === system.name)) {
        throw new Error(`System "${system.name}" is already registered`);
      }
      const every = system.every ?? 1;
      if (!Number.isInteger(every) || every < 1) {
        throw new RangeError(`System "${system.name}": every must be an integer >= 1`);
      }
      return addEntry({ ...system, kind: "system", run: (ctx) => system.run(ctx) });
    },
    registerPlanner(planner) {
      return addEntry({ kind: "planner", phase: "planning", planner });
    },
    registerCommandHandler(kind, handler) {
      if (handlers.has(kind)) {
        throw new Error(`A command handler for "${kind}" is already registered`);
      }
      const stored = handler as unknown as CommandHandler<CommandKind, unknown>;
      handlers.set(kind, stored);
      return () => {
        if (handlers.get(kind) === stored) {
          handlers.delete(kind);
        }
      };
    },
    commandHandler<K extends CommandKind>(kind: K) {
      return handlers.get(kind) as CommandHandler<K, unknown> | undefined;
    },
    setAgentViewBuilder(builder) {
      agentViewBuilder = builder;
      return () => {
        if (agentViewBuilder === builder) {
          agentViewBuilder = notImplementedBuilder;
        }
      };
    },
    buildAgentView: (world, actorId) => agentViewBuilder(world, actorId),
    registerCacheBuilder(builder) {
      if (cacheBuilders.some((b) => b.name === builder.name)) {
        throw new Error(`Cache builder "${builder.name}" is already registered`);
      }
      cacheBuilders.push(builder);
      return () => {
        const index = cacheBuilders.indexOf(builder);
        if (index >= 0) {
          cacheBuilders.splice(index, 1);
        }
      };
    },
    cacheBuilders: () => cacheBuilders,
    pipeline() {
      if (sorted === null) {
        // Array.prototype.sort is stable, so registration order holds within a phase.
        sorted = [...entries].sort((a, b) => PHASE_INDEX[a.phase] - PHASE_INDEX[b.phase]);
      }
      return sorted;
    },
  };

  if (options.core ?? true) {
    for (const system of coreSystems(registry)) {
      registry.registerSystem(system);
    }
    registerCoreCommandHandlers(registry);
  }
  return registry;
}

/** The registry behind the exported `kernel`. Other workstreams register into this one. */
export const defaultRegistry: KernelRegistry = createRegistry();

export const registerSystem = (system: System): Unregister =>
  defaultRegistry.registerSystem(system);
export const registerPlanner = (planner: Planner): Unregister =>
  defaultRegistry.registerPlanner(planner);
export const registerCommandHandler = <K extends CommandKind, P>(
  kind: K,
  handler: CommandHandler<K, P>,
): Unregister => defaultRegistry.registerCommandHandler(kind, handler);
export const setAgentViewBuilder = (builder: AgentViewBuilder): Unregister =>
  defaultRegistry.setAgentViewBuilder(builder);
export const registerCacheBuilder = (builder: CacheBuilder): Unregister =>
  defaultRegistry.registerCacheBuilder(builder);
