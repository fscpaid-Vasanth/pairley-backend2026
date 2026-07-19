import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

// Like JwtAuthGuard, but never blocks the request — a missing or invalid
// token just leaves request.user undefined instead of throwing. For routes
// that are public by default but need to behave differently for an
// authenticated caller (e.g. only the owning business sees interested-
// customer PII on an otherwise-public offer detail response).
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);
    if (!token) {
      return true;
    }
    try {
      request.user = await this.jwtService.verifyAsync(token);
    } catch (e) {
      // Invalid/expired token on an optional-auth route — treat as anonymous
      // rather than rejecting the request.
    }
    return true;
  }

  private extractTokenFromHeader(request: any): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' && token ? token : undefined;
  }
}
