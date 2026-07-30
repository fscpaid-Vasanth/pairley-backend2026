import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import { ImageCandidate, ImageRole } from './heroImageRanking';
import { Orientation, orientationOf } from './bannerTemplates';

/**
 * Module 14 Phase 3C — measures an image so the ranking engine works from
 * real numbers instead of assumptions.
 *
 * Everything here is best-effort and non-throwing. A candidate we couldn't
 * probe must still be rankable: `heroImageRanking` treats missing metrics as
 * neutral rather than bad, precisely so a slow or unreachable host doesn't
 * silently demote a merchant's best photo.
 */

const FETCH_TIMEOUT_MS = 8_000;
const MAX_BYTES = 12 * 1024 * 1024;

export interface ImageProbe {
  url: string;
  ok: boolean;
  /** Why the probe failed, when it did. */
  error?: string;
  width?: number;
  height?: number;
  aspectRatio?: number;
  orientation?: Orientation | null;
  format?: string;
  fileSizeBytes?: number;
  /** Mean luminance, 0–1. */
  brightness?: number;
  /** Normalised luminance standard deviation, 0–1. */
  contrast?: number;
  /** 0–1; low values mean soft/out-of-focus. */
  sharpness?: number;
  /**
   * Always null: automatic watermark detection is **not implemented**, see
   * `WATERMARK_DETECTION_STATUS`. The field exists because the ranking engine
   * accepts a watermark signal and an admin can set one by hand; it is not a
   * measurement.
   */
  watermarkConfidence?: number | null;
  dominantColor?: string;
}

@Injectable()
export class ImageAnalysisService {
  private readonly logger = new Logger(ImageAnalysisService.name);

  /** Probes many URLs concurrently; never rejects. */
  async probeAll(urls: string[]): Promise<ImageProbe[]> {
    const unique = [...new Set((urls ?? []).filter(Boolean))];
    return Promise.all(unique.map((url) => this.probe(url)));
  }

  async probe(url: string): Promise<ImageProbe> {
    let buffer: Buffer;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        return { url, ok: false, error: `HTTP ${response.status}` };
      }
      buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_BYTES) {
        return { url, ok: false, error: 'Image too large to analyse' };
      }
    } catch (err) {
      return {
        url,
        ok: false,
        error: err instanceof Error ? err.message : 'fetch failed',
      };
    }

    return this.analyseBuffer(url, buffer);
  }

  /** Same analysis for bytes we already hold (e.g. an admin upload). */
  async analyseBuffer(url: string, buffer: Buffer): Promise<ImageProbe> {
    try {
      const image = sharp(buffer);
      const metadata = await image.metadata();
      const stats = await image.stats();

      const width = metadata.width ?? undefined;
      const height = metadata.height ?? undefined;

      // Mean/stddev across colour channels, normalised out of 255. Averaging
      // the channels is a cheap stand-in for true luminance and is accurate
      // enough to answer the only question being asked: would white text
      // overlaid on this be readable?
      const colourChannels = stats.channels.slice(0, 3);
      const meanOf = (pick: (c: { mean: number; stdev: number }) => number) =>
        colourChannels.length
          ? colourChannels.reduce((sum, c) => sum + pick(c), 0) /
            colourChannels.length
          : 0;

      const brightness = clamp01(meanOf((c) => c.mean) / 255);
      const contrast = clamp01(meanOf((c) => c.stdev) / 255);

      return {
        url,
        ok: true,
        width,
        height,
        aspectRatio:
          width && height
            ? Math.round((width / height) * 1000) / 1000
            : undefined,
        orientation: orientationOf(width, height),
        format: metadata.format,
        fileSizeBytes: buffer.length,
        brightness: round3(brightness),
        contrast: round3(contrast),
        sharpness: round3(await this.measureSharpness(buffer)),
        // Not measured — see WATERMARK_DETECTION_STATUS.
        watermarkConfidence: null,
        dominantColor: toHex(stats.dominant),
      };
    } catch (err) {
      this.logger.debug(
        `Image analysis failed for ${url}: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
      return {
        url,
        ok: false,
        error: err instanceof Error ? err.message : 'analysis failed',
      };
    }
  }

  /**
   * Variance-of-Laplacian, the standard cheap focus measure: convolve with a
   * Laplacian kernel (which responds to edges) and look at how much the
   * result varies. A sharp photo has strong, varied edge response; a blurred
   * one has little. Downscaled first so the figure doesn't depend on
   * resolution.
   */
  private async measureSharpness(buffer: Buffer): Promise<number> {
    try {
      const stats = await sharp(buffer)
        .greyscale()
        .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
        .convolve({
          width: 3,
          height: 3,
          kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0],
        })
        .stats();

      const stdev = stats.channels[0]?.stdev ?? 0;
      // ~25 is a comfortably sharp photo in practice; treat that as full marks.
      return clamp01(stdev / 25);
    } catch {
      return 0.5; // unknown — deliberately neutral, not a penalty
    }
  }

  /**
   * Why there is no automatic watermark detection here.
   *
   * Two region-statistics hypotheses were implemented and measured against
   * real composites (a translucent white wordmark over a detailed photo, and
   * a corner "© stockphoto" mark):
   *
   *  1. *Overlaid text adds edge activity.* Wrong — a translucent overlay
   *     flattens detail rather than adding it. Zero signal in every case.
   *  2. *An overlay lifts local brightness and drops local contrast.*
   *     Directionally correct but far too weak: the heavy wordmark moved mean
   *     brightness from 0.469 to 0.479. A +0.01 shift is indistinguishable
   *     from ordinary scene variation, so any threshold that fires on it
   *     fires on everything.
   *
   * Thin strokes averaged over a region simply do not survive as a statistic.
   * Doing this properly needs a model (or the source site's own metadata),
   * which is out of scope here.
   *
   * Rather than ship a field that always returns 0 while appearing to detect
   * watermarks — which would leave the ranking engine's watermark penalty
   * silently dead — the value is reported as `null` ("not assessed") and the
   * ranker treats it as no signal. An admin can still flag an image by hand,
   * and the penalty path stays ready for a real detector later.
   */
  static readonly WATERMARK_DETECTION_STATUS =
    'not-implemented: region statistics proved insufficient, needs a model';

  /**
   * Turns probe results into ranking candidates. Roles come from the caller
   * (it knows which URL was the offer image versus the shop photo); this only
   * attaches the measurements.
   */
  toCandidates(
    probes: ImageProbe[],
    roleFor: (url: string) => ImageRole,
    watermarkThreshold = 0.5,
  ): ImageCandidate[] {
    return probes
      .filter((probe) => probe.ok)
      .map((probe) => ({
        url: probe.url,
        role: roleFor(probe.url),
        width: probe.width ?? null,
        height: probe.height ?? null,
        brightness: probe.brightness ?? null,
        contrast: probe.contrast ?? null,
        // null means "not assessed", which the ranker treats as no signal
        // rather than as "clean" — an important distinction if a real
        // detector lands later.
        watermarkSuspected:
          probe.watermarkConfidence === null ||
          probe.watermarkConfidence === undefined
            ? null
            : probe.watermarkConfidence >= watermarkThreshold,
        // Sharpness is the best available proxy for "clear subject focus".
        focus: probe.sharpness ?? null,
      }));
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round3(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.round(value * 1000) / 1000;
}

function toHex(dominant?: {
  r: number;
  g: number;
  b: number;
}): string | undefined {
  if (!dominant) return undefined;
  const part = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(dominant.r)}${part(dominant.g)}${part(dominant.b)}`;
}
