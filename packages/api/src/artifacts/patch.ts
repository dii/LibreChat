import { ARTIFACT_START, ARTIFACT_END, findAllArtifacts, replaceArtifactContent } from './update';
import { applyDocEdit } from '../canvas/docs';
import type { CanvasDocEditResult } from '../canvas/docs';

export const ARTIFACT_EDIT_START = ':::artifact-edit';
const ORIGINAL_MARKER = '<<<<<<< ORIGINAL';
const DIVIDER_MARKER = '=======';
const UPDATED_MARKER = '>>>>>>> UPDATED';

const IDENTIFIER_PATTERN = /identifier\s*=\s*["']([^"']*)["']/;

type MarkerBlock = {
  original: string;
  updated: string;
};

export type ArtifactEditDirective = {
  start: number;
  end: number;
  identifier: string | null;
  blocks: MarkerBlock[];
};

export type ResolveResult = {
  text: string;
  applied: number;
  failed: number;
};

type TextPart = {
  type?: string;
  text?: string;
};

type PriorMessage = {
  content?: TextPart[];
  text?: string;
};

type ContentResult = {
  content: TextPart[];
  applied: number;
  failed: number;
};

const getLineEnd = (text: string, start: number): number => {
  const index = text.indexOf('\n', start);
  return index === -1 ? text.length : index;
};

const getNextLineStart = (text: string, lineEnd: number): number =>
  lineEnd >= text.length ? text.length : lineEnd + 1;

const getIdentifier = (line: string): string | null => {
  const match = line.match(IDENTIFIER_PATTERN);
  return match ? match[1] : null;
};

const isEditOpening = (text: string, start: number): boolean => {
  const next = text[start + ARTIFACT_EDIT_START.length];
  return next === '{' || next === ' ' || next === '\t' || next === '\r' || next === '\n';
};

type DirectiveBody = {
  blocks: MarkerBlock[];
  end: number;
};

const parseDirectiveBody = (text: string, bodyStart: number): DirectiveBody | null => {
  const blocks: MarkerBlock[] = [];
  let state: 'search' | 'original' | 'updated' = 'search';
  let originalLines: string[] = [];
  let updatedLines: string[] = [];
  let index = bodyStart;

  while (index < text.length) {
    const lineEnd = getLineEnd(text, index);
    const line = text.slice(index, lineEnd);
    const trimmed = line.trim();
    const nextIndex = getNextLineStart(text, lineEnd);

    if (state === 'search') {
      if (trimmed === ARTIFACT_END) {
        if (blocks.length === 0) {
          return null;
        }
        const markerStart = index + line.search(/\S/);
        return { blocks, end: markerStart + ARTIFACT_END.length };
      }
      if (trimmed === ORIGINAL_MARKER) {
        state = 'original';
        originalLines = [];
      }
    } else if (state === 'original') {
      if (trimmed === DIVIDER_MARKER) {
        state = 'updated';
        updatedLines = [];
      } else {
        originalLines.push(line);
      }
    } else if (trimmed === UPDATED_MARKER) {
      blocks.push({ original: originalLines.join('\n'), updated: updatedLines.join('\n') });
      state = 'search';
    } else {
      updatedLines.push(line);
    }

    index = nextIndex;
  }

  return null;
};

/**
 * Parses `:::artifact-edit{...}` container directives out of a text string.
 * Each directive holds one or more ORIGINAL/UPDATED marker blocks. Unclosed or
 * malformed directives (e.g. streaming truncation) are skipped so the raw text
 * is left untouched.
 */
export const parseArtifactEdits = (text: string): ArtifactEditDirective[] => {
  const directives: ArtifactEditDirective[] = [];
  let searchIndex = text.indexOf(ARTIFACT_EDIT_START);

  while (searchIndex !== -1) {
    if (!isEditOpening(text, searchIndex)) {
      searchIndex = text.indexOf(ARTIFACT_EDIT_START, searchIndex + ARTIFACT_EDIT_START.length);
      continue;
    }

    const lineEnd = getLineEnd(text, searchIndex);
    const openingLine = text.slice(searchIndex, lineEnd);
    const body = parseDirectiveBody(text, getNextLineStart(text, lineEnd));

    if (!body) {
      searchIndex = text.indexOf(ARTIFACT_EDIT_START, searchIndex + ARTIFACT_EDIT_START.length);
      continue;
    }

    directives.push({
      start: searchIndex,
      end: body.end,
      identifier: getIdentifier(openingLine),
      blocks: body.blocks,
    });
    searchIndex = text.indexOf(ARTIFACT_EDIT_START, body.end);
  }

  return directives;
};

const getArtifactIdentifier = (block: string): string | null => {
  if (!block.startsWith(ARTIFACT_START) || block[ARTIFACT_START.length] === '-') {
    return null;
  }
  const lineEnd = getLineEnd(block, 0);
  return getIdentifier(block.slice(0, lineEnd));
};

