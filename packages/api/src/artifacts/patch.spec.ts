import os from 'os';
import fs from 'fs';
import path from 'path';
import {
  parseArtifactEdits,
  resolveArtifactEdits,
  resolveArtifactEditsInContent,
  collectPriorArtifactTexts,
  resolveArtifactEditsWithDocs,
  resolveArtifactEditsInContentWithDocs,
} from './patch';
import { createOrVersionDoc, getDocMeta } from '../canvas/docs';

type ArtifactOptions = {
  type?: string;
  title?: string;
  fence?: string | false;
};

const artifact = (identifier: string, content: string, options: ArtifactOptions = {}): string => {
  const { type = 'text/markdown', title = 'Doc', fence = '```' } = options;
  const opening = `:::artifact{identifier="${identifier}" type="${type}" title="${title}"}`;
  const body = fence === false ? content : `${fence}\n${content}\n${fence}`;
  return `${opening}\n${body}\n:::`;
};

const block = (original: string, updated: string): string =>
  `<<<<<<< ORIGINAL\n${original}\n=======\n${updated}\n>>>>>>> UPDATED`;

const edit = (identifier: string, blocks: string[]): string =>
  `:::artifact-edit{identifier="${identifier}"}\n${blocks.join('\n')}\n:::`;

describe('parseArtifactEdits', () => {
  test('parses a single directive with one marker block', () => {
    const text = edit('doc-1', [block('old text', 'new text')]);
    const directives = parseArtifactEdits(text);

    expect(directives).toHaveLength(1);
    expect(directives[0].identifier).toBe('doc-1');
    expect(directives[0].blocks).toEqual([{ original: 'old text', updated: 'new text' }]);
    expect(text.slice(directives[0].start, directives[0].end)).toBe(text);
  });

  test('parses multiple marker blocks in a single directive', () => {
    const text = edit('doc-1', [block('a', 'A'), block('b', 'B')]);
    const directives = parseArtifactEdits(text);

    expect(directives).toHaveLength(1);
    expect(directives[0].blocks).toEqual([
      { original: 'a', updated: 'A' },
      { original: 'b', updated: 'B' },
    ]);
  });

  test('captures multi-line original and updated content', () => {
    const text = edit('doc-1', [block('line one\nline two', 'line one\nline changed')]);
    const directives = parseArtifactEdits(text);

    expect(directives[0].blocks[0]).toEqual({
      original: 'line one\nline two',
      updated: 'line one\nline changed',
    });
  });

  test('isolates a directive surrounded by prose', () => {
    const directive = edit('doc-1', [block('x', 'y')]);
    const text = `Here is a tweak:\n\n${directive}\n\nLet me know.`;
    const directives = parseArtifactEdits(text);

    expect(directives).toHaveLength(1);
    expect(text.slice(directives[0].start, directives[0].end)).toBe(directive);
  });

  test('ignores an unclosed directive (streaming truncation)', () => {
    const text = `:::artifact-edit{identifier="doc-1"}\n<<<<<<< ORIGINAL\nx\n=======\ny`;
    expect(parseArtifactEdits(text)).toEqual([]);
  });

  test('ignores a directive missing its closing marker', () => {
    const text = `:::artifact-edit{identifier="doc-1"}\n<<<<<<< ORIGINAL\nx\n=======\ny\n>>>>>>> UPDATED`;
    expect(parseArtifactEdits(text)).toEqual([]);
  });

  test('does not misparse a plain :::artifact block as an edit directive', () => {
    const text = artifact('doc-1', 'some content');
    expect(parseArtifactEdits(text)).toEqual([]);
  });
});

