/**
 * Test helper (not used by the app): a stand-in 2D context that accepts every call, counts them,
 * and throws where a real canvas would misbehave or silently draw nothing: a non-finite number
 * anywhere in a call or assigned to a property, a negative arc or gradient radius, a colour stop
 * outside [0, 1]. jsdom has no canvas, so the drawing code is exercised against this.
 */

export interface MockCanvas {
  readonly ctx: CanvasRenderingContext2D;
  /** Calls per method name. */
  readonly calls: ReadonlyMap<string, number>;
}

function checkArgs(method: string, args: readonly unknown[]): void {
  args.forEach((arg, i) => {
    if (typeof arg === "number" && !Number.isFinite(arg)) {
      throw new Error(`${method}: argument ${i} is ${arg}`);
    }
  });
  if (method === "arc" && typeof args[2] === "number" && args[2] < 0) {
    throw new Error(`arc: negative radius ${args[2]}`);
  }
  if (method === "createRadialGradient") {
    if ((args[2] as number) < 0 || (args[5] as number) < 0) {
      throw new Error("createRadialGradient: negative radius");
    }
  }
}

export function mockCanvas(): MockCanvas {
  const calls = new Map<string, number>();
  const count = (method: string) => calls.set(method, (calls.get(method) ?? 0) + 1);
  const gradient = {
    addColorStop(offset: number, color: string) {
      checkArgs("addColorStop", [offset]);
      if (offset < 0 || offset > 1) throw new Error(`addColorStop: offset ${offset}`);
      if (typeof color !== "string" || color.includes("NaN")) {
        throw new Error(`addColorStop: colour ${color}`);
      }
    },
  };
  const state = new Map<string, unknown>();
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      if (state.has(prop)) return state.get(prop);
      if (prop === "measureText") {
        return (text: string) => ({ width: text.length * 6 });
      }
      if (prop === "createLinearGradient" || prop === "createRadialGradient") {
        return (...args: unknown[]) => {
          checkArgs(prop, args);
          count(prop);
          return gradient;
        };
      }
      return (...args: unknown[]) => {
        checkArgs(prop, args);
        count(prop);
      };
    },
    set(_target, prop, value: unknown) {
      if (typeof prop !== "string") return false;
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new Error(`${prop} set to ${value}`);
      }
      if (typeof value === "string" && value.includes("NaN")) {
        throw new Error(`${prop} set to ${value}`);
      }
      state.set(prop, value);
      return true;
    },
  };
  return { ctx: new Proxy({}, handler) as CanvasRenderingContext2D, calls };
}
