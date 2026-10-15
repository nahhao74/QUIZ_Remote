import { ANSWERS, toAnswerKey, type AnswerChoice, type AnswerKey, type QuestionType } from './answers';
import { QUESTION_LIMITS, questionIssues, type Difficulty, type QuestionDraft } from './question';

export type MarkKind = 'underline' | 'bold' | 'color' | 'highlight';
export interface TextMark { start: number; end: number; kind: MarkKind }
/** One logical line of an imported document. Word files add formatting marks, heading levels and list numbering. */
export interface ImportLine { text: string; marks?: TextMark[]; heading?: number; numbered?: boolean; page?: number }
export interface ParsedQuestions { title: string; description: string; questions: QuestionDraft[]; warnings: string[] }
export interface ParseOptions { filename?: string; defaultDuration?: number; maxQuestions?: number }

/** Regex source matching a Vietnamese phrase with or without diacritics, e.g. "đáp án" also matches "dap an". */
function fuzzy(phrase: string) {
  return [...phrase.normalize('NFC')].map(char => {
    if (char === ' ') return '\\s*';
    if (char === 'đ') return '[đd]';
    const base = char.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return base !== char ? `[${char}${base}]` : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
}
const words = (...phrases: string[]) => `(?:${phrases.map(fuzzy).join('|')})`;
const pattern = (source: string) => new RegExp(source, 'i');

const QUESTION_START = pattern(`^${words('câu hỏi', 'câu', 'question', 'q')}\\s*(\\d{1,4})\\s*(?:\\(([^)]{0,40})\\))?\\s*[:.)\\-–]?\\s*(.*)$`);
const BARE_NUMBER = /^(\d{1,4})\s*[.)]\s+(.+)$/;
const LETTERS = '([A-D](?:\\s*(?:,|;|&|\\+|\\/|và|and|\\s)\\s*[A-D])*)';
const ANSWER_LINE = pattern(`^${words('đáp án đúng', 'đáp án', 'đa', 'answer', 'key', 'chọn')}\\s*(?:${words('là')})?\\s*[:.\\-–]?\\s*\\(?${LETTERS}\\)?\\s*(?:[.:\\-–)]\\s*(.*))?$`);
const ANSWER_HEADING = pattern(`^(?:${words('bảng')}\\s+)?${words('đáp án', 'answer key', 'answers', 'hướng dẫn chấm', 'hướng dẫn giải', 'lời giải')}(?:\\s+${words('đúng', 'tham khảo', 'chi tiết', 'trắc nghiệm', 'và hướng dẫn giải', 'phần trắc nghiệm')})?\\s*:?\\s*$`);
const EXPLANATION_LINE = pattern(`^${words('lời giải chi tiết', 'lời giải', 'giải thích', 'hướng dẫn giải', 'hướng dẫn', 'explanation', 'solution')}\\s*[:\\-–]\\s*(.*)$`);
const KNOWLEDGE_LINE = pattern(`^${words('kiến thức kiểm tra', 'kiến thức', 'knowledge', 'mục tiêu', 'yêu cầu cần đạt')}\\s*[:\\-–]\\s*(.*)$`);
const TOPIC_LINE = pattern(`^${words('chủ đề', 'topic', 'chương', 'chapter', 'bài học')}\\s*[:\\-–]\\s*(.+)$`);
const DIFFICULTY_LINE = pattern(`^${words('độ khó', 'mức độ', 'cấp độ', 'difficulty', 'level')}\\s*[:\\-–]\\s*(.+)$`);
const TYPE_LINE = pattern(`^${words('loại câu', 'loại', 'kiểu', 'type')}\\s*[:\\-–]\\s*(.+)$`);
const TIME_LINE = pattern(`^${words('thời gian', 'time', 'duration')}\\s*[:\\-–]\\s*(\\d+)\\s*(${words('giây', 'phút')}|s|sec|seconds?|p|min|minutes?)?\\.?\\s*$`);
const TITLE_LINE = pattern(`^${words('tiêu đề', 'title', 'tên đề', 'tên bộ câu hỏi')}\\s*:\\s*(.+)$`);
const DESCRIPTION_LINE = pattern(`^${words('mô tả', 'description')}\\s*:\\s*(.*)$`);
const SECTION_HEADING = pattern(`^${words('chương', 'phần', 'chapter', 'part', 'chủ đề', 'unit', 'module')}\\s+(\\d+|[IVXLCDM]+)(?=$|[\\s.:\\-–)])`);
const DIFFICULTY_TAG = /^[[(]\s*(NB|TH|VDC|VD|Dễ|De|TB|Khó|Kho)\s*[\])]\s*/i;
const OPTION_LABEL = /(^|\s)(\*?)(\(?)([A-Fa-f])(\)|[.:]|\s*[-–](?=\s))(\*?)/g;
const TABLE_PAIR = /(\d{1,3})\s*[.:\-–)]?\s*([A-D](?:\s*[,&+]\s*[A-D])*)(?![\p{L}\d])/giu;
const TABLE_NUMBERS = pattern(`^(?:${words('câu', 'question')})?[\\s|:]*(?:\\d{1,3}[\\s|,;]+)+\\d{1,3}[\\s|]*$`);
const TABLE_LETTERS_PREFIX = pattern(`^${words('đáp án', 'đa', 'key')}[\\s|:]*`);
const TABLE_LETTERS = /^[\s|]*(?:[A-D]{1,4}[\s|,;]+)*[A-D]{1,4}[\s|]*$/i;
const TABLE_ENTRY = /^(?:chọn|đáp án|dap an|đa)?\s*:?\s*\(?([A-D](?:\s*(?:,|và|&)\s*[A-D])*)\)?(?=$|[\s.:,;)\-–])\s*[.:,;)\-–]?\s*(.*)$/i;

