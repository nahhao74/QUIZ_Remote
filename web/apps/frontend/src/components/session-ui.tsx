import { Check, Clock3, Lightbulb, ListChecks, Users } from 'lucide-react';
import { ANSWERS, type AnswerChoice, type QuestionStats, type QuestionType, type SessionSnapshot } from '@classpulse/shared-types';
import { useServerCountdown } from '../hooks';
export function Countdown({ session }: { session: SessionSnapshot }) {
  const left = useServerCountdown(session.questionEndsAt, session.serverTime);
  return <span className={`countdown ${left !== null && left <= 5 ? 'countdown-urgent' : ''}`} aria-label="Thời gian còn lại"><Clock3 size={20}/>{session.status === 'QUESTION_ACTIVE' && left !== null ? `${Math.floor(left / 60).toString().padStart(2, '0')}:${(left % 60).toString().padStart(2, '0')}` : '—:—'}</span>;
}
type Displayable = Record<`option${AnswerChoice}`, string> & { type?: QuestionType; correctAnswer?: string; explanation?: string };
/** Options A–D. Every letter of the key is highlighted once revealed; multi-answer questions say so up front. */
export function Options({ question, reveal = false, explain = false }: { question: Displayable; reveal?: boolean; explain?: boolean }) {
  const key = question.correctAnswer ?? '';
  return <>
    {question.type === 'MULTIPLE' && <div className="multi-answer-hint"><ListChecks size={15}/>Câu hỏi nhiều đáp án — chọn tất cả phương án đúng</div>}
    <div className="answer-options">{ANSWERS.map(answer => {
      const correct = reveal && key.includes(answer);
      return <div key={answer} className={`answer-option option-${answer.toLowerCase()} ${correct ? 'answer-correct' : ''}`}><span className="answer-letter">{answer}</span><span>{question[`option${answer}`]}</span>{correct && <Check size={22} aria-label="Đáp án đúng"/>}</div>;
    })}</div>
    {explain && reveal && question.explanation && <div className="explanation-box"><Lightbulb size={17}/><div><strong>Lời giải</strong><p>{question.explanation}</p></div></div>}
  </>;
}
export function ResultsChart({ stats, correctAnswer, reveal = false, multiple = false }: { stats: QuestionStats; correctAnswer?: string; reveal?: boolean; multiple?: boolean }) {
  return <div className="results-chart"><div className="chart-columns">{ANSWERS.map(answer => <div className={`chart-column chart-${answer.toLowerCase()}`} key={answer}><strong>{stats.percentages[answer] || 0}<small>%</small></strong><div className="chart-track"><div className="chart-bar" style={{ height: `${Math.max(2, Math.min(100, stats.percentages[answer] || 0))}%` }}/></div><span className="chart-label">{answer}{reveal && correctAnswer?.includes(answer) && <Check size={14}/>}</span><small>{stats.counts[answer]} lượt chọn</small></div>)}</div><div className="chart-footer"><span><Users size={15}/>{stats.answered} / {stats.total} đã trả lời</span><span>{stats.unanswered} chưa trả lời</span></div>{multiple && <p className="chart-note">Mỗi sinh viên có thể chọn nhiều phương án nên tổng tỷ lệ có thể vượt 100%. Chỉ tính đúng khi chọn đủ và đúng tất cả đáp án.</p>}{reveal && <div className="correct-summary"><span><i/>{stats.correct} đúng <b>{stats.correctPercentage}%</b></span><span><i/>{stats.incorrect} sai <b>{stats.incorrectPercentage}%</b></span></div>}</div>;
}
