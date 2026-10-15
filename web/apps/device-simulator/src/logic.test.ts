import { describe, expect, it } from 'vitest';
import { applyKey, displayFrame, initialKeypad, KEYPAD, nextSequence, isRoomState, type KeypadState } from './logic';
describe('physical keypad', () => {
  it('has exactly the required 4×4 layout', () => expect(KEYPAD).toEqual(['1','2','3','A','4','5','6','B','7','8','9','C','Xóa','0','Confirm','D']));
  it('requires six room digits and confirms room before entering student', () => {
    expect(applyKey(initialKeypad, 'Confirm')).toEqual(initialKeypad);
    let state = initialKeypad;
    for (const key of ['1','2','3','4','5','6','7']) state = applyKey(state, key);
    expect(state.entry).toBe('123456');
    state = applyKey(state, 'Confirm');
    expect(state).toMatchObject({ step: 'student', roomCode: '123456', entry: '' });
    state = applyKey(state, '1'); state = applyKey(state, '2'); state = applyKey(state, 'Xóa');
    expect(state.entry).toBe('1');
    state = applyKey(state, '2'); state = applyKey(state, '3');
    expect(state.entry).toBe('12');
  });
  it('clear cancels pending choice, while confirm is handled by transport only', () => {
    const state = { ...initialKeypad, step: 'ready' as const };
    expect(applyKey(applyKey(state, 'B'), 'Confirm').selected).toBe('B');
    expect(applyKey(applyKey(state, 'C'), 'Xóa').selected).toBeNull();
    expect(applyKey(state, '9')).toEqual(state);
  });
  it('toggles several letters in canonical order for multi-answer questions', () => {
    let state: KeypadState = { ...initialKeypad, step: 'ready' };
    for (const key of ['C', 'A', 'D', 'D']) state = applyKey(state, key, true);
    expect(state.selected).toBe('AC');
    expect(applyKey(state, 'B').selected).toBe('B');
    expect(applyKey(applyKey(state, 'A', true), 'C', true).selected).toBeNull();
    expect(applyKey(state, 'Xóa', true).selected).toBeNull();
  });
});
describe('two physical seven-segment digits', () => {
  it('scrolls pairs and pads last odd digit', () => {
    expect([0,1,2,3].map(t => displayFrame('123456',t))).toEqual(['12','34','56','12']);
    expect([0,1,2].map(t => displayFrame('123',t))).toEqual(['12','3 ','12']);
    expect(displayFrame('A',9)).toBe('A ');
    expect(displayFrame('',0)).toBe('--');
  });
  it('maintains monotonically increasing sequence after simulator reinitialization', () => {
    const values = new Map<string,string>();
    const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key,value); } };
    expect(nextSequence(store,'esp-01','q-01')).toBe(1);
    expect(nextSequence(store,'esp-01','q-01')).toBe(2);
    expect(nextSequence(store,'esp-01','q-02')).toBe(1);
    expect(nextSequence(store,'esp-02','q-01')).toBe(1);
  });
  it('rejects incomplete retained state instead of treating it as an active question', () => {
    expect(isRoomState({ status: 'QUESTION_ACTIVE' })).toBe(false);
    expect(isRoomState({ sessionId:'s', roomCode:'123456', status:'LOBBY', serverTimestamp:new Date().toISOString(), questionStartedAt:null, questionEndsAt:null, currentQuestion:null, totalQuestions:3,currentQuestionIndex:-1 })).toBe(true);
  });
});
