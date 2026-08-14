import { toAttachedFile } from '../AttachExistingDialog';
import type { TFile } from 'librechat-data-provider';

function file(overrides: Partial<TFile> = {}): TFile {
  return {
    file_id: 'abc',
    filename: 'shoulder.png',
    filepath: '/uploads/alice/shoulder.png',
    type: 'image/png',
    bytes: 1234,
    width: 1024,
    height: 768,
    conversationId: 'original-conversation',
    ...overrides,
  } as TFile;
}

describe('toAttachedFile', () => {
  it('marks the file as attached so removing it does not delete the original', () => {
    /* FileRow keys deletion on `attached`. Without this flag, dismissing a
       referenced photo from one message would destroy the user's file. */
    expect(toAttachedFile(file()).attached).toBe(true);
  });

  it('reports the upload as already complete', () => {
    /* progress < 1 makes the composer treat it as an in-flight upload and offer
       to abort something that was never uploading. */
    expect(toAttachedFile(file()).progress).toBe(1);
  });

  it('carries the existing file_id rather than minting a new one', () => {
    expect(toAttachedFile(file({ file_id: 'existing-id' })).file_id).toBe('existing-id');
  });

  it('does NOT carry conversationId, so attaching cannot rewrite provenance', () => {
    /* conversationId records where a file was first uploaded. If attaching
       rewrote it, a file would appear to move between conversations and the
       most recent chat would erase where it came from. */
    expect(toAttachedFile(file())).not.toHaveProperty('conversationId');
  });

  it('carries no File blob, because nothing is being uploaded', () => {
    expect(toAttachedFile(file()).file).toBeUndefined();
  });

  it('preserves dimensions, which the image path needs', () => {
    const attached = toAttachedFile(file());
    expect([attached.width, attached.height]).toEqual([1024, 768]);
  });

  it('tolerates a file with no byte count', () => {
    expect(toAttachedFile(file({ bytes: undefined })).size).toBe(0);
  });
});
