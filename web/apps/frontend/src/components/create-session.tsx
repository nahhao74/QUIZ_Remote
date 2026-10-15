import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Clock3, Hand, Layers, Shuffle } from 'lucide-react';
import type { Classroom, Quiz, SessionMode, SessionSnapshot } from '@classpulse/shared-types';
import { api, json } from '../api';
import { useResource } from '../hooks';
import { ErrorNotice, Loading, Modal, messageOf } from './ui';
export function CreateSession({ quizId, onClose }: { quizId?: string; onClose: () => void }) {
  const quizzes = useResource<Quiz[]>('/quizzes'); const classes = useResource<Classroom[]>('/classes'); const navigate = useNavigate();
  const [selected, setSelected] = useState(quizId ?? ''); const [mode, setMode] = useState<SessionMode>('MANUAL'); const [duration, setDuration] = useState(''); const [classroomId, setClassroomId] = useState('');
  const [shuffleQuestions, setShuffleQuestions] = useState(false); const [shuffleOptions, setShuffleOptions] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const result = await api<SessionSnapshot>('/sessions', json('POST', { quizId: selected || quizzes.data?.find(q => q.questions.length)?.id, mode, shuffleQuestions, shuffleOptions, ...(duration ? { durationSeconds: Number(duration) } : {}), ...(classroomId ? { classroomId } : {}) }));
      navigate(`/sessions/${result.id}`); onClose();
    } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  return <Modal title="Bắt đầu một buổi học" onClose={onClose}><p className="muted modal-intro">Chọn bộ câu hỏi, mời sinh viên và để lớp học lên tiếng.</p>{quizzes.loading ? <Loading/> : <form onSubmit={submit} className="form-stack">
    {(error || quizzes.error) && <ErrorNotice message={error || quizzes.error}/>}
    <label>Bộ câu hỏi<select required value={selected || quizzes.data?.find(q => q.questions.length)?.id || ''} onChange={e => setSelected(e.target.value)}><option value="" disabled>Chọn bộ câu hỏi</option>{quizzes.data?.filter(q => q.questions.length).map(q => <option key={q.id} value={q.id}>{q.title} · {q.questions.length} câu</option>)}</select></label>
    <label>Lớp học (tùy chọn)<select value={classroomId} onChange={e => setClassroomId(e.target.value)}><option value="">Không gán lớp</option>{classes.data?.map(item => <option key={item.id} value={item.id}>{item.name} · {item.studentCount} sinh viên</option>)}</select><small className="muted">Gán lớp để báo cáo hiện họ tên sinh viên và cộng vào thống kê điểm của lớp. <Link to="/classes" onClick={onClose}>Quản lý lớp</Link></small></label>
    <label>Chế độ điều khiển</label>
    <div className="mode-options"><button type="button" className={mode === 'MANUAL' ? 'selected' : ''} onClick={() => setMode('MANUAL')}><Hand size={22}/><strong>Chủ động</strong><span>Bạn quyết định khi nào chuyển câu</span></button><button type="button" className={mode === 'TIMER' ? 'selected' : ''} onClick={() => setMode('TIMER')}><Clock3 size={22}/><strong>Tự động</strong><span>Hết giờ, tự động chuyển câu tiếp</span></button></div>
    <div className="toggle-list">
      <label className="toggle"><input type="checkbox" checked={shuffleQuestions} onChange={e => setShuffleQuestions(e.target.checked)}/><span><Shuffle size={15}/><b>Trộn thứ tự câu hỏi</b></span></label>
      <label className="toggle"><input type="checkbox" checked={shuffleOptions} onChange={e => setShuffleOptions(e.target.checked)}/><span><Layers size={15}/><b>Xáo trộn đáp án A–D</b><small>Giữ nguyên câu có “Tất cả các đáp án trên”, “Cả A và B”.</small></span></label>
    </div>
    <label>Thời gian mỗi câu (giây)<input type="number" min={5} max={3600} placeholder="Theo thời gian của từng câu hỏi" value={duration} onChange={e => setDuration(e.target.value)}/></label>
    <button className="button primary full-width" disabled={busy || !quizzes.data?.some(q => q.questions.length)}>{busy ? 'Đang tạo phòng…' : 'Tạo phòng học'}<ArrowRight size={17}/></button>
    {quizzes.data?.length === 0 && <p className="muted">Tạo bộ câu hỏi đầu tiên trước khi mở phòng học.</p>}
  </form>}</Modal>;
}