const findLatestArtifactBlock = (text: string, identifier: string): string | null => {
  if (!text.includes(ARTIFACT_START)) {
    return null;
  }
  const artifacts = findAllArtifacts({ text });
  for (let i = artifacts.length - 1; i >= 0; i--) {
    const boundary = artifacts[i];
    const block = text.slice(boundary.start, boundary.end);
    if (getArtifactIdentifier(block) === identifier) {
      return block;
    }
  }
  return null;
};

const findSourceArtifact = (
  recentText: string,
  priorText: string[],
  identifier: string | null,
): string | null => {
  if (!identifier) {
    return null;
  }
  const fromRecent = findLatestArtifactBlock(recentText, identifier);
  if (fromRecent) {
    return fromRecent;
  }
  for (let i = priorText.length - 1; i >= 0; i--) {
    const found = findLatestArtifactBlock(priorText[i], identifier);
    if (found) {
      return found;
    }
  }
  return null;
};

const applyMarkerBlocks = (sourceBlock: string, blocks: MarkerBlock[]): string | null => {
  let current = sourceBlock;
  for (const block of blocks) {
    const boundary = findAllArtifacts({ text: current })[0];
    if (!boundary) {
      return null;
    }
    const next = replaceArtifactContent(current, boundary, block.original, block.updated);
    if (next === null) {
      return null;
    }
    current = next;
  }
  return current;
};

const editFailure = (reason: string, identifier: string | null): string =>
  `\n> ⚠️ artifact edit failed: ${reason} "${identifier ?? ''}"`;

/**
 * Resolves `:::artifact-edit` directives in a text string. Each directive is
 * matched against the most recent prior `:::artifact` block sharing its
 * identifier (searching the already-resolved text first, then prior messages
 * from newest to oldest), and replaced with a full `:::artifact` block carrying
 * the same attributes and the patched inner content. Failures are left in place
 * with a visible blockquote warning and never half-applied.
 */
export const resolveArtifactEdits = ({
  priorText,
  text,
}: {
  priorText: string[];
  text: string;
}): ResolveResult => {
  if (!text.includes(ARTIFACT_EDIT_START)) {
    return { text, applied: 0, failed: 0 };
  }

  const directives = parseArtifactEdits(text);
  if (directives.length === 0) {
    return { text, applied: 0, failed: 0 };
  }

  let result = '';
  let cursor = 0;
  let applied = 0;
  let failed = 0;

  for (const directive of directives) {
    result += text.slice(cursor, directive.start);
    const rawDirective = text.slice(directive.start, directive.end);
    const source = findSourceArtifact(result, priorText, directive.identifier);

    if (!source) {
      result +=
        rawDirective + editFailure('no artifact found with identifier', directive.identifier);
      failed++;
    } else {
      const patched = applyMarkerBlocks(source, directive.blocks);
      if (patched === null) {
        result +=
          rawDirective +
          editFailure('original content not found in artifact', directive.identifier);
        failed++;
      } else {
        result += patched;
        applied++;
      }
    }

    cursor = directive.end;
  }

  result += text.slice(cursor);
  return { text: result, applied, failed };
};

/**
 * Resolves `:::artifact-edit` directives across a content-part array (e.g. agent
 * responses), threading resolved parts as prior context for later parts.
 */
export const resolveArtifactEditsInContent = ({
  priorText,
  content,
}: {
  priorText: string[];
  content: TextPart[];
}): ContentResult => {
  let applied = 0;
  let failed = 0;
  const priorTexts = [...priorText];

  const nextContent = content.map((part) => {
    if (part?.type !== 'text' || typeof part.text !== 'string') {
      return part;
    }
    if (!part.text.includes(ARTIFACT_EDIT_START)) {
      if (part.text.includes(ARTIFACT_START)) {
        priorTexts.push(part.text);
      }
      return part;
    }

    const resolved = resolveArtifactEdits({ priorText: priorTexts, text: part.text });
    applied += resolved.applied;
    failed += resolved.failed;
    priorTexts.push(resolved.text);
    return { ...part, text: resolved.text };
  });

  return { content: nextContent, applied, failed };
};

export type CanvasDocsContext = {
  baseDir: string;
  userId: string;
};

const toDiffLines = (value: string, marker: '-' | '+'): string =>
  value
    .split('\n')
    .map((line) => `${marker} ${line}`)
    .join('\n');

const formatDocDiff = (blocks: MarkerBlock[]): string =>
  blocks
    .map((block) => `${toDiffLines(block.original, '-')}\n${toDiffLines(block.updated, '+')}`)
    .join('\n');

const docConfirmation = (identifier: string, version: number, blocks: MarkerBlock[]): string =>
  `**Canvas doc \`${identifier}\` updated to v${version}.**\n\n\`\`\`diff\n${formatDocDiff(blocks)}\n\`\`\``;

