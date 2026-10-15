import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertOctagon, AlertTriangle, ArrowLeft, CheckCircle2, ClipboardCheck, Info, Pencil, RefreshCw, Sparkles } from 'lucide-react';
import { ANSWERS, DIFFICULTY_LABELS, QUALITY_CATEGORY_LABELS, SEVERITY_LABELS, type AiJob, type AiQuizReview, type AiStatus, type QualityIssue, type Quiz, type QuizQualityReport, type Severity } from '@classpulse/shared-types';
import { api, json } from '../api';
import { useAiJob, useResource } from '../hooks';
import { Empty, ErrorNotice, Loading, PageHeading, messageOf } from '../components/ui';
import { Options } from '../components/session-ui';
import { ItemAnalysisTable, ScoreCards } from '../components/analysis';
import { DifficultyBadge, TypeBadge } from '../components/question-form';
import { AiSetupNotice, JobProgress } from './ai';

const SEVERITY_ICON: Record<Severity, typeof AlertOctagon> = { HIGH: AlertOctagon, MEDIUM: AlertTriangle, LOW: Info };
const DISTRACTOR_LABELS = { GOOD: 'Tốt', WEAK: 'Yếu', IMPLAUSIBLE: 'Vô lý', POSSIBLY_CORRECT: 'Có thể cũng đúng' } as const;
function IssueList({ issues }: { issues: QualityIssue[] }) {
  return <ul className="issue-list">{issues.map((issue, i) => { const Icon = SEVERITY_ICON[issue.severity]; return <li key={i} className={`issue issue-${issue.severity.toLowerCase()}`}>
    <Icon size={15}/><div><span className="issue-meta"><b>{QUALITY_CATEGORY_LABELS[issue.category]}</b> · {SEVERITY_LABELS[issue.severity]} · {issue.source === 'AI' ? 'AI' : 'Kiểm tra tự động'}</span><p>{issue.message}</p>{issue.suggestion && <p className="issue-suggestion">Gợi ý: {issue.suggestion}</p>}</div>
  </li>; })}</ul>;
}
function Distribution({ title, entries }: { title: string; entries: Array<[string, number]> }) {
  const total = entries.reduce((sum, [, value]) => sum + value, 0) || 1;
  return <div className="distribution"><h3>{title}</h3>{entries.map(([label, value]) => <div key={label} className="distribution-row"><span>{label}</span><div className="mini-meter"><span style={{ width: `${value * 100 / total}%` }}/></div><b>{value}</b></div>)}</div>;
}

