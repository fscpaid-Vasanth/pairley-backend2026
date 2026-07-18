import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);
    if (!token) {
      throw new UnauthorizedException('Missing or invalid token format');
    }
    try {
      // No secret override here — uses the same JwtService instance configured
      // once in AuthModule (which fails startup if JWT_SECRET is unset), instead
      // of independently re-deriving a secret with its own hardcoded fallback.
      const payload = await this.jwtService.verifyAsync(token);
      request.user = payload;
    } catch (e) {
      throw new UnauthorizedException('Invalid or expired token');
    }
    return true;
  }

  private extractTokenFromHeader(request: any): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    if (type === 'Bearer' && token) {
      return token;
    }
    // Fallback for endpoints consumed as raw URLs (e.g. <img src>, <a href> document
    // previews) where the browser can't attach an Authorization header. Only used
    // when no header is present, so header-based callers are unaffected.
    return request.query?.token || undefined;
  }
}
