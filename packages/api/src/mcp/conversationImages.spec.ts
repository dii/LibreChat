import {
  buildConversationImages,
  DEFAULT_MAX_SOURCES,
  DEFAULT_MAX_ATTEMPTS,
} from './conversationImages';
import type { ThreadImageMessage, ImageFileDocument } from './conversationImages';

const upload = (id: string, filename = `${id}.jpg`): ImageFileDocument => ({
  file_id: id,
  type: 'image/jpeg',
  width: 1536,
  height: 1024,
  filename,
  context: 'message_attachment',
});

const render = (id: string): ImageFileDocument => ({
  file_id: id,
  type: 'image/png',
  width: 1024,
  height: 1024,
  filename: `${id}.png`,
  context: 'image_generation',
});

const userMsg = (fileIds: string[]): ThreadImageMessage => ({
  files: fileIds.map((file_id) => ({ file_id })),
});

const toolMsg = (fileId: string, toolCallId: string, prompt?: string): ThreadImageMessage => ({
  attachments: [{ file_id: fileId, toolCallId }],
  content: prompt
    ? [{ type: 'tool_call', tool_call: { id: toolCallId, name: 'edit_image', args: { prompt } } }]
    : undefined,
});

describe('buildConversationImages', () => {
  describe('splitting uploads from renders', () => {
    it('classifies on the file document context, not on where it appeared', () => {
      /* The document field is authoritative: an image can be re-attached to a
       * later message and must not change kind because of it. */
      const set = buildConversationImages({
        messages: [userMsg(['a']), toolMsg('b', 't1')],
        files: [upload('a'), render('b')],
      });
      expect(set.sources.map((i) => i.fileId)).toEqual(['a']);
      expect(set.attempts.map((i) => i.fileId)).toEqual(['b']);
    });

    it('drops files that are not images', () => {
      const set = buildConversationImages({
        messages: [userMsg(['a', 'doc'])],
        files: [
          upload('a'),
          { file_id: 'doc', type: 'application/pdf', context: 'message_attachment' },
        ],
      });
      expect(set.sources.map((i) => i.fileId)).toEqual(['a']);
    });

    it('drops images with no dimensions, which the tools cannot use', () => {
      const set = buildConversationImages({
        messages: [userMsg(['a', 'nodims'])],
        files: [
          upload('a'),
          { file_id: 'nodims', type: 'image/png', context: 'message_attachment' },
        ],
      });
      expect(set.sources.map((i) => i.fileId)).toEqual(['a']);
    });

    /* Anything filtered out by authorisation simply is not in `files`. It must
     * vanish rather than appear unnamed, or we name what we cannot vouch for. */
    it('drops ids with no corresponding document', () => {
      const set = buildConversationImages({
        messages: [userMsg(['a', 'unauthorised'])],
        files: [upload('a')],
      });
      expect(set.sources.map((i) => i.fileId)).toEqual(['a']);
      expect(set.attempts).toHaveLength(0);
    });

    it('does not list the same image twice when it is re-attached', () => {
      const set = buildConversationImages({
        messages: [userMsg(['a']), userMsg(['a'])],
        files: [upload('a')],
      });
      expect(set.sources).toHaveLength(1);
    });
  });

  /* U1 and the tattoo use case: the source photo is the anchor every attempt
   * depends on, so it must never be evicted to make room for attempts. */
  describe('sources are pinned', () => {
    it('keeps the source photo however many attempts follow it', () => {
      const messages: ThreadImageMessage[] = [userMsg(['photo'])];
      const files: ImageFileDocument[] = [upload('photo')];
      for (let i = 1; i <= 40; i++) {
        messages.push(toolMsg(`r${i}`, `t${i}`));
        files.push(render(`r${i}`));
      }
      const set = buildConversationImages({ messages, files });
      expect(set.sources.map((i) => i.fileId)).toEqual(['photo']);
      expect(set.attempts.length).toBe(DEFAULT_MAX_ATTEMPTS);
    });

    it('bounds sources too, keeping the most recent', () => {
      const ids = Array.from({ length: DEFAULT_MAX_SOURCES + 3 }, (_, i) => `p${i + 1}`);
      const set = buildConversationImages({
        messages: ids.map((id) => userMsg([id])),
        files: ids.map((id) => upload(id)),
      });
      expect(set.sources).toHaveLength(DEFAULT_MAX_SOURCES);
      expect(set.sources[0].fileId).toBe(ids[ids.length - 1]);
    });
  });

  /* U9. "Go back to the third one" must mean the same thing on every turn, so
   * the ordinal is the position in the whole conversation, never in the window. */
  describe('ordinals are stable across the window', () => {
    const build = (count: number) => {
      const messages: ThreadImageMessage[] = [];
      const files: ImageFileDocument[] = [];
      for (let i = 1; i <= count; i++) {
        messages.push(toolMsg(`r${i}`, `t${i}`));
        files.push(render(`r${i}`));
      }
      return buildConversationImages({ messages, files });
    };

    it('numbers attempts forward from the start of the conversation', () => {
      const set = build(3);
      expect(set.attempts.map((a) => [a.ordinal, a.fileId])).toEqual([
        [3, 'r3'],
        [2, 'r2'],
        [1, 'r1'],
      ]);
    });

    it('keeps attempt 3 numbered 3 once the window has slid past it', () => {
      const set = build(34);
      expect(set.totalAttempts).toBe(34);
      expect(set.attempts[0].ordinal).toBe(34);
      expect(set.attempts[set.attempts.length - 1].ordinal).toBe(34 - DEFAULT_MAX_ATTEMPTS + 1);
      expect(set.attempts.some((a) => a.ordinal === 3)).toBe(false);
    });

    it('reports the total and the range it dropped, so a miss can be explained', () => {
      const set = build(34);
      expect(set.totalAttempts).toBe(34);
      expect(set.omittedAttempts).toEqual({ from: 1, to: 34 - DEFAULT_MAX_ATTEMPTS });
    });

    it('reports nothing omitted when everything fits', () => {
      expect(build(4).omittedAttempts).toBeUndefined();
    });
  });

  /* U9 again: a model with no vision can only tell attempts apart by the words
   * that produced them, so the description has to be recovered and carried. */
  describe('recovering the description that produced a render', () => {
    it('matches the attachment toolCallId against the tool call args', () => {
      const set = buildConversationImages({
        messages: [toolMsg('r1', 't1', 'dragon across the shoulder blade')],
        files: [render('r1')],
      });
      expect(set.attempts[0].description).toBe('dragon across the shoulder blade');
    });

    it('finds the tool call even when it sits in a different message', () => {
      const set = buildConversationImages({
        messages: [
          {
            content: [
              {
                type: 'tool_call',
                tool_call: { id: 't1', name: 'edit_image', args: { prompt: 'snake' } },
              },
            ],
          },
          { attachments: [{ file_id: 'r1', toolCallId: 't1' }] },
        ],
        files: [render('r1')],
      });
      expect(set.attempts[0].description).toBe('snake');
    });

    it('reads args when they were persisted as a JSON string', () => {
      const set = buildConversationImages({
        messages: [
          {
            attachments: [{ file_id: 'r1', toolCallId: 't1' }],
            content: [
              {
                type: 'tool_call',
                tool_call: { id: 't1', name: 'edit_image', args: '{"prompt":"koi fish"}' },
              },
            ],
          },
        ],
        files: [render('r1')],
      });
      expect(set.attempts[0].description).toBe('koi fish');
    });

    it('falls back to style_prompt', () => {
      const set = buildConversationImages({
        messages: [
          {
            attachments: [{ file_id: 'r1', toolCallId: 't1' }],
            content: [
              {
                type: 'tool_call',
                tool_call: { id: 't1', name: 'style_transfer', args: { style_prompt: 'woodcut' } },
              },
            ],
          },
        ],
        files: [render('r1')],
      });
      expect(set.attempts[0].description).toBe('woodcut');
    });

    it('leaves the description undefined rather than guessing when nothing matches', () => {
      const set = buildConversationImages({
        messages: [toolMsg('r1', 'no-such-call')],
        files: [render('r1')],
      });
      expect(set.attempts[0].description).toBeUndefined();
      expect(set.attempts[0].ordinal).toBe(1);
    });

    it('survives malformed args without throwing', () => {
      const set = buildConversationImages({
        messages: [
          {
            attachments: [{ file_id: 'r1', toolCallId: 't1' }],
            content: [{ type: 'tool_call', tool_call: { id: 't1', name: 'x', args: '{not json' } }],
          },
        ],
        files: [render('r1')],
      });
      expect(set.attempts[0].description).toBeUndefined();
    });
  });

  describe('degenerate input is total, never thrown', () => {
    const cases: Array<[string, unknown, unknown]> = [
      ['no messages', [], []],
      ['messages with nothing in them', [{}, {}], []],
      ['null entries', [null, undefined], []],
      ['files with no messages', [], [upload('a')]],
    ];

    it.each(cases)('returns an empty set for %s', (_label, messages, files) => {
      expect(() =>
        buildConversationImages({
          messages: messages as ThreadImageMessage[],
          files: files as ImageFileDocument[],
        }),
      ).not.toThrow();
      const set = buildConversationImages({
        messages: messages as ThreadImageMessage[],
        files: files as ImageFileDocument[],
      });
      expect(set.sources).toEqual([]);
      expect(set.attempts).toEqual([]);
      expect(set.totalAttempts).toBe(0);
    });
  });
});
