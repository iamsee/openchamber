/**
 * LLM token stream → speakable sentences. Pure: no I/O, no timers.
 *
 * The chunker exists for one reason: time-to-first-audio. Synthesis costs
 * roughly `0.09 s/char + 0.3 s` on the measured Kokoro backend, so waiting for
 * the LLM's first full sentence before starting TTS adds seconds of silence at
 * the point the user is most aware of the delay. The FIRST chunk is therefore
 * held to `firstSentenceMaxChars` (12) and may break on a clause boundary
 * (，、；) rather than only on a sentence terminator, so the first ~1.4 s of
 * audio can start while the model is still producing the rest of the reply.
 *
 * Later chunks break only on sentence terminators, bounded below by `minChars`
 * (so a stray "好。" does not become its own HTTP round-trip) and above by
 * `maxChars` (so one synthesized frame stays inside the WS payload limit).
 *
 * Boundary detection is a character walk rather than a single regex because
 * CJK terminators need no trailing whitespace while Latin ones do: the shape
 * reused from packages/ui/src/components/chat/lib/streamTextCommit.ts:16 is
 * `/[.!?…][)"'»”’]?\s/` — the `\s` lookahead is what stops it splitting
 * "3.14" or "e.g.". That guard is preserved here for Latin terminators and
 * deliberately dropped for CJK ones, which are unambiguous on their own.
 */

const SENTENCE_END_CHARS = new Set(['。', '！', '？', '…', '!', '?', '‼', '⁇']);
// Only the period needs a whitespace guard: `!` and `?` end a sentence in both
// Latin and CJK text without one, and are handled by SENTENCE_END_CHARS above.
const LATIN_PERIOD = '.';
const CLOSING_QUOTE_CHARS = new Set([')', '"', "'", '»', '”', '’', '」', '』']);
const CLAUSE_BREAK_CHARS = new Set(['，', '、', '；', ',', ';', '：', ':']);
const WHITESPACE_CHARS = new Set([' ', '\t', '\n', '\r', '\u3000']);
// A force-split can leave a terminator stranded at the head of the next chunk.
const ORPHAN_BREAK = /^[。！？!?…，、；,;:：)\]"'»”’」』\s]+/;

const DEFAULTS = {
  firstSentenceMaxChars: 12,
  // Small on purpose: a COMPLETE sentence must be spoken promptly, so merging
  // is only worth it for degenerate fragments. Holding a finished 8-char
  // sentence for a longer one would stall second-sentence audio until the
  // model finishes — the exact latency this chunker exists to remove.
  minChars: 6,
  maxChars: 60,
};

/**
 * Index just past the first boundary in `text`, or -1 when there is none.
 * @param {string} text
 * @param {boolean} allowClauseBreak also split on ，、；
 * @returns {number}
 */
function findBoundaryIndex(text, allowClauseBreak) {
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (SENTENCE_END_CHARS.has(char)) {
      return i + 1 + countClosingQuotes(text, i + 1);
    }
    if (char === LATIN_PERIOD) {
      const afterQuotes = i + 1 + countClosingQuotes(text, i + 1);
      // A period only ends a sentence before whitespace or at the end of the
      // buffered text; otherwise "3.14" and "e.g." would split.
      if (afterQuotes >= text.length || WHITESPACE_CHARS.has(text[afterQuotes])) {
        return afterQuotes;
      }
    }
    if (allowClauseBreak && CLAUSE_BREAK_CHARS.has(char)) {
      return i + 1;
    }
  }
  return -1;
}

function countClosingQuotes(text, from) {
  let count = 0;
  while (from + count < text.length && CLOSING_QUOTE_CHARS.has(text[from + count])) {
    count += 1;
  }
  return count;
}

/**
 * Best split point at or before `limit`: the last whitespace boundary, so a
 * boundary-less run of Latin text does not get cut mid-word. CJK has no
 * spaces, so the hard limit is correct there.
 * @param {string} text
 * @param {number} limit
 * @returns {number}
 */
