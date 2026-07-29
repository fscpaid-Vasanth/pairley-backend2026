import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { CloudStorageProvider } from './cloud-storage-provider.interface';

// Storage Migration Phase 1 — extracted from the pre-migration
// StorageService (same S3Client construction, same PutObjectCommand/
// GetObjectCommand/HeadBucketCommand calls, same error messages, same
// returned URL shape) so STORAGE_PROVIDER=s3 behaves identically to the
// code this replaced.
//
// One deliberate change from the original: the AWS SDK import is a static
// top-level import here, not `await import(...)` inside each method. That
// dynamic-import pattern turned out to be untestable under this project's
// tsconfig (`module: "nodenext"` compiles `import()` to a genuine dynamic
// import, which Jest's CJS-based `jest.mock()` can't intercept without
// `--experimental-vm-modules` — a project-wide Jest config change this
// migration doesn't need). Static import has no runtime behavior
// difference here (the SDK was always loaded synchronously at call time
// either way; nothing depended on it being deferred) and is what let the
// AWS branch get real test coverage for the first time.
export class S3StorageProvider implements CloudStorageProvider {
  private readonly logger = new Logger(S3StorageProvider.name);
  private readonly bucketName: string;
  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;

  constructor(configService: ConfigService) {
    this.bucketName = configService.get<string>('AWS_S3_BUCKET_NAME', '');
    this.region = configService.get<string>('AWS_REGION', 'ap-south-1');
    this.accessKeyId = configService.get<string>('AWS_ACCESS_KEY_ID', '');
    this.secretAccessKey = configService.get<string>(
      'AWS_SECRET_ACCESS_KEY',
      '',
    );
  }

  private client() {
    return new S3Client({
      region: this.region,
      credentials: {
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
      },
    });
  }

  async put(
    buffer: Buffer,
    folder: string,
    fileName: string,
    contentType: string,
  ): Promise<string> {
    try {
      const s3 = this.client();
      const key = `${folder}/${fileName}`;
      await s3.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          Body: buffer,
          ContentType: contentType,
        }),
      );

      const publicUrl = `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${key}`;
      this.logger.log(`[AWS S3] Uploaded file to: ${publicUrl}`);
      return publicUrl;
    } catch (error) {
      this.logger.error(`Failed to upload to S3: ${error.message}`);
      throw new Error(`S3 upload failed: ${error.message}`);
    }
  }

  async get(key: string): Promise<{ buffer: Buffer; contentType: string }> {
    try {
      const s3 = this.client();
      const response = await s3.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        }),
      );

      const streamToBuffer = (stream: any): Promise<Buffer> =>
        new Promise((resolve, reject) => {
          const chunks: any[] = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => resolve(Buffer.concat(chunks)));
        });

      const buffer = await streamToBuffer(response.Body);
      return {
        buffer,
        contentType: response.ContentType || 'image/png',
      };
    } catch (error) {
      this.logger.error(`Failed to get file from S3: ${error.message}`);
      throw new Error(`S3 fetch failed: ${error.message}`);
    }
  }

  async health(): Promise<{ ok: boolean; error?: string }> {
    try {
      const s3 = this.client();
      await s3.send(new HeadBucketCommand({ Bucket: this.bucketName }));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
}
