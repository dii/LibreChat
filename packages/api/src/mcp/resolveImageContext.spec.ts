import { resolveConversationImageContext } from './resolveImageContext';

const SERVER = 'comfyui-image';
const KEY = 'resolver-signing-key';
const USER = '507f1f77bcf86cd799439011';

const photoDoc = {
  file_id: 'photo-1',
  type: 'image/jpeg',
  width: 1536,
  height: 1024,
  filename: 'torso.jpg',
  context: 'message_attachment',
};

const messages = [
  { messageId: 'm2', parentMessageId: 'm1', files: [], attachments: [], content: [] },
  {
    messageId: 'm1',
    parentMessageId: null,
    files: [{ file_id: 'photo-1' }],
    attachments: [],
    content: [],
  },
];

const deps = () => ({
  getMessages: jest.fn().mockResolvedValue(messages),
  getFiles: jest.fn().mockResolvedValue([photoDoc]),
  filterFiles: jest.fn().mockImplementation(({ files }) => Promise.resolve(files)),
});

const base = (over = {}) => ({
  agentTools: [`edit_image_mcp_${SERVER}`],
  serverName: SERVER,
  signingKey: KEY,
  userId: USER,
  agentId: 'agent_abc',
  conversationId: 'conv-1',
  parentMessageId: 'm2',
  requestFileIds: [],
  ...deps(),
  ...over,
});

describe('resolveConversationImageContext', () => {
  it('returns the context text for an agent carrying the server tools', async () => {
    const text = await resolveConversationImageContext(base());
    expect(text).toContain('torso.jpg');
    expect(text).toMatch(/lcimg_/);
  });

  /* U8 and N5. A request that cannot use the feature must cost nothing: not a
   * Mongo query, not a network call, not a context key. These assert the
   * *absence of work*, which is the part a later refactor silently breaks. */
  /* eslint-disable jest/expect-expect --
   * Assertions live in expectNoWork, which is the point: every case must assert
   * the *same* absence of work, and inlining them would let them drift apart. */
  describe('costs nothing when it does not apply', () => {
    const expectNoWork = async (params: ReturnType<typeof base>) => {
      expect(await resolveConversationImageContext(params)).toBeNull();
      expect(params.getMessages).not.toHaveBeenCalled();
      expect(params.getFiles).not.toHaveBeenCalled();
    };

    it('when the agent carries no tools from the server', async () => {
      await expectNoWork(base({ agentTools: ['execute_code', 'web_search'] }));
    });

    it('when the agent carries MCP tools from a different server', async () => {
      await expectNoWork(base({ agentTools: ['edit_image_mcp_some-other-server'] }));
    });

    it('when a different server merely starts with the configured name', async () => {
      /* The key is `<tool>_mcp_<server>`, so the server name is a suffix. A
       * substring test would fire for `comfyui-image-staging` too, activating
       * the real broker's context for an agent carrying none of its tools. */
      await expectNoWork(base({ agentTools: [`edit_image_mcp_${SERVER}-staging`] }));
    });

    it('when no server is configured, so the feature is off', async () => {
      await expectNoWork(base({ serverName: undefined }));
    });

    it('when no signing key is configured', async () => {
      await expectNoWork(base({ signingKey: '' }));
    });

    it('when there is no principal to bind references to', async () => {
      await expectNoWork(base({ userId: '' }));
    });

    it('when the agent has no tools at all', async () => {
      await expectNoWork(base({ agentTools: undefined }));
    });
  });

  describe('turn one, before the conversation exists', () => {
    it('uses the request files and does not query messages', async () => {
      const params = base({
        conversationId: null,
        parentMessageId: null,
        requestFileIds: ['photo-1'],
      });
      const text = await resolveConversationImageContext(params);
      expect(params.getMessages).not.toHaveBeenCalled();
      expect(text).toContain('torso.jpg');
    });

    it('returns null when there are no request files either', async () => {
      const params = base({ conversationId: null, parentMessageId: null, requestFileIds: [] });
      expect(await resolveConversationImageContext(params)).toBeNull();
      expect(params.getFiles).not.toHaveBeenCalled();
    });
  });

  describe('authorisation', () => {
    it('passes the files through the access filter with the agent and principal', async () => {
      const params = base();
      await resolveConversationImageContext(params);
      expect(params.filterFiles).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER, agentId: 'agent_abc' }),
      );
    });

    it('offers nothing when the filter rejects everything', async () => {
      const params = base({ filterFiles: jest.fn().mockResolvedValue([]) });
      expect(await resolveConversationImageContext(params)).toBeNull();
    });

    it('still works when no filter was injected, relying on the reference to bind the principal', async () => {
      const params = base({ filterFiles: undefined });
      expect(await resolveConversationImageContext(params)).toContain('torso.jpg');
    });
  });

  /* This runs inside request initialisation. A throw here would fail a whole
   * conversation over an image that could simply have gone unmentioned. */
  describe('never throws out of request initialisation', () => {
    it('returns null when the message query fails', async () => {
      const params = base({ getMessages: jest.fn().mockRejectedValue(new Error('mongo down')) });
      await expect(resolveConversationImageContext(params)).resolves.toBeNull();
    });

    it('returns null when the file query fails', async () => {
      const params = base({ getFiles: jest.fn().mockRejectedValue(new Error('mongo down')) });
      await expect(resolveConversationImageContext(params)).resolves.toBeNull();
    });

    it('returns null when the access filter fails', async () => {
      const params = base({ filterFiles: jest.fn().mockRejectedValue(new Error('boom')) });
      await expect(resolveConversationImageContext(params)).resolves.toBeNull();
    });
  });

  it('selects the message fields the walk and the descriptions need', async () => {
    const params = base();
    await resolveConversationImageContext(params);
    const select = params.getMessages.mock.calls[0][1] as string;
    for (const field of ['messageId', 'parentMessageId', 'files', 'attachments', 'content']) {
      expect(select).toContain(field);
    }
  });

  /* The blocking finding from the 2026-08-08 implementation red-team.
   * `requestFileIds` originates in `req.body.files`, which the caller controls.
   * Without a user scope on this query, anyone who knows a file id pulls another
   * user's filename, dimensions and recovered prompt into their own context and
   * on to the LLM provider. The signed reference protects the bytes; it does not
   * protect this metadata, and the access filter fails open for the ordinary
   * ephemeral-agent case. So the scope on THIS query is the real gate. */
  describe('the file query is scoped to the principal', () => {
    it('never queries for a file id without constraining the owner', async () => {
      const params = base();
      await resolveConversationImageContext(params);
      const filter = params.getFiles.mock.calls[0][0];
      expect(filter).toEqual(expect.objectContaining({ user: USER }));
    });

    it('carries the tenant into the query when there is one', async () => {
      const params = base({ tenantId: 'tenant-7' });
      await resolveConversationImageContext(params);
      expect(params.getFiles.mock.calls[0][0]).toEqual(
        expect.objectContaining({ tenantId: 'tenant-7' }),
      );
    });

    it("offers nothing when the caller names someone else's file id", async () => {
      /* The scoped query is what makes this return empty; the model must then be
       * told about no images at all rather than about a stranger's photo. */
      const params = base({
        conversationId: null,
        parentMessageId: null,
        requestFileIds: ['someone-elses-file'],
        getFiles: jest.fn().mockResolvedValue([]),
      });
      expect(await resolveConversationImageContext(params)).toBeNull();
    });
  });
});
