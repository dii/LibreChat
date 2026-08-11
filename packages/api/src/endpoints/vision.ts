/**
 * Which models must never be sent image content.
 *
 * LibreChat's agents path has no vision-capability gate: attachments are
 * categorised on `file.type.startsWith('image/')` alone and then encoded
 * unconditionally, so an image attached to a text-only model reaches the
 * provider and fails there. Against ollama that is a hard 500,
 * "image input is not supported - hint: ... you may need to provide the mmproj",
 * which kills the turn before the model runs.
 *
 * This is an explicit deny-list rather than an inferred capability, and the
 * direction is deliberate. The obvious alternative was `validateVisionModel`
 * in `librechat-data-provider`, which matches against a hard-coded
 * `visionModels` array. That array carries `claude-sonnet-4`, `claude-opus-4`
 * and `claude-haiku-4` but NOT `claude-sonnet-5`, and nothing for
 * `claude-fable-5`. Gating on it would therefore have silently stopped sending
 * images to current frontier models, trading a loud 500 on one local model for
 * a quiet capability loss on every cloud one. A deny-list cannot do that: a
 * model nobody listed behaves exactly as it does today.
 *
 * The cost of that choice, stated so it is not discovered later: adding a new
 * text-only model without listing it here reproduces the 500. That failure is
 * loud, immediate and names its own cause, which is the trade being made.
 */

/** Comma-separated model names that cannot accept image input. */
export const NON_VISION_MODELS_ENV: string = 'NON_VISION_MODELS';

/**
 * Exact, case-insensitive matching, not substring.
 *
 * Substring matching would be friendlier to configure and is the reason this
 * needs a comment: an entry of `llama3.2` would also capture
 * `llama3.2-vision`, silently blinding a model that can in fact see. Exact
 * names are auditable, and a deployment has few enough of them to list.
 */
export function parseNonVisionModels(raw?: string | null): Set<string> {
  if (!raw) {
    return new Set<string>();
  }
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * True when image content must be withheld from this model.
 *
 * Total by contract: an absent model, absent configuration or junk input all
 * yield `false`, i.e. today's behaviour. Nothing here can make a request fail.
 */
export function isNonVisionModel(model?: string | null, raw?: string | null): boolean {
  if (typeof model !== 'string' || !model) {
    return false;
  }
  return parseNonVisionModels(raw).has(model.trim().toLowerCase());
}