describe('resolveArtifactEdits', () => {
  test('rewrites a directive into a full artifact block with the source attributes', () => {
    const source = artifact('doc-1', 'Hello world', { type: 'text/markdown', title: 'My Doc' });
    const text = edit('doc-1', [block('Hello world', 'Goodbye world')]);

    const result = resolveArtifactEdits({ priorText: [source], text });

    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.text).toContain(
      ':::artifact{identifier="doc-1" type="text/markdown" title="My Doc"}',
    );
    expect(result.text).toContain('Goodbye world');
    expect(result.text).not.toContain('artifact-edit');
    expect(result.text).not.toContain('ORIGINAL');
  });

  test('patches the most recent artifact when several versions exist', () => {
    const v1 = artifact('doc-1', 'old-one');
    const v2 = artifact('doc-1', 'old-two');
    const text = edit('doc-1', [block('old-two', 'new-two')]);

    const result = resolveArtifactEdits({ priorText: [v1, v2], text });

    expect(result.applied).toBe(1);
    expect(result.text).toContain('new-two');
  });

  test('applies multiple marker blocks in order', () => {
    const source = artifact('doc-1', 'alpha\nbeta\ngamma');
    const text = edit('doc-1', [block('alpha', 'ALPHA'), block('gamma', 'GAMMA')]);

    const result = resolveArtifactEdits({ priorText: [source], text });

    expect(result.applied).toBe(1);
    expect(result.text).toContain('ALPHA');
    expect(result.text).toContain('GAMMA');
    expect(result.text).toContain('beta');
  });

  test('preserves prose surrounding the directive', () => {
    const source = artifact('doc-1', 'content here');
    const directive = edit('doc-1', [block('content here', 'content updated')]);
    const text = `Sure, here's the tweak:\n\n${directive}\n\nLet me know!`;

    const result = resolveArtifactEdits({ priorText: [source], text });

    expect(result.text.startsWith("Sure, here's the tweak:")).toBe(true);
    expect(result.text.endsWith('Let me know!')).toBe(true);
    expect(result.text).toContain('content updated');
  });

  test('survives source content containing code fences and ::: markers', () => {
    const content = `# Heading

\`\`\`js
console.log('x');
\`\`\`

Some ::: text inside

marker-target`;
    const source = artifact('doc-1', content, { fence: '````' });
    const text = edit('doc-1', [block('marker-target', 'marker-updated')]);

    const result = resolveArtifactEdits({ priorText: [source], text });

    expect(result.applied).toBe(1);
    expect(result.text).toContain('marker-updated');
    expect(result.text).toContain("console.log('x');");
    expect(result.text).toContain('```js');
    expect(result.text).toContain('Some ::: text inside');
    expect(result.text).toContain('````');
  });

  test('resolves against an artifact emitted earlier in the same text', () => {
    const source = artifact('doc-1', 'first draft');
    const text = `${source}\n\n${edit('doc-1', [block('first draft', 'second draft')])}`;

    const result = resolveArtifactEdits({ priorText: [], text });

    expect(result.applied).toBe(1);
    expect(result.text).toContain('second draft');
  });

  test('fails loud when no artifact matches the identifier', () => {
    const text = edit('missing-doc', [block('a', 'b')]);

    const result = resolveArtifactEdits({ priorText: [artifact('doc-1', 'a')], text });

    expect(result.applied).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.text).toContain(':::artifact-edit{identifier="missing-doc"}');
    expect(result.text).toContain(
      '> ⚠️ artifact edit failed: no artifact found with identifier "missing-doc"',
    );
  });

  test('fails loud when the original content is not found', () => {
    const source = artifact('doc-1', 'actual content');
    const text = edit('doc-1', [block('nonexistent original', 'whatever')]);

    const result = resolveArtifactEdits({ priorText: [source], text });

    expect(result.applied).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.text).toContain(':::artifact-edit{identifier="doc-1"}');
    expect(result.text).toContain(
      '> ⚠️ artifact edit failed: original content not found in artifact "doc-1"',
    );
  });

  test('is atomic per directive: a failing second block reverts the first', () => {
    const source = artifact('doc-1', 'apple\nbanana');
    const text = edit('doc-1', [block('apple', 'apricot'), block('zzz-missing', 'whatever')]);

    const result = resolveArtifactEdits({ priorText: [source], text });

    expect(result.applied).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.text).not.toContain(':::artifact{identifier="doc-1" type=');
    expect(result.text).toContain(':::artifact-edit{identifier="doc-1"}');
    expect(result.text).toContain('> ⚠️ artifact edit failed: original content not found');
  });

  test('returns input unchanged when no directive is present', () => {
    const text = `${artifact('doc-1', 'content')}\n\nplain prose`;
    const result = resolveArtifactEdits({ priorText: [], text });

    expect(result).toEqual({ text, applied: 0, failed: 0 });
  });
});

