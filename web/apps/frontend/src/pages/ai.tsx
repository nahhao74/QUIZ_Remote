import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Check, CheckCheck, ChevronDown, ChevronUp, Copy, FileText, Pencil, Quote, RotateCcw, Sparkles, Trash2, UploadCloud, X } from 'lucide-react';
import { AI_PROVIDER_LABELS, allocate, DIFFICULTY_LABELS, questionIssues, type AiJob, type AiStatus, type GeneratedQuestion, type GenerateQuestionsRequest, type GenerationResult, type Quiz, type ReviewStatus, type SourceDocument } from '@classpulse/shared-types';
import { api, json, upload } from '../api';
import { useAiJob, useResource } from '../hooks';
import { Empty, ErrorNotice, Loading, Modal, PageHeading, jobElapsed, messageOf } from '../components/ui';
import { Options } from '../components/session-ui';
import { DifficultyBadge, QuestionFields, TypeBadge } from '../components/question-form';

const MAX_CHARS = 500_000;
const number = (value: number) => value.toLocaleString('vi-VN');
export function AiSetupNotice({ status }: { status: AiStatus | null }) {
  if (!status || status.enabled) return null;
  return <div className="ai-setup"><AlertTriangle size={18}/><div><strong>AI chưa được bật trên máy chủ.</strong><span>Miễn phí: tạo khóa Gemini tại <b>aistudio.google.com/apikey</b> rồi thêm <code>GEMINI_API_KEY=…</code> vào file <code>.env</code>; hoặc chạy mô hình trên máy chủ bằng Ollama (<code>OLLAMA_URL=…</code>). Khởi động lại backend sau khi sửa. Các chức năng không dùng AI vẫn hoạt động bình thường.</span></div></div>;
}
/** Which AI answers, and what that implies for limits and privacy. */
export function AiProviderNote({ status }: { status: AiStatus | null }) {
  if (!status?.enabled || !status.provider) return null;
  const note = status.provider === 'gemini' ? 'Gói miễn phí có giới hạn số lượt mỗi phút và mỗi ngày; nội dung gửi qua gói miễn phí có thể được Google dùng để cải thiện sản phẩm.'
    : status.provider === 'ollama' ? 'Chạy trên máy chủ của bạn: không giới hạn lượt dùng, dữ liệu không rời máy chủ; tốc độ và chất lượng phụ thuộc mô hình và phần cứng.'
    : 'Tính phí theo token trên tài khoản Anthropic.';
  const fallback = status.fallback && <> Khi hết hạn mức hoặc mất kết nối, hệ thống tự chuyển sang <b>{AI_PROVIDER_LABELS[status.fallback.provider]}</b> · <code>{status.fallback.model}</code>.</>;
  return <p className="ai-provider-note"><Sparkles size={14}/>Đang dùng <b>{AI_PROVIDER_LABELS[status.provider]}</b> · <code>{status.model}</code>. {note}{fallback}</p>;
}
export function JobProgress({ job, label }: { job: AiJob | null; label: string }) {
  if (!job) return null;
  if (job.status === 'FAILED') return <ErrorNotice message={job.error || 'Tác vụ AI thất bại.'}/>;
  if (job.status === 'SUCCEEDED') return null;
  return <div className="progress-notice"><Sparkles size={17}/><span>{label} {job.status === 'QUEUED' ? '(đang chờ tới lượt)' : `${job.progress}% · ${jobElapsed(job)}`}</span><div className="progress-bar"><span style={{ width: `${Math.max(5, job.progress)}%` }}/></div></div>;
}

export function AiStudioPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'review' ? 'review' : 'generate';
  const status = useResource<AiStatus>('/ai/status');
  const count = useResource<{ pending: number }>('/ai/generated/count');
  return <>
    <PageHeading eyebrow="TRỢ LÝ AI" title="Tạo câu hỏi từ tài liệu" description="Tải giáo trình lên, chọn chương và tỷ lệ độ khó. AI đề xuất câu hỏi kèm lời giải và kiến thức kiểm tra — bạn duyệt trước khi đưa vào bộ đề."/>
    <AiSetupNotice status={status.data}/>
    <AiProviderNote status={status.data}/>
    <div className="tabs page-tabs"><button className={tab === 'generate' ? 'tab-active' : ''} onClick={() => setParams({})}>Tạo câu hỏi</button><button className={tab === 'review' ? 'tab-active' : ''} onClick={() => setParams({ tab: 'review' })}>Chờ duyệt{count.data?.pending ? <span className="tab-count">{count.data.pending}</span> : null}</button></div>
    {tab === 'generate' ? <GeneratePanel enabled={!!status.data?.enabled} onGenerated={jobId => { void count.reload(); setParams({ tab: 'review', job: jobId }); }}/> : <ReviewQueue jobId={params.get('job') ?? ''} onChanged={() => void count.reload()}/>}
  </>;
}

