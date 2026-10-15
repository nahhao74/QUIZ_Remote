import { useId } from 'react';
import { AlertTriangle, Check, Clock3, ListChecks, CircleDot } from 'lucide-react';
import { ANSWERS, answerLetters, DIFFICULTY_LABELS, MISSING_KEY_ISSUE, QUESTION_LIMITS, toAnswerKey, type AnswerChoice, type Difficulty, type QuestionDraft, type QuestionType } from '@classpulse/shared-types';

export type EditableQuestion = Omit<QuestionDraft, 'order' | 'durationSeconds'> & { durationSeconds?: number };
/** Content, options with the correct-answer picker (radio for one answer, checkboxes for several) and metadata. */
export function QuestionFields<T extends EditableQuestion>({ value, onChange, label, showDuration = true }: { value: T; onChange: (patch: Partial<T>) => void; label: string; showDuration?: boolean }) {
  const id = useId();
  const type: QuestionType = value.type ?? 'SINGLE';
  const chosen = new Set(answerLetters(value.correctAnswer));
  const toggle = (letter: AnswerChoice) => {
    if (type === 'SINGLE') return onChange({ correctAnswer: letter } as Partial<T>);
    if (chosen.has(letter)) chosen.delete(letter); else chosen.add(letter);
    onChange({ correctAnswer: toAnswerKey(chosen) ?? '' } as Partial<T>);
  };
  const setType = (next: QuestionType) => onChange({ type: next, correctAnswer: next === 'SINGLE' ? value.correctAnswer.slice(0, 1) : value.correctAnswer } as Partial<T>);
  const hasMeta = !!(value.explanation || value.knowledge || value.topic || value.difficulty);
  return <>
    <label>Nội dung câu hỏi<textarea required rows={3} maxLength={QUESTION_LIMITS.content} value={value.content} onChange={e => onChange({ content: e.target.value } as Partial<T>)} placeholder="Điều gì bạn muốn hỏi lớp học?"/></label>
    <div className="question-type-row">
      <div className="segmented" role="radiogroup" aria-label={`Loại câu hỏi ${label}`}>
        <button type="button" role="radio" aria-checked={type === 'SINGLE'} className={type === 'SINGLE' ? 'segmented-active' : ''} onClick={() => setType('SINGLE')}><CircleDot size={14}/>Một đáp án</button>
        <button type="button" role="radio" aria-checked={type === 'MULTIPLE'} className={type === 'MULTIPLE' ? 'segmented-active' : ''} onClick={() => setType('MULTIPLE')}><ListChecks size={14}/>Nhiều đáp án</button>
      </div>
      <span className="muted">{type === 'SINGLE' ? 'Chọn nút tròn của phương án đúng.' : 'Đánh dấu mọi phương án đúng; sinh viên phải chọn đủ mới được tính điểm.'}</span>
    </div>
    <div className="edit-options">{ANSWERS.map(letter => {
      const checked = chosen.has(letter);
      return <label key={letter} className={`edit-option ${checked ? 'edit-option-correct' : ''}`}>
        <input type={type === 'SINGLE' ? 'radio' : 'checkbox'} name={`correct-${id}`} checked={checked} onChange={() => toggle(letter)} aria-label={`Đặt ${letter} là đáp án đúng cho ${label}`}/>
        <span>{letter}</span>
        <input aria-label={`Phương án ${letter} ${label}`} required maxLength={QUESTION_LIMITS.option} placeholder={`Nhập phương án ${letter}`} value={value[`option${letter}`]} onChange={e => onChange({ [`option${letter}`]: e.target.value } as Partial<T>)}/>
        {checked && <Check size={17}/>}
      </label>;
    })}</div>
    {!value.correctAnswer && <p className="field-warning"><AlertTriangle size={14}/>{MISSING_KEY_ISSUE}</p>}
    <details className="question-meta" open={hasMeta}>
      <summary>Lời giải, kiến thức kiểm tra và độ khó</summary>
      <div className="meta-grid">
        <label>Độ khó<select value={value.difficulty ?? ''} onChange={e => onChange({ difficulty: (e.target.value || null) as Difficulty | null } as Partial<T>)}><option value="">Chưa phân loại</option>{(Object.keys(DIFFICULTY_LABELS) as Difficulty[]).map(level => <option key={level} value={level}>{DIFFICULTY_LABELS[level]}</option>)}</select></label>
        <label>Chủ đề / chương<input maxLength={QUESTION_LIMITS.topic} value={value.topic ?? ''} onChange={e => onChange({ topic: e.target.value } as Partial<T>)} placeholder="Ví dụ: Chương 2 – MQTT"/></label>
        <label>Kiến thức được kiểm tra<input maxLength={QUESTION_LIMITS.knowledge} value={value.knowledge ?? ''} onChange={e => onChange({ knowledge: e.target.value } as Partial<T>)} placeholder="Ví dụ: Mô hình publish/subscribe"/></label>
        {showDuration && <label><span className="inline-label"><Clock3 size={14}/>Thời gian (giây)</span><input type="number" required min={QUESTION_LIMITS.minDuration} max={QUESTION_LIMITS.maxDuration} value={value.durationSeconds ?? 30} onChange={e => onChange({ durationSeconds: Number(e.target.value) } as Partial<T>)}/></label>}
      </div>
      <label>Lời giải<textarea rows={3} maxLength={QUESTION_LIMITS.explanation} value={value.explanation ?? ''} onChange={e => onChange({ explanation: e.target.value } as Partial<T>)} placeholder="Giải thích vì sao đáp án đúng và các phương án nhiễu sai. Hiển thị cho lớp sau khi đóng câu."/></label>
    </details>
  </>;
}
export function DifficultyBadge({ value }: { value: Difficulty | null | undefined }) {
  return value ? <span className={`tag tag-${value.toLowerCase()}`}>{DIFFICULTY_LABELS[value]}</span> : null;
}
export function TypeBadge({ value }: { value: QuestionType | undefined }) {
  return value === 'MULTIPLE' ? <span className="tag tag-multiple"><ListChecks size={12}/>Nhiều đáp án</span> : null;
}
