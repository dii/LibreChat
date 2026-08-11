import { isNonVisionModel, parseNonVisionModels } from './vision';

describe('parseNonVisionModels', () => {
  it('returns an empty set for absent or empty configuration', () => {
    expect(parseNonVisionModels(undefined).size).toBe(0);
    expect(parseNonVisionModels(null).size).toBe(0);
    expect(parseNonVisionModels('').size).toBe(0);
  });

  it('splits, trims and lowercases', () => {
    const set = parseNonVisionModels(' Qwen3.6-Heretic-Local , cydonia-24b-local ');
    expect(set.has('qwen3.6-heretic-local')).toBe(true);
    expect(set.has('cydonia-24b-local')).toBe(true);
    expect(set.size).toBe(2);
  });

  it('drops empty entries from sloppy configuration', () => {
    expect(parseNonVisionModels('a,,b,').size).toBe(2);
  });
});

describe('isNonVisionModel', () => {
  const configured = 'qwen3.6-heretic-local,cydonia-24b-local,llama3.2-3b-local';

  it('matches a listed model regardless of case or padding', () => {
    expect(isNonVisionModel('qwen3.6-heretic-local', configured)).toBe(true);
    expect(isNonVisionModel('  QWEN3.6-HERETIC-LOCAL  ', configured)).toBe(true);
  });

  it('leaves unlisted models alone, which is the whole safety property', () => {
    expect(isNonVisionModel('claude-sonnet-5', configured)).toBe(false);
    expect(isNonVisionModel('claude-fable-5', configured)).toBe(false);
    expect(isNonVisionModel('gemini-3-1-pro', configured)).toBe(false);
  });

  /**
   * The regression this design exists to prevent. `validateVisionModel`'s list
   * knows `claude-sonnet-4` but not `claude-sonnet-5`, so a capability-inferred
   * gate would classify current frontier models as blind and silently withhold
   * images from them. A deny-list must never do that.
   */
  it('never blinds a frontier model that is absent from any capability list', () => {
    for (const model of ['claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5']) {
      expect(isNonVisionModel(model, configured)).toBe(false);
    }
  });

  it('does not substring-match, so a vision variant is not caught by its base name', () => {
    expect(isNonVisionModel('llama3.2-vision', 'llama3.2')).toBe(false);
    expect(isNonVisionModel('qwen3.6-heretic-local-vl', configured)).toBe(false);
  });

  it('is total: junk or absent input yields today behaviour', () => {
    expect(isNonVisionModel(undefined, configured)).toBe(false);
    expect(isNonVisionModel(null, configured)).toBe(false);
    expect(isNonVisionModel('', configured)).toBe(false);
    expect(isNonVisionModel('qwen3.6-heretic-local', undefined)).toBe(false);
    expect(isNonVisionModel('qwen3.6-heretic-local', '')).toBe(false);
  });
});
