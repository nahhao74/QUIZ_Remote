import { BadRequestException, Controller, Get, Injectable, NotFoundException, OnModuleInit, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AiJob as AiJobRecord, Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  analyzeItems, DIFFICULTY_LABELS, GRADE_BANDS, ITEM_FLAG_LABELS, QUESTION_TYPE_LABELS, scoreOf, summarizeScores,
  type AiResultInsight, type AnswerKey, type ItemAnalysisReport, type ScoreSummary, type SessionAnalysis,
} from '@classpulse/shared-types';
import { AuthGuard, AuthRequest } from './auth';
import { AiJobsService, AiService, AiTaskError } from './ai';
import { PrismaService } from './prisma.service';

type ScoredSession = { questions: Array<{ id: string; correctAnswer: string }>; participants: Array<{ id: string; studentCode: string; answers: Array<{ questionId: string; answer: string }> }> };
/** Scores on the 10-point scale over every question in the session, as the devices display them. */
export function sessionScores(session: ScoredSession) {
  const keys = new Map(session.questions.map(question => [question.id, question.correctAnswer]));
  const students = session.participants.map(participant => {
    const correct = participant.answers.filter(answer => keys.get(answer.questionId) === answer.answer).length;
    return { participantId: participant.id, studentCode: participant.studentCode, correct, score: scoreOf(correct, session.questions.length) };
  });
  return { students, summary: summarizeScores(students.map(student => student.score)) };
}

export const InsightSchema = z.object({
  summary: z.string(), strengths: z.array(z.string()),
  weaknesses: z.array(z.object({ topic: z.string(), evidence: z.string(), suggestion: z.string() })),
  questionFlags: z.array(z.object({ number: z.number().int(), issue: z.string(), recommendation: z.string() })),
  recommendations: z.array(z.string()), classComparison: z.string(),
});
const INSIGHT_SYSTEM = `You are an assessment analyst helping a Vietnamese teacher understand the results of a multiple-choice test that students answered on classroom keypads. Write in clear Vietnamese for teachers; when you use a statistical term, explain it in a few words.

Use only the statistics provided; do not speculate about individual students.
- summary: three to five sentences on overall performance and how reliable the results are.
- strengths: knowledge points most students have mastered, citing question numbers.
- weaknesses: topics or knowledge points students struggled with, each with evidence (question numbers, percentages) and one concrete teaching suggestion.
- questionFlags: questions whose statistics suggest a flawed item — negative or very low discrimination, a distractor chosen more often than the key, nearly everyone right or wrong, distractors nobody chose. Say what to check (wrong key, ambiguous wording, implausible distractors) and how to fix it.
- recommendations: next teaching steps and improvements for the next test.
- classComparison: when several classes are included, compare them and suggest what each class needs; otherwise an empty string.
With fewer than 15 students, say that the statistics are unstable and conclusions are tentative.`;

export interface InsightQuestion { number: number; content: string; options: [string, string, string, string]; correctAnswer: string; type: 'SINGLE' | 'MULTIPLE'; knowledge: string; topic: string; difficulty: 'EASY' | 'MEDIUM' | 'HARD' | null }
const pct = (value: number) => `${Math.round(value * 100)}%`;
const clip = (text: string, length: number) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > length ? `${flat.slice(0, length)}…` : flat; };
export function describeSummary(summary: ScoreSummary) {
  return `${summary.count} học sinh; điểm trung bình ${summary.mean}/10; trung vị ${summary.median}; độ lệch chuẩn ${summary.standardDeviation}; thấp nhất ${summary.min}, cao nhất ${summary.max}; tỷ lệ đạt (≥ 5) ${summary.passRate}%; ${GRADE_BANDS.map(band => `${band.label}: ${summary.bands[band.band]}`).join(', ')}.`;
}
/** Compact, model-friendly description of the test and its item statistics. */
export function describeResults(title: string, questions: InsightQuestion[], report: ItemAnalysisReport, extra = '') {
  const lines = [`Bài kiểm tra: ${title}`, `Tổng quan: ${describeSummary(report.scores)} Độ tin cậy KR-20: ${report.reliability ?? 'không tính được'}.`, extra, 'Từng câu hỏi:'];
  report.items.forEach((item, i) => {
    const q = questions[i];
    lines.push(`Câu ${q.number} (${QUESTION_TYPE_LABELS[q.type]}${q.difficulty ? `, độ khó dự kiến: ${DIFFICULTY_LABELS[q.difficulty]}` : ''}${q.topic ? `, chủ đề: ${clip(q.topic, 80)}` : ''}${q.knowledge ? `, kiến thức: ${clip(q.knowledge, 100)}` : ''}): ${clip(q.content, 300)}`);
    lines.push(`  ${q.options.map((option, k) => `${'ABCD'[k]}. ${clip(option, 80)}`).join(' | ')}`);
    lines.push(`  Đáp án: ${q.correctAnswer}. Tỷ lệ đúng ${pct(item.difficulty)}; độ phân biệt ${item.discrimination ?? 'n/a'}; tương quan điểm-câu ${item.pointBiserial ?? 'n/a'}; tỷ lệ chọn ${item.options.map(option => `${option.option} ${pct(option.rate)}`).join(', ')}.${item.flags.length ? ` Cảnh báo: ${item.flags.map(flag => ITEM_FLAG_LABELS[flag]).join('; ')}.` : ''}`);
  });
  return lines.filter(Boolean).join('\n');
}