/** Accepts Vietnamese levels (nhận biết/thông hiểu/vận dụng), dễ/trung bình/khó and English names. */
export function parseDifficulty(value: string): Difficulty | null {
  const v = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().trim();
  if (/^(de|easy|nhan biet|nb|biet|muc 1)\b/.test(v)) return 'EASY';
  if (/^(trung binh|tb|medium|thong hieu|th|hieu|muc 2)\b/.test(v)) return 'MEDIUM';
  if (/^(kho|hard|van dung|vd|vdc|muc 3)\b/.test(v)) return 'HARD';
  return null;
}
const letterKey = (text: string) => toAnswerKey(text.match(/[A-D]/gi) ?? []);
function isSectionHeading(text: string) {
  const match = SECTION_HEADING.exec(text);
  return !!match && /^(\d+|[IVXLCDM]+)$/.test(match[1]) && text.length <= 160;
}
type Kinds = Set<MarkKind>;
type Option = { letter: string; lower: boolean; value: string; starred: boolean; kinds: Kinds };

/** Options on one line ("A. 2   B. 3   C. 4   D. 5"); null unless the line starts with a label. */
function splitOptions(text: string, marks: TextMark[]): Option[] | null {
  const found = [...text.matchAll(OPTION_LABEL)].map(m => {
    const at = m.index! + m[1].length;
    return { letter: m[4].toUpperCase(), lower: m[4] !== m[4].toUpperCase(), at, letterAt: at + m[2].length + m[3].length, end: m.index! + m[0].length, starred: !!(m[2] || m[6]) };
  });
  if (!found.length || found[0].at !== 0) return null;
  const run = [found[0]];
  for (const label of found.slice(1)) {
    const previous = run[run.length - 1];
    if (label.lower === previous.lower && label.letter.charCodeAt(0) === previous.letter.charCodeAt(0) + 1) run.push(label);
  }
  return run.map((label, i) => {
    const end = i + 1 < run.length ? run[i + 1].at : text.length;
    const value = text.slice(label.end, end).trim().replace(/\s*;$/, '');
    const kinds: Kinds = new Set();
    for (const kind of ['underline', 'bold', 'color', 'highlight'] as MarkKind[]) {
      const relevant = marks.filter(mark => mark.kind === kind);
      if (!relevant.length) continue;
      const covered = (position: number) => relevant.some(mark => mark.start <= position && position < mark.end);
      let chars = 0, hit = 0;
      for (let p = label.end; p < end; p++) if (text[p].trim()) { chars++; if (covered(p)) hit++; }
      if (covered(label.letterAt) || (chars && hit / chars >= 0.6)) kinds.add(kind);
    }
    return { letter: label.letter, lower: label.lower, value, starred: label.starred, kinds };
  });
}
/** "Câu 1: 2 + 2 = ? A. 3 B. 4 C. 5 D. 6" keeps the stem and returns the trailing options. */
function splitInlineOptions(text: string, marks: TextMark[]): { stem: string; options: Option[] } | null {
  for (const match of text.matchAll(/(?:^|\s)(?=\*?\(?A(?:\)|[.:]))/g)) {
    const at = match.index! + match[0].length;
    if (at === 0) continue;
    const options = splitOptions(text.slice(at), marks.map(mark => ({ ...mark, start: mark.start - at, end: mark.end - at })));
    if (options && options.length >= 2 && !options[0].lower) return { stem: text.slice(0, at).trim(), options };
  }
  return null;
}

