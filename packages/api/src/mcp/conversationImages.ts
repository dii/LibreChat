/**
 * Builds the set of conversation images offered to an MCP tool server, split
 * into pinned source photos and windowed attempts, with stable ordinals.
 *
 * Why this walks messages rather than `getThreadData`'s `fileIds`: that helper
 * collects `files` and `attachments` into one deduplicated `Set<string>`, so it
 * carries no grouping, no surviving order, and no per-image metadata. Use it for
 * parent-chain membership, then walk the messages here for everything else.
 *
 * The pinning is not a preference. In an iterative session the source photo is
 * the anchor every attempt is derived from, so a policy that windows purely by
 * recency evicts the one image that must never go and keeps disposable attempts
 * instead.
 */

/** Bounded because too many near-identical options makes the model choose badly, not to save tokens. */
export const DEFAULT_MAX_SOURCES = 10;
export const DEFAULT_MAX_ATTEMPTS = 20;

/** Longer than this is not helping the model tell two attempts apart. */
const MAX_DESCRIPTION_CHARS = 120;

/** Keys a consumer's image tools use for the words that produced a render. */
const DESCRIPTION_KEYS = ['prompt', 'style_prompt', 'description'] as const;

/** `FileContext.image_generation`, set on every render at `callbacks.js:864` and `:1186`. */
const RENDER_CONTEXT = 'image_generation';

export interface ImageFileDocument {
  file_id: string;
  type?: string;
  width?: number;
  height?: number;
  filename?: string;
  /** `FileContext`. `image_generation` marks a render; anything else is treated as an upload. */
  context?: string;
}

interface ThreadToolCall {
  id?: string;
  name?: string;
  args?: string | Record<string, unknown>;
}

interface ThreadContentPart {
  type?: string;
  tool_call?: ThreadToolCall;
}

export interface ThreadImageMessage {
  files?: Array<{ file_id?: string } | null> | null;
  attachments?: Array<{ file_id?: string; toolCallId?: string } | null> | null;
  content?: Array<ThreadContentPart | null> | null;
}

export interface ConversationImage {
  fileId: string;
  filename?: string;
  width?: number;
  height?: number;
  /** Attempts only. Position among renders, counted from the start of the conversation. */
  ordinal?: number;
  /** Attempts only. The words that produced it, where they could be recovered. */
  description?: string;
}

export interface ConversationImageSet {
  /** Pinned. Most recent first. */
  sources: ConversationImage[];
  /** Windowed. Most recent first. */
  attempts: ConversationImage[];
  totalAttempts: number;
  /** Present only when the window dropped some, so a miss can be explained rather than guessed at. */
  omittedAttempts?: { from: number; to: number };
  totalSources: number;
  /** How many source photos were dropped by the cap. Sources are pinned against
   * attempts, not unbounded, and dropping one silently would be worse here than
   * for an attempt: the source is the anchor every attempt derives from. */
  omittedSources?: number;
}

export interface BuildConversationImagesParams {
  /** The thread's messages, in conversation order. */
  messages: ThreadImageMessage[];
  /** Fetched, authorised file documents. Anything absent here is treated as not available. */
  files: ImageFileDocument[];
  maxSources?: number;
  maxAttempts?: number;
}

const asRecord = (args: ThreadToolCall['args']): Record<string, unknown> | null => {
  if (!args) {
    return null;
  }
  if (typeof args === 'object') {
    return args as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** Indexes every tool call in the thread by id, so a render can find the words that made it. */
const indexToolCalls = (messages: ThreadImageMessage[]): Map<string, ThreadToolCall> => {
  const byId = new Map<string, ThreadToolCall>();
  for (const message of messages) {
    for (const part of message?.content ?? []) {
      const call = part?.tool_call;
      if (call?.id && !byId.has(call.id)) {
        byId.set(call.id, call);
      }
    }
  }
  return byId;
};

const describeToolCall = (call: ThreadToolCall | undefined): string | undefined => {
  const args = asRecord(call?.args);
  if (!args) {
    return undefined;
  }
  for (const key of DESCRIPTION_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim().slice(0, MAX_DESCRIPTION_CHARS);
    }
  }
  return undefined;
};

const isUsableImage = (file: ImageFileDocument | undefined): file is ImageFileDocument =>
  !!file &&
  typeof file.type === 'string' &&
  file.type.startsWith('image/') &&
  !!file.width &&
  !!file.height;

/**
 * Total by contract: degenerate input yields an empty set rather than throwing.
 * This runs inside request initialisation, where a throw would take down a
 * conversation over an image that could simply have gone unmentioned.
 */
export function buildConversationImages({
  messages,
  files,
  maxSources = DEFAULT_MAX_SOURCES,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}: BuildConversationImagesParams): ConversationImageSet {
  const empty: ConversationImageSet = {
    sources: [],
    attempts: [],
    totalAttempts: 0,
    totalSources: 0,
  };
  if (!Array.isArray(messages) || !Array.isArray(files)) {
    return empty;
  }

  const documents = new Map<string, ImageFileDocument>();
  for (const file of files) {
    if (file?.file_id) {
      documents.set(file.file_id, file);
    }
  }
  if (documents.size === 0) {
    return empty;
  }

  const toolCalls = indexToolCalls(messages);
  const seen = new Set<string>();
  const sources: ConversationImage[] = [];
  const attempts: ConversationImage[] = [];

  for (const message of messages) {
    if (!message) {
      continue;
    }

    /* Uploads and renders are read from their own collections, but the file
     * document's context decides the kind. A re-attached image must not change
     * kind because of where it appeared the second time. */
    const candidates: Array<{ fileId: string; toolCallId?: string }> = [];
    for (const file of message.files ?? []) {
      if (file?.file_id) {
        candidates.push({ fileId: file.file_id });
      }
    }
    for (const attachment of message.attachments ?? []) {
      if (attachment?.file_id) {
        candidates.push({ fileId: attachment.file_id, toolCallId: attachment.toolCallId });
      }
    }

    for (const { fileId, toolCallId } of candidates) {
      if (seen.has(fileId)) {
        continue;
      }
      const document = documents.get(fileId);
      if (!isUsableImage(document)) {
        continue;
      }
      seen.add(fileId);

      const image: ConversationImage = {
        fileId,
        filename: document.filename,
        width: document.width,
        height: document.height,
      };

      if (document.context === RENDER_CONTEXT) {
        image.ordinal = attempts.length + 1;
        const description = describeToolCall(toolCallId ? toolCalls.get(toolCallId) : undefined);
        if (description) {
          image.description = description;
        }
        attempts.push(image);
      } else {
        /* Any context that is not a render is treated as a source, including
         * `message_attachment`. Defaulting this way means an unfamiliar context
         * is offered as an anchor rather than silently dropped. */
        sources.push(image);
      }
    }
  }

  const totalAttempts = attempts.length;
  /* Most recent first in both lists: it is the order a person iterating thinks
   * in, and it makes the window boundary the far end rather than the near one. */
  const windowedAttempts = attempts.slice(-maxAttempts).reverse();
  const windowedSources = sources.slice(-maxSources).reverse();
  const result: ConversationImageSet = {
    sources: windowedSources,
    attempts: windowedAttempts,
    totalAttempts,
    totalSources: sources.length,
  };

  if (totalAttempts > windowedAttempts.length) {
    result.omittedAttempts = { from: 1, to: totalAttempts - windowedAttempts.length };
  }
  if (sources.length > windowedSources.length) {
    result.omittedSources = sources.length - windowedSources.length;
  }
  return result;
}
