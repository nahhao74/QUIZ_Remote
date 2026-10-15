import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { keyToSource } from '@classpulse/shared-types';
import { topics, type Ack } from '@classpulse/mqtt-contracts';
import { AuthService } from '../src/auth';
import { QuizService } from '../src/quizzes';
import { SessionService } from '../src/sessions';
import { MqttProcessor } from '../src/mqtt';
import { PrismaService } from '../src/prisma.service';
import { SessionEvents } from '../src/events';
import { AiJobsService, AiService } from '../src/ai';
import { GenerationService } from '../src/generation';
import { BankService } from '../src/bank';
import { QualityService } from '../src/quality';
import { AnalyticsService } from '../src/analytics';
import { ClassService } from '../src/classes';
import { ExamService } from '../src/exams';

// Genuine PostgreSQL tests for multi-answer questions, AI review queue, bank, quality, classes and exams.
const db = new PrismaService();
const events = new SessionEvents();
const sessions = new SessionService(db, events);
const quizzes = new QuizService(db);
const processor = new MqttProcessor(db, events);
const ai = new AiService();
const jobs = new AiJobsService(db, ai);
const generation = new GenerationService(db, ai, jobs);
const bank = new BankService(db);
const quality = new QualityService(db, ai, jobs);
const analytics = new AnalyticsService(db, ai, jobs);
const classes = new ClassService(db);
const exams = new ExamService(db, sessions, analytics, jobs);
const auth = new AuthService(db, new JwtService({ secret: 'integration-only-secret-at-least-32-characters' }));
const tag = randomUUID().slice(0, 8);
const deviceIds = new Set<string>(); const requestIds = new Set<string>();
let teacherId: string;
let serial = 0;
const options = { optionA: 'Hai', optionB: 'Ba', optionC: 'Bốn', optionD: 'Năm' };
async function send(action: 'join' | 'answer', body: Record<string, unknown>) {
  const deviceId = body.deviceId as string; const requestId = randomUUID();
  deviceIds.add(deviceId); requestIds.add(requestId);
  return (await processor.process(topics[action](deviceId), JSON.stringify({ requestId, clientTimestamp: new Date().toISOString(), ...body }))) as Ack;
}
async function joinDevice(roomCode: string, studentCode = String(++serial % 100).padStart(2, '0')) {
  const deviceId = `feat-${tag}-${randomUUID().slice(0, 6)}`;
  expect((await send('join', { deviceId, roomCode, studentCode })).code).toBe('JOIN_ACCEPTED');
  return deviceId;
}
beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests.');
  await db.$connect();
  teacherId = (await auth.register({ email: `features-${tag}@example.test`, name: 'Feature Teacher', password: 'TestOnly@12345' })).response.teacher.id;
}, 15000);
afterAll(async () => {
  const where = { session: { teacherId } };
  await db.answer.deleteMany({ where: { participant: where } });
  await db.sessionParticipant.deleteMany({ where });
  await db.sessionQuestion.deleteMany({ where });
  await db.quizSession.deleteMany({ where: { teacherId } });
  await db.generatedQuestion.deleteMany({ where: { teacherId } });
  await db.aiJob.deleteMany({ where: { teacherId } });
  await db.examVariant.deleteMany({ where: { exam: { teacherId } } });
  await db.examQuestion.deleteMany({ where: { exam: { teacherId } } });
  await db.exam.deleteMany({ where: { teacherId } });
  await db.student.deleteMany({ where: { classroom: { teacherId } } });
  await db.classroom.deleteMany({ where: { teacherId } });
  await db.sourceDocument.deleteMany({ where: { teacherId } });
  await db.question.deleteMany({ where: { quiz: { teacherId } } });
  await db.quiz.deleteMany({ where: { teacherId } });
  await db.refreshToken.deleteMany({ where: { teacherId } });
  await db.teacher.deleteMany({ where: { id: teacherId } });
  await db.processedMqttMessage.deleteMany({ where: { requestId: { in: [...requestIds] } } });
  await db.device.deleteMany({ where: { id: { in: [...deviceIds] } } });
  await db.$disconnect();
});

