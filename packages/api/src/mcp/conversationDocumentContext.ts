import { logger } from '@librechat/data-schemas';
import { FileContext } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import { FileRefScope, mintFileRef } from './fileRef';

/**
 * Offering a document to a document tool, the way conversationImageContext
 * offers a photo to an image tool.
 *
 * The asymmetry with images is the whole design problem here. An image tool
 * reads; a document tool reads AND replaces, in one call. So a document is
 * offered as a LABELLED PAIR of references rather than one combined
 * capability, decided in spec-canvas-on-files.md §5: both tokens look alike to
 * a model that cannot see them, so it will sometimes swap them, and the pair is
 * the only option where that mix-up is refused on scope before any file is
 * touched. A combined `rw` scope has no such check, and "write implies read"
 * was rejected on 2026-08-14 for granting capability by implication.
 *
 * It also means a read-only operation carries no destroy capability at all,
 * which matters more than usual because the canvas design removed versions:
 * a bad write is recoverable only by re-uploading.
 */

/** Files whose bytes a document tool can meaningfully transform. */
const TEXTUAL_TYPES = /^(text\/|application\/(json|xml|x-yaml|yaml|markdown))/;
const TEXTUAL_EXTENSIONS = /\.(md|markdown|txt|json|ya?ml|csv|tsv|rst|org|adoc|tex)$/i;

export interface DocumentContextFile {
  file_id: string;
  filename?: string;
  type?: string;
  bytes?: number;
  context?: string;
}

export interface BuildConversationDocumentContextParams {
  files: DocumentContextFile[];
  userId: string;
  tenantId?: string;
  signingKey: string;
  /** Cap on documents offered, most recent first. */
  maxDocuments?: number;
  /** Read reference lifetime. Write inherits the shorter mutating default. */
  readTtlMs?: number;
  writeTtlMs?: number;
}

const DEFAULT_MAX_DOCUMENTS = 12;

export function isTextualDocument(
  file: Pick<TFile, 'type' | 'filename'> | DocumentContextFile,
): boolean {
  const type = file.type ?? '';
  const filename = file.filename ?? '';
  return TEXTUAL_TYPES.test(type) || TEXTUAL_EXTENSIONS.test(filename);
}

/**
 * A document offered to the tools. `context: canvas_source` is the deliberate
 * marker (set by the canvas upload route), but any textual file in the thread
 * qualifies too — a user who attaches a .md and asks for it to be rewritten has
 * not used a different feature, and requiring them to would be the "two stores"
 * split this rebuild exists to remove.
 */
export function isOfferableDocument(file: DocumentContextFile): boolean {
  if (file.context === FileContext.canvas_source) {
    return true;
  }
  return isTextualDocument(file);
}

function describe(file: DocumentContextFile): string {
  const name = file.filename ? ` ${file.filename}` : '';
  if (!file.bytes) {
    return name;
  }
  const kb = file.bytes / 1024;
  const size = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} KB`;
  return `${name} (${size})`;
}

export function buildConversationDocumentContext({
  files,
  userId,
  tenantId,
  signingKey,
  maxDocuments = DEFAULT_MAX_DOCUMENTS,
  readTtlMs,
  writeTtlMs,
}: BuildConversationDocumentContextParams): string | null {
  const offerable = files.filter(isOfferableDocument).filter((file) => !!file.file_id);
  if (offerable.length === 0) {
    return null;
  }

  const shown = offerable.slice(0, Math.max(1, maxDocuments));
  const omitted = offerable.length - shown.length;

  const lines: string[] = [];
  for (const file of shown) {
    try {
      const base = { fileId: file.file_id, userId, tenantId };
      const read = mintFileRef({ ...base, scope: FileRefScope.read }, { signingKey, ttlMs: readTtlMs });
      const write = mintFileRef(
        { ...base, scope: FileRefScope.write },
        { signingKey, ttlMs: writeTtlMs },
      );
      lines.push(`  read=${read} write=${write}${describe(file)}`);
    } catch {
      /* One unmintable document must not lose the others. */
      continue;
    }
  }

  if (lines.length === 0) {
    return null;
  }

  const parts: string[] = [
    'Documents in this conversation. Each line gives TWO references for one document.',
    'Copy the token after `read=` or `write=` EXACTLY, up to the next space.',
    /* Deliberately no claim about the prefix. Read references still mint with
     * the legacy `lcimg_` prefix so they stay byte-identical to ones minted
     * before scopes existed, while mutating ones use `lcref_`. Telling the
     * model "both begin with lcref_" would be false for half of them, and the
     * `read=`/`write=` labels already say which is which. */
    'Pass `read=` where a tool asks what to read, and `write=` only where a tool',
    'asks where to write. They are NOT interchangeable: presenting one where the',
    'other belongs is refused and nothing is changed.',
    'Do not reuse a reference from earlier in the conversation; they expire, and',
    'the write ones expire sooner. Do not invent one.',
    '',
    'A write REPLACES the whole document and there is no version history, so only',
    'write when the user asked you to change the document itself.',
    '',
    omitted > 0
      ? `DOCUMENTS (showing ${lines.length} of ${offerable.length}, most recent first):`
      : 'DOCUMENTS:',
    ...lines,
  ];

  const context = parts.join('\n');
  logger.info(`[conversationDocuments] offered ${lines.length} document(s)`, {
    omitted,
    chars: context.length,
  });
  return context;
}
