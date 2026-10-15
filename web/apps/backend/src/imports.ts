import { BadRequestException, Controller, Get, Injectable, OnModuleInit, Post, Req, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import ExcelJS from 'exceljs';
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  ANSWERS, foldText, parseDifficulty, parseQuestionLines, questionIssues, QUESTION_LIMITS, QUESTION_TEXT_SAMPLE, toAnswerKey,
  type ImportFormat, type ImportResult, type QuestionDraft, type QuestionType,
} from '@classpulse/shared-types';
import { AuthGuard, AuthRequest } from './auth';
import { AiJobsService, AiService, choice, pick, type AiPart, type AiUsage } from './ai';
import { decodeText, detectFormat, MAX_UPLOAD_BYTES, readDocx, readPdf, readSpreadsheet, textLines, uploadName, type UploadedFile as Upload } from './extract';

type Field = 'number' | 'content' | 'A' | 'B' | 'C' | 'D' | 'key' | 'type' | 'time' | 'explanation' | 'knowledge' | 'topic' | 'difficulty';
const HEADERS: Record<Field, string[]> = {
  number: ['stt', 'cau', 'cau so', 'so thu tu', 'no', 'so'],
  content: ['cau hoi', 'noi dung', 'noi dung cau hoi', 'question', 'de bai', 'cau dan'],
  A: ['a', 'dap an a', 'phuong an a', 'lua chon a', 'option a', 'pa a'],
  B: ['b', 'dap an b', 'phuong an b', 'lua chon b', 'option b', 'pa b'],
  C: ['c', 'dap an c', 'phuong an c', 'lua chon c', 'option c', 'pa c'],
  D: ['d', 'dap an d', 'phuong an d', 'lua chon d', 'option d', 'pa d'],
  key: ['dap an', 'dap an dung', 'answer', 'key', 'da', 'correct', 'correct answer'],
  type: ['loai', 'loai cau', 'loai cau hoi', 'type', 'kieu'],
  time: ['thoi gian', 'time', 'giay', 'seconds', 'duration'],
  explanation: ['giai thich', 'loi giai', 'explanation', 'huong dan giai', 'huong dan'],
  knowledge: ['kien thuc', 'kien thuc kiem tra', 'knowledge', 'muc tieu'],
  topic: ['chu de', 'chuong', 'topic', 'chapter', 'bai'],
  difficulty: ['do kho', 'muc do', 'difficulty', 'level', 'cap do'],
};
/** Exact header names win; otherwise the longest alias that starts the header ("thoi gian giay" → time). */
function headerField(cell: string): Field | null {
  const folded = foldText(cell);
  if (!folded) return null;
  let best: { field: Field; length: number } | null = null;
  for (const [field, aliases] of Object.entries(HEADERS) as Array<[Field, string[]]>) for (const alias of aliases) {
    if (folded === alias) return field;
    if (folded.startsWith(`${alias} `) && alias.length > 1 && (!best || alias.length > best.length)) best = { field, length: alias.length };
  }
  return best?.field ?? null;
}
const DEFAULT_COLUMNS: Field[] = ['content', 'A', 'B', 'C', 'D', 'key', 'time', 'explanation'];
/** One question per spreadsheet row; the header row may sit anywhere in the first ten rows. */
export function questionsFromRows(rows: string[][], filename: string): Omit<ImportResult, 'sourceName' | 'format'> {
  let columns: Array<Field | null> = [];
  let headerIndex = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const mapped = rows[i].map(headerField);
    if (mapped.includes('content') && (['A', 'B', 'C', 'D'] as Field[]).filter(f => mapped.includes(f)).length >= 2) { columns = mapped; headerIndex = i; break; }
  }
  const warnings: string[] = [];
  if (headerIndex < 0) {
    const numbered = rows.slice(0, 5).filter(row => /^\d+$/.test(row[0] ?? '')).length >= 3;
    columns = numbered ? ['number', ...DEFAULT_COLUMNS] : DEFAULT_COLUMNS;
    warnings.push('Không tìm thấy dòng tiêu đề cột; đã đọc theo thứ tự: Câu hỏi, A, B, C, D, Đáp án, Thời gian, Lời giải. Nên dùng file mẫu.');
  }
  const questions: QuestionDraft[] = [];
  rows.slice(headerIndex + 1).forEach((row, offset) => {
    const value = (field: Field) => { const index = columns.indexOf(field); return index >= 0 ? (row[index] ?? '').trim() : ''; };
    if (!value('content') && !['A', 'B', 'C', 'D'].some(letter => value(letter as Field))) return;
    if (questions.length >= QUESTION_LIMITS.questionsPerQuiz) { if (questions.length === QUESTION_LIMITS.questionsPerQuiz) warnings.unshift(`Chỉ nhập ${QUESTION_LIMITS.questionsPerQuiz} câu đầu tiên.`); return; }
    const rawKey = value('key').replace(/[1-4]/g, digit => 'ABCD'[Number(digit) - 1]);
    const key = toAnswerKey(rawKey.match(/[A-D]/gi) ?? []) ?? '';
    const type: QuestionType = /nhi[eềê]u|multi/i.test(value('type')) || key.length > 1 ? 'MULTIPLE' : 'SINGLE';
    const time = Number.parseInt(value('time'), 10);
    const question: QuestionDraft = {
      content: value('content'), optionA: value('A'), optionB: value('B'), optionC: value('C'), optionD: value('D'), type, correctAnswer: key,
      explanation: value('explanation'), knowledge: value('knowledge'), topic: value('topic'), difficulty: parseDifficulty(value('difficulty')),
      origin: 'IMPORT', durationSeconds: Number.isFinite(time) && time > 0 ? time : 30, order: questions.length,
    };
    questions.push(question);
    const issues = questionIssues(question);
    if (issues.length) warnings.push(`Dòng ${headerIndex + offset + 2}: ${issues.join(' ')}`);
  });
  return { title: filename.replace(/\.[^.]+$/, '').slice(0, 200) || 'Bộ câu hỏi nhập từ Excel', description: '', questions, warnings };
}

