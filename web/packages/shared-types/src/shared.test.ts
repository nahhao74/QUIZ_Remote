import { describe, expect, it } from 'vitest';
import {
  analyzeItems, buildVariant, calculateStats, createRng, findDuplicatePairs, hasPositionalOptions, keyToDisplay, keyToSource, matchesSearch,
  parseQuestionLines, parseQuestionText, QUESTION_TEXT_SAMPLE, questionIssues, questionSimilarity, reorderOptions, similarityMatcher, summarizeScores, toAnswerKey,
} from './index';

const options = { optionA: 'Một', optionB: 'Hai', optionC: 'Ba', optionD: 'Bốn' };

describe('answer keys', () => {
  it('normalizes letters into one canonical key', () => {
    expect(toAnswerKey(['c', 'A', 'C'])).toBe('AC');
    expect(toAnswerKey('dba')).toBe('ABD');
    expect(toAnswerKey(['E', 'x'])).toBeNull();
  });
  it('maps keys and options through a shuffled order in both directions', () => {
    const order = 'CADB';
    expect(reorderOptions(options, order)).toEqual({ optionA: 'Ba', optionB: 'Một', optionC: 'Bốn', optionD: 'Hai' });
    expect(keyToDisplay('AC', order)).toBe('AB');
    expect(keyToSource('AB', order)).toBe('AC');
    for (const key of ['A', 'B', 'C', 'D', 'BD', 'ABCD']) expect(keyToSource(keyToDisplay(key, order), order)).toBe(key);
  });
  it('counts every chosen letter and scores multi-answer keys all-or-nothing', () => {
    expect(calculateStats(['AC', 'A', 'AC', 'BC'], 5, 'AC')).toMatchObject({ answered: 4, unanswered: 1, counts: { A: 3, B: 1, C: 3, D: 0 }, percentages: { A: 75, C: 75 }, correct: 2, incorrect: 2 });
  });
  it('reports blocking issues for drafts', () => {
    expect(questionIssues({ content: 'Q', ...options, correctAnswer: 'AB', type: 'SINGLE', durationSeconds: 30, order: 0 })).toEqual([expect.stringContaining('một đáp án đúng')]);
    expect(questionIssues({ content: 'Q', ...options, optionD: 'một', correctAnswer: '', durationSeconds: 2, order: 0 })).toHaveLength(3);
  });
});

