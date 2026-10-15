import { BadRequestException, Controller, Get, Injectable, NotFoundException, OnModuleInit, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AiJob as AiJobRecord, Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  analyzeItems, ANSWERS, answerLetters, findDuplicatePairs, foldText, hasPositionalOptions, keyToSource, QUESTION_TYPE_LABELS, DIFFICULTY_LABELS,
  type AiQuizReview, type AnswerChoice, type Difficulty, type QualityIssue, type QuestionType, type QuizQualityReport, type QuizResultsAnalysis,
} from '@classpulse/shared-types';
import { AuthGuard, AuthRequest } from './auth';
import { AiJobsService, AiService, AiTaskError, choice, pick, type AiUsage } from './ai';
import { PrismaService } from './prisma.service';

export interface ReviewQuestion { id: string; content: string; optionA: string; optionB: string; optionC: string; optionD: string; type: QuestionType; correctAnswer: string; knowledge: string; topic: string; difficulty: Difficulty | null }
const NEGATIVE = /(^|[^\p{L}])(không (?:đúng|phải|thuộc|có|là|được|nên|chính xác)|sai|ngoại trừ)(?=[^\p{L}]|$)/iu;
const ASKS_CHOICE = /nào|điều gì|đâu là|là gì/iu;
const MULTIPLE_HINT = /chọn (?:tất cả|các|nhiều|những|hai|ba)|những (?:phương án|đáp án|ý|phát biểu|câu)|các (?:phương án|đáp án|ý|phát biểu) (?:đúng|sai)|nhiều đáp án|mọi đáp án/iu;
const FIGURE = /(hình vẽ|hình|bảng|biểu đồ|đồ thị|sơ đồ|ảnh)\s+(?:sau|bên|dưới|trên|đã cho|\d+)|\((?:xem )?hình/iu;
const issue = (q: { id: string } | null, number: number | null, category: QualityIssue['category'], severity: QualityIssue['severity'], message: string, suggestion: string, related: number[] = []): QualityIssue =>
  ({ questionId: q?.id ?? null, number, category, severity, message, suggestion, source: 'RULE', related });

/** Fast checks that need no AI; they run on every quality report. */
export function ruleIssues(questions: ReviewQuestion[]): QualityIssue[] {
  const issues: QualityIssue[] = [];
  questions.forEach((q, i) => {
    const n = i + 1;
    const options = ANSWERS.map(letter => q[`option${letter}`]);
    const folded = options.map(foldText);
    for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) if (folded[a] && folded[a] === folded[b])
      issues.push(issue(q, n, 'FORMAT', 'HIGH', `Phương án ${ANSWERS[a]} và ${ANSWERS[b]} giống hệt nhau.`, 'Viết lại một trong hai phương án thành một phương án nhiễu khác.'));
    if (hasPositionalOptions(q)) issues.push(issue(q, n, 'WEAK_DISTRACTOR', 'LOW', 'Có phương án dạng “Tất cả các đáp án trên”/“Cả A và B”.', 'Loại phương án này dễ đoán và không thể xáo trộn khi trộn đề; nên thay bằng một nhiễu có nội dung.'));
    const keys = answerLetters(q.correctAnswer);
    if (q.type === 'SINGLE' && keys.length === 1) {
      const key = ANSWERS.indexOf(keys[0]);
      const others = options.filter((_, k) => k !== key).map(option => option.trim().length);
      const keyLength = options[key].trim().length;
      if (keyLength >= 20 && keyLength >= 1.6 * (others.reduce((a, b) => a + b, 0) / others.length) && others.every(length => keyLength > length + 10))
        issues.push(issue(q, n, 'ANSWER_CUE', 'MEDIUM', 'Đáp án đúng dài và chi tiết hơn hẳn các phương án nhiễu.', 'Cân bằng độ dài các phương án để học sinh không đoán được đáp án.'));
    }
    const negative = NEGATIVE.exec(q.content);
    if (negative && ASKS_CHOICE.test(q.content) && negative[2] !== negative[2].toUpperCase())
      issues.push(issue(q, n, 'LANGUAGE', 'LOW', `Câu hỏi phủ định (“${negative[2]}”) chưa được nhấn mạnh.`, 'In hoa từ phủ định, ví dụ “KHÔNG đúng”, “SAI”, để học sinh không đọc nhầm.'));
    if (q.type === 'MULTIPLE' && !MULTIPLE_HINT.test(q.content))
      issues.push(issue(q, n, 'FORMAT', 'LOW', 'Câu nhiều đáp án nhưng đề bài chưa nói rõ cần chọn nhiều đáp án.', 'Thêm “Chọn tất cả các đáp án đúng.” vào cuối câu hỏi.'));
    if (FIGURE.test(q.content)) issues.push(issue(q, n, 'MISSING_DATA', 'MEDIUM', 'Câu hỏi nhắc tới hình/bảng nhưng màn hình trình chiếu và thiết bị chỉ hiển thị chữ.', 'Mô tả dữ kiện của hình/bảng bằng lời ngay trong câu hỏi.'));
    if (foldText(q.content).length < 12) issues.push(issue(q, n, 'AMBIGUOUS', 'LOW', 'Câu hỏi rất ngắn, có thể thiếu dữ kiện.', 'Kiểm tra câu hỏi đã đủ ý và đủ dữ kiện để trả lời chưa.'));
  });
  // One issue per later question, listing every earlier question it resembles.
  const index = new Map(questions.map((q, i) => [q.id, i]));
  const similar = new Map<number, Array<{ number: number; score: number; kind: string }>>();
  for (const pair of findDuplicatePairs(questions.map(q => ({ id: q.id, content: q.content, options: ANSWERS.map(letter => q[`option${letter}`]) })), 0.8)) {
    const [first, second] = [index.get(pair.a)!, index.get(pair.b)!].sort((a, b) => a - b);
    similar.set(second, [...(similar.get(second) ?? []), { number: first + 1, score: pair.score, kind: pair.kind }]);
  }
  for (const [position, matches] of similar) {
    const numbers = matches.map(match => match.number).sort((a, b) => a - b);
    const top = Math.max(...matches.map(match => match.score));
    const stemOnly = matches.every(match => match.kind === 'STEM');
    issues.push(issue(questions[position], position + 1, 'DUPLICATE', matches.some(match => match.kind !== 'NEAR') ? 'HIGH' : 'MEDIUM',
      `Gần giống câu ${numbers.join(', ')} (tương đồng tới ${Math.round(top * 100)}%${stemOnly ? ', cùng câu dẫn nhưng khác phương án' : ''}).`, 'Giữ một câu hoặc viết lại để kiểm tra kiến thức khác.', numbers));
  }
  const singles = questions.filter(q => q.type === 'SINGLE' && q.correctAnswer.length === 1);
  if (singles.length >= 8) {
    const counts = ANSWERS.map(letter => singles.filter(q => q.correctAnswer === letter).length);
    const top = Math.max(...counts);
    if (top / singles.length >= 0.5) issues.push(issue(null, null, 'ANSWER_CUE', 'LOW', `Đáp án đúng tập trung ở ${ANSWERS[counts.indexOf(top)]} (${Math.round(top * 100 / singles.length)}% số câu một đáp án).`, 'Phân bố lại vị trí đáp án hoặc bật “Xáo trộn đáp án” khi mở phiên/kỳ thi.'));
  }
  return issues.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
}

