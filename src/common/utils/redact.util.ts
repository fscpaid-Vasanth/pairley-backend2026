export const REDACTED = '[REDACTED]';

// Single source of truth for what "sensitive" means across this codebase —
// used by both Sentry's beforeSend (this file) and nestjs-pino's redact
// paths, so the list only has to be maintained once.
const SENSITIVE_KEY_FRAGMENTS = [
  // auth/session
  'password',
  'otp',
  'authorization',
  'token',
  'jwt',
  'session',
  'cookie',
  'secret',
  // KYC
  'aadhaar',
  'pan',
  'gst',
  // customer/business PII
  'phone',
  'mobile',
  'email',
  'name',
  'address',
  'pincode',
  'dob',
  'date_of_birth',
  // third-party credentials
  'access_key',
  'accesskey',
  'api_key',
  'apikey',
];

function normalize(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalize(key);
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) =>
    normalized.includes(normalize(fragment)),
  );
}

function redact(value: unknown, depth: number): unknown {
  if (depth > 6 || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      out[key] = isSensitiveKey(key)
        ? REDACTED
        : redact(source[key], depth + 1);
    }
    return out;
  }
  return value;
}

export function redactSensitive<T>(value: T): T {
  return redact(value, 0) as T;
}

// fast-redact (used by pino's `redact` option) needs literal paths rather
// than the substring matching above — kept in sync with
// SENSITIVE_KEY_FRAGMENTS by hand since the two libraries' redaction
// mechanisms aren't compatible with a single shared implementation.
const SENSITIVE_FIELD_NAMES = [
  'password',
  'password_hash',
  'otp',
  'otp_code',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'jwt',
  'session',
  'cookie',
  'secret',
  'client_secret',
  'aadhaar',
  'aadhaar_number',
  'pan',
  'pan_number',
  'gst',
  'gst_number',
  'aws_access_key_id',
  'aws_secret_access_key',
  'razorpay_key_id',
  'razorpay_key_secret',
  'openai_api_key',
  'google_api_key',
  'whatsapp_access_token',
  'whatsapp_api_token',
  'meta_token',
  'firebase_token',
  'fcm_token',
];

export const PINO_REDACT_PATHS: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  ...SENSITIVE_FIELD_NAMES.map((field) => `*.${field}`),
];