describe('question document parser', () => {
  it('reads the published sample, including multi-answer keys, inline options and the answer table', () => {
    const result = parseQuestionText(QUESTION_TEXT_SAMPLE, { filename: 'mau.txt' });
    expect(result.title).toBe('Kiểm tra kiến thức IoT');
    expect(result.questions).toHaveLength(3);
    expect(result.questions[0]).toMatchObject({ correctAnswer: 'B', type: 'SINGLE', difficulty: 'EASY', topic: 'Chương 1: Giao thức truyền thông', explanation: expect.stringContaining('broker') });
    expect(result.questions[1]).toMatchObject({ correctAnswer: 'AB', type: 'MULTIPLE', difficulty: 'MEDIUM', durationSeconds: 45, knowledge: 'Khả năng kết nối không dây của ESP32' });
    expect(result.questions[2]).toMatchObject({ optionA: 'Truyền video 4K', optionD: 'Lưu dữ liệu quan hệ', correctAnswer: 'C' });
    expect(result.warnings).toEqual([]);
  });
  it('keeps the legacy TXT format working', () => {
    const result = parseQuestionText('\uFEFFTiêu đề: IoT cơ bản\r\nMô tả: Bài ôn tập\r\n\r\nCâu 1: MQTT là gì?\r\nA. Một DB\r\nB. Một giao thức\r\nC. Một cảm biến\r\nD. Một MCU\r\nĐáp án: B\r\nThời gian: 25 giây\r\n\r\nCâu 2: BLE ưu tiên điều gì?\r\nA) Năng lượng thấp\r\nB) Video\r\nC) SQL\r\nD) HDMI\r\nAnswer: A');
    expect(result).toMatchObject({ title: 'IoT cơ bản', description: 'Bài ôn tập' });
    expect(result.questions.map(q => [q.correctAnswer, q.durationSeconds])).toEqual([['B', 25], ['A', 30]]);
  });
  it('returns incomplete questions with warnings instead of failing', () => {
    const result = parseQuestionText('Câu 1: Thiếu đáp án\nA. Một\nB. Hai\nC. Ba\nD. Bốn\n\nCâu 2: Thiếu D\nA. 1\nB. 2\nC. 3\nĐáp án: A', { filename: 'chuong-1.txt' });
    expect(result.title).toBe('chuong-1');
    expect(result.questions.map(q => q.correctAnswer)).toEqual(['', 'A']);
    expect(result.warnings).toEqual([expect.stringContaining('Câu 1'), expect.stringContaining('phương án D đang trống')]);
  });
  it('handles stems on several lines, statements a)–d), stars and a two-row answer table', () => {
    const text = [
      'ĐỀ KIỂM TRA 15 PHÚT', '', 'Câu 1 (NB): Cho các phát biểu', 'a) MQTT dùng broker', 'b) HTTP là giao thức nhẹ nhất', 'Số phát biểu đúng là', 'A. 0   B. 1', 'C. 2   D. 3',
      'Câu 2. Chọn các số chẵn', '*A. 2', 'B. 3', '*C. 4', 'D. 5',
      'Câu 3: 1 + 1 = ? A. 1 B. 2 C. 3 D. 4',
      'BẢNG ĐÁP ÁN', 'Câu | 1 | 3', 'Đáp án | B | B',
    ].join('\n');
    const [first, second, third] = parseQuestionText(text).questions;
    expect(first).toMatchObject({ content: 'Cho các phát biểu\na) MQTT dùng broker\nb) HTTP là giao thức nhẹ nhất\nSố phát biểu đúng là', optionA: '0', optionD: '3', correctAnswer: 'B', difficulty: 'EASY' });
    expect(second).toMatchObject({ correctAnswer: 'AC', type: 'MULTIPLE', optionA: '2' });
    expect(third).toMatchObject({ content: '1 + 1 = ?', optionB: '2', correctAnswer: 'B' });
  });
  it('maps "1-A, 2-C" keys and "Câu N: Chọn X" explanations from the end of the document', () => {
    const body = 'Câu 1: X?\nA. a\nB. b\nC. c\nD. d\nCâu 2: Y?\nA. a\nB. b\nC. c\nD. d\nĐÁP ÁN\n1-A, 2-C\nHƯỚNG DẪN GIẢI\nCâu 2: Chọn C vì c đúng.';
    const result = parseQuestionText(body);
    expect(result.questions.map(q => q.correctAnswer)).toEqual(['A', 'C']);
    expect(result.questions[1].explanation).toBe('vì c đúng.');
  });
  it('recognizes Word formatting marks and auto-numbered questions', () => {
    const lines = [
      { text: 'Thủ đô của Việt Nam?', numbered: true },
      { text: 'A. Hà Nội', marks: [{ start: 0, end: 9, kind: 'underline' as const }] }, { text: 'B. Huế' }, { text: 'C. Đà Nẵng' }, { text: 'D. Cần Thơ' },
      { text: 'Chương 2', heading: 1 },
      { text: 'Số nguyên tố chẵn duy nhất?', numbered: true }, { text: 'A. 1   B. 2   C. 3   D. 4', marks: [{ start: 7, end: 11, kind: 'color' as const }] },
    ];
    const result = parseQuestionLines(lines);
    expect(result.questions.map(q => [q.correctAnswer, q.topic])).toEqual([['A', ''], ['B', 'Chương 2']]);
    expect(result.warnings.every(w => w.includes('định dạng'))).toBe(true);
  });
  it('splits unnumbered questions by their options', () => {
    const result = parseQuestionText('Câu hỏi thứ nhất?\nA. 1\nB. 2\nC. 3\nD. 4\nCâu hỏi thứ hai dài\nA. 5\nB. 6\nC. 7\nD. 8\nĐáp án: D');
    expect(result.questions.map(q => [q.content, q.correctAnswer])).toEqual([['Câu hỏi thứ nhất?', ''], ['Câu hỏi thứ hai dài', 'D']]);
  });
});