const VERDICTS = ['OK', 'REVIEW', 'FIX'] as const;
const CATEGORIES = ['AMBIGUOUS', 'MISSING_DATA', 'MULTIPLE_CORRECT', 'WRONG_KEY', 'DUPLICATE', 'WEAK_DISTRACTOR', 'ANSWER_CUE', 'LANGUAGE', 'FORMAT', 'OTHER'] as const;
const SEVERITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
const RATINGS = ['GOOD', 'WEAK', 'IMPLAUSIBLE', 'POSSIBLY_CORRECT'] as const;
export const ReviewSchema = z.object({
  score: z.number().int(), summary: z.string(),
  questions: z.array(z.object({
    number: z.number().int(), verdict: choice(VERDICTS),
    issues: z.array(z.object({ category: choice(CATEGORIES), severity: choice(SEVERITIES), message: z.string(), suggestion: z.string(), related: z.array(z.number().int()) })),
    distractors: z.array(z.object({ option: choice(ANSWERS), rating: choice(RATINGS), note: z.string() })),
    suggestedRewrite: z.string(),
  })),
  duplicates: z.array(z.object({ numbers: z.array(z.number().int()), reason: z.string() })),
});
const REVIEW_SYSTEM = `You are a meticulous reviewer of multiple-choice exams written by Vietnamese teachers. Students read questions on a projector and answer A–D on keypads; there are no images, only text.

Review every question you are given and report only real problems:
- AMBIGUOUS: wording that allows more than one reading, vague qualifiers, or an unclear task.
- MISSING_DATA: the stem lacks information needed to answer (numbers, units, conditions, or a figure or table that is not included).
- MULTIPLE_CORRECT: for a single-answer question, another option can also be defended as correct; for a multiple-answer question, an option outside the key is also correct.
- WRONG_KEY: the marked key appears to be incorrect. Explain why.
- DUPLICATE: another question in the exam tests the same point with the same or nearly the same content. Put the other question numbers in related.
- WEAK_DISTRACTOR: implausible, joke, overlapping or obviously wrong options, "all/none of the above", options that differ in kind from the key.
- ANSWER_CUE: the key stands out — longest, most precise, grammatical agreement with the stem, repeats stem words, or absolute words appear only in distractors.
- LANGUAGE: spelling, missing diacritics, grammar or unclear Vietnamese. FORMAT/OTHER for anything else.

For each question, rate every distractor: GOOD (plausible and clearly wrong), WEAK (unlikely to attract anyone), IMPLAUSIBLE (obviously wrong), POSSIBLY_CORRECT (could be argued correct). Give the verdict OK, REVIEW or FIX. When the verdict is FIX, put an improved version of the whole question (stem, options A–D and key) in suggestedRewrite; otherwise leave it empty. Write messages and suggestions in Vietnamese, briefly and concretely.
Return one entry per question with the same number. Also list groups of duplicated questions in duplicates. score is the overall quality of this set from 0 to 100; summary is two to four sentences in Vietnamese.`;
const BATCH = 30;
const formatQuestion = (q: ReviewQuestion, number: number) => [
  `Câu ${number} [${QUESTION_TYPE_LABELS[q.type]}${q.difficulty ? `, độ khó: ${DIFFICULTY_LABELS[q.difficulty]}` : ''}${q.knowledge ? `, kiến thức: ${q.knowledge}` : ''}]`,
  q.content, ...ANSWERS.map(letter => `${letter}. ${q[`option${letter}`]}`), `Đáp án: ${answerLetters(q.correctAnswer).join(', ')}`,
].join('\n');

