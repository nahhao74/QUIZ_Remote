import { z } from 'zod';
import { ANSWER_KEY_PATTERN, type PublicQuestion, type SessionStatus } from '@classpulse/shared-types';
export const deviceIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{3,64}$/);
const base = { requestId: z.string().uuid(), deviceId: deviceIdSchema, roomCode: z.string().regex(/^\d{6}$/), clientTimestamp: z.string().datetime({ offset: true }) };
export const joinSchema = z.object({ ...base, studentCode: z.string().regex(/^\d{2}$/) }).strict();
export const answerSchema = z.object({ ...base, questionId: z.string().uuid(), answer: z.string().regex(ANSWER_KEY_PATTERN), sequence: z.number().int().min(1).max(2147483647) }).strict();
export const statusSchema = z.object({ ...base, online: z.boolean() }).strict();
export type JoinMessage = z.infer<typeof joinSchema>;
export type AnswerMessage = z.infer<typeof answerSchema>;
export type StatusMessage = z.infer<typeof statusSchema>;
export type DeviceMessage = JoinMessage | AnswerMessage | StatusMessage;
export type AckCode = 'JOIN_ACCEPTED' | 'ANSWER_ACCEPTED' | 'STATUS_ACCEPTED' | 'INVALID_PAYLOAD' | 'DEVICE_NOT_JOINED' | 'ROOM_NOT_FOUND' | 'SESSION_NOT_ACTIVE' | 'QUESTION_NOT_ACTIVE' | 'QUESTION_EXPIRED' | 'INVALID_ANSWER' | 'DUPLICATE_MESSAGE' | 'STALE_SEQUENCE' | 'STUDENT_ALREADY_JOINED' | 'DEVICE_ALREADY_JOINED' | 'SERVER_ERROR';
export interface Ack { requestId: string; success: boolean; code: AckCode; message: string; serverTimestamp: string; originalCode?: AckCode; roomCode?: string }
/** `currentQuestion.type` tells devices whether A–D keys select one option or toggle several. Explanations are never sent to devices. */
export type DeviceQuestion = Omit<PublicQuestion, 'explanation'>;
export interface RoomState { sessionId: string; roomCode: string; status: SessionStatus; serverTimestamp: string; questionStartedAt: string | null; questionEndsAt: string | null; currentQuestion: DeviceQuestion | null; totalQuestions: number; currentQuestionIndex: number }
export interface ResultCommand { type: 'RESULT'; roomCode: string; score: number; correct: number; total: number; serverTimestamp: string }
export const topics = {
  join: (deviceId: string) => `quiz/v1/devices/${deviceId}/join`,
  answer: (deviceId: string) => `quiz/v1/devices/${deviceId}/answer`,
  status: (deviceId: string) => `quiz/v1/devices/${deviceId}/status`,
  ack: (deviceId: string) => `quiz/v1/devices/${deviceId}/ack`,
  command: (deviceId: string) => `quiz/v1/devices/${deviceId}/command`,
  question: (roomCode: string) => `quiz/v1/rooms/${roomCode}/question`,
  state: (roomCode: string) => `quiz/v1/rooms/${roomCode}/state`,
};
export function parseDeviceTopic(topic: string): { deviceId: string; action: 'join' | 'answer' | 'status' } | null {
  const match = /^quiz\/v1\/devices\/([a-zA-Z0-9_-]{3,64})\/(join|answer|status)$/.exec(topic);
  return match ? { deviceId: match[1], action: match[2] as 'join' | 'answer' | 'status' } : null;
}
export function validateDeviceMessage(topic: string, payload: unknown) {
  const parsed = parseDeviceTopic(topic);
  if (!parsed) return { success: false as const, code: 'INVALID_PAYLOAD' as AckCode, message: 'Invalid topic' };
  const schema = parsed.action === 'join' ? joinSchema : parsed.action === 'answer' ? answerSchema : statusSchema;
  const result = schema.safeParse(payload);
  if (!result.success) {
    const invalidAnswer = parsed.action === 'answer' && result.error.issues.some(i => i.path[0] === 'answer');
    return { success: false as const, code: (invalidAnswer ? 'INVALID_ANSWER' : 'INVALID_PAYLOAD') as AckCode, message: 'Payload validation failed' };
  }
  if (result.data.deviceId !== parsed.deviceId) return { success: false as const, code: 'INVALID_PAYLOAD' as AckCode, message: 'Topic deviceId does not match payload' };
  return { success: true as const, action: parsed.action, data: result.data };
}
