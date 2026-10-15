import 'reflect-metadata';
import { ConsoleLogger, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { JwtModule } from '@nestjs/jwt';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AuthController, AuthGuard, AuthService, TeacherController } from './auth';
import { PrismaService } from './prisma.service';
import { QuizController, QuizService } from './quizzes';
import { SessionController, SessionService } from './sessions';
import { SessionEvents } from './events';
import { MqttProcessor, MqttService } from './mqtt';
import { allowedOrigins, RealtimeGateway } from './realtime';
import { ApiExceptionFilter, HealthController, securityMiddleware } from './http';
import { AiController, AiJobsService, AiService } from './ai';
import { ImportController, ImportService } from './imports';
import { GenerationController, GenerationService } from './generation';
import { BankController, BankService } from './bank';
import { QualityController, QualityService } from './quality';
import { AnalyticsController, AnalyticsService } from './analytics';
import { ClassController, ClassService } from './classes';
import { ExamController, ExamService } from './exams';

@Module({
  imports: [JwtModule.registerAsync({ useFactory: () => {
    const secret = process.env.JWT_ACCESS_SECRET ?? process.env.JWT_SECRET;
    if (!secret || secret.length < 32) throw new Error('JWT_ACCESS_SECRET must contain at least 32 characters. Set it in .env before starting.');
    return { secret, signOptions: { algorithm: 'HS256' }, verifyOptions: { algorithms: ['HS256'] } };
  } })],
  controllers: [AuthController, TeacherController, QuizController, QualityController, SessionController, AnalyticsController, HealthController, AiController, GenerationController, ImportController, BankController, ClassController, ExamController],
  providers: [PrismaService, AuthService, AuthGuard, QuizService, SessionService, SessionEvents, MqttProcessor, MqttService, RealtimeGateway,
    AiService, AiJobsService, ImportService, GenerationService, BankService, QualityService, AnalyticsService, ClassService, ExamService],
})
export class AppModule {}

export async function createApp(options: { logger?: false } = {}) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: options.logger ?? new ConsoleLogger({ json: true }), bodyParser: true });
  // Quizzes of 200 questions with explanations exceed the 100 KB default; uploads use multipart instead.
  app.useBodyParser('json', { limit: '5mb' });
  const express = app.getHttpAdapter().getInstance();
  express.disable('x-powered-by');
  if (process.env.TRUST_PROXY === 'true') express.set('trust proxy', 1);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => callback(null, !origin || allowedOrigins().includes(origin)), credentials: true });
  app.use(helmet()); app.use(cookieParser()); app.use(securityMiddleware());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new ApiExceptionFilter());
  const config = new DocumentBuilder().setTitle('ClassPulse API').setDescription('Teacher API; students submit only through MQTT.').setVersion('1.0.0').addBearerAuth().build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));
  app.enableShutdownHooks();
  return app;
}
