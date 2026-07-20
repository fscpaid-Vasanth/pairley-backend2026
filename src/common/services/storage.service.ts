import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly useMock: boolean;
  private readonly uploadDir = path.join(process.cwd(), 'uploads');
  private readonly bucketName: string;
  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;

  constructor(private configService: ConfigService) {
    const mockStorageVal = this.configService.get<any>(
      'USE_MOCK_STORAGE',
      true,
    );
    this.useMock = mockStorageVal === true || mockStorageVal === 'true';

    this.bucketName = this.configService.get<string>('AWS_S3_BUCKET_NAME', '');
    this.region = this.configService.get<string>('AWS_REGION', 'ap-south-1');
    this.accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID', '');
    this.secretAccessKey = this.configService.get<string>(
      'AWS_SECRET_ACCESS_KEY',
      '',
    );

    if (this.useMock && !fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  async uploadFile(file: Express.Multer.File, folder: string): Promise<string> {
    const fileName = `${Date.now()}-${path.basename(file.originalname)}`;

    if (this.useMock) {
      const destination = path.join(this.uploadDir, folder);
      if (!fs.existsSync(destination)) {
        fs.mkdirSync(destination, { recursive: true });
      }

      const filePath = path.join(destination, fileName);
      fs.writeFileSync(filePath, file.buffer);
      this.logger.log(
        `[MOCK STORAGE] Uploaded file ${file.originalname} locally to ${filePath}`,
      );
      return `/uploads/${folder}/${fileName}`;
    }

    try {
      // Real AWS S3 Upload using @aws-sdk/client-s3
      const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');

      const s3 = new S3Client({
        region: this.region,
        credentials: {
          accessKeyId: this.accessKeyId,
          secretAccessKey: this.secretAccessKey,
        },
      });

      const key = `${folder}/${fileName}`;
      await s3.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
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

  async uploadBase64(
    base64Str: string,
    folder: string,
    originalName: string,
  ): Promise<string> {
    if (!base64Str || !base64Str.startsWith('data:')) {
      return base64Str; // Return as-is if it's already a URL or invalid
    }

    try {
      const match = base64Str.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        throw new Error('Invalid base64 format');
      }

      const mimetype = match[1];
      const buffer = Buffer.from(match[2], 'base64');

      // Construct a mock Express.Multer.File object
      const file: any = {
        buffer,
        originalname:
          originalName || `uploaded-file.${mimetype.split('/')[1] || 'png'}`,
        mimetype,
      };

      return this.uploadFile(file, folder);
    } catch (err) {
      this.logger.error(`Failed to upload base64: ${err.message}`);
      return '';
    }
  }

  // Best-effort, side-effect-free reachability check for /api/health — a
  // HEAD on the bucket itself (no object read/write), short-circuited to
  // "ok" in mock mode since there's no real S3 to check. Never throws;
  // callers treat a false result as "degraded," not as blocking health.
  async checkHealth(): Promise<{
    ok: boolean;
    mode: 'mock' | 's3';
    error?: string;
  }> {
    if (this.useMock) {
      return { ok: true, mode: 'mock' };
    }
    try {
      const { S3Client, HeadBucketCommand } =
        await import('@aws-sdk/client-s3');
      const s3 = new S3Client({
        region: this.region,
        credentials: {
          accessKeyId: this.accessKeyId,
          secretAccessKey: this.secretAccessKey,
        },
      });
      await s3.send(new HeadBucketCommand({ Bucket: this.bucketName }));
      return { ok: true, mode: 's3' };
    } catch (error) {
      return { ok: false, mode: 's3', error: error.message };
    }
  }

  async getFile(key: string): Promise<{ buffer: Buffer; contentType: string }> {
    if (this.useMock) {
      const filePath = path.join(this.uploadDir, key);
      if (!fs.existsSync(filePath)) {
        throw new Error('File not found');
      }
      const buffer = fs.readFileSync(filePath);
      const ext = path.extname(key).toLowerCase();
      let contentType = 'image/png';
      if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
      else if (ext === '.pdf') contentType = 'application/pdf';
      return { buffer, contentType };
    }

    try {
      const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
      const s3 = new S3Client({
        region: this.region,
        credentials: {
          accessKeyId: this.accessKeyId,
          secretAccessKey: this.secretAccessKey,
        },
      });

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
}
