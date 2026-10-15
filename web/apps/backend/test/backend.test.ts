import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { calculateStats } from '@classpulse/shared-types';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { MqttProcessor } from '../src/mqtt';
import { PrismaService } from '../src/prisma.service';
import { SessionEvents } from '../src/events';
import { buildSessionCsv, SessionService } from '../src/sessions';
import { QuestionDto, RegisterDto } from '../src/dto';

describe('statistics and privacy', () => {
  it('never divides by zero', () => {
    expect(calculateStats([], 12, 'A')).toEqual({ total: 12, answered: 0, unanswered: 12, counts: { A: 0, B: 0, C: 0, D: 0 }, percentages: { A: 0, B: 0, C: 0, D: 0 }, correct: 0, incorrect: 0, correctPercentage: 0, incorrectPercentage: 0 });
  });
  it('calculates final answers with correct denominator', () => {
    expect(calculateStats(['A','B','A','D'], 10, 'A')).toMatchObject({ answered: 4, unanswered: 6, counts: { A: 2, B: 1, C: 0, D: 1 }, percentages: { A: 50, B: 25, C: 0, D: 25 }, correct: 2, incorrect: 2, correctPercentage: 50 });
  });
  it('hides correct answers, future questions, and per-student answers while active', async () => {
    const q = { id: 'q', content: 'Question', optionA: 'A', optionB: 'B', optionC: 'C', optionD: 'D', correctAnswer: 'A', durationSeconds: 30, order: 0, closedAt: null, answers: [{ answer: 'A' }] };
    const session = { id: 's', quizId: 'quiz', title: 'Class', roomCode: '123456', status: 'QUESTION_ACTIVE', mode: 'MANUAL', currentQuestionIndex: 0, createdAt: new Date(), questions: [q, { ...q, id: 'q2', order: 1 }], participants: [{ id: 'p', deviceId: 'dev', studentCode: 'SV01', joinedAt: new Date(), answers: [{ questionId: 'q', answer: 'A' }] }] };
    const db = { $transaction: vi.fn().mockResolvedValue(session) } as unknown as PrismaService;
    const service = new SessionService(db, new SessionEvents());
    const active = await service.snapshot('s');
    expect(active.currentQuestion).not.toHaveProperty('correctAnswer');
    expect(active.participants[0]).toEqual(expect.objectContaining({ answered: true }));
    expect(active.participants[0]).not.toHaveProperty('answer');
    expect(active.stats.correct).toBe(0); expect(active.results).toEqual([]);
    session.status = 'QUESTION_CLOSED';
    const closed = await service.snapshot('s');
    expect(closed.currentQuestion?.correctAnswer).toBe('A');
    expect(closed.participants[0]).toMatchObject({ answer: 'A', isCorrect: true });
  });
});
describe('CSV result export', () => {
  it('creates an Excel-friendly gradebook and neutralizes spreadsheet formulas', () => {
    const csv = buildSessionCsv({
      roomCode: '123456', title: 'IoT, "cơ bản"',
      questions: [
        { id: 'q1', content: 'MQTT là gì?', correctAnswer: 'B' },
        { id: 'q2', content: 'BLE?', correctAnswer: 'A' },
      ],
      participants: [{ studentCode: '=2+2', deviceId: 'device-001', joinedAt: new Date('2026-09-30T01:00:00.000Z'), answers: [{ questionId: 'q1', answer: 'B' }] }],
    });
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"IoT, ""cơ bản"""');
    expect(csv).toContain('"\'=2+2"');
    expect(csv).toContain('"Đúng"');
    expect(csv).toContain('"Chưa trả lời"');
    expect(csv).toContain('"1","1","2","50"');
  });
});
describe('MQTT validation before any database access', () => {
  const db = { $transaction: vi.fn() } as unknown as PrismaService;
  const processor = new MqttProcessor(db, new SessionEvents());
  it('does not reflect unsupported topics', async () => expect(await processor.process('quiz/v2/devices/one/answer', '{}')).toBeNull());
  it('rejects malformed JSON and oversized payloads', async () => {
    expect(await processor.process('quiz/v1/devices/test-device/join', '{')).toMatchObject({ code: 'INVALID_PAYLOAD', success: false });
    expect(await processor.process('quiz/v1/devices/test-device/join', 'x'.repeat(9000))).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('rejects a topic/payload device mismatch', async () => {
    const data = { requestId: 'fe60868f-607e-4449-a455-21cfe1ca37ec', deviceId: 'different-device', roomCode: '123456', studentCode: '01', clientTimestamp: new Date().toISOString() };
    expect(await processor.process('quiz/v1/devices/test-device/join', JSON.stringify(data))).toMatchObject({ code: 'INVALID_PAYLOAD' });
  });
});
describe('DTO boundaries', () => {
  it('normalizes teacher email, rejects weak passwords', async () => {
    const input = plainToInstance(RegisterDto, { email: ' TEACHER@example.com ', name: ' Giáo viên ', password: 'short' });
    expect(input.email).toBe('teacher@example.com'); expect(input.name).toBe('Giáo viên');
    expect((await validate(input)).map(e => e.property)).toContain('password');
  });
  it('rejects invalid answer and duration', async () => {
    const input = plainToInstance(QuestionDto, { content: 'Q', optionA: 'A', optionB: 'B', optionC: 'C', optionD: 'D', correctAnswer: 'Z', durationSeconds: 0, order: 0 });
    expect((await validate(input)).map(e => e.property)).toEqual(expect.arrayContaining(['correctAnswer','durationSeconds']));
  });
});
