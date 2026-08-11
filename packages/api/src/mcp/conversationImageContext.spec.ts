import { renderImageContext, buildConversationImageContext } from './conversationImageContext';
import { verifyFileRef } from './fileRef';
import type {
  ConversationImageSet,
  ThreadImageMessage,
  ImageFileDocument,
} from './conversationImages';

const mint = (fileId: string) => `lcimg_${fileId}.sig`;

const source = (fileId: string, filename = `${fileId}.jpg`) => ({
  fileId,
  filename,
  width: 1536,
  height: 1024,
});

const attempt = (fileId: string, ordinal: number, description?: string) => ({
  fileId,
  filename: `${fileId}.png`,
  width: 1024,
  height: 1024,
  ordinal,
  ...(description ? { description } : {}),
});

const set = (over: Partial<ConversationImageSet> = {}): ConversationImageSet => ({
  sources: [],
  attempts: [],
  totalAttempts: 0,
  totalSources: 0,
  ...over,
});

describe('renderImageContext', () => {
  /* U8. An agent that has nothing to be offered must get nothing injected, so
   * the caller can skip the key entirely rather than adding an empty heading. */
  it('returns null when there is nothing to offer', () => {
    expect(renderImageContext(set(), mint)).toBeNull();
  });

  describe('instructions the model needs', () => {
    it('tells the model to use a reference exactly and not to invent one', () => {
      const text = renderImageContext(set({ sources: [source('a')] }), mint) as string;
      expect(text).toMatch(/exactly/i);
      expect(text).toMatch(/do not invent/i);
    });

    /* References are re-minted every turn and expire, so a reference replayed
     * out of old conversation history is dead. The model has to be told. */
    it('tells the model not to reuse a reference from earlier in the conversation', () => {
      const text = renderImageContext(set({ sources: [source('a')] }), mint) as string;
      expect(text).toMatch(/earlier in the conversation/i);
      expect(text).toMatch(/expire/i);
    });
  });

  describe('sources', () => {
    it('lists each source with its reference, name and dimensions', () => {
      const text = renderImageContext(set({ sources: [source('a', 'torso.jpg')] }), mint) as string;
      expect(text).toContain('lcimg_a.sig');
      expect(text).toContain('torso.jpg');
      expect(text).toContain('1536x1024');
    });

    it('says source photos are always available, which is the point of pinning them', () => {
      const text = renderImageContext(set({ sources: [source('a')] }), mint) as string;
      expect(text).toMatch(/always available/i);
    });

    it('stops claiming "always available" once the cap has dropped one', () => {
      const text = renderImageContext(
        set({ sources: [source('a')], totalSources: 12, omittedSources: 11 }),
        mint,
      ) as string;
      expect(text).not.toMatch(/always available/i);
      expect(text).toMatch(/12/);
      expect(text).toMatch(/not shown/i);
    });

    it('omits the source section entirely when there are none', () => {
      const text = renderImageContext(
        set({ attempts: [attempt('r1', 1)], totalAttempts: 1 }),
        mint,
      ) as string;
      /* The section, not the word. The header instructs the model to pass a
       * reference as `source`, so a bare /source/i also matches guidance that
       * must always be present. */
      expect(text).not.toMatch(/SOURCE PHOTOS/);
    });
  });

  describe('attempts', () => {
    it('numbers each attempt with its conversation-wide ordinal', () => {
      const text = renderImageContext(
        set({ attempts: [attempt('r34', 34), attempt('r33', 33)], totalAttempts: 34 }),
        mint,
      ) as string;
      expect(text).toContain('#34');
      expect(text).toContain('#33');
    });

    it('quotes the description that produced each attempt', () => {
      const text = renderImageContext(
        set({ attempts: [attempt('r1', 1, 'dragon across the shoulder blade')], totalAttempts: 1 }),
        mint,
      ) as string;
      expect(text).toContain('"dragon across the shoulder blade"');
    });

    it('leaves an attempt unquoted rather than inventing a description', () => {
      const text = renderImageContext(
        set({ attempts: [attempt('r1', 1)], totalAttempts: 1 }),
        mint,
      ) as string;
      expect(text).toContain('#1');
      expect(text).not.toContain('""');
    });

    it('omits the attempts section entirely when there are none', () => {
      const text = renderImageContext(set({ sources: [source('a')] }), mint) as string;
      expect(text).not.toMatch(/attempt/i);
    });
  });

  /* U9. Asking for an attempt that has scrolled out of the window must produce a
   * plain answer, which the model can only give if it is told the range exists. */
  describe('what is no longer available', () => {
    it('states the total alongside the number shown when the window truncated', () => {
      const text = renderImageContext(
        set({
          attempts: [attempt('r34', 34)],
          totalAttempts: 34,
          omittedAttempts: { from: 1, to: 33 },
        }),
        mint,
      ) as string;
      expect(text).toContain('34');
      expect(text).toMatch(/showing/i);
    });

    it('names the range that is gone and what to do about it', () => {
      const text = renderImageContext(
        set({
          attempts: [attempt('r34', 34)],
          totalAttempts: 34,
          omittedAttempts: { from: 1, to: 33 },
        }),
        mint,
      ) as string;
      expect(text).toMatch(/1\s*(-|to|–)\s*33/);
      expect(text).toMatch(/no longer available/i);
    });

    it('says nothing about omissions when everything fits', () => {
      const text = renderImageContext(
        set({ attempts: [attempt('r1', 1)], totalAttempts: 1 }),
        mint,
      ) as string;
      expect(text).not.toMatch(/no longer available/i);
    });
  });

  /* Minting throws when misconfigured. One unmintable image must cost that image
   * and nothing else, rather than taking down the whole conversation's context. */
  describe('a failing mint costs one image, not the turn', () => {
    it('skips an image whose reference cannot be minted', () => {
      const failing = (fileId: string) => {
        if (fileId === 'bad') {
          throw new Error('no signing key');
        }
        return `lcimg_${fileId}.sig`;
      };
      const text = renderImageContext(
        set({ sources: [source('good'), source('bad')] }),
        failing,
      ) as string;
      expect(text).toContain('lcimg_good.sig');
      expect(text).not.toContain('bad');
    });

    it('returns null when nothing at all could be minted', () => {
      const alwaysFails = () => {
        throw new Error('no signing key');
      };
      expect(renderImageContext(set({ sources: [source('a')] }), alwaysFails)).toBeNull();
    });
  });
});

