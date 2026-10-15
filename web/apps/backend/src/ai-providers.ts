import { Logger } from '@nestjs/common';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { ApiError as GeminiApiError, FileState, GoogleGenAI, ThinkingLevel, type Part } from '@google/genai';
import { z } from 'zod';

/** Failure whose message is safe and useful to show to the teacher. `unavailable`: quota used up, overload or network, so another provider may still succeed. */
export class AiTaskError extends Error {
  constructor(message: string, readonly unavailable = false) { super(message); }
}
export type AiUsage = { inputTokens: number; outputTokens: number };
export type Effort = 'low' | 'medium' | 'high' | 'xhigh';
export type AiProviderName = 'gemini' | 'ollama' | 'anthropic';
/** Provider-neutral prompt content. `cache` marks a large block repeated across calls (prompt caching where supported). */
export type AiPart = { type: 'text'; text: string; cache?: boolean } | { type: 'pdf'; data: string; title: string; cache?: boolean };
export interface StructuredRequest<S extends z.ZodType> { system: string; content: AiPart[]; schema: S; effort?: Effort; maxTokens?: number }
export interface AiProvider {
  readonly name: AiProviderName;
  readonly model: string;
  /** Largest document chunk (characters) for one extraction call, so the text and the questions copied out of it both fit. */
  readonly chunkChars: number;
  /** Whether scanned PDFs can be sent as documents. */
  readonly readsPdf: boolean;
  generate<S extends z.ZodType>(request: StructuredRequest<S>): Promise<{ data: z.infer<S>; usage: AiUsage }>;
}

/** JSON Schema for providers that constrain output to a schema (Gemini, Ollama). */
export function jsonSchema(schema: z.ZodType) {
  const result = z.toJSONSchema(schema) as Record<string, unknown>;
  delete result.$schema;
  return result;
}
function parseStructured<S extends z.ZodType>(schema: S, text: string): z.infer<S> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new AiTaskError('AI trả về dữ liệu không phải JSON hợp lệ. Vui lòng thử lại.'); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AiTaskError('AI trả về dữ liệu không đúng định dạng. Vui lòng thử lại.');
  return parsed.data;
}
const logger = new Logger('AiProvider');
const logFailure = (provider: AiProviderName, error: unknown, status?: number) =>
  logger.error(JSON.stringify({ event: 'ai_request_failed', provider, type: error instanceof Error ? error.constructor.name : typeof error, status, message: error instanceof Error ? error.message.slice(0, 300) : undefined }));

const GEMINI_LEVELS: Record<Effort, ThinkingLevel> = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH, xhigh: ThinkingLevel.HIGH };
const INLINE_PDF_LIMIT = 14 * 1024 * 1024; // base64 characters; larger PDFs go through the Files API
/**
 * Google Gemini (free tier available). Output is constrained with responseJsonSchema and streamed so long
 * generations do not hit HTTP timeouts. The SDK retries 429/5xx with backoff, which absorbs per-minute quotas.
 */
