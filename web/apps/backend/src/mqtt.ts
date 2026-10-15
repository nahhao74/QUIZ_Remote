import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { connect, MqttClient } from 'mqtt';
import { Ack, AckCode, AnswerMessage, DeviceMessage, JoinMessage, ResultCommand, RoomState, StatusMessage, parseDeviceTopic, topics, validateDeviceMessage } from '@classpulse/mqtt-contracts';
import { SessionEvents } from './events';
import { PrismaService } from './prisma.service';
import { lockSession, SessionService } from './sessions';

const messages: Record<AckCode, string> = {
  JOIN_ACCEPTED: 'Joined session', ANSWER_ACCEPTED: 'Answer saved', STATUS_ACCEPTED: 'Status updated',
  INVALID_PAYLOAD: 'Invalid payload or topic', DEVICE_NOT_JOINED: 'Join the session first', ROOM_NOT_FOUND: 'Room not found',
  SESSION_NOT_ACTIVE: 'Session is not accepting answers', QUESTION_NOT_ACTIVE: 'This question is not active', QUESTION_EXPIRED: 'The answer deadline has passed',
  INVALID_ANSWER: 'Answer must be one of A-D, or several letters in order (e.g. AC) for multiple-answer questions', DUPLICATE_MESSAGE: 'Request was already processed', STALE_SEQUENCE: 'A newer answer has already been confirmed',
  STUDENT_ALREADY_JOINED: 'Student code is already linked to another device', DEVICE_ALREADY_JOINED: 'Device is already linked to another student', SERVER_ERROR: 'Server temporarily unavailable; retry the same requestId',
};
export const makeAck = (requestId: string, code: AckCode, extra: Partial<Ack> = {}): Ack => ({ requestId, code, success: ['JOIN_ACCEPTED','ANSWER_ACCEPTED','STATUS_ACCEPTED'].includes(code), message: messages[code], serverTimestamp: new Date().toISOString(), ...extra });
const canonical = (value: DeviceMessage) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));

