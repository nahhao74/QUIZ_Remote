import { ANSWERS, isAnswerKey, type AnswerKey, type QuestionType } from './answers';

export type Difficulty = 'EASY' | 'MEDIUM' | 'HARD';
export type QuestionOrigin = 'MANUAL' | 'IMPORT' | 'AI';
export const DIFFICULTIES: Difficulty[] = ['EASY', 'MEDIUM', 'HARD'];
export const DIFFICULTY_LABELS: Record<Difficulty, string> = { EASY: 'Dễ', MEDIUM: 'Trung bình', HARD: 'Khó' };
export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = { SINGLE: 'Một đáp án', MULTIPLE: 'Nhiều đáp án' };
export const MISSING_KEY_ISSUE = 'Chưa chọn đáp án đúng.';
export const QUESTION_LIMITS = { content: 4000, option: 1000, explanation: 4000, knowledge: 300, topic: 200, minDuration: 5, maxDuration: 3600, questionsPerQuiz: 200 } as const;

export interface QuestionInput {
  content: string; optionA: string; optionB: string; optionC: string; optionD: string;
  type?: QuestionType; correctAnswer: AnswerKey;
  explanation?: string; knowledge?: string; topic?: string; difficulty?: Difficulty | null; origin?: QuestionOrigin;
  durationSeconds: number; order: number;
}
export interface Question extends QuestionInput { id: string; type: QuestionType; explanation: string; knowledge: string; topic: string; difficulty: Difficulty | null; origin: QuestionOrigin }
/** Editor and import state: the correct answer may be missing until the teacher confirms it. */
export type QuestionDraft = Omit<QuestionInput, 'correctAnswer'> & { correctAnswer: AnswerKey | '' };

/** Problems that block saving, phrased for teachers. An empty list means the question can be saved. */
export function questionIssues(q: QuestionDraft): string[] {
  const issues: string[] = [];
  const type = q.type ?? 'SINGLE';
  if (!q.content.trim()) issues.push('Nội dung câu hỏi đang trống.');
  else if (q.content.length > QUESTION_LIMITS.content) issues.push(`Nội dung vượt quá ${QUESTION_LIMITS.content} ký tự.`);
  for (const letter of ANSWERS) {
    const option = q[`option${letter}`];
    if (!option.trim()) issues.push(`Phương án ${letter} đang trống.`);
    else if (option.length > QUESTION_LIMITS.option) issues.push(`Phương án ${letter} vượt quá ${QUESTION_LIMITS.option} ký tự.`);
  }
  const filled = ANSWERS.map(letter => q[`option${letter}`].trim().toLowerCase());
  const repeated = ANSWERS.filter((letter, index) => filled[index] && filled.indexOf(filled[index]) !== index);
  if (repeated.length) issues.push(`Phương án ${repeated.join(', ')} trùng nội dung với phương án khác.`);
  if (!q.correctAnswer) issues.push(MISSING_KEY_ISSUE);
  else if (!isAnswerKey(q.correctAnswer)) issues.push('Đáp án đúng không hợp lệ.');
  else if (type === 'SINGLE' && q.correctAnswer.length > 1) issues.push('Câu một đáp án chỉ được có một đáp án đúng. Hãy chuyển sang loại nhiều đáp án.');
  if (!Number.isInteger(q.durationSeconds) || q.durationSeconds < QUESTION_LIMITS.minDuration || q.durationSeconds > QUESTION_LIMITS.maxDuration) issues.push(`Thời gian phải từ ${QUESTION_LIMITS.minDuration} đến ${QUESTION_LIMITS.maxDuration} giây.`);
  if ((q.explanation ?? '').length > QUESTION_LIMITS.explanation) issues.push(`Lời giải vượt quá ${QUESTION_LIMITS.explanation} ký tự.`);
  if ((q.knowledge ?? '').length > QUESTION_LIMITS.knowledge) issues.push(`Kiến thức kiểm tra vượt quá ${QUESTION_LIMITS.knowledge} ký tự.`);
  if ((q.topic ?? '').length > QUESTION_LIMITS.topic) issues.push(`Chủ đề vượt quá ${QUESTION_LIMITS.topic} ký tự.`);
  return issues;
}
