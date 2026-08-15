import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { VerifyOtpDto } from './auth.controller';

// DTO-level proof that the request never even reaches AuthService with the
// wrong code length — the actual 4-digit OTP migration's length boundary.
describe('VerifyOtpDto — code length', () => {
  const dtoWith = (code: string) =>
    plainToInstance(VerifyOtpDto, { mobile: '9000000001', code });

  it('accepts a 4-digit code', async () => {
    const errors = await validate(dtoWith('4821'));
    expect(errors).toHaveLength(0);
  });

  it('rejects a 6-digit code', async () => {
    const errors = await validate(dtoWith('482913'));
    expect(errors).not.toHaveLength(0);
  });

  it('rejects a 5-digit code', async () => {
    const errors = await validate(dtoWith('48219'));
    expect(errors).not.toHaveLength(0);
  });

  it('rejects a 3-digit code', async () => {
    const errors = await validate(dtoWith('482'));
    expect(errors).not.toHaveLength(0);
  });
});
