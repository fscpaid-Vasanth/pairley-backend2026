import { WhatsappService } from './whatsapp.service';

// Launch-readiness finding: lead-alert WhatsApp sends were failing silently
// in production (WhatsAppMessage rows logged status FAILED, error "No
// WhatsApp token configured") with no visibility short of reading a failed
// send's logged error after the fact. getStatus() is the side-effect-free
// check GET /admin/system-health now surfaces this through.
describe('WhatsappService.getStatus', () => {
  const makeConfig = (values: Record<string, string | undefined>) =>
    ({
      get: jest.fn((key: string) => values[key]),
    }) as any;

  it('reports not configured when neither token nor phone number ID is set (the production launch-readiness finding)', () => {
    const service = new WhatsappService(makeConfig({}));
    expect(service.getStatus()).toEqual({
      configured: false,
      phoneNumberIdSet: false,
      tokenSet: false,
    });
  });

  it('reports not configured when only the phone number ID is set', () => {
    const service = new WhatsappService(
      makeConfig({ WHATSAPP_PHONE_NUMBER_ID: '123456' }),
    );
    expect(service.getStatus()).toEqual({
      configured: false,
      phoneNumberIdSet: true,
      tokenSet: false,
    });
  });

  it('accepts WHATSAPP_ACCESS_TOKEN as a fallback for WHATSAPP_API_TOKEN', () => {
    const service = new WhatsappService(
      makeConfig({
        WHATSAPP_PHONE_NUMBER_ID: '123456',
        WHATSAPP_ACCESS_TOKEN: 'fallback-token',
      }),
    );
    expect(service.getStatus()).toEqual({
      configured: true,
      phoneNumberIdSet: true,
      tokenSet: true,
    });
  });

  it('reports fully configured when both phone number ID and API token are set', () => {
    const service = new WhatsappService(
      makeConfig({
        WHATSAPP_PHONE_NUMBER_ID: '123456',
        WHATSAPP_API_TOKEN: 'real-token',
      }),
    );
    expect(service.getStatus()).toEqual({
      configured: true,
      phoneNumberIdSet: true,
      tokenSet: true,
    });
  });

  it('never leaks the token or phone number ID values themselves', () => {
    const service = new WhatsappService(
      makeConfig({
        WHATSAPP_PHONE_NUMBER_ID: 'secret-phone-id',
        WHATSAPP_API_TOKEN: 'super-secret-token',
      }),
    );
    const status = JSON.stringify(service.getStatus());
    expect(status).not.toContain('secret-phone-id');
    expect(status).not.toContain('super-secret-token');
  });
});