export class GeminiProvider implements AiProvider {
  readonly name = 'gemini' as const;
  readonly chunkChars = 60000;
  readonly readsPdf = true;
  private readonly client: GoogleGenAI;
  constructor(readonly model: string, apiKey: string, baseUrl?: string) {
    this.client = new GoogleGenAI({ apiKey, httpOptions: { ...(baseUrl ? { baseUrl } : {}), retryOptions: { attempts: 4, initialDelay: 5, maxDelay: 60, httpStatusCodes: [408, 429, 500, 502, 503, 504] } } });
  }
  async generate<S extends z.ZodType>(request: StructuredRequest<S>) {
    try {
      const parts: Part[] = [];
      for (const part of request.content) parts.push(part.type === 'text' ? { text: part.text } : await this.pdfPart(part));
      const stream = await this.client.models.generateContentStream({
        model: this.model,
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction: request.system,
          responseMimeType: 'application/json',
          responseJsonSchema: jsonSchema(request.schema),
          maxOutputTokens: Math.min(request.maxTokens ?? 65536, 65536),
          // Gemini 3 models take a thinking level; older models keep their default thinking budget.
          ...(/^gemini-3/.test(this.model) ? { thinkingConfig: { thinkingLevel: GEMINI_LEVELS[request.effort ?? 'high'] } } : {}),
        },
      });
      let text = '', finish: string | undefined, blocked: string | undefined, input = 0, output = 0;
      for await (const chunk of stream) {
        text += chunk.text ?? '';
        finish = chunk.candidates?.[0]?.finishReason ?? finish;
        blocked = chunk.promptFeedback?.blockReason ?? blocked;
        if (chunk.usageMetadata) { input = chunk.usageMetadata.promptTokenCount ?? input; output = (chunk.usageMetadata.candidatesTokenCount ?? 0) + (chunk.usageMetadata.thoughtsTokenCount ?? 0); }
      }
      if (blocked) throw new AiTaskError('Gemini từ chối xử lý nội dung này (bộ lọc an toàn). Hãy kiểm tra lại tài liệu hoặc yêu cầu.');
      if (finish === 'MAX_TOKENS') throw new AiTaskError('Kết quả AI vượt quá giới hạn độ dài. Hãy giảm số câu hỏi hoặc chọn ít chương hơn.');
      if (finish && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(finish)) throw new AiTaskError(`Gemini dừng giữa chừng (lý do: ${finish}). Hãy thử lại hoặc điều chỉnh tài liệu.`);
      return { data: parseStructured(request.schema, text), usage: { inputTokens: input, outputTokens: output } };
    } catch (error) {
      if (error instanceof AiTaskError) throw error;
      throw this.translate(error);
    }
  }
  private async pdfPart(part: Extract<AiPart, { type: 'pdf' }>): Promise<Part> {
    if (part.data.length <= INLINE_PDF_LIMIT) return { inlineData: { mimeType: 'application/pdf', data: part.data } };
    let file = await this.client.files.upload({ file: new Blob([Buffer.from(part.data, 'base64')], { type: 'application/pdf' }), config: { mimeType: 'application/pdf', displayName: part.title } });
    for (let attempt = 0; file.state === FileState.PROCESSING && attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      file = await this.client.files.get({ name: file.name! });
    }
    if (file.state === FileState.FAILED || !file.uri) throw new AiTaskError('Gemini không xử lý được file PDF này.');
    return { fileData: { fileUri: file.uri, mimeType: 'application/pdf' } };
  }
  private translate(error: unknown) {
    const status = error instanceof GeminiApiError ? error.status : undefined;
    logFailure('gemini', error, status);
    if (status === 429) return new AiTaskError('Đã chạm hạn mức miễn phí của Gemini (số yêu cầu hoặc token mỗi phút/mỗi ngày). Hạn mức ngày được đặt lại lúc 0h giờ Thái Bình Dương (khoảng 14–15h giờ Việt Nam). Hãy thử lại sau, giảm số câu/chương, hoặc dùng mô hình cục bộ Ollama.', true);
    if (status === 400 && /api key/i.test(error instanceof Error ? error.message : '')) return new AiTaskError('GEMINI_API_KEY không hợp lệ. Tạo khóa mới tại aistudio.google.com/apikey.');
    if (status === 403 && /denied access/i.test(error instanceof Error ? error.message : '')) return new AiTaskError('Google đã chặn dự án của GEMINI_API_KEY này ("project has been denied access"). Hãy tạo khóa mới bằng tài khoản Google khác tại aistudio.google.com/apikey, hoặc dùng mô hình cục bộ Ollama.');
    if (status === 401 || status === 403) return new AiTaskError('GEMINI_API_KEY không hợp lệ hoặc dự án chưa bật Gemini API.');
    if (status === 404) return new AiTaskError(`Không tìm thấy mô hình ${this.model}. Kiểm tra GEMINI_MODEL.`);
    if (status === 400) return new AiTaskError(/token|too (long|large)|exceeds/i.test(error instanceof Error ? error.message : '') ? 'Tài liệu quá dài cho một lần xử lý. Hãy chọn ít chương hơn.' : 'Yêu cầu gửi tới Gemini không hợp lệ.');
    if (status !== undefined) return new AiTaskError('Dịch vụ Gemini tạm thời gặp lỗi. Vui lòng thử lại.', status >= 500 || status === 408);
    return new AiTaskError('Không kết nối được tới Gemini. Kiểm tra kết nối Internet của máy chủ.', true);
  }
}

