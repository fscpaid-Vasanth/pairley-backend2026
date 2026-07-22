import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, Role } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { BusinessConsolidationService } from './business-consolidation.service';

class ConsolidateDto {
  // Optional — defaults to the business's own duplicate_of_business_id
  // (the AI's original suggestion) when omitted, but the admin can
  // override it to merge into a different business entirely.
  @IsOptional()
  @IsString()
  canonical_business_id?: string;
}

// Module 12 Phase 4 — admin-only business duplicate consolidation. Sibling
// to ClaimAdminController (business/claim/requests): same module, same
// admin-only claim-adjacent domain, same guard/decorator conventions.
@Controller('business/duplicates')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class BusinessDuplicatesController {
  constructor(
    private readonly consolidationService: BusinessConsolidationService,
  ) {}

  @Get()
  list() {
    return this.consolidationService.listDuplicates();
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.consolidationService.getDuplicateDetail(id);
  }

  @Post(':id/consolidate')
  consolidate(
    @Param('id') id: string,
    @Body() body: ConsolidateDto,
    @CurrentUser() admin: { sub: string },
  ) {
    return this.consolidationService.consolidate(
      id,
      body.canonical_business_id,
      admin.sub,
    );
  }
}
