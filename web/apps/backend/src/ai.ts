import { AsyncLocalStorage } from 'node:async_hooks';
import { Controller, Get, HttpException, HttpStatus, Injectable, Logger, NotFoundException, OnModuleInit, Param, ParseUUIDPipe, Query, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { AiJob as AiJobRecord, AiJobKind, Prisma } from '@prisma/client';
import type { AiJob, AiStatus } from '@classpulse/shared-types';
import { AuthGuard, AuthRequest } from './auth';
import { PrismaService } from './prisma.service';
import { AiTaskError, ClaudeProvider, GeminiProvider, OllamaProvider, type AiProvider, type AiProviderName, type AiUsage, type StructuredRequest } from './ai-providers';

export { AiTaskError, type AiPart, type AiUsage, type Effort } from './ai-providers';
/**
 * Enum-like fields are described strings: Gemini and Ollama receive a real `enum` constraint through the JSON
 * Schema metadata, while parsing stays tolerant (Claude only sees enums as text) and `pick` maps the value.
 */
export const choice = (values: readonly string[]) => z.string().meta({ enum: [...values], description: `One of: ${values.join(', ')}` });
export function pick<T extends string>(value: string, values: readonly T[], fallback: T): T {
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return values.find(item => item === normalized) ?? fallback;
}

const DEFAULT_MODELS: Record<AiProviderName, string> = { gemini: 'gemini-3.8-flash', ollama: 'qwen3:4b-instruct', anthropic: 'claude-opus-5-5' };
/** After the primary runs out of quota, calls go straight to the fallback for this long before trying it again. */
const PRIMARY_PAUSE_MS = 10 * 60 * 1000;
/** Models that served the calls of the job running in this async context; a job may switch to the fallback midway. */
const jobModels = new AsyncLocalStorage<Set<string>>();
type Providers = { provider: AiProvider | null; fallback: AiProvider | null };
/**
 * Chooses the AI provider from the environment: AI_PROVIDER if set, otherwise the first configured of
 * Gemini (free tier), Claude, then a local Ollama server. Nothing is configured → AI features stay disabled.
 * When a cloud provider is chosen and OLLAMA_URL is also set, Ollama serves the calls the cloud cannot
 * (quota used up, overload, network), so running out of free quota never stops the teacher.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private cached?: { signature: string } & Providers;
  private primaryPausedUntil = 0;
  private resolve(): Providers {
    const env = process.env;
    const signature = ['AI_DISABLED', 'AI_PROVIDER', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'OLLAMA_URL', 'OLLAMA_MODEL', 'OLLAMA_NUM_CTX'].map(key => env[key] ?? '').join('\u0000');
    if (this.cached?.signature === signature) return this.cached;
    const requested = env.AI_PROVIDER?.trim().toLowerCase();
    const name: AiProviderName | null = env.AI_DISABLED === 'true' ? null
      : requested === 'gemini' || requested === 'ollama' || requested === 'anthropic' ? requested
      : env.GEMINI_API_KEY ? 'gemini' : env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? 'anthropic' : env.OLLAMA_URL ? 'ollama' : null;
    const model = (name && { gemini: env.GEMINI_MODEL, ollama: env.OLLAMA_MODEL, anthropic: env.ANTHROPIC_MODEL }[name]?.trim()) || (name ? DEFAULT_MODELS[name] : '');
    const ollama = (ollamaModel: string) => new OllamaProvider(ollamaModel, env.OLLAMA_URL || 'http://localhost:11434', Number(env.OLLAMA_NUM_CTX) || 32768);
    let provider: AiProvider | null = null;
    if (name === 'gemini' && env.GEMINI_API_KEY) provider = new GeminiProvider(model, env.GEMINI_API_KEY, env.GEMINI_BASE_URL || undefined);
    if (name === 'anthropic' && (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)) provider = new ClaudeProvider(model);
    if (name === 'ollama') provider = ollama(model);
    const fallback = provider && provider.name !== 'ollama' && env.OLLAMA_URL ? ollama(env.OLLAMA_MODEL?.trim() || DEFAULT_MODELS.ollama) : null;
    this.cached = { signature, provider, fallback };
    this.primaryPausedUntil = 0;
    return this.cached;
  }
  get enabled() { return !!this.resolve().provider; }
  get model() { return this.resolve().provider?.model ?? ''; }
  /** Extraction chunks must fit whichever provider ends up serving them. */
  get chunkChars() { const { provider, fallback } = this.resolve(); return Math.min(provider?.chunkChars ?? 60000, fallback?.chunkChars ?? 60000); }
  status(): AiStatus {
    const { provider, fallback } = this.resolve();
    return { enabled: !!provider, provider: provider?.name ?? null, model: provider?.model ?? '', fallback: fallback ? { provider: fallback.name, model: fallback.model } : null };
  }
  assertEnabled() {
    if (!this.enabled) throw new ServiceUnavailableException('Chưa cấu hình AI. Đặt GEMINI_API_KEY (miễn phí tại aistudio.google.com/apikey) hoặc OLLAMA_URL trong .env rồi khởi động lại backend.');
  }
  /** One structured call: the response is constrained to the Zod schema and validated before use. */
  async structured<S extends z.ZodType>(request: StructuredRequest<S>): Promise<{ data: z.infer<S>; usage: AiUsage }> {
    const { provider, fallback } = this.resolve();
    if (!provider) { this.assertEnabled(); throw new AiTaskError('Chưa cấu hình AI.'); }
    const spare = fallback && (fallback.readsPdf || !request.content.some(part => part.type === 'pdf')) ? fallback : null;
    if (spare && Date.now() < this.primaryPausedUntil) return this.call(spare, request);
    try {
      return await this.call(provider, request);
    } catch (error) {
      if (!spare || !(error instanceof AiTaskError) || !error.unavailable) throw error;
      this.primaryPausedUntil = Date.now() + PRIMARY_PAUSE_MS;
      this.logger.warn(JSON.stringify({ event: 'ai_fallback', from: provider.name, to: spare.name, reason: error.message.slice(0, 120) }));
      // If the fallback fails too, the primary's message (for example "quota used up") is the one worth showing.
      return await this.call(spare, request).catch(() => { throw error; });
    }
  }
  private async call<S extends z.ZodType>(provider: AiProvider, request: StructuredRequest<S>) {
    const result = await provider.generate(request);
    jobModels.getStore()?.add(provider.model);
    return result;
  }
}