describe('multiple-answer questions end to end', () => {
  it('stores keys, rejects inconsistent ones, and scores devices all-or-nothing', async () => {
    await expect(quizzes.create(teacherId, { title: 'Bad', questions: [{ content: 'Q', ...options, correctAnswer: 'AB', durationSeconds: 30, order: 0 }] })).rejects.toThrow('một đáp án');
    const quiz = await quizzes.create(teacherId, { title: `Multi ${tag}`, questions: [
      { content: 'Số nguyên tố chẵn?', ...options, type: 'SINGLE', correctAnswer: 'A', durationSeconds: 30, order: 0, difficulty: 'EASY', explanation: 'Chỉ có 2.' },
      { content: 'Chọn tất cả số nguyên tố', ...options, type: 'MULTIPLE', correctAnswer: 'ABD', durationSeconds: 30, order: 1, knowledge: 'Số nguyên tố', topic: 'Chương 1' },
    ] });
    expect(quiz.questions.map(q => [q.type, q.correctAnswer, q.origin])).toEqual([['SINGLE', 'A', 'MANUAL'], ['MULTIPLE', 'ABD', 'MANUAL']]);
    const session = await sessions.create(teacherId, { quizId: quiz.id });
    const [good, partial] = [await joinDevice(session.roomCode), await joinDevice(session.roomCode)];
    const first = await sessions.control(teacherId, session.id, 'start');
    expect(first.currentQuestion).toMatchObject({ type: 'SINGLE' });
    expect(first.currentQuestion).not.toHaveProperty('explanation');
    expect((await send('answer', { deviceId: good, roomCode: session.roomCode, questionId: first.currentQuestion!.id, answer: 'AB', sequence: 1 })).code).toBe('INVALID_ANSWER');
    expect((await send('answer', { deviceId: good, roomCode: session.roomCode, questionId: first.currentQuestion!.id, answer: 'A', sequence: 2 })).code).toBe('ANSWER_ACCEPTED');
    expect((await sessions.control(teacherId, session.id, 'close')).currentQuestion).toMatchObject({ correctAnswer: 'A', explanation: 'Chỉ có 2.' });
    const second = await sessions.control(teacherId, session.id, 'next');
    expect(second.currentQuestion?.type).toBe('MULTIPLE');
    expect((await send('answer', { deviceId: good, roomCode: session.roomCode, questionId: second.currentQuestion!.id, answer: 'ABD', sequence: 1 })).code).toBe('ANSWER_ACCEPTED');
    expect((await send('answer', { deviceId: partial, roomCode: session.roomCode, questionId: second.currentQuestion!.id, answer: 'AB', sequence: 1 })).code).toBe('ANSWER_ACCEPTED');
    const closed = await sessions.control(teacherId, session.id, 'close');
    expect(closed.stats).toMatchObject({ answered: 2, counts: { A: 2, B: 2, C: 0, D: 1 }, correct: 1, incorrect: 1 });
    await sessions.control(teacherId, session.id, 'finish');
    const results = await sessions.deviceResults(session.id);
    expect(results.find(r => r.deviceId === good)).toMatchObject({ correct: 2, score: 10 });
    expect(results.find(r => r.deviceId === partial)).toMatchObject({ correct: 0, score: 0 });
    const analysis = await analytics.analysis(teacherId, session.id);
    expect(analysis.report.items[1]).toMatchObject({ correct: 1, difficulty: 0.5 });
    expect(analysis.students.map(s => s.score).sort()).toEqual([0, 10]);
    expect((await sessions.exportCsv(teacherId, session.id)).content).toContain('"ABD"');
  });
  it('shuffles options per session while keeping keys and explanations consistent', async () => {
    const quiz = await quizzes.create(teacherId, { title: `Shuffle ${tag}`, questions: Array.from({ length: 6 }, (_, i) => ({ content: `Câu ${i}`, ...options, type: 'MULTIPLE' as const, correctAnswer: ['AB', 'C', 'BD', 'A', 'ACD', 'D'][i], explanation: 'Đáp án A đúng.', durationSeconds: 30, order: i })) });
    const session = await sessions.create(teacherId, { quizId: quiz.id, shuffleQuestions: true, shuffleOptions: true });
    const copies = await db.sessionQuestion.findMany({ where: { sessionId: session.id } });
    const source = new Map(quiz.questions.map(q => [q.id, q]));
    for (const copy of copies) {
      const original = source.get(copy.sourceQuestionId)!;
      expect(keyToSource(copy.correctAnswer, copy.optionOrder)).toBe(original.correctAnswer);
      expect(copy[`option${copy.correctAnswer[0] as 'A'}`]).toBe(original[`option${keyToSource(copy.correctAnswer[0], copy.optionOrder) as 'A'}`]);
      if (copy.optionOrder !== 'ABCD') expect(copy.explanation).toBe(`Đáp án ${'ABCD'[copy.optionOrder.indexOf('A')]} đúng.`);
    }
    expect(new Set(copies.map(c => c.optionOrder)).size).toBeGreaterThan(1);
  });
});