describe('duplicates and search', () => {
  const items = [
    { id: '1', content: 'Thủ đô của Việt Nam là thành phố nào?', options: ['Hà Nội', 'Huế', 'Đà Nẵng', 'TP.HCM'] },
    { id: '2', content: 'Thu do cua Viet Nam la thanh pho nao', options: ['Huế', 'Hà Nội', 'TP.HCM', 'Đà Nẵng'] },
    { id: '3', content: 'MQTT hoạt động theo mô hình nào?', options: ['Pub/sub', 'P2P', 'REST', 'RPC'] },
  ];
  it('finds accent-insensitive duplicates even when options are shuffled', () => {
    const pairs = findDuplicatePairs(items, 0.8);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ a: '1', b: '2', kind: 'EXACT' });
    expect(questionSimilarity(items[0], items[2]).score).toBeLessThan(0.4);
    expect(similarityMatcher(items)({ id: 'new', content: 'Thủ đô Việt Nam là thành phố nào?', options: ['Hà Nội', 'Huế', 'Vinh', 'Hải Phòng'] })?.id).toBe('1');
  });
  it('searches without accents', () => expect(matchesSearch('Giao thức MQTT', 'giao thuc mqtt')).toBe(true));
});

describe('item analysis and score statistics', () => {
  it('computes difficulty, discrimination, distractors and KR-20', () => {
    const questions = [{ id: 'q1', correctAnswer: 'A' }, { id: 'q2', correctAnswer: 'BC' }, { id: 'q3', correctAnswer: 'D' }];
    const responses = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, answers: { q1: i < 9 ? 'A' : 'B', q2: i < 6 ? 'BC' : 'B', q3: i % 2 ? 'D' : 'A' } as Record<string, string> }));
    const report = analyzeItems(questions, responses);
    expect(report.participants).toBe(12);
    expect(report.items[0]).toMatchObject({ correct: 9, difficulty: 0.75, level: 'EASY' });
    expect(report.items[1].difficulty).toBe(0.5);
    expect(report.items[1].discrimination).toBeGreaterThan(0.5);
    expect(report.items[0].options.find(o => o.option === 'C')!.flags).toContain('NON_FUNCTIONING');
    expect(report.reliability).not.toBeNull();
    expect(report.studentScores[0].score).toBeCloseTo(6.67, 2);
  });
  it('summarizes scores with Vietnamese grade bands', () => {
    expect(summarizeScores([10, 8, 6.5, 5, 4, 2])).toMatchObject({ count: 6, mean: 5.92, median: 5.75, min: 2, max: 10, passRate: 66.7, bands: { EXCELLENT: 2, GOOD: 1, AVERAGE: 1, WEAK: 1, POOR: 1 } });
    expect(summarizeScores([])).toMatchObject({ count: 0, mean: 0 });
  });
});

describe('exam variants', () => {
  const questions = [options, { ...options, optionD: 'Tất cả các đáp án trên' }, { ...options, optionC: 'Cả A và B' }, options];
  it('is reproducible from the seed and never shuffles positional options', () => {
    const first = buildVariant(questions, createRng(42), { shuffleQuestions: true, shuffleOptions: true });
    expect(buildVariant(questions, createRng(42), { shuffleQuestions: true, shuffleOptions: true })).toEqual(first);
    expect(first.map(item => item.index).sort()).toEqual([0, 1, 2, 3]);
    for (const item of first) if (item.index === 1 || item.index === 2) expect(item.order).toBe('ABCD');
    expect(hasPositionalOptions(questions[0])).toBe(false);
  });
});
