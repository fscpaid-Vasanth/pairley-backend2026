import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from '../auth/auth.module';
import { FileValidationService } from '../discovery/file-validation.service';
import { BulkImportController } from './bulk-import.controller';
import { BulkImportService } from './bulk-import.service';
import { BulkImageImportService } from './bulk-image-import.service';
import { BulkImportScheduler } from './bulk-import.scheduler';

@Module({
  imports: [AuthModule, ScheduleModule.forRoot()],
  controllers: [BulkImportController],
  providers: [
    BulkImportService,
    BulkImageImportService,
    BulkImportScheduler,
    // Reused from Module 10/12's upload path — the same magic-byte checks
    // apply to a bulk-uploaded image as to any other.
    FileValidationService,
  ],
  exports: [BulkImportService],
})
export class BulkImportModule {}
