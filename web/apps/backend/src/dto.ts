import { Type, Transform } from 'class-transformer';
import { IsEmail, IsString, MinLength, MaxLength, IsOptional, IsEnum, IsInt, Min, Max, IsArray, ValidateNested, IsUUID, ArrayMaxSize, ArrayMinSize, Matches, IsBoolean } from 'class-validator';
import { ApiProperty, PartialType } from '@nestjs/swagger';
import { ANSWER_KEY_PATTERN, QUESTION_LIMITS } from '@classpulse/shared-types';
const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
export class RegisterDto {
  @ApiProperty({ example: 'teacher@example.com' }) @IsEmail() @MaxLength(254) @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value) email!: string;
  @ApiProperty({ minLength: 8 }) @IsString() @MinLength(8) @MaxLength(72) password!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) @Transform(trim) name!: string;
}
export class LoginDto {
  @ApiProperty() @IsEmail() @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value) email!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(72) password!: string;
}
export class ProfileDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) @Transform(trim) name!: string;
}
const KEY_MESSAGE = 'correctAnswer phải là A, B, C, D hoặc tổ hợp theo thứ tự như AC, ABD.';
export class QuestionDto {
  @ApiProperty({ required: false }) @IsOptional() @IsUUID() id?: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(QUESTION_LIMITS.content) content!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(QUESTION_LIMITS.option) optionA!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(QUESTION_LIMITS.option) optionB!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(QUESTION_LIMITS.option) optionC!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(QUESTION_LIMITS.option) optionD!: string;
  @ApiProperty({ enum: ['SINGLE', 'MULTIPLE'], default: 'SINGLE', description: 'MULTIPLE lets students select several options; scoring is all-or-nothing.' }) @IsOptional() @IsEnum(['SINGLE', 'MULTIPLE']) type?: 'SINGLE'|'MULTIPLE';
  @ApiProperty({ example: 'B', description: 'Canonical key: one letter for SINGLE, letters in order for MULTIPLE (e.g. "AC").' }) @IsString() @Matches(ANSWER_KEY_PATTERN, { message: KEY_MESSAGE }) correctAnswer!: string;
  @ApiProperty({ required: false, description: 'Lời giải' }) @IsOptional() @IsString() @MaxLength(QUESTION_LIMITS.explanation) explanation?: string;
  @ApiProperty({ required: false, description: 'Kiến thức được kiểm tra' }) @IsOptional() @IsString() @MaxLength(QUESTION_LIMITS.knowledge) knowledge?: string;
  @ApiProperty({ required: false, description: 'Chương/chủ đề' }) @IsOptional() @IsString() @MaxLength(QUESTION_LIMITS.topic) topic?: string;
  @ApiProperty({ required: false, enum: ['EASY', 'MEDIUM', 'HARD'], nullable: true }) @IsOptional() @IsEnum(['EASY', 'MEDIUM', 'HARD']) difficulty?: 'EASY'|'MEDIUM'|'HARD' | null;
  @ApiProperty({ required: false, enum: ['MANUAL', 'IMPORT', 'AI'] }) @IsOptional() @IsEnum(['MANUAL', 'IMPORT', 'AI']) origin?: 'MANUAL'|'IMPORT'|'AI';
  @ApiProperty({ default: 30 }) @IsInt() @Min(5) @Max(3600) durationSeconds!: number;
  @ApiProperty({ default: 0 }) @IsInt() @Min(0) @Max(1000) order!: number;
}
export class UpdateQuestionDto extends PartialType(QuestionDto) {}
export class QuizDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @ApiProperty({ default: '' }) @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @ApiProperty({ type: [QuestionDto] }) @IsOptional() @IsArray() @ArrayMaxSize(QUESTION_LIMITS.questionsPerQuiz) @ValidateNested({ each: true }) @Type(() => QuestionDto) questions?: QuestionDto[];
}
export class UpdateQuizDto extends PartialType(QuizDto) {}
export class CreateSessionDto {
  @ApiProperty() @IsUUID() quizId!: string;
  @ApiProperty({ enum: ['MANUAL','TIMER'], default: 'MANUAL' }) @IsOptional() @IsEnum(['MANUAL','TIMER']) mode?: 'MANUAL'|'TIMER';
  @ApiProperty({ required: false }) @IsOptional() @IsInt() @Min(5) @Max(3600) durationSeconds?: number;
  @ApiProperty({ required: false, description: 'Lớp học tham gia; tên sinh viên trong báo cáo lấy từ danh sách lớp.' }) @IsOptional() @IsUUID() classroomId?: string;
  @ApiProperty({ required: false, default: false }) @IsOptional() @IsBoolean() shuffleQuestions?: boolean;
  @ApiProperty({ required: false, default: false }) @IsOptional() @IsBoolean() shuffleOptions?: boolean;
}
export class SettingsDto {
  @ApiProperty({ enum: ['MANUAL','TIMER'] }) @IsOptional() @IsEnum(['MANUAL','TIMER']) mode?: 'MANUAL'|'TIMER';
  @ApiProperty({ required: false }) @IsOptional() @IsInt() @Min(5) @Max(3600) durationSeconds?: number;
}
export class OpenQuestionDto {
  @ApiProperty({ required: false }) @IsOptional() @IsUUID() questionId?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsInt() @Min(0) index?: number;
}