describe('AI review queue without calling AI', () => {
  it('approves proposals into a new quiz and keeps rejected ones out', async () => {
    const job = await db.aiJob.create({ data: { teacherId, kind: 'GENERATE_QUESTIONS', status: 'SUCCEEDED', input: {}, model: 'test' } });
    const base = { jobId: job.id, teacherId, ...options, explanation: 'Vì…', knowledge: 'Đếm', topic: 'Chương 1', difficulty: 'MEDIUM' as const };
    await db.generatedQuestion.createMany({ data: [
      { ...base, content: 'Đề xuất 1?', correctAnswer: 'B', order: 0 },
      { ...base, content: 'Đề xuất 2?', correctAnswer: 'AC', type: 'MULTIPLE', order: 1 },
      { ...base, content: 'Đề xuất 3 thiếu đáp án?', correctAnswer: '', order: 2 },
    ] });
    const pending = await generation.generated(teacherId, {});
    expect(pending).toHaveLength(3);
    const [first, second, third] = [...pending].sort((a, b) => a.order - b.order);
    await expect(generation.approve(teacherId, { ids: [third.id], newQuizTitle: 'X' })).rejects.toThrow('Hãy sửa');
    await generation.update(teacherId, third.id, { correctAnswer: 'D' });
    const approved = await generation.approve(teacherId, { ids: [first.id, second.id, third.id], newQuizTitle: `AI ${tag}`, durationSeconds: 40 });
    const quiz = await quizzes.get(teacherId, approved.quizId);
    expect(quiz.questions.map(q => [q.content, q.correctAnswer, q.type, q.origin, q.durationSeconds])).toEqual([
      ['Đề xuất 1?', 'B', 'SINGLE', 'AI', 40], ['Đề xuất 2?', 'AC', 'MULTIPLE', 'AI', 40], ['Đề xuất 3 thiếu đáp án?', 'D', 'SINGLE', 'AI', 40]]);
    expect((await generation.pendingCount(teacherId)).pending).toBe(0);
    await expect(generation.reject(teacherId, [first.id])).rejects.toThrow();
  });
  it('runs registered background jobs and records failures with readable messages', async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
    try {
      jobs.register('ANALYZE_SESSION', async (_job, progress) => { await progress(50); return { result: { ok: true }, usage: { inputTokens: 3, outputTokens: 2 } }; });
      jobs.register('ANALYZE_EXAM', async () => { throw new Error('boom'); });
      const ok = await jobs.enqueue(teacherId, 'ANALYZE_SESSION', {}, {});
      const failed = await jobs.enqueue(teacherId, 'ANALYZE_EXAM', {}, {});
      for (let i = 0; i < 50 && ((await jobs.get(teacherId, ok.id)).status !== 'SUCCEEDED' || (await jobs.get(teacherId, failed.id)).status !== 'FAILED'); i++) await new Promise(resolve => setTimeout(resolve, 50));
      expect(await jobs.get(teacherId, ok.id)).toMatchObject({ status: 'SUCCEEDED', progress: 100, result: { ok: true }, inputTokens: 3 });
      expect(await jobs.get(teacherId, failed.id)).toMatchObject({ status: 'FAILED', error: 'Lỗi không xác định khi xử lý tác vụ AI.' });
    } finally { if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous; }
  });
});