export const ExtractionSchema = z.object({
  title: z.string(),
  questions: z.array(z.object({
    content: z.string(), optionA: z.string(), optionB: z.string(), optionC: z.string(), optionD: z.string(),
    type: choice(['SINGLE', 'MULTIPLE']), correctOptions: z.array(choice(ANSWERS)).describe('Letters of the correct options; empty when the document does not give the answer'),
    explanation: z.string(), knowledge: z.string(), topic: z.string(), difficulty: choice(['EASY', 'MEDIUM', 'HARD', 'UNKNOWN']),
  })),
  notes: z.array(z.string()),
});
const EXTRACTION_SYSTEM = `You convert exam and question-bank documents into structured multiple-choice questions for a Vietnamese classroom quiz system.

- Copy every multiple-choice question exactly as written. Do not invent, merge, translate, summarize or reword questions or options; only repair line breaks or OCR splits inside a sentence and drop the leading labels ("Câu 3:", "A.").
- Keep at most four options A–D. If a question has more, keep the first four and add a note.
- Fill correctOptions only when the document states the answer: an "Đáp án" line, an answer-key table, a solution section, or marked options. Never guess; leave the list empty when the answer is not given.
- Use type MULTIPLE only when the document marks several correct options or asks to choose all correct answers.
- Copy explanations, topics, knowledge points and difficulty only when the document states them; otherwise use empty strings and UNKNOWN.
- Ignore exam headers, student information fields, instructions, page numbers and footers. Skip questions that are not multiple choice and mention them in a note.
- title: the exam or chapter title if one is visible, otherwise an empty string.
- notes: short remarks in Vietnamese about anything the teacher must check (unreadable parts, missing options, skipped questions).`;

