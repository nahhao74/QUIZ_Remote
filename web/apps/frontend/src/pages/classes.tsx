import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Download, FileSpreadsheet, Pencil, Plus, Save, School, Trash2, Users, X } from 'lucide-react';
import type { Classroom, ClassReport, Student } from '@classpulse/shared-types';
import { api, downloadApiFile, json, upload } from '../api';
import { useResource } from '../hooks';
import { Empty, ErrorNotice, Loading, Modal, PageHeading, dateLabel, messageOf } from '../components/ui';
import { ScoreCards, ScoreHistogram } from '../components/analysis';

function ClassForm({ initial, onClose, onSaved }: { initial?: Classroom; onClose: () => void; onSaved: (classroom: Classroom) => void }) {
  const [name, setName] = useState(initial?.name ?? ''); const [description, setDescription] = useState(initial?.description ?? '');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { onSaved(await api<Classroom>(initial ? `/classes/${initial.id}` : '/classes', json(initial ? 'PATCH' : 'POST', { name, description }))); }
    catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  return <Modal title={initial ? 'Sửa thông tin lớp' : 'Tạo lớp học'} onClose={onClose}><form className="form-stack" onSubmit={submit}>
    {error && <ErrorNotice message={error}/>}
    <label>Tên lớp<input required maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder="Ví dụ: 10A1 · IoT căn bản K24"/></label>
    <label>Ghi chú<textarea rows={2} maxLength={1000} value={description} onChange={e => setDescription(e.target.value)} placeholder="Năm học, học phần…"/></label>
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Hủy</button><button className="button primary" disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu lớp'}</button></div>
  </form></Modal>;
}
export function ClassListPage() {
  const classes = useResource<Classroom[]>('/classes'); const navigate = useNavigate();
  const [create, setCreate] = useState(false);
  return <>
    <PageHeading eyebrow="LỚP HỌC" title="Lớp học và danh sách sinh viên" description="Gán mã thiết bị (01–99) cho từng sinh viên để báo cáo hiện họ tên và thống kê điểm theo lớp." actions={<button className="button primary" onClick={() => setCreate(true)}><Plus size={18}/>Tạo lớp</button>}/>
    {classes.error && <ErrorNotice message={classes.error} retry={classes.reload}/>}
    {classes.loading ? <Loading/> : classes.data?.length ? <div className="class-grid">{classes.data.map(item => <Link key={item.id} to={`/classes/${item.id}`} className="panel class-card"><span className="class-icon"><School size={22}/></span><div><h3>{item.name}</h3><p>{item.description || 'Chưa có ghi chú'}</p><span className="class-stats"><Users size={13}/>{item.studentCount} sinh viên · {item.sessionCount} buổi học</span></div></Link>)}</div>
      : <Empty title="Chưa có lớp học" action={<button className="button primary" onClick={() => setCreate(true)}><Plus size={16}/>Tạo lớp đầu tiên</button>}>Tạo lớp và nhập danh sách sinh viên từ Excel để theo dõi điểm theo lớp.</Empty>}
    {create && <ClassForm onClose={() => setCreate(false)} onSaved={classroom => navigate(`/classes/${classroom.id}`)}/>}
  </>;
}

