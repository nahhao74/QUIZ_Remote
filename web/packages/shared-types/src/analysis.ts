import { ANSWERS, type AnswerChoice } from './answers';

export type GradeBand = 'EXCELLENT' | 'GOOD' | 'AVERAGE' | 'WEAK' | 'POOR';
/** Vietnamese 10-point grading bands. */
export const GRADE_BANDS: Array<{ band: GradeBand; label: string; min: number }> = [
  { band: 'EXCELLENT', label: 'Giỏi (≥ 8)', min: 8 }, { band: 'GOOD', label: 'Khá (6,5–7,9)', min: 6.5 },
  { band: 'AVERAGE', label: 'Trung bình (5–6,4)', min: 5 }, { band: 'WEAK', label: 'Yếu (3,5–4,9)', min: 3.5 }, { band: 'POOR', label: 'Kém (< 3,5)', min: 0 },
];
export interface ScoreSummary {
  count: number; mean: number; median: number; standardDeviation: number; min: number; max: number;
  /** Share of students scoring at least 5/10, in percent. */
  passRate: number; bands: Record<GradeBand, number>;
  /** Students per whole point 0–10 (a score of 7.5 counts in bucket 7, 10 in bucket 10). */
  histogram: number[];
}
const round = (value: number, digits = 2) => { const factor = 10 ** digits; return Math.round(value * factor) / factor; };
export const scoreOf = (correct: number, total: number) => total ? round(correct * 10 / total) : 0;
export const bandOf = (score: number): GradeBand => GRADE_BANDS.find(item => score >= item.min)!.band;
export function summarizeScores(scores: number[]): ScoreSummary {
  const bands: Record<GradeBand, number> = { EXCELLENT: 0, GOOD: 0, AVERAGE: 0, WEAK: 0, POOR: 0 };
  const histogram = Array.from({ length: 11 }, () => 0);
  if (!scores.length) return { count: 0, mean: 0, median: 0, standardDeviation: 0, min: 0, max: 0, passRate: 0, bands, histogram };
  const sorted = [...scores].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const variance = sorted.length > 1 ? sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (sorted.length - 1) : 0;
  for (const score of sorted) { bands[bandOf(score)]++; histogram[Math.min(10, Math.max(0, Math.floor(score)))]++; }
  return { count: sorted.length, mean: round(mean), median: round(median), standardDeviation: round(Math.sqrt(variance)), min: sorted[0], max: sorted[sorted.length - 1],
    passRate: round(sorted.filter(score => score >= 5).length * 100 / sorted.length, 1), bands, histogram };
}

export interface AnalysisQuestion { id: string; correctAnswer: string }
/** One student's final answers keyed by question id; missing questions count as unanswered. */
export interface AnalysisResponse { id: string; answers: Record<string, string> }
export type DistractorFlag = 'NON_FUNCTIONING' | 'ATTRACTS_UPPER' | 'MORE_POPULAR_THAN_KEY';
export interface OptionAnalysis { option: AnswerChoice; isKey: boolean; count: number; rate: number; upperRate: number; lowerRate: number; flags: DistractorFlag[] }
export type ItemFlag = 'TOO_EASY' | 'TOO_HARD' | 'NEGATIVE_DISCRIMINATION' | 'LOW_DISCRIMINATION' | 'KEY_CHECK' | 'WEAK_DISTRACTORS';
export interface ItemAnalysis {
  questionId: string; answered: number; correct: number;
  /** Difficulty index p: share of all students answering correctly (0–1). */
  difficulty: number;
  /** Upper 27% minus lower 27% correct rate (−1 to 1); null with fewer than 4 students. */
  discrimination: number | null;
  /** Correlation between this item and the rest of the test; null when undefined. */
  pointBiserial: number | null;
  level: 'EASY' | 'MEDIUM' | 'HARD';
  quality: 'GOOD' | 'FAIR' | 'POOR' | 'INSUFFICIENT';
  options: OptionAnalysis[]; flags: ItemFlag[];
}
export interface ItemAnalysisReport { participants: number; questionCount: number; reliability: number | null; scores: ScoreSummary; studentScores: Array<{ id: string; correct: number; score: number }>; items: ItemAnalysis[] }
export const ITEM_FLAG_LABELS: Record<ItemFlag, string> = {
  TOO_EASY: 'Quá dễ (trên 90% làm đúng)', TOO_HARD: 'Quá khó (dưới 20% làm đúng)',
  NEGATIVE_DISCRIMINATION: 'Phân biệt âm: nhóm giỏi làm sai nhiều hơn nhóm yếu — kiểm tra lại đáp án hoặc câu chữ',
  LOW_DISCRIMINATION: 'Độ phân biệt thấp (< 0,2)', KEY_CHECK: 'Một phương án nhiễu được chọn nhiều hơn đáp án đúng — kiểm tra lại đáp án',
  WEAK_DISTRACTORS: 'Có phương án nhiễu gần như không ai chọn',
};
export const DISTRACTOR_FLAG_LABELS: Record<DistractorFlag, string> = {
  NON_FUNCTIONING: 'Nhiễu không hiệu quả (< 5% chọn)', ATTRACTS_UPPER: 'Thu hút nhóm giỏi nhiều hơn nhóm yếu', MORE_POPULAR_THAN_KEY: 'Được chọn nhiều hơn đáp án đúng',
};
function correlation(x: number[], y: number[]) {
  const n = x.length;
  if (n < 3) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? round(sxy / Math.sqrt(sxx * syy), 3) : null;
}
/**
 * Classical test theory item analysis: difficulty, upper/lower 27% discrimination, corrected point-biserial,
 * distractor efficiency and KR-20 reliability. Multi-answer questions are scored all-or-nothing.
 */
