import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiJob } from '@classpulse/shared-types';
import { AiProviderNote, JobProgress } from './pages/ai';
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe('AI provider and job progress', () => {
  it('names the model in use and the local model that takes over when the free quota runs out', () => {
    const { container, rerender } = render(<AiProviderNote status={{ enabled: true, provider: 'gemini', model: 'gemini-3.8-flash', fallback: { provider: 'ollama', model: 'qwen3:4b-instruct' } }}/>);
    expect(container.textContent).toContain('Đang dùng Google Gemini · gemini-3.8-flash');
    expect(container.textContent).toContain('tự chuyển sang Ollama (máy chủ cục bộ) · qwen3:4b-instruct');
    rerender(<AiProviderNote status={{ enabled: true, provider: 'ollama', model: 'qwen3:4b-instruct', fallback: null }}/>);
    expect(container.textContent).toContain('không giới hạn lượt dùng');
    expect(container.textContent).not.toContain('tự chuyển sang');
  });
  it('shows how long a slow job has been running while it sits at 0%', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T08:10:05Z'));
    const job: AiJob = { id: 'j1', kind: 'GENERATE_QUESTIONS', status: 'RUNNING', progress: 0, error: null, result: null, input: {}, documentId: null, quizId: null, sessionId: null, examId: null,
      model: 'qwen3:4b-instruct', inputTokens: 0, outputTokens: 0, createdAt: '2026-10-12T08:06:58Z', startedAt: '2026-10-12T08:07:00Z', finishedAt: null };
    render(<JobProgress job={job} label="AI đang viết câu hỏi…"/>);
    expect(screen.getByText(/0% · 3 phút 05 giây/)).toBeTruthy();
  });
});
