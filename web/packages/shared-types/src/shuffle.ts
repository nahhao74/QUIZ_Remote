import { ANSWERS, IDENTITY_ORDER, type AnswerChoice } from './answers';

/** Deterministic 32-bit PRNG (mulberry32): the same seed always rebuilds the same exam variant. */
export function createRng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function seedFrom(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}
export function shuffleWith<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

const POSITIONAL_PHRASES = /tất cả|toàn bộ các|đều đúng|đều sai|không có (?:đáp án|phương án|câu|ý) nào|cả (?:hai|ba|bốn) |các (?:đáp án|phương án) trên|all of the above|none of the above|both of/i;
const LETTER_REFERENCE = /(?:^|[^\p{L}])[A-D](?:\s*(?:,|và|and|&)\s*[A-D])+(?![\p{L}])/u;
/** Options such as "Cả A và B" or "Tất cả đều đúng" depend on their position, so they are never shuffled. */
export function hasPositionalOptions(question: Record<`option${AnswerChoice}`, string>) {
  return ANSWERS.some(letter => POSITIONAL_PHRASES.test(question[`option${letter}`]) || LETTER_REFERENCE.test(question[`option${letter}`]));
}

export interface VariantItem { index: number; order: string }
/** One exam variant: question order (indexes into the source list) and a display option order per question. */
export function buildVariant(questions: Array<Record<`option${AnswerChoice}`, string>>, random: () => number, options: { shuffleQuestions: boolean; shuffleOptions: boolean }): VariantItem[] {
  const indexes = questions.map((_, index) => index);
  return (options.shuffleQuestions ? shuffleWith(indexes, random) : indexes).map(index => ({
    index,
    order: options.shuffleOptions && !hasPositionalOptions(questions[index]) ? shuffleWith([...IDENTITY_ORDER], random).join('') : IDENTITY_ORDER,
  }));
}
export const variantCodes = (count: number, start = 101) => Array.from({ length: count }, (_, i) => String(start + i));
