const CONTEXT_LINES = 3;
const MAX_DIFF_CELLS = 4_000_000;

type DiffTag = ' ' | '-' | '+';

type DiffOp = {
  tag: DiffTag;
  line: string;
};

type Hunk = {
  start: number;
  end: number;
};

const buildOps = (a: string[], b: string[]): DiffOp[] | null => {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_DIFF_CELLS) {
    return null;
  }

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: ' ', line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ tag: '-', line: a[i] });
      i++;
    } else {
      ops.push({ tag: '+', line: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ tag: '-', line: a[i] });
    i++;
  }
  while (j < m) {
    ops.push({ tag: '+', line: b[j] });
    j++;
  }
  return ops;
};

const groupHunks = (ops: DiffOp[]): Hunk[] => {
  const changed: number[] = [];
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx].tag !== ' ') {
      changed.push(idx);
    }
  }
  if (changed.length === 0) {
    return [];
  }

  const last = ops.length - 1;
  const hunks: Hunk[] = [];
  let start = Math.max(0, changed[0] - CONTEXT_LINES);
  let end = Math.min(last, changed[0] + CONTEXT_LINES);
  for (let k = 1; k < changed.length; k++) {
    const at = changed[k];
    if (at - CONTEXT_LINES <= end + 1) {
      end = Math.min(last, at + CONTEXT_LINES);
    } else {
      hunks.push({ start, end });
      start = Math.max(0, at - CONTEXT_LINES);
      end = Math.min(last, at + CONTEXT_LINES);
    }
  }
  hunks.push({ start, end });
  return hunks;
};

const renderHunk = (ops: DiffOp[], hunk: Hunk, oldNo: number[], newNo: number[]): string => {
  let oldCount = 0;
  let newCount = 0;
  const body: string[] = [];
  for (let idx = hunk.start; idx <= hunk.end; idx++) {
    const op = ops[idx];
    if (op.tag !== '+') {
      oldCount++;
    }
    if (op.tag !== '-') {
      newCount++;
    }
    body.push(`${op.tag}${op.line}`);
  }
  const header = `@@ -${oldNo[hunk.start]},${oldCount} +${newNo[hunk.start]},${newCount} @@`;
  return [header, ...body].join('\n');
};

/**
 * Produces a git-style unified diff (hunk headers, three lines of context,
 * `-`/`+`/` ` line prefixes) between two texts, line by line. Returns an empty
 * string when the texts are identical, and `null` when the inputs are too large
 * to diff cheaply so the caller can fall back to a coarser rendering.
 */
export const unifiedDiff = (oldText: string, newText: string): string | null => {
  if (oldText === newText) {
    return '';
  }
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const ops = buildOps(a, b);
  if (!ops) {
    return null;
  }

  const oldNo: number[] = new Array<number>(ops.length);
  const newNo: number[] = new Array<number>(ops.length);
  let oldLine = 1;
  let newLine = 1;
  for (let idx = 0; idx < ops.length; idx++) {
    oldNo[idx] = oldLine;
    newNo[idx] = newLine;
    if (ops[idx].tag !== '+') {
      oldLine++;
    }
    if (ops[idx].tag !== '-') {
      newLine++;
    }
  }

  return groupHunks(ops)
    .map((hunk) => renderHunk(ops, hunk, oldNo, newNo))
    .join('\n');
};
