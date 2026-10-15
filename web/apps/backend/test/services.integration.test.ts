import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../src/auth';
import { QuizService } from '../src/quizzes';
import { SessionService } from '../src/sessions';
import { MqttProcessor } from '../src/mqtt';
import { PrismaService } from '../src/prisma.service';
import { SessionEvents } from '../src/events';
import { topics, Ack } from '@classpulse/mqtt-contracts';

// Genuine PostgreSQL tests: DATABASE_URL must point to an already migrated test database.
const db = new PrismaService();
const events = new SessionEvents();
const sessions = new SessionService(db, events);
const quizService = new QuizService(db);
const processor = new MqttProcessor(db, events);
const auth = new AuthService(db, new JwtService({ secret: 'integration-only-secret-at-least-32-characters' }));
const tag = randomUUID().slice(0, 8);
let teacherId: string; let otherTeacherId: string; let quizId: string;
let studentSerial = 0;
const deviceIds = new Set<string>();
const requestIds = new Set<string>();
function identity(deviceId = `test-${tag}-${randomUUID().slice(0, 8)}`) {
  deviceIds.add(deviceId); const requestId = randomUUID(); requestIds.add(requestId);
  return { requestId, deviceId, clientTimestamp: new Date().toISOString() };
}
async function join(roomCode: string, deviceId?: string, studentCode?: string) {
  const body = { ...identity(deviceId), roomCode, studentCode: studentCode ?? String(studentSerial++ % 100).padStart(2, '0') };
  return { body, ack: (await processor.process(topics.join(body.deviceId), JSON.stringify(body)))! };
}
async function answer(roomCode: string, questionId: string, deviceId: string, value = 'A', sequence = 1) {
  const body = { ...identity(deviceId), roomCode, questionId, answer: value, sequence };
  return { body, ack: (await processor.process(topics.answer(deviceId), JSON.stringify(body)))! };
}
async function fresh(mode: 'MANUAL'|'TIMER' = 'MANUAL') { return sessions.create(teacherId, { quizId, mode }); }
beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests.');
  await db.$connect();
  const first = await auth.register({ email: `integration-${tag}@example.test`, name: 'Integration Teacher', password: 'TestOnly@12345' });
  teacherId = first.response.teacher.id;
  const other = await auth.register({ email: `integration-other-${tag}@example.test`, name: 'Other Teacher', password: 'TestOnly@12345' });
  otherTeacherId = other.response.teacher.id;
  const quiz = await quizService.create(teacherId, { title: `Integration ${tag}`, questions: [0,1].map(order => ({ content: `Q${order + 1}`, optionA: 'One', optionB: 'Two', optionC: 'Three', optionD: 'Four', correctAnswer: 'A', durationSeconds: 30, order })) });
  quizId = quiz.id;
}, 15000);
afterAll(async () => {
  const teachers = [teacherId, otherTeacherId].filter(Boolean);
  if (teachers.length) {
    await db.answer.deleteMany({ where: { participant: { session: { teacherId: { in: teachers } } } } });
    await db.sessionParticipant.deleteMany({ where: { session: { teacherId: { in: teachers } } } });
    await db.sessionQuestion.deleteMany({ where: { session: { teacherId: { in: teachers } } } });
    await db.quizSession.deleteMany({ where: { teacherId: { in: teachers } } });
    await db.question.deleteMany({ where: { quiz: { teacherId: { in: teachers } } } });
    await db.quiz.deleteMany({ where: { teacherId: { in: teachers } } });
    await db.refreshToken.deleteMany({ where: { teacherId: { in: teachers } } });
    await db.teacher.deleteMany({ where: { id: { in: teachers } } });
  }
  await db.processedMqttMessage.deleteMany({ where: { requestId: { in: [...requestIds] } } });
  await db.device.deleteMany({ where: { id: { in: [...deviceIds] } } });
  await db.$disconnect();
});

