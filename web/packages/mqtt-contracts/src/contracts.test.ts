import { describe, expect, it } from 'vitest';
import { calculateStats } from '@classpulse/shared-types';
import { parseDeviceTopic, topics, validateDeviceMessage } from './index';

const join = { requestId: '6e9a650c-68f5-467c-a1cd-c7d1d573778a', deviceId: 'test-device', roomCode: '123456', studentCode: '01', clientTimestamp: '2026-09-29T08:00:00.000Z' };
const answer = { requestId: join.requestId, deviceId: join.deviceId, roomCode: join.roomCode, questionId: '9cfaeaa6-6435-4c10-9992-63b028db5907', answer: 'A', sequence: 1, clientTimestamp: join.clientTimestamp };

describe('versioned MQTT contract', () => {
  it('validates join and every A/B/C/D answer', () => {
    expect(validateDeviceMessage(topics.join(join.deviceId), join).success).toBe(true);
    for (const choice of ['A', 'B', 'C', 'D']) expect(validateDeviceMessage(topics.answer(join.deviceId), { ...answer, answer: choice }).success).toBe(true);
  });
  it('requires a student ID containing exactly two digits', () => {
    for (const studentCode of ['1', '001', 'A1', '']) {
      expect(validateDeviceMessage(topics.join(join.deviceId), { ...join, studentCode }).success).toBe(false);
    }
  });
  it('rejects topic/payload identity mismatch and topic wildcards', () => {
    expect(validateDeviceMessage(topics.join('another-device'), join).success).toBe(false);
    expect(parseDeviceTopic('quiz/v1/devices/+/join')).toBeNull();
    expect(parseDeviceTopic('quiz/v2/devices/test-device/join')).toBeNull();
    expect(parseDeviceTopic('quiz/v1/devices/test-device/ack')).toBeNull();
    expect(parseDeviceTopic('quiz/v1/devices/test-device/join/extra')).toBeNull();
  });
  it('requires request UUID, valid timestamp, safe room and sequence', () => {
    for (const patch of [{ requestId: 'bad' }, { clientTimestamp: 'yesterday' }, { roomCode: '../#' }, { sequence: -1 }, { sequence: 0.5 }, { extra: true }]) {
      expect(validateDeviceMessage(topics.answer(join.deviceId), { ...answer, ...patch }).success).toBe(false);
    }
  });
  it('returns a specific invalid-answer error', () => {
    expect(validateDeviceMessage(topics.answer(join.deviceId), { ...answer, answer: 'E' })).toMatchObject({ success: false, code: 'INVALID_ANSWER' });
  });
  it('accepts canonical multi-answer keys only', () => {
    for (const key of ['AC', 'BCD', 'ABCD']) expect(validateDeviceMessage(topics.answer(join.deviceId), { ...answer, answer: key }).success).toBe(true);
    for (const key of ['CA', 'AA', '', 'a', 'AE']) expect(validateDeviceMessage(topics.answer(join.deviceId), { ...answer, answer: key })).toMatchObject({ success: false, code: 'INVALID_ANSWER' });
  });
});

describe('answer statistics', () => {
  it('has finite zero percentages with no answers', () => {
    expect(calculateStats([], 50, 'A')).toEqual({ total: 50, answered: 0, unanswered: 50, counts: { A: 0, B: 0, C: 0, D: 0 }, percentages: { A: 0, B: 0, C: 0, D: 0 }, correct: 0, incorrect: 0, correctPercentage: 0, incorrectPercentage: 0 });
  });
  it('uses valid confirmed answers as percentage denominator', () => {
    expect(calculateStats(['A', 'B', 'A', 'D'], 5, 'A')).toMatchObject({ answered: 4, unanswered: 1, correct: 2, incorrect: 2, correctPercentage: 50, percentages: { A: 50, B: 25, C: 0, D: 25 } });
  });
  it('hides correctness before a correct answer is supplied', () => {
    expect(calculateStats(['A', 'B'], 3)).toMatchObject({ correct: 0, incorrect: 0, correctPercentage: 0, incorrectPercentage: 0 });
  });
  it('counts each selected letter of multi-answer keys', () => {
    expect(calculateStats(['AB', 'A', 'BD'], 3, 'AB')).toMatchObject({ counts: { A: 2, B: 2, C: 0, D: 1 }, correct: 1, incorrect: 2 });
  });
});