function GeneratePanel({ enabled, onGenerated }: { enabled: boolean; onGenerated: (jobId: string) => void }) {
  const documents = useResource<SourceDocument[]>('/ai/documents');
  const quizzes = useResource<Quiz[]>('/quizzes');
  const jobs = useResource<AiJob<GenerationResult>[]>('/ai/jobs?kind=GENERATE_QUESTIONS');
  const fileInput = useRef<HTMLInputElement>(null);
  const [documentId, setDocumentId] = useState('');
  const [sections, setSections] = useState<number[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [form, setForm] = useState({ questionCount: 20, easyPercent: 40, mediumPercent: 40, hardPercent: 20, multiplePercent: 0, instructions: '', quizId: '' });
  const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const job = useAiJob<GenerationResult>(null, finished => { void jobs.reload(); if (finished.status === 'SUCCEEDED') onGenerated(finished.id); });
  const doc = documents.data?.find(item => item.id === documentId) ?? null;
  useEffect(() => { if (!documentId && documents.data?.length) setDocumentId(documents.data[0].id); }, [documents.data, documentId]);
  useEffect(() => { setSections(doc ? doc.sections.map(section => section.index) : []); setExpanded(null); }, [doc?.id]);
  const selectedChars = doc ? doc.sections.filter(section => sections.includes(section.index)).reduce((sum, section) => sum + section.charCount, 0) : 0;
  const percentTotal = form.easyPercent + form.mediumPercent + form.hardPercent;
  const counts = useMemo(() => allocate(form.questionCount, [form.easyPercent, form.mediumPercent, form.hardPercent]), [form.questionCount, form.easyPercent, form.mediumPercent, form.hardPercent]);
  async function uploadDocument(file: File) {
    setBusy('upload'); setError('');
    try { const created = await upload<SourceDocument>('/ai/documents', file); await documents.reload(); setDocumentId(created.id); }
    catch (e) { setError(messageOf(e)); } finally { setBusy(''); if (fileInput.current) fileInput.current.value = ''; }
  }
  async function removeDocument(id: string) {
    setBusy('delete'); setError('');
    try { await api(`/ai/documents/${id}`, json('DELETE')); if (id === documentId) setDocumentId(''); await documents.reload(); }
    catch (e) { setError(messageOf(e)); } finally { setBusy(''); }
  }
  async function generate(e: FormEvent) {
    e.preventDefault(); setError('');
    if (!doc) { setError('Hãy tải lên hoặc chọn một tài liệu.'); return; }
    if (!sections.length) { setError('Chọn ít nhất một chương.'); return; }
    if (percentTotal !== 100) { setError('Tổng tỷ lệ dễ, trung bình và khó phải bằng 100%.'); return; }
    setBusy('generate');
    try {
      const body: GenerateQuestionsRequest = { documentId: doc.id, sectionIndexes: sections, questionCount: form.questionCount, easyPercent: form.easyPercent, mediumPercent: form.mediumPercent, hardPercent: form.hardPercent, multiplePercent: form.multiplePercent, ...(form.instructions.trim() ? { instructions: form.instructions.trim() } : {}), ...(form.quizId ? { quizId: form.quizId } : {}) };
      job.start(await api<AiJob<GenerationResult>>('/ai/generate', json('POST', body)));
      void jobs.reload();
    } catch (e) { setError(messageOf(e)); } finally { setBusy(''); }
  }
  // Keeps "dễ", trims "khó" if needed and gives the remainder to "trung bình".
  const rebalance = () => setForm(f => { const hard = Math.min(f.hardPercent, 100 - f.easyPercent); return { ...f, hardPercent: hard, mediumPercent: 100 - f.easyPercent - hard }; });
  const setPercent = (key: 'easyPercent' | 'mediumPercent' | 'hardPercent', value: number) => setForm(f => ({ ...f, [key]: Math.max(0, Math.min(100, Math.round(value) || 0)) }));
  return <div className="ai-grid">
    <div className="ai-main">
      {error && <ErrorNotice message={error}/>}
      <section className="panel step-panel">
        <div className="step-heading"><span className="step-number">1</span><div><h2>Tài liệu nguồn</h2><p>PDF, Word (.docx), TXT hoặc Markdown, tối đa 20 MB. PDF dạng ảnh scan vẫn dùng được nhưng không tách chương tự động.</p></div></div>
        <input ref={fileInput} type="file" hidden accept=".pdf,.docx,.txt,.md" onChange={e => { const file = e.target.files?.[0]; if (file) void uploadDocument(file); }}/>
        <button type="button" className="upload-zone" disabled={!!busy} onClick={() => fileInput.current?.click()}><UploadCloud size={26}/><strong>{busy === 'upload' ? 'Đang đọc tài liệu…' : 'Chọn tài liệu để tải lên'}</strong><span>Hệ thống tự nhận diện các chương, bài và tiêu đề.</span></button>
        {documents.loading ? <Loading/> : documents.data?.length ? <div className="document-list">{documents.data.map(item => <div key={item.id} className={`document-row ${item.id === documentId ? 'document-row-active' : ''}`}><button type="button" onClick={() => setDocumentId(item.id)}><FileText size={18}/><span><strong>{item.filename}</strong><small>{item.pageCount ? `${item.pageCount} trang · ` : ''}{item.scanned ? 'PDF dạng ảnh' : `${number(item.charCount)} ký tự · ${item.sections.length} phần`}</small></span></button><button type="button" className="icon-button danger-text" aria-label={`Xóa ${item.filename}`} disabled={!!busy} onClick={() => { void removeDocument(item.id); }}><Trash2 size={15}/></button></div>)}</div> : null}
      </section>
      {doc && <section className="panel step-panel">
        <div className="step-heading"><span className="step-number">2</span><div><h2>Chọn chương</h2><p>Đã chọn {sections.length}/{doc.sections.length} phần · {number(selectedChars)} ký tự{selectedChars > MAX_CHARS ? ' — vượt giới hạn 500.000 ký tự, hãy bỏ bớt chương' : ''}.</p></div><div className="step-actions"><button type="button" className="text-button" onClick={() => setSections(doc.sections.map(s => s.index))}>Chọn tất cả</button><button type="button" className="text-button" onClick={() => setSections([])}>Bỏ chọn</button></div></div>
        <div className="section-list">{doc.sections.map(section => <div key={section.index} className={`section-row ${sections.includes(section.index) ? 'section-row-active' : ''}`}>
          <label><input type="checkbox" checked={sections.includes(section.index)} onChange={e => setSections(e.target.checked ? [...sections, section.index].sort((a, b) => a - b) : sections.filter(i => i !== section.index))}/><span><strong>{section.title}</strong><small>{section.pageStart ? `Trang ${section.pageStart}${section.pageEnd && section.pageEnd !== section.pageStart ? `–${section.pageEnd}` : ''} · ` : ''}{doc.scanned ? 'Toàn bộ file PDF' : `${number(section.charCount)} ký tự`}</small></span></label>
          {section.preview && <button type="button" className="icon-button" aria-label="Xem trước nội dung" onClick={() => setExpanded(expanded === section.index ? null : section.index)}>{expanded === section.index ? <ChevronUp size={16}/> : <ChevronDown size={16}/>}</button>}
          {expanded === section.index && <p className="section-preview">{section.preview}…</p>}
        </div>)}</div>
      </section>}
      {doc && <form className="panel step-panel form-stack" onSubmit={generate}>
        <div className="step-heading"><span className="step-number">3</span><div><h2>Cấu hình bộ câu hỏi</h2><p>AI viết đúng số câu theo tỷ lệ độ khó; câu hỏi chỉ được đưa vào bộ đề sau khi bạn duyệt.</p></div></div>
        <div className="generate-grid">
          <label>Số câu hỏi<input type="number" min={1} max={60} value={form.questionCount} onChange={e => setForm({ ...form, questionCount: Math.max(1, Math.min(60, Number(e.target.value) || 1)) })}/></label>
          <label>Tỷ lệ câu nhiều đáp án (%)<input type="number" min={0} max={100} value={form.multiplePercent} onChange={e => setForm({ ...form, multiplePercent: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}/></label>
        </div>
        <div className="difficulty-mix">
          {([['easyPercent', 'EASY'], ['mediumPercent', 'MEDIUM'], ['hardPercent', 'HARD']] as const).map(([key, level], i) => <label key={key} className={`mix-${level.toLowerCase()}`}><span>{DIFFICULTY_LABELS[level]} <b>{counts[i]} câu</b></span><input type="range" min={0} max={100} step={5} value={form[key]} onChange={e => setPercent(key, Number(e.target.value))}/><span className="mix-value"><input type="number" min={0} max={100} value={form[key]} onChange={e => setPercent(key, Number(e.target.value))}/>%</span></label>)}
          <div className={`mix-total ${percentTotal === 100 ? '' : 'mix-total-error'}`}>Tổng: {percentTotal}%{percentTotal !== 100 && <button type="button" className="text-button" onClick={rebalance}>Cân bằng lại</button>}</div>
          <p className="muted mix-help">Dễ: nhận biết, nhắc lại kiến thức · Trung bình: thông hiểu, vận dụng · Khó: vận dụng cao, suy luận nhiều bước.</p>
        </div>
        <label>Bộ câu hỏi dự kiến (tùy chọn)<select value={form.quizId} onChange={e => setForm({ ...form, quizId: e.target.value })}><option value="">Chọn khi duyệt</option>{quizzes.data?.map(quiz => <option key={quiz.id} value={quiz.id}>{quiz.title} · {quiz.questions.length} câu</option>)}</select><small className="muted">AI sẽ tránh lặp lại các câu đã có trong bộ này.</small></label>
        <label>Yêu cầu thêm cho AI (tùy chọn)<textarea rows={3} maxLength={2000} value={form.instructions} onChange={e => setForm({ ...form, instructions: e.target.value })} placeholder="Ví dụ: tập trung vào phần ứng dụng thực tế; dùng ví dụ về nông nghiệp thông minh; tránh câu tính toán."/></label>
        <button className="button primary" disabled={!enabled || !!busy || job.running || !sections.length || percentTotal !== 100 || selectedChars > MAX_CHARS}><Sparkles size={17}/>{job.running ? 'AI đang tạo câu hỏi…' : busy === 'generate' ? 'Đang gửi…' : `Tạo ${form.questionCount} câu hỏi`}</button>
        <JobProgress job={job.job} label="AI đang viết câu hỏi…"/>
      </form>}
    </div>
    <aside className="panel ai-history">
      <div className="panel-heading"><h2>Lượt tạo gần đây</h2></div>
      {jobs.loading ? <Loading/> : jobs.data?.length ? <ul>{jobs.data.map(item => <li key={item.id}><span className={`job-status job-${item.status.toLowerCase()}`}>{({ QUEUED: 'Đang chờ', RUNNING: `${item.progress}%`, SUCCEEDED: 'Hoàn tất', FAILED: 'Lỗi' } as const)[item.status]}</span><div><strong>{item.result ? `${item.result.created} câu đề xuất` : `${(item.input as { questionCount?: number }).questionCount ?? ''} câu`}</strong><small>{new Date(item.createdAt).toLocaleString('vi-VN')}</small>{item.error && <small className="danger-text">{item.error}</small>}{item.status === 'SUCCEEDED' && <Link to={`/ai?tab=review&job=${item.id}`} className="text-link">Xem để duyệt</Link>}</div></li>)}</ul> : <p className="muted ai-history-empty">Chưa có lượt tạo nào.</p>}
    </aside>
  </div>;
}

function ApproveModal({ ids, defaultQuizId, onClose, onDone }: { ids: string[]; defaultQuizId?: string | null; onClose: () => void; onDone: (message: string) => void }) {
  const quizzes = useResource<Quiz[]>('/quizzes');
  const [target, setTarget] = useState(defaultQuizId ?? ''); const [title, setTitle] = useState(''); const [duration, setDuration] = useState(30);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { if (!target && quizzes.data) setTarget(defaultQuizId ?? quizzes.data[0]?.id ?? 'new'); }, [quizzes.data]);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const result = await api<{ quizTitle: string; approved: number }>('/ai/generated/approve', json('POST', { ids, durationSeconds: duration, ...(target === 'new' ? { newQuizTitle: title } : { quizId: target }) }));
      onDone(`Đã thêm ${result.approved} câu vào “${result.quizTitle}”.`);
    } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  return <Modal title={`Duyệt ${ids.length} câu hỏi`} onClose={onClose}><form className="form-stack" onSubmit={submit}>
    {error && <ErrorNotice message={error}/>}
    <p className="muted">Các câu được duyệt sẽ được thêm vào cuối bộ câu hỏi bạn chọn.</p>
    {quizzes.loading ? <Loading/> : <label>Thêm vào bộ câu hỏi<select value={target} onChange={e => setTarget(e.target.value)}>{quizzes.data?.map(quiz => <option key={quiz.id} value={quiz.id}>{quiz.title} · {quiz.questions.length} câu</option>)}<option value="new">+ Tạo bộ câu hỏi mới</option></select></label>}
    {target === 'new' && <label>Tên bộ câu hỏi mới<input required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} placeholder="Ví dụ: Ôn tập chương 2 (AI)"/></label>}
    <label>Thời gian mỗi câu (giây)<input type="number" min={5} max={3600} value={duration} onChange={e => setDuration(Number(e.target.value))}/></label>
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Hủy</button><button className="button primary" disabled={busy || !target}><CheckCheck size={16}/>{busy ? 'Đang duyệt…' : 'Duyệt và thêm'}</button></div>
  </form></Modal>;
}