type Draft = {
  number: number | null; line: number; content: string[];
  options: Partial<Record<AnswerChoice, string>>; kinds: Partial<Record<AnswerChoice, Kinds>>; starred: Set<AnswerChoice>;
  /** Lowercase a)–d) items stay provisional: uppercase options later turn them, and `afterLower`, back into the stem. */
  lowerOptions: boolean; afterLower: string[];
  last: AnswerChoice | null; key: AnswerKey | null; type: QuestionType | null; explanation: string[];
  mode: 'content' | 'options' | 'explanation'; knowledge: string; topic: string; difficulty: Difficulty | null; duration: number | null; notes: string[];
};
const optionCount = (draft: Draft) => ANSWERS.filter(letter => draft.options[letter] !== undefined).length;
const MARK_LABELS: Record<MarkKind, string> = { color: 'màu chữ', underline: 'gạch chân', highlight: 'tô nền', bold: 'in đậm' };

/**
 * Lenient question reader shared by TXT, Word and PDF imports. Problems become warnings instead of
 * errors, and questions missing data are still returned so the teacher can fix them in the editor.
 */
export function parseQuestionLines(lines: ImportLine[], options: ParseOptions = {}): ParsedQuestions {
  const maxQuestions = options.maxQuestions ?? QUESTION_LIMITS.questionsPerQuiz;
  const defaultDuration = options.defaultDuration ?? 30;
  const warnings: string[] = [];
  const drafts: Draft[] = [];
  const answerTable: Array<{ number: number; key: AnswerKey | null; explanation: string }> = [];
  let title = '', description = '', topic = '';
  let current: Draft | null = null;
  let pendingStem: string[] = [];
  let inTable = false, tableNumbers: number[] = [];
  let truncated = false, ignoredOptions = false;
  // Documents numbering questions with "Câu N" never start questions from bare "1." lines or unlabeled stems.
  const usesMarkers = lines.filter(item => QUESTION_START.test(item.text.trim())).length >= 2;

  const finish = () => {
    if (!current) return;
    if (current.afterLower.length && current.last) current.options[current.last] = [current.options[current.last], ...current.afterLower].join(' ').trim();
    drafts.push(current);
    current = null;
  };
  const addOptions = (draft: Draft, parsed: Option[]) => {
    const lower = parsed[0].lower;
    // Lowercase a) b) c) statements followed by uppercase options belong to the question stem.
    if (!lower && draft.lowerOptions && optionCount(draft)) {
      draft.content.push(...ANSWERS.filter(l => draft.options[l] !== undefined).map(l => `${l.toLowerCase()}) ${draft.options[l]}`), ...draft.afterLower);
      draft.options = {}; draft.kinds = {}; draft.starred.clear();
    }
    draft.afterLower = [];
    draft.lowerOptions = lower;
    for (const option of parsed) {
      if (!(ANSWERS as readonly string[]).includes(option.letter)) { ignoredOptions = true; continue; }
      const letter = option.letter as AnswerChoice;
      draft.options[letter] = option.value;
      draft.kinds[letter] = option.kinds;
      if (option.starred) draft.starred.add(letter);
      draft.last = letter;
    }
    draft.mode = 'options';
  };
  const start = (lineNo: number, number: number | null, firstLine: string, marks: TextMark[] = [], tag?: string): Draft | null => {
    finish();
    pendingStem = [];
    if (drafts.length >= maxQuestions) { truncated = true; return null; }
    let content = firstLine;
    let difficulty: Difficulty | null = tag ? parseDifficulty(tag) : null;
    const tagged = DIFFICULTY_TAG.exec(content);
    const shift = tagged ? tagged[0].length : 0;
    if (tagged) { difficulty = parseDifficulty(tagged[1]); content = content.slice(shift); }
    const inline = splitInlineOptions(content, marks.map(mark => ({ ...mark, start: mark.start - shift, end: mark.end - shift })));
    const draft: Draft = { number, line: lineNo, content: [], options: {}, kinds: {}, starred: new Set(), lowerOptions: false, afterLower: [], last: null, key: null, type: null,
      explanation: [], mode: 'content', knowledge: '', topic, difficulty, duration: null, notes: [] };
    const stem = inline ? inline.stem : content;
    if (stem) draft.content.push(stem);
    if (inline) addOptions(draft, inline.options);
    current = draft;
    return draft;
  };
  const tableLine = (text: string) => {
    if (ANSWER_HEADING.test(text)) return;
    const question = QUESTION_START.exec(text);
    // A bare "Câu 3" row heads a one-column key table whose letters follow on the next row.
    if (question && !question[3].trim()) { tableNumbers = [Number(question[1])]; return; }
    if (question) {
      const entry = TABLE_ENTRY.exec(question[3].trim());
      answerTable.push({ number: Number(question[1]), key: entry ? letterKey(entry[1]) : null, explanation: (entry ? entry[2] : question[3]).trim() });
      return;
    }
    if (TABLE_NUMBERS.test(text)) { tableNumbers = text.match(/\d{1,3}/g)!.map(Number); return; }
    const letters = text.replace(TABLE_LETTERS_PREFIX, '');
    if (TABLE_LETTERS.test(letters)) {
      const keys = letters.match(/[A-D]{1,4}/gi) ?? [];
      if (tableNumbers.length) keys.forEach((key, i) => { if (tableNumbers[i] !== undefined) answerTable.push({ number: tableNumbers[i], key: letterKey(key), explanation: '' }); });
      else if (!answerTable.length && keys.length === 1 && drafts.length && !drafts[drafts.length - 1].key) drafts[drafts.length - 1].key = letterKey(keys[0]);
      tableNumbers = [];
      return;
    }
    const pairs = [...text.matchAll(TABLE_PAIR)];
    if (pairs.length) { for (const pair of pairs) answerTable.push({ number: Number(pair[1]), key: letterKey(pair[2]), explanation: '' }); return; }
    const last = answerTable[answerTable.length - 1];
    if (last) last.explanation = `${last.explanation}\n${text}`.trim();
  };

  lines.forEach((source, index) => {
    const lineNo = index + 1;
    const raw = source.text.replace(/^\uFEFF/, '');
    const text = raw.trim();
    if (!text) { if (!current) pendingStem = []; return; }
    if (/^(#|\/\/)/.test(text)) return;
    const lead = raw.length - raw.trimStart().length;
    const marks = (source.marks ?? []).map(mark => ({ ...mark, start: mark.start - lead, end: mark.end - lead }));
    const question = QUESTION_START.exec(text);
    if (inTable) {
      // A question numbered after the existing ones means the key section only covered an earlier part.
      if (!(question && answerTable.length && Number(question[1]) > drafts.length)) { tableLine(text); return; }
      inTable = false;
    }
    if (!current && !drafts.length) {
      const titleMatch = TITLE_LINE.exec(text);
      if (titleMatch) { title = titleMatch[1].trim(); return; }
      const descriptionMatch = DESCRIPTION_LINE.exec(text);
      if (descriptionMatch) { description = descriptionMatch[1].trim(); return; }
    }
    if (ANSWER_HEADING.test(text)) {
      const explains = /gi[ảa]i/i.test(text) && !/ch[ấa]m|b[ảa]ng/i.test(text);
      if (explains && current && optionCount(current) >= 2 && !current.explanation.length) { current.mode = 'explanation'; return; }
      finish(); inTable = true; tableNumbers = [];
      return;
    }
    if (question) { start(lineNo, Number(question[1]), question[3].trim(), marks.map(mark => ({ ...mark, start: mark.start - (text.length - question[3].length), end: mark.end - (text.length - question[3].length) })), question[2]); return; }
    const parsedOptions = splitOptions(text, marks);
    const expectedNumber = (current?.number ?? drafts[drafts.length - 1]?.number ?? 0) + 1;
    const bare = usesMarkers || parsedOptions ? null : BARE_NUMBER.exec(text);
    if (bare && Number(bare[1]) === expectedNumber && (!current || optionCount(current) >= 2)) { start(lineNo, Number(bare[1]), bare[2].trim()); return; }
    const isHeading = (source.heading !== undefined && source.heading <= 2) || isSectionHeading(text);
    if (isHeading && !parsedOptions && (!current || optionCount(current) >= 2) && !ANSWER_LINE.test(text)) { finish(); topic = text.slice(0, QUESTION_LIMITS.topic); pendingStem = []; return; }
    if (!current) {
      if (parsedOptions && pendingStem.length && parsedOptions[0].letter === 'A') { const draft = start(lineNo, null, pendingStem.join('\n')); if (draft) addOptions(draft, parsedOptions); return; }
      if (source.numbered && !parsedOptions) { start(lineNo, null, text); return; }
      pendingStem.push(text);
      return;
    }
    const draft: Draft = current;
    const answer = ANSWER_LINE.exec(text);
    if (answer && optionCount(draft) >= 2) {
      draft.key = letterKey(answer[1]);
      if (answer[2]?.trim()) draft.explanation.push(answer[2].trim());
      draft.mode = 'explanation';
      return;
    }
    const explanation = EXPLANATION_LINE.exec(text);
    if (explanation && optionCount(draft) >= 2) { draft.mode = 'explanation'; if (explanation[1].trim()) draft.explanation.push(explanation[1].trim()); return; }
    const knowledge = KNOWLEDGE_LINE.exec(text);
    if (knowledge) { draft.knowledge = knowledge[1].trim(); return; }
    const topicLine = TOPIC_LINE.exec(text);
    if (topicLine && optionCount(draft) >= 2) { draft.topic = topicLine[1].trim(); return; }
    const difficulty = DIFFICULTY_LINE.exec(text);
    if (difficulty && parseDifficulty(difficulty[1])) { draft.difficulty = parseDifficulty(difficulty[1]); return; }
    const type = TYPE_LINE.exec(text);
    if (type) { draft.type = /nhi[eềê]u|multi/i.test(type[1]) ? 'MULTIPLE' : 'SINGLE'; return; }
    const time = TIME_LINE.exec(text);
    if (time) { draft.duration = Number(time[1]) * (time[2] && /^(ph|p$|min)/i.test(time[2]) ? 60 : 1); return; }
    if (parsedOptions && draft.mode !== 'explanation') { addOptions(draft, parsedOptions); return; }
    if (parsedOptions && parsedOptions[0].letter === 'A' && !usesMarkers) {
      // Unnumbered documents: the line before a new "A." option is the next question's stem.
      const stem = draft.explanation.pop() ?? '';
      const next = start(lineNo, null, stem);
      if (next) addOptions(next, parsedOptions);
      return;
    }
    if (source.numbered && optionCount(draft) >= 2 && draft.mode !== 'explanation') { start(lineNo, null, text); return; }
    if (draft.mode === 'content') draft.content.push(text);
    else if (draft.mode === 'explanation') draft.explanation.push(text);
    else if (!usesMarkers && optionCount(draft) === 4) { finish(); pendingStem = [text]; }
    else if (draft.lowerOptions) draft.afterLower.push(text);
    else if (draft.last) draft.options[draft.last] = `${draft.options[draft.last]} ${text}`.trim();
  });
  finish();

  // Answer keys listed at the end of the document map to printed question numbers, falling back to order.
  for (const entry of answerTable) {
    const draft = drafts.find(item => item.number === entry.number && !item.key) ?? drafts.find(item => item.number === entry.number)
      ?? (drafts.every(item => item.number === null) ? drafts[entry.number - 1] : undefined);
    if (!draft) { warnings.push(`Bảng đáp án có câu ${entry.number} nhưng không tìm thấy câu hỏi tương ứng.`); continue; }
    if (entry.key && !draft.key) draft.key = entry.key;
    if (entry.explanation) draft.explanation.push(entry.explanation);
  }
  const questions = drafts.map((draft, order): QuestionDraft => {
    let key = draft.key;
    if (!key && draft.starred.size) key = toAnswerKey(draft.starred);
    if (!key) {
      const present = ANSWERS.filter(letter => draft.options[letter] !== undefined);
      for (const kind of ['color', 'underline', 'highlight', 'bold'] as MarkKind[]) {
        const flagged = present.filter(letter => draft.kinds[letter]?.has(kind));
        if (flagged.length && flagged.length < present.length) { key = toAnswerKey(flagged); draft.notes.push(`đáp án được nhận dạng từ định dạng ${MARK_LABELS[kind]}, hãy kiểm tra lại`); break; }
      }
    }
    const type: QuestionType = draft.type ?? (key && key.length > 1 ? 'MULTIPLE' : 'SINGLE');
    return {
      content: draft.content.join('\n').trim(),
      optionA: draft.options.A ?? '', optionB: draft.options.B ?? '', optionC: draft.options.C ?? '', optionD: draft.options.D ?? '',
      type, correctAnswer: key ?? '', explanation: draft.explanation.join('\n').trim(), knowledge: draft.knowledge, topic: draft.topic, difficulty: draft.difficulty,
      origin: 'IMPORT', durationSeconds: draft.duration ?? defaultDuration, order,
    };
  });
  questions.forEach((question, i) => {
    const notes = [...drafts[i].notes, ...questionIssues(question).map(issue => issue.replace(/\.$/, '').replace(/^./, c => c.toLowerCase()))];
    if (notes.length) warnings.push(`Câu ${i + 1} (dòng ${drafts[i].line}): ${notes.join('; ')}.`);
  });
  if (truncated) warnings.unshift(`Chỉ nhập ${maxQuestions} câu đầu tiên; các câu còn lại đã bị bỏ qua.`);
  if (ignoredOptions) warnings.unshift('Có phương án E/F: thiết bị chỉ hỗ trợ A–D nên các phương án này đã bị bỏ qua.');
  const fallbackTitle = (options.filename ?? '').replace(/\.[^.]+$/, '').trim() || 'Bộ câu hỏi nhập từ file';
  return { title: (title || fallbackTitle).slice(0, 200), description: description.slice(0, 4000), questions, warnings };
}
export function parseQuestionText(text: string, options: ParseOptions = {}): ParsedQuestions {
  return parseQuestionLines(text.replace(/^\uFEFF/, '').normalize('NFC').split(/\r\n?|\n/).map(value => ({ text: value })), options);
}

export const QUESTION_TEXT_SAMPLE = `Tiêu đề: Kiểm tra kiến thức IoT
Mô tả: Bộ câu hỏi mẫu — có thể nhập từ TXT, Word hoặc PDF theo cùng định dạng

Chương 1: Giao thức truyền thông

Câu 1: MQTT hoạt động theo mô hình nào?
A. Client - server trực tiếp
B. Publish - subscribe
C. Peer to peer
D. Chỉ dùng HTTP
Đáp án: B
Giải thích: Thiết bị publish lên broker, các client subscribe topic để nhận dữ liệu.
Độ khó: Dễ
Thời gian: 30

Câu 2: Những công nghệ nào ESP32 hỗ trợ sẵn? (chọn nhiều đáp án)
A. Wi-Fi
B. Bluetooth Low Energy
C. 5G
D. Ethernet quang
Đáp án: A, B
Kiến thức: Khả năng kết nối không dây của ESP32
Độ khó: Trung bình
Thời gian: 45

Câu 3: BLE phù hợp nhất với mục tiêu nào?
A. Truyền video 4K   B. Kết nối vệ tinh   C. Tiêu thụ năng lượng thấp   D. Lưu dữ liệu quan hệ

BẢNG ĐÁP ÁN
3C
`;