describe('resolveArtifactEditsInContent', () => {
  test('resolves the directive in the correct content part', () => {
    const source = artifact('doc-1', 'hello world');
    const content = [
      { type: 'text', text: 'Here is the update:' },
      { type: 'text', text: edit('doc-1', [block('hello world', 'hola mundo')]) },
      { type: 'text', text: 'Anything else?' },
    ];

    const result = resolveArtifactEditsInContent({ priorText: [source], content });

    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.content[0].text).toBe('Here is the update:');
    expect(result.content[1].text).toContain(':::artifact{identifier="doc-1"');
    expect(result.content[1].text).toContain('hola mundo');
    expect(result.content[1].text).not.toContain('artifact-edit');
    expect(result.content[2].text).toBe('Anything else?');
  });

  test('resolves a directive against an artifact in an earlier content part', () => {
    const content = [
      { type: 'text', text: artifact('doc-1', 'draft one') },
      { type: 'text', text: edit('doc-1', [block('draft one', 'draft two')]) },
    ];

    const result = resolveArtifactEditsInContent({ priorText: [], content });

    expect(result.applied).toBe(1);
    expect(result.content[1].text).toContain('draft two');
  });

  test('leaves non-text and directive-free parts untouched', () => {
    const image = { type: 'image_url', text: undefined };
    const content = [image, { type: 'text', text: 'just prose' }];

    const result = resolveArtifactEditsInContent({ priorText: [], content });

    expect(result.applied).toBe(0);
    expect(result.content[0]).toBe(image);
    expect(result.content[1].text).toBe('just prose');
  });
});

describe('collectPriorArtifactTexts', () => {
  test('collects artifact-bearing texts oldest to newest', () => {
    const older = artifact('doc-1', 'old');
    const newer = artifact('doc-1', 'new');
    const messages = [{ text: 'no artifacts here' }, { text: older }, { text: newer }];

    expect(collectPriorArtifactTexts(messages)).toEqual([older, newer]);
  });

  test('collects artifact-bearing text parts from content arrays', () => {
    const source = artifact('doc-1', 'content');
    const messages = [
      {
        content: [
          { type: 'text', text: 'intro' },
          { type: 'text', text: source },
        ],
      },
    ];

    expect(collectPriorArtifactTexts(messages)).toEqual([source]);
  });

  test('returns an empty array for empty or missing input', () => {
    expect(collectPriorArtifactTexts([])).toEqual([]);
    expect(collectPriorArtifactTexts(undefined)).toEqual([]);
    expect(collectPriorArtifactTexts(null)).toEqual([]);
  });
});

