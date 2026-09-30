/**
 * Template card text now lives in `@crew/content` so the web host can render it too (Integration
 * 2); re-exported here so the narrator's own imports and tests are unchanged.
 */
export {
  type DecisionCardText,
  NARRATOR_TEXT_KEYS,
  renderTextRef,
  templateCard,
} from "@crew/content";
