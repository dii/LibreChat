const mockGetFiles = jest.fn();
const mockUpdateFile = jest.fn();
const mockSaveBuffer = jest.fn();
const mockGetDownloadStream = jest.fn();

jest.mock('~/models', () => ({
  getFiles: (...args) => mockGetFiles(...args),
  updateFile: (...args) => mockUpdateFile(...args),
}));
jest.mock('./strategies', () => ({
  getStrategyFunctions: () => ({
    saveBuffer: (...args) => mockSaveBuffer(...args),
    getDownloadStream: (...args) => mockGetDownloadStream(...args),
  }),
}));

const { applyCanvasDocEdit, applyBlocks } = require('./canvasDocEdit');

/**
 * Needs (stated before the code):
 *
 * A1 A directive edits only a document the CALLING user owns.
 * A2 An ambiguous identifier changes nothing. Editing the wrong `notes.md` is
 *    worse than editing none, and there is no version history to recover from.
 * A3 A block that matches zero times, or more than once, aborts the WHOLE
 *    directive. A partly-applied edit is unrecoverable and invisible.
 * A4 A successful edit writes through the same storage strategy as everything
 *    else, and updates the file record's size.
 */

const file = (over = {}) => ({
  file_id: 'f1',
  filename: 'notes.md',
  user: 'u1',
  source: 'local',
  filepath: '/documents/notes.md',
  ...over,
});

const streamOf = (text) => ({
  async *[Symbol.asyncIterator]() {
    yield Buffer.from(text, 'utf8');
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSaveBuffer.mockResolvedValue('/documents/notes.md');
  mockUpdateFile.mockResolvedValue({});
});

describe('A1: scoped to the caller', () => {
  it('queries files for that user only', async () => {
    mockGetFiles.mockResolvedValue([]);
    await applyCanvasDocEdit({ userId: 'u1', identifier: 'notes.md', blocks: [{ original: 'a', updated: 'b' }] });
    expect(mockGetFiles).toHaveBeenCalledWith({ user: 'u1' }, null, { text: 0 });
  });

  it('returns notfound when the user owns nothing by that name', async () => {
    mockGetFiles.mockResolvedValue([file({ filename: 'other.md' })]);
    const result = await applyCanvasDocEdit({
      userId: 'u1',
      identifier: 'notes.md',
      blocks: [{ original: 'a', updated: 'b' }],
    });
    expect(result).toEqual({ status: 'notfound' });
    expect(mockSaveBuffer).not.toHaveBeenCalled();
  });
});

describe('A2: ambiguity changes nothing', () => {
  it('refuses when two files share the identifier', async () => {
    mockGetFiles.mockResolvedValue([file(), file({ file_id: 'f2' })]);
    const result = await applyCanvasDocEdit({
      userId: 'u1',
      identifier: 'notes.md',
      blocks: [{ original: 'a', updated: 'b' }],
    });
    expect(result).toEqual({ status: 'notfound' });
    expect(mockSaveBuffer).not.toHaveBeenCalled();
  });

  it('matches on the stem only when it is unambiguous', async () => {
    mockGetFiles.mockResolvedValue([file({ filename: 'notes.md' })]);
    mockGetDownloadStream.mockResolvedValue(streamOf('hello world'));
    const result = await applyCanvasDocEdit({
      userId: 'u1',
      identifier: 'notes',
      blocks: [{ original: 'world', updated: 'there' }],
    });
    expect(result.status).toBe('applied');
  });
});

describe('A3: all-or-nothing', () => {
  it('aborts when a block matches nothing', async () => {
    mockGetFiles.mockResolvedValue([file()]);
    mockGetDownloadStream.mockResolvedValue(streamOf('hello world'));
    const result = await applyCanvasDocEdit({
      userId: 'u1',
      identifier: 'notes.md',
      blocks: [{ original: 'absent', updated: 'x' }],
    });
    expect(result).toEqual({ status: 'nomatch' });
    expect(mockSaveBuffer).not.toHaveBeenCalled();
  });

  it('aborts when a block matches more than once', async () => {
    expect(applyBlocks('a a', [{ original: 'a', updated: 'b' }])).toBeNull();
  });

  it('writes nothing when a LATER block fails, not just the first', async () => {
    mockGetFiles.mockResolvedValue([file()]);
    mockGetDownloadStream.mockResolvedValue(streamOf('one two'));
    const result = await applyCanvasDocEdit({
      userId: 'u1',
      identifier: 'notes.md',
      blocks: [
        { original: 'one', updated: 'ONE' },
        { original: 'absent', updated: 'x' },
      ],
    });
    expect(result).toEqual({ status: 'nomatch' });
    expect(mockSaveBuffer).not.toHaveBeenCalled();
  });

  it('treats a no-op edit as nomatch rather than a silent success', async () => {
    mockGetFiles.mockResolvedValue([file()]);
    mockGetDownloadStream.mockResolvedValue(streamOf('same'));
    const result = await applyCanvasDocEdit({
      userId: 'u1',
      identifier: 'notes.md',
      blocks: [{ original: 'same', updated: 'same' }],
    });
    expect(result).toEqual({ status: 'nomatch' });
  });
});

describe('A4: a successful edit', () => {
  it('writes the new content and updates the record', async () => {
    mockGetFiles.mockResolvedValue([file()]);
    mockGetDownloadStream.mockResolvedValue(streamOf('hello world'));
    const result = await applyCanvasDocEdit({
      userId: 'u1',
      identifier: 'notes.md',
      blocks: [{ original: 'world', updated: 'there' }],
    });
    expect(result.status).toBe('applied');
    expect(result.oldContent).toBe('hello world');
    expect(result.newContent).toBe('hello there');
    expect(mockSaveBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', fileName: 'notes.md' }),
    );
    expect(mockUpdateFile).toHaveBeenCalledWith(
      expect.objectContaining({ file_id: 'f1', bytes: Buffer.byteLength('hello there') }),
    );
  });

  it('does not report a recoverable version, because there is none', async () => {
    mockGetFiles.mockResolvedValue([file()]);
    mockGetDownloadStream.mockResolvedValue(streamOf('a'));
    const result = await applyCanvasDocEdit({
      userId: 'u1',
      identifier: 'notes.md',
      blocks: [{ original: 'a', updated: 'b' }],
    });
    expect(result.version).toBe(1);
  });
});