describe('PostgreSQL authentication and ownership', () => {
  it('registers, logs in, rotates refresh tokens, and rejects replay', async () => {
    const login = await auth.login({ email: `integration-${tag}@example.test`, password: 'TestOnly@12345' });
    expect(await auth.verify(login.response.accessToken)).toBe(teacherId);
    const rotated = await auth.refresh(login.refreshToken);
    expect(rotated.refreshToken).not.toBe(login.refreshToken);
    await expect(auth.refresh(login.refreshToken)).rejects.toThrow();
    await expect(auth.refresh(rotated.refreshToken)).rejects.toThrow();
    await expect(auth.login({ email: `integration-${tag}@example.test`, password: 'incorrect' })).rejects.toThrow();
  });
  it('rejects another teacher reading or changing quiz/session', async () => {
    await expect(quizService.get(otherTeacherId, quizId)).rejects.toThrow();
    await expect(quizService.update(otherTeacherId, quizId, { title: 'Unauthorized' })).rejects.toThrow();
    const s = await fresh();
    await expect(sessions.get(otherTeacherId, s.id)).rejects.toThrow();
    await expect(sessions.control(otherTeacherId, s.id, 'start')).rejects.toThrow();
  });
  it('keeps session snapshots after source questions change or quiz is deleted', async () => {
    const q = await quizService.duplicate(teacherId, quizId);
    const s = await sessions.create(teacherId, { quizId: q.id });
    await quizService.update(teacherId, q.id, { questions: [{ content: 'Changed', optionA: 'New', optionB: 'New', optionC: 'New', optionD: 'New', correctAnswer: 'B', durationSeconds: 20, order: 0 }] });
    await quizService.remove(teacherId, q.id);
    const started = await sessions.control(teacherId, s.id, 'start');
    expect(started.currentQuestion?.content).toBe('Q1'); expect(started.totalQuestions).toBe(2);
  });
});
describe('MQTT transactional processing', () => {
  it('joins, rejects missing room, and prevents conflicting device/student bindings', async () => {
    const s = await fresh(); const first = await join(s.roomCode, undefined, '01');
    expect(first.ack.code).toBe('JOIN_ACCEPTED');
    expect((await join(s.roomCode, first.body.deviceId, '02')).ack.code).toBe('DEVICE_ALREADY_JOINED');
    expect((await join(s.roomCode, undefined, '01')).ack.code).toBe('STUDENT_ALREADY_JOINED');
    expect((await join('000000')).ack.code).toBe('ROOM_NOT_FOUND');
    expect((await sessions.snapshot(s.id)).participantCount).toBe(1);
  });
  it('accepts A/B/C/D and counts the latest confirmed sequence only', async () => {
    const s = await fresh(); const first = await join(s.roomCode);
    const current = await sessions.control(teacherId, s.id, 'start'); const qid = current.currentQuestion!.id;
    for (const [index, value] of ['A','B','C','D'].entries()) expect((await answer(s.roomCode, qid, first.body.deviceId, value, index + 1)).ack.code).toBe('ANSWER_ACCEPTED');
    expect((await answer(s.roomCode, qid, first.body.deviceId, 'A', 2)).ack.code).toBe('STALE_SEQUENCE');
    const before = await sessions.snapshot(s.id); expect(before.answerCount).toBe(1); expect(before.participants[0].answer).toBeUndefined();
    const closed = await sessions.control(teacherId, s.id, 'close');
    expect(closed.stats.counts).toEqual({ A: 0, B: 0, C: 0, D: 1 });
    expect(closed.stats.correct).toBe(0); expect(closed.stats.incorrectPercentage).toBe(100);
    expect((await answer(s.roomCode, qid, first.body.deviceId, 'A', 5)).ack.success).toBe(false);
  });
  it('rejects invalid answers, unjoined devices, wrong questions and expired deadlines', async () => {
    const s = await fresh(); const joined = await join(s.roomCode); const started = await sessions.control(teacherId, s.id, 'start'); const qid = started.currentQuestion!.id;
    expect((await answer(s.roomCode, qid, joined.body.deviceId, 'Z')).ack.code).toBe('INVALID_ANSWER');
    expect((await answer(s.roomCode, qid, identity().deviceId)).ack.code).toBe('DEVICE_NOT_JOINED');
    expect((await answer(s.roomCode, randomUUID(), joined.body.deviceId)).ack.code).toBe('QUESTION_NOT_ACTIVE');
    await db.quizSession.update({ where: { id: s.id }, data: { questionEndsAt: new Date(Date.now() - 1000) } });
    expect((await answer(s.roomCode, qid, joined.body.deviceId)).ack.code).toBe('QUESTION_EXPIRED');
    expect((await sessions.snapshot(s.id)).answerCount).toBe(0);
  });
  it('deduplicates two QoS1 deliveries atomically and rejects requestId payload reuse', async () => {
    const s = await fresh(); const joined = await join(s.roomCode); const started = await sessions.control(teacherId, s.id, 'start');
    const body = { ...identity(joined.body.deviceId), roomCode: s.roomCode, questionId: started.currentQuestion!.id, answer: 'B', sequence: 1 };
    const results = await Promise.all([0,1].map(() => processor.process(topics.answer(body.deviceId), JSON.stringify(body))));
    expect(results.map(a => a!.code).sort()).toEqual(['ANSWER_ACCEPTED','DUPLICATE_MESSAGE']);
    expect(results.every(a => a!.success)).toBe(true);
    expect(await db.answer.count({ where: { questionId: body.questionId } })).toBe(1);
    expect(await processor.process(topics.answer(body.deviceId), JSON.stringify({ ...body, answer: 'C' }))).toMatchObject({ code: 'INVALID_PAYLOAD' });
  });
  it('serializes 50 near simultaneous devices without losing any final answer', async () => {
    const s = await fresh(); const joins = await Promise.all(Array.from({ length: 50 }, () => join(s.roomCode)));
    expect(joins.every(j => j.ack.success)).toBe(true);
    const started = await sessions.control(teacherId, s.id, 'start');
    const replies = await Promise.all(joins.map((j, i) => answer(s.roomCode, started.currentQuestion!.id, j.body.deviceId, ['A','B','C','D'][i % 4])));
    expect(replies.every(r => r.ack.success)).toBe(true);
    const closed = await sessions.control(teacherId, s.id, 'close');
    expect(closed.stats).toMatchObject({ total: 50, answered: 50, unanswered: 0, counts: { A: 13, B: 13, C: 12, D: 12 }, correct: 13, correctPercentage: 26 });
  }, 30000);
  it('calculates each finished participant score on a ten-point scale', async () => {
    const s = await fresh(); const joined = await join(s.roomCode);
    const first = await sessions.control(teacherId, s.id, 'start');
    await answer(s.roomCode, first.currentQuestion!.id, joined.body.deviceId, 'A');
    await sessions.control(teacherId, s.id, 'close');
    const second = await sessions.control(teacherId, s.id, 'next');
    await answer(s.roomCode, second.currentQuestion!.id, joined.body.deviceId, 'B');
    await sessions.control(teacherId, s.id, 'finish');
    expect(await sessions.deviceResults(s.id)).toEqual([{ deviceId: joined.body.deviceId, roomCode: s.roomCode, correct: 1, total: 2, score: 5 }]);
  });
});
describe('persisted deadlines and reload recovery', () => {
  it('reloads the same server state and recovers close/next after service restart', async () => {
    const s = await fresh('TIMER'); const started = await sessions.control(teacherId, s.id, 'start');
    const reloaded = await sessions.get(teacherId, s.id);
    expect(reloaded.questionEndsAt).toBe(started.questionEndsAt); expect(reloaded.currentQuestion?.id).toBe(started.currentQuestion?.id);
    await db.quizSession.update({ where: { id: s.id }, data: { questionEndsAt: new Date(Date.now() - 1000) } });
    const recovered = new SessionService(db, events);
    await recovered.tick(); expect((await recovered.snapshot(s.id)).status).toBe('QUESTION_CLOSED');
    await db.quizSession.update({ where: { id: s.id }, data: { nextQuestionAt: new Date(Date.now() - 1000) } });
    await recovered.tick(); const next = await recovered.snapshot(s.id);
    expect(next.status).toBe('QUESTION_ACTIVE'); expect(next.currentQuestionIndex).toBe(1); expect(Date.parse(next.questionEndsAt!)).toBeGreaterThan(Date.now());
    await recovered.control(teacherId, s.id, 'close');
    await db.quizSession.update({ where: { id: s.id }, data: { nextQuestionAt: new Date(Date.now() - 1000) } });
    await recovered.tick(); expect((await recovered.snapshot(s.id)).status).toBe('FINISHED');
  });
});
