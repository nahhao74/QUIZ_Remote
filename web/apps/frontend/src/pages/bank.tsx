import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Copy, Database, ExternalLink, Search, Sparkles, Trash2 } from 'lucide-react';
import { DIFFICULTY_LABELS, type BankQuestion, type BankSearchResult, type DuplicatePairView, type Quiz } from '@classpulse/shared-types';
import { api, json } from '../api';
import { useResource } from '../hooks';
import { Empty, ErrorNotice, Loading, Modal, PageHeading, messageOf } from '../components/ui';
import { Options } from '../components/session-ui';
import { DifficultyBadge, TypeBadge } from '../components/question-form';

function useDebounced<T>(value: T, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const timer = window.setTimeout(() => setDebounced(value), delay); return () => window.clearTimeout(timer); }, [value, delay]);
  return debounced;
}
function BankItem({ question, compact = false }: { question: BankQuestion; compact?: boolean }) {
  return <div className={`bank-item ${compact ? 'bank-item-compact' : ''}`}>
    <div className="bank-item-meta"><Link to={`/quizzes/${question.quizId}`} className="bank-quiz"><Database size={12}/>{question.quizTitle}</Link><span className="question-tags"><TypeBadge value={question.type}/><DifficultyBadge value={question.difficulty}/>{question.topic && <span className="tag">{question.topic}</span>}{question.origin === 'AI' && <span className="tag tag-ai"><Sparkles size={11}/>AI</span>}</span></div>
    <h3>{question.content}</h3>
    <Options question={question} reveal/>
  </div>;
}
export function QuestionBankPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'duplicates' ? 'duplicates' : 'search';
  return <>
    <PageHeading eyebrow="NGÂN HÀNG CÂU HỎI" title="Tìm kiếm và phát hiện trùng lặp" description="Mọi câu hỏi trong các bộ câu hỏi của bạn ở một nơi: tìm theo nội dung (không cần gõ dấu), lọc theo độ khó, chủ đề, và phát hiện câu hỏi trùng hoặc gần giống nhau."/>
    <div className="tabs page-tabs"><button className={tab === 'search' ? 'tab-active' : ''} onClick={() => setParams({})}><Search size={14}/>Tìm kiếm</button><button className={tab === 'duplicates' ? 'tab-active' : ''} onClick={() => setParams({ tab: 'duplicates' })}><Copy size={14}/>Câu hỏi trùng lặp</button></div>
    {tab === 'search' ? <SearchPanel/> : <DuplicatePanel/>}
  </>;
}
function SearchPanel() {
  const quizzes = useResource<Quiz[]>('/quizzes');
  const [filter, setFilter] = useState({ search: '', quizId: '', difficulty: '', type: '', topic: '', origin: '' });
  const debounced = useDebounced(filter);
  const query = new URLSearchParams(Object.entries(debounced).filter(([, value]) => value)).toString();
  const result = useResource<BankSearchResult>(`/bank/questions${query ? `?${query}` : ''}`);
  const set = (key: keyof typeof filter, value: string) => setFilter(f => ({ ...f, [key]: value }));
  return <>
    <div className="bank-filters">
      <label className="search-input bank-search"><Search size={17}/><input value={filter.search} onChange={e => set('search', e.target.value)} placeholder="Tìm trong câu hỏi, phương án, chủ đề, lời giải…"/></label>
      <select aria-label="Bộ câu hỏi" value={filter.quizId} onChange={e => set('quizId', e.target.value)}><option value="">Tất cả bộ câu hỏi</option>{quizzes.data?.map(quiz => <option key={quiz.id} value={quiz.id}>{quiz.title}</option>)}</select>
      <select aria-label="Độ khó" value={filter.difficulty} onChange={e => set('difficulty', e.target.value)}><option value="">Mọi độ khó</option>{Object.entries(DIFFICULTY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}<option value="UNSET">Chưa phân loại</option></select>
      <select aria-label="Loại câu" value={filter.type} onChange={e => set('type', e.target.value)}><option value="">Mọi loại câu</option><option value="SINGLE">Một đáp án</option><option value="MULTIPLE">Nhiều đáp án</option></select>
      <select aria-label="Chủ đề" value={filter.topic} onChange={e => set('topic', e.target.value)}><option value="">Mọi chủ đề</option>{result.data?.topics.map(topic => <option key={topic} value={topic}>{topic}</option>)}</select>
      <select aria-label="Nguồn" value={filter.origin} onChange={e => set('origin', e.target.value)}><option value="">Mọi nguồn</option><option value="MANUAL">Soạn tay</option><option value="IMPORT">Nhập từ file</option><option value="AI">AI tạo</option></select>
    </div>
    {result.error && <ErrorNotice message={result.error} retry={result.reload}/>}
    {result.loading && !result.data ? <Loading/> : result.data && <>
      <p className="list-count bank-count">Tìm thấy <b>{result.data.total}</b> câu hỏi{result.data.total > result.data.items.length ? ` · hiển thị ${result.data.items.length} câu đầu` : ''}</p>
      {result.data.items.length ? <div className="bank-list">{result.data.items.map(question => <div key={question.id} className="panel"><BankItem question={question}/></div>)}</div> : <Empty title="Không có câu hỏi phù hợp">Thử bỏ bớt bộ lọc hoặc dùng từ khóa khác.</Empty>}
    </>}
  </>;
}
const KIND_LABELS = { EXACT: 'Trùng hoàn toàn', NEAR: 'Gần giống', STEM: 'Cùng câu dẫn, khác phương án' } as const;
function DuplicatePanel() {
  const quizzes = useResource<Quiz[]>('/quizzes');
  const [threshold, setThreshold] = useState(80); const [quizId, setQuizId] = useState('');
  const debounced = useDebounced(threshold, 400);
  const pairs = useResource<DuplicatePairView[]>(`/bank/duplicates?threshold=${debounced / 100}${quizId ? `&quizId=${quizId}` : ''}`);
  const [removing, setRemoving] = useState<BankQuestion | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function remove() {
    if (!removing) return;
    setBusy(true); setError('');
    try { await api(`/quizzes/${removing.quizId}/questions/${removing.id}`, json('DELETE')); setRemoving(null); await pairs.reload(); }
    catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  return <>
    <div className="bank-filters">
      <label className="threshold"><span>Độ giống tối thiểu <b>{threshold}%</b></span><input type="range" min={60} max={98} step={1} value={threshold} onChange={e => setThreshold(Number(e.target.value))}/></label>
      <select aria-label="Bộ câu hỏi" value={quizId} onChange={e => setQuizId(e.target.value)}><option value="">So sánh toàn bộ ngân hàng</option>{quizzes.data?.map(quiz => <option key={quiz.id} value={quiz.id}>Liên quan tới: {quiz.title}</option>)}</select>
    </div>
    <p className="muted bank-help">So khớp câu dẫn và phương án theo nội dung, không phân biệt dấu, hoa thường hay thứ tự phương án. Câu cùng câu dẫn nhưng khác phương án cũng được liệt kê để bạn kiểm tra.</p>
    {(error || pairs.error) && <ErrorNotice message={error || pairs.error} retry={pairs.reload}/>}
    {pairs.loading && !pairs.data ? <Loading/> : pairs.data?.length ? <div className="duplicate-list">{pairs.data.map(pair => <article key={`${pair.a.id}-${pair.b.id}`} className="panel duplicate-pair">
      <div className="duplicate-pair-head"><span className={`similarity sim-${pair.kind.toLowerCase()}`}>{Math.round(pair.score * 100)}%</span><strong>{KIND_LABELS[pair.kind]}</strong><span className="muted">Câu dẫn {Math.round(pair.stem * 100)}% · Phương án {Math.round(pair.options * 100)}%{pair.a.quizId === pair.b.quizId ? ' · cùng bộ câu hỏi' : ''}</span></div>
      <div className="duplicate-columns">{[pair.a, pair.b].map(question => <div key={question.id}><BankItem question={question} compact/><div className="duplicate-actions"><Link className="text-link" to={`/quizzes/${question.quizId}/edit`}><ExternalLink size={13}/>Sửa trong bộ</Link><button className="text-button danger-text" onClick={() => setRemoving(question)}><Trash2 size={13}/>Xóa câu này</button></div></div>)}</div>
    </article>)}</div> : <Empty title="Không phát hiện câu trùng lặp">Không có cặp câu nào giống nhau từ {threshold}% trở lên.</Empty>}
    {removing && <Modal title="Xóa câu hỏi khỏi bộ?" onClose={() => setRemoving(null)}><p className="muted">Câu “{removing.content.slice(0, 120)}” sẽ bị gỡ khỏi bộ “{removing.quizTitle}”. Lịch sử các buổi học cũ vẫn được giữ.</p><div className="modal-actions"><button className="button secondary" onClick={() => setRemoving(null)}>Hủy</button><button className="button danger" disabled={busy} onClick={() => { void remove(); }}>{busy ? 'Đang xóa…' : 'Xóa câu hỏi'}</button></div></Modal>}
  </>;
}
