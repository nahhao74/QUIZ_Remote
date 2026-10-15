import { ArgumentsHost, Catch, Controller, ExceptionFilter, Get, HttpException, HttpStatus, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { PrismaService } from './prisma.service';
import { MqttService } from './mqtt';
import { AiService } from './ai';
import { allowedOrigins } from './realtime';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: unknown = 'Đã xảy ra lỗi máy chủ.';
    if (error instanceof HttpException) {
      status = error.getStatus(); const body = error.getResponse();
      message = typeof body === 'string' ? body : (body as { message?: unknown }).message ?? 'Yêu cầu không hợp lệ.';
    } else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      status = HttpStatus.CONFLICT; message = 'Dữ liệu đã tồn tại.';
    } else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      status = HttpStatus.NOT_FOUND; message = 'Không tìm thấy dữ liệu.';
    } else this.logger.error(JSON.stringify({ event: 'unhandled_http_error', requestId: res.getHeader('x-request-id') }));
    res.status(status).json({ statusCode: status, message, requestId: res.getHeader('x-request-id'), timestamp: new Date().toISOString() });
  }
}
/** In-memory limits protect this single-instance MVP; deploy Redis-backed limits when scaling. */
export function securityMiddleware() {
  const buckets = new Map<string, { count: number; until: number }>();
  const logger = new Logger('HTTP');
  let lastPrune = Date.now();
  return (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.setHeader('x-request-id', randomUUID());
    res.on('finish', () => logger.log(JSON.stringify({ event: 'http_request', requestId: res.getHeader('x-request-id'), method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - start })));
    if (start - lastPrune > 60000) { for (const [key, bucket] of buckets) if (bucket.until <= start) buckets.delete(key); lastPrune = start; }
    const sensitive = /^\/api\/auth\/(login|register)$/.test(req.path);
    const key = `${req.ip}:${sensitive ? 'credentials' : 'api'}`;
    const bucket = buckets.get(key);
    const current = bucket && bucket.until > start ? bucket : { count: 0, until: start + 60000 };
    current.count++; buckets.set(key, current);
    const maximum = sensitive ? Number(process.env.AUTH_RATE_LIMIT ?? 20) : Number(process.env.API_RATE_LIMIT ?? 600);
    if (current.count > maximum) { res.setHeader('Retry-After', Math.max(1, Math.ceil((current.until - start) / 1000))); return res.status(429).json({ statusCode: 429, message: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.' }); }
    const origin = req.headers.origin;
    if (origin && !['GET','HEAD','OPTIONS'].includes(req.method) && !allowedOrigins().includes(origin)) return res.status(403).json({ statusCode: 403, message: 'Origin không được phép.' });
    next();
  };
}
@ApiTags('Health') @Controller('health')
export class HealthController {
  constructor(private readonly db: PrismaService, private readonly mqtt: MqttService, private readonly ai: AiService) {}
  @Get() async health() {
    let database = false;
    try { await this.db.$queryRaw`SELECT 1`; database = true; } catch {}
    const ready = database && (!this.mqtt.enabled || this.mqtt.connected);
    const result = { status: ready ? 'ok' : 'degraded', api: 'up', database: database ? 'up' : 'down', mqtt: this.mqtt.enabled ? (this.mqtt.connected ? 'up' : 'down') : 'disabled', ai: this.ai.enabled ? 'configured' : 'disabled', serverTime: new Date().toISOString() };
    if (!ready) throw new ServiceUnavailableException({ message: result });
    return result;
  }
}
