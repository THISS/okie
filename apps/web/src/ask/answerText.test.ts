import { describe, expect, it } from 'vitest';
import { readableAskAnswer, UNREADABLE_SAVED_ASK } from './answerText';
import { parseAskThreadTurns } from './askAtlas';

describe('readable saved Ask answers', () => {
  const answer = 'Ask searches the atlas.\n\n- The **web** collects the question.\n- The server retrieves evidence.';
  const envelope = JSON.stringify({ answer, citations: ['untrusted-new-id'] });

  it('unwraps complete, fenced, nested and citation-truncated envelopes without literal escapes', () => {
    for (const raw of [envelope, `\`\`\`json\n${envelope}\n\`\`\``, JSON.stringify(envelope), envelope.slice(0, -9)]) {
      expect(readableAskAnswer(raw)).toBe(answer);
    }
  });

  it('keeps ordinary Markdown and quoted prose, but does not display a broken answer envelope', () => {
    for (const raw of ['[Web](src/web.ts) renders the atlas.', '"Ask" searches the atlas.', '- First\n- Second', '```ts\nconst answer = 1;\n```']) expect(readableAskAnswer(raw)).toBe(raw);
    expect(readableAskAnswer('{"answer":"unfinished')).toBe(UNREADABLE_SAVED_ASK);
    expect(readableAskAnswer('{"answer":null}')).toBe(UNREADABLE_SAVED_ASK);
    expect(readableAskAnswer('{"answer":"invalid\\q",')).toBe(UNREADABLE_SAVED_ASK);
    expect(readableAskAnswer('x'.repeat(100_001))).toBe(UNREADABLE_SAVED_ASK);
  });

  it('repairs loaded turns while preserving their existing citation metadata', () => {
    const turns = parseAskThreadTurns([{ id: 'old', question: 'How?', answer: envelope.slice(0, -9), citations: ['trusted-existing-id'], scopeIds: ['trusted-existing-id'], createdAt: 1 }]);
    expect(turns[0]?.answer).toBe(answer);
    expect(turns[0]?.citations).toEqual(['trusted-existing-id']);
  });
});
