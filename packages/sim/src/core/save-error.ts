/**
 * The one error `restore` throws for a save this build cannot load (an unsupported schema
 * version, a refused migration, a malformed envelope). Its own module so the migrations can throw
 * it without importing `save.ts`, which imports them.
 */
export class SaveCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveCompatibilityError";
  }
}
