import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, BarChart3, Clock3, Download, Eye, FileSpreadsheet, FileText, GraduationCap, Hand, Layers, Play, Plus, Shuffle, Trash2, Users } from 'lucide-react';
import { formatAnswerKey, type AiJob, type AiResultInsight, type AiStatus, type Classroom, type Exam, type ExamReport, type ExamVariantDetail, type Quiz, type SessionMode, type SessionSnapshot } from '@classpulse/shared-types';
import { api, downloadApiFile, json } from '../api';
import { useAiJob, useResource } from '../hooks';
import { Empty, ErrorNotice, Loading, Modal, PageHeading, Status, dateLabel, messageOf } from '../components/ui';
import { Options } from '../components/session-ui';
import { InsightPanel, ScoreCards, ScoreHistogram } from '../components/analysis';

function CreateExam({ quizId, onClose }: { quizId?: string; onClose: () => void }) {
  const quizzes = useResource<Quiz[]>('/quizzes'); const navigate = useNavigate();
  const [form, setForm] = useState({ quizId: quizId ?? '', title: '', description: '', variantCount: 4, shuffleQuestions: true, shuffleOptions: true, durationSeconds: '' });
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const quiz = quizzes.data?.find(item => item.id === form.quizId);
  useEffect(() => { if (!form.quizId && quizzes.data?.length) setForm(f => ({ ...f, quizId: quizzes.data!.find(q => q.questions.length)?.id ?? '' })); }, [quizzes.data]);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const exam = await api<Exam>('/exams', json('POST', { quizId: form.quizId, title: form.title.trim() || quiz?.title || 'Kỳ thi', description: form.description, variantCount: form.variantCount, shuffleQuestions: form.shuffleQuestions, shuffleOptions: form.shuffleOptions, ...(form.durationSeconds ? { durationSeconds: Number(form.durationSeconds) } : {}) }));
      navigate(`/exams/${exam.id}`);
    } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  return <Modal title="Tạo kỳ thi" onClose={onClose}>{quizzes.loading ? <Loading/> : <form className="form-stack" onSubmit={submit}>
    {(error || quizzes.error) && <ErrorNotice message={error || quizzes.error}/>}
    <label>Bộ câu hỏi<select required value={form.quizId} onChange={e => setForm({ ...form, quizId: e.target.value })}><option value="" disabled>Chọn bộ câu hỏi</option>{quizzes.data?.filter(q => q.questions.length).map(q => <option key={q.id} value={q.id}>{q.title} · {q.questions.length} câu</option>)}</select></label>
    <label>Tên kỳ thi<input maxLength={200} value={form.title} placeholder={quiz?.title ?? 'Ví dụ: Kiểm tra giữa kỳ'} onChange={e => setForm({ ...form, title: e.target.value })}/></label>
    <label>Số mã đề<input type="number" min={1} max={24} value={form.variantCount} onChange={e => setForm({ ...form, variantCount: Math.max(1, Math.min(24, Number(e.target.value) || 1)) })}/><small className="muted">Mã đề đánh số 101, 102, … Mỗi lớp có thể nhận một mã đề khác nhau.</small></label>
    <div className="toggle-list">
      <label className="toggle"><input type="checkbox" checked={form.shuffleQuestions} onChange={e => setForm({ ...form, shuffleQuestions: e.target.checked })}/><span><Shuffle size={15}/><b>Trộn thứ tự câu hỏi</b><small>Mỗi mã đề có thứ tự câu khác nhau.</small></span></label>
      <label className="toggle"><input type="checkbox" checked={form.shuffleOptions} onChange={e => setForm({ ...form, shuffleOptions: e.target.checked })}/><span><Layers size={15}/><b>Xáo trộn đáp án</b><small>Đảo vị trí A–D; câu có “Tất cả các đáp án trên”/“Cả A và B” được giữ nguyên.</small></span></label>
    </div>
    <label>Thời gian mỗi câu (giây, tùy chọn)<input type="number" min={5} max={3600} value={form.durationSeconds} placeholder="Theo thời gian của từng câu" onChange={e => setForm({ ...form, durationSeconds: e.target.value })}/></label>
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Hủy</button><button className="button primary" disabled={busy || !form.quizId}>{busy ? 'Đang tạo mã đề…' : 'Tạo kỳ thi'}</button></div>
  </form>}</Modal>;
}
export function ExamListPage() {
  const exams = useResource<Exam[]>('/exams');
  const [params, setParams] = useSearchParams();
  const [create, setCreate] = useState(!!params.get('quiz'));
  return <>
    <PageHeading eyebrow="QUẢN LÝ KỲ THI" title="Kỳ thi, mã đề và thống kê theo lớp" description="Trộn câu hỏi và xáo trộn đáp án thành nhiều mã đề, mở phiên thi cho từng lớp và so sánh kết quả giữa các lớp." actions={<button className="button primary" onClick={() => setCreate(true)}><Plus size={18}/>Tạo kỳ thi</button>}/>
    {exams.error && <ErrorNotice message={exams.error} retry={exams.reload}/>}
    {exams.loading ? <Loading/> : exams.data?.length ? <div className="panel"><div className="table-scroll"><table className="session-table"><thead><tr><th>KỲ THI</th><th>MÃ ĐỀ</th><th>PHIÊN THI</th><th>ĐIỂM TB</th><th/></tr></thead><tbody>{exams.data.map(exam => {
      const finished = exam.sessions.filter(s => s.status === 'FINISHED');
      const count = finished.reduce((sum, s) => sum + s.summary.count, 0);
      const mean = count ? Math.round(finished.reduce((sum, s) => sum + s.summary.mean * s.summary.count, 0) / count * 100) / 100 : null;
      return <tr key={exam.id}><td><Link to={`/exams/${exam.id}`} className="session-title"><span className="session-table-icon"><GraduationCap size={19}/></span><span><strong>{exam.title}</strong><small>{exam.quizTitle} · {exam.questionCount} câu · {dateLabel(exam.createdAt)}</small></span></Link></td><td>{exam.variants.map(v => v.code).join(', ')}</td><td>{exam.sessions.length}</td><td>{mean ?? '—'}</td><td><Link className="icon-button" to={`/exams/${exam.id}`} aria-label={`Mở ${exam.title}`}><Eye size={17}/></Link></td></tr>;
    })}</tbody></table></div></div> : <Empty title="Chưa có kỳ thi" action={<button className="button primary" onClick={() => setCreate(true)}><Plus size={16}/>Tạo kỳ thi</button>}>Tạo kỳ thi từ một bộ câu hỏi để có nhiều mã đề và thống kê điểm theo lớp.</Empty>}
    {create && <CreateExam quizId={params.get('quiz') ?? undefined} onClose={() => { setCreate(false); setParams({}); }}/>}
  </>;
}

