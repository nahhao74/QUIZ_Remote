import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateStats, type PublicQuestion, type SessionSnapshot } from '@classpulse/shared-types';
import { Options, ResultsChart } from './components/session-ui';
import { useServerCountdown } from './hooks';
const question: PublicQuestion = { id:'q1', content:'Giao thức kết nối thiết bị?', optionA:'HTTP', optionB:'MQTT', optionC:'FTP', optionD:'SMTP', type:'SINGLE', correctAnswer:'B', durationSeconds:30, order:0 };
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe('question results', () => {
  it('does not reveal the correct choice until the teacher closes the question', () => {
    const {rerender} = render(<Options question={question}/>);
    expect(screen.queryByLabelText('Đáp án đúng')).toBeNull();
    expect(screen.getByText('MQTT').closest('.answer-option')?.classList.contains('answer-correct')).toBe(false);
    rerender(<Options question={question} reveal/>);
    expect(screen.getByText('MQTT').closest('.answer-option')?.classList.contains('answer-correct')).toBe(true);
    expect(screen.getByLabelText('Đáp án đúng')).toBeTruthy();
  });
  it('renders zero responses as finite percentages and keeps everyone unanswered', () => {
    const {container}=render(<ResultsChart stats={calculateStats([],50,'B')} correctAnswer="B" reveal/>);
    expect(container.textContent).not.toMatch(/NaN|Infinity/);
    expect(screen.getByText('50 chưa trả lời')).toBeTruthy();
    expect(screen.getByText('0 / 50 đã trả lời')).toBeTruthy();
    const bars=container.querySelectorAll<HTMLElement>('.chart-bar');
    expect(bars.length).toBe(4);
    for(const bar of bars) expect(bar.style.height).toBe('2%');
  });
  it('uses all submitted responses as the denominator for A/B/C/D percentages', () => {
    const {container}=render(<ResultsChart stats={calculateStats(['A','B','B','D'],10,'B')} correctAnswer="B" reveal/>);
    expect(screen.getByText('6 chưa trả lời')).toBeTruthy();
    expect(container.querySelector('.chart-b>strong')?.textContent).toBe('50%');
    expect(container.querySelector('.chart-c>strong')?.textContent).toBe('0%');
    expect(screen.getByText('2 đúng')).toBeTruthy();
  });
});
describe('server-authoritative countdown', () => {
  beforeEach(() => vi.useFakeTimers({toFake:['setInterval','clearInterval','performance']}));
  it('starts from the server deadline, even if the browser clock differs', () => {
    const deadline='2030-01-01T00:01:00Z';
    const {result}=renderHook(()=>useServerCountdown(deadline,'2030-01-01T00:00:47Z'));
    expect(result.current).toBe(13);
    act(()=>vi.advanceTimersByTime(5000));
    expect(result.current).toBe(8);
    act(()=>vi.advanceTimersByTime(20000));
    expect(result.current).toBe(0);
  });
  it('a reload restores the remaining server time instead of starting the full duration again', () => {
    const initial=renderHook(()=>useServerCountdown('2030-01-01T00:01:00Z','2030-01-01T00:00:30Z'));
    expect(initial.result.current).toBe(30);
    initial.unmount();
    const reloaded=renderHook(()=>useServerCountdown('2030-01-01T00:01:00Z','2030-01-01T00:00:54Z'));
    expect(reloaded.result.current).toBe(6);
  });
  it('rebases on a fresh realtime snapshot and clears when no question is open', () => {
    const {result,rerender}=renderHook(({ends,server})=>useServerCountdown(ends,server),{initialProps:{ends:'2030-01-01T00:01:00Z' as string|null,server:'2030-01-01T00:00:30Z'}});
    act(()=>vi.advanceTimersByTime(1000));
    expect(result.current).toBe(29);
    rerender({ends:'2030-01-01T00:01:00Z',server:'2030-01-01T00:00:57Z'});
    expect(result.current).toBe(3);
    rerender({ends:null,server:'2030-01-01T00:01:01Z'});
    expect(result.current).toBeNull();
  });
});
