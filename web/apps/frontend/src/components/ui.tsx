import { useEffect, type ReactNode } from 'react';
import { AlertCircle, ArrowRight, Loader2, Radio, X } from 'lucide-react';
import type { SessionStatus } from '@classpulse/shared-types';
export function Brand({ light = false, compact = false }: { light?: boolean; compact?: boolean }) {
  return <span className={`brand ${light ? 'brand-light' : ''}`}><span className="brand-icon"><svg width="25" height="25" viewBox="0 0 30 30" fill="none"><path d="M2 16h7L12 6l5 19 4-12h7" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"/></svg></span>{!compact && <>Class<span>Pulse</span><span className="brand-dot">.</span></>}</span>;
}
export function Loading({ label = 'Đang tải dữ liệu…' }: { label?: string }) { return <div className="loading" role="status"><Loader2 className="spin" size={24}/><span>{label}</span></div>; }
export function ErrorNotice({ message, retry }: { message: string; retry?: () => void }) { return <div className="error-notice" role="alert"><AlertCircle size={19}/><span>{message}</span>{retry && <button className="text-button" onClick={retry}>Thử lại</button>}</div>; }
export function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) { return <div className="empty-state"><span className="empty-symbol"><Radio size={30}/></span><h3>{title}</h3><p>{children}</p>{action}</div>; }
const statusLabels: Record<SessionStatus, string> = { LOBBY: 'Phòng chờ', QUESTION_ACTIVE: 'Đang diễn ra', QUESTION_CLOSED: 'Đã đóng câu', FINISHED: 'Đã kết thúc' };
export function Status({ status }: { status: SessionStatus }) { return <span className={`status status-${status.toLowerCase()}`}><span/>{statusLabels[status]}</span>; }
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => { const listener = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', listener); const old = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { window.removeEventListener('keydown', listener); document.body.style.overflow = old; }; }, [onClose]);
  return <div className="modal-backdrop" onClick={onClose}><section role="dialog" aria-modal="true" aria-label={title} className={`modal ${wide ? 'modal-wide' : ''}`} onClick={e => e.stopPropagation()}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="Đóng" onClick={onClose}><X size={21}/></button></div>{children}</section></div>;
}
export function PageHeading({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) { return <div className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="heading-actions">{actions}</div>}</div>; }
export function SectionHeading({ title, note, action }: { title: string; note?: string; action?: ReactNode }) { return <div className="section-heading"><div><h2>{title}</h2>{note && <p>{note}</p>}</div>{action}</div>; }
export function ArrowLabel({ children }: { children: ReactNode }) { return <span className="arrow-label">{children}<ArrowRight size={16}/></span>; }
export const dateLabel = (date: string) => new Date(date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
export const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Có lỗi xảy ra. Vui lòng thử lại.';
/** Time since an AI job started, e.g. "2 phút 05 giây": a local model on CPU can stay at 0% for minutes. */
export function jobElapsed(job: { startedAt: string | null } | null | undefined) {
  if (!job?.startedAt) return '';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(job.startedAt)) / 1000));
  return seconds < 60 ? `${seconds} giây` : `${Math.floor(seconds / 60)} phút ${String(seconds % 60).padStart(2, '0')} giây`;
}
