import { Controller, Get, Injectable, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { findDuplicatePairs, matchesSearch, type BankQuestion, type BankSearchResult, type DuplicatePairView } from '@classpulse/shared-types';
import { AuthGuard, AuthRequest } from './auth';
import { PrismaService } from './prisma.service';

const uuid = (value?: string) => (value && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined);
@Injectable()
export class BankService {
  constructor(private readonly db: PrismaService) {}
  /** Every live question in the teacher's live quizzes, in quiz order. */
  async all(teacherId: string): Promise<BankQuestion[]> {
    const rows = await this.db.question.findMany({ where: { deletedAt: null, quiz: { teacherId, deletedAt: null } }, include: { quiz: { select: { title: true, updatedAt: true } } }, orderBy: [{ quiz: { updatedAt: 'desc' } }, { order: 'asc' }] });
    return rows.map(({ quiz, deletedAt, ...question }) => ({ ...question, correctAnswer: question.correctAnswer as BankQuestion['correctAnswer'], quizTitle: quiz.title, updatedAt: quiz.updatedAt.toISOString() }));
  }
  async search(teacherId: string, filter: { search?: string; quizId?: string; difficulty?: string; type?: string; topic?: string; origin?: string }): Promise<BankSearchResult> {
    const all = await this.all(teacherId);
    const items = all.filter(q => (!filter.quizId || q.quizId === filter.quizId)
      && (!filter.difficulty || (filter.difficulty === 'UNSET' ? !q.difficulty : q.difficulty === filter.difficulty))
      && (!filter.type || q.type === filter.type) && (!filter.origin || q.origin === filter.origin) && (!filter.topic || q.topic === filter.topic)
      && (!filter.search?.trim() || matchesSearch([q.content, q.optionA, q.optionB, q.optionC, q.optionD, q.topic, q.knowledge, q.explanation, q.quizTitle].join(' '), filter.search)));
    return { total: items.length, items: items.slice(0, 500), topics: [...new Set(all.map(q => q.topic).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi')) };
  }
  /** Near-duplicate pairs across the bank; with a quiz, only pairs involving that quiz's questions. */
  async duplicates(teacherId: string, threshold: number, quizId?: string): Promise<DuplicatePairView[]> {
    const all = await this.all(teacherId);
    const byId = new Map(all.map(q => [q.id, q]));
    const pairs = findDuplicatePairs(all.map(q => ({ id: q.id, content: q.content, options: [q.optionA, q.optionB, q.optionC, q.optionD] })), threshold, 2000);
    return pairs.filter(pair => !quizId || byId.get(pair.a)!.quizId === quizId || byId.get(pair.b)!.quizId === quizId).slice(0, 300)
      .map(pair => ({ ...pair, a: byId.get(pair.a)!, b: byId.get(pair.b)! }));
  }
}
@ApiTags('Question bank') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('bank')
export class BankController {
  constructor(private readonly bank: BankService) {}
  @Get('questions') @ApiQuery({ name: 'search', required: false }) @ApiQuery({ name: 'quizId', required: false }) @ApiQuery({ name: 'difficulty', required: false, enum: ['EASY', 'MEDIUM', 'HARD', 'UNSET'] })
  @ApiQuery({ name: 'type', required: false, enum: ['SINGLE', 'MULTIPLE'] }) @ApiQuery({ name: 'topic', required: false }) @ApiQuery({ name: 'origin', required: false, enum: ['MANUAL', 'IMPORT', 'AI'] })
  search(@Req() req: AuthRequest, @Query('search') search?: string, @Query('quizId') quizId?: string, @Query('difficulty') difficulty?: string, @Query('type') type?: string, @Query('topic') topic?: string, @Query('origin') origin?: string) {
    return this.bank.search(req.teacherId, { search: search?.slice(0, 200), quizId: uuid(quizId), difficulty, type, topic, origin });
  }
  @Get('duplicates') @ApiQuery({ name: 'threshold', required: false, description: '0.5–0.99, mặc định 0.8' }) @ApiQuery({ name: 'quizId', required: false })
  duplicates(@Req() req: AuthRequest, @Query('threshold') threshold?: string, @Query('quizId') quizId?: string) {
    const value = Number(threshold);
    return this.bank.duplicates(req.teacherId, Number.isFinite(value) ? Math.min(0.99, Math.max(0.5, value)) : 0.8, uuid(quizId));
  }
}
