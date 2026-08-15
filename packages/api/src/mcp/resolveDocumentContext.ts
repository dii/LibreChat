import { logger } from '@librechat/data-schemas';
import { Constants } from 'librechat-data-provider';
import { buildConversationDocumentContext } from './conversationDocumentContext';
import type { DocumentContextFile } from './conversationDocumentContext';

/**
 * The document half of resolveConversationImageContext, and the piece the
 * canvas rebuild was blocked on: the MCP server cannot fetch a document by
 * reference until LibreChat OFFERS one.
 *
 * Deliberately the same shape as the image resolver, including the parts that
 * look like caution and are actually load-bearing:
 *
 *  - every cheap disqualifier runs before any I/O, so a conversation with no
 *    document tools costs nothing,
 *  - the file query is scoped to the principal, which is the PRIMARY gate: the
 *    request-supplied ids are caller-controlled, and an unscoped query would
 *    leak another user's filenames into this user's tool context,
 *  - failures are swallowed and logged, because this runs inside request
 *    initialisation and a throw would fail the whole conversation over a
 *    document that could simply have gone unmentioned.
 */

export const MCP_CONVERSATION_DOCUMENTS_KEY: string = 'mcp_conversation_documents';

const LOG_PREFIX = '[conversationDocuments]';

const MESSAGE_SELECT = { messageId: 1, parentMessageId: 1, files: 1 } as const;

export interface ResolveConversationDocumentContextParams {
  agentTools?: Array<string | { name?: string }> | null;
  serverName?: string;
  signingKey?: string;
  userId?: string;
  tenantId?: string;
  agentId?: string;
  role?: string;
  conversationId?: string | null;
  parentMessageId?: string | null;
  requestFileIds?: string[];
  getMessages?: (filter: object, select?: unknown) => Promise<Array<Record<string, unknown>>>;
  getFiles?: (
    filter: Record<string, unknown>,
    a?: unknown,
    b?: unknown,
  ) => Promise<DocumentContextFile[]>;
  filterFiles?: (args: {
    files: DocumentContextFile[];
    userId?: string;
    role?: string;
    agentId?: string;
  }) => Promise<DocumentContextFile[]>;
  maxDocuments?: number;
}

function carriesServerTools(
  agentTools: ResolveConversationDocumentContextParams['agentTools'],
  serverName: string,
): boolean {
  const suffix = `${Constants.mcp_delimiter}${serverName}`;
  return (agentTools ?? []).some((tool) => {
    const name = typeof tool === 'string' ? tool : tool?.name;
    return typeof name === 'string' && name.endsWith(suffix);
  });
}

export async function resolveConversationDocumentContext({
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
  maxDocuments,
}: ResolveConversationDocumentContextParams): Promise<string | null> {
  if (!serverName || !signingKey || !userId || !getFiles) {
    return null;
  }
  if (!carriesServerTools(agentTools, serverName)) {
    logger.debug(
      `${LOG_PREFIX} not offered: no agent tool ends with "${Constants.mcp_delimiter}${serverName}"`,
      { toolCount: agentTools?.length ?? 0 },
    );
    return null;
  }

  try {
    const fileIds = new Set<string>(requestFileIds.filter(Boolean));

    if (conversationId && parentMessageId && getMessages) {
      const messages = await getMessages({ conversationId }, MESSAGE_SELECT);
      for (const message of messages ?? []) {
        const files = (message as { files?: Array<{ file_id?: string }> }).files ?? [];
        for (const file of files) {
          if (file?.file_id) {
            fileIds.add(file.file_id);
          }
        }
      }
    }

    if (fileIds.size === 0) {
      logger.info(`${LOG_PREFIX} not offered: no file ids in the thread or the request`, {
        conversationId,
      });
      return null;
    }

    /* Principal-scoped, and that is the gate. See the note above. */
    const filter: Record<string, unknown> = {
      file_id: { $in: Array.from(fileIds) },
      user: userId,
    };
    if (tenantId) {
      filter.tenantId = tenantId;
    }
    const documents = await getFiles(filter, null, null);
    if (!documents?.length) {
      logger.info(
        `${LOG_PREFIX} not offered: none of the ${fileIds.size} id(s) resolve to a file owned by this user`,
        { conversationId },
      );
      return null;
    }

    let authorised = documents;
    if (filterFiles && agentId) {
      authorised = await filterFiles({ files: documents, userId, role, agentId });
    }
    if (!authorised?.length) {
      logger.info(`${LOG_PREFIX} not offered: agent-access filter rejected every file`, {
        conversationId,
        agentId,
      });
      return null;
    }

    /* Most recent first, so the cap drops the stalest rather than an arbitrary
     * set. Files carry no ordering field here, so the thread's own id order is
     * the best available proxy and is reversed to put the newest at the top. */
    const order = Array.from(fileIds).reverse();
    const rank = new Map(order.map((id, index) => [id, index]));
    const ordered = authorised
      .slice()
      .sort((a, b) => (rank.get(a.file_id) ?? 0) - (rank.get(b.file_id) ?? 0));

    const context = buildConversationDocumentContext({
      files: ordered,
      userId,
      tenantId,
      signingKey,
      maxDocuments,
    });

    if (!context) {
      logger.info(`${LOG_PREFIX} not offered: none of the ${authorised.length} file(s) are textual`, {
        conversationId,
      });
      return null;
    }
    return context;
  } catch (error) {
    logger.warn(`${LOG_PREFIX} failed; the turn proceeds without document context`, error);
    return null;
  }
}
