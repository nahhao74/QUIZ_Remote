export * from './answers';
export * from './stats';
export * from './question';
export * from './question-text';
export * from './similarity';
export * from './analysis';
export * from './shuffle';
import type { AnswerChoice, AnswerKey, QuestionType } from './answers';
import type { Difficulty, Question, QuestionDraft, QuestionInput } from './question';
import type { QuestionStats } from './stats';
import type { ItemAnalysisReport, ScoreSummary } from './analysis';

export type SessionStatus = 'LOBBY' | 'QUESTION_ACTIVE' | 'QUESTION_CLOSED' | 'FINISHED';
export type SessionMode = 'MANUAL' | 'TIMER';
export interface Teacher { id: string; email: string; name: string }
export interface AuthResponse { accessToken: string; teacher: Teacher }
export interface QuizInput { title: string; description: string; questions: QuestionInput[] }
export interface Quiz extends QuizInput { id: string; questions: Question[]; createdAt: string; updatedAt: string }
/** Question as shown to the class. The key and explanation are only present once the question is closed. */
export interface PublicQuestion { id: string; content: string; optionA: string; optionB: string; optionC: string; optionD: string; type: QuestionType; durationSeconds: number; order: number; correctAnswer?: AnswerKey; explanation?: string }
export interface Participant { id: string; deviceId: string; studentCode: string; studentName?: string | null; joinedAt: string; answered: boolean; answer?: AnswerKey; isCorrect?: boolean }
export interface QuestionResult { question: PublicQuestion; stats: QuestionStats }
export interface SessionSnapshot {
  id: string; quizId: string; title: string; roomCode: string; status: SessionStatus; mode: SessionMode;
  currentQuestionIndex: number; totalQuestions: number; currentQuestion: PublicQuestion | null;
  questionStartedAt: string | null; questionEndsAt: string | null; nextQuestionAt: string | null;
  serverTime: string; createdAt: string; finishedAt: string | null;
  participantCount: number; answerCount: number; participants: Participant[];
  stats: QuestionStats; results: QuestionResult[];
  classroomId: string | null; classroomName: string | null; examId: string | null; variantCode: string | null;
}
export interface SessionSettings { mode?: SessionMode; durationSeconds?: number }
export const SOCKET_EVENT = 'session:update';
export const SOCKET_JOIN = 'session:join';

export type ImportFormat = 'txt' | 'docx' | 'xlsx' | 'csv' | 'pdf';
export interface ImportResult { title: string; description: string; questions: QuestionDraft[]; warnings: string[]; sourceName: string; format: ImportFormat }

export type AiJobKind = 'GENERATE_QUESTIONS' | 'EXTRACT_QUESTIONS' | 'REVIEW_QUIZ' | 'ANALYZE_SESSION' | 'ANALYZE_EXAM';
export type AiJobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export type AiProviderName = 'gemini' | 'ollama' | 'anthropic';
/** `fallback`: local model that takes over when the primary runs out of quota or is unreachable. */
export interface AiStatus { enabled: boolean; provider: AiProviderName | null; model: string; fallback: { provider: AiProviderName; model: string } | null }
export const AI_PROVIDER_LABELS: Record<AiProviderName, string> = { gemini: 'Google Gemini', ollama: 'Ollama (máy chủ cục bộ)', anthropic: 'Anthropic Claude' };
export interface AiJob<R = unknown> {
  id: string; kind: AiJobKind; status: AiJobStatus; progress: number; error: string | null; result: R | null; input: Record<string, unknown>;
  documentId: string | null; quizId: string | null; sessionId: string | null; examId: string | null;
  model: string; inputTokens: number; outputTokens: number; createdAt: string; startedAt: string | null; finishedAt: string | null;
}
export interface DocumentSection { index: number; title: string; charCount: number; preview: string; pageStart: number | null; pageEnd: number | null }
export interface SourceDocument { id: string; filename: string; mimeType: string; size: number; pageCount: number | null; charCount: number; sections: DocumentSection[]; scanned: boolean; createdAt: string }
export interface GenerateQuestionsRequest { documentId: string; sectionIndexes: number[]; questionCount: number; easyPercent: number; mediumPercent: number; hardPercent: number; multiplePercent: number; instructions?: string; quizId?: string }
export interface GenerationResult { created: number; counts: Record<Difficulty, number> }
export type ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export interface DuplicateHint { questionId: string; quizId: string; quizTitle: string; content: string; similarity: number }
export interface GeneratedQuestion {
  id: string; jobId: string; content: string; optionA: string; optionB: string; optionC: string; optionD: string;
  type: QuestionType; correctAnswer: AnswerKey | ''; explanation: string; knowledge: string; topic: string; difficulty: Difficulty | null; sourceExcerpt: string;
  status: ReviewStatus; quizId: string | null; questionId: string | null; order: number; createdAt: string; reviewedAt: string | null;
  documentName: string | null; duplicate: DuplicateHint | null;
}

export interface BankQuestion extends Question { quizId: string; quizTitle: string; updatedAt: string }
export interface BankSearchResult { total: number; items: BankQuestion[]; topics: string[] }
export interface DuplicatePairView { score: number; stem: number; options: number; kind: 'EXACT' | 'NEAR' | 'STEM'; a: BankQuestion; b: BankQuestion }

