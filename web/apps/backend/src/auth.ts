import { BadRequestException, CanActivate, Controller, ExecutionContext, Get, Injectable, Post, Patch, Body, Req, Res, UnauthorizedException, UseGuards, HttpCode } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { compare, hash } from 'bcryptjs';
import type { Request, Response } from 'express';
import { PrismaService } from './prisma.service';
import { LoginDto, ProfileDto, RegisterDto } from './dto';
import type { AuthResponse, Teacher } from '@classpulse/shared-types';
export type AuthRequest = Request & { teacherId: string };
const safeTeacher = (t: { id: string; email: string; name: string }): Teacher => ({ id: t.id, email: t.email, name: t.name });
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const refreshDays = 7;
@Injectable()
export class AuthService {
  constructor(private readonly db: PrismaService, private readonly jwt: JwtService) {}
  async register(input: RegisterDto) {
    if (Buffer.byteLength(input.password, 'utf8') > 72) throw new BadRequestException('Mật khẩu tối đa 72 byte UTF-8.');
    if (await this.db.teacher.findUnique({ where: { email: input.email } })) throw new BadRequestException('Email đã được sử dụng.');
    const passwordHash = await hash(input.password, 12);
    const teacher = await this.db.teacher.create({ data: { email: input.email, name: input.name, passwordHash } });
    return this.issue(teacher);
  }
  async login(input: LoginDto) {
    const teacher = await this.db.teacher.findUnique({ where: { email: input.email } });
    const valid = await compare(input.password, teacher?.passwordHash ?? '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxDpPl4MQGtFdvwxVK/waNBOGUu');
    if (!teacher || !valid) throw new UnauthorizedException('Email hoặc mật khẩu không chính xác.');
    return this.issue(teacher);
  }
  private async issue(teacher: Teacher, familyId: string = randomUUID()) {
    const refreshToken = randomBytes(48).toString('base64url');
    await this.db.refreshToken.create({ data: { teacherId: teacher.id, tokenHash: digest(refreshToken), familyId, expiresAt: new Date(Date.now() + refreshDays * 86400000) } });
    return { response: { teacher: safeTeacher(teacher), accessToken: this.jwt.sign({ sub: teacher.id }, { expiresIn: '15m' }) } satisfies AuthResponse, refreshToken };
  }
  async refresh(token?: string) {
    if (!token) throw new UnauthorizedException('Thiếu refresh token.');
    const stored = await this.db.refreshToken.findUnique({ where: { tokenHash: digest(token) }, include: { teacher: true } });
    if (!stored) throw new UnauthorizedException('Phiên đăng nhập không hợp lệ.');
    if (stored.revokedAt || stored.expiresAt < new Date()) {
      await this.db.refreshToken.updateMany({ where: { familyId: stored.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw new UnauthorizedException('Phiên đã hết hạn. Vui lòng đăng nhập lại.');
    }
    // A compare-and-set prevents two requests rotating the same credential successfully.
    const consumed = await this.db.refreshToken.updateMany({ where: { id: stored.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (consumed.count !== 1) throw new UnauthorizedException('Refresh token đã được sử dụng.');
    return this.issue(stored.teacher, stored.familyId);
  }
  async logout(token?: string) {
    if (token) await this.db.refreshToken.updateMany({ where: { tokenHash: digest(token), revokedAt: null }, data: { revokedAt: new Date() } });
  }
  async verify(token: string): Promise<string> {
    try {
      const payload = this.jwt.verify<{ sub: string }>(token);
      if (!payload.sub || !await this.db.teacher.findUnique({ where: { id: payload.sub }, select: { id: true } })) throw new Error();
      return payload.sub;
    } catch { throw new UnauthorizedException('Access token không hợp lệ hoặc hết hạn.'); }
  }
  async profile(id: string) { return this.db.teacher.findUniqueOrThrow({ where: { id }, select: { id: true, email: true, name: true } }); }
  async updateProfile(id: string, input: ProfileDto) { return this.db.teacher.update({ where: { id }, data: input, select: { id: true, email: true, name: true } }); }
}
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    if (!match) throw new UnauthorizedException('Cần đăng nhập.');
    req.teacherId = await this.auth.verify(match[1]);
    return true;
  }
}
const cookieOptions = () => ({ httpOnly: true, secure: process.env.COOKIE_SECURE === 'true', sameSite: 'lax' as const, path: '/api/auth', maxAge: refreshDays * 86400000 });
@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  private setCookie(res: Response, value: string) { res.cookie('refreshToken', value, cookieOptions()); }
  @Post('register') async register(@Body() input: RegisterDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.register(input); this.setCookie(res, result.refreshToken); return result.response;
  }
  @Post('login') @HttpCode(200) async login(@Body() input: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(input); this.setCookie(res, result.refreshToken); return result.response;
  }
  @Post('refresh') @HttpCode(200) async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.refresh(req.cookies?.refreshToken); this.setCookie(res, result.refreshToken); return result.response;
  }
  @Post('logout') @HttpCode(200) async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.refreshToken); res.clearCookie('refreshToken', { ...cookieOptions(), maxAge: undefined }); return { success: true };
  }
}
@ApiTags('Teacher') @ApiBearerAuth() @UseGuards(AuthGuard) @Controller('teachers')
export class TeacherController {
  constructor(private readonly auth: AuthService) {}
  @Get('me') profile(@Req() req: AuthRequest) { return this.auth.profile(req.teacherId); }
  @Patch('me') update(@Req() req: AuthRequest, @Body() input: ProfileDto) { return this.auth.updateProfile(req.teacherId, input); }
}