function findForceSplitIndex(text, limit) {
  const capped = Math.min(limit, text.length);
  for (let i = capped - 1; i > 0; i -= 1) {
    if (WHITESPACE_CHARS.has(text[i]) && !WHITESPACE_CHARS.has(text[i - 1])) {
      return i + 1;
    }
  }
  return capped;
}

/**
 * @param {object} [options]
 * @param {number} [options.firstSentenceMaxChars] hard cap for the first chunk (default 12)
 * @param {number} [options.minChars] later chunks shorter than this are merged forward
 * @param {number} [options.maxChars] later chunks longer than this are force-split
 */
export function createSentenceChunker(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const firstMax = Math.max(1, cfg.firstSentenceMaxChars);
  const minChars = Math.max(1, cfg.minChars);
  const maxChars = Math.max(minChars, cfg.maxChars);

  let buffer = '';
  let firstEmitted = false;

  const emit = (chunk) => {
    const trimmed = chunk.trim();
    if (trimmed.length === 0) {
      return null;
    }
    firstEmitted = true;
    return trimmed;
  };

  /**
   * Pull every chunk that is ready to be spoken now.
   * @returns {string[]}
   */
  const drain = () => {
    const out = [];
    for (;;) {
      if (buffer.length === 0) {
        break;
      }
      if (firstEmitted && ORPHAN_BREAK.test(buffer)) {
        buffer = buffer.replace(ORPHAN_BREAK, '');
        if (buffer.length === 0) {
          break;
        }
      }
      if (!firstEmitted) {
        const boundary = findBoundaryIndex(buffer.slice(0, firstMax), true);
        if (boundary > 0) {
          const chunk = emit(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary);
          if (chunk) {
            out.push(chunk);
          }
          continue;
        }
        // No boundary inside the first-chunk window: if more text has arrived
        // past the cap, force the split so first audio is never held hostage
        // by a model that opens with a long clause.
        if (buffer.length > firstMax) {
          const splitAt = findForceSplitIndex(buffer, firstMax);
          const chunk = emit(buffer.slice(0, splitAt));
          buffer = buffer.slice(splitAt);
          if (chunk) {
            out.push(chunk);
          }
          continue;
        }
        break;
      }

      const boundary = findBoundaryIndex(buffer, false);
      if (boundary >= minChars) {
        const chunk = emit(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary);
        if (chunk) {
          out.push(chunk);
        }
        continue;
      }
      if (buffer.length >= maxChars) {
        const splitAt = boundary > 0 ? boundary : findForceSplitIndex(buffer, maxChars);
        const chunk = emit(buffer.slice(0, splitAt));
        buffer = buffer.slice(splitAt);
        if (chunk) {
          out.push(chunk);
        }
        continue;
      }
      break;
    }
    return out;
  };

  return {
    /**
     * Feed LLM delta text; get back zero or more complete sentences.
     * @param {string} text
     * @returns {string[]}
     */
    push(text) {
      if (typeof text !== 'string' || text.length === 0) {
        return drain();
      }
      buffer += text;
      return drain();
    },
    /**
     * Release whatever is left at end-of-stream, force-split to `maxChars`.
     * @returns {string[]}
     */
    flush() {
      const out = drain();
      let rest = buffer.trim().replace(ORPHAN_BREAK, '');
      buffer = '';
      while (rest.length > maxChars) {
        const splitAt = findForceSplitIndex(rest, maxChars);
        const chunk = rest.slice(0, splitAt).trim();
        if (chunk.length > 0) {
          out.push(chunk);
          firstEmitted = true;
        }
        rest = rest.slice(splitAt).trim();
      }
      if (rest.length > 0) {
        out.push(rest);
        firstEmitted = true;
      }
      return out;
    },
    /** Reset for a new turn. */
    reset() {
      buffer = '';
      firstEmitted = false;
    },
    /** Unreleased text, for tests and diagnostics. */
    get pending() {
      return buffer;
    },
  };
}
