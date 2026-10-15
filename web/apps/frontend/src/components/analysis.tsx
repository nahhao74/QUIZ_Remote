import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Lightbulb, RefreshCw, Sparkles, TrendingDown, TrendingUp } from 'lucide-react';
import { DISTRACTOR_FLAG_LABELS, GRADE_BANDS, ITEM_FLAG_LABELS, type AiJob, type AiResultInsight, type ItemAnalysis, type ItemAnalysisReport, type ScoreSummary } from '@classpulse/shared-types';
import { ErrorNotice, jobElapsed } from './ui';

const pct = (value: number) => `${Math.round(value * 100)}%`;
const decimal = (value: number | null) => (value === null ? '—' : value.toLocaleString('vi-VN', { maximumFractionDigits: 2 }));
export function ScoreCards({ summary, reliability }: { summary: ScoreSummary; reliability?: number | null }) {
  return <div className="score-cards">
    <div><span>Điểm trung bình</span><strong>{decimal(summary.mean)}</strong><small>Trung vị {decimal(summary.median)} · Độ lệch chuẩn {decimal(summary.standardDeviation)}</small></div>
    <div><span>Tỷ lệ đạt (≥ 5)</span><strong>{decimal(summary.passRate)}%</strong><small>{summary.count} bài · Thấp nhất {decimal(summary.min)} · Cao nhất {decimal(summary.max)}</small></div>
    <div className="grade-bands"><span>Xếp loại</span><ul>{GRADE_BANDS.map(band => <li key={band.band} className={`band-${band.band.toLowerCase()}`}><i/>{band.label}<b>{summary.bands[band.band]}</b></li>)}</ul></div>
    {reliability !== undefined && <div><span>Độ tin cậy (KR-20)</span><strong>{decimal(reliability)}</strong><small>{reliability === null ? 'Chưa đủ dữ liệu' : reliability >= 0.7 ? 'Đề có độ tin cậy tốt' : reliability >= 0.5 ? 'Chấp nhận được' : 'Thấp — đề chưa đo ổn định'}</small></div>}
  </div>;
}
export function ScoreHistogram({ summary, title = 'Phổ điểm' }: { summary: ScoreSummary; title?: string }) {
  const max = Math.max(1, ...summary.histogram);
  return <div className="histogram" aria-label={title}><h3>{title}</h3><div className="histogram-bars">{summary.histogram.map((count, score) => <div key={score} className={score >= 8 ? 'hist-good' : score >= 5 ? 'hist-pass' : 'hist-fail'}><b>{count || ''}</b><span style={{ height: `${count ? Math.max(6, count * 100 / max) : 0}%` }}/><small>{score}</small></div>)}</div></div>;
}
const QUALITY_LABELS: Record<ItemAnalysis['quality'], string> = { GOOD: 'Tốt', FAIR: 'Khá', POOR: 'Cần xem lại', INSUFFICIENT: 'Chưa đủ dữ liệu' };
const LEVEL_LABELS: Record<ItemAnalysis['level'], string> = { EASY: 'Dễ', MEDIUM: 'Trung bình', HARD: 'Khó' };
/** Classical item analysis per question, with distractor efficiency on demand. */
export function ItemAnalysisTable({ report, labels }: { report: ItemAnalysisReport; labels: Array<{ number: number; content: string; correctAnswer: string }> }) {
  const [open, setOpen] = useState<string | null>(null);
  return <div className="table-scroll"><table className="analysis-table">
    <thead><tr><th>CÂU</th><th>TỶ LỆ ĐÚNG</th><th>ĐỘ PHÂN BIỆT</th><th>MỨC ĐỘ</th><th>CHẤT LƯỢNG</th><th>LỰA CHỌN A / B / C / D</th><th/></tr></thead>
    <tbody>{report.items.map((item, i) => {
      const label = labels[i];
      return [<tr key={item.questionId} className={item.flags.length ? 'analysis-flagged' : ''}>
        <td><b>{label?.number ?? i + 1}</b><span className="analysis-content" title={label?.content}>{label?.content}</span></td>
        <td><div className="mini-meter"><span style={{ width: pct(item.difficulty) }}/></div>{pct(item.difficulty)}</td>
        <td className={item.discrimination !== null && item.discrimination < 0.2 ? 'danger-text' : ''}>{item.discrimination === null ? '—' : <>{item.discrimination >= 0 ? <TrendingUp size={13}/> : <TrendingDown size={13}/>}{decimal(item.discrimination)}</>}</td>
        <td>{LEVEL_LABELS[item.level]}</td>
        <td><span className={`quality quality-${item.quality.toLowerCase()}`}>{QUALITY_LABELS[item.quality]}</span></td>
        <td><div className="option-rates">{item.options.map(option => <span key={option.option} className={`${option.isKey ? 'rate-key' : ''} ${option.flags.length ? 'rate-flag' : ''}`} title={option.flags.map(flag => DISTRACTOR_FLAG_LABELS[flag]).join('; ')}>{option.option} {pct(option.rate)}</span>)}</div></td>
        <td><button className="icon-button" aria-label="Chi tiết" onClick={() => setOpen(open === item.questionId ? null : item.questionId)}>{open === item.questionId ? <ChevronUp size={15}/> : <ChevronDown size={15}/>}</button></td>
      </tr>, open === item.questionId && <tr key={`${item.questionId}-detail`} className="analysis-detail"><td colSpan={7}>
        <div className="analysis-detail-grid">
          <div><strong>Đáp án đúng: {label?.correctAnswer}</strong><p>{item.correct}/{report.participants} sinh viên làm đúng · {item.answered} đã trả lời · tương quan điểm–câu {decimal(item.pointBiserial)}</p>{item.flags.length ? <ul>{item.flags.map(flag => <li key={flag}><AlertTriangle size={13}/>{ITEM_FLAG_LABELS[flag]}</li>)}</ul> : <p className="success-note">Không phát hiện bất thường.</p>}</div>
          <table className="distractor-table"><thead><tr><th>Phương án</th><th>Tất cả</th><th>Nhóm giỏi</th><th>Nhóm yếu</th><th>Nhận xét</th></tr></thead><tbody>{item.options.map(option => <tr key={option.option} className={option.isKey ? 'rate-key-row' : ''}><td>{option.option}{option.isKey ? ' (đúng)' : ''}</td><td>{pct(option.rate)}</td><td>{pct(option.upperRate)}</td><td>{pct(option.lowerRate)}</td><td>{option.flags.map(flag => DISTRACTOR_FLAG_LABELS[flag]).join('; ') || (option.isKey ? '' : 'Hoạt động tốt')}</td></tr>)}</tbody></table>
        </div>
      </td></tr>];
    })}</tbody>
  </table><p className="muted analysis-legend">Tỷ lệ đúng: càng thấp câu càng khó. Độ phân biệt = tỷ lệ đúng của 27% sinh viên điểm cao trừ 27% điểm thấp; từ 0,3 trở lên là tốt, dưới 0,2 nên xem lại, âm thường do sai đáp án hoặc câu chữ gây hiểu nhầm.</p></div>;
}
/** AI commentary on results, with the latest run and a button to (re)run it. */
export function InsightPanel({ job, running, error, enabled, onRun }: { job: AiJob<AiResultInsight> | null; running: boolean; error?: string; enabled: boolean; onRun: () => void }) {
  const insight = job?.status === 'SUCCEEDED' ? job.result : null;
  return <section className="panel insight-panel">
    <div className="panel-heading"><h2><Sparkles size={16}/>AI phân tích kết quả</h2><button className="button secondary small" disabled={!enabled || running} title={enabled ? '' : 'Chưa cấu hình AI trên máy chủ (GEMINI_API_KEY hoặc OLLAMA_URL)'} onClick={onRun}>{running ? <><RefreshCw size={14} className="spin"/>Đang phân tích {jobElapsed(job) || '…'}</> : insight ? <><RefreshCw size={14}/>Phân tích lại</> : <><Sparkles size={14}/>Phân tích bằng AI</>}</button></div>
    {(error || job?.status === 'FAILED') && <div className="insight-body"><ErrorNotice message={error || job?.error || 'Phân tích thất bại.'}/></div>}
    {insight ? <div className="insight-body">
      <p className="insight-summary">{insight.summary}</p>
      {insight.classComparison && <div className="insight-block"><h3>So sánh giữa các lớp</h3><p>{insight.classComparison}</p></div>}
      <div className="insight-columns">
        <div className="insight-block"><h3>Điểm mạnh</h3><ul>{insight.strengths.map((item, i) => <li key={i}>{item}</li>)}</ul></div>
        <div className="insight-block"><h3>Lỗ hổng kiến thức</h3><ul>{insight.weaknesses.map((item, i) => <li key={i}><b>{item.topic}</b>: {item.evidence}<span className="insight-suggestion"><Lightbulb size={13}/>{item.suggestion}</span></li>)}</ul></div>
      </div>
      {insight.questionFlags.length > 0 && <div className="insight-block"><h3>Câu hỏi cần xem lại</h3><ul>{insight.questionFlags.map((item, i) => <li key={i}><b>Câu {item.number}:</b> {item.issue}<span className="insight-suggestion"><Lightbulb size={13}/>{item.recommendation}</span></li>)}</ul></div>}
      <div className="insight-block"><h3>Đề xuất</h3><ul>{insight.recommendations.map((item, i) => <li key={i}>{item}</li>)}</ul></div>
      {job && <small className="muted">Phân tích lúc {new Date(job.finishedAt ?? job.createdAt).toLocaleString('vi-VN')} · {job.model}</small>}
    </div> : !running && !error && job?.status !== 'FAILED' && <p className="muted insight-empty">AI đọc thống kê từng câu (tỷ lệ đúng, độ phân biệt, phương án nhiễu) để chỉ ra lỗ hổng kiến thức, câu hỏi có vấn đề và gợi ý giảng dạy. Chỉ số liệu tổng hợp được gửi đi, không gửi tên sinh viên.</p>}
  </section>;
}
