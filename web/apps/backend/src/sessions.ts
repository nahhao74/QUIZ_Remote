import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Param, ParseUUIDPipe, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Difficulty, Prisma, QuestionType, QuizSession, SessionQuestion } from '@prisma/client';
import { randomInt } from 'node:crypto';
import type { Response } from 'express';
import { buildVariant, calculateStats, createRng, IDENTITY_ORDER, keyToDisplay, reorderOptions, type AnswerKey, type PublicQuestion, type SessionSnapshot, type VariantItem } from '@classpulse/shared-types';
import { AuthGuard, AuthRequest } from './auth';
import { CreateSessionDto, OpenQuestionDto, SettingsDto } from './dto';
import { PrismaService } from './prisma.service';
import { SessionEvents } from './events';

const includeSession = {
  questions: { orderBy: { order: 'asc' as const }, include: { answers: true } },
  participants: { orderBy: { joinedAt: 'asc' as const }, include: { answers: true } },
  classroom: { select: { name: true, students: { select: { code: true, name: true } } } },
};
export function publicQuestion(q: SessionQuestion, reveal: boolean): PublicQuestion {
  return { id: q.id, content: q.content, optionA: q.optionA, optionB: q.optionB, optionC: q.optionC, optionD: q.optionD, type: q.type,
    durationSeconds: q.durationSeconds, order: q.order, ...(reveal ? { correctAnswer: q.correctAnswer as AnswerKey, explanation: q.explanation } : {}) };
}
export async function lockSession(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM "QuizSession" WHERE id = ${id}::uuid FOR UPDATE`;
}
/** Question content a session copies, from the quiz bank or an exam snapshot. */
export interface SourceQuestion {
  id: string; content: string; optionA: string; optionB: string; optionC: string; optionD: string; type: QuestionType; correctAnswer: string;
  explanation: string; knowledge: string; topic: string; difficulty: Difficulty | null; durationSeconds: number;
}
/** Rewrites "đáp án B"-style references when options are shuffled so revealed explanations stay correct. */
export function remapLetterReferences(text: string, order: string) {
  if (order === IDENTITY_ORDER) return text;
  return text.replace(/((?:đáp án|phương án|lựa chọn|chọn|option)(?:\s+(?:đúng|đúng là|là))?\s+)([A-D])(?![\p{L}\d])/giu, (_, prefix: string, letter: string) => prefix + keyToDisplay(letter.toUpperCase(), order));
}
export function sessionQuestionsFrom(questions: SourceQuestion[], layout: VariantItem[]) {
  return layout.map(({ index, order }, position) => {
    const q = questions[index];
    return { sourceQuestionId: q.id, content: q.content, ...reorderOptions(q, order), type: q.type, correctAnswer: keyToDisplay(q.correctAnswer, order),
      explanation: remapLetterReferences(q.explanation, order), knowledge: q.knowledge, topic: q.topic, difficulty: q.difficulty, optionOrder: order, durationSeconds: q.durationSeconds, order: position };
  });
}
type CsvSession = {
  roomCode: string; title: string;
  questions: Array<{ id: string; content: string; correctAnswer: string }>;
  participants: Array<{ studentCode: string; studentName?: string | null; deviceId: string; joinedAt: Date; answers: Array<{ questionId: string; answer: string }> }>;
};
function csvCell(value: unknown) {
  let text = value === null || value === undefined ? '' : String(value);
  // Excel and other spreadsheet apps may evaluate cells beginning with these characters.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function buildSessionCsv(session: CsvSession) {
  const header: unknown[] = ['Mã phòng', 'Tên bộ câu hỏi', 'Mã sinh viên', 'Họ tên', 'Device ID', 'Tham gia lúc'];
  session.questions.forEach((question, index) => header.push(`Câu ${index + 1}: ${question.content}`, `Đáp án đúng câu ${index + 1}`, `Kết quả câu ${index + 1}`));
  header.push('Số câu đã trả lời', 'Số câu đúng', 'Tổng số câu', 'Tỷ lệ đúng (%)', 'Điểm (thang 10)');
  const rows = session.participants.map(participant => {
    const byQuestion = new Map(participant.answers.map(answer => [answer.questionId, answer.answer]));
    let answered = 0;
    let correct = 0;
    const row: unknown[] = [session.roomCode, session.title, participant.studentCode, participant.studentName ?? '', participant.deviceId, participant.joinedAt.toISOString()];
    session.questions.forEach(question => {
      const answer = byQuestion.get(question.id);
      if (answer) { answered++; if (answer === question.correctAnswer) correct++; }
      row.push(answer ?? '', question.correctAnswer, answer ? (answer === question.correctAnswer ? 'Đúng' : 'Sai') : 'Chưa trả lời');
    });
    const total = session.questions.length;
    row.push(answered, correct, total, total ? Math.round(correct / total * 10000) / 100 : 0, total ? Math.round(correct * 1000 / total) / 100 : 0);
    return row;
  });
  return `\uFEFF${[header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
export interface LaunchInput {
  quizId: string; title: string; mode?: 'MANUAL'|'TIMER'; durationSeconds?: number;
  classroomId?: string | null; examId?: string | null; variantCode?: string | null;
  questions: ReturnType<typeof sessionQuestionsFrom>;
}
@Injectable()
export class SessionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionService.name);
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  constructor(private readonly db: PrismaService, private readonly events: SessionEvents) {}
  onModuleInit() {
    if (process.env.DISABLE_TIMERS === 'true') return;
    this.timer = setInterval(() => { void this.tick().catch(() => this.logger.error(JSON.stringify({ event: 'timer_tick_failed' }))); }, 250);
    this.timer.unref();
    void this.tick().catch(() => this.logger.error(JSON.stringify({ event: 'timer_recovery_failed' })));
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  async owned(teacherId: string, id: string) {
    const session = await this.db.quizSession.findFirst({ where: { id, teacherId } });
    if (!session) throw new NotFoundException('Không tìm thấy phiên học.');
    return session;
  }
  async list(teacherId: string) {
    const sessions = await this.db.quizSession.findMany({ where: { teacherId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    return Promise.all(sessions.map(s => this.snapshot(s.id)));
  }
  async get(teacherId: string, id: string) { await this.owned(teacherId, id); return this.snapshot(id); }
  async exportCsv(teacherId: string, id: string) {
    const session = await this.db.quizSession.findFirst({ where: { id, teacherId }, select: {
      roomCode: true, title: true, classroom: { select: { students: { select: { code: true, name: true } } } },
      questions: { orderBy: { order: 'asc' }, select: { id: true, content: true, correctAnswer: true } },
      participants: { orderBy: [{ studentCode: 'asc' }, { joinedAt: 'asc' }], select: { studentCode: true, deviceId: true, joinedAt: true, answers: { select: { questionId: true, answer: true } } } },
    } });
    if (!session) throw new NotFoundException('Không tìm thấy phiên học.');
    const names = new Map(session.classroom?.students.map(student => [student.code, student.name]) ?? []);
    const participants = session.participants.map(participant => ({ ...participant, studentName: names.get(participant.studentCode) ?? null }));
    return { filename: `classpulse-${session.roomCode}-ket-qua.csv`, content: buildSessionCsv({ ...session, participants }) };
  }
  async snapshot(id: string): Promise<SessionSnapshot> {
    const session = await this.db.$transaction(tx => tx.quizSession.findUnique({ where: { id }, include: includeSession }), { isolationLevel: 'RepeatableRead' });
    if (!session) throw new NotFoundException('Không tìm thấy phiên học.');
    const current = session.questions[session.currentQuestionIndex];
    const reveal = session.status === 'QUESTION_CLOSED' || session.status === 'FINISHED';
    const total = session.participants.length;
    const stats = calculateStats(current?.answers.map(a => a.answer) ?? [], total, reveal ? current?.correctAnswer : undefined);
    const names = new Map(session.classroom?.students.map(student => [student.code, student.name]) ?? []);
    return {
      id: session.id, quizId: session.quizId, title: session.title, roomCode: session.roomCode, status: session.status, mode: session.mode,
      currentQuestionIndex: session.currentQuestionIndex, totalQuestions: session.questions.length,
      currentQuestion: current ? publicQuestion(current, reveal) : null,
      questionStartedAt: session.questionStartedAt?.toISOString() ?? null, questionEndsAt: session.questionEndsAt?.toISOString() ?? null,
      nextQuestionAt: session.nextQuestionAt?.toISOString() ?? null, serverTime: new Date().toISOString(), createdAt: session.createdAt.toISOString(), finishedAt: session.finishedAt?.toISOString() ?? null,
      participantCount: total, answerCount: stats.answered, stats,
      participants: session.participants.map(p => {
        const a = p.answers.find(answer => answer.questionId === current?.id);
        return { id: p.id, deviceId: p.deviceId, studentCode: p.studentCode, studentName: names.get(p.studentCode) ?? null, joinedAt: p.joinedAt.toISOString(), answered: !!a,
          ...(reveal && a ? { answer: a.answer as AnswerKey, isCorrect: a.answer === current?.correctAnswer } : {}) };
      }),
      results: session.questions.filter(q => q.closedAt !== null).map(q => ({ question: publicQuestion(q, true), stats: calculateStats(q.answers.map(a => a.answer), total, q.correctAnswer) })),
      classroomId: session.classroomId ?? null, classroomName: session.classroom?.name ?? null, examId: session.examId ?? null, variantCode: session.variantCode ?? null,
    };
  }
  async deviceResults(id: string) {
    const session = await this.db.quizSession.findUnique({ where: { id }, select: {
      roomCode: true, status: true,
      questions: { orderBy: { order: 'asc' }, select: { id: true, correctAnswer: true } },
      participants: { select: { deviceId: true, answers: { select: { questionId: true, answer: true } } } },
    } });
    if (!session || session.status !== 'FINISHED') return [];
    const correctByQuestion = new Map(session.questions.map(question => [question.id, question.correctAnswer]));
    const total = session.questions.length;
    return session.participants.map(participant => {
      const correct = participant.answers.reduce((count, answer) => count + (correctByQuestion.get(answer.questionId) === answer.answer ? 1 : 0), 0);
      return { deviceId: participant.deviceId, roomCode: session.roomCode, correct, total, score: total ? Math.round(correct * 10 / total) : 0 };
    });
  }
  async ownedClassroom(teacherId: string, classroomId: string) {
    const classroom = await this.db.classroom.findFirst({ where: { id: classroomId, teacherId, deletedAt: null }, select: { id: true } });
    if (!classroom) throw new NotFoundException('Không tìm thấy lớp học.');
    return classroom;
  }
  async create(teacherId: string, input: CreateSessionDto) {
    const quiz = await this.db.quiz.findFirst({ where: { id: input.quizId, teacherId, deletedAt: null }, include: { questions: { where: { deletedAt: null }, orderBy: { order: 'asc' } } } });
    if (!quiz) throw new NotFoundException('Không tìm thấy bộ câu hỏi.');
    if (!quiz.questions.length) throw new BadRequestException('Thêm ít nhất một câu hỏi trước khi tạo phiên.');
    if (input.classroomId) await this.ownedClassroom(teacherId, input.classroomId);
    const shuffle = { shuffleQuestions: !!input.shuffleQuestions, shuffleOptions: !!input.shuffleOptions };
    const layout = buildVariant(quiz.questions, createRng(randomInt(2 ** 31)), shuffle);
    return this.launch(teacherId, { quizId: quiz.id, title: quiz.title, mode: input.mode, durationSeconds: input.durationSeconds, classroomId: input.classroomId, questions: sessionQuestionsFrom(quiz.questions, layout) });
  }
  /** Creates a session from prepared question copies and allocates a room code unique among active sessions. */
  async launch(teacherId: string, input: LaunchInput) {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const result = await this.db.quizSession.create({ data: { teacherId, quizId: input.quizId, title: input.title.slice(0, 200), roomCode: String(randomInt(100000, 1000000)),
          mode: input.mode ?? 'MANUAL', durationSeconds: input.durationSeconds, classroomId: input.classroomId ?? null, examId: input.examId ?? null, variantCode: input.variantCode ?? null,
          questions: { create: input.questions } } });
        await this.events.publish(result.id);
        return this.snapshot(result.id);
      } catch (error) { if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error; }
    }
    throw new ConflictException('Không thể cấp mã phòng. Vui lòng thử lại.');
  }
  private async open(tx: Prisma.TransactionClient, s: QuizSession, index: number, now: Date) {
    const q = await tx.sessionQuestion.findUnique({ where: { sessionId_order: { sessionId: s.id, order: index } } });
    if (!q) throw new BadRequestException('Không tìm thấy câu hỏi.');
    if (q.openedAt) throw new ConflictException('Câu hỏi đã mở không thể mở lại; hãy tạo phiên mới.');
    if (s.status === 'QUESTION_ACTIVE') await tx.sessionQuestion.update({ where: { sessionId_order: { sessionId: s.id, order: s.currentQuestionIndex } }, data: { closedAt: now } });
    await tx.sessionQuestion.update({ where: { id: q.id }, data: { openedAt: now } });
    await tx.quizSession.update({ where: { id: s.id }, data: { currentQuestionIndex: index, status: 'QUESTION_ACTIVE', questionStartedAt: now,
      questionEndsAt: new Date(now.getTime() + (s.durationSeconds ?? q.durationSeconds) * 1000), nextQuestionAt: null } });
  }
  private async finish(tx: Prisma.TransactionClient, s: QuizSession, now: Date) {
    if (s.status === 'QUESTION_ACTIVE') await tx.sessionQuestion.update({ where: { sessionId_order: { sessionId: s.id, order: s.currentQuestionIndex } }, data: { closedAt: now } });
    await tx.quizSession.update({ where: { id: s.id }, data: { status: 'FINISHED', finishedAt: now, nextQuestionAt: null } });
  }
  private async close(tx: Prisma.TransactionClient, s: QuizSession, now: Date) {
    await tx.sessionQuestion.update({ where: { sessionId_order: { sessionId: s.id, order: s.currentQuestionIndex } }, data: { closedAt: now } });
    await tx.quizSession.update({ where: { id: s.id }, data: { status: 'QUESTION_CLOSED', nextQuestionAt: s.mode === 'TIMER' ? new Date(now.getTime() + 3000) : null } });
  }
  async control(teacherId: string, id: string, action: 'start'|'close'|'next'|'finish'|'open', input: OpenQuestionDto = {}) {
    await this.db.$transaction(async tx => {
      await lockSession(tx, id);
      const s = await tx.quizSession.findFirst({ where: { id, teacherId }, include: { questions: { orderBy: { order: 'asc' } } } });
      if (!s) throw new NotFoundException('Không tìm thấy phiên học.');
      if (s.status === 'FINISHED') { if (action === 'finish') return; throw new ConflictException('Phiên đã kết thúc.'); }
      const now = new Date();
      if (action === 'finish') return this.finish(tx, s, now);
      if (action === 'close') {
        if (s.status === 'QUESTION_CLOSED') return;
        if (s.status !== 'QUESTION_ACTIVE') throw new ConflictException('Chưa có câu hỏi đang mở.');
        return this.close(tx, s, now);
      }
      if (action === 'start' && s.status !== 'LOBBY') throw new ConflictException('Phiên đã bắt đầu.');
      if (action === 'next' && s.status === 'LOBBY') throw new ConflictException('Bắt đầu phiên trước.');
      const index = action === 'start' ? 0 : action === 'open' ? (input.questionId ? s.questions.findIndex(q => q.id === input.questionId) : input.index ?? s.currentQuestionIndex + 1) : s.currentQuestionIndex + 1;
      if (index >= s.questions.length && action === 'next') return this.finish(tx, s, now);
      if (index < 0 || index >= s.questions.length) throw new BadRequestException('Câu hỏi không thuộc phiên này.');
      return this.open(tx, s, index, now);
    });
    await this.events.publish(id);
    return this.snapshot(id);
  }
  async settings(teacherId: string, id: string, input: SettingsDto) {
    await this.db.$transaction(async tx => {
      await lockSession(tx, id);
      const s = await tx.quizSession.findFirst({ where: { id, teacherId } });
      if (!s) throw new NotFoundException('Không tìm thấy phiên học.');
      if (s.status === 'FINISHED') throw new ConflictException('Phiên đã kết thúc.');
      await tx.quizSession.update({ where: { id }, data: { ...input,
        ...(s.status === 'QUESTION_CLOSED' && input.mode ? { nextQuestionAt: input.mode === 'TIMER' ? new Date(Date.now() + 3000) : null } : {}) } });
    });
    await this.events.publish(id);
    return this.snapshot(id);
  }
  /** All deadlines live in PostgreSQL. Polling resumes expired sessions after a restart. */
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due = await this.db.quizSession.findMany({ where: { OR: [ { status: 'QUESTION_ACTIVE', questionEndsAt: { lte: new Date() } }, { status: 'QUESTION_CLOSED', mode: 'TIMER', nextQuestionAt: { lte: new Date() } } ] }, select: { id: true } });
      for (const { id } of due) {
        const changed = await this.db.$transaction(async tx => {
          await lockSession(tx, id);
          const s = await tx.quizSession.findUniqueOrThrow({ where: { id }, include: { _count: { select: { questions: true } } } });
          const now = new Date();
          if (s.status === 'QUESTION_ACTIVE' && s.questionEndsAt && s.questionEndsAt <= now) { await this.close(tx, s, now); return true; }
          if (s.status === 'QUESTION_CLOSED' && s.mode === 'TIMER' && s.nextQuestionAt && s.nextQuestionAt <= now) {
            if (s.currentQuestionIndex + 1 >= s._count.questions) await this.finish(tx, s, now);
            else await this.open(tx, s, s.currentQuestionIndex + 1, now);
            return true;
          }
          return false;
        });
        if (changed) await this.events.publish(id);
      }
    } finally { this.ticking = false; }
  }
}
@ApiTags('Sessions') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('sessions')
export class SessionController {
  constructor(private readonly sessions: SessionService) {}
  @Get() list(@Req() req: AuthRequest) { return this.sessions.list(req.teacherId); }
  @Post() create(@Req() req: AuthRequest, @Body() input: CreateSessionDto) { return this.sessions.create(req.teacherId, input); }
  @Get(':id/export.csv') async exportCsv(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.sessions.exportCsv(req.teacherId, id);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    response.setHeader('Cache-Control', 'private, no-store');
    return result.content;
  }
  @Get(':id') get(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.sessions.get(req.teacherId, id); }
  @Get(':id/participants') async participants(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return (await this.sessions.get(req.teacherId, id)).participants; }
  @Get(':id/stats') async stats(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return (await this.sessions.get(req.teacherId, id)).stats; }
  @Get(':id/report') report(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.sessions.get(req.teacherId, id); }
  @Post(':id/start') start(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.sessions.control(req.teacherId, id, 'start'); }
  @Post(':id/close') close(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.sessions.control(req.teacherId, id, 'close'); }
  @Post(':id/next') next(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.sessions.control(req.teacherId, id, 'next'); }
  @Post(':id/finish') finish(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.sessions.control(req.teacherId, id, 'finish'); }
  @Post(':id/open') open(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() input: OpenQuestionDto) { return this.sessions.control(req.teacherId, id, 'open', input); }
  @Patch(':id/settings') settings(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() input: SettingsDto) { return this.sessions.settings(req.teacherId, id, input); }
}