export type JobHandler = (job: AiJobRecord, progress: (value: number) => Promise<void>) => Promise<{ result: Prisma.InputJsonValue; usage: AiUsage }>;
type JobLinks = { documentId?: string; quizId?: string; sessionId?: string; examId?: string };
const MAX_CONCURRENT = Number(process.env.AI_MAX_CONCURRENT_JOBS ?? 2);
const MAX_ACTIVE_PER_TEACHER = 3;

export function jobView<R>(job: AiJobRecord): AiJob<R> {
  return { id: job.id, kind: job.kind, status: job.status, progress: job.progress, error: job.error, result: job.result as R | null, input: (job.input ?? {}) as Record<string, unknown>,
    documentId: job.documentId, quizId: job.quizId, sessionId: job.sessionId, examId: job.examId, model: job.model, inputTokens: job.inputTokens, outputTokens: job.outputTokens,
    createdAt: job.createdAt.toISOString(), startedAt: job.startedAt?.toISOString() ?? null, finishedAt: job.finishedAt?.toISOString() ?? null };
}
/**
 * AI work runs in the background and is polled, so slow generations never hit proxy timeouts.
 * Jobs live in PostgreSQL; ones interrupted by a restart are marked failed instead of hanging forever.
 */
@Injectable()
export class AiJobsService implements OnModuleInit {
  private readonly logger = new Logger(AiJobsService.name);
  private readonly handlers = new Map<AiJobKind, JobHandler>();
  private readonly queue: string[] = [];
  private running = 0;
  constructor(private readonly db: PrismaService, private readonly ai: AiService) {}
  async onModuleInit() {
    await this.db.aiJob.updateMany({ where: { status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'FAILED', error: 'Máy chủ khởi động lại khi tác vụ đang chạy. Vui lòng chạy lại.', finishedAt: new Date() } })
      .catch(() => this.logger.error(JSON.stringify({ event: 'ai_job_recovery_failed' })));
  }
  register(kind: AiJobKind, handler: JobHandler) { this.handlers.set(kind, handler); }
  async enqueue<R = unknown>(teacherId: string, kind: AiJobKind, links: JobLinks, input: Prisma.InputJsonValue): Promise<AiJob<R>> {
    this.ai.assertEnabled();
    const active = await this.db.aiJob.count({ where: { teacherId, status: { in: ['QUEUED', 'RUNNING'] } } });
    if (active >= MAX_ACTIVE_PER_TEACHER) throw new HttpException('Bạn đang có nhiều tác vụ AI chưa xong. Vui lòng đợi rồi thử lại.', HttpStatus.TOO_MANY_REQUESTS);
    const job = await this.db.aiJob.create({ data: { teacherId, kind, ...links, input, model: this.ai.model } });
    this.queue.push(job.id);
    this.pump();
    return jobView<R>(job);
  }
  private pump() {
    while (this.running < MAX_CONCURRENT && this.queue.length) {
      const id = this.queue.shift()!;
      this.running++;
      void this.run(id).finally(() => { this.running--; this.pump(); });
    }
  }
  private async run(id: string) {
    const job = await this.db.aiJob.update({ where: { id }, data: { status: 'RUNNING', startedAt: new Date() } });
    const started = Date.now();
    try {
      const handler = this.handlers.get(job.kind);
      if (!handler) throw new AiTaskError('Loại tác vụ AI không được hỗ trợ.');
      const models = new Set<string>();
      const outcome = await jobModels.run(models, () => handler(job, async progress => { await this.db.aiJob.update({ where: { id }, data: { progress: Math.max(0, Math.min(99, Math.round(progress))) } }); }));
      await this.db.aiJob.update({ where: { id }, data: { status: 'SUCCEEDED', progress: 100, result: outcome.result, inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens, finishedAt: new Date(),
        ...(models.size ? { model: [...models].join(' + ') } : {}) } });
      this.logger.log(JSON.stringify({ event: 'ai_job_succeeded', kind: job.kind, jobId: id, durationMs: Date.now() - started, ...outcome.usage }));
    } catch (error) {
      const message = error instanceof AiTaskError || error instanceof HttpException ? error.message : 'Lỗi không xác định khi xử lý tác vụ AI.';
      if (!(error instanceof AiTaskError || error instanceof HttpException)) this.logger.error(JSON.stringify({ event: 'ai_job_crashed', kind: job.kind, jobId: id, error: error instanceof Error ? error.message : String(error) }));
      await this.db.aiJob.update({ where: { id }, data: { status: 'FAILED', error: message, finishedAt: new Date() } }).catch(() => undefined);
    }
  }
  /** Drops bulky inputs (such as an uploaded PDF) once a job no longer needs them. */
  async clearInput(id: string, input: Prisma.InputJsonValue) { await this.db.aiJob.update({ where: { id }, data: { input } }); }
  async get<R = unknown>(teacherId: string, id: string): Promise<AiJob<R>> {
    const job = await this.db.aiJob.findFirst({ where: { id, teacherId } });
    if (!job) throw new NotFoundException('Không tìm thấy tác vụ AI.');
    return jobView<R>(job);
  }
  async list(teacherId: string, filter: { kind?: AiJobKind } & JobLinks = {}, take = 30) {
    const jobs = await this.db.aiJob.findMany({ where: { teacherId, ...filter }, orderBy: { createdAt: 'desc' }, take });
    return jobs.map(job => jobView(job));
  }
  async latest<R = unknown>(teacherId: string, kind: AiJobKind, links: JobLinks): Promise<AiJob<R> | null> {
    const job = await this.db.aiJob.findFirst({ where: { teacherId, kind, ...links }, orderBy: { createdAt: 'desc' } });
    return job ? jobView<R>(job) : null;
  }
}

const JOB_KINDS: AiJobKind[] = ['GENERATE_QUESTIONS', 'EXTRACT_QUESTIONS', 'REVIEW_QUIZ', 'ANALYZE_SESSION', 'ANALYZE_EXAM'];
@ApiTags('AI') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService, private readonly jobs: AiJobsService) {}
  @Get('status') status() { return this.ai.status(); }
  @Get('jobs') list(@Req() req: AuthRequest, @Query('kind') kind?: string) {
    return this.jobs.list(req.teacherId, JOB_KINDS.includes(kind as AiJobKind) ? { kind: kind as AiJobKind } : {});
  }
  @Get('jobs/:id') get(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.jobs.get(req.teacherId, id); }
}