export function QuizQualityPage() {
  const { id = '' } = useParams();
  const report = useResource<QuizQualityReport>(`/quizzes/${id}/quality`);
  const quiz = useResource<Quiz>(`/quizzes/${id}`);
  const status = useResource<AiStatus>('/ai/status');
  const review = useAiJob<AiQuizReview>(report.data?.latestReview ?? null, () => { void report.reload(); });
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const aiReview = review.job?.status === 'SUCCEEDED' ? review.job.result : report.data?.latestReview?.status === 'SUCCEEDED' ? report.data.latestReview.result : null;
  const stale = !!aiReview && !!quiz.data && (aiReview.reviewedQuestionIds.length !== quiz.data.questions.length || quiz.data.questions.some(q => !aiReview.reviewedQuestionIds.includes(q.id)));
  const byQuestion = useMemo(() => {
    const map = new Map<string, { rule: QualityIssue[]; ai: AiQuizReview['questions'][number] | null }>();
    quiz.data?.questions.forEach(q => map.set(q.id, { rule: [], ai: null }));
    report.data?.ruleIssues.forEach(issue => { if (issue.questionId) map.get(issue.questionId)?.rule.push(issue); });
    if (!stale) aiReview?.questions.forEach(item => { const entry = item.questionId ? map.get(item.questionId) : undefined; if (entry) entry.ai = item; });
    return map;
  }, [quiz.data, report.data, aiReview, stale]);
  async function runReview() {
    setBusy(true); setError('');
    try { review.start(await api<AiJob<AiQuizReview>>(`/quizzes/${id}/ai-review`, json('POST'))); }
    catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  if (report.loading || quiz.loading) return <Loading/>;
  if (!report.data || !quiz.data) return <ErrorNotice message={report.error || quiz.error || 'Không tìm thấy bộ câu hỏi.'} retry={() => { void report.reload(); void quiz.reload(); }}/>;
  const data = report.data;
  const quizIssues = data.ruleIssues.filter(issue => !issue.questionId);
  const counts = { HIGH: 0, MEDIUM: 0, LOW: 0 } as Record<Severity, number>;
  for (const entry of byQuestion.values()) for (const issue of [...entry.rule, ...(entry.ai?.issues ?? [])]) counts[issue.severity]++;
  const visible = quiz.data.questions.filter(q => { const entry = byQuestion.get(q.id); return !onlyProblems || (entry && (entry.rule.length || entry.ai?.issues.length || (entry.ai && entry.ai.verdict !== 'OK'))); });
  return <>
    <Link className="back-link" to={`/quizzes/${id}`}><ArrowLeft size={16}/>{quiz.data.title}</Link>
    <PageHeading eyebrow="ĐÁNH GIÁ CHẤT LƯỢNG ĐỀ" title={quiz.data.title} description="Kiểm tra câu mơ hồ, thiếu dữ kiện, nhiều đáp án có thể đúng, câu trùng nội dung, chất lượng phương án nhiễu và phân tích kết quả làm bài." actions={<><Link className="button secondary" to={`/quizzes/${id}/edit`}><Pencil size={16}/>Sửa bộ câu hỏi</Link><button className="button primary" disabled={!status.data?.enabled || busy || review.running || !data.questionCount} onClick={() => { void runReview(); }}><Sparkles size={16}/>{review.running ? 'AI đang đánh giá…' : aiReview ? 'Đánh giá lại bằng AI' : 'Đánh giá bằng AI'}</button></>}/>
    <AiSetupNotice status={status.data}/>
    {error && <ErrorNotice message={error}/>}
    <JobProgress job={review.job} label="AI đang đọc và đánh giá từng câu hỏi…"/>
    <div className="quality-overview">
      <div className="panel quality-score"><span>Điểm chất lượng (AI)</span><strong className={aiReview ? (aiReview.score >= 80 ? 'score-good' : aiReview.score >= 60 ? 'score-fair' : 'score-poor') : ''}>{aiReview && !stale ? aiReview.score : '—'}<small>/100</small></strong><p>{aiReview ? (stale ? 'Bộ câu hỏi đã thay đổi sau lần đánh giá gần nhất. Hãy đánh giá lại.' : aiReview.summary) : 'Chạy đánh giá AI để nhận nhận xét chi tiết cho từng câu.'}</p></div>
      <div className="panel quality-counts"><h3>Vấn đề phát hiện</h3>{(['HIGH', 'MEDIUM', 'LOW'] as Severity[]).map(level => { const Icon = SEVERITY_ICON[level]; return <div key={level} className={`issue-${level.toLowerCase()}`}><Icon size={16}/>{SEVERITY_LABELS[level]}<b>{counts[level]}</b></div>; })}<label className="only-problems"><input type="checkbox" checked={onlyProblems} onChange={e => setOnlyProblems(e.target.checked)}/>Chỉ hiện câu có vấn đề</label></div>
      <div className="panel quality-dist"><Distribution title="Vị trí đáp án đúng" entries={ANSWERS.map(letter => [letter, data.keyDistribution[letter]])}/><Distribution title="Độ khó" entries={[...(['EASY', 'MEDIUM', 'HARD'] as const).map(level => [DIFFICULTY_LABELS[level], data.difficultyDistribution[level]] as [string, number]), ['Chưa phân loại', data.difficultyDistribution.UNSET]]}/></div>
    </div>
    {quizIssues.length > 0 && <section className="panel quality-section"><div className="panel-heading"><h2>Nhận xét chung</h2></div><div className="quality-section-body"><IssueList issues={quizIssues}/></div></section>}
    {!stale && aiReview && aiReview.duplicates.length > 0 && <section className="panel quality-section"><div className="panel-heading"><h2>Nhóm câu trùng nội dung (AI)</h2></div><ul className="duplicate-groups">{aiReview.duplicates.map((group, i) => <li key={i}><b>Câu {group.numbers.join(', ')}</b>: {group.reason}</li>)}</ul></section>}
    <section className="quality-questions">{visible.length ? visible.map(q => {
      const number = quiz.data!.questions.indexOf(q) + 1;
      const entry = byQuestion.get(q.id)!;
      const verdict = entry.ai?.verdict ?? (entry.rule.some(issue => issue.severity === 'HIGH') ? 'FIX' : entry.rule.length ? 'REVIEW' : null);
      return <article key={q.id} className={`panel quality-question verdict-${(verdict ?? 'none').toLowerCase()}`}>
        <div className="detail-question-top"><span className="small-label">CÂU {String(number).padStart(2, '0')}</span><span className="question-tags"><TypeBadge value={q.type}/><DifficultyBadge value={q.difficulty}/></span>{verdict && <span className={`verdict verdict-tag-${verdict.toLowerCase()}`}>{verdict === 'OK' ? <><CheckCircle2 size={13}/>Đạt</> : verdict === 'REVIEW' ? 'Cần xem lại' : 'Cần sửa'}</span>}</div>
        <h3>{q.content}</h3>
        <Options question={q} reveal/>
        {entry.ai && entry.ai.distractors.length > 0 && <div className="distractor-ratings"><span>Phương án nhiễu:</span>{entry.ai.distractors.map(item => <span key={item.option} className={`distractor distractor-${item.rating.toLowerCase()}`} title={item.note}><b>{item.option}</b> {DISTRACTOR_LABELS[item.rating]}</span>)}</div>}
        {(entry.rule.length > 0 || (entry.ai?.issues.length ?? 0) > 0) && <IssueList issues={[...entry.rule, ...(entry.ai?.issues ?? [])]}/>}
        {entry.ai?.suggestedRewrite && <details className="rewrite"><summary>Gợi ý viết lại của AI</summary><pre>{entry.ai.suggestedRewrite}</pre></details>}
      </article>;
    }) : <Empty title="Không có câu nào cần xem lại">Các kiểm tra tự động{aiReview ? ' và AI' : ''} chưa phát hiện vấn đề.</Empty>}</section>
    <section className="panel quality-section">
      <div className="panel-heading"><h2><ClipboardCheck size={16}/>Phân tích kết quả làm bài</h2>{data.results && <span className="muted">{data.results.sessionCount} phiên · {data.results.report.participants} lượt làm bài</span>}</div>
      {data.results ? <div className="quality-section-body"><ScoreCards summary={data.results.report.scores} reliability={data.results.report.reliability}/><ItemAnalysisTable report={data.results.report} labels={quiz.data.questions.map((q, i) => ({ number: i + 1, content: q.content, correctAnswer: q.correctAnswer }))}/></div>
        : <p className="muted quality-section-body">Chưa có phiên học đã kết thúc dùng đúng các câu hỏi hiện tại. Sau khi lớp làm bài, hệ thống tính tỷ lệ đúng, độ phân biệt và hiệu quả phương án nhiễu cho từng câu.<button className="text-button" onClick={() => { void report.reload(); }}><RefreshCw size={14}/>Tải lại</button></p>}
    </section>
  </>;
}