@Injectable()
export class MqttProcessor {
  constructor(private readonly db: PrismaService, private readonly events: SessionEvents) {}
  async process(topic: string, raw: Buffer | string): Promise<Ack | null> {
    const parsed = parseDeviceTopic(topic);
    if (!parsed) return null; // Never reflect untrusted topics into an outbound path.
    let value: unknown;
    if (Buffer.byteLength(raw) > 8192) return makeAck('invalid', 'INVALID_PAYLOAD');
    try { value = JSON.parse(raw.toString()); } catch { return makeAck('invalid', 'INVALID_PAYLOAD'); }
    const requestId = typeof value === 'object' && value !== null && 'requestId' in value && typeof value.requestId === 'string' && value.requestId.length <= 64 ? value.requestId : 'invalid';
    const valid = validateDeviceMessage(topic, value);
    if (!valid.success) return makeAck(requestId, valid.code);
    const data = valid.data;
    const payloadHash = createHash('sha256').update(canonical(data)).digest('hex');
    const result = await this.db.$transaction(async tx => {
      // Serialize a UUID before checking its row, including two deliveries arriving before either INSERT.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${data.requestId}, 0))`;
      const previous = await tx.processedMqttMessage.findUnique({ where: { requestId: data.requestId } });
      if (previous) {
        if (previous.deviceId !== parsed.deviceId || previous.action !== parsed.action || previous.payloadHash !== payloadHash) return { ack: makeAck(data.requestId, 'INVALID_PAYLOAD'), sessionId: null };
        const original = previous.ack as unknown as Ack;
        return { ack: makeAck(data.requestId, 'DUPLICATE_MESSAGE', { success: original.success, originalCode: original.code, roomCode: original.roomCode }), sessionId: null };
      }
      const lookup = await tx.quizSession.findFirst({ where: { roomCode: data.roomCode }, orderBy: [{ finishedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }] });
      let ack: Ack;
      let sessionId: string | null = null;
      if (!lookup) ack = makeAck(data.requestId, 'ROOM_NOT_FOUND');
      else {
        await lockSession(tx, lookup.id);
        const session = await tx.quizSession.findUniqueOrThrow({ where: { id: lookup.id } });
        const now = new Date(); // Must be captured AFTER waiting for the session lock.
        if (session.status === 'FINISHED') ack = makeAck(data.requestId, 'SESSION_NOT_ACTIVE');
        else if (valid.action === 'join') {
          const join = data as JoinMessage;
          const existing = await tx.sessionParticipant.findUnique({ where: { sessionId_deviceId: { sessionId: session.id, deviceId: join.deviceId } } });
          const occupied = await tx.sessionParticipant.findUnique({ where: { sessionId_studentCode: { sessionId: session.id, studentCode: join.studentCode } } });
          if (existing && existing.studentCode !== join.studentCode) ack = makeAck(data.requestId, 'DEVICE_ALREADY_JOINED');
          else if (occupied && occupied.deviceId !== join.deviceId) ack = makeAck(data.requestId, 'STUDENT_ALREADY_JOINED');
          else {
            await tx.device.upsert({ where: { id: join.deviceId }, create: { id: join.deviceId }, update: { online: true, lastSeenAt: now } });
            if (!existing) await tx.sessionParticipant.create({ data: { sessionId: session.id, deviceId: join.deviceId, studentCode: join.studentCode } });
            ack = makeAck(data.requestId, 'JOIN_ACCEPTED', { roomCode: data.roomCode }); sessionId = session.id;
          }
        } else {
          const participant = await tx.sessionParticipant.findUnique({ where: { sessionId_deviceId: { sessionId: session.id, deviceId: data.deviceId } } });
          if (!participant) ack = makeAck(data.requestId, 'DEVICE_NOT_JOINED');
          else if (valid.action === 'status') {
            await tx.device.update({ where: { id: data.deviceId }, data: { online: (data as StatusMessage).online, lastSeenAt: now } });
            ack = makeAck(data.requestId, 'STATUS_ACCEPTED');
          } else {
            const answer = data as AnswerMessage;
            const current = await tx.sessionQuestion.findUnique({ where: { sessionId_order: { sessionId: session.id, order: session.currentQuestionIndex } } });
            if (session.status !== 'QUESTION_ACTIVE') ack = makeAck(data.requestId, 'SESSION_NOT_ACTIVE');
            else if (!current || current.id !== answer.questionId) ack = makeAck(data.requestId, 'QUESTION_NOT_ACTIVE');
            else if (!session.questionEndsAt || now >= session.questionEndsAt) ack = makeAck(data.requestId, 'QUESTION_EXPIRED');
            else if (current.type === 'SINGLE' && answer.answer.length > 1) ack = makeAck(data.requestId, 'INVALID_ANSWER');
            else {
              const existing = await tx.answer.findUnique({ where: { participantId_questionId: { participantId: participant.id, questionId: current.id } } });
              if (existing && answer.sequence <= existing.sequence) ack = makeAck(data.requestId, 'STALE_SEQUENCE');
              else {
                const fields = { answer: answer.answer, sequence: answer.sequence, clientTimestamp: new Date(answer.clientTimestamp), serverTimestamp: now };
                await tx.answer.upsert({ where: { participantId_questionId: { participantId: participant.id, questionId: current.id } }, create: { participantId: participant.id, questionId: current.id, ...fields }, update: fields });
                await tx.device.update({ where: { id: data.deviceId }, data: { online: true, lastSeenAt: now } });
                ack = makeAck(data.requestId, 'ANSWER_ACCEPTED'); sessionId = session.id;
              }
            }
          }
        }
      }
      // The mutation and its ACK commit together. Retrying never reapplies a committed answer.
      await tx.processedMqttMessage.create({ data: { requestId: data.requestId, deviceId: data.deviceId, action: valid.action, payloadHash, ack: ack as unknown as Prisma.InputJsonValue } });
      return { ack, sessionId };
    }, { maxWait: 15000, timeout: 15000 });
    if (result.sessionId) void this.events.publish(result.sessionId);
    return result.ack;
  }
}

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttService.name);
  private client?: MqttClient;
  private unsubscribe?: () => void;
  private readonly active = new Set<Promise<void>>();
  private shuttingDown = false;
  constructor(private readonly processor: MqttProcessor, private readonly sessions: SessionService, private readonly db: PrismaService, private readonly events: SessionEvents) {}
  get connected() { return this.client?.connected ?? false; }
  get enabled() { return process.env.MQTT_DISABLED !== 'true'; }
  onModuleInit() {
    if (!this.enabled) return;
    this.client = connect(process.env.MQTT_URL ?? 'mqtt://localhost:1883', {
      clientId: process.env.MQTT_CLIENT_ID ?? 'classpulse-backend', username: process.env.MQTT_USERNAME ?? 'backend', password: process.env.MQTT_PASSWORD,
      clean: false, reconnectPeriod: 1500, connectTimeout: 10000, protocolVersion: 4, queueQoSZero: false,
    });
    this.client.on('connect', () => { void this.onConnected().catch(() => this.logger.error(JSON.stringify({ event: 'mqtt_recovery_failed' }))); });
    this.client.on('error', () => this.logger.error(JSON.stringify({ event: 'mqtt_connection_error' })));
    this.client.on('message', (topic, payload) => {
      if (this.shuttingDown) return;
      const task = this.receive(topic, payload); this.active.add(task); void task.finally(() => this.active.delete(task));
    });
    this.unsubscribe = this.events.subscribe(id => this.broadcast(id));
  }
  private async onConnected() {
    await this.client!.subscribeAsync(['quiz/v1/devices/+/join','quiz/v1/devices/+/answer','quiz/v1/devices/+/status'], { qos: 1 });
    this.logger.log(JSON.stringify({ event: 'mqtt_connected' }));
    const sessions = await this.db.quizSession.findMany({ where: { status: { not: 'FINISHED' } }, select: { id: true } });
    for (const session of sessions) await this.broadcast(session.id);
  }
  private async receive(topic: string, raw: Buffer) {
    const parsed = parseDeviceTopic(topic);
    if (!parsed) return;
    try {
      const ack = await this.processor.process(topic, raw);
      if (ack && this.client?.connected) await this.client.publishAsync(topics.ack(parsed.deviceId), JSON.stringify(ack), { qos: 1, retain: false });
    } catch {
      this.logger.error(JSON.stringify({ event: 'mqtt_processing_failed', deviceId: parsed.deviceId }));
      let requestId = 'invalid';
      try { const v = JSON.parse(raw.toString()); if (typeof v.requestId === 'string' && v.requestId.length <= 64) requestId = v.requestId; } catch {}
      if (this.client?.connected) await this.client.publishAsync(topics.ack(parsed.deviceId), JSON.stringify(makeAck(requestId, 'SERVER_ERROR')), { qos: 1 }).catch(() => {});
    }
  }
  async broadcast(sessionId: string) {
    if (!this.client?.connected) return;
    const s = await this.sessions.snapshot(sessionId);
    // Devices never receive explanations: they are not displayed and could overflow the 12 KB firmware buffer.
    const currentQuestion = s.currentQuestion && (({ explanation, ...question }) => question)(s.currentQuestion);
    const state: RoomState = { sessionId: s.id, roomCode: s.roomCode, status: s.status, serverTimestamp: s.serverTime, questionStartedAt: s.questionStartedAt, questionEndsAt: s.questionEndsAt, currentQuestion, totalQuestions: s.totalQuestions, currentQuestionIndex: s.currentQuestionIndex };
    await this.client.publishAsync(topics.state(s.roomCode), JSON.stringify(state), { qos: 1, retain: true });
    // Use the same envelope for both retained room topics, including a null question in the lobby.
    await this.client.publishAsync(topics.question(s.roomCode), JSON.stringify(state), { qos: 1, retain: true });
    if (s.status === 'FINISHED') {
      const results = await this.sessions.deviceResults(sessionId);
      for (const result of results) {
        const command: ResultCommand = { type: 'RESULT', roomCode: result.roomCode, score: result.score, correct: result.correct, total: result.total, serverTimestamp: s.serverTime };
        await this.client.publishAsync(topics.command(result.deviceId), JSON.stringify(command), { qos: 1, retain: false });
      }
    }
  }
  async onModuleDestroy() {
    this.shuttingDown = true; this.unsubscribe?.();
    await Promise.allSettled([...this.active]);
    if (this.client) await this.client.endAsync();
  }
}
