import { mintFileRef, DEFAULT_FILE_REF_TTL_MS } from './fileRef';
import { buildConversationImages } from './conversationImages';
import type {
  ConversationImage,
  ConversationImageSet,
  ThreadImageMessage,
  ImageFileDocument,
} from './conversationImages';

/**
 * Renders the conversation's images into the text an image tool server is given.
 *
 * Kept separate from building the set, and from minting, so it can be read and
 * tested as prose. Minting is passed in rather than imported: a reference is a
 * credential, and this stays a pure formatter.
 *
 * Two audiences read this at once, which is unusual and shapes the format. The
 * model resolves a reference from it, and the person is indirectly relying on it
 * when they say "go back to the third one" — so ordinals have to be legible and
 * stable, and what is missing has to be stated rather than left as silence.
 */

export type MintReference = (fileId: string) => string;

const dimensions = (image: ConversationImage): string =>
  image.width && image.height ? ` ${image.width}x${image.height}` : '';

const line = (image: ConversationImage, reference: string, ordinal?: number): string => {
  const number = ordinal != null ? `#${ordinal} ` : '';
  const name = image.filename ? ` name=${image.filename}` : '';
  /* Only quote a description that exists. An empty pair of quotes reads as an
   * image with no prompt rather than one whose prompt could not be recovered. */
  const described = image.description ? ` "${image.description}"` : '';
  return `  ${number}ref=${reference}${name}${dimensions(image)}${described}`;
};

/**
 * Returns the context text, or `null` when there is nothing to offer.
 *
 * `null` matters: the caller must then inject no key at all, so an agent with no
 * usable images is byte-identical to one without the feature.
 */
export function renderImageContext(
  set: ConversationImageSet,
  mintRef: MintReference,
): string | null {
  /* A reference that cannot be minted is an image we cannot vouch for, so it is
   * dropped rather than named. One failure costs that image and nothing else. */
  const withReference = (images: ConversationImage[]): Array<[ConversationImage, string]> => {
    const out: Array<[ConversationImage, string]> = [];
    for (const image of images) {
      try {
        const reference = mintRef(image.fileId);
        if (reference) {
          out.push([image, reference]);
        }
      } catch {
        continue;
      }
    }
    return out;
  };

  const sources = withReference(set?.sources ?? []);
  const attempts = withReference(set?.attempts ?? []);
  if (sources.length === 0 && attempts.length === 0) {
    return null;
  }

  const parts: string[] = [
    'Images in this conversation. Use a reference exactly as written below.',
    'Do not reuse a reference from earlier in the conversation; they expire.',
    'Do not invent a reference.',
  ];

  if (sources.length > 0) {
    /* Only claim "always available" when it is true. Sources are pinned against
     * attempts, but they are still capped, and the anchor going missing without
     * a word is worse than an attempt doing so. */
    const omitted = set.omittedSources ?? 0;
    parts.push(
      '',
      omitted > 0
        ? `SOURCE PHOTOS (showing ${sources.length} of ${set.totalSources}, most recent first; ${omitted} older not shown):`
        : 'SOURCE PHOTOS (always available):',
    );
    for (const [image, reference] of sources) {
      parts.push(line(image, reference));
    }
  }

  if (attempts.length > 0) {
    const shown =
      set.totalAttempts > attempts.length
        ? `showing ${attempts.length} of ${set.totalAttempts}, most recent first`
        : 'most recent first';
    parts.push('', `ATTEMPTS (${shown}):`);
    for (const [image, reference] of attempts) {
      parts.push(line(image, reference, image.ordinal));
    }

    /* Stated explicitly so an out-of-window request gets a plain answer. Without
     * this the model cannot tell "gone" from "never existed" and will guess. */
    if (set.omittedAttempts) {
      const { from, to } = set.omittedAttempts;
      const range = from === to ? `Attempt ${from} is` : `Attempts ${from}-${to} are`;
      parts.push(
        '',
        `${range} no longer available. If the user asks for one, say so and offer to work from a source photo or a listed attempt.`,
      );
    }
  }

  return parts.join('\n');
}

export interface BuildConversationImageContextParams {
  /** The thread's messages, in conversation order. */
  messages: ThreadImageMessage[];
  /** Fetched, authorised file documents. Anything absent is treated as unavailable. */
  files: ImageFileDocument[];
  /** The principal every reference is bound to. */
  userId: string;
  tenantId?: string;
  signingKey: string;
  ttlMs?: number;
  maxSources?: number;
  maxAttempts?: number;
}

/**
 * Returns the context text, or `null` when nothing should be injected.
 *
 * `null` is the important case and it has three causes: the thread holds no
 * usable image, there is no signing key, or there is no principal. In all three
 * the caller injects no key at all, so a request that cannot use the feature is
 * byte-identical to one made before the feature existed.
 */
export function buildConversationImageContext({
  messages,
  files,
  userId,
  tenantId,
  signingKey,
  ttlMs = DEFAULT_FILE_REF_TTL_MS,
  maxSources,
  maxAttempts,
}: BuildConversationImageContextParams): string | null {
  /* Checked here rather than left to the mint, so a misconfiguration produces
   * no context instead of a set that silently fails to render. */
  if (!signingKey || !userId) {
    return null;
  }

  const set = buildConversationImages({ messages, files, maxSources, maxAttempts });
  return renderImageContext(set, (fileId) =>
    mintFileRef({ fileId, userId, ...(tenantId ? { tenantId } : {}) }, { signingKey, ttlMs }),
  );
}