function ReviewQueue({ jobId, onChanged }: { jobId: string; onChanged: () => void }) {
  const [status, setStatus] = useState<ReviewStatus>('PENDING');
  const items = useResource<GeneratedQuestion[]>(`/ai/generated?status=${status}${jobId ? `&jobId=${jobId}` : ''}`);
  const [selected, setSelected] = useState<string[]>([]); const [approve, setApprove] = useState<string[] | null>(null);
  const [editing, setEditing] = useState<GeneratedQuestion | null>(null);
  const [notice, setNotice] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState('');
  const [jobQuiz, setJobQuiz] = useState<string | null>(null);
  useEffect(() => setSelected([]), [status, jobId, items.data]);
  // Approvals default to the quiz chosen when the questions were generated.
  useEffect(() => { setJobQuiz(null); if (jobId) api<AiJob>(`/ai/jobs/${jobId}`).then(job => setJobQuiz(typeof job.input.quizId === 'string' ? job.input.quizId : null)).catch(() => undefined); }, [jobId]);
  async function act(path: 'reject' | 'reopen', ids: string[]) {
    setBusy(path); setError('');
    try { await api(`/ai/generated/${path}`, json('POST', { ids })); setNotice(path === 'reject' ? `Đã loại ${ids.length} câu.` : `Đã đưa ${ids.length} câu về hàng chờ duyệt.`); await items.reload(); onChanged(); }
    catch (e) { setError(messageOf(e)); } finally { setBusy(''); }
  }
  async function saveEdit() {
    if (!editing) return;
    setBusy('edit'); setError('');
    try {
      const { content, optionA, optionB, optionC, optionD, type, correctAnswer, explanation, knowledge, topic, difficulty } = editing;
      await api(`/ai/generated/${editing.id}`, json('PATCH', { content, optionA, optionB, optionC, optionD, type, ...(correctAnswer ? { correctAnswer } : {}), explanation, knowledge, topic, difficulty }));
      setEditing(null); await items.reload();
    } catch (e) { setError(messageOf(e)); } finally { setBusy(''); }
  }
  const all = items.data ?? [];
  return <section>
    <div className="list-toolbar review-toolbar">
      <div className="tabs">{(['PENDING', 'APPROVED', 'REJECTED'] as ReviewStatus[]).map(value => <button key={value} className={status === value ? 'tab-active' : ''} onClick={() => setStatus(value)}>{({ PENDING: 'Chờ duyệt', APPROVED: 'Đã duyệt', REJECTED: 'Đã loại' } as const)[value]}</button>)}</div>
      {jobId && <Link to="/ai?tab=review" className="text-button"><X size={14}/>Bỏ lọc theo lượt tạo</Link>}
      {status === 'PENDING' && all.length > 0 && <div className="bulk-actions"><label className="check-all"><input type="checkbox" checked={selected.length === all.length} onChange={e => setSelected(e.target.checked ? all.map(item => item.id) : [])}/>Chọn tất cả ({all.length})</label><button className="button primary" disabled={!selected.length} onClick={() => setApprove(selected)}><CheckCheck size={16}/>Duyệt {selected.length || ''}</button><button className="button secondary" disabled={!selected.length || !!busy} onClick={() => { void act('reject', selected); }}><X size={16}/>Loại</button></div>}
    </div>
    {notice && <div className="import-notice"><Check size={17}/>{notice}</div>}
    {(error || items.error) && <ErrorNotice message={error || items.error} retry={items.reload}/>}
    {items.loading ? <Loading/> : !all.length ? <Empty title={status === 'PENDING' ? 'Không có câu hỏi chờ duyệt' : 'Chưa có câu hỏi'}>{status === 'PENDING' ? 'Tạo câu hỏi từ tài liệu, các đề xuất của AI sẽ xuất hiện ở đây để bạn duyệt.' : 'Các câu hỏi đã xử lý sẽ hiển thị tại đây.'}</Empty> : <div className="generated-list">{all.map((item, i) => {
      const problems = questionIssues({ ...item, durationSeconds: 30, order: 0 });
      return <article key={item.id} className={`panel generated-card ${selected.includes(item.id) ? 'generated-selected' : ''}`}>
        <div className="generated-top">
          {status === 'PENDING' && <input type="checkbox" aria-label={`Chọn câu ${i + 1}`} checked={selected.includes(item.id)} onChange={e => setSelected(e.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))}/>}
          <span className="small-label">ĐỀ XUẤT {String(i + 1).padStart(2, '0')}</span>
          <span className="question-tags"><TypeBadge value={item.type}/><DifficultyBadge value={item.difficulty}/>{item.topic && <span className="tag">{item.topic}</span>}</span>
          {item.documentName && <span className="generated-source"><FileText size={13}/>{item.documentName}</span>}
        </div>
        {item.duplicate && <p className="duplicate-hint"><Copy size={13}/>Có thể trùng với câu trong “{item.duplicate.quizTitle}” ({Math.round(item.duplicate.similarity * 100)}%): {item.duplicate.content.slice(0, 120)}</p>}
        {problems.length > 0 && <ul className="question-issues">{problems.map(problem => <li key={problem}><AlertTriangle size={13}/>{problem}</li>)}</ul>}
        <h3>{item.content}</h3>
        <Options question={item} reveal explain/>
        {item.knowledge && <p className="knowledge-line"><b>Kiến thức kiểm tra:</b> {item.knowledge}</p>}
        {item.sourceExcerpt && <blockquote className="source-excerpt"><Quote size={13}/>{item.sourceExcerpt}</blockquote>}
        <div className="generated-actions">
          {status === 'PENDING' && <><button className="text-button" onClick={() => setEditing(item)}><Pencil size={15}/>Sửa</button><button className="text-button danger-text" disabled={!!busy} onClick={() => { void act('reject', [item.id]); }}><X size={15}/>Loại</button><button className="button primary small" disabled={problems.length > 0} onClick={() => setApprove([item.id])}><Check size={15}/>Duyệt</button></>}
          {status === 'APPROVED' && item.quizId && <Link className="text-link" to={`/quizzes/${item.quizId}`}>Mở bộ câu hỏi</Link>}
          {status === 'REJECTED' && <button className="text-button" disabled={!!busy} onClick={() => { void act('reopen', [item.id]); }}><RotateCcw size={15}/>Khôi phục</button>}
        </div>
      </article>;
    })}</div>}
    {approve && <ApproveModal ids={approve} defaultQuizId={jobQuiz} onClose={() => setApprove(null)} onDone={message => { setApprove(null); setNotice(message); void items.reload(); onChanged(); }}/>}
    {editing && <Modal wide title="Sửa câu hỏi đề xuất" onClose={() => setEditing(null)}><div className="form-stack question-edit">
      <QuestionFields value={editing} label="câu đề xuất" showDuration={false} onChange={patch => setEditing({ ...editing, ...patch })}/>
      <div className="modal-actions"><button className="button secondary" onClick={() => setEditing(null)}>Hủy</button><button className="button primary" disabled={busy === 'edit'} onClick={() => { void saveEdit(); }}>{busy === 'edit' ? 'Đang lưu…' : 'Lưu thay đổi'}</button></div>
    </div></Modal>}
  </section>;
}