function OpenSession({ exam, onClose }: { exam: Exam; onClose: () => void }) {
  const classes = useResource<Classroom[]>('/classes'); const navigate = useNavigate();
  const [form, setForm] = useState({ classroomId: '', variantCode: '', mode: 'MANUAL' as SessionMode, durationSeconds: '' });
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const session = await api<SessionSnapshot>(`/exams/${exam.id}/sessions`, json('POST', { mode: form.mode, ...(form.classroomId ? { classroomId: form.classroomId } : {}), ...(form.variantCode ? { variantCode: form.variantCode } : {}), ...(form.durationSeconds ? { durationSeconds: Number(form.durationSeconds) } : {}) }));
      navigate(`/sessions/${session.id}`);
    } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  return <Modal title="Mở phiên thi cho một lớp" onClose={onClose}>{classes.loading ? <Loading/> : <form className="form-stack" onSubmit={submit}>
    {error && <ErrorNotice message={error}/>}
    <label>Lớp<select value={form.classroomId} onChange={e => setForm({ ...form, classroomId: e.target.value })}><option value="">Không gán lớp</option>{classes.data?.map(item => <option key={item.id} value={item.id}>{item.name} · {item.studentCount} SV</option>)}</select>{!classes.data?.length && <small className="muted">Chưa có lớp. <Link to="/classes">Tạo lớp</Link> để thống kê điểm theo lớp.</small>}</label>
    <label>Mã đề<select value={form.variantCode} onChange={e => setForm({ ...form, variantCode: e.target.value })}><option value="">Tự động (mã đề ít dùng nhất)</option>{exam.variants.map(variant => <option key={variant.code} value={variant.code}>Mã đề {variant.code}</option>)}</select></label>
    <label>Chế độ điều khiển</label>
    <div className="mode-options"><button type="button" className={form.mode === 'MANUAL' ? 'selected' : ''} onClick={() => setForm({ ...form, mode: 'MANUAL' })}><Hand size={22}/><strong>Chủ động</strong><span>Giáo viên chuyển câu</span></button><button type="button" className={form.mode === 'TIMER' ? 'selected' : ''} onClick={() => setForm({ ...form, mode: 'TIMER' })}><Clock3 size={22}/><strong>Tự động</strong><span>Hết giờ tự chuyển câu</span></button></div>
    <label>Thời gian mỗi câu (giây)<input type="number" min={5} max={3600} placeholder={exam.durationSeconds ? `${exam.durationSeconds} (theo kỳ thi)` : 'Theo từng câu hỏi'} value={form.durationSeconds} onChange={e => setForm({ ...form, durationSeconds: e.target.value })}/></label>
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Hủy</button><button className="button primary" disabled={busy}><Play size={16}/>{busy ? 'Đang mở phòng…' : 'Mở phòng thi'}</button></div>
  </form>}</Modal>;
}
function VariantPreview({ examId, code, onClose }: { examId: string; code: string; onClose: () => void }) {
  const variant = useResource<ExamVariantDetail>(`/exams/${examId}/variants/${code}`);
  return <Modal wide title={`Mã đề ${code}`} onClose={onClose}>{variant.loading ? <Loading/> : variant.data ? <div className="variant-preview">
    <div className="variant-key"><b>Đáp án:</b> {variant.data.questions.map(q => `${q.number}.${formatAnswerKey(q.correctAnswer).replace(/, /g, '')}`).join('  ')}</div>
    {variant.data.questions.map(q => <div key={q.number} className="variant-question"><span className="small-label">CÂU {q.number} · CÂU GỐC {q.sourceNumber}</span><h3>{q.content}</h3><Options question={q} reveal/></div>)}
  </div> : <ErrorNotice message={variant.error || 'Không tải được mã đề.'}/>}</Modal>;
}

