import { Global, Module } from '@nestjs/common';
import { EntitlementService } from './entitlement.service';
import { EntitlementAdminService } from './entitlement-admin.service';
import { EntitlementController } from './entitlement.controller';

// @Global for the same reason CommonModule is: LeadService needs the engine,
// and future callers (Demand fulfilment in M2, any paid surface after that)
// will too. Making it global avoids threading an import through every module
// that ever gates a feature on entitlement.
@Global()
@Module({
  controllers: [EntitlementController],
  providers: [EntitlementService, EntitlementAdminService],
  exports: [EntitlementService, EntitlementAdminService],
})
export class EntitlementModule {}
