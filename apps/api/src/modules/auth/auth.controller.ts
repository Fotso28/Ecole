import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  loginSchema,
  mfaVerifySchema,
  otpRequestSchema,
  otpVerifySchema,
  switchSchoolSchema,
} from '@ecole/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { currentContext } from '../../common/context';
import { AccountRoute, AllowWithoutMfa, Public } from '../../common/decorators';
import { ZodPipe } from '../../common/zod.pipe';
import { AuthService, SessionResult } from './auth.service';

export const REFRESH_COOKIE = 'ecole_rt';

function sendSession(res: Response, session: SessionResult) {
  res.cookie(REFRESH_COOKIE, session.refreshToken, {
    httpOnly: true,
    secure: env().NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: session.refreshExpiresAt,
  });
  return {
    accessToken: session.accessToken,
    expiresIn: session.expiresIn,
    kind: session.kind,
    activeSchoolId: session.activeSchoolId,
  };
}

function refreshCookie(req: Request): string | undefined {
  return (req.cookies as Record<string, string | undefined> | undefined)?.[REFRESH_COOKIE];
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.loginStaff(body.email, body.password, req.headers['user-agent']);
    if ('mfaRequired' in result) return result;
    return sendSession(res, result);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('mfa/verify')
  @HttpCode(200)
  async verifyMfa(
    @Body(new ZodPipe(mfaVerifySchema)) body: z.infer<typeof mfaVerifySchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return sendSession(
      res,
      await this.auth.verifyMfa(body.mfaToken, body.code, req.headers['user-agent']),
    );
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    try {
      return sendSession(
        res,
        await this.auth.refresh(refreshCookie(req), req.headers['user-agent']),
      );
    } catch (e) {
      res.clearCookie(REFRESH_COOKIE, { path: '/' });
      throw e;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(refreshCookie(req));
    res.clearCookie(REFRESH_COOKIE, { path: '/' });
  }

  @AccountRoute()
  @AllowWithoutMfa()
  @Get('me')
  me() {
    const ctx = currentContext();
    if (ctx?.kind === 'parent') return this.auth.me(ctx.userId, 'parent', null);
    if (ctx?.kind === 'staff') return this.auth.me(ctx.userId, 'staff', ctx.schoolId);
    if (ctx?.kind === 'account') return this.auth.me(ctx.userId, 'staff', null);
    return null;
  }

  @AccountRoute()
  @AllowWithoutMfa()
  @Post('switch-school')
  @HttpCode(200)
  async switchSchool(
    @Body(new ZodPipe(switchSchoolSchema)) body: z.infer<typeof switchSchoolSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ctx = currentContext();
    if (!ctx || !('userId' in ctx) || ctx.kind === 'parent') throw new Error('Contexte invalide');
    return sendSession(
      res,
      await this.auth.switchSchool(
        ctx.userId,
        body.schoolId,
        refreshCookie(req),
        req.headers['user-agent'],
      ),
    );
  }

  @AccountRoute()
  @AllowWithoutMfa()
  @Post('mfa/setup')
  @HttpCode(200)
  setupMfa() {
    const ctx = currentContext();
    if (!ctx || ctx.kind === 'parent' || !('userId' in ctx)) throw new Error('Contexte invalide');
    return this.auth.setupMfa(ctx.userId);
  }

  @AccountRoute()
  @AllowWithoutMfa()
  @Post('mfa/enable')
  @HttpCode(204)
  async enableMfa(
    @Body(new ZodPipe(z.object({ code: z.string().regex(/^\d{6}$/) }))) body: { code: string },
  ): Promise<void> {
    const ctx = currentContext();
    if (!ctx || ctx.kind === 'parent' || !('userId' in ctx)) throw new Error('Contexte invalide');
    await this.auth.enableMfa(ctx.userId, body.code);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('otp/request')
  @HttpCode(202)
  async requestOtp(@Body(new ZodPipe(otpRequestSchema)) body: z.infer<typeof otpRequestSchema>) {
    await this.auth.requestOtp(body.phone);
    return { message: 'Si ce numéro est connu de l’école, un code vient d’être envoyé par SMS.' };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('otp/verify')
  @HttpCode(200)
  async verifyOtp(
    @Body(new ZodPipe(otpVerifySchema)) body: z.infer<typeof otpVerifySchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return sendSession(
      res,
      await this.auth.verifyOtp(body.phone, body.code, req.headers['user-agent']),
    );
  }
}
