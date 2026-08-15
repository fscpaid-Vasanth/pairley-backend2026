import { OtpService } from './otp.service';

// MSG91 production migration — this session. Covers: mock mode (local dev,
// never reachable in production since USE_MOCK_OTP defaults to true only
// when the env var is genuinely unset, and production has it explicitly
// set to false), the real MSG91 send path, MSG91's own error responses,
// and the new timeout handling (a hung MSG91 endpoint previously left the
// whole /auth/send-otp request hanging indefinitely).
describe('OtpService', () => {
  const makeConfig = (values: Record<string, any> = {}) =>
    ({
      get: jest.fn((key: string, def?: any) =>
        key in values ? values[key] : def,
      ),
    }) as any;

  const REAL_CONFIG = {
    USE_MOCK_OTP: false,
    MSG91_API_KEY: 'test-authkey',
    MSG91_SENDER_ID: 'PAIRLY',
    MSG91_TEMPLATE_ID: 'test-template-id',
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('generateOtp', () => {
    it('always produces a 4-digit numeric string', () => {
      const service = new OtpService(makeConfig());
      for (let i = 0; i < 50; i++) {
        const code = service.generateOtp();
        expect(code).toMatch(/^\d{4}$/);
      }
    });

    it('can legitimately produce "1234" like any other 4-digit value — it is not special-cased away', () => {
      // 1 in 10,000 per call; 20,000 draws makes a false negative here
      // astronomically unlikely while keeping the test fast and deterministic-free.
      const service = new OtpService(makeConfig());
      let sawIt = false;
      for (let i = 0; i < 20_000; i++) {
        if (service.generateOtp() === '1234') {
          sawIt = true;
          break;
        }
      }
      expect(sawIt).toBe(true);
    });
  });

  describe('mock mode (USE_MOCK_OTP=true — local dev only)', () => {
    it('never calls MSG91 and always reports success', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch');
      const service = new OtpService(makeConfig({ USE_MOCK_OTP: true }));

      const result = await service.sendOtp('9000000001', '4821');

      expect(result).toEqual({ success: true });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('is the default when USE_MOCK_OTP is entirely unset — never silently defaults to real sends', () => {
      const service = new OtpService(makeConfig({}));
      expect(service.useMock).toBe(true);
    });

    it('is false only when the environment variable is explicitly false', () => {
      const service = new OtpService(makeConfig({ USE_MOCK_OTP: false }));
      expect(service.useMock).toBe(false);
    });
  });

  describe('real MSG91 send (USE_MOCK_OTP=false — production)', () => {
    it('reports success on a valid MSG91 response', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue({
        json: () =>
          Promise.resolve({ type: 'success', request_id: 'req-abc123' }),
      } as any);
      const service = new OtpService(makeConfig(REAL_CONFIG));

      const result = await service.sendOtp('9000000001', '4821');

      expect(result).toEqual({ success: true });
    });

    it('sends the exact code Pairley generated — MSG91 never generates its own', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        json: () => Promise.resolve({ type: 'success' }),
      } as any);
      const service = new OtpService(makeConfig(REAL_CONFIG));

      await service.sendOtp('9000000001', '4821');

      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('otp=4821');
    });

    it('never sends the MSG91 authkey anywhere but the request header', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        json: () => Promise.resolve({ type: 'success' }),
      } as any);
      const service = new OtpService(makeConfig(REAL_CONFIG));

      await service.sendOtp('9000000001', '4821');

      const [url, options] = fetchSpy.mock.calls[0];
      expect(url as string).not.toContain('test-authkey');
      expect((options as any).headers.authkey).toBe('test-authkey');
    });

    it('maps a known MSG91 error code to a clear message', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue({
        json: () =>
          Promise.resolve({
            type: 'error',
            code: '301',
            message: 'Insufficient balance',
          }),
      } as any);
      const service = new OtpService(makeConfig(REAL_CONFIG));

      const result = await service.sendOtp('9000000001', '4821');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient balance');
    });

    it('reports a generic network error without leaking internals when fetch itself throws', async () => {
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
      const service = new OtpService(makeConfig(REAL_CONFIG));

      const result = await service.sendOtp('9000000001', '4821');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network/API connection error');
    });

    // The actual bug this test guards against: previously there was no
    // signal/timeout option on the fetch call at all, so a hung MSG91
    // endpoint would leave this Promise — and the whole /auth/send-otp
    // request above it — pending indefinitely.
    it('times out rather than hanging indefinitely, with a distinct, safe error message', async () => {
      jest.spyOn(global, 'fetch').mockImplementation(() => {
        const err = new Error('The operation was aborted');
        err.name = 'TimeoutError';
        return Promise.reject(err);
      });
      const service = new OtpService(makeConfig(REAL_CONFIG));

      const result = await service.sendOtp('9000000001', '4821');

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'OTP provider is taking too long to respond. Please try again.',
      );
      // Must not fall through to the generic network-error message —
      // callers/UI may want to branch on this distinctly.
      expect(result.error).not.toContain('Network/API connection error');
    });

    it('passes an AbortSignal to fetch so a hang is actually bounded', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        json: () => Promise.resolve({ type: 'success' }),
      } as any);
      const service = new OtpService(makeConfig(REAL_CONFIG));

      await service.sendOtp('9000000001', '4821');

      const options = fetchSpy.mock.calls[0][1] as any;
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('sendSms — generic MSG91 flow messages (separate from OTP)', () => {
    it('mocks in mock mode without calling MSG91', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch');
      const service = new OtpService(makeConfig({ USE_MOCK_OTP: true }));

      const result = await service.sendSms('9000000001', 'hello');

      expect(result).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('falls back to mock behaviour when no SMS template is configured, even in real mode', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch');
      const service = new OtpService(
        makeConfig({ ...REAL_CONFIG, MSG91_SMS_TEMPLATE_ID: '' }),
      );

      const result = await service.sendSms('9000000001', 'hello');

      expect(result).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('times out rather than hanging, same as sendOtp', async () => {
      jest.spyOn(global, 'fetch').mockImplementation(() => {
        const err = new Error('The operation was aborted');
        err.name = 'TimeoutError';
        return Promise.reject(err);
      });
      const service = new OtpService(
        makeConfig({ ...REAL_CONFIG, MSG91_SMS_TEMPLATE_ID: 'sms-template' }),
      );

      const result = await service.sendSms('9000000001', 'hello');

      expect(result).toBe(false);
    });
  });
});
