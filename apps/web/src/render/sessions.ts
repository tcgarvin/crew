/**
 * Slice 4 (call 17): a group session is drawn as one plate at its venue, "cards — Jax, Tomas,
 * Dane", and its members' own labels are left out, so four people round a two-tile table read as
 * one game rather than four stacked "Name — playing cards" plates. Pure words and ids; the canvas
 * places and draws the plate with the people's labels (`draw.ts`).
 */
import type { RenderFrame, RenderSession } from "@crew/sim";

/** A session plate's longest text, a local's label's (§person-labels). */
export const SESSION_PLATE_CHARS = 34;

/**
 * Everyone in a session, whose own label the canvas skips (their `actionLabel` still feeds the
 * inspector).
 */
export function sessionMemberIds(frame: Pick<RenderFrame, "sessions">): ReadonlySet<string> {
  return new Set(frame.sessions.flatMap((session) => session.memberIds));
}

/**
 * An activity label as the name of the thing played: "playing cards" reads "cards" (the ticker's
 * "won at cards" does the same); a label without the verb ("sparring", "watching a vid") stands.
 */
export function activityShortLabel(label: string): string {
  return label.replace(/^playing /, "");
}

/** "Jax Okonkwo" → "Jax". */
export function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/**
 * The plate's text: the game and its players' first names, "cards — Jax, Tomas, Dane", cut to
 * 34 characters. While it gathers, `label` is the def's waiting label ("waiting for a game of
 * cards — Jax"). Every member is named, not just the host: their own labels are skipped, so a
 * member the plate left out would be a nameless dot. A member missing from the frame's actors (a
 * frame between their leaving and the session's) is left out of the names.
 */
export function sessionPlateText(
  session: Pick<RenderSession, "label" | "memberIds" | "running">,
  frame: Pick<RenderFrame, "actors">,
): string {
  const names = new Map(frame.actors.map((actor) => [actor.id as string, actor.name]));
  const firsts = session.memberIds.flatMap((id) => {
    const name = names.get(id);
    return name === undefined ? [] : [firstName(name)];
  });
  const what = session.running ? activityShortLabel(session.label) : session.label;
  return truncate(
    firsts.length === 0 ? what : `${what} — ${firsts.join(", ")}`,
    SESSION_PLATE_CHARS,
  );
}
