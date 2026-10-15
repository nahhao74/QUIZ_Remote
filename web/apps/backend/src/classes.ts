import { BadRequestException, Body, Controller, Delete, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import ExcelJS from 'exceljs';
import { foldText, GRADE_BANDS, summarizeScores, type Classroom, type ClassReport, type Student } from '@classpulse/shared-types';
import { AuthGuard, AuthRequest } from './auth';
import { ClassroomDto, StudentsDto, UpdateClassroomDto, UpdateStudentDto } from './dto';
import { detectFormat, MAX_UPLOAD_BYTES, readSpreadsheet, type UploadedFile as Upload } from './extract';
import { PrismaService } from './prisma.service';
import { sessionScores } from './analytics';

const studentView = (s: { id: string; code: string; name: string; externalId: string }): Student => ({ id: s.id, code: s.code, name: s.name, externalId: s.externalId });
/** Reads a class list: device code (STT), full name and optional student ID; missing codes are numbered 01, 02… */
export function rosterFromRows(rows: string[][]): { students: Array<{ code: string; name: string; externalId: string }>; warnings: string[] } {
  const find = (row: string[], test: (value: string) => boolean) => row.findIndex(cell => test(foldText(cell)));
  const headerIndex = rows.slice(0, 10).findIndex(row => find(row, value => /^(ho (va )?ten|ho ten|ten|name|hoc sinh|sinh vien|full name)$/.test(value)) >= 0);
  const header = headerIndex >= 0 ? rows[headerIndex] : [];
  const nameColumn = headerIndex >= 0 ? find(header, value => /^(ho (va )?ten|ho ten|ten|name|hoc sinh|sinh vien|full name)$/.test(value)) : rows[0]?.length > 1 && /^\d+$/.test(rows[0][0] ?? '') ? 1 : 0;
  const codeColumn = headerIndex >= 0 ? find(header, value => /^(stt|ma thiet bi|ma may|ma tren thiet bi|so thu tu|code|ma so may|so)$/.test(value)) : rows[0]?.length > 1 && /^\d+$/.test(rows[0][0] ?? '') ? 0 : -1;
  const idColumn = headerIndex >= 0 ? find(header, value => /^(mssv|ma sv|ma sinh vien|ma hs|ma hoc sinh|student id|ma so|ma dinh danh)$/.test(value)) : -1;
  const students: Array<{ code: string; name: string; externalId: string }> = [];
  const warnings: string[] = [];
  const used = new Set<string>();
  rows.slice(headerIndex + 1).forEach((row, offset) => {
    const name = (row[nameColumn] ?? '').trim();
    if (!name) return;
    let code = codeColumn >= 0 ? (row[codeColumn] ?? '').trim() : '';
    if (/^\d{1,2}$/.test(code)) code = code.padStart(2, '0');
    if (!/^\d{2}$/.test(code) || code === '00' || used.has(code)) {
      const next = Array.from({ length: 99 }, (_, i) => String(i + 1).padStart(2, '0')).find(candidate => !used.has(candidate));
      if (!next) { warnings.push('Lớp chỉ có tối đa 99 mã thiết bị (01–99); các dòng sau đã bị bỏ qua.'); return; }
      if (codeColumn >= 0) warnings.push(`Dòng ${headerIndex + offset + 2}: mã “${code}” không hợp lệ hoặc bị trùng, đã gán ${next}.`);
      code = next;
    }
    used.add(code);
    students.push({ code, name: name.slice(0, 120), externalId: idColumn >= 0 ? (row[idColumn] ?? '').trim().slice(0, 60) : '' });
  });
  return { students, warnings };
}

@Injectable()
export class ClassService {
  constructor(private readonly db: PrismaService) {}
  private async owned(teacherId: string, id: string) {
    const classroom = await this.db.classroom.findFirst({ where: { id, teacherId, deletedAt: null }, include: { students: { orderBy: { code: 'asc' } }, _count: { select: { sessions: true } } } });
    if (!classroom) throw new NotFoundException('Không tìm thấy lớp học.');
    return classroom;
  }
  private view(classroom: Awaited<ReturnType<ClassService['owned']>>): Classroom {
    return { id: classroom.id, name: classroom.name, description: classroom.description, studentCount: classroom.students.length, sessionCount: classroom._count.sessions,
      createdAt: classroom.createdAt.toISOString(), students: classroom.students.map(studentView) };
  }
  async list(teacherId: string): Promise<Classroom[]> {
    const rows = await this.db.classroom.findMany({ where: { teacherId, deletedAt: null }, orderBy: { name: 'asc' }, include: { _count: { select: { students: true, sessions: true } } } });
    return rows.map(row => ({ id: row.id, name: row.name, description: row.description, studentCount: row._count.students, sessionCount: row._count.sessions, createdAt: row.createdAt.toISOString() }));
  }
  async get(teacherId: string, id: string) { return this.view(await this.owned(teacherId, id)); }
  async create(teacherId: string, input: ClassroomDto) {
    const created = await this.db.classroom.create({ data: { teacherId, name: input.name, description: input.description ?? '' } });
    return this.get(teacherId, created.id);
  }
  async update(teacherId: string, id: string, input: UpdateClassroomDto) {
    await this.owned(teacherId, id);
    await this.db.classroom.update({ where: { id }, data: input });
    return this.get(teacherId, id);
  }
  async remove(teacherId: string, id: string) {
    await this.owned(teacherId, id);
    await this.db.classroom.update({ where: { id }, data: { deletedAt: new Date() } });
    return { success: true };
  }
  async saveStudents(teacherId: string, id: string, input: StudentsDto) {
    const classroom = await this.owned(teacherId, id);
    const codes = input.students.map(student => student.code);
    if (new Set(codes).size !== codes.length) throw new BadRequestException('Danh sách có mã thiết bị bị trùng.');
    if (codes.includes('00')) throw new BadRequestException('Mã thiết bị phải từ 01 đến 99.');
    await this.db.$transaction(async tx => {
      if (input.replace) await tx.student.deleteMany({ where: { classroomId: id } });
      for (const student of input.students) await tx.student.upsert({
        where: { classroomId_code: { classroomId: classroom.id, code: student.code } },
        create: { classroomId: classroom.id, code: student.code, name: student.name, externalId: student.externalId ?? '' },
        update: { name: student.name, externalId: student.externalId ?? '' },
      });
    });
    return this.get(teacherId, id);
  }
  async updateStudent(teacherId: string, id: string, studentId: string, input: UpdateStudentDto) {
    const classroom = await this.owned(teacherId, id);
    if (!classroom.students.some(student => student.id === studentId)) throw new NotFoundException('Không tìm thấy sinh viên.');
    if (input.code === '00') throw new BadRequestException('Mã thiết bị phải từ 01 đến 99.');
    await this.db.student.update({ where: { id: studentId }, data: input });
    return this.get(teacherId, id);
  }
  async removeStudent(teacherId: string, id: string, studentId: string) {
    const classroom = await this.owned(teacherId, id);
    if (!classroom.students.some(student => student.id === studentId)) throw new NotFoundException('Không tìm thấy sinh viên.');
    await this.db.student.delete({ where: { id: studentId } });
    return this.get(teacherId, id);
  }
  async parseRoster(teacherId: string, id: string, file: Upload) {
    await this.owned(teacherId, id);
    const format = detectFormat(file, ['xlsx', 'csv']) as 'xlsx' | 'csv';
    const result = rosterFromRows(await readSpreadsheet(file.buffer, format));
    if (!result.students.length) throw new BadRequestException('Không tìm thấy tên sinh viên. File cần cột “Họ và tên” (và tùy chọn “STT”, “Mã SV”).');
    return result;
  }
  /** Finished sessions of the class, with each roster student's score per session and their average. */
  async report(teacherId: string, id: string): Promise<ClassReport> {
    const classroom = await this.owned(teacherId, id);
    const sessions = await this.db.quizSession.findMany({ where: { teacherId, classroomId: id, status: 'FINISHED' }, orderBy: { createdAt: 'asc' },
      include: { questions: { select: { id: true, correctAnswer: true } }, participants: { select: { id: true, studentCode: true, answers: { select: { questionId: true, answer: true } } } } } });
    const scored = sessions.map(session => ({ session, ...sessionScores(session) }));
    const codes = [...new Set([...classroom.students.map(s => s.code), ...scored.flatMap(item => item.students.map(s => s.studentCode))])].sort();
    const names = new Map(classroom.students.map(student => [student.code, student.name]));
    const students = codes.map(code => {
      const scores = scored.map(item => item.students.find(student => student.studentCode === code)?.score ?? null);
      const taken = scores.filter((score): score is number => score !== null);
      return { code, name: names.get(code) ?? null, scores, average: taken.length ? Math.round(taken.reduce((a, b) => a + b, 0) / taken.length * 100) / 100 : null };
    });
    return {
      classroom: this.view(classroom),
      sessions: scored.map(({ session, summary }) => ({ id: session.id, title: session.title, createdAt: session.createdAt.toISOString(), status: session.status, questionCount: session.questions.length,
        participantCount: session.participants.length, examId: session.examId, variantCode: session.variantCode, summary })),
      students,
      overall: summarizeScores(students.map(student => student.average).filter((value): value is number => value !== null)),
    };
  }
  async reportWorkbook(teacherId: string, id: string) {
    const report = await this.report(teacherId, id);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Bảng điểm', { views: [{ state: 'frozen', ySplit: 1, xSplit: 2 }] });
    sheet.addRow(['Mã', 'Họ và tên', ...report.sessions.map((session, i) => `${i + 1}. ${session.title} (${new Date(session.createdAt).toLocaleDateString('vi-VN')})`), 'Điểm TB']);
    for (const student of report.students) sheet.addRow([student.code, student.name ?? '(chưa có trong danh sách)', ...student.scores.map(score => score ?? ''), student.average ?? '']);
    sheet.getRow(1).font = { bold: true };
    sheet.columns.forEach((column, i) => { column.width = i === 1 ? 28 : i === 0 ? 6 : 16; });
    const summary = workbook.addWorksheet('Thống kê');
    summary.addRow(['Buổi', 'Ngày', 'Số SV', 'Điểm TB', 'Trung vị', 'Độ lệch chuẩn', 'Thấp nhất', 'Cao nhất', 'Tỷ lệ đạt (%)', ...GRADE_BANDS.map(band => band.label)]);
    for (const session of report.sessions) summary.addRow([session.title, new Date(session.createdAt).toLocaleDateString('vi-VN'), session.summary.count, session.summary.mean, session.summary.median,
      session.summary.standardDeviation, session.summary.min, session.summary.max, session.summary.passRate, ...GRADE_BANDS.map(band => session.summary.bands[band.band])]);
    summary.getRow(1).font = { bold: true };
    summary.columns.forEach(column => { column.width = 16; });
    return { filename: `bang-diem-${foldText(report.classroom.name).replace(/ /g, '-') || 'lop'}.xlsx`, buffer: Buffer.from(await workbook.xlsx.writeBuffer()) };
  }
}

@ApiTags('Classes') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('classes')
export class ClassController {
  constructor(private readonly classes: ClassService) {}
  @Get() list(@Req() req: AuthRequest) { return this.classes.list(req.teacherId); }
  @Post() create(@Req() req: AuthRequest, @Body() input: ClassroomDto) { return this.classes.create(req.teacherId, input); }
  @Get(':id') get(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.classes.get(req.teacherId, id); }
  @Patch(':id') update(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() input: UpdateClassroomDto) { return this.classes.update(req.teacherId, id, input); }
  @Delete(':id') remove(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.classes.remove(req.teacherId, id); }
  @Post(':id/students') saveStudents(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() input: StudentsDto) { return this.classes.saveStudents(req.teacherId, id, input); }
  @Patch(':id/students/:studentId') updateStudent(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('studentId', ParseUUIDPipe) studentId: string, @Body() input: UpdateStudentDto) { return this.classes.updateStudent(req.teacherId, id, studentId, input); }
  @Delete(':id/students/:studentId') removeStudent(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('studentId', ParseUUIDPipe) studentId: string) { return this.classes.removeStudent(req.teacherId, id, studentId); }
  @Post(':id/students/import') @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } })) @ApiConsumes('multipart/form-data') @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  parseRoster(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Upload) { return this.classes.parseRoster(req.teacherId, id, file); }
  @Get(':id/report') report(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.classes.report(req.teacherId, id); }
  @Get(':id/report.xlsx') async workbook(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const file = await this.classes.reportWorkbook(req.teacherId, id);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    return new StreamableFile(file.buffer, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
}