@Injectable()
export class AnalyticsService implements OnModuleInit {
  constructor(private readonly db: PrismaService, private readonly ai: AiService, private readonly jobs: AiJobsService) {}
  onModuleInit() { this.jobs.register('ANALYZE_SESSION', job => this.runSessionInsight(job)); }
  private async load(teacherId: string, id: string) {
    const session = await this.db.quizSession.findFirst({ where: { id, teacherId }, include: {
      questions: { orderBy: { order: 'asc' } }, participants: { orderBy: { studentCode: 'asc' }, include: { answers: true } },
      classroom: { select: { students: { select: { code: true, name: true } } } },
    } });
    if (!session) throw new NotFoundException('Không tìm thấy phiên học.');
    return session;
  }
  private compute(session: Awaited<ReturnType<AnalyticsService['load']>>) {
    // Item statistics cover only questions that were actually asked.
    const asked = session.questions.filter(question => question.openedAt);
    const responses = session.participants.map(participant => ({ id: participant.id, answers: Object.fromEntries(participant.answers.map(answer => [answer.questionId, answer.answer])) }));
    const report = analyzeItems(asked.map(question => ({ id: question.id, correctAnswer: question.correctAnswer })), responses);
    const questions: InsightQuestion[] = asked.map(question => ({ number: question.order + 1, content: question.content, options: [question.optionA, question.optionB, question.optionC, question.optionD],
      correctAnswer: question.correctAnswer, type: question.type, knowledge: question.knowledge, topic: question.topic, difficulty: question.difficulty }));
    return { asked, report, questions };
  }
  async analysis(teacherId: string, id: string): Promise<SessionAnalysis> {
    const session = await this.load(teacherId, id);
    const { asked, report } = this.compute(session);
    const names = new Map(session.classroom?.students.map(student => [student.code, student.name]) ?? []);
    const byId = new Map(report.studentScores.map(student => [student.id, student]));
    return {
      sessionId: session.id, title: session.title, status: session.status, report,
      questions: asked.map(q => ({ id: q.id, content: q.content, optionA: q.optionA, optionB: q.optionB, optionC: q.optionC, optionD: q.optionD, type: q.type, durationSeconds: q.durationSeconds, order: q.order,
        correctAnswer: q.correctAnswer as AnswerKey, explanation: q.explanation, knowledge: q.knowledge, topic: q.topic, difficulty: q.difficulty })),
      students: session.participants.map(p => ({ participantId: p.id, studentCode: p.studentCode, studentName: names.get(p.studentCode) ?? null, correct: byId.get(p.id)?.correct ?? 0, score: byId.get(p.id)?.score ?? 0 })),
      latestInsight: await this.jobs.latest<AiResultInsight>(teacherId, 'ANALYZE_SESSION', { sessionId: id }),
    };
  }
  async startSessionInsight(teacherId: string, id: string) {
    const session = await this.load(teacherId, id);
    if (!session.participants.length || !session.questions.some(question => question.closedAt)) throw new BadRequestException('Phiên học chưa có câu hỏi đã đóng hoặc chưa có sinh viên trả lời.');
    return this.jobs.enqueue<AiResultInsight>(teacherId, 'ANALYZE_SESSION', { sessionId: id, quizId: session.quizId }, { sessionId: id });
  }
  private async runSessionInsight(job: AiJobRecord) {
    const session = await this.load(job.teacherId, job.sessionId!).catch(() => { throw new AiTaskError('Phiên học không còn tồn tại.'); });
    const { questions, report } = this.compute(session);
    return this.insight(describeResults(session.title, questions, report));
  }
  async insight(description: string) {
    const { data, usage } = await this.ai.structured({ system: INSIGHT_SYSTEM, content: [{ type: 'text', text: description }, { type: 'text', text: 'Phân tích kết quả trên và đưa ra nhận xét cho giáo viên.' }], schema: InsightSchema, effort: 'medium', maxTokens: 32000 });
    return { result: data as unknown as Prisma.InputJsonValue, usage };
  }
}
@ApiTags('Analytics') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('sessions')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}
  @Get(':id/analysis') analysis(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.analytics.analysis(req.teacherId, id); }
  @Post(':id/ai-analysis') insight(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.analytics.startSessionInsight(req.teacherId, id); }
}
