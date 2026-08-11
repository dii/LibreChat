import { Constants } from 'librechat-data-provider';
import { getThreadData } from '~/utils/message';
import { buildConversationImageContext } from './conversationImageContext';
import type { ThreadImageMessage, ImageFileDocument } from './conversationImages';

/**
 * Resolves the conversation's image context for a request, or nothing.
 *
 * This is the seam between our feature and request initialisation. It exists so
 * the call site inside `initializeAgent` is a few lines rather than the whole
 * pipeline, which keeps the delta in an upstream-owned file small enough to
 * survive rebases.
 *
 * Its most important property is what it does *not* do. A request whose agent
 * carries none of the server's tools, or a deployment with the feature
 * unconfigured, performs no database query, mints nothing and injects nothing,
 * so it is indistinguishable from one made before the feature existed.
 */

/** Fields the walk needs, plus `content` for the tool calls that name each attempt. */
const MESSAGE_SELECT = 'messageId parentMessageId files attachments content';

/**
 * Key under which the context is injected. `joinInstructionMap` takes
 * `Object.values`, so the key is free; it names the feature for anyone reading
 * a dump of the map.
 */
export const MCP_CONVERSATION_IMAGES_KEY: string = 'mcp_conversation_images';

/**
 * What we require of a persisted message here. Deliberately stricter than
 * `ThreadImageMessage`, which tolerates nulls because it defends against junk:
 * this shape has to satisfy `getThreadData`'s own `ThreadMessage` on the way in,
 * and a narrower type widens to the permissive one on the way out.
 */
type ThreadSourceMessage = {
  messageId: string;
  parentMessageId?: string | null;
  files?: Array<{ file_id?: string }>;
  attachments?: Array<{ file_id?: string; toolCallId?: string }>;
  content?: ThreadImageMessage['content'];
};

type GetMessages = (
  filter: { conversationId: string },
  select: string,
) => Promise<ThreadSourceMessage[]>;

type GetFiles = (
  filter: Record<string, unknown>,
  sort: unknown,
  select: unknown,
) => Promise<ImageFileDocument[]>;

type FilterFiles = (params: {
  files: ImageFileDocument[];
  userId: string;
  role?: string;
  agentId?: string;
}) => Promise<ImageFileDocument[]>;

export interface ResolveConversationImageContextParams {
  /** `agent.tools`. The gate: nothing happens unless one belongs to the server. */
  agentTools?: unknown[];
  /** The MCP server whose tools consume image references. Unset means the feature is off. */
  serverName?: string;
  signingKey?: string;
  userId?: string;
  tenantId?: string;
  agentId?: string;
  role?: string;
  conversationId?: string | null;
  parentMessageId?: string | null;
  /** Files attached to this request, so turn one works before the conversation exists. */
  requestFileIds?: string[];
  getMessages?: GetMessages;
  getFiles?: GetFiles;
  filterFiles?: FilterFiles;
  maxSources?: number;
  maxAttempts?: number;
}

/**
 * An MCP tool key is `<toolName><delimiter><serverName>`, so the server name is
 * a *suffix*. Matching it as a bare substring would also match any server whose
 * name merely starts with this one, so `comfyui-image-staging` would activate
 * the feature configured for `comfyui-image`. `splitMCPToolKey` anchors the
 * same way, for the same reason.
 */
const carriesServerTools = (tools: unknown[] | undefined, serverName: string): boolean => {
  const marker = `${Constants.mcp_delimiter}${serverName}`;
  return (tools ?? []).some((tool) => typeof tool === 'string' && tool.endsWith(marker));
};

export async function resolveConversationImageContext({
  agentTools,
  serverName,
  signingKey,
  userId,
  tenantId,
  agentId,
  role,
  conversationId,
  parentMessageId,
  requestFileIds = [],
  getMessages,
  getFiles,
  filterFiles,
  maxSources,
  maxAttempts,
}: ResolveConversationImageContextParams): Promise<string | null> {
  /* Every cheap disqualifier first, before any I/O. This ordering is the
   * mechanism behind "changes nothing else", not an optimisation. */
  if (!serverName || !signingKey || !userId || !getFiles) {
    return null;
  }
  if (!carriesServerTools(agentTools, serverName)) {
    return null;
  }

  try {
    let threadMessages: ThreadImageMessage[] = [];
    const fileIds = new Set<string>(requestFileIds.filter(Boolean));

    /* `conversationId` is genuinely null on turn one, and `db.getMessages`'
     * filter type requires a string, so this is a guard rather than a nicety. */
    if (conversationId && parentMessageId && getMessages) {
      const messages = await getMessages({ conversationId }, MESSAGE_SELECT);
      const thread = getThreadData(messages ?? [], parentMessageId);
      for (const id of thread.fileIds) {
        fileIds.add(id);
      }

      /* The walk climbs from the current message towards the root, so its
       * `messageIds` are most-recent-first. Ordinals count forward from the
       * start of the conversation, so this has to be reversed. */
      const byId = new Map(messages?.map((message) => [message.messageId, message]) ?? []);
      threadMessages = thread.messageIds
        .slice()
        .reverse()
        .map((id) => byId.get(id))
        .filter((message): message is ThreadSourceMessage => !!message);
    }

    if (fileIds.size === 0) {
      return null;
    }

    /* Scoped to the principal, and that is the PRIMARY gate, not a nicety.
     * `requestFileIds` originates in `req.body.files`, which the caller
     * controls, so an unscoped query here lets anyone who knows a file id pull
     * another user's filename, dimensions and recovered prompt into their own
     * tool context. The signed reference protects the bytes but not this
     * metadata, and `filterFilesByAgentAccess` below returns its input
     * unfiltered for an ephemeral agent, which is the ordinary case. */
    const filter: Record<string, unknown> = {
      file_id: { $in: Array.from(fileIds) },
      user: userId,
    };
    if (tenantId) {
      filter.tenantId = tenantId;
    }
    const documents = await getFiles(filter, null, null);
    if (!documents?.length) {
      return null;
    }

    /* Defence in depth, and known to be so: this helper returns its input
     * unfiltered when `agentId` is absent or ephemeral. The reference minted
     * below is what actually binds an image to a principal. */
    let authorised = documents;
    if (filterFiles && agentId) {
      authorised = await filterFiles({ files: documents, userId, role, agentId });
    }
    if (!authorised?.length) {
      return null;
    }

    /* On turn one there are no thread messages, so synthesise the request's
     * files as a single message: the builder reads messages, not raw ids. */
    const messagesForBuild: ThreadImageMessage[] = threadMessages.length
      ? threadMessages
      : [{ files: Array.from(fileIds).map((file_id) => ({ file_id })) }];

    return buildConversationImageContext({
      messages: messagesForBuild,
      files: authorised,
      userId,
      tenantId,
      signingKey,
      maxSources,
      maxAttempts,
    });
  } catch {
    /* Swallowed deliberately. This runs inside request initialisation, where a
     * throw would fail the whole conversation over an image that could simply
     * have gone unmentioned. The caller logs; the user still gets their turn. */
    return null;
  }
}