/**
 * Local model through Ollama: free and unlimited, nothing leaves the server, but quality and speed depend on
 * the model and hardware. Uses the native /api/chat endpoint with `format` (JSON schema constrained decoding).
 * Plain http with no client timeout: on CPU, reading a long chapter can take minutes before the first token.
 */
export class OllamaProvider implements AiProvider {
  readonly name = 'ollama' as const;
  readonly readsPdf = false;
  constructor(readonly model: string, private readonly url: string, private readonly contextTokens: number) {}
  /** About a third of the context window for the document, leaving the rest for the extracted questions. */
  get chunkChars() { return Math.max(4000, Math.min(30000, Math.floor(this.contextTokens * 0.9))); }
  async generate<S extends z.ZodType>(request: StructuredRequest<S>) {
    if (request.content.some(part => part.type === 'pdf')) throw new AiTaskError('Mô hình cục bộ (Ollama) không đọc được PDF dạng ảnh. Hãy tải PDF có lớp chữ hoặc dùng Gemini.');
    const prompt = request.content.map(part => (part.type === 'text' ? part.text : '')).join('\n\n');
    const format = jsonSchema(request.schema);
    // The grammar enforces the shape, but the model never sees the field descriptions unless they are in the prompt.
    const system = `${request.system}\n\nRespond with JSON that follows this JSON Schema:\n${JSON.stringify(format)}`;
    // Vietnamese averages roughly three characters per token; Ollama would silently cut a longer prompt.
    const estimated = Math.ceil((system.length + prompt.length) / 3);
    const output = Math.min(request.maxTokens ?? 16000, 16000, this.contextTokens - estimated);
    if (output < 2000) throw new AiTaskError(`Nội dung quá dài cho mô hình cục bộ (khoảng ${estimated.toLocaleString('vi-VN')} token, giới hạn ${this.contextTokens.toLocaleString('vi-VN')}). Hãy chọn ít chương hơn hoặc tăng OLLAMA_NUM_CTX.`);
    const body = JSON.stringify({ model: this.model, stream: true, format,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], options: { temperature: 0.4, num_ctx: this.contextTokens, num_predict: output } });
    let text = '', reason = '', input = 0, generated = 0, done = false, responded = false;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: AiTaskError) => { if (settled) return; settled = true; reject(error); req.destroy(); };
      const target = new URL('/api/chat', this.url);
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(target, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
        responded = true;
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            let event: { message?: { content?: string }; done?: boolean; done_reason?: string; prompt_eval_count?: number; eval_count?: number; error?: string };
            try { event = JSON.parse(line); } catch { continue; }
            if (event.error) { fail(this.translate(res.statusCode, event.error)); return; }
            text += event.message?.content ?? '';
            if (event.done) { done = true; reason = event.done_reason ?? ''; input = event.prompt_eval_count ?? 0; generated = event.eval_count ?? 0; }
          }
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) fail(this.translate(res.statusCode, buffer));
          else if (!done) fail(this.translate(res.statusCode, 'stream ended before completion'));
          else if (!settled) { settled = true; resolve(); }
        });
        res.on('error', error => fail(this.translate(res.statusCode, error.message)));
      });
      req.on('error', error => fail(responded ? this.translate(undefined, error.message)
        : (logFailure('ollama', error), new AiTaskError(`Không kết nối được Ollama tại ${this.url}. Kiểm tra dịch vụ Ollama đang chạy.`, true))));
      req.end(body);
    });
    if (reason === 'length') throw new AiTaskError('Kết quả AI vượt quá giới hạn độ dài. Hãy giảm số câu hỏi, chọn ít chương hơn hoặc tăng OLLAMA_NUM_CTX.');
    return { data: parseStructured(request.schema, text), usage: { inputTokens: input, outputTokens: generated } };
  }
  private translate(status: number | undefined, detail: string) {
    logFailure('ollama', new Error(detail), status);
    if (/not found|pull/i.test(detail)) return new AiTaskError(`Ollama chưa có mô hình ${this.model}. Chạy: ollama pull ${this.model}`);
    // Out-of-memory shows up as a load error, a killed runner, or a stream that stops without its final event.
    if (/memory|terminated|killed|signal|aborted|reset|socket hang up|before completion/i.test(detail)) return new AiTaskError(`Ollama dừng giữa chừng, thường do máy chủ không đủ RAM cho ${this.model} với OLLAMA_NUM_CTX=${this.contextTokens}. Hãy giảm OLLAMA_NUM_CTX (ví dụ 16384), dùng mô hình nhỏ hơn hoặc xem log của Ollama.`);
    return new AiTaskError('Ollama gặp lỗi khi xử lý yêu cầu. Kiểm tra log của Ollama.');
  }
}