/* Integration across the three pieces with real signing: build the set, render
 * the text, and confirm a reference lifted out of that text verifies back to the
 * file and principal it was minted for. */

const KEY = 'integration-signing-key';
const USER = '507f1f77bcf86cd799439011';

const photo: ImageFileDocument = {
  file_id: 'photo-1',
  type: 'image/jpeg',
  width: 1536,
  height: 1024,
  filename: 'torso.jpg',
  context: 'message_attachment',
};

const renderDoc = (id: string): ImageFileDocument => ({
  file_id: id,
  type: 'image/png',
  width: 1024,
  height: 1024,
  filename: `${id}.png`,
  context: 'image_generation',
});

const messages: ThreadImageMessage[] = [
  { files: [{ file_id: 'photo-1' }] },
  {
    attachments: [{ file_id: 'r1', toolCallId: 't1' }],
    content: [
      {
        type: 'tool_call',
        tool_call: { id: 't1', name: 'edit_image', args: { prompt: 'dragon, fine line' } },
      },
    ],
  },
];

const refsIn = (text: string): string[] =>
  text.match(/lcimg_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? [];

describe('buildConversationImageContext', () => {
  it('produces text whose references verify back to the right file and principal', () => {
    const text = buildConversationImageContext({
      messages,
      files: [photo, renderDoc('r1')],
      userId: USER,
      signingKey: KEY,
    }) as string;

    const references = refsIn(text);
    expect(references).toHaveLength(2);

    const resolved = references.map((ref) => verifyFileRef(ref, { signingKey: KEY }));
    expect(resolved.every((r) => r?.userId === USER)).toBe(true);
    expect(resolved.map((r) => r?.fileId).sort()).toEqual(['photo-1', 'r1']);
  });

  it('carries the tenant into every reference it mints', () => {
    const text = buildConversationImageContext({
      messages,
      files: [photo],
      userId: USER,
      tenantId: 'tenant-7',
      signingKey: KEY,
    }) as string;
    expect(verifyFileRef(refsIn(text)[0], { signingKey: KEY })?.tenantId).toBe('tenant-7');
  });

  it('shows the source as always available and the render as a numbered attempt', () => {
    const text = buildConversationImageContext({
      messages,
      files: [photo, renderDoc('r1')],
      userId: USER,
      signingKey: KEY,
    }) as string;
    expect(text).toContain('torso.jpg');
    expect(text).toMatch(/always available/i);
    expect(text).toContain('#1');
    expect(text).toContain('"dragon, fine line"');
  });

  it('mints references that another key cannot verify', () => {
    const text = buildConversationImageContext({
      messages,
      files: [photo],
      userId: USER,
      signingKey: KEY,
    }) as string;
    expect(verifyFileRef(refsIn(text)[0], { signingKey: 'a-different-key' })).toBeNull();
  });

  /* U8. No usable images, or no key, means no context key injected at all, so a
   * request that cannot use the feature is identical to one without it. */
  describe('returns null rather than an empty heading', () => {
    it('when the thread holds no usable images', () => {
      expect(
        buildConversationImageContext({ messages: [], files: [], userId: USER, signingKey: KEY }),
      ).toBeNull();
    });

    it('when no signing key is configured', () => {
      expect(
        buildConversationImageContext({ messages, files: [photo], userId: USER, signingKey: '' }),
      ).toBeNull();
    });

    it('when there is no principal to bind a reference to', () => {
      expect(
        buildConversationImageContext({ messages, files: [photo], userId: '', signingKey: KEY }),
      ).toBeNull();
    });
  });

  it('does not throw on degenerate input', () => {
    expect(() =>
      buildConversationImageContext({
        messages: null as unknown as ThreadImageMessage[],
        files: null as unknown as ImageFileDocument[],
        userId: USER,
        signingKey: KEY,
      }),
    ).not.toThrow();
  });
});