export type QualityCategory = 'AMBIGUOUS' | 'MISSING_DATA' | 'MULTIPLE_CORRECT' | 'WRONG_KEY' | 'DUPLICATE' | 'WEAK_DISTRACTOR' | 'ANSWER_CUE' | 'LANGUAGE' | 'FORMAT' | 'OTHER';
export type Severity = 'HIGH' | 'MEDIUM' | 'LOW';
export const QUALITY_CATEGORY_LABELS: Record<QualityCategory, string> = {
  AMBIGUOUS: 'Mơ hồ', MISSING_DATA: 'Thiếu dữ kiện', MULTIPLE_CORRECT: 'Nhiều đáp án có thể đúng', WRONG_KEY: 'Nghi sai đáp án', DUPLICATE: 'Trùng nội dung',
  WEAK_DISTRACTOR: 'Phương án nhiễu yếu', ANSWER_CUE: 'Lộ đáp án', LANGUAGE: 'Ngôn ngữ, chính tả', FORMAT: 'Hình thức', OTHER: 'Khác',
};
export const SEVERITY_LABELS: Record<Severity, string> = { HIGH: 'Nghiêm trọng', MEDIUM: 'Cần xem lại', LOW: 'Gợi ý' };
export interface QualityIssue { questionId: string | null; number: number | null; category: QualityCategory; severity: Severity; message: string; suggestion: string; source: 'RULE' | 'AI'; related: number[] }
export interface DistractorReview { option: AnswerChoice; rating: 'GOOD' | 'WEAK' | 'IMPLAUSIBLE' | 'POSSIBLY_CORRECT'; note: string }
export interface AiQuestionReview { number: number; questionId: string | null; verdict: 'OK' | 'REVIEW' | 'FIX'; issues: QualityIssue[]; distractors: DistractorReview[]; suggestedRewrite: string }
export interface AiQuizReview { score: number; summary: string; questions: AiQuestionReview[]; duplicates: Array<{ numbers: number[]; reason: string }>; reviewedQuestionIds: string[] }
/** Item analysis of finished sessions matched back to the quiz's current questions. */
export interface QuizResultsAnalysis { sessionCount: number; report: ItemAnalysisReport }
export interface QuizQualityReport {
  quizId: string; questionCount: number; ruleIssues: QualityIssue[];
  keyDistribution: Record<AnswerChoice, number>; difficultyDistribution: Record<Difficulty | 'UNSET', number>; typeDistribution: Record<QuestionType, number>;
  latestReview: AiJob<AiQuizReview> | null; results: QuizResultsAnalysis | null;
}
export interface AiResultInsight {
  summary: string; strengths: string[]; weaknesses: Array<{ topic: string; evidence: string; suggestion: string }>;
  questionFlags: Array<{ number: number; issue: string; recommendation: string }>; recommendations: string[]; classComparison: string;
}
export interface AnalyzedQuestion extends PublicQuestion { correctAnswer: AnswerKey; knowledge: string; topic: string; difficulty: Difficulty | null }
export interface SessionAnalysis {
  sessionId: string; title: string; status: SessionStatus; questions: AnalyzedQuestion[]; report: ItemAnalysisReport;
  students: Array<{ participantId: string; studentCode: string; studentName: string | null; correct: number; score: number }>;
  latestInsight: AiJob<AiResultInsight> | null;
}

export interface Student { id: string; code: string; name: string; externalId: string }
export interface Classroom { id: string; name: string; description: string; studentCount: number; sessionCount: number; createdAt: string; students?: Student[] }
export interface ClassSessionSummary { id: string; title: string; createdAt: string; status: SessionStatus; questionCount: number; participantCount: number; examId: string | null; variantCode: string | null; summary: ScoreSummary }
export interface ClassReport {
  classroom: Classroom; sessions: ClassSessionSummary[];
  /** One row per roster student or unknown device code; scores align with `sessions`. */
  students: Array<{ code: string; name: string | null; scores: Array<number | null>; average: number | null }>;
  overall: ScoreSummary;
}

export interface ExamVariant { code: string; questionCount: number }
export interface ExamSessionSummary extends ClassSessionSummary { classroomId: string | null; classroomName: string | null }
export interface Exam {
  id: string; title: string; description: string; quizId: string; quizTitle: string; shuffleQuestions: boolean; shuffleOptions: boolean;
  durationSeconds: number | null; questionCount: number; variants: ExamVariant[]; sessions: ExamSessionSummary[]; createdAt: string;
}
export interface ExamVariantQuestion { number: number; sourceNumber: number; content: string; optionA: string; optionB: string; optionC: string; optionD: string; type: QuestionType; correctAnswer: AnswerKey; explanation: string }
export interface ExamVariantDetail { code: string; questions: ExamVariantQuestion[] }
export interface ExamReport {
  exam: Exam; overall: ScoreSummary;
  classes: Array<{ classroomId: string | null; classroomName: string; sessionIds: string[]; summary: ScoreSummary }>;
  questions: Array<{ number: number; content: string; knowledge: string; topic: string; difficulty: Difficulty | null; correctRate: number; byClass: Record<string, number> }>;
  latestInsight: AiJob<AiResultInsight> | null;
}
