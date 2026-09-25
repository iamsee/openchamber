import { describe, expect, it } from 'bun:test';

import { createSentenceChunker } from './sentence-chunker.js';

const collect = (chunker, text) => [...chunker.push(text), ...chunker.flush()];

describe('createSentenceChunker first chunk', () => {
  it('splits on a clause boundary so first audio does not wait for a full sentence', () => {
    const chunks = createSentenceChunker().push('好的，我来帮你查一下这个问题的具体情况。');

    expect(chunks[0]).toBe('好的，');
    expect(chunks[0].length).toBeLessThanOrEqual(12);
    expect(chunks[1]).toBe('我来帮你查一下这个问题的具体情况。');
  });

  it('splits on 、 and ； as well as ，', () => {
    for (const text of ['嗯、我知道了。', '好的；马上处理。']) {
      const chunker = createSentenceChunker();
      expect(chunker.push(text)[0].length).toBeLessThanOrEqual(12);
    }
  });

  it('force-splits at the cap when the opening has no boundary at all', () => {
    const chunker = createSentenceChunker();
    const text = '这是一个完全没有标点符号的很长很长的中文句子用来测试强制切分行为';
    const chunks = chunker.push(text);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(12);
    expect(chunker.pending).toHaveLength(text.length - 12);
    expect(chunks[0] + collect(chunker, '').join('')).toBe(text);
  });

  it('honours a smaller firstSentenceMaxChars', () => {
    const chunks = createSentenceChunker({ firstSentenceMaxChars: 4 }).push('好的，我来帮你查一下。');
    expect(chunks[0]).toBe('好的，');
  });

  it('does not strand a terminator at the head of the next chunk', () => {
    const chunker = createSentenceChunker();
    const chunks = chunker.push('一二三四五六七八九十一二。后续内容');

    expect(chunks).toEqual(['一二三四五六七八九十一二']);
    expect(chunker.pending).toBe('后续内容');
    expect(chunker.pending.startsWith('。')).toBe(false);
  });

  it('keeps the first chunk short even for a Latin opening', () => {
    const chunks = createSentenceChunker().push('Pi is 3.14 approximately. The next sentence follows here.');

    expect(chunks[0].length).toBeLessThanOrEqual(12);
    expect(chunks[0]).toContain('3.14');
  });
});

describe('createSentenceChunker later chunks', () => {
  it('splits on sentence terminators but not on clause marks', () => {
    const chunks = createSentenceChunker().push('好的。然后我们需要检查，确认，最后再提交。');

    expect(chunks).toEqual(['好的。', '然后我们需要检查，确认，最后再提交。']);
  });

  it('does not split a decimal point or an abbreviation', () => {
    const chunks = createSentenceChunker().push('好的。Pi is 3.14 approximately.');

    expect(chunks).toEqual(['好的。', 'Pi is 3.14 approximately.']);
  });

  it('keeps a closing quote attached to its terminator', () => {
    const chunks = createSentenceChunker().push('好的。He said "stop" then left.');

    expect(chunks[1]).toBe('He said "stop" then left.');
  });

  it('merges a degenerate fragment into the next sentence', () => {
    const chunker = createSentenceChunker();
    const chunks = chunker.push('好的，嗯。这是一个足够长的后续句子。');

    expect(chunks).toEqual(['好的，']);
    expect(chunker.pending).toBe('嗯。这是一个足够长的后续句子。');
    expect(chunker.flush()).toEqual(['嗯。这是一个足够长的后续句子。']);
  });

  it('force-splits a boundary-less run at maxChars', () => {
    const chunker = createSentenceChunker();
    const chunks = chunker.push('字'.repeat(130));

    expect(chunks[0]).toHaveLength(12);
    expect(chunks[1]).toHaveLength(60);
    for (const chunk of [...chunks, ...chunker.flush()]) {
      expect(chunk.length).toBeLessThanOrEqual(60);
    }
  });

  it('splits on a newline', () => {
    const chunker = createSentenceChunker();
    expect(chunker.push('好的。\n第二段内容在这里。')[1]).toBe('\n第二段内容在这里。'.trim());
  });
});

describe('createSentenceChunker streaming', () => {
  const TEXT = '好的，我来帮你查一下。然后我们再看看别的。';

  it('produces the same chunks fed token by token as fed at once', () => {
    const oneShot = collect(createSentenceChunker(), TEXT);

    const incremental = createSentenceChunker();
    const streamed = [];
    for (let i = 0; i < TEXT.length; i += 2) {
      streamed.push(...incremental.push(TEXT.slice(i, i + 2)));
    }
    streamed.push(...incremental.flush());

    expect(streamed).toEqual(oneShot);
  });

  it('holds text until a boundary arrives', () => {
    const chunker = createSentenceChunker();
    expect(chunker.push('好的')).toEqual([]);
    expect(chunker.pending).toBe('好的');
    expect(chunker.push('，')).toEqual(['好的，']);
  });

  it('ignores empty and non-string pushes', () => {
    const chunker = createSentenceChunker();
    expect(chunker.push('')).toEqual([]);
    expect(chunker.push(null)).toEqual([]);
    expect(chunker.push(undefined)).toEqual([]);
  });

  it('releases the remainder on flush', () => {
    const chunker = createSentenceChunker();
    chunker.push('好的，');
    expect(chunker.flush()).toEqual([]);

    chunker.push('未结束的尾巴');
    expect(chunker.flush()).toEqual(['未结束的尾巴']);
    expect(chunker.pending).toBe('');
  });

  it('re-arms the first-chunk rule after reset', () => {
    const chunker = createSentenceChunker();
    collect(chunker, '字'.repeat(80));

    chunker.reset();
    expect(chunker.pending).toBe('');
    expect(chunker.push('好的，再来一次。')[0]).toBe('好的，');
  });
});