export class GenerateQuestionsDto {
  @ApiProperty() @IsUUID() documentId!: string;
  @ApiProperty({ type: [Number], description: 'Chỉ số các chương đã chọn' }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsInt({ each: true }) @Min(0, { each: true }) sectionIndexes!: number[];
  @ApiProperty({ minimum: 1, maximum: 60 }) @IsInt() @Min(1) @Max(60) questionCount!: number;
  @ApiProperty() @IsInt() @Min(0) @Max(100) easyPercent!: number;
  @ApiProperty() @IsInt() @Min(0) @Max(100) mediumPercent!: number;
  @ApiProperty() @IsInt() @Min(0) @Max(100) hardPercent!: number;
  @ApiProperty({ description: 'Tỷ lệ câu nhiều đáp án (0–100)', default: 0 }) @IsOptional() @IsInt() @Min(0) @Max(100) multiplePercent?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(2000) @Transform(trim) instructions?: string;
  @ApiProperty({ required: false, description: 'Bộ câu hỏi đề xuất khi duyệt' }) @IsOptional() @IsUUID() quizId?: string;
}
export class GeneratedQuestionUpdateDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MinLength(1) @MaxLength(QUESTION_LIMITS.content) content?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MinLength(1) @MaxLength(QUESTION_LIMITS.option) optionA?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MinLength(1) @MaxLength(QUESTION_LIMITS.option) optionB?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MinLength(1) @MaxLength(QUESTION_LIMITS.option) optionC?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MinLength(1) @MaxLength(QUESTION_LIMITS.option) optionD?: string;
  @ApiProperty({ required: false, enum: ['SINGLE', 'MULTIPLE'] }) @IsOptional() @IsEnum(['SINGLE', 'MULTIPLE']) type?: 'SINGLE'|'MULTIPLE';
  @ApiProperty({ required: false }) @IsOptional() @IsString() @Matches(ANSWER_KEY_PATTERN, { message: KEY_MESSAGE }) correctAnswer?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(QUESTION_LIMITS.explanation) explanation?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(QUESTION_LIMITS.knowledge) knowledge?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(QUESTION_LIMITS.topic) topic?: string;
  @ApiProperty({ required: false, enum: ['EASY', 'MEDIUM', 'HARD'] }) @IsOptional() @IsEnum(['EASY', 'MEDIUM', 'HARD']) difficulty?: 'EASY'|'MEDIUM'|'HARD' | null;
}
export class ApproveGeneratedDto {
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('all', { each: true }) ids!: string[];
  @ApiProperty({ required: false, description: 'Thêm vào bộ câu hỏi có sẵn' }) @IsOptional() @IsUUID() quizId?: string;
  @ApiProperty({ required: false, description: 'Hoặc tạo bộ câu hỏi mới với tên này' }) @IsOptional() @IsString() @MinLength(1) @MaxLength(200) @Transform(trim) newQuizTitle?: string;
  @ApiProperty({ required: false, default: 30 }) @IsOptional() @IsInt() @Min(5) @Max(3600) durationSeconds?: number;
}
export class GeneratedIdsDto {
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('all', { each: true }) ids!: string[];
}

export class ClassroomDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(120) @Transform(trim) name!: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(1000) description?: string;
}
export class UpdateClassroomDto extends PartialType(ClassroomDto) {}
export class StudentDto {
  @ApiProperty({ example: '01', description: 'Mã hai chữ số nhập trên thiết bị' }) @Transform(({ value }) => typeof value === 'number' ? String(value).padStart(2, '0') : typeof value === 'string' ? value.trim().padStart(2, '0') : value) @Matches(/^\d{2}$/, { message: 'Mã sinh viên trên thiết bị gồm đúng 2 chữ số (01–99).' }) code!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(120) @Transform(trim) name!: string;
  @ApiProperty({ required: false, description: 'Mã số sinh viên/học sinh thật' }) @IsOptional() @IsString() @MaxLength(60) @Transform(trim) externalId?: string;
}
export class UpdateStudentDto extends PartialType(StudentDto) {}
export class StudentsDto {
  @ApiProperty({ type: [StudentDto] }) @IsArray() @ArrayMaxSize(99) @ValidateNested({ each: true }) @Type(() => StudentDto) students!: StudentDto[];
  @ApiProperty({ required: false, description: 'Thay toàn bộ danh sách hiện có' }) @IsOptional() @IsBoolean() replace?: boolean;
}

export class ExamDto {
  @ApiProperty() @IsUUID() quizId!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) @Transform(trim) title!: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @ApiProperty({ minimum: 1, maximum: 24, default: 4 }) @IsInt() @Min(1) @Max(24) variantCount!: number;
  @ApiProperty({ default: true }) @IsBoolean() shuffleQuestions!: boolean;
  @ApiProperty({ default: true }) @IsBoolean() shuffleOptions!: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsInt() @Min(5) @Max(3600) durationSeconds?: number;
}
export class ExamSessionDto {
  @ApiProperty({ required: false }) @IsOptional() @IsUUID() classroomId?: string;
  @ApiProperty({ required: false, description: 'Mã đề; bỏ trống để tự chọn mã đề chưa dùng nhiều nhất' }) @IsOptional() @IsString() @Matches(/^\d{3}$/) variantCode?: string;
  @ApiProperty({ enum: ['MANUAL','TIMER'], default: 'MANUAL' }) @IsOptional() @IsEnum(['MANUAL','TIMER']) mode?: 'MANUAL'|'TIMER';
  @ApiProperty({ required: false }) @IsOptional() @IsInt() @Min(5) @Max(3600) durationSeconds?: number;
}
