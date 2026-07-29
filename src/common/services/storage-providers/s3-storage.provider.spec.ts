import { ConfigService } from '@nestjs/config';

// Fake readable stream matching what @aws-sdk/client-s3's GetObjectCommand
// response.Body actually looks like closely enough for streamToBuffer():
// synchronously "emits" data then end as soon as both handlers are
// registered, since the provider registers all three listeners
// synchronously before yielding.
function fakeStream(chunks: Buffer[]) {
  return {
    on(event: string, cb: (arg?: any) => void) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      if (event === 'end') cb();
      return this;
    },
  };
}

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Put', input })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Get', input })),
  HeadBucketCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Head', input })),
}));

import { S3StorageProvider } from './s3-storage.provider';

describe('S3StorageProvider', () => {
  const makeConfig = () =>
    ({
      get: jest.fn((key: string, def?: any) => {
        const values: Record<string, string> = {
          AWS_S3_BUCKET_NAME: 'pairley-storage',
          AWS_REGION: 'ap-south-1',
          AWS_ACCESS_KEY_ID: 'test-key',
          AWS_SECRET_ACCESS_KEY: 'test-secret',
        };
        return values[key] ?? def;
      }),
    }) as unknown as ConfigService;

  let provider: S3StorageProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new S3StorageProvider(makeConfig());
  });

  it('put() uploads via PutObjectCommand and returns the S3 URL, matching the pre-migration URL shape exactly', async () => {
    mockSend.mockResolvedValue({});
    const url = await provider.put(Buffer.from('hello'), 'businesses/shops', '123-shop.png', 'image/png');

    expect(url).toBe(
      'https://pairley-storage.s3.ap-south-1.amazonaws.com/businesses/shops/123-shop.png',
    );
    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0];
    expect(command.__cmd).toBe('Put');
    expect(command.input).toEqual({
      Bucket: 'pairley-storage',
      Key: 'businesses/shops/123-shop.png',
      Body: Buffer.from('hello'),
      ContentType: 'image/png',
    });
  });

  it('put() throws a clear error when the S3 call fails', async () => {
    mockSend.mockRejectedValue(new Error('access denied'));
    await expect(
      provider.put(Buffer.from('x'), 'folder', 'name.png', 'image/png'),
    ).rejects.toThrow('S3 upload failed: access denied');
  });

  it('get() streams the object body into a Buffer and returns the content type', async () => {
    mockSend.mockResolvedValue({
      Body: fakeStream([Buffer.from('chunk1'), Buffer.from('chunk2')]),
      ContentType: 'image/jpeg',
    });

    const result = await provider.get('businesses/shops/123-shop.png');

    expect(result.buffer).toEqual(Buffer.concat([Buffer.from('chunk1'), Buffer.from('chunk2')]));
    expect(result.contentType).toBe('image/jpeg');
    const command = mockSend.mock.calls[0][0];
    expect(command.__cmd).toBe('Get');
    expect(command.input).toEqual({ Bucket: 'pairley-storage', Key: 'businesses/shops/123-shop.png' });
  });

  it('get() falls back to image/png when S3 returns no ContentType', async () => {
    mockSend.mockResolvedValue({ Body: fakeStream([Buffer.from('x')]) });
    const result = await provider.get('some/key.bin');
    expect(result.contentType).toBe('image/png');
  });

  it('get() throws a clear error when the object cannot be fetched', async () => {
    mockSend.mockRejectedValue(new Error('NoSuchKey'));
    await expect(provider.get('missing/key.png')).rejects.toThrow('S3 fetch failed: NoSuchKey');
  });

  it('health() returns ok:true when HeadBucketCommand succeeds', async () => {
    mockSend.mockResolvedValue({});
    const result = await provider.health();
    expect(result).toEqual({ ok: true });
    expect(mockSend.mock.calls[0][0].__cmd).toBe('Head');
  });

  it('health() returns ok:false with the error message, never throws', async () => {
    mockSend.mockRejectedValue(new Error('quarantine: access denied'));
    const result = await provider.health();
    expect(result).toEqual({ ok: false, error: 'quarantine: access denied' });
  });
});