export function analyzeItems(questions: AnalysisQuestion[], responses: AnalysisResponse[]): ItemAnalysisReport {
  const n = responses.length;
  const correctMatrix = responses.map(response => questions.map(question => response.answers[question.id] === question.correctAnswer ? 1 : 0));
  const totals = correctMatrix.map(row => row.reduce<number>((sum, value) => sum + value, 0));
  const ranked = responses.map((_, index) => index).sort((a, b) => totals[b] - totals[a]);
  const groupSize = n >= 10 ? Math.max(1, Math.round(n * 0.27)) : n >= 4 ? Math.floor(n / 2) : 0;
  const upper = ranked.slice(0, groupSize), lower = groupSize ? ranked.slice(-groupSize) : [];
  const rate = (count: number, of: number) => of ? round(count / of, 3) : 0;
  const items = questions.map((question, column): ItemAnalysis => {
    const answered = responses.filter(response => response.answers[question.id]).length;
    const correct = correctMatrix.reduce((sum, row) => sum + row[column], 0);
    const difficulty = rate(correct, n);
    const discrimination = groupSize ? round(upper.reduce((s, i) => s + correctMatrix[i][column], 0) / groupSize - lower.reduce((s, i) => s + correctMatrix[i][column], 0) / groupSize, 3) : null;
    const pointBiserial = correlation(correctMatrix.map(row => row[column]), totals.map((total, i) => total - correctMatrix[i][column]));
    const chose = (index: number, letter: AnswerChoice) => (responses[index].answers[question.id] ?? '').includes(letter);
    const keyRate = rate(responses.filter((_, i) => chose(i, question.correctAnswer[0] as AnswerChoice)).length, n);
    const options = ANSWERS.map((letter): OptionAnalysis => {
      const isKey = question.correctAnswer.includes(letter);
      const count = responses.filter((_, i) => chose(i, letter)).length;
      const upperRate = rate(upper.filter(i => chose(i, letter)).length, upper.length);
      const lowerRate = rate(lower.filter(i => chose(i, letter)).length, lower.length);
      const flags: DistractorFlag[] = [];
      if (!isKey && n >= 10 && count / n < 0.05) flags.push('NON_FUNCTIONING');
      if (!isKey && groupSize >= 2 && upperRate > lowerRate) flags.push('ATTRACTS_UPPER');
      if (!isKey && question.correctAnswer.length === 1 && n >= 5 && rate(count, n) > keyRate) flags.push('MORE_POPULAR_THAN_KEY');
      return { option: letter, isKey, count, rate: rate(count, n), upperRate, lowerRate, flags };
    });
    const flags: ItemFlag[] = [];
    if (n >= 5 && difficulty > 0.9) flags.push('TOO_EASY');
    if (n >= 5 && difficulty < 0.2) flags.push('TOO_HARD');
    if (discrimination !== null && discrimination < 0) flags.push('NEGATIVE_DISCRIMINATION');
    else if (discrimination !== null && discrimination < 0.2) flags.push('LOW_DISCRIMINATION');
    if (options.some(option => option.flags.includes('MORE_POPULAR_THAN_KEY'))) flags.push('KEY_CHECK');
    if (options.some(option => option.flags.includes('NON_FUNCTIONING'))) flags.push('WEAK_DISTRACTORS');
    const quality = n < 5 || discrimination === null ? 'INSUFFICIENT' : discrimination >= 0.3 && difficulty >= 0.2 && difficulty <= 0.9 ? 'GOOD' : discrimination < 0.2 ? 'POOR' : 'FAIR';
    return { questionId: question.id, answered, correct, difficulty, discrimination, pointBiserial, level: difficulty >= 0.7 ? 'EASY' : difficulty >= 0.3 ? 'MEDIUM' : 'HARD', quality, options, flags };
  });
  const k = questions.length;
  const meanTotal = n ? totals.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n ? totals.reduce((sum, total) => sum + (total - meanTotal) ** 2, 0) / n : 0;
  const pq = items.reduce((sum, item) => sum + item.difficulty * (1 - item.difficulty), 0);
  const reliability = k >= 2 && n >= 2 && variance > 0 ? round(k / (k - 1) * (1 - pq / variance), 3) : null;
  const studentScores = responses.map((response, i) => ({ id: response.id, correct: totals[i], score: scoreOf(totals[i], k) }));
  return { participants: n, questionCount: k, reliability, scores: summarizeScores(studentScores.map(s => s.score)), studentScores, items };
}
/** Largest-remainder rounding: integer shares of `total` proportional to `weights` that add up exactly. */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map((_, i) => (i === 0 ? total : 0));
  const raw = weights.map(weight => total * weight / sum);
  const result = raw.map(Math.floor);
  const order = raw.map((value, index) => ({ fraction: value - Math.floor(value), index })).sort((a, b) => b.fraction - a.fraction);
  for (let k = 0, rest = total - result.reduce((a, b) => a + b, 0); rest > 0; k++, rest--) result[order[k % order.length].index]++;
  return result;
}
