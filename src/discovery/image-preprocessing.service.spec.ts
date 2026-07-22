const metadataMock = jest.fn();
const toBufferMock = jest.fn();
const resizeMock = jest.fn().mockReturnValue({
  toBuffer: (...args: unknown[]): unknown => toBufferMock(...args),
});
const sharpMock = jest
  .fn()
  .mockReturnValue({ metadata: metadataMock, resize: resizeMock });

jest.mock('sharp', () => ({
  __esModule: true,
  default: (...args: unknown[]): unknown => sharpMock(...args),
}));

import { ImagePreprocessingService } from './image-preprocessing.service';

describe('ImagePreprocessingService', () => {
  let service: ImagePreprocessingService;
  const original = Buffer.from('original-image-bytes');
  const resized = Buffer.from('resized-image-bytes');

  beforeEach(() => {
    jest.clearAllMocks();
    resizeMock.mockReturnValue({
      toBuffer: (...args: unknown[]): unknown => toBufferMock(...args),
    });
    service = new ImagePreprocessingService();
  });

  it('returns the original buffer unchanged when the image is already within the size limit', async () => {
    metadataMock.mockResolvedValue({ width: 800, height: 600 });

    const result = await service.resizeIfNeeded(original);

    expect(result).toBe(original);
    expect(resizeMock).not.toHaveBeenCalled();
  });

  it('resizes an image larger than the max dimension', async () => {
    metadataMock.mockResolvedValue({ width: 4000, height: 3000 });
    toBufferMock.mockResolvedValue(resized);

    const result = await service.resizeIfNeeded(original);

    expect(resizeMock).toHaveBeenCalledWith({
      width: 2000,
      height: 2000,
      fit: 'inside',
      withoutEnlargement: true,
    });
    expect(result).toBe(resized);
  });

  it('falls back to the original buffer if sharp cannot read the image at all', async () => {
    metadataMock.mockRejectedValue(new Error('unsupported image format'));

    const result = await service.resizeIfNeeded(original);

    expect(result).toBe(original);
  });

  it('treats missing width/height metadata as "no resize needed"', async () => {
    metadataMock.mockResolvedValue({});

    const result = await service.resizeIfNeeded(original);

    expect(result).toBe(original);
    expect(resizeMock).not.toHaveBeenCalled();
  });
});