const resolveDocEdit = (
  canvasDocs: CanvasDocsContext,
  identifier: string | null,
  blocks: MarkerBlock[],
): Promise<CanvasDocEditResult> => {
  if (!identifier) {
    return Promise.resolve({ status: 'notfound' });
  }
  return applyDocEdit({
    baseDir: canvasDocs.baseDir,
    userId: canvasDocs.userId,
    docKey: identifier,
    blocks,
  });
};

/**
 * Doc-aware variant of {@link resolveArtifactEdits}. In-message artifacts keep
 * precedence; only when no prior artifact matches a directive's identifier does
 * it fall back to the requesting user's server-stored canvas docs (never in
 * context). A doc hit is applied via `applyDocEdit` and the directive is
 * replaced with a confirmation plus a fenced diff; misses fail loud in place.
 * With no `canvasDocs` it is exactly {@link resolveArtifactEdits}.
 */
export const resolveArtifactEditsWithDocs = async ({
  priorText,
  text,
  canvasDocs,
}: {
  priorText: string[];
  text: string;
  canvasDocs?: CanvasDocsContext;
}): Promise<ResolveResult> => {
  if (!canvasDocs || !text.includes(ARTIFACT_EDIT_START)) {
    return resolveArtifactEdits({ priorText, text });
  }

  const directives = parseArtifactEdits(text);
  if (directives.length === 0) {
    return { text, applied: 0, failed: 0 };
  }

  let result = '';
  let cursor = 0;
  let applied = 0;
  let failed = 0;

  for (const directive of directives) {
    result += text.slice(cursor, directive.start);
    const rawDirective = text.slice(directive.start, directive.end);
    const source = findSourceArtifact(result, priorText, directive.identifier);

    if (source) {
      const patched = applyMarkerBlocks(source, directive.blocks);
      if (patched === null) {
        result +=
          rawDirective +
          editFailure('original content not found in artifact', directive.identifier);
        failed++;
      } else {
        result += patched;
        applied++;
      }
    } else {
      const outcome = await resolveDocEdit(canvasDocs, directive.identifier, directive.blocks);
      if (outcome.status === 'applied') {
        result += docConfirmation(directive.identifier ?? '', outcome.version, directive.blocks);
        applied++;
      } else if (outcome.status === 'nomatch') {
        result +=
          rawDirective +
          editFailure('original content not found in canvas doc', directive.identifier);
        failed++;
      } else {
        result +=
          rawDirective + editFailure('no artifact found with identifier', directive.identifier);
        failed++;
      }
    }

    cursor = directive.end;
  }

  result += text.slice(cursor);
  return { text: result, applied, failed };
};

/**
 * Doc-aware variant of {@link resolveArtifactEditsInContent}, threading resolved
 * parts as prior context for later parts. With no `canvasDocs` it is exactly
 * {@link resolveArtifactEditsInContent}.
 */
export const resolveArtifactEditsInContentWithDocs = async ({
  priorText,
  content,
  canvasDocs,
}: {
  priorText: string[];
  content: TextPart[];
  canvasDocs?: CanvasDocsContext;
}): Promise<ContentResult> => {
  if (!canvasDocs) {
    return resolveArtifactEditsInContent({ priorText, content });
  }

  let applied = 0;
  let failed = 0;
  const priorTexts = [...priorText];
  const nextContent: TextPart[] = [];

  for (const part of content) {
    if (part?.type !== 'text' || typeof part.text !== 'string') {
      nextContent.push(part);
      continue;
    }
    if (!part.text.includes(ARTIFACT_EDIT_START)) {
      if (part.text.includes(ARTIFACT_START)) {
        priorTexts.push(part.text);
      }
      nextContent.push(part);
      continue;
    }

    const resolved = await resolveArtifactEditsWithDocs({
      priorText: priorTexts,
      text: part.text,
      canvasDocs,
    });
    applied += resolved.applied;
    failed += resolved.failed;
    priorTexts.push(resolved.text);
    nextContent.push({ ...part, text: resolved.text });
  }

  return { content: nextContent, applied, failed };
};

/**
 * Flattens prior conversation messages into an ordered (oldest to newest) list
 * of texts that contain artifact blocks, for use as edit-resolution sources.
 */
export const collectPriorArtifactTexts = (
  messages: PriorMessage[] | undefined | null,
): string[] => {
  const texts: string[] = [];
  if (!messages?.length) {
    return texts;
  }

  for (const message of messages) {
    if (message?.content?.length) {
      for (const part of message.content) {
        if (
          part?.type === 'text' &&
          typeof part.text === 'string' &&
          part.text.includes(ARTIFACT_START)
        ) {
          texts.push(part.text);
        }
      }
    } else if (typeof message?.text === 'string' && message.text.includes(ARTIFACT_START)) {
      texts.push(message.text);
    }
  }

  return texts;
};
