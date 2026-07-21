import { Module } from '@nestjs/common';
import { ImportJobRepository } from './import-job.repository';

// Module 9 — AI Offer Discovery (Group B). Phase 1 registers only the
// repository layer; the import/fetch service and controller land in
// Phase 2, the admin review-queue controller in Phase 3.
@Module({
  providers: [ImportJobRepository],
  exports: [ImportJobRepository],
})
export class DiscoveryModule {}