/**
 * Anthropic Claude (paid). The SDK sends enums only as description text and validates strictly afterwards,
 * which is why enum-like schema fields are plain strings mapped in code. Refusals retry on a fallback model.
 */
export class ClaudeProvider implements AiProvider {
  readonly name = 'anthropic' as const;
  readonly chunkChars = 60000;
  readonly readsPdf = true;
  private readonly client = new Anthropic({ maxRetries: 3, timeout: 20 * 60 * 1000 });
  constructor(readonly model: string) {}
  async generate<S extends z.ZodType>(request: StructuredRequest<S>) {
    const fallback = /^claude-(opus-5|fable-5|mythos-5|sonnet-5-5)/.test(this.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {};
    const content: BetaContentBlockParam[] = request.content.map(part => ({
      ...(part.type === 'text' ? { type: 'text' as const, text: part.text } : { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: part.data }, title: part.title }),
      ...(part.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }));
    try {
      const stream = this.client.beta.messages.stream({
        model: this.model, max_tokens: request.maxTokens ?? 64000, system: request.system, messages: [{ role: 'user', content }],
        output_config: { effort: request.effort ?? 'high', format: betaZodOutputFormat(request.schema) }, ...fallback,
      });
      const message = await stream.finalMessage();
      const usage = { inputTokens: message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0), outputTokens: message.usage.output_tokens };
      if (message.stop_reason === 'refusal') throw new AiTaskError('AI từ chối xử lý nội dung này. Hãy kiểm tra lại tài liệu hoặc yêu cầu.');
      if (message.stop_reason === 'max_tokens') throw new AiTaskError('Kết quả AI vượt quá giới hạn độ dài. Hãy giảm số câu hỏi hoặc chọn ít chương hơn.');
      if (!message.parsed_output) throw new AiTaskError('AI trả về dữ liệu không đúng định dạng. Vui lòng thử lại.');
      return { data: message.parsed_output as z.infer<S>, usage };
    } catch (error) {
      if (error instanceof AiTaskError) throw error;
      const status = error instanceof Anthropic.APIError ? error.status : undefined;
      logFailure('anthropic', error, status);
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) throw new AiTaskError('Khóa ANTHROPIC_API_KEY không hợp lệ hoặc không có quyền dùng mô hình đã cấu hình.');
      if (error instanceof Anthropic.NotFoundError) throw new AiTaskError(`Không tìm thấy mô hình ${this.model}. Kiểm tra ANTHROPIC_MODEL.`);
      if (error instanceof Anthropic.RateLimitError) throw new AiTaskError('Dịch vụ AI đang quá tải hoặc hết hạn mức. Vui lòng thử lại sau ít phút.', true);
      if (error instanceof Anthropic.BadRequestError) throw new AiTaskError(/too long|context|token/i.test(error.message) ? 'Tài liệu quá dài cho một lần xử lý. Hãy chọn ít chương hơn.' : 'Yêu cầu gửi tới AI không hợp lệ.');
      if (error instanceof Anthropic.APIConnectionError) throw new AiTaskError('Không kết nối được dịch vụ AI. Kiểm tra kết nối Internet của máy chủ.', true);
      throw new AiTaskError(error instanceof Anthropic.APIError ? 'Dịch vụ AI tạm thời gặp lỗi. Vui lòng thử lại.' : 'Không thể hoàn tất yêu cầu AI.', (status ?? 0) >= 500);
    }
  }
}
