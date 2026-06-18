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
    const mockStorageVal = this.configService.get<any>('USE_MOCK_STORAGE', true);
    this.useMock = mockStorageVal === true || mockStorageVal === 'true';
    
    this.bucketName = this.configService.get<string>('AWS_S3_BUCKET_NAME', '');
    this.region = this.configService.get<string>('AWS_REGION', 'ap-south-1');
    this.accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID', '');
    this.secretAccessKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY', '');

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
      this.logger.log(`[MOCK STORAGE] Uploaded file ${file.originalname} locally to ${filePath}`);
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
      await s3.send(new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        ACL: 'public-read' as any,
      }));

      const publicUrl = `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${key}`;
      this.logger.log(`[AWS S3] Uploaded file to: ${publicUrl}`);
      return publicUrl;
    } catch (error) {
      this.logger.error(`Failed to upload to S3: ${error.message}`);
      throw new Error(`S3 upload failed: ${error.message}`);
    }
  }
}