describe('question bank and quality', () => {
  it('finds accent-insensitive matches, near duplicates and rule issues', async () => {
    const quiz = await quizzes.create(teacherId, { title: `Bank ${tag}`, questions: [
      { content: 'Giao thức MQTT hoạt động theo mô hình nào?', optionA: 'Publish/subscribe', optionB: 'Peer to peer', optionC: 'REST', optionD: 'REST', correctAnswer: 'A', durationSeconds: 30, order: 0 },
      { content: 'Giao thuc MQTT hoat dong theo mo hinh nao', optionA: 'REST', optionB: 'Publish/subscribe', optionC: 'Peer to peer', optionD: 'SOAP', correctAnswer: 'B', durationSeconds: 30, order: 1 },
    ] });
    const found = await bank.search(teacherId, { search: 'mo hinh mqtt', quizId: quiz.id });
    expect(found.total).toBe(2);
    const pairs = await bank.duplicates(teacherId, 0.8, quiz.id);
    expect(pairs[0]).toMatchObject({ a: { quizId: quiz.id }, b: { quizId: quiz.id } });
    const report = await quality.report(teacherId, quiz.id);
    expect(report.ruleIssues.map(issue => [issue.number, issue.category])).toEqual(expect.arrayContaining([[1, 'FORMAT'], [2, 'DUPLICATE']]));
    expect(report).toMatchObject({ questionCount: 2, keyDistribution: { A: 1, B: 1, C: 0, D: 0 }, results: null, latestReview: null });
  });
});

describe('classes and exams', () => {
  it('maps roster names, builds variants and reports scores by class', async () => {
    const classroom = await classes.create(teacherId, { name: `10A1 ${tag}` });
    await classes.saveStudents(teacherId, classroom.id, { students: [{ code: '01', name: 'Nguyễn An' }, { code: '02', name: 'Trần Bình' }] });
    const quiz = await quizzes.create(teacherId, { title: `Exam ${tag}`, questions: Array.from({ length: 4 }, (_, i) => ({ content: `Câu thi ${i + 1}`, ...options, correctAnswer: 'ABCD'[i], durationSeconds: 30, order: i })) });
    const exam = await exams.create(teacherId, { quizId: quiz.id, title: `Giữa kỳ ${tag}`, variantCount: 3, shuffleQuestions: true, shuffleOptions: true });
    expect(exam.variants.map(v => v.code)).toEqual(['101', '102', '103']);
    const variant = await exams.variant(teacherId, exam.id, '102');
    expect(variant.questions.map(q => q.sourceNumber).sort()).toEqual([1, 2, 3, 4]);
    const session = await exams.openSession(teacherId, exam.id, { classroomId: classroom.id });
    expect(session).toMatchObject({ classroomName: `10A1 ${tag}`, variantCode: '101', examId: exam.id });
    const second = await exams.openSession(teacherId, exam.id, {});
    expect(second.variantCode).toBe('102');
    const [an, binh] = [await joinDevice(session.roomCode, '01'), await joinDevice(session.roomCode, '02')];
    let current = await sessions.control(teacherId, session.id, 'start');
    for (let i = 0; i < 4; i++) {
      const copy = await db.sessionQuestion.findUniqueOrThrow({ where: { id: current.currentQuestion!.id } });
      await send('answer', { deviceId: an, roomCode: session.roomCode, questionId: copy.id, answer: copy.correctAnswer, sequence: 1 });
      if (i < 2) await send('answer', { deviceId: binh, roomCode: session.roomCode, questionId: copy.id, answer: copy.correctAnswer, sequence: 1 });
      await sessions.control(teacherId, session.id, 'close');
      current = await sessions.control(teacherId, session.id, 'next');
    }
    expect(current.status).toBe('FINISHED');
    expect(current.participants.map(p => p.studentName).sort()).toEqual(['Nguyễn An', 'Trần Bình']);
    const report = await exams.report(teacherId, exam.id);
    expect(report.classes[0]).toMatchObject({ classroomName: `10A1 ${tag}`, summary: { count: 2, mean: 7.5, passRate: 100 } });
    expect(report.questions.map(q => q.correctRate)).toEqual(expect.arrayContaining([1, 0.5]));
    const classReport = await classes.report(teacherId, classroom.id);
    expect(classReport.students).toEqual([{ code: '01', name: 'Nguyễn An', scores: [10], average: 10 }, { code: '02', name: 'Trần Bình', scores: [5], average: 5 }]);
    expect((await classes.reportWorkbook(teacherId, classroom.id)).buffer.subarray(0, 2).toString()).toBe('PK');
    expect((await exams.papers(teacherId, exam.id)).buffer.subarray(0, 2).toString()).toBe('PK');
    expect((await exams.answerKey(teacherId, exam.id)).buffer.subarray(0, 2).toString()).toBe('PK');
    expect((await exams.reportWorkbook(teacherId, exam.id)).buffer.subarray(0, 2).toString()).toBe('PK');
  }, 30000);
});
