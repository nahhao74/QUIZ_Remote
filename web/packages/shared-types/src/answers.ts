export const ANSWERS = ['A', 'B', 'C', 'D'] as const;
export type AnswerChoice = typeof ANSWERS[number];
/** Every non-empty subset of A–D in canonical (alphabetical) order. A single-answer key is one letter. */
export const ANSWER_KEYS = ['A', 'B', 'C', 'D', 'AB', 'AC', 'AD', 'BC', 'BD', 'CD', 'ABC', 'ABD', 'ACD', 'BCD', 'ABCD'] as const;
export type AnswerKey = typeof ANSWER_KEYS[number];
export type QuestionType = 'SINGLE' | 'MULTIPLE';
export const ANSWER_KEY_PATTERN = /^(?=[A-D])A?B?C?D?$/;

export const isAnswerKey = (value: unknown): value is AnswerKey => typeof value === 'string' && ANSWER_KEY_PATTERN.test(value);
/** Builds the canonical key from letters in any order or case; returns null when nothing valid remains. */
export function toAnswerKey(letters: Iterable<string>): AnswerKey | null {
  const set = new Set<string>();
  for (const letter of letters) for (const char of letter.toUpperCase()) if ((ANSWERS as readonly string[]).includes(char)) set.add(char);
  const key = ANSWERS.filter(letter => set.has(letter)).join('');
  return isAnswerKey(key) ? key : null;
}
export const answerLetters = (key: string): AnswerChoice[] => ANSWERS.filter(letter => key.includes(letter));
export const keyAllowedFor = (type: QuestionType, key: string) => isAnswerKey(key) && (type === 'MULTIPLE' || key.length === 1);
export const formatAnswerKey = (key: string) => answerLetters(key).join(', ');

/**
 * `order[i]` names the source option shown at display position i, e.g. "CADB" shows source C as A.
 * Keys and option texts are converted in both directions so shuffled sessions map back to the bank.
 */
export const IDENTITY_ORDER = 'ABCD';
export function isOptionOrder(order: string) { return order.length === 4 && [...ANSWERS].every(letter => order.includes(letter)); }
export function keyToDisplay(sourceKey: string, order: string): string {
  return toAnswerKey(answerLetters(sourceKey).map(letter => ANSWERS[order.indexOf(letter)])) ?? '';
}
export function keyToSource(displayKey: string, order: string): string {
  return toAnswerKey(answerLetters(displayKey).map(letter => order[ANSWERS.indexOf(letter)])) ?? '';
}
export function reorderOptions<T extends Record<`option${AnswerChoice}`, string>>(question: T, order: string): Record<`option${AnswerChoice}`, string> {
  return { optionA: question[`option${order[0] as AnswerChoice}`], optionB: question[`option${order[1] as AnswerChoice}`], optionC: question[`option${order[2] as AnswerChoice}`], optionD: question[`option${order[3] as AnswerChoice}`] };
}
