import { ANSWERS, type AnswerChoice } from './answers';

export interface QuestionStats { total: number; answered: number; unanswered: number; counts: Record<AnswerChoice, number>; percentages: Record<AnswerChoice, number>; correct: number; incorrect: number; correctPercentage: number; incorrectPercentage: number }

/**
 * Counts how many confirmed answers include each letter. For multi-answer questions the letter
 * percentages can add up to more than 100%. Correctness is an exact match of the whole key.
 */
export function calculateStats(answers: string[], total: number, correctAnswer?: string): QuestionStats {
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const answer of answers) for (const letter of ANSWERS) if (answer.includes(letter)) counts[letter]++;
  const answered = answers.length;
  const percentage = (n: number) => answered ? Math.round(n / answered * 10000) / 100 : 0;
  const correct = correctAnswer ? answers.filter(answer => answer === correctAnswer).length : 0;
  const incorrect = correctAnswer ? answered - correct : 0;
  return { total, answered, unanswered: Math.max(0, total - answered), counts,
    percentages: { A: percentage(counts.A), B: percentage(counts.B), C: percentage(counts.C), D: percentage(counts.D) },
    correct, incorrect, correctPercentage: percentage(correct), incorrectPercentage: percentage(incorrect) };
}