describe('resolveArtifactEditsWithDocs (canvas doc fallback)', () => {
  let baseDir: string;
  const userId = 'userAAAA';
  const canvasDocs = () => ({ baseDir, userId });

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-patch-'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const seedDoc = async (filename: string, content: string, uid = userId): Promise<string> => {
    const { docKey } = await createOrVersionDoc({ baseDir, userId: uid, filename, content });
    return docKey;
  };

  test('without canvasDocs it behaves exactly like resolveArtifactEdits', async () => {
    const text = edit('doc-md', [block('a', 'b')]);
    const withDocs = await resolveArtifactEditsWithDocs({ priorText: [], text });
    expect(withDocs).toEqual(resolveArtifactEdits({ priorText: [], text }));
    expect(withDocs.failed).toBe(1);
    expect(withDocs.text).not.toContain('Canvas doc');
  });

  test('falls back to a canvas doc, bumps the version, and emits a diff', async () => {
    const docKey = await seedDoc('doc.md', 'alpha\nbravo\ncharlie');
    const text = `Applying your change:\n\n${edit(docKey, [block('bravo', 'BRAVO')])}`;

    const result = await resolveArtifactEditsWithDocs({
      priorText: [],
      text,
      canvasDocs: canvasDocs(),
    });

    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.text).toContain(`**Canvas doc \`${docKey}\` updated to v2.**`);
    expect(result.text).toContain('```diff');
    expect(result.text).toContain('-bravo');
    expect(result.text).toContain('+BRAVO');
    expect(result.text).not.toContain(':::artifact-edit');

    const meta = await getDocMeta({ baseDir, userId, docKey });
    expect(meta?.currentVersion).toBe(2);
  });

  test('in-message artifacts take precedence over a same-identifier doc', async () => {
    const docKey = await seedDoc('doc.md', 'from-doc');
    const priorText = [artifact(docKey, 'in-message')];
    const text = edit(docKey, [block('in-message', 'edited-in-message')]);

    const result = await resolveArtifactEditsWithDocs({
      priorText,
      text,
      canvasDocs: canvasDocs(),
    });

    expect(result.applied).toBe(1);
    expect(result.text).toContain(`:::artifact{identifier="${docKey}"`);
    expect(result.text).toContain('edited-in-message');
    expect(result.text).not.toContain('Canvas doc');

    const meta = await getDocMeta({ baseDir, userId, docKey });
    expect(meta?.currentVersion).toBe(1);
  });

  test('unknown identifier fails loud without touching any doc', async () => {
    const text = edit('ghost-doc', [block('a', 'b')]);

    const result = await resolveArtifactEditsWithDocs({
      priorText: [],
      text,
      canvasDocs: canvasDocs(),
    });

    expect(result.applied).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.text).toContain(':::artifact-edit{identifier="ghost-doc"}');
    expect(result.text).toContain('⚠️ artifact edit failed: no artifact found with identifier');
  });

  test('a doc that exists but has no matching ORIGINAL fails loud', async () => {
    const docKey = await seedDoc('doc.md', 'hello world');
    const text = edit(docKey, [block('absent', 'x')]);

    const result = await resolveArtifactEditsWithDocs({
      priorText: [],
      text,
      canvasDocs: canvasDocs(),
    });

    expect(result.failed).toBe(1);
    expect(result.text).toContain('original content not found in canvas doc');
    const meta = await getDocMeta({ baseDir, userId, docKey });
    expect(meta?.currentVersion).toBe(1);
  });

  test('per-user isolation: one user’s directive cannot edit another user’s doc', async () => {
    const docKey = await seedDoc('secret.md', 'top secret', 'userBBBB');
    const text = edit(docKey, [block('top secret', 'leaked')]);

    const result = await resolveArtifactEditsWithDocs({
      priorText: [],
      text,
      canvasDocs: { baseDir, userId: 'userAAAA' },
    });

    expect(result.failed).toBe(1);
    expect(result.text).toContain('no artifact found with identifier');
    const meta = await getDocMeta({ baseDir, userId: 'userBBBB', docKey });
    expect(meta?.currentVersion).toBe(1);
  });

  test('content variant resolves a doc edit within a text part', async () => {
    const docKey = await seedDoc('doc.md', 'one two');
    const content = [
      { type: 'text', text: 'here goes' },
      { type: 'text', text: edit(docKey, [block('two', 'TWO')]) },
    ];

    const result = await resolveArtifactEditsInContentWithDocs({
      priorText: [],
      content,
      canvasDocs: canvasDocs(),
    });

    expect(result.applied).toBe(1);
    expect(result.content[1].text).toContain(`**Canvas doc \`${docKey}\` updated to v2.**`);
    const meta = await getDocMeta({ baseDir, userId, docKey });
    expect(meta?.currentVersion).toBe(2);
  });
});