export function ExamDetailPage() {
  const { id = '' } = useParams(); const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (['variants', 'sessions', 'report'] as const).find(value => value === params.get('tab')) ?? 'variants';
  const exam = useResource<Exam>(`/exams/${id}`);
  const [open, setOpen] = useState(false); const [preview, setPreview] = useState(''); const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(''); const [downloading, setDownloading] = useState('');
  async function download(path: string, name: string) {
    setDownloading(path); setError('');
    try { await downloadApiFile(path, name); } catch (e) { setError(messageOf(e)); } finally { setDownloading(''); }
  }
  async function remove() { try { await api(`/exams/${id}`, json('DELETE')); navigate('/exams'); } catch (e) { setError(messageOf(e)); } }
  if (exam.loading && !exam.data) return <Loading/>;
  if (!exam.data) return <ErrorNotice message={exam.error || 'Không tìm thấy kỳ thi.'} retry={exam.reload}/>;
  const data = exam.data;
  return <>
    <Link className="back-link" to="/exams"><ArrowLeft size={16}/>Tất cả kỳ thi</Link>
    <PageHeading eyebrow="KỲ THI" title={data.title} description={`${data.quizTitle} · ${data.questionCount} câu · ${data.variants.length} mã đề · ${data.shuffleQuestions ? 'trộn câu' : 'giữ thứ tự câu'} · ${data.shuffleOptions ? 'xáo trộn đáp án' : 'giữ vị trí đáp án'}`} actions={<><button className="button secondary" disabled={!!downloading} onClick={() => { void download(`/exams/${id}/papers.docx`, 'de-thi.docx'); }}><FileText size={16}/>Tải tất cả đề (Word)</button><button className="button secondary" disabled={!!downloading} onClick={() => { void download(`/exams/${id}/answer-key.xlsx`, 'dap-an.xlsx'); }}><FileSpreadsheet size={16}/>Đáp án (Excel)</button><button className="button primary" onClick={() => setOpen(true)}><Play size={16}/>Mở phiên thi</button></>}/>
    {error && <ErrorNotice message={error}/>}
    <div className="tabs page-tabs"><button className={tab === 'variants' ? 'tab-active' : ''} onClick={() => setParams({})}><Layers size={14}/>Mã đề</button><button className={tab === 'sessions' ? 'tab-active' : ''} onClick={() => setParams({ tab: 'sessions' })}><Users size={14}/>Phiên thi ({data.sessions.length})</button><button className={tab === 'report' ? 'tab-active' : ''} onClick={() => setParams({ tab: 'report' })}><BarChart3 size={14}/>Thống kê theo lớp</button></div>
    {tab === 'variants' && <div className="variant-grid">{data.variants.map(variant => <div key={variant.code} className="panel variant-card"><span className="small-label">MÃ ĐỀ</span><strong>{variant.code}</strong><small>{variant.questionCount} câu · {data.sessions.filter(s => s.variantCode === variant.code).length} phiên đã dùng</small><div><button className="text-button" onClick={() => setPreview(variant.code)}><Eye size={14}/>Xem</button><button className="text-button" disabled={!!downloading} onClick={() => { void download(`/exams/${id}/papers.docx?code=${variant.code}`, `de-${variant.code}.docx`); }}><Download size={14}/>Word</button></div></div>)}</div>}
    {tab === 'sessions' && (data.sessions.length ? <div className="panel"><div className="table-scroll"><table className="session-table"><thead><tr><th>LỚP</th><th>MÃ ĐỀ</th><th>TRẠNG THÁI</th><th>SINH VIÊN</th><th>ĐIỂM TB</th><th>ĐẠT</th></tr></thead><tbody>{data.sessions.map(session => <tr key={session.id}><td><Link className="session-title" to={`/sessions/${session.id}`}><span><strong>{session.classroomName ?? 'Chưa gán lớp'}</strong><small>{new Date(session.createdAt).toLocaleString('vi-VN')}</small></span></Link></td><td><code className="room-code-small">{session.variantCode}</code></td><td><Status status={session.status}/></td><td>{session.participantCount}</td><td>{session.status === 'FINISHED' ? session.summary.mean : '—'}</td><td>{session.status === 'FINISHED' ? `${session.summary.passRate}%` : '—'}</td></tr>)}</tbody></table></div></div>
      : <Empty title="Chưa mở phiên thi nào" action={<button className="button primary" onClick={() => setOpen(true)}><Play size={16}/>Mở phiên thi</button>}>Mỗi lớp làm bài trong một phiên với mã đề riêng; điểm được tổng hợp theo lớp.</Empty>)}
    {tab === 'report' && <ExamReportView id={id}/>}
    <div className="danger-zone"><button className="text-button danger-text" onClick={() => setDeleting(true)}><Trash2 size={14}/>Xóa kỳ thi</button></div>
    {open && <OpenSession exam={data} onClose={() => setOpen(false)}/>}
    {preview && <VariantPreview examId={id} code={preview} onClose={() => setPreview('')}/>}
    {deleting && <Modal title="Xóa kỳ thi?" onClose={() => setDeleting(false)}><p className="muted">Kỳ thi sẽ bị ẩn. Các phiên thi và kết quả đã có vẫn còn trong lịch sử buổi học.</p><div className="modal-actions"><button className="button secondary" onClick={() => setDeleting(false)}>Hủy</button><button className="button danger" onClick={() => { void remove(); }}>Xóa kỳ thi</button></div></Modal>}
  </>;
}
function ExamReportView({ id }: { id: string }) {
  const report = useResource<ExamReport>(`/exams/${id}/report`);
  const status = useResource<AiStatus>('/ai/status');
  const insight = useAiJob<AiResultInsight>(report.data?.latestInsight ?? null);
  const [error, setError] = useState('');
  async function runInsight() {
    setError('');
    try { insight.start(await api<AiJob<AiResultInsight>>(`/exams/${id}/ai-analysis`, json('POST'))); } catch (e) { setError(messageOf(e)); }
  }
  if (report.loading) return <Loading/>;
  if (!report.data) return <ErrorNotice message={report.error || 'Không tải được thống kê.'} retry={report.reload}/>;
  const data = report.data;
  if (!data.classes.length) return <Empty title="Chưa có phiên thi kết thúc">Thống kê điểm theo lớp xuất hiện khi các phiên thi kết thúc.</Empty>;
  const maxMean = 10;
  return <>
    <div className="report-toolbar"><span className="muted">{data.overall.count} bài làm · {data.classes.length} lớp</span><button className="button secondary small" onClick={() => { downloadApiFile(`/exams/${id}/report.xlsx`, 'bang-diem-ky-thi.xlsx').catch(e => setError(messageOf(e))); }}><Download size={15}/>Xuất bảng điểm Excel</button></div>
    {error && <ErrorNotice message={error}/>}
    <section className="panel report-block"><div className="panel-heading"><h2>Toàn kỳ thi</h2></div><div className="report-block-body"><ScoreCards summary={data.overall}/><ScoreHistogram summary={data.overall}/></div></section>
    <section className="panel report-block"><div className="panel-heading"><h2>So sánh các lớp</h2></div><div className="table-scroll"><table className="session-table class-compare"><thead><tr><th>LỚP</th><th>SỐ BÀI</th><th>ĐIỂM TB</th><th/><th>TRUNG VỊ</th><th>ĐỘ LỆCH CHUẨN</th><th>ĐẠT</th><th>GIỎI</th><th>KHÁ</th><th>TB</th><th>YẾU</th><th>KÉM</th></tr></thead><tbody>{data.classes.map(item => <tr key={item.classroomId ?? 'none'}><td><b>{item.classroomName}</b></td><td>{item.summary.count}</td><td><b>{item.summary.mean}</b></td><td className="compare-bar-cell"><div className="compare-bar"><span style={{ width: `${item.summary.mean * 100 / maxMean}%` }}/></div></td><td>{item.summary.median}</td><td>{item.summary.standardDeviation}</td><td>{item.summary.passRate}%</td><td>{item.summary.bands.EXCELLENT}</td><td>{item.summary.bands.GOOD}</td><td>{item.summary.bands.AVERAGE}</td><td>{item.summary.bands.WEAK}</td><td>{item.summary.bands.POOR}</td></tr>)}</tbody></table></div></section>
    <section className="panel report-block"><div className="panel-heading"><h2>Tỷ lệ đúng từng câu (theo đề gốc)</h2></div><div className="table-scroll"><table className="session-table heat-table"><thead><tr><th>CÂU</th><th>NỘI DUNG</th><th>CHUNG</th>{data.classes.map(item => <th key={item.classroomId ?? 'none'}>{item.classroomName.toUpperCase()}</th>)}</tr></thead><tbody>{data.questions.map(question => <tr key={question.number}><td>{question.number}</td><td className="heat-content" title={question.content}>{question.content}{question.knowledge && <small>{question.knowledge}</small>}</td>{[question.correctRate, ...data.classes.map(item => question.byClass[item.classroomId ?? 'none'])].map((rate, i) => <td key={i} className="heat-cell" style={{ background: rate === undefined ? undefined : `hsl(${Math.round(rate * 120)}, 55%, 90%)` }}>{rate === undefined ? '—' : `${Math.round(rate * 100)}%`}</td>)}</tr>)}</tbody></table></div></section>
    <InsightPanel job={insight.job} running={insight.running} error={error || insight.error} enabled={!!status.data?.enabled} onRun={() => { void runInsight(); }}/>
  </>;
}
