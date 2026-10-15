import { BadRequestException, Body, Controller, Delete, Get, Injectable, NotFoundException, OnModuleInit, Param, ParseUUIDPipe, Post, Query, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AiJob as AiJobRecord, Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import { AlignmentType, Document, Packer, PageBreak, Paragraph, TabStopType, TextRun } from 'docx';
import {
  analyzeItems, ANSWERS, buildVariant, createRng, foldText, formatAnswerKey, GRADE_BANDS, keyToDisplay, keyToSource, reorderOptions, seedFrom, summarizeScores, variantCodes,
  type AiResultInsight, type Exam, type ExamReport, type ExamVariantDetail, type ExamVariantQuestion, type VariantItem,
} from '@classpulse/shared-types';
import { AuthGuard, AuthRequest } from './auth';
import { AiJobsService, AiTaskError } from './ai';
import { AnalyticsService, describeResults, describeSummary, sessionScores, type InsightQuestion } from './analytics';
import { ExamDto, ExamSessionDto } from './dto';
import { PrismaService } from './prisma.service';
import { remapLetterReferences, SessionService, sessionQuestionsFrom } from './sessions';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const slug = (text: string) => foldText(text).replace(/ /g, '-').slice(0, 60) || 'ky-thi';
const NO_CLASS = 'none';

@Injectable()
export class ExamService implements OnModuleInit {
  constructor(private readonly db: PrismaService, private readonly sessions: SessionService, private readonly analytics: AnalyticsService, private readonly jobs: AiJobsService) {}
  onModuleInit() { this.jobs.register('ANALYZE_EXAM', job => this.runInsight(job)); }
  private async owned(teacherId: string, id: string) {
    const exam = await this.db.exam.findFirst({ where: { id, teacherId, deletedAt: null }, include: { quiz: { select: { title: true } }, questions: { orderBy: { order: 'asc' } }, variants: { orderBy: { code: 'asc' } } } });
    if (!exam) throw new NotFoundException('Không tìm thấy kỳ thi.');
    return exam;
  }
  private sessionsOf(teacherId: string, examId: string) {
    return this.db.quizSession.findMany({ where: { teacherId, examId }, orderBy: { createdAt: 'asc' }, include: {
      classroom: { select: { name: true, students: { select: { code: true, name: true } } } },
      questions: { select: { id: true, sourceQuestionId: true, correctAnswer: true, optionOrder: true } },
      participants: { orderBy: { studentCode: 'asc' }, select: { id: true, studentCode: true, answers: { select: { questionId: true, answer: true } } } },
    } });
  }
  private view(exam: Awaited<ReturnType<ExamService['owned']>>, sessions: Awaited<ReturnType<ExamService['sessionsOf']>>): Exam {
    return {
      id: exam.id, title: exam.title, description: exam.description, quizId: exam.quizId, quizTitle: exam.quiz.title, shuffleQuestions: exam.shuffleQuestions, shuffleOptions: exam.shuffleOptions,
      durationSeconds: exam.durationSeconds, questionCount: exam.questions.length, createdAt: exam.createdAt.toISOString(),
      variants: exam.variants.map(variant => ({ code: variant.code, questionCount: (variant.layout as unknown as VariantItem[]).length })),
      sessions: sessions.map(session => ({ id: session.id, title: session.title, createdAt: session.createdAt.toISOString(), status: session.status, questionCount: session.questions.length,
        participantCount: session.participants.length, examId: session.examId, variantCode: session.variantCode, classroomId: session.classroomId, classroomName: session.classroom?.name ?? null,
        summary: sessionScores(session).summary })),
    };
  }
  async list(teacherId: string) {
    const exams = await this.db.exam.findMany({ where: { teacherId, deletedAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    return Promise.all(exams.map(exam => this.get(teacherId, exam.id)));
  }
  async get(teacherId: string, id: string) { return this.view(await this.owned(teacherId, id), await this.sessionsOf(teacherId, id)); }
  /** Freezes the quiz questions and builds reproducible variants (mã đề 101, 102, …) seeded from the exam id. */
  async create(teacherId: string, input: ExamDto) {
    const quiz = await this.db.quiz.findFirst({ where: { id: input.quizId, teacherId, deletedAt: null }, include: { questions: { where: { deletedAt: null }, orderBy: { order: 'asc' } } } });
    if (!quiz) throw new NotFoundException('Không tìm thấy bộ câu hỏi.');
    if (!quiz.questions.length) throw new BadRequestException('Bộ câu hỏi chưa có câu nào.');
    const exam = await this.db.$transaction(async tx => {
      const created = await tx.exam.create({ data: { teacherId, quizId: quiz.id, title: input.title, description: input.description ?? '', shuffleQuestions: input.shuffleQuestions, shuffleOptions: input.shuffleOptions,
        durationSeconds: input.durationSeconds ?? null, questions: { create: quiz.questions.map((q, order) => ({ sourceQuestionId: q.id, content: q.content, optionA: q.optionA, optionB: q.optionB, optionC: q.optionC,
          optionD: q.optionD, type: q.type, correctAnswer: q.correctAnswer, explanation: q.explanation, knowledge: q.knowledge, topic: q.topic, difficulty: q.difficulty, durationSeconds: q.durationSeconds, order })) } } });
      await tx.examVariant.createMany({ data: variantCodes(input.variantCount).map(code => ({ examId: created.id, code,
        layout: buildVariant(quiz.questions, createRng(seedFrom(`${created.id}:${code}`)), { shuffleQuestions: input.shuffleQuestions, shuffleOptions: input.shuffleOptions }) as unknown as Prisma.InputJsonValue })) });
      return created;
    });
    return this.get(teacherId, exam.id);
  }
  async remove(teacherId: string, id: string) {
    await this.owned(teacherId, id);
    await this.db.exam.update({ where: { id }, data: { deletedAt: new Date() } });
    return { success: true };
  }
  private variantOf(exam: Awaited<ReturnType<ExamService['owned']>>, code: string): ExamVariantDetail {
    const variant = exam.variants.find(item => item.code === code);
    if (!variant) throw new NotFoundException(`Kỳ thi không có mã đề ${code}.`);
    const questions = (variant.layout as unknown as VariantItem[]).map(({ index, order }, position): ExamVariantQuestion => {
      const q = exam.questions[index];
      return { number: position + 1, sourceNumber: index + 1, content: q.content, ...reorderOptions(q, order), type: q.type, correctAnswer: keyToDisplay(q.correctAnswer, order) as ExamVariantQuestion['correctAnswer'], explanation: remapLetterReferences(q.explanation, order) };
    });
    return { code, questions };
  }
  async variant(teacherId: string, id: string, code: string) { return this.variantOf(await this.owned(teacherId, id), code); }
  /** Printable exam papers (one variant or all, each starting on a new page). */
  async papers(teacherId: string, id: string, code?: string) {
    const exam = await this.owned(teacherId, id);
    const codes = code ? [code] : exam.variants.map(variant => variant.code);
    const children: Paragraph[] = [];
    codes.forEach((variantCode, i) => {
      const variant = this.variantOf(exam, variantCode);
      if (i) children.push(new Paragraph({ children: [new PageBreak()] }));
      children.push(
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: exam.title.toUpperCase(), bold: true, size: 28 })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120 }, children: [new TextRun({ text: `Mã đề ${variant.code} · ${variant.questions.length} câu trắc nghiệm`, bold: true })] }),
        new Paragraph({ tabStops: [{ type: TabStopType.LEFT, position: 6200 }], spacing: { after: 240 }, children: [new TextRun('Họ và tên: ..................................................'), new TextRun('\tMã trên thiết bị: ........')] }),
      );
      for (const question of variant.questions) {
        question.content.split('\n').forEach((line, k) => children.push(new Paragraph({ spacing: { before: k ? 0 : 160 }, children: k ? [new TextRun(line)] : [new TextRun({ text: `Câu ${question.number}. `, bold: true }), new TextRun(line)] })));
        if (question.type === 'MULTIPLE' && !/chọn (tất cả|các|nhiều)/i.test(question.content)) children.push(new Paragraph({ children: [new TextRun({ text: '(Chọn tất cả các đáp án đúng)', italics: true })] }));
        for (const letter of ANSWERS) children.push(new Paragraph({ indent: { left: 360 }, children: [new TextRun({ text: `${letter}. `, bold: true }), new TextRun(question[`option${letter}`])] }));
      }
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 240 }, children: [new TextRun({ text: '— HẾT —', bold: true })] }));
    });
    const document = new Document({ creator: 'ClassPulse', title: exam.title, styles: { default: { document: { run: { font: 'Times New Roman', size: 24 } } } }, sections: [{ children }] });
    return { filename: `de-thi-${slug(exam.title)}${code ? `-ma-${code}` : ''}.docx`, buffer: await Packer.toBuffer(document) };
  }
  async answerKey(teacherId: string, id: string) {
    const exam = await this.owned(teacherId, id);
    const variants = exam.variants.map(variant => this.variantOf(exam, variant.code));
    const workbook = new ExcelJS.Workbook();
    const keys = workbook.addWorksheet('Đáp án', { views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }] });
    keys.addRow(['Câu', ...variants.map(variant => `Mã ${variant.code}`)]);
    for (let i = 0; i < exam.questions.length; i++) keys.addRow([i + 1, ...variants.map(variant => formatAnswerKey(variant.questions[i].correctAnswer))]);
    keys.getRow(1).font = { bold: true };
    keys.columns.forEach(column => { column.width = 10; column.alignment = { horizontal: 'center' }; });
    const mapping = workbook.addWorksheet('Đối chiếu câu gốc');
    mapping.addRow(['Câu trong đề gốc', 'Nội dung', ...variants.map(variant => `Vị trí ở mã ${variant.code}`)]);
    exam.questions.forEach((question, index) => mapping.addRow([index + 1, question.content.slice(0, 200), ...variants.map(variant => variant.questions.find(q => q.sourceNumber === index + 1)?.number ?? '')]));
    mapping.getRow(1).font = { bold: true };
    mapping.getColumn(2).width = 60;
    return { filename: `dap-an-${slug(exam.title)}.xlsx`, buffer: Buffer.from(await workbook.xlsx.writeBuffer()) };
  }
  /** Opens a live session for one class using a variant; without a choice, the least-used variant is assigned. */
  async openSession(teacherId: string, id: string, input: ExamSessionDto) {
    const exam = await this.owned(teacherId, id);
    const classroom = input.classroomId ? await this.db.classroom.findFirst({ where: { id: input.classroomId, teacherId, deletedAt: null }, select: { id: true, name: true } }) : null;
    if (input.classroomId && !classroom) throw new NotFoundException('Không tìm thấy lớp học.');
    let variant = input.variantCode ? exam.variants.find(item => item.code === input.variantCode) : undefined;
    if (input.variantCode && !variant) throw new NotFoundException(`Kỳ thi không có mã đề ${input.variantCode}.`);
    if (!variant) {
      const used = await this.db.quizSession.groupBy({ by: ['variantCode'], where: { examId: exam.id }, _count: { _all: true } });
      const count = (code: string) => used.find(item => item.variantCode === code)?._count._all ?? 0;
      variant = [...exam.variants].sort((a, b) => count(a.code) - count(b.code) || a.code.localeCompare(b.code))[0];
    }
    const source = exam.questions.map(question => ({ ...question, id: question.sourceQuestionId }));
    return this.sessions.launch(teacherId, { quizId: exam.quizId, title: `${exam.title} · ${classroom?.name ?? 'Chưa gán lớp'} · Mã đề ${variant.code}`, mode: input.mode,
      durationSeconds: input.durationSeconds ?? exam.durationSeconds ?? undefined, classroomId: classroom?.id ?? null, examId: exam.id, variantCode: variant.code,
      questions: sessionQuestionsFrom(source, variant.layout as unknown as VariantItem[]) });
  }
  /** Finished sessions grouped by class, with per-question correct rates mapped back to the original order. */
  private async compute(teacherId: string, id: string) {
    const exam = await this.owned(teacherId, id);
    const sessions = (await this.sessionsOf(teacherId, id)).filter(session => session.status === 'FINISHED');
    const indexBySource = new Map(exam.questions.map((question, index) => [question.sourceQuestionId, index]));
    const groups = new Map<string, { classroomId: string | null; classroomName: string; sessionIds: string[]; scores: number[] }>();
    const questionStats = exam.questions.map(() => ({ correct: 0, total: 0, byClass: new Map<string, { correct: number; total: number }>() }));
    const responses: Array<{ id: string; answers: Record<string, string> }> = [];
    for (const session of sessions) {
      const key = session.classroomId ?? NO_CLASS;
      const group = groups.get(key) ?? { classroomId: session.classroomId, classroomName: session.classroom?.name ?? 'Chưa gán lớp', sessionIds: [], scores: [] };
      group.sessionIds.push(session.id);
      group.scores.push(...sessionScores(session).students.map(student => student.score));
      groups.set(key, group);
      const bySessionQuestion = new Map(session.questions.map(question => [question.id, question]));
      for (const question of session.questions) {
        const index = indexBySource.get(question.sourceQuestionId);
        if (index === undefined) continue;
        const stat = questionStats[index];
        const perClass = stat.byClass.get(key) ?? { correct: 0, total: 0 };
        for (const participant of session.participants) {
          const correct = participant.answers.some(answer => answer.questionId === question.id && answer.answer === question.correctAnswer) ? 1 : 0;
          stat.correct += correct; stat.total++; perClass.correct += correct; perClass.total++;
        }
        stat.byClass.set(key, perClass);
      }
      for (const participant of session.participants) responses.push({ id: participant.id, answers: Object.fromEntries(participant.answers.flatMap(answer => {
        const question = bySessionQuestion.get(answer.questionId);
        const index = question ? indexBySource.get(question.sourceQuestionId) : undefined;
        return question && index !== undefined ? [[exam.questions[index].id, keyToSource(answer.answer, question.optionOrder)]] : [];
      })) });
    }
    return { exam, sessions, groups: [...groups.values()], questionStats, responses };
  }
  async report(teacherId: string, id: string): Promise<ExamReport> {
    const { exam, groups, questionStats } = await this.compute(teacherId, id);
    const ratio = (correct: number, total: number) => total ? Math.round(correct * 1000 / total) / 1000 : 0;
    return {
      exam: await this.get(teacherId, id),
      overall: summarizeScores(groups.flatMap(group => group.scores)),
      classes: groups.map(group => ({ classroomId: group.classroomId, classroomName: group.classroomName, sessionIds: group.sessionIds, summary: summarizeScores(group.scores) })),
      questions: exam.questions.map((question, index) => ({ number: index + 1, content: question.content, knowledge: question.knowledge, topic: question.topic, difficulty: question.difficulty,
        correctRate: ratio(questionStats[index].correct, questionStats[index].total),
        byClass: Object.fromEntries([...questionStats[index].byClass].map(([key, value]) => [key, ratio(value.correct, value.total)])) })),
      latestInsight: await this.jobs.latest<AiResultInsight>(teacherId, 'ANALYZE_EXAM', { examId: id }),
    };
  }
  async reportWorkbook(teacherId: string, id: string) {
    const { exam, sessions, groups } = await this.compute(teacherId, id);
    const workbook = new ExcelJS.Workbook();
    const overview = workbook.addWorksheet('Tổng hợp theo lớp');
    overview.addRow(['Lớp', 'Số SV', 'Điểm TB', 'Trung vị', 'Độ lệch chuẩn', 'Thấp nhất', 'Cao nhất', 'Tỷ lệ đạt (%)', ...GRADE_BANDS.map(band => band.label)]);
    for (const group of groups) { const s = summarizeScores(group.scores); overview.addRow([group.classroomName, s.count, s.mean, s.median, s.standardDeviation, s.min, s.max, s.passRate, ...GRADE_BANDS.map(band => s.bands[band.band])]); }
    overview.getRow(1).font = { bold: true };
    overview.columns.forEach((column, i) => { column.width = i ? 14 : 28; });
    const usedNames = new Set<string>();
    for (const session of sessions) {
      let name = `${session.classroom?.name ?? 'Chưa gán lớp'} - ${session.variantCode ?? ''}`.replace(/[\\/*?:[\]]/g, ' ').slice(0, 28);
      for (let n = 2; usedNames.has(name); n++) name = `${name.slice(0, 25)} ${n}`;
      usedNames.add(name);
      const sheet = workbook.addWorksheet(name);
      const names = new Map(session.classroom?.students.map(student => [student.code, student.name]) ?? []);
      sheet.addRow(['Mã', 'Họ và tên', 'Mã đề', 'Số câu đúng', 'Tổng số câu', 'Điểm']);
      for (const student of sessionScores(session).students) sheet.addRow([student.studentCode, names.get(student.studentCode) ?? '', session.variantCode ?? '', student.correct, session.questions.length, student.score]);
      sheet.getRow(1).font = { bold: true };
      sheet.columns.forEach((column, i) => { column.width = i === 1 ? 28 : 12; });
    }
    return { filename: `bang-diem-${slug(exam.title)}.xlsx`, buffer: Buffer.from(await workbook.xlsx.writeBuffer()) };
  }
  async startInsight(teacherId: string, id: string) {
    const { responses } = await this.compute(teacherId, id);
    if (!responses.length) throw new BadRequestException('Kỳ thi chưa có phiên nào kết thúc với bài làm của sinh viên.');
    return this.jobs.enqueue<AiResultInsight>(teacherId, 'ANALYZE_EXAM', { examId: id }, { examId: id });
  }
  private async runInsight(job: AiJobRecord) {
    const { exam, groups, questionStats, responses } = await this.compute(job.teacherId, job.examId!).catch(() => { throw new AiTaskError('Kỳ thi không còn tồn tại.'); });
    const report = analyzeItems(exam.questions.map(question => ({ id: question.id, correctAnswer: question.correctAnswer })), responses);
    const questions: InsightQuestion[] = exam.questions.map((question, index) => ({ number: index + 1, content: question.content, options: [question.optionA, question.optionB, question.optionC, question.optionD],
      correctAnswer: question.correctAnswer, type: question.type, knowledge: question.knowledge, topic: question.topic, difficulty: question.difficulty }));
    const classes = groups.map(group => `- Lớp ${group.classroomName}: ${describeSummary(summarizeScores(group.scores))}`).join('\n');
    const byClass = questionStats.map((stat, index) => `Câu ${index + 1}: ${groups.map(group => `${group.classroomName} ${Math.round((stat.byClass.get(group.classroomId ?? NO_CLASS)?.correct ?? 0) * 100 / Math.max(1, stat.byClass.get(group.classroomId ?? NO_CLASS)?.total ?? 0))}%`).join(', ')}`).join('\n');
    const extra = groups.length > 1 ? `Kết quả theo lớp:\n${classes}\nTỷ lệ đúng từng câu theo lớp:\n${byClass}` : '';
    return this.analytics.insight(describeResults(`${exam.title} (đáp án theo thứ tự đề gốc, đã quy đổi từ các mã đề)`, questions, report, extra));
  }
}

@ApiTags('Exams') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('exams')
export class ExamController {
  constructor(private readonly exams: ExamService) {}
  @Get() list(@Req() req: AuthRequest) { return this.exams.list(req.teacherId); }
  @Post() create(@Req() req: AuthRequest, @Body() input: ExamDto) { return this.exams.create(req.teacherId, input); }
  @Get(':id') get(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.exams.get(req.teacherId, id); }
  @Delete(':id') remove(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.exams.remove(req.teacherId, id); }
  @Get(':id/variants/:code') variant(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('code') code: string) { return this.exams.variant(req.teacherId, id, code); }
  @Get(':id/papers.docx') @ApiQuery({ name: 'code', required: false, description: 'Mã đề; bỏ trống để xuất tất cả' })
  async papers(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response, @Query('code') code?: string) {
    const file = await this.exams.papers(req.teacherId, id, code && /^\d{3}$/.test(code) ? code : undefined);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    return new StreamableFile(file.buffer, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }
  @Get(':id/answer-key.xlsx') async answerKey(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const file = await this.exams.answerKey(req.teacherId, id);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    return new StreamableFile(file.buffer, { type: XLSX });
  }
  @Post(':id/sessions') open(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() input: ExamSessionDto) { return this.exams.openSession(req.teacherId, id, input); }
  @Get(':id/report') report(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.exams.report(req.teacherId, id); }
  @Get(':id/report.xlsx') async workbook(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const file = await this.exams.reportWorkbook(req.teacherId, id);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    return new StreamableFile(file.buffer, { type: XLSX });
  }
  @Post(':id/ai-analysis') insight(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.exams.startInsight(req.teacherId, id); }
}
