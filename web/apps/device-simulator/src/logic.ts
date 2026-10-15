import { toAnswerKey, type AnswerChoice, type AnswerKey } from '@classpulse/shared-types';
import type { RoomState } from '@classpulse/mqtt-contracts';

export type EntryStep = 'room' | 'student' | 'ready';
export interface KeypadState { step: EntryStep; entry: string; roomCode: string; studentCode: string; selected: AnswerKey | null }
export const initialKeypad: KeypadState = { step: 'room', entry: '', roomCode: '', studentCode: '', selected: null };
export const KEYPAD = ['1', '2', '3', 'A', '4', '5', '6', 'B', '7', '8', '9', 'C', 'Xóa', '0', 'Confirm', 'D'];
export const isChoice = (key: string): key is AnswerChoice => ['A', 'B', 'C', 'D'].includes(key);
/** In multi-answer questions A–D toggle letters; the selection is always kept in canonical order (e.g. "AC"). */
export function applyKey(state: KeypadState, key: string, multiple = false): KeypadState {
  if (key === 'Xóa') return state.step === 'ready' ? { ...state, selected: null } : { ...state, entry: state.entry.slice(0, -1) };
  if (state.step === 'ready') {
    if (!isChoice(key)) return state;
    if (!multiple) return { ...state, selected: key };
    const letters = new Set(state.selected ?? '');
    if (letters.has(key)) letters.delete(key); else letters.add(key);
    return { ...state, selected: toAnswerKey(letters) };
  }
  if (/^\d$/.test(key) && state.entry.length < (state.step === 'room' ? 6 : 2)) return { ...state, entry: state.entry + key };
  if (key === 'Confirm' && state.step === 'room' && state.entry.length === 6) return { ...state, step: 'student', roomCode: state.entry, entry: '' };
  return state;
}
/** Scroll complete pairs. No frame ever renders more than two LED characters. */
export function displayFrame(value: string, tick: number): string {
  const text = (value || '--').toUpperCase();
  if (text.length <= 2) return text.padEnd(2, ' ');
  const padded = text.length % 2 ? `${text} ` : text;
  const start = (tick % (padded.length / 2)) * 2;
  return padded.slice(start, start + 2);
}
export function nextSequence(storage: Pick<Storage, 'getItem' | 'setItem'>, deviceId: string, questionId: string): number {
  const key = `classpulse.sequence.${deviceId}.${questionId}`;
  const previous = Number(storage.getItem(key) || 0);
  const next = Number.isSafeInteger(previous) && previous >= 0 ? previous + 1 : 1;
  if (next > 2147483647) throw new Error('Đã đạt giới hạn sequence; cần dùng thiết bị mới.');
  storage.setItem(key, String(next));
  return next;
}
export function isRoomState(value: unknown): value is RoomState {
  if (!value || typeof value !== 'object') return false;
  const state = value as RoomState;
  if (typeof state.sessionId !== 'string' || typeof state.roomCode !== 'string' || !/^\d{6}$/.test(state.roomCode)
    || !['LOBBY', 'QUESTION_ACTIVE', 'QUESTION_CLOSED', 'FINISHED'].includes(state.status)
    || !Number.isFinite(Date.parse(state.serverTimestamp)) || !Number.isInteger(state.totalQuestions) || !Number.isInteger(state.currentQuestionIndex)) return false;
  for (const date of [state.questionStartedAt, state.questionEndsAt]) if (date !== null && (typeof date !== 'string' || !Number.isFinite(Date.parse(date)))) return false;
  if (state.currentQuestion !== null) {
    const question = state.currentQuestion;
    if (!question || typeof question.id !== 'string' || typeof question.content !== 'string'
      || !['optionA', 'optionB', 'optionC', 'optionD'].every(k => typeof (question as unknown as Record<string, unknown>)[k] === 'string')
      || (question.type !== undefined && question.type !== 'SINGLE' && question.type !== 'MULTIPLE')) return false;
  }
  return state.status !== 'QUESTION_ACTIVE' || Boolean(state.currentQuestion && state.questionEndsAt);
}
