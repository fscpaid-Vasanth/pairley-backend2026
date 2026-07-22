import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';

// tesseract.js gains essentially nothing from OCR-ing an image larger than
// this on its longest side, but processing time scales with pixel count —
// this is the Module 10 Phase 2 performance requirement (Decision-approved
// "reasonable limits... including image resizing where appropriate before
// OCR").
const MAX_DIMENSION = 2000;

@Injectable()
export class ImagePreprocessingService {
  private readonly logger = new Logger(ImagePreprocessingService.name);

  async resizeIfNeeded(buffer: Buffer): Promise<Buffer> {
    try {
      const image = sharp(buffer);
      const { width, height } = await image.metadata();
      if (!width || !height || Math.max(width, height) <= MAX_DIMENSION) {
        return buffer;
      }

      const resized = await image
        .resize({
          width: MAX_DIMENSION,
          height: MAX_DIMENSION,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .toBuffer();
      this.logger.log(
        `Resized image from ${width}x${height} to fit within ${MAX_DIMENSION}px before OCR`,
      );
      return resized;
    } catch (err) {
      // Preprocessing is an optimization, not a correctness requirement —
      // if sharp can't even read the image (corrupt/unusual encoding), let
      // the original buffer flow through to OCR rather than failing the
      // whole import here. OCR's own failure mode (if it also can't read
      // the file) produces a clearer, more specific error than this step
      // would.
      this.logger.warn(
        `Image preprocessing skipped (${err instanceof Error ? err.message : 'unknown error'}) — proceeding with original buffer`,
      );
      return buffer;
    }
  }
}
