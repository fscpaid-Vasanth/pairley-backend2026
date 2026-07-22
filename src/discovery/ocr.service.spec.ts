import { OcrService } from './ocr.service';

const recognizeMock = jest.fn();
const terminateMock = jest.fn().mockResolvedValue(undefined);
const createWorkerMock = jest.fn().mockResolvedValue({
  recognize: recognizeMock,
  terminate: terminateMock,
});

jest.mock('tesseract.js', () => ({
  createWorker: (...args: unknown[]): unknown => createWorkerMock(...args),
}));

describe('OcrService', () => {
  let service: OcrService;

  beforeEach(() => {
    jest.clearAllMocks();
    createWorkerMock.mockResolvedValue({
      recognize: recognizeMock,
      terminate: terminateMock,
    });
    service = new OcrService();
  });

  it('normalizes Tesseract confidence from a 0-100 scale to 0-1', async () => {
    recognizeMock.mockResolvedValue({
      data: { text: 'Diwali Sale', confidence: 87 },
    });

    const result = await service.extractText(Buffer.from('fake-image-bytes'));

    expect(result).toEqual({ text: 'Diwali Sale', confidence: 0.87 });
  });

  it('creates an English worker and terminates it after recognition', async () => {
    recognizeMock.mockResolvedValue({ data: { text: 'X', confidence: 50 } });

    await service.extractText(Buffer.from('fake'));

    expect(createWorkerMock).toHaveBeenCalledWith('eng');
    expect(terminateMock).toHaveBeenCalledTimes(1);
  });

  it('terminates the worker even if recognition throws, and propagates the error', async () => {
    recognizeMock.mockRejectedValue(new Error('corrupt image data'));

    await expect(service.extractText(Buffer.from('fake'))).rejects.toThrow(
      'corrupt image data',
    );
    expect(terminateMock).toHaveBeenCalledTimes(1);
  });
});
