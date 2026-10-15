import { BadRequestException, Body, Controller, Delete, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { keyAllowedFor, type QuestionType } from '@classpulse/shared-types';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PrismaService } from './prisma.service';
import { AuthGuard, AuthRequest } from './auth';
import { QuizDto, UpdateQuizDto, QuestionDto, UpdateQuestionDto } from './dto';
const include = { questions: { where: { deletedAt: null }, orderBy: { order: 'asc' as const } } };
export const questionData = (q: QuestionDto) => ({ content: q.content, optionA: q.optionA, optionB: q.optionB, optionC: q.optionC, optionD: q.optionD, type: q.type ?? 'SINGLE', correctAnswer: q.correctAnswer,
  explanation: q.explanation ?? '', knowledge: q.knowledge ?? '', topic: q.topic ?? '', difficulty: q.difficulty ?? null, origin: q.origin ?? 'MANUAL', durationSeconds: q.durationSeconds, order: q.order });
/** A single-answer question keeps exactly one letter; multi-answer keys are validated by the DTO pattern. */
export function assertAnswerKeys(questions: Array<{ type?: QuestionType | null; correctAnswer: string }>) {
  questions.forEach((q, i) => { if (!keyAllowedFor(q.type ?? 'SINGLE', q.correctAnswer)) throw new BadRequestException(`Câu ${i + 1}: câu một đáp án chỉ được có một đáp án đúng; hãy chọn loại nhiều đáp án.`); });
}
@Injectable()
export class QuizService {
  constructor(private readonly db: PrismaService) {}
  list(teacherId: string) { return this.db.quiz.findMany({ where: { teacherId, deletedAt: null }, include, orderBy: { updatedAt: 'desc' } }); }
  async get(teacherId: string, id: string) {
    const quiz = await this.db.quiz.findFirst({ where: { id, teacherId, deletedAt: null }, include });
    if (!quiz) throw new NotFoundException('Không tìm thấy bộ câu hỏi.');
    return quiz;
  }
  async create(teacherId: string, input: QuizDto) { assertAnswerKeys(input.questions ?? []); return this.db.quiz.create({ data: { teacherId, title: input.title, description: input.description ?? '', questions: { create: (input.questions ?? []).map(questionData) } }, include }); }
  async update(teacherId: string, id: string, input: UpdateQuizDto) {
    await this.get(teacherId, id);
    assertAnswerKeys(input.questions ?? []);
    return this.db.$transaction(async tx => {
      if (input.questions) await tx.question.updateMany({ where: { quizId: id, deletedAt: null }, data: { deletedAt: new Date() } });
      return tx.quiz.update({ where: { id }, data: { title: input.title, description: input.description, ...(input.questions ? { questions: { create: input.questions.map(questionData) } } : {}) }, include });
    });
  }
  async remove(teacherId: string, id: string) { await this.get(teacherId, id); await this.db.quiz.update({ where: { id }, data: { deletedAt: new Date() } }); return { success: true }; }
  async duplicate(teacherId: string, id: string) { const quiz = await this.get(teacherId, id); return this.create(teacherId, { title: `${quiz.title} (bản sao)`.slice(0, 200), description: quiz.description, questions: quiz.questions }); }
  async addQuestion(teacherId: string, id: string, input: QuestionDto) { await this.get(teacherId, id); assertAnswerKeys([input]); return this.db.question.create({ data: { quizId: id, ...questionData(input) } }); }
  async changeQuestion(teacherId: string, id: string, questionId: string, input: UpdateQuestionDto | null) {
    await this.get(teacherId, id);
    const question = await this.db.question.findFirst({ where: { id: questionId, quizId: id, deletedAt: null } });
    if (!question) throw new NotFoundException('Không tìm thấy câu hỏi.');
    if (!input) { await this.db.question.update({ where: { id: questionId }, data: { deletedAt: new Date() } }); return { success: true }; }
    const { id: ignoredId, ...data } = input;
    assertAnswerKeys([{ type: data.type ?? question.type, correctAnswer: data.correctAnswer ?? question.correctAnswer }]);
    return this.db.question.update({ where: { id: questionId }, data });
  }
}
@ApiTags('Quizzes') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('quizzes')
export class QuizController {
  constructor(private readonly quizzes: QuizService) {}
  @Get() list(@Req() req: AuthRequest) { return this.quizzes.list(req.teacherId); }
  @Post() create(@Req() req: AuthRequest, @Body() input: QuizDto) { return this.quizzes.create(req.teacherId, input); }
  @Get(':id') get(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.quizzes.get(req.teacherId, id); }
  @Patch(':id') update(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() input: UpdateQuizDto) { return this.quizzes.update(req.teacherId, id, input); }
  @Delete(':id') remove(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.quizzes.remove(req.teacherId, id); }
  @Post(':id/duplicate') duplicate(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.quizzes.duplicate(req.teacherId, id); }
  @Post(':id/questions') addQuestion(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() input: QuestionDto) { return this.quizzes.addQuestion(req.teacherId, id, input); }
  @Patch(':id/questions/:questionId') updateQuestion(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('questionId', ParseUUIDPipe) questionId: string, @Body() input: UpdateQuestionDto) { return this.quizzes.changeQuestion(req.teacherId, id, questionId, input); }
  @Delete(':id/questions/:questionId') removeQuestion(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('questionId', ParseUUIDPipe) questionId: string) { return this.quizzes.changeQuestion(req.teacherId, id, questionId, null); }
}