/** Splits long text near the size limit, preferring to cut just before a "Câu N" line, then at a paragraph break. */
export function chunkText(text: string, size = 60000): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const window = rest.slice(0, size);
    const question = [...window.matchAll(/\n(?=\s*(?:câu|cau|question)\s*\d+)/gi)].map(match => match.index!).filter(index => index > size / 2).pop();
    const paragraph = window.lastIndexOf('\n\n'), line = window.lastIndexOf('\n');
    const cut = question ?? (paragraph > size / 2 ? paragraph : line > size / 2 ? line : size);
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

@Injectable()
export class ImportService implements OnModuleInit {
  constructor(private readonly ai: AiService, private readonly jobs: AiJobsService) {}
  onModuleInit() { this.jobs.register('EXTRACT_QUESTIONS', (job, progress) => this.runExtraction(job.id, job.input as { filename: string; format: ImportFormat; text?: string; pdfBase64?: string }, progress)); }
  async parse(file: Upload): Promise<ImportResult> {
    const format = detectFormat(file, ['txt', 'docx', 'xlsx', 'csv', 'pdf']) as ImportFormat;
    const sourceName = uploadName(file);
    if (format === 'xlsx' || format === 'csv') return { ...questionsFromRows(await readSpreadsheet(file.buffer, format), sourceName), sourceName, format };
    let scanned = false;
    let lines;
    if (format === 'docx') lines = await readDocx(file.buffer);
    else if (format === 'pdf') { const pdf = await readPdf(file.buffer); lines = pdf.lines; scanned = pdf.scanned; }
    else lines = textLines(decodeText(file.buffer));
    const parsed = parseQuestionLines(lines, { filename: sourceName });
    if (scanned) parsed.warnings.unshift('PDF có vẻ là ảnh scan nên không đọc được chữ. Hãy dùng “Nhận dạng bằng AI”.');
    else if (!parsed.questions.length) parsed.warnings.unshift('Không nhận ra câu hỏi nào. Kiểm tra định dạng theo file mẫu hoặc dùng “Nhận dạng bằng AI”.');
    return { ...parsed, sourceName, format };
  }
  async startExtraction(teacherId: string, file: Upload) {
    this.ai.assertEnabled();
    const format = detectFormat(file, ['txt', 'docx', 'pdf']) as ImportFormat;
    const filename = uploadName(file);
    let input: { filename: string; format: ImportFormat; text?: string; pdfBase64?: string };
    if (format === 'pdf') {
      const pdf = await readPdf(file.buffer);
      input = pdf.scanned ? { filename, format, pdfBase64: file.buffer.toString('base64') } : { filename, format, text: pdf.lines.map(line => line.text).join('\n') };
    } else input = { filename, format, text: (format === 'docx' ? await readDocx(file.buffer) : textLines(decodeText(file.buffer))).map(line => line.text).join('\n') };
    if (input.text !== undefined && !input.text.trim()) throw new BadRequestException('File không có nội dung chữ.');
    return this.jobs.enqueue(teacherId, 'EXTRACT_QUESTIONS', {}, input);
  }
  private async runExtraction(jobId: string, input: { filename: string; format: ImportFormat; text?: string; pdfBase64?: string }, progress: (value: number) => Promise<void>) {
    const blocks: AiPart[][] = input.pdfBase64
      ? [[{ type: 'pdf', data: input.pdfBase64, title: input.filename }]]
      : chunkText(input.text ?? '', this.ai.chunkChars).map((chunk, i, all) => [{ type: 'text', text: `<document name="${input.filename}" part="${i + 1}/${all.length}">\n${chunk}\n</document>` }]);
    const usage: AiUsage = { inputTokens: 0, outputTokens: 0 };
    const questions: QuestionDraft[] = [];
    const warnings: string[] = [];
    let title = '';
    for (const [index, content] of blocks.entries()) {
      const { data, usage: used } = await this.ai.structured({ system: EXTRACTION_SYSTEM, content: [...content, { type: 'text', text: 'Trích xuất toàn bộ câu hỏi trắc nghiệm trong phần tài liệu trên.' }], schema: ExtractionSchema, effort: 'medium' });
      usage.inputTokens += used.inputTokens; usage.outputTokens += used.outputTokens;
      title ||= data.title.trim();
      warnings.push(...data.notes.map(note => note.trim()).filter(note => note.length >= 10)); // small local models sometimes emit fragments
      for (const item of data.questions.slice(0, QUESTION_LIMITS.questionsPerQuiz - questions.length)) {
        const key = toAnswerKey(item.correctOptions) ?? '';
        questions.push({ content: item.content.trim(), optionA: item.optionA.trim(), optionB: item.optionB.trim(), optionC: item.optionC.trim(), optionD: item.optionD.trim(),
          type: pick(item.type, ['SINGLE', 'MULTIPLE'] as const, 'SINGLE') === 'MULTIPLE' || key.length > 1 ? 'MULTIPLE' : 'SINGLE', correctAnswer: key, explanation: item.explanation.trim(), knowledge: item.knowledge.trim().slice(0, QUESTION_LIMITS.knowledge),
          topic: item.topic.trim().slice(0, QUESTION_LIMITS.topic), difficulty: parseDifficulty(item.difficulty), origin: 'IMPORT', durationSeconds: 30, order: questions.length });
      }
      await progress((index + 1) * 100 / blocks.length);
    }
    questions.forEach((question, i) => { const issues = questionIssues(question); if (issues.length) warnings.push(`Câu ${i + 1}: ${issues.join(' ')}`); });
    // The uploaded file is no longer needed once questions are extracted.
    await this.jobs.clearInput(jobId, { filename: input.filename, format: input.format });
    const result: ImportResult = { title: (title || input.filename.replace(/\.[^.]+$/, '')).slice(0, 200), description: '', questions, warnings, sourceName: input.filename, format: input.format };
    return { result: result as unknown as Prisma.InputJsonValue, usage };
  }
  async excelTemplate() {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ClassPulse';
    const sheet = workbook.addWorksheet('Câu hỏi', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'STT', width: 6 }, { header: 'Câu hỏi', width: 48 }, { header: 'A', width: 22 }, { header: 'B', width: 22 }, { header: 'C', width: 22 }, { header: 'D', width: 22 },
      { header: 'Đáp án', width: 10 }, { header: 'Loại', width: 16 }, { header: 'Thời gian (giây)', width: 15 }, { header: 'Độ khó', width: 13 },
      { header: 'Chủ đề', width: 24 }, { header: 'Kiến thức kiểm tra', width: 28 }, { header: 'Lời giải', width: 40 },
    ];
    sheet.addRows([
      [1, 'MQTT hoạt động theo mô hình nào?', 'Client - server trực tiếp', 'Publish - subscribe', 'Peer to peer', 'Chỉ dùng HTTP', 'B', 'Một đáp án', 30, 'Dễ', 'Giao thức IoT', 'Mô hình truyền thông MQTT', 'Thiết bị publish lên broker; client subscribe topic để nhận dữ liệu.'],
      [2, 'Những công nghệ nào ESP32 hỗ trợ sẵn? (chọn nhiều đáp án)', 'Wi-Fi', 'Bluetooth Low Energy', '5G', 'Ethernet quang', 'A, B', 'Nhiều đáp án', 45, 'Trung bình', 'Phần cứng IoT', 'Kết nối không dây của ESP32', ''],
      [3, 'BLE phù hợp nhất với mục tiêu nào?', 'Truyền video 4K', 'Kết nối vệ tinh', 'Tiêu thụ năng lượng thấp', 'Lưu dữ liệu quan hệ', 'C', 'Một đáp án', 20, 'Dễ', 'Giao thức IoT', 'Đặc điểm BLE', ''],
    ]);
    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF13847C' } };
    header.alignment = { vertical: 'middle', wrapText: true };
    for (let row = 2; row <= 201; row++) {
      sheet.getCell(row, 8).dataValidation = { type: 'list', allowBlank: true, formulae: ['"Một đáp án,Nhiều đáp án"'] };
      sheet.getCell(row, 10).dataValidation = { type: 'list', allowBlank: true, formulae: ['"Dễ,Trung bình,Khó"'] };
    }
    const guide = workbook.addWorksheet('Hướng dẫn');
    guide.columns = [{ width: 110 }];
    [
      'HƯỚNG DẪN NHẬP CÂU HỎI TỪ EXCEL', '',
      '• Mỗi dòng là một câu hỏi. Giữ nguyên dòng tiêu đề; có thể thêm/bớt cột tùy chọn (Loại, Thời gian, Độ khó, Chủ đề, Kiến thức, Lời giải).',
      '• Bắt buộc: Câu hỏi, A, B, C, D và Đáp án. Thiết bị chỉ hỗ trợ 4 phương án A–D.',
      '• Câu một đáp án: ghi một chữ cái (B). Câu nhiều đáp án: ghi các chữ cái cách nhau dấu phẩy (A, C) và chọn Loại = Nhiều đáp án.',
      '• Câu nhiều đáp án được chấm đúng khi sinh viên chọn đủ và đúng tất cả đáp án.',
      '• Thời gian tính bằng giây (5–3600), mặc định 30. Độ khó: Dễ / Trung bình / Khó (hoặc Nhận biết / Thông hiểu / Vận dụng).',
      '• Tối đa 200 câu mỗi lần nhập. Sau khi nhập, bạn vẫn kiểm tra và sửa được trước khi lưu.',
    ].forEach((text, i) => { const row = guide.addRow([text]); if (i === 0) row.font = { bold: true, size: 14 }; });
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }
  async wordTemplate() {
    const paragraphs = QUESTION_TEXT_SAMPLE.split('\n').map(line => {
      if (/^(Chương|BẢNG)/.test(line)) return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(line)] });
      if (/^Câu \d+/.test(line)) return new Paragraph({ spacing: { before: 200 }, children: [new TextRun({ text: line, bold: true })] });
      return new Paragraph({ children: [new TextRun(line)] });
    });
    const document = new Document({ creator: 'ClassPulse', title: 'Mẫu nhập câu hỏi', sections: [{ children: [
      new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, children: [new TextRun('Mẫu nhập câu hỏi trắc nghiệm')] }),
      new Paragraph({ children: [new TextRun({ text: 'Mỗi câu bắt đầu bằng “Câu N:”, sau đó là các phương án A–D và dòng “Đáp án:”. Có thể thay dòng đáp án bằng cách gạch chân, tô đậm hoặc tô màu đỏ phương án đúng, hoặc đặt bảng đáp án ở cuối tài liệu.', italics: true })] }),
      ...paragraphs,
    ] }] });
    return Packer.toBuffer(document);
  }
}

const upload = FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
const fileBody = { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } };
@ApiTags('Imports') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('imports')
export class ImportController {
  constructor(private readonly imports: ImportService) {}
  @Post('questions') @UseInterceptors(upload) @ApiConsumes('multipart/form-data') @ApiBody(fileBody)
  parse(@UploadedFile() file: Upload) { return this.imports.parse(file); }
  @Post('questions/ai') @UseInterceptors(upload) @ApiConsumes('multipart/form-data') @ApiBody(fileBody)
  extract(@Req() req: AuthRequest, @UploadedFile() file: Upload) { return this.imports.startExtraction(req.teacherId, file); }
  @Get('template.xlsx') async excel(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Content-Disposition', 'attachment; filename="mau-cau-hoi-classpulse.xlsx"');
    return new StreamableFile(await this.imports.excelTemplate(), { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  @Get('template.docx') async word(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Content-Disposition', 'attachment; filename="mau-cau-hoi-classpulse.docx"');
    return new StreamableFile(await this.imports.wordTemplate(), { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }
}
