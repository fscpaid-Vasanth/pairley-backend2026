import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EntitlementService } from './entitlement.service';
import { EntitlementAdminService } from './entitlement-admin.service';
import { EntitlementController } from './entitlement.controller';

// @Global for the same reason CommonModule is: LeadService needs the engine,
// and future callers (Demand fulfilment in M2, any paid surface after that)
// will too. Making it global avoids threading an import through every module
// that ever gates a feature on entitlement.
@Global()
@Module({
  // EntitlementController is guarded by JwtAuthGuard, which injects
  // JwtService. Guards are resolved in the module that declares the
  // controller, not where the guard class lives, so AuthModule (which
  // configures and exports JwtModule) must be imported here — the same
  // reason LeadModule, DashboardModule and the rest import it.
  imports: [AuthModule],
  controllers: [EntitlementController],
  providers: [EntitlementService, EntitlementAdminService],
  exports: [EntitlementService, EntitlementAdminService],
})
export class EntitlementModule {}