type Row = { code: string; name: string; externalId: string };
export function ClassDetailPage() {
  const { id = '' } = useParams(); const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'report' ? 'report' : 'roster';
  const classroom = useResource<Classroom>(`/classes/${id}`);
  const [editing, setEditing] = useState(false); const [deleting, setDeleting] = useState(false); const [error, setError] = useState('');
  async function remove() {
    try { await api(`/classes/${id}`, json('DELETE')); navigate('/classes'); } catch (e) { setError(messageOf(e)); }
  }
  if (classroom.loading && !classroom.data) return <Loading/>;
  if (!classroom.data) return <ErrorNotice message={classroom.error || 'Không tìm thấy lớp học.'} retry={classroom.reload}/>;
  return <>
    <Link className="back-link" to="/classes"><ArrowLeft size={16}/>Tất cả lớp học</Link>
    <PageHeading eyebrow="LỚP HỌC" title={classroom.data.name} description={classroom.data.description || `${classroom.data.studentCount} sinh viên · ${classroom.data.sessionCount} buổi học`} actions={<><button className="button secondary" onClick={() => setEditing(true)}><Pencil size={16}/>Sửa</button><button className="button secondary danger-text" onClick={() => setDeleting(true)}><Trash2 size={16}/>Xóa lớp</button></>}/>
    {error && <ErrorNotice message={error}/>}
    <div className="tabs page-tabs"><button className={tab === 'roster' ? 'tab-active' : ''} onClick={() => setParams({})}><Users size={14}/>Danh sách ({classroom.data.studentCount})</button><button className={tab === 'report' ? 'tab-active' : ''} onClick={() => setParams({ tab: 'report' })}><FileSpreadsheet size={14}/>Thống kê điểm</button></div>
    {tab === 'roster' ? <Roster classroom={classroom.data} onSaved={classroom.setData}/> : <ClassReportView id={id}/>}
    {editing && <ClassForm initial={classroom.data} onClose={() => setEditing(false)} onSaved={saved => { classroom.setData(saved); setEditing(false); }}/>}
    {deleting && <Modal title="Xóa lớp học?" onClose={() => setDeleting(false)}><p className="muted">Lớp “{classroom.data.name}” sẽ bị ẩn. Các buổi học và kết quả cũ vẫn được giữ.</p><div className="modal-actions"><button className="button secondary" onClick={() => setDeleting(false)}>Hủy</button><button className="button danger" onClick={() => { void remove(); }}>Xóa lớp</button></div></Modal>}
  </>;
}
function Roster({ classroom, onSaved }: { classroom: Classroom; onSaved: (classroom: Classroom) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [preview, setPreview] = useState<{ students: Row[]; warnings: string[] } | null>(null);
  const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const students: Student[] = classroom.students ?? [];
  const nextCode = (list: Array<{ code: string }>) => Array.from({ length: 99 }, (_, i) => String(i + 1).padStart(2, '0')).find(code => !list.some(item => item.code === code)) ?? '';
  async function save(list: Row[], replace: boolean) {
    setBusy('save'); setError('');
    try { onSaved(await api<Classroom>(`/classes/${classroom.id}/students`, json('POST', { students: list.filter(row => row.name.trim()).map(row => ({ ...row, name: row.name.trim() })), replace }))); setRows(null); setPreview(null); }
    catch (e) { setError(messageOf(e)); } finally { setBusy(''); }
  }
  async function importFile(file: File) {
    setBusy('import'); setError('');
    try { setPreview(await upload<{ students: Row[]; warnings: string[] }>(`/classes/${classroom.id}/students/import`, file)); }
    catch (e) { setError(messageOf(e)); } finally { setBusy(''); if (fileInput.current) fileInput.current.value = ''; }
  }
  async function removeStudent(studentId: string) {
    setBusy(studentId); setError('');
    try { onSaved(await api<Classroom>(`/classes/${classroom.id}/students/${studentId}`, json('DELETE'))); } catch (e) { setError(messageOf(e)); } finally { setBusy(''); }
  }
  const editRows = rows ?? students.map(({ code, name, externalId }) => ({ code, name, externalId }));
  const edit = (index: number, patch: Partial<Row>) => setRows(editRows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return <section className="panel roster">
    <div className="panel-heading"><h2>Danh sách sinh viên</h2><div className="roster-actions">
      <input ref={fileInput} type="file" hidden accept=".xlsx,.csv" onChange={e => { const file = e.target.files?.[0]; if (file) void importFile(file); }}/>
      <button className="button secondary small" disabled={!!busy} onClick={() => fileInput.current?.click()}><FileSpreadsheet size={15}/>{busy === 'import' ? 'Đang đọc…' : 'Nhập từ Excel'}</button>
      {rows ? <><button className="button secondary small" onClick={() => setRows(null)}><X size={15}/>Hủy</button><button className="button primary small" disabled={!!busy} onClick={() => { void save(editRows, true); }}><Save size={15}/>{busy === 'save' ? 'Đang lưu…' : 'Lưu danh sách'}</button></>
        : <button className="button primary small" onClick={() => setRows([...editRows, { code: nextCode(editRows), name: '', externalId: '' }])}><Plus size={15}/>Thêm sinh viên</button>}
    </div></div>
    {error && <div className="roster-body"><ErrorNotice message={error}/></div>}
    <p className="muted roster-help">Sinh viên nhập <b>mã 2 chữ số</b> này trên thiết bị khi tham gia. File Excel cần cột “Họ và tên”, tùy chọn “STT” (dùng làm mã thiết bị) và “Mã SV”.</p>
    {editRows.length ? <div className="table-scroll"><table className="session-table roster-table"><thead><tr><th>MÃ THIẾT BỊ</th><th>HỌ VÀ TÊN</th><th>MÃ SV/HS</th><th/></tr></thead><tbody>{editRows.map((row, i) => rows
      ? <tr key={i}><td><input aria-label="Mã thiết bị" value={row.code} maxLength={2} inputMode="numeric" onChange={e => edit(i, { code: e.target.value.replace(/\D/g, '') })}/></td><td><input aria-label="Họ và tên" value={row.name} maxLength={120} onChange={e => edit(i, { name: e.target.value })}/></td><td><input aria-label="Mã sinh viên" value={row.externalId} maxLength={60} onChange={e => edit(i, { externalId: e.target.value })}/></td><td><button className="icon-button danger-text" aria-label="Bỏ dòng" onClick={() => setRows(editRows.filter((_, k) => k !== i))}><X size={15}/></button></td></tr>
      : <tr key={row.code}><td><code className="room-code-small">{row.code}</code></td><td>{row.name}</td><td>{row.externalId}</td><td><button className="icon-button" aria-label="Sửa danh sách" onClick={() => setRows(editRows)}><Pencil size={14}/></button><button className="icon-button danger-text" aria-label={`Xóa ${row.name}`} disabled={!!busy} onClick={() => { const student = students.find(s => s.code === row.code); if (student) void removeStudent(student.id); }}><Trash2 size={14}/></button></td></tr>)}</tbody></table></div>
      : <Empty title="Lớp chưa có sinh viên">Thêm từng sinh viên hoặc nhập danh sách từ Excel.</Empty>}
    {preview && <Modal wide title={`Nhập ${preview.students.length} sinh viên`} onClose={() => setPreview(null)}>
      {preview.warnings.length > 0 && <ul className="question-issues">{preview.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
      <div className="table-scroll roster-preview"><table className="session-table"><thead><tr><th>MÃ</th><th>HỌ VÀ TÊN</th><th>MÃ SV/HS</th></tr></thead><tbody>{preview.students.map(row => <tr key={row.code}><td>{row.code}</td><td>{row.name}</td><td>{row.externalId}</td></tr>)}</tbody></table></div>
      <div className="modal-actions"><button className="button secondary" onClick={() => setPreview(null)}>Hủy</button><button className="button secondary" disabled={!!busy} onClick={() => { void save(preview.students, false); }}>Gộp vào danh sách hiện có</button><button className="button primary" disabled={!!busy} onClick={() => { void save(preview.students, true); }}>Thay toàn bộ danh sách</button></div>
    </Modal>}
  </section>;
}
function ClassReportView({ id }: { id: string }) {
  const report = useResource<ClassReport>(`/classes/${id}/report`);
  const [error, setError] = useState('');
  if (report.loading) return <Loading/>;
  if (!report.data) return <ErrorNotice message={report.error || 'Không tải được thống kê.'} retry={report.reload}/>;
  const data = report.data;
  if (!data.sessions.length) return <Empty title="Chưa có buổi học đã kết thúc">Khi mở buổi học, chọn lớp này để điểm của sinh viên được tổng hợp tại đây.</Empty>;
  return <>
    {error && <ErrorNotice message={error}/>}
    <div className="report-toolbar"><span className="muted">{data.sessions.length} buổi học đã kết thúc · điểm thang 10, câu nhiều đáp án chỉ tính đúng khi chọn đủ</span><button className="button secondary small" onClick={() => { downloadApiFile(`/classes/${id}/report.xlsx`, 'bang-diem.xlsx').catch(e => setError(messageOf(e))); }}><Download size={15}/>Xuất bảng điểm Excel</button></div>
    <section className="panel report-block"><div className="panel-heading"><h2>Điểm trung bình các buổi của từng sinh viên</h2></div><div className="report-block-body"><ScoreCards summary={data.overall}/><ScoreHistogram summary={data.overall} title="Phổ điểm trung bình"/></div></section>
    <section className="panel report-block"><div className="panel-heading"><h2>Từng buổi học</h2></div><div className="table-scroll"><table className="session-table"><thead><tr><th>BUỔI HỌC</th><th>SỐ SV</th><th>ĐIỂM TB</th><th>TRUNG VỊ</th><th>ĐẠT</th><th>GIỎI / KHÁ</th></tr></thead><tbody>{data.sessions.map(session => <tr key={session.id}><td><Link to={`/sessions/${session.id}`} className="session-title"><span><strong>{session.title}</strong><small>{dateLabel(session.createdAt)} · {session.questionCount} câu{session.variantCode ? ` · Mã đề ${session.variantCode}` : ''}</small></span></Link></td><td>{session.participantCount}</td><td><b>{session.summary.mean}</b></td><td>{session.summary.median}</td><td>{session.summary.passRate}%</td><td>{session.summary.bands.EXCELLENT} / {session.summary.bands.GOOD}</td></tr>)}</tbody></table></div></section>
    <section className="panel report-block"><div className="panel-heading"><h2>Bảng điểm</h2></div><div className="table-scroll"><table className="session-table gradebook"><thead><tr><th>MÃ</th><th>HỌ VÀ TÊN</th>{data.sessions.map((session, i) => <th key={session.id} title={session.title}>BUỔI {i + 1}</th>)}<th>TB</th></tr></thead><tbody>{data.students.map(student => <tr key={student.code}><td>{student.code}</td><td>{student.name ?? <span className="muted">Chưa có trong danh sách</span>}</td>{student.scores.map((score, i) => <td key={i} className={score === null ? 'muted' : score >= 5 ? '' : 'danger-text'}>{score ?? '—'}</td>)}<td><b>{student.average ?? '—'}</b></td></tr>)}</tbody></table></div></section>
  </>;
}
