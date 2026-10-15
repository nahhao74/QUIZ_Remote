import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, ClipboardCheck, Clock3, Copy, Eye, FileSpreadsheet, FileText, FileUp, GraduationCap, Pencil, Play, Plus, Save, Search, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { findDuplicatePairs, MISSING_KEY_ISSUE, questionIssues, QUESTION_LIMITS, QUESTION_TEXT_SAMPLE, type AiJob, type AiStatus, type AnswerKey, type ImportResult, type QuestionDraft, type Quiz, type QuizInput } from '@classpulse/shared-types';
import { api, downloadApiFile, json, upload } from '../api';
import { useAiJob, useResource } from '../hooks';
import { CreateSession } from '../components/create-session';
import { Empty, ErrorNotice, Loading, Modal, PageHeading, dateLabel, jobElapsed, messageOf } from '../components/ui';
import { Options } from '../components/session-ui';
import { DifficultyBadge, QuestionFields, TypeBadge } from '../components/question-form';
import { QuizCard } from './dashboard';
export function QuizList() {const resource=useResource<Quiz[]>('/quizzes');const [search,setSearch]=useState('');const [selected,setSelected]=useState<string>();const visible=resource.data?.filter(q=>(q.title+' '+q.description).toLowerCase().includes(search.toLowerCase()))??[];return <><PageHeading eyebrow="Ý TƯỞNG BẮT ĐẦU TỪ ĐÂY" title="Bộ câu hỏi của bạn" description="Chuẩn bị kiến thức. Khơi mở những cuộc trò chuyện." actions={<><Link className="button secondary" to="/ai"><Sparkles size={18}/>Tạo bằng AI</Link><Link className="button primary" to="/quizzes/new"><Plus size={18}/>Tạo bộ câu hỏi</Link></>}/><div className="list-toolbar"><span className="list-count">Tất cả bộ câu hỏi <b>{resource.data?.length??0}</b></span><label className="search-input"><Search size={17}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Tìm kiếm bộ câu hỏi…"/></label></div>{resource.error&&<ErrorNotice message={resource.error} retry={resource.reload}/>} {resource.loading?<Loading/>:visible.length?<div className="quiz-grid">{visible.map((q,i)=><QuizCard key={q.id} quiz={q} index={i} onStart={()=>setSelected(q.id)}/>)}</div>:<Empty title={search?'Không tìm thấy bộ câu hỏi':'Bắt đầu với một câu hỏi hay'} action={!search&&<Link className="button primary" to="/quizzes/new"><Plus size={16}/>Tạo bộ câu hỏi</Link>}>{search?'Thử một từ khóa khác nhé.':'Thêm câu hỏi trắc nghiệm để sẵn sàng cho buổi học tiếp theo.'}</Empty>}{selected&&<CreateSession quizId={selected} onClose={()=>setSelected(undefined)}/>}</>;}

type Draft = QuestionDraft & { key: string };
let draftSequence = 0;
const toDraft = (q: QuestionDraft): Draft => ({ type: 'SINGLE', explanation: '', knowledge: '', topic: '', difficulty: null, origin: 'MANUAL', ...q, key: `q${++draftSequence}` });
const blankQuestion = (order: number) => toDraft({ content: '', optionA: '', optionB: '', optionC: '', optionD: '', correctAnswer: '', durationSeconds: 30, order });
const isBlank = (q: Draft) => !q.content && !q.optionA && !q.optionB && !q.optionC && !q.optionD;
type ImportSummary = { sourceName: string; added: number; warnings: string[]; ai: boolean };
function downloadText(name: string, text: string) { const url = URL.createObjectURL(new Blob([`\uFEFF${text}`], { type: 'text/plain;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url); }

export function QuizEditor() {
  const { id } = useParams(); const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null); const aiInput = useRef<HTMLInputElement>(null);
  const [quiz, setQuiz] = useState<{ title: string; description: string; questions: Draft[] }>({ title: '', description: '', questions: [blankQuestion(0)] });
  const [loading, setLoading] = useState(!!id); const [error, setError] = useState(''); const [busy, setBusy] = useState(''); const [active, setActive] = useState(0);
  const [summary, setSummary] = useState<ImportSummary | null>(null); const [showIssues, setShowIssues] = useState(false); const [templates, setTemplates] = useState(false);
  const ai = useResource<AiStatus>('/ai/status');
  const extraction = useAiJob<ImportResult>(null, job => { if (job.status === 'SUCCEEDED' && job.result) merge(job.result, true); else setError(job.error || 'AI không nhận dạng được câu hỏi.'); });
  useEffect(() => { if (!id) return; let alive = true; api<Quiz>(`/quizzes/${id}`).then(q => { if (alive) setQuiz({ title: q.title, description: q.description, questions: q.questions.map(({ id: _id, ...question }) => toDraft(question)) }); }).catch(e => { if (alive) setError(messageOf(e)); }).finally(() => { if (alive) setLoading(false); }); return () => { alive = false; }; }, [id]);
  const issues = useMemo(() => quiz.questions.map(q => questionIssues(q)), [quiz.questions]);
  const duplicates = useMemo(() => {
    const index = new Map(quiz.questions.map((q, i) => [q.key, i]));
    const hints = new Map<string, string>();
    for (const pair of findDuplicatePairs(quiz.questions.filter(q => q.content.trim().length > 10).map(q => ({ id: q.key, content: q.content, options: [q.optionA, q.optionB, q.optionC, q.optionD] })), 0.8)) {
      const [a, b] = [index.get(pair.a)!, index.get(pair.b)!].sort((x, y) => x - y);
      if (!hints.has(quiz.questions[b].key)) hints.set(quiz.questions[b].key, `Có thể trùng với câu ${a + 1} (giống ${Math.round(pair.score * 100)}%).`);
    }
    return hints;
  }, [quiz.questions]);
  function edit(index: number, patch: Partial<Draft>) { setQuiz(q => ({ ...q, questions: q.questions.map((item, i) => i === index ? { ...item, ...patch } : item) })); }
  function move(index: number, step: number) { const next = [...quiz.questions]; [next[index], next[index + step]] = [next[index + step], next[index]]; setQuiz({ ...quiz, questions: next }); setActive(index + step); }
  function remove(index: number) { setQuiz({ ...quiz, questions: quiz.questions.filter((_, i) => i !== index) }); setActive(Math.max(0, active - (active >= index ? 1 : 0))); }
  function add() { setQuiz(q => ({ ...q, questions: [...q.questions, blankQuestion(q.questions.length)] })); setActive(quiz.questions.length); }
  function focus(index: number) { setActive(index); document.getElementById(`question-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  function merge(result: ImportResult, viaAi = false) {
    const kept = quiz.questions.length === 1 && isBlank(quiz.questions[0]) ? [] : quiz.questions;
    const room = QUESTION_LIMITS.questionsPerQuiz - kept.length;
    const incoming = result.questions.slice(0, Math.max(0, room)).map(toDraft);
    const warnings = room < result.questions.length ? [`Chỉ thêm ${incoming.length}/${result.questions.length} câu vì mỗi bộ tối đa ${QUESTION_LIMITS.questionsPerQuiz} câu.`, ...result.warnings] : result.warnings;
    setQuiz({ title: quiz.title.trim() ? quiz.title : result.title, description: quiz.description.trim() ? quiz.description : result.description, questions: [...kept, ...incoming] });
    setSummary({ sourceName: result.sourceName, added: incoming.length, warnings, ai: viaAi });
    if (incoming.length) { setActive(kept.length); setShowIssues(true); }
  }
  async function importFile(file: File, viaAi: boolean) {
    setError(''); setSummary(null); setBusy(viaAi ? 'ai' : 'import');
    try { if (viaAi) extraction.start(await upload<AiJob<ImportResult>>('/imports/questions/ai', file)); else merge(await upload<ImportResult>('/imports/questions', file)); }
    catch (e) { setError(messageOf(e)); }
    finally { setBusy(''); for (const input of [fileInput.current, aiInput.current]) if (input) input.value = ''; }
  }
  async function template(kind: 'xlsx' | 'docx' | 'txt') {
    setTemplates(false);
    try { if (kind === 'txt') downloadText('mau-cau-hoi-classpulse.txt', QUESTION_TEXT_SAMPLE); else await downloadApiFile(`/imports/template.${kind}`, `mau-cau-hoi-classpulse.${kind}`); }
    catch (e) { setError(messageOf(e)); }
  }
  async function save(e: FormEvent) {
    e.preventDefault(); setError('');
    if (!quiz.questions.length) { setError('Thêm ít nhất một câu hỏi trước khi lưu.'); return; }
    const first = issues.findIndex(list => list.length);
    if (first >= 0) { setShowIssues(true); setError(`Còn ${issues.filter(list => list.length).length} câu cần sửa. Câu ${first + 1}: ${issues[first][0]}`); focus(first); return; }
    setBusy('save');
    try {
      const body: QuizInput = { title: quiz.title.trim(), description: quiz.description, questions: quiz.questions.map(({ key, ...q }, i) => ({ ...q, order: i, content: q.content.trim(), optionA: q.optionA.trim(), optionB: q.optionB.trim(), optionC: q.optionC.trim(), optionD: q.optionD.trim(),
        correctAnswer: q.correctAnswer as AnswerKey, explanation: q.explanation?.trim() ?? '', knowledge: q.knowledge?.trim() ?? '', topic: q.topic?.trim() ?? '' })) };
      const saved = await api<Quiz>(id ? `/quizzes/${id}` : '/quizzes', json(id ? 'PATCH' : 'POST', body));
      navigate(`/quizzes/${saved.id}`);
    } catch (e) { setError(messageOf(e)); } finally { setBusy(''); }
  }
  if (loading) return <Loading/>;
  const aiEnabled = !!ai.data?.enabled;
  const problemCount = issues.filter(list => list.length).length;
  return <form onSubmit={save}>
    <Link className="back-link" to={id ? `/quizzes/${id}` : '/quizzes'}><ArrowLeft size={16}/>Quay lại bộ câu hỏi</Link>
    <input ref={fileInput} type="file" accept=".txt,.docx,.xlsx,.csv,.pdf" hidden onChange={e => { const file = e.target.files?.[0]; if (file) void importFile(file, false); }}/>
    <input ref={aiInput} type="file" accept=".docx,.pdf,.txt" hidden onChange={e => { const file = e.target.files?.[0]; if (file) void importFile(file, true); }}/>
    <PageHeading eyebrow="XÂY DỰNG KIẾN THỨC" title={id ? 'Chỉnh sửa bộ câu hỏi' : 'Tạo bộ câu hỏi mới'} description="Mỗi câu hỏi nhỏ, một cơ hội để hiểu lớp học hơn." actions={<><Link className="button secondary" to={id ? `/quizzes/${id}` : '/quizzes'}>Hủy</Link><button className="button primary" disabled={!!busy}><Save size={17}/>{busy === 'save' ? 'Đang lưu…' : 'Lưu bộ câu hỏi'}</button></>}/>
    {error && <ErrorNotice message={error}/>}
    {extraction.running && <div className="progress-notice"><Sparkles size={17}/><span>AI đang nhận dạng câu hỏi từ tài liệu… {extraction.job?.progress ?? 0}%{extraction.job?.startedAt ? ` · ${jobElapsed(extraction.job)}` : ''}</span><div className="progress-bar"><span style={{ width: `${Math.max(5, extraction.job?.progress ?? 0)}%` }}/></div></div>}
    {summary && <ImportReport summary={summary} onClose={() => setSummary(null)}/>}
    <section className="panel quiz-info form-stack">
      <h2>Thông tin bộ câu hỏi</h2>
      <label>Tên bộ câu hỏi<input required maxLength={200} placeholder="Ví dụ: Khám phá Internet of Things" value={quiz.title} onChange={e => setQuiz({ ...quiz, title: e.target.value })}/></label>
      <label>Mô tả<textarea rows={2} maxLength={4000} placeholder="Chủ đề, mục tiêu hoặc một lời giới thiệu ngắn…" value={quiz.description} onChange={e => setQuiz({ ...quiz, description: e.target.value })}/></label>
      <div className="import-panel">
        <div className="import-panel-copy"><FileUp size={20}/><div><strong>Nhập câu hỏi từ Word, Excel, PDF hoặc TXT</strong><span>Nhận dạng “Câu 1:”, các phương án A–D, dòng “Đáp án:”, bảng đáp án cuối tài liệu, phương án gạch chân/tô màu trong Word và nhiều đáp án như “A, C”. Câu nhập vào vẫn được kiểm tra trước khi lưu.</span></div></div>
        <div className="import-actions">
          <button type="button" className="button secondary" disabled={!!busy} onClick={() => fileInput.current?.click()}><FileUp size={16}/>{busy === 'import' ? 'Đang đọc file…' : 'Nhập từ file'}</button>
          <button type="button" className="button secondary" disabled={!!busy || extraction.running || !aiEnabled} title={aiEnabled ? 'Dùng AI cho tài liệu trình bày phức tạp hoặc PDF scan' : 'Chưa cấu hình AI trên máy chủ (GEMINI_API_KEY hoặc OLLAMA_URL)'} onClick={() => aiInput.current?.click()}><Wand2 size={16}/>{busy === 'ai' ? 'Đang tải lên…' : 'Nhận dạng bằng AI'}</button>
          <div className="dropdown"><button type="button" className="text-button" onClick={() => setTemplates(!templates)} aria-expanded={templates}>File mẫu<ChevronDown size={14}/></button>{templates && <div className="dropdown-menu" role="menu"><button type="button" role="menuitem" onClick={() => { void template('xlsx'); }}><FileSpreadsheet size={15}/>Mẫu Excel (.xlsx)</button><button type="button" role="menuitem" onClick={() => { void template('docx'); }}><FileText size={15}/>Mẫu Word (.docx)</button><button type="button" role="menuitem" onClick={() => { void template('txt'); }}><FileText size={15}/>Mẫu văn bản (.txt)</button></div>}</div>
        </div>
      </div>
    </section>
    <div className="editor-layout">
      <aside className="panel question-nav"><h3>Câu hỏi <span>{quiz.questions.length}</span></h3>{quiz.questions.map((q, i) => <button type="button" className={active === i ? 'question-nav-active' : ''} key={q.key} onClick={() => focus(i)}><b>{i + 1}</b><span>{q.content || 'Câu hỏi chưa đặt tên'}</span>{(showIssues && issues[i].length > 0 || duplicates.has(q.key)) && <i className="nav-warning" aria-label="Cần kiểm tra"/>}</button>)}<button className="add-question-small" type="button" disabled={quiz.questions.length >= QUESTION_LIMITS.questionsPerQuiz} onClick={add}><Plus size={16}/>Thêm câu hỏi</button></aside>
      <div className="question-edit-list">
        {quiz.questions.map((q, i) => <section id={`question-${i}`} className={`panel question-edit ${active === i ? 'question-edit-active' : ''} ${showIssues && issues[i].length ? 'question-edit-invalid' : ''}`} key={q.key} onFocus={() => setActive(i)}>
          <div className="question-edit-heading"><span><span className="question-number">{String(i + 1).padStart(2, '0')}</span><h3>Câu hỏi {i + 1}</h3>{q.origin === 'AI' && <span className="tag tag-ai"><Sparkles size={11}/>AI</span>}{q.origin === 'IMPORT' && <span className="tag">Nhập file</span>}</span><div><button className="icon-button" type="button" disabled={i === 0} title="Di chuyển lên" onClick={() => move(i, -1)}><ArrowUp size={16}/></button><button className="icon-button" type="button" disabled={i === quiz.questions.length - 1} title="Di chuyển xuống" onClick={() => move(i, 1)}><ArrowDown size={16}/></button><button className="icon-button danger-text" type="button" title="Xóa câu hỏi" onClick={() => remove(i)}><Trash2 size={16}/></button></div></div>
          {/* QuestionFields already shows the missing-key hint inline under the options. */}{showIssues && issues[i].some(issue => issue !== MISSING_KEY_ISSUE) && <ul className="question-issues">{issues[i].filter(issue => issue !== MISSING_KEY_ISSUE).map(issue => <li key={issue}><AlertTriangle size={13}/>{issue}</li>)}</ul>}
          {duplicates.has(q.key) && <p className="duplicate-hint"><Copy size={13}/>{duplicates.get(q.key)}</p>}
          <QuestionFields value={q} label={`câu ${i + 1}`} onChange={patch => edit(i, patch)}/>
        </section>)}
        <button type="button" className="add-question" disabled={quiz.questions.length >= QUESTION_LIMITS.questionsPerQuiz} onClick={add}><Plus size={19}/>Thêm câu hỏi mới</button>
        <div className="editor-bottom"><span className="muted">{quiz.questions.length} câu hỏi{problemCount ? ` · ${problemCount} câu cần hoàn thiện` : ' · Sẵn sàng cho lớp học của bạn'}</span><button className="button primary" disabled={!!busy}><Save size={17}/>{busy === 'save' ? 'Đang lưu…' : 'Lưu bộ câu hỏi'}</button></div>
      </div>
    </div>
  </form>;
}
function ImportReport({ summary, onClose }: { summary: ImportSummary; onClose: () => void }) {
  const [open, setOpen] = useState(summary.warnings.length <= 5);
  return <div className={`import-notice ${summary.added ? '' : 'import-notice-warning'}`}>
    {summary.added ? <Check size={17}/> : <AlertTriangle size={17}/>}
    <div className="grow"><strong>{summary.added ? `Đã ${summary.ai ? 'nhận dạng bằng AI' : 'nhập'} ${summary.added} câu hỏi từ ${summary.sourceName}.` : `Không thêm được câu hỏi nào từ ${summary.sourceName}.`}</strong> {summary.added ? 'Hãy kiểm tra các câu được đánh dấu rồi bấm Lưu bộ câu hỏi.' : ''}
      {summary.warnings.length > 0 && <><button type="button" className="text-button" onClick={() => setOpen(!open)}>{open ? 'Ẩn' : 'Xem'} {summary.warnings.length} lưu ý</button>{open && <ul>{summary.warnings.slice(0, 50).map((warning, i) => <li key={i}>{warning}</li>)}</ul>}</>}
    </div>
    <button type="button" className="icon-button" aria-label="Đóng thông báo" onClick={onClose}>×</button>
  </div>;
}

export function QuizDetail(){const {id=''}=useParams();const resource=useResource<Quiz>(`/quizzes/${id}`);const navigate=useNavigate();const [create,setCreate]=useState(false);const [preview,setPreview]=useState(false);const [index,setIndex]=useState(0);const [reveal,setReveal]=useState(false);const [deleteOpen,setDeleteOpen]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');async function act(remove=false){setBusy(true);setError('');try{if(remove){await api(`/quizzes/${id}`,json('DELETE'));navigate('/quizzes');}else{const q=await api<Quiz>(`/quizzes/${id}/duplicate`,json('POST'));navigate(`/quizzes/${q.id}`);}}catch(e){setError(messageOf(e));}finally{setBusy(false);}}if(resource.loading)return <Loading/>;if(!resource.data)return <ErrorNotice message={resource.error||'Không tìm thấy bộ câu hỏi.'} retry={resource.reload}/>;const q=resource.data;const multiple=q.questions.filter(item=>item.type==='MULTIPLE').length;return <><Link className="back-link" to="/quizzes"><ArrowLeft size={16}/>Tất cả bộ câu hỏi</Link><PageHeading eyebrow="BỘ CÂU HỎI" title={q.title} description={q.description||'Một bộ câu hỏi dành cho lớp học của bạn.'} actions={<><Link className="button secondary" to={`/quizzes/${id}/edit`}><Pencil size={16}/>Chỉnh sửa</Link><Link className="button secondary" to={`/quizzes/${id}/quality`}><ClipboardCheck size={16}/>Đánh giá chất lượng</Link><button className="button primary" disabled={!q.questions.length} onClick={()=>setCreate(true)}><Play size={16}/>Tạo buổi học</button></>}/>{error&&<ErrorNotice message={error}/>}<div className="quiz-detail-toolbar"><span><BookOpen size={16}/>{q.questions.length} câu hỏi{multiple?` · ${multiple} câu nhiều đáp án`:''}</span><span><Clock3 size={16}/>Cập nhật {dateLabel(q.updatedAt)}</span><div className="grow"/><button className="text-button" disabled={!q.questions.length} onClick={()=>{setIndex(0);setReveal(false);setPreview(true);}}><Eye size={16}/>Xem trước</button><Link className="text-button" to={`/exams?quiz=${id}`}><GraduationCap size={16}/>Tạo kỳ thi</Link><button className="text-button" disabled={busy} onClick={()=>{void act();}}><Copy size={16}/>Nhân bản</button><button className="text-button danger-text" onClick={()=>setDeleteOpen(true)}><Trash2 size={16}/>Xóa</button></div><div className="quiz-detail-questions">{q.questions.map((question,i)=><section className="panel detail-question" key={question.id}><div className="detail-question-top"><span className="small-label">CÂU HỎI {String(i+1).padStart(2,'0')}</span><span className="question-tags"><TypeBadge value={question.type}/><DifficultyBadge value={question.difficulty}/>{question.topic&&<span className="tag">{question.topic}</span>}{question.origin==='AI'&&<span className="tag tag-ai"><Sparkles size={11}/>AI</span>}</span><span><Clock3 size={14}/>{question.durationSeconds} giây</span></div><h2>{question.content}</h2><Options question={question} reveal explain/>{question.knowledge&&<p className="knowledge-line"><b>Kiến thức kiểm tra:</b> {question.knowledge}</p>}</section>)}</div>{create&&<CreateSession quizId={id} onClose={()=>setCreate(false)}/>} {deleteOpen&&<Modal title="Xóa bộ câu hỏi?" onClose={()=>setDeleteOpen(false)}><p className="muted">“{q.title}” sẽ được gỡ khỏi thư viện. Lịch sử những buổi học trước vẫn được lưu.</p><div className="modal-actions"><button className="button secondary" onClick={()=>setDeleteOpen(false)}>Hủy</button><button className="button danger" disabled={busy} onClick={()=>{void act(true);}}>{busy?'Đang xóa…':'Xóa bộ câu hỏi'}</button></div></Modal>}{preview&&q.questions[index]&&<Modal wide title={`Xem trước · Câu ${index+1}/${q.questions.length}`} onClose={()=>setPreview(false)}><div className="preview-question"><h2>{q.questions[index].content}</h2><Options question={q.questions[index]} reveal={reveal} explain/></div><div className="preview-footer"><button className="button secondary" onClick={()=>setReveal(!reveal)}><Eye size={16}/>{reveal?'Ẩn đáp án':'Hiện đáp án'}</button><div><button className="icon-button" aria-label="Câu trước" disabled={index===0} onClick={()=>{setIndex(index-1);setReveal(false);}}><ChevronLeft/></button><button className="icon-button" aria-label="Câu sau" disabled={index===q.questions.length-1} onClick={()=>{setIndex(index+1);setReveal(false);}}><ChevronRight/></button></div></div></Modal>}</>;}
