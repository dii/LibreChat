import { FileContext } from 'librechat-data-provider';
import { buildConversationDocumentContext, isOfferableDocument } from './conversationDocumentContext';
import { FileRefScope, verifyFileRef } from './fileRef';

/**
 * Needs (stated before the code, spec-canvas-on-files.md §5):
 *
 * D1 A document is offered with BOTH capabilities its tools need, as a labelled
 *    pair, never as one combined grant.
 * D2 The two references are distinguishable by label and each carries only its
 *    own scope, so presenting one where the other belongs is refused rather
 *    than silently accepted.
 * D3 A read-only operation can be performed without holding write capability.
 * D4 The model is told plainly that a write replaces the document and is not
 *    recoverable, because the design removed versions.
 */

const SIGNING_KEY = 'a'.repeat(64);
const USER = '507f1f77bcf86cd799439011';

const doc = (over: Record<string, unknown> = {}) => ({
  file_id: 'file-1',
  filename: 'notes.md',
  type: 'text/markdown',
  bytes: 4096,
  ...over,
});

function refsFrom(context: string) {
  /* Anchored on a prefix on purpose: the instruction text above the list
   * mentions `read=` and `write=` as parameter names, so a loose match picks
   * those up instead of an actual reference. Both prefixes are accepted
   * because a READ reference still mints as `lcimg_` for wire compatibility
   * while a write one is `lcref_` — a test that assumed one prefix is what
   * caught the context text asserting the same falsehood to the model. */
  const read = context.match(/read=((?:lcimg_|lcref_)\S+)/)?.[1];
  const write = context.match(/write=((?:lcimg_|lcref_)\S+)/)?.[1];
  return { read, write };
}

describe('what counts as a document', () => {
  it('offers a canvas upload regardless of type', () => {
    expect(isOfferableDocument(doc({ type: 'application/octet-stream', filename: 'x.bin', context: FileContext.canvas_source }))).toBe(true);
  });

  it('offers an ordinary text file the user just attached', () => {
    /* Requiring a separate "add to canvas" action would rebuild the two-store
     * split this whole change exists to remove. */
    expect(isOfferableDocument(doc())).toBe(true);
    expect(isOfferableDocument(doc({ filename: 'a.yaml', type: '' }))).toBe(true);
  });

  it('does not offer an image', () => {
    expect(isOfferableDocument(doc({ filename: 'p.png', type: 'image/png' }))).toBe(false);
  });
});

describe('D1/D2: a labelled pair, each carrying only its own scope', () => {
  const context = buildConversationDocumentContext({
    files: [doc()],
    userId: USER,
    signingKey: SIGNING_KEY,
  }) as string;

  it('offers both a read and a write reference', () => {
    const { read, write } = refsFrom(context);
    expect(read).toBeTruthy();
    expect(write).toBeTruthy();
    expect(read).not.toEqual(write);
  });

  it('mints each with only its own scope', () => {
    const { read, write } = refsFrom(context);
    expect(verifyFileRef(read as string, { signingKey: SIGNING_KEY })?.scope).toBe(FileRefScope.read);
    expect(verifyFileRef(write as string, { signingKey: SIGNING_KEY })?.scope).toBe(FileRefScope.write);
  });

  it('binds both to the same file and principal', () => {
    const { read, write } = refsFrom(context);
    const r = verifyFileRef(read as string, { signingKey: SIGNING_KEY });
    const w = verifyFileRef(write as string, { signingKey: SIGNING_KEY });
    expect(r?.fileId).toBe('file-1');
    expect(w?.fileId).toBe('file-1');
    expect(r?.userId).toBe(USER);
    expect(w?.userId).toBe(USER);
  });

  it('tells the model the two are not interchangeable', () => {
    expect(context).toMatch(/NOT interchangeable/i);
  });
});

describe('D4: the irreversibility is stated', () => {
  it('says a write replaces the document and has no history', () => {
    const context = buildConversationDocumentContext({
      files: [doc()],
      userId: USER,
      signingKey: SIGNING_KEY,
    }) as string;
    expect(context).toMatch(/REPLACES the whole document/);
    expect(context).toMatch(/no version history/);
  });
});

describe('offering nothing', () => {
  it('returns null when the thread holds no documents', () => {
    expect(
      buildConversationDocumentContext({
        files: [doc({ filename: 'p.png', type: 'image/png' })],
        userId: USER,
        signingKey: SIGNING_KEY,
      }),
    ).toBeNull();
  });

  it('caps the list and says so rather than silently truncating', () => {
    const files = Array.from({ length: 20 }, (_, i) => doc({ file_id: `f${i}` }));
    const context = buildConversationDocumentContext({
      files,
      userId: USER,
      signingKey: SIGNING_KEY,
      maxDocuments: 3,
    }) as string;
    expect(context).toMatch(/showing 3 of 20/);
  });
});
