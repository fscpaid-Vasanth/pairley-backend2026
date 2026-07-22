import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BusinessStatus, ClaimRequestStatus } from '@prisma/client';
import { BusinessConsolidationService } from './business-consolidation.service';
import { PrismaService } from '../prisma/prisma.service';

// Module 12 Phase 4 — Business Duplicate Consolidation. Covers the safety
// guards (pending claim, already-removed, non-UNCLAIMED duplicate,
// self-consolidation, missing canonical) and the happy path's atomic
// offer-reassignment + soft-remove.
describe('BusinessConsolidationService', () => {
  let businessFindUnique: jest.Mock;
  let businessFindMany: jest.Mock;
  let businessUpdate: jest.Mock;
  let offerUpdateMany: jest.Mock;
  let claimRequestFindFirst: jest.Mock;
  let claimRequestFindMany: jest.Mock;
  let transaction: jest.Mock;
  let service: BusinessConsolidationService;

  const duplicateBiz = {
    id: 'dup-1',
    business_name: 'Ghost Shop (2)',
    business_status: BusinessStatus.UNCLAIMED,
    duplicate_of_business_id: 'canon-1',
  };
  const canonicalBiz = {
    id: 'canon-1',
    business_name: 'Ghost Shop',
    business_status: BusinessStatus.UNCLAIMED,
    duplicate_of_business_id: null,
  };

  const businessesById: Record<string, any> = {
    'dup-1': duplicateBiz,
    'canon-1': canonicalBiz,
  };

  beforeEach(() => {
    businessFindUnique = jest
      .fn()
      .mockImplementation(({ where: { id } }) =>
        Promise.resolve(businessesById[id] ?? null),
      );
    businessFindMany = jest.fn().mockResolvedValue([]);
    businessUpdate = jest
      .fn()
      .mockImplementation(({ where: { id }, data }) =>
        Promise.resolve({ ...businessesById[id], ...data }),
      );
    offerUpdateMany = jest.fn().mockResolvedValue({ count: 3 });
    claimRequestFindFirst = jest.fn().mockResolvedValue(null);
    claimRequestFindMany = jest.fn().mockResolvedValue([]);
    transaction = jest.fn().mockImplementation((ops: Promise<unknown>[]) =>
      Promise.all(ops),
    );

    const prisma = {
      business: {
        findUnique: businessFindUnique,
        findMany: businessFindMany,
        update: businessUpdate,
      },
      offer: { updateMany: offerUpdateMany },
      claimRequest: {
        findFirst: claimRequestFindFirst,
        findMany: claimRequestFindMany,
      },
      $transaction: transaction,
    };

    service = new BusinessConsolidationService(
      prisma as unknown as PrismaService,
    );
  });

  describe('consolidate', () => {
    it('reassigns offers and soft-removes the duplicate on the happy path', async () => {
      const result = await service.consolidate('dup-1', undefined, 'admin-1');

      expect(offerUpdateMany).toHaveBeenCalledWith({
        where: { business_id: 'dup-1' },
        data: { business_id: 'canon-1' },
      });
      expect(businessUpdate).toHaveBeenCalledWith({
        where: { id: 'dup-1' },
        data: expect.objectContaining({
          business_status: BusinessStatus.REMOVED,
          consolidated_into_business_id: 'canon-1',
          consolidated_by: 'admin-1',
        }),
      });
      expect(result.offers_reassigned).toBe(3);
      expect(result.canonical_business_id).toBe('canon-1');
    });

    it('defaults canonical_business_id to the stored duplicate_of_business_id when omitted', async () => {
      await service.consolidate('dup-1', undefined, 'admin-1');
      expect(businessFindUnique).toHaveBeenCalledWith({ where: { id: 'canon-1' } });
    });

    it('lets an admin override the canonical business explicitly', async () => {
      businessesById['other-canon'] = {
        id: 'other-canon',
        business_status: BusinessStatus.UNCLAIMED,
      };
      const result = await service.consolidate('dup-1', 'other-canon', 'admin-1');
      expect(result.canonical_business_id).toBe('other-canon');
      delete businessesById['other-canon'];
    });

    it('throws NotFound when the duplicate business does not exist', async () => {
      await expect(
        service.consolidate('missing', 'canon-1', 'admin-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequest when no canonical id is available at all', async () => {
      businessesById['orphan'] = {
        id: 'orphan',
        business_status: BusinessStatus.UNCLAIMED,
        duplicate_of_business_id: null,
      };
      await expect(
        service.consolidate('orphan', undefined, 'admin-1'),
      ).rejects.toThrow(BadRequestException);
      delete businessesById['orphan'];
    });

    it('throws BadRequest when consolidating a business with itself', async () => {
      await expect(
        service.consolidate('dup-1', 'dup-1', 'admin-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFound when the canonical business does not exist', async () => {
      await expect(
        service.consolidate('dup-1', 'missing-canon', 'admin-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequest when the duplicate has already been consolidated', async () => {
      businessesById['dup-1'] = { ...duplicateBiz, business_status: BusinessStatus.REMOVED };
      await expect(
        service.consolidate('dup-1', 'canon-1', 'admin-1'),
      ).rejects.toThrow(BadRequestException);
      businessesById['dup-1'] = duplicateBiz;
    });

    it('throws BadRequest when the duplicate is not UNCLAIMED (already has an owner)', async () => {
      businessesById['dup-1'] = { ...duplicateBiz, business_status: BusinessStatus.CLAIMED };
      await expect(
        service.consolidate('dup-1', 'canon-1', 'admin-1'),
      ).rejects.toThrow(BadRequestException);
      businessesById['dup-1'] = duplicateBiz;
    });

    it('throws BadRequest when the canonical business has itself been removed', async () => {
      businessesById['canon-1'] = { ...canonicalBiz, business_status: BusinessStatus.REMOVED };
      await expect(
        service.consolidate('dup-1', 'canon-1', 'admin-1'),
      ).rejects.toThrow(BadRequestException);
      businessesById['canon-1'] = canonicalBiz;
    });

    it('throws BadRequest when a pending claim exists on the duplicate', async () => {
      claimRequestFindFirst.mockResolvedValue({
        id: 'claim-1',
        business_id: 'dup-1',
        status: ClaimRequestStatus.PENDING_ADMIN_REVIEW,
      });
      await expect(
        service.consolidate('dup-1', 'canon-1', 'admin-1'),
      ).rejects.toThrow(BadRequestException);
      expect(offerUpdateMany).not.toHaveBeenCalled();
    });

    it('throws BadRequest when a pending claim exists on the canonical business', async () => {
      claimRequestFindFirst.mockResolvedValue({
        id: 'claim-1',
        business_id: 'canon-1',
        status: ClaimRequestStatus.ADMIN_APPROVED,
      });
      await expect(
        service.consolidate('dup-1', 'canon-1', 'admin-1'),
      ).rejects.toThrow(BadRequestException);
      expect(offerUpdateMany).not.toHaveBeenCalled();
    });

    it('does not block on a completed (terminal) claim', async () => {
      claimRequestFindFirst.mockResolvedValue(null); // findFirst is already scoped to pending statuses only
      const result = await service.consolidate('dup-1', 'canon-1', 'admin-1');
      expect(result.offers_reassigned).toBe(3);
    });
  });

  describe('getDuplicateDetail', () => {
    it('flags pending claims on both sides independently', async () => {
      businessFindUnique.mockResolvedValueOnce({ ...duplicateBiz, duplicate_of: canonicalBiz });
      claimRequestFindMany.mockResolvedValue([
        { id: 'c1', business_id: 'canon-1', status: ClaimRequestStatus.PENDING_ADMIN_REVIEW },
      ]);

      const result = await service.getDuplicateDetail('dup-1');
      expect(result.pending_claim_on_this).toBe(false);
      expect(result.pending_claim_on_canonical).toBe(true);
    });

    it('throws NotFound for a nonexistent business', async () => {
      businessFindUnique.mockResolvedValueOnce(null);
      await expect(service.getDuplicateDetail('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