@Injectable()
export class QualityService implements OnModuleInit {
  constructor(private readonly db: PrismaService, private readonly ai: AiService, private readonly jobs: AiJobsService) {}
  onModuleInit() { this.jobs.register('REVIEW_QUIZ', (job, progress) => this.runReview(job, progress)); }
  private async quiz(teacherId: string, id: string) {
    const quiz = await this.db.quiz.findFirst({ where: { id, teacherId, deletedAt: null }, include: { questions: { where: { deletedAt: null }, orderBy: { order: 'asc' } } } });
    if (!quiz) throw new NotFoundException('Không tìm thấy bộ câu hỏi.');
    return quiz;
  }
  async report(teacherId: string, id: string): Promise<QuizQualityReport> {
    const quiz = await this.quiz(teacherId, id);
    const keyDistribution = Object.fromEntries(ANSWERS.map(letter => [letter, quiz.questions.filter(q => q.correctAnswer.includes(letter)).length])) as Record<AnswerChoice, number>;
    return {
      quizId: quiz.id, questionCount: quiz.questions.length, ruleIssues: ruleIssues(quiz.questions), keyDistribution,
      difficultyDistribution: Object.fromEntries((['EASY', 'MEDIUM', 'HARD', 'UNSET'] as const).map(level => [level, quiz.questions.filter(q => (q.difficulty ?? 'UNSET') === level).length])) as QuizQualityReport['difficultyDistribution'],
      typeDistribution: { SINGLE: quiz.questions.filter(q => q.type === 'SINGLE').length, MULTIPLE: quiz.questions.filter(q => q.type === 'MULTIPLE').length },
      latestReview: await this.jobs.latest<AiQuizReview>(teacherId, 'REVIEW_QUIZ', { quizId: quiz.id }),
      results: await this.results(teacherId, quiz),
    };
  }
  /**
   * Item analysis pooled over finished sessions that asked exactly the quiz's current questions. Questions are
   * matched by id or identical text (editing a quiz recreates ids) and answers mapped back through any shuffle,
   * so a corrected key re-scores earlier sessions.
   */
  private async results(teacherId: string, quiz: Awaited<ReturnType<QualityService['quiz']>>): Promise<QuizResultsAnalysis | null> {
    if (!quiz.questions.length) return null;
    const sessions = await this.db.quizSession.findMany({ where: { teacherId, quizId: quiz.id, status: 'FINISHED' }, orderBy: { createdAt: 'desc' }, take: 30,
      include: { questions: { select: { id: true, sourceQuestionId: true, content: true, optionOrder: true } }, participants: { select: { id: true, answers: { select: { questionId: true, answer: true } } } } } });
    const current = new Set(quiz.questions.map(q => q.id));
    const byText = new Map(quiz.questions.map(q => [foldText(q.content), q.id]));
    const responses: Array<{ id: string; answers: Record<string, string> }> = [];
    let sessionCount = 0;
    for (const session of sessions) {
      const mapping = new Map<string, { id: string; order: string }>();
      for (const question of session.questions) {
        const id = current.has(question.sourceQuestionId) ? question.sourceQuestionId : byText.get(foldText(question.content));
        if (id) mapping.set(question.id, { id, order: question.optionOrder });
      }
      if (mapping.size !== quiz.questions.length || new Set([...mapping.values()].map(m => m.id)).size !== quiz.questions.length) continue;
      sessionCount++;
      for (const participant of session.participants) responses.push({ id: participant.id, answers: Object.fromEntries(participant.answers.flatMap(answer => {
        const target = mapping.get(answer.questionId);
        return target ? [[target.id, keyToSource(answer.answer, target.order)]] : [];
      })) });
    }
    if (!sessionCount || !responses.length) return null;
    return { sessionCount, report: analyzeItems(quiz.questions.map(q => ({ id: q.id, correctAnswer: q.correctAnswer })), responses) };
  }
  async startReview(teacherId: string, id: string) {
    const quiz = await this.quiz(teacherId, id);
    if (!quiz.questions.length) throw new BadRequestException('Bộ câu hỏi chưa có câu nào để đánh giá.');
    return this.jobs.enqueue<AiQuizReview>(teacherId, 'REVIEW_QUIZ', { quizId: quiz.id }, { quizId: quiz.id, questionCount: quiz.questions.length });
  }
  private async runReview(job: AiJobRecord, progress: (value: number) => Promise<void>) {
    const quiz = await this.quiz(job.teacherId, job.quizId!).catch(() => { throw new AiTaskError('Bộ câu hỏi không còn tồn tại.'); });
    const questions = quiz.questions;
    const usage: AiUsage = { inputTokens: 0, outputTokens: 0 };
    const review: AiQuizReview = { score: 0, summary: '', questions: [], duplicates: [], reviewedQuestionIds: questions.map(q => q.id) };
    const summaries: string[] = [];
    let weighted = 0;
    for (let start = 0; start < questions.length; start += BATCH) {
      const batch = questions.slice(start, start + BATCH);
      const others = questions.map((q, i) => ({ q, n: i + 1 })).filter(({ n }) => n <= start || n > start + batch.length);
      const content = [
        `Đề gồm ${questions.length} câu. Hãy đánh giá các câu ${start + 1}–${start + batch.length} dưới đây.`,
        batch.map((q, k) => formatQuestion(q, start + k + 1)).join('\n\n'),
        others.length ? `Các câu khác trong cùng đề (chỉ dùng để phát hiện trùng lặp):\n${others.map(({ q, n }) => `Câu ${n}: ${q.content.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n')}` : '',
      ].filter(Boolean).join('\n\n');
      const { data, usage: used } = await this.ai.structured({ system: REVIEW_SYSTEM, content: [{ type: 'text', text: content }], schema: ReviewSchema, effort: 'high' });
      usage.inputTokens += used.inputTokens; usage.outputTokens += used.outputTokens;
      for (const item of data.questions) {
        const question = questions[item.number - 1];
        if (!question || item.number <= start || item.number > start + batch.length) continue;
        review.questions.push({ number: item.number, questionId: question.id, verdict: pick(item.verdict, VERDICTS, 'REVIEW'), suggestedRewrite: item.suggestedRewrite.trim(),
          // Ratings only make sense for wrong options; letters of the key are dropped even if the model rated them.
          distractors: item.distractors.map(d => ({ ...d, option: d.option.trim().toUpperCase() })).filter(d => ANSWERS.includes(d.option as AnswerChoice) && !question.correctAnswer.includes(d.option))
            .map(d => ({ option: d.option as AnswerChoice, rating: pick(d.rating, RATINGS, 'WEAK'), note: d.note })),
          issues: item.issues.map(found => ({ category: pick(found.category, CATEGORIES, 'OTHER'), severity: pick(found.severity, SEVERITIES, 'MEDIUM'), message: found.message, suggestion: found.suggestion,
            questionId: question.id, number: item.number, source: 'AI' as const, related: found.related.filter(n => n >= 1 && n <= questions.length && n !== item.number) })) });
      }
      review.duplicates.push(...data.duplicates.filter(group => group.numbers.length > 1));
      weighted += Math.max(0, Math.min(100, data.score)) * batch.length;
      summaries.push(data.summary.trim());
      await progress((start + batch.length) * 100 / questions.length);
    }
    review.questions.sort((a, b) => a.number - b.number);
    review.score = Math.round(weighted / questions.length);
    review.summary = summaries.filter(Boolean).join(' ');
    return { result: review as unknown as Prisma.InputJsonValue, usage };
  }
}
@ApiTags('Quality') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('quizzes')
export class QualityController {
  constructor(private readonly quality: QualityService) {}
  @Get(':id/quality') report(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.quality.report(req.teacherId, id); }
  @Post(':id/ai-review') review(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.quality.startReview(req.teacherId, id); }
}
