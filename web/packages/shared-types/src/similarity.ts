/** Lowercase, remove Vietnamese diacritics and punctuation so "Câu hỏi?" and "cau hoi" compare equal. */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function trigrams(text: string): Set<string> {
  const folded = ` ${foldText(text)} `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= folded.length; i++) grams.add(folded.slice(i, i + 3));
  return grams;
}
function dice(a: Set<string>, b: Set<string>) {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const gram of small) if (large.has(gram)) shared++;
  return 2 * shared / (a.size + b.size);
}
export const textSimilarity = (a: string, b: string) => dice(trigrams(a), trigrams(b));

export interface SimilarityItem { id: string; content: string; options: string[] }
export interface DuplicatePair { a: string; b: string; score: number; stem: number; options: number; kind: 'EXACT' | 'NEAR' | 'STEM' }
type Prepared = { id: string; stem: Set<string>; options: Set<string>[]; tokens: Set<string> };
const STOP_WORDS = new Set('la cua va cac nhung mot trong cho voi duoc nao gi khong co the nay do sau dau khi thi ma de ra vao tren duoi theo nhu hay hoac the nao bao nhieu dung sai sau day'.split(' '));
function prepare(item: SimilarityItem): Prepared {
  return { id: item.id, stem: trigrams(item.content), options: item.options.map(trigrams), tokens: new Set(foldText(item.content).split(' ').filter(token => token.length > 1 && !STOP_WORDS.has(token))) };
}
/** Options are compared as an unordered set so shuffled copies of the same question still match. */
function optionSimilarity(a: Set<string>[], b: Set<string>[]) {
  if (!a.length || !b.length) return 0;
  const best = (from: Set<string>[], to: Set<string>[]) => from.reduce((sum, option) => sum + Math.max(...to.map(other => dice(option, other))), 0) / from.length;
  return (best(a, b) + best(b, a)) / 2;
}
function compare(a: Prepared, b: Prepared) {
  const stem = dice(a.stem, b.stem);
  const options = optionSimilarity(a.options, b.options);
  return { stem, options, score: 0.7 * stem + 0.3 * options };
}
const round = (value: number) => Math.round(value * 1000) / 1000;
export function questionSimilarity(a: SimilarityItem, b: SimilarityItem) {
  const result = compare(prepare(a), prepare(b));
  return { score: round(result.score), stem: round(result.stem), options: round(result.options) };
}
function pairOf(a: Prepared, b: Prepared, threshold: number): DuplicatePair | null {
  const { stem, options, score } = compare(a, b);
  // Same stem with different options is still worth a teacher's look: it often tests the same fact twice.
  const sameStem = stem >= 0.9;
  if (score < threshold && !sameStem) return null;
  const kind = score >= 0.97 ? 'EXACT' : sameStem && options < 0.5 ? 'STEM' : 'NEAR';
  return { a: a.id, b: b.id, score: round(score), stem: round(stem), options: round(options), kind };
}
/**
 * Pairs whose combined stem/option similarity reaches the threshold, most similar first.
 * Large banks only compare questions that share uncommon words, keeping this close to linear.
 */
export function findDuplicatePairs(items: SimilarityItem[], threshold = 0.8, limit = 500): DuplicatePair[] {
  const prepared = items.map(prepare);
  const pairs: DuplicatePair[] = [];
  if (prepared.length <= 400) {
    for (let i = 0; i < prepared.length; i++) for (let j = i + 1; j < prepared.length; j++) {
      const pair = pairOf(prepared[i], prepared[j], threshold);
      if (pair) pairs.push(pair);
    }
  } else {
    const index = new Map<string, number[]>();
    prepared.forEach((item, position) => item.tokens.forEach(token => { const list = index.get(token); if (list) list.push(position); else index.set(token, [position]); }));
    const common = Math.max(50, prepared.length * 0.2);
    prepared.forEach((item, position) => {
      const shared = new Map<number, number>();
      for (const token of item.tokens) {
        const list = index.get(token)!;
        if (list.length > common) continue;
        for (const other of list) if (other > position) shared.set(other, (shared.get(other) ?? 0) + 1);
      }
      const needed = Math.max(1, Math.min(3, Math.floor(item.tokens.size / 3)));
      for (const [other, count] of shared) if (count >= needed) {
        const pair = pairOf(item, prepared[other], threshold);
        if (pair) pairs.push(pair);
      }
    });
  }
  return pairs.sort((x, y) => y.score - x.score).slice(0, limit);
}
/** Prepares candidates once; the returned function finds the most similar one for "may duplicate" hints. */
export function similarityMatcher(candidates: SimilarityItem[]) {
  const prepared = candidates.map(prepare);
  return (item: SimilarityItem, threshold = 0.75): { id: string; score: number } | null => {
    const target = prepare(item);
    let best: { id: string; score: number } | null = null;
    for (const candidate of prepared) {
      if (candidate.id === item.id) continue;
      const { score, stem } = compare(target, candidate);
      const effective = stem >= 0.9 ? Math.max(score, stem) : score;
      if (effective >= threshold && (!best || effective > best.score)) best = { id: candidate.id, score: effective };
    }
    return best && { id: best.id, score: round(best.score) };
  };
}
/** Every word of the query must appear, ignoring case, accents and punctuation. */
export function matchesSearch(text: string, query: string) {
  const haystack = ` ${foldText(text)} `;
  return foldText(query).split(' ').filter(Boolean).every(word => haystack.includes(word));
}
