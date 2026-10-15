import { BadRequestException, Body, Controller, Delete, Get, Injectable, NotFoundException, OnModuleInit, Param, ParseUUIDPipe, Patch, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { AiJob as AiJobRecord, GeneratedQuestion as GeneratedRecord, Prisma, SourceDocument as DocumentRecord } from '@prisma/client';
import { z } from 'zod';
import {
  allocate, ANSWERS, DIFFICULTIES, QUESTION_LIMITS, questionIssues, shuffleWith, similarityMatcher, toAnswerKey,
  type AnswerChoice, type Difficulty, type GeneratedQuestion, type GenerationResult, type SourceDocument,
} from '@classpulse/shared-types';
import { AuthGuard, AuthRequest } from './auth';
import { AiJobsService, AiService, AiTaskError, choice, pick, type AiPart, type AiUsage } from './ai';
import { ApproveGeneratedDto, GeneratedIdsDto, GeneratedQuestionUpdateDto, GenerateQuestionsDto } from './dto';
import { decodeText, detectFormat, MAX_UPLOAD_BYTES, readDocx, readPdf, textLines, uploadName, type UploadedFile as Upload } from './extract';
import { PrismaService } from './prisma.service';
import { assertAnswerKeys } from './quizzes';
import { detectSections, sectionView, type StoredSection } from './sections';

export const MAX_MATERIAL_CHARS = 500_000;
const MAX_DOCUMENT_CHARS = 3_000_000;
const BATCH_SIZE = 12;

export interface BatchSlot { difficulty: Difficulty; multiple: boolean; key: AnswerChoice | null }
export interface BatchPlan { size: number; counts: Record<Difficulty, number>; multiple: number; slots: BatchSlot[] }
/**
 * Interleaves difficulties (smooth weighted round-robin) so every batch gets a fair mix, then cuts batches.
 * Single-answer slots get balanced, shuffled key positions: models left alone favour A and B.
 */
export function planBatches(count: number, percents: [number, number, number], multiplePercent: number, batchSize = BATCH_SIZE, random = Math.random): BatchPlan[] {
  const totals = allocate(count, percents);
  const current = [0, 0, 0];
  const slots: Difficulty[] = [];
  for (let i = 0; i < count; i++) {
    for (let d = 0; d < 3; d++) current[d] += totals[d];
    const pick = current.indexOf(Math.max(...current));
    current[pick] -= count;
    slots.push(DIFFICULTIES[pick]);
  }
  const multiple = Math.round(count * multiplePercent / 100);
  const isMultiple = (i: number) => Math.floor((i + 1) * multiple / count) > Math.floor(i * multiple / count);
  const singles = slots.map((_, i) => i).filter(i => !isMultiple(i));
  const keys = shuffleWith(singles.map((_, n) => ANSWERS[n % ANSWERS.length]), random);
  const keyOf = new Map(singles.map((slot, n) => [slot, keys[n]]));
  const plans: BatchPlan[] = [];
  for (let offset = 0; offset < count; offset += batchSize) {
    const slice = slots.slice(offset, offset + batchSize).map((difficulty, k): BatchSlot => ({ difficulty, multiple: isMultiple(offset + k), key: keyOf.get(offset + k) ?? null }));
    plans.push({ size: slice.length, counts: { EASY: slice.filter(slot => slot.difficulty === 'EASY').length, MEDIUM: slice.filter(slot => slot.difficulty === 'MEDIUM').length, HARD: slice.filter(slot => slot.difficulty === 'HARD').length },
      multiple: slice.filter(slot => slot.multiple).length, slots: slice });
  }
  return plans;
}

export const GeneratedSchema = z.object({
  questions: z.array(z.object({
    content: z.string(), optionA: z.string(), optionB: z.string(), optionC: z.string(), optionD: z.string(),
    type: choice(['SINGLE', 'MULTIPLE']), correctOptions: z.array(choice(ANSWERS)).describe('Letters of the correct options, e.g. ["B"] or ["A", "C"]'),
    difficulty: choice(DIFFICULTIES),
    explanation: z.string(), knowledge: z.string(), topic: z.string(), sourceExcerpt: z.string(),
  })),
});
const GENERATION_SYSTEM = `You are an experienced assessment designer who writes multiple-choice questions for Vietnamese classrooms. Students answer on a keypad with options A–D, so every question has exactly four options. You write questions only from the course material the teacher provides.

Requirements for every question:
- It is answerable from the material alone. Never invent facts, numbers or definitions the material does not support.
- The stem is self-contained and gives every number, unit and condition needed. It does not refer to figures, tables or pages, because students only see text.
- Wording is precise and unambiguous. Avoid double negatives. If a negative stem is necessary, write the negative word in capitals (KHÔNG, SAI, NGOẠI TRỪ).
- SINGLE questions have exactly one correct option. MULTIPLE questions have two or three correct options and the stem explicitly asks students to choose all correct answers (for example "Chọn tất cả các đáp án đúng").
- Distractors are plausible to a student with partial understanding (common misconceptions, calculation slips, confusable concepts from the material) yet clearly wrong to an expert. Options are similar in length, grammar and level of detail so none stands out. Do not use "Tất cả các đáp án trên", "Không có đáp án nào", "Cả A và B" or any option that refers to other options.
- Put the correct option at the position given for each question. In MULTIPLE questions, spread the correct options across A–D.
- Difficulty: EASY = recall or recognise something stated in the material (nhận biết). MEDIUM = explain, compare or apply one concept in a familiar situation (thông hiểu, vận dụng). HARD = multi-step reasoning, analysis, or combining several ideas in a new situation (vận dụng cao).
- explanation (lời giải): why the correct option is right and, briefly, why each distractor is wrong. Refer to options by their content, never by letter, because options may be shuffled.
- knowledge: the specific concept or skill being tested, as one short phrase.
- topic: the title of the chapter or section the question comes from, as written in the material.
- sourceExcerpt: a short verbatim quotation (at most about 200 characters) from the material that supports the correct answer.
- Write in the language of the material (normally Vietnamese) with correct diacritics.
- Each question tests a different point. Never repeat or paraphrase a question listed as already written.`;

function documentView(doc: DocumentRecord): SourceDocument {
  return { id: doc.id, filename: doc.filename, mimeType: doc.mimeType, size: doc.size, pageCount: doc.pageCount, charCount: doc.text.length,
    sections: sectionView(doc.text, doc.sections as unknown as StoredSection[]), scanned: doc.data !== null, createdAt: doc.createdAt.toISOString() };
}
const generatedView = (row: GeneratedRecord, extra: Pick<GeneratedQuestion, 'documentName' | 'duplicate'>): GeneratedQuestion => ({
  id: row.id, jobId: row.jobId, content: row.content, optionA: row.optionA, optionB: row.optionB, optionC: row.optionC, optionD: row.optionD, type: row.type,
  correctAnswer: row.correctAnswer as GeneratedQuestion['correctAnswer'], explanation: row.explanation, knowledge: row.knowledge, topic: row.topic, difficulty: row.difficulty,
  sourceExcerpt: row.sourceExcerpt, status: row.status, quizId: row.quizId, questionId: row.questionId, order: row.order, createdAt: row.createdAt.toISOString(),
  reviewedAt: row.reviewedAt?.toISOString() ?? null, ...extra,
});
type GenerationInput = { documentId: string; sectionIndexes: number[]; questionCount: number; easyPercent: number; mediumPercent: number; hardPercent: number; multiplePercent: number; instructions: string; quizId: string | null };

@Injectable()
export class GenerationService implements OnModuleInit {
  constructor(private readonly db: PrismaService, private readonly ai: AiService, private readonly jobs: AiJobsService) {}
  onModuleInit() { this.jobs.register('GENERATE_QUESTIONS', (job, progress) => this.run(job, progress)); }

  async upload(teacherId: string, file: Upload) {
    const format = detectFormat(file, ['pdf', 'docx', 'txt', 'md']);
    let lines, pageCount: number | null = null, scanned = false;
    if (format === 'pdf') ({ lines, pageCount, scanned } = await readPdf(file.buffer));
    else if (format === 'docx') lines = await readDocx(file.buffer);
    else lines = textLines(decodeText(file.buffer));
    const { text, sections } = scanned ? { text: '', sections: [{ title: 'Toàn bộ tài liệu (PDF dạng ảnh)', start: 0, end: 0, pageStart: 1, pageEnd: pageCount }] } : detectSections(lines);
    if (!scanned && text.replace(/\s/g, '').length < 200) throw new BadRequestException('Tài liệu quá ngắn để tạo câu hỏi (cần ít nhất vài đoạn văn).');
    if (text.length > MAX_DOCUMENT_CHARS) throw new BadRequestException('Tài liệu quá dài. Hãy tách thành các file nhỏ hơn (tối đa khoảng 3 triệu ký tự).');
    const doc = await this.db.sourceDocument.create({ data: { teacherId, filename: uploadName(file), mimeType: file.mimetype || 'application/octet-stream', size: file.size, pageCount, text,
      sections: sections as unknown as Prisma.InputJsonValue, data: scanned ? file.buffer : null } });
    return documentView(doc);
  }
  async documents(teacherId: string) {
    const docs = await this.db.sourceDocument.findMany({ where: { teacherId, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 50 });
    return docs.map(documentView);
  }
  private async ownedDocument(teacherId: string, id: string) {
    const doc = await this.db.sourceDocument.findFirst({ where: { id, teacherId, deletedAt: null } });
    if (!doc) throw new NotFoundException('Không tìm thấy tài liệu.');
    return doc;
  }
  async document(teacherId: string, id: string) { return documentView(await this.ownedDocument(teacherId, id)); }
  async removeDocument(teacherId: string, id: string) {
    await this.ownedDocument(teacherId, id);
    await this.db.sourceDocument.update({ where: { id }, data: { deletedAt: new Date(), data: null } });
    return { success: true };
  }

  async start(teacherId: string, input: GenerateQuestionsDto) {
    if (input.easyPercent + input.mediumPercent + input.hardPercent !== 100) throw new BadRequestException('Tổng tỷ lệ câu dễ, trung bình và khó phải bằng 100%.');
    const doc = await this.ownedDocument(teacherId, input.documentId);
    const sections = doc.sections as unknown as StoredSection[];
    const indexes = [...new Set(input.sectionIndexes)].sort((a, b) => a - b);
    if (indexes.some(index => !sections[index])) throw new BadRequestException('Chương đã chọn không thuộc tài liệu.');
    const length = indexes.reduce((sum, index) => sum + sections[index].end - sections[index].start, 0);
    if (!doc.data && length > MAX_MATERIAL_CHARS) throw new BadRequestException(`Các chương đã chọn dài ${length.toLocaleString('vi-VN')} ký tự; hãy chọn ít chương hơn (tối đa ${MAX_MATERIAL_CHARS.toLocaleString('vi-VN')} ký tự mỗi lần).`);
    if (input.quizId && !await this.db.quiz.findFirst({ where: { id: input.quizId, teacherId, deletedAt: null }, select: { id: true } })) throw new NotFoundException('Không tìm thấy bộ câu hỏi.');
    const data: GenerationInput = { documentId: doc.id, sectionIndexes: indexes, questionCount: input.questionCount, easyPercent: input.easyPercent, mediumPercent: input.mediumPercent,
      hardPercent: input.hardPercent, multiplePercent: input.multiplePercent ?? 0, instructions: input.instructions ?? '', quizId: input.quizId ?? null };
    return this.jobs.enqueue<GenerationResult>(teacherId, 'GENERATE_QUESTIONS', { documentId: doc.id, ...(input.quizId ? { quizId: input.quizId } : {}) }, data);
  }
  private async run(job: AiJobRecord, progress: (value: number) => Promise<void>) {
    const input = job.input as unknown as GenerationInput;
    const doc = await this.db.sourceDocument.findFirst({ where: { id: input.documentId, teacherId: job.teacherId } });
    if (!doc) throw new AiTaskError('Tài liệu nguồn không còn tồn tại.');
    const sections = (doc.sections as unknown as StoredSection[]).filter((_, index) => input.sectionIndexes.includes(index));
    // The material block is identical for every batch; providers with prompt caching re-read it cheaply.
    const material: AiPart = doc.data
      ? { type: 'pdf', data: Buffer.from(doc.data).toString('base64'), title: doc.filename, cache: true }
      : { type: 'text', text: `<material source="${doc.filename}">\n${sections.map(section => `<section title="${section.title.replace(/"/g, "'")}">\n${doc.text.slice(section.start, section.end).trim()}\n</section>`).join('\n')}\n</material>`, cache: true };
    const existing = input.quizId ? (await this.db.question.findMany({ where: { quizId: input.quizId, deletedAt: null }, select: { content: true }, take: 150 })).map(q => q.content) : [];
    const plans = planBatches(input.questionCount, [input.easyPercent, input.mediumPercent, input.hardPercent], input.multiplePercent);
    const usage: AiUsage = { inputTokens: 0, outputTokens: 0 };
    const written: string[] = [];
    const counts: Record<Difficulty, number> = { EASY: 0, MEDIUM: 0, HARD: 0 };
    for (const [index, plan] of plans.entries()) {
      const avoid = [...existing, ...written].map((content, i) => `${i + 1}. ${content.replace(/\s+/g, ' ').slice(0, 180)}`).join('\n');
      const request = [
        `Write exactly ${plan.size} new multiple-choice questions from the material above, in this order:`,
        ...plan.slots.map((slot, k) => `${k + 1}. ${slot.difficulty}, ${slot.multiple ? 'MULTIPLE (two or three correct options)' : `SINGLE, correct option ${slot.key}`}`),
        `- Difficulty: ${plan.counts.EASY} EASY, ${plan.counts.MEDIUM} MEDIUM, ${plan.counts.HARD} HARD.`,
        `- Type: ${plan.multiple} MULTIPLE (two or three correct options), ${plan.size - plan.multiple} SINGLE (exactly one correct option).`,
        doc.data ? '' : `- Cover these chapters in proportion to their length: ${sections.map(section => `"${section.title}"`).join(', ')}.`,
        input.instructions ? `- Teacher's additional instructions (follow them unless they conflict with the requirements): ${input.instructions}` : '',
        avoid ? `\nQuestions already written — do not repeat or paraphrase them:\n${avoid}` : '',
      ].filter(Boolean).join('\n');
      const { data, usage: used } = await this.ai.structured({ system: GENERATION_SYSTEM, content: [material, { type: 'text', text: request }], schema: GeneratedSchema, effort: 'high' });
      usage.inputTokens += used.inputTokens; usage.outputTokens += used.outputTokens;
      const offset = written.length;
      const rows = data.questions.slice(0, plan.size).map((item, k) => {
        const key = toAnswerKey(item.correctOptions) ?? '';
        const difficulty = pick(item.difficulty, DIFFICULTIES, 'MEDIUM');
        counts[difficulty]++;
        written.push(item.content);
        return { jobId: job.id, teacherId: job.teacherId, content: item.content.trim().slice(0, QUESTION_LIMITS.content), optionA: item.optionA.trim().slice(0, QUESTION_LIMITS.option),
          optionB: item.optionB.trim().slice(0, QUESTION_LIMITS.option), optionC: item.optionC.trim().slice(0, QUESTION_LIMITS.option), optionD: item.optionD.trim().slice(0, QUESTION_LIMITS.option),
          type: pick(item.type, ['SINGLE', 'MULTIPLE'] as const, 'SINGLE') === 'MULTIPLE' || key.length > 1 ? 'MULTIPLE' as const : 'SINGLE' as const, correctAnswer: key, difficulty,
          explanation: item.explanation.trim().slice(0, QUESTION_LIMITS.explanation), knowledge: item.knowledge.trim().slice(0, QUESTION_LIMITS.knowledge),
          topic: item.topic.trim().slice(0, QUESTION_LIMITS.topic), sourceExcerpt: item.sourceExcerpt.trim().slice(0, 600), order: offset + k };
      });
      // Each batch is saved immediately so a later failure keeps the questions already written.
      await this.db.generatedQuestion.createMany({ data: rows });
      await progress((index + 1) * 100 / plans.length);
    }
    const result: GenerationResult = { created: written.length, counts };
    return { result: result as unknown as Prisma.InputJsonValue, usage };
  }

  async generated(teacherId: string, filter: { status?: string; jobId?: string }) {
    const status = ['PENDING', 'APPROVED', 'REJECTED'].includes(filter.status ?? '') ? filter.status as 'PENDING' | 'APPROVED' | 'REJECTED' : 'PENDING';
    const rows = await this.db.generatedQuestion.findMany({ where: { teacherId, status, ...(filter.jobId ? { jobId: filter.jobId } : {}) }, orderBy: [{ createdAt: 'desc' }, { order: 'asc' }], take: 300, include: { job: { select: { documentId: true } } } });
    const documentIds = [...new Set(rows.map(row => row.job.documentId).filter((id): id is string => !!id))];
    const names = new Map((await this.db.sourceDocument.findMany({ where: { id: { in: documentIds } }, select: { id: true, filename: true } })).map(doc => [doc.id, doc.filename]));
    let duplicateOf: (row: GeneratedRecord) => GeneratedQuestion['duplicate'] = () => null;
    if (status === 'PENDING' && rows.length) {
      const bank = await this.db.question.findMany({ where: { deletedAt: null, quiz: { teacherId, deletedAt: null } }, select: { id: true, content: true, optionA: true, optionB: true, optionC: true, optionD: true, quizId: true, quiz: { select: { title: true } } } });
      const byId = new Map(bank.map(question => [question.id, question]));
      const match = similarityMatcher(bank.map(q => ({ id: q.id, content: q.content, options: [q.optionA, q.optionB, q.optionC, q.optionD] })));
      duplicateOf = row => {
        const hit = match({ id: row.id, content: row.content, options: [row.optionA, row.optionB, row.optionC, row.optionD] }, 0.75);
        const question = hit && byId.get(hit.id);
        return question ? { questionId: question.id, quizId: question.quizId, quizTitle: question.quiz.title, content: question.content, similarity: hit!.score } : null;
      };
    }
    return rows.map(row => generatedView(row, { documentName: row.job.documentId ? names.get(row.job.documentId) ?? null : null, duplicate: duplicateOf(row) }));
  }
  async pendingCount(teacherId: string) { return { pending: await this.db.generatedQuestion.count({ where: { teacherId, status: 'PENDING' } }) }; }
  private async ownedPending(teacherId: string, ids: string[]) {
    const rows = await this.db.generatedQuestion.findMany({ where: { id: { in: ids }, teacherId } });
    if (rows.length !== new Set(ids).size) throw new NotFoundException('Không tìm thấy một số câu hỏi đề xuất.');
    if (rows.some(row => row.status !== 'PENDING')) throw new BadRequestException('Chỉ thao tác được với câu hỏi đang chờ duyệt.');
    return rows;
  }
  async update(teacherId: string, id: string, input: GeneratedQuestionUpdateDto) {
    const [row] = await this.ownedPending(teacherId, [id]);
    assertAnswerKeys([{ type: input.type ?? row.type, correctAnswer: input.correctAnswer ?? row.correctAnswer }].filter(item => item.correctAnswer));
    const updated = await this.db.generatedQuestion.update({ where: { id }, data: input });
    return generatedView(updated, { documentName: null, duplicate: null });
  }
  /** Copies approved proposals into a quiz in one transaction; nothing reaches a quiz without this step. */
  async approve(teacherId: string, input: ApproveGeneratedDto) {
    if (!input.quizId && !input.newQuizTitle) throw new BadRequestException('Chọn bộ câu hỏi đích hoặc nhập tên bộ câu hỏi mới.');
    const ids = [...new Set(input.ids)];
    const rows = (await this.ownedPending(teacherId, ids)).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    const problems = rows.map((row, i) => ({ i, issues: questionIssues({ ...row, correctAnswer: row.correctAnswer as GeneratedQuestion['correctAnswer'], durationSeconds: input.durationSeconds ?? 30, order: 0 }) })).filter(item => item.issues.length);
    if (problems.length) throw new BadRequestException(`Hãy sửa trước khi duyệt: ${problems.slice(0, 3).map(p => `câu “${rows[p.i].content.slice(0, 40)}…”: ${p.issues[0]}`).join(' ')}`);
    return this.db.$transaction(async tx => {
      const quiz = input.quizId
        ? await tx.quiz.findFirst({ where: { id: input.quizId, teacherId, deletedAt: null }, include: { questions: { where: { deletedAt: null }, select: { order: true } } } })
        : await tx.quiz.create({ data: { teacherId, title: input.newQuizTitle!, description: 'Câu hỏi do AI đề xuất và giáo viên đã duyệt.' }, include: { questions: { where: { deletedAt: null }, select: { order: true } } } });
      if (!quiz) throw new NotFoundException('Không tìm thấy bộ câu hỏi.');
      if (quiz.questions.length + rows.length > QUESTION_LIMITS.questionsPerQuiz) throw new BadRequestException(`Bộ câu hỏi chỉ chứa tối đa ${QUESTION_LIMITS.questionsPerQuiz} câu; hiện có ${quiz.questions.length} câu.`);
      let order = quiz.questions.reduce((max, q) => Math.max(max, q.order), -1);
      for (const row of rows) {
        const question = await tx.question.create({ data: { quizId: quiz.id, content: row.content, optionA: row.optionA, optionB: row.optionB, optionC: row.optionC, optionD: row.optionD, type: row.type,
          correctAnswer: row.correctAnswer, explanation: row.explanation, knowledge: row.knowledge, topic: row.topic, difficulty: row.difficulty, origin: 'AI', durationSeconds: input.durationSeconds ?? 30, order: ++order } });
        await tx.generatedQuestion.update({ where: { id: row.id }, data: { status: 'APPROVED', quizId: quiz.id, questionId: question.id, reviewedAt: new Date() } });
      }
      await tx.quiz.update({ where: { id: quiz.id }, data: { updatedAt: new Date() } });
      return { quizId: quiz.id, quizTitle: quiz.title, approved: rows.length };
    });
  }
  async reject(teacherId: string, ids: string[]) {
    await this.ownedPending(teacherId, ids);
    const { count } = await this.db.generatedQuestion.updateMany({ where: { id: { in: ids }, teacherId, status: 'PENDING' }, data: { status: 'REJECTED', reviewedAt: new Date() } });
    return { rejected: count };
  }
  async reopen(teacherId: string, ids: string[]) {
    const { count } = await this.db.generatedQuestion.updateMany({ where: { id: { in: ids }, teacherId, status: 'REJECTED' }, data: { status: 'PENDING', reviewedAt: null } });
    return { reopened: count };
  }
}

const upload = FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
@ApiTags('AI') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('ai')
export class GenerationController {
  constructor(private readonly generation: GenerationService) {}
  @Post('documents') @UseInterceptors(upload) @ApiConsumes('multipart/form-data') @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  upload(@Req() req: AuthRequest, @UploadedFile() file: Upload) { return this.generation.upload(req.teacherId, file); }
  @Get('documents') documents(@Req() req: AuthRequest) { return this.generation.documents(req.teacherId); }
  @Get('documents/:id') document(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.generation.document(req.teacherId, id); }
  @Delete('documents/:id') removeDocument(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.generation.removeDocument(req.teacherId, id); }
  @Post('generate') generate(@Req() req: AuthRequest, @Body() input: GenerateQuestionsDto) { return this.generation.start(req.teacherId, input); }
  @Get('generated') generated(@Req() req: AuthRequest, @Query('status') status?: string, @Query('jobId') jobId?: string) { return this.generation.generated(req.teacherId, { status, jobId: jobId && /^[0-9a-f-]{36}$/i.test(jobId) ? jobId : undefined }); }
  @Get('generated/count') count(@Req() req: AuthRequest) { return this.generation.pendingCount(req.teacherId); }
  @Patch('generated/:id') update(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() input: GeneratedQuestionUpdateDto) { return this.generation.update(req.teacherId, id, input); }
  @Post('generated/approve') approve(@Req() req: AuthRequest, @Body() input: ApproveGeneratedDto) { return this.generation.approve(req.teacherId, input); }
  @Post('generated/reject') reject(@Req() req: AuthRequest, @Body() input: GeneratedIdsDto) { return this.generation.reject(req.teacherId, input.ids); }
  @Post('generated/reopen') reopen(@Req() req: AuthRequest, @Body() input: GeneratedIdsDto) { return this.generation.reopen(req.teacherId, input.ids); }
}
