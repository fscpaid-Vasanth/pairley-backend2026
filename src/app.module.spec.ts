import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';

// Boot smoke test — compiles the real DI graph for the whole application.
//
// Every other spec in this repo constructs services directly with mocked
// dependencies, which means none of them can see a wiring mistake: a
// controller guarded by JwtAuthGuard in a module that never imports
// AuthModule typechecks cleanly, passes every unit test, and then fails at
// container build time on boot.
//
// That is exactly what happened with EntitlementModule — the failure only
// surfaced in production logs after deploy, with the previous release left
// serving. This test moves that detection to the point of writing the code.
//
// Prisma is overridden so no database connection is required; the point is
// the shape of the dependency graph, not talking to anything real.
describe('AppModule (DI graph)', () => {
  it('compiles — every controller, guard and provider resolves', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        $connect: jest.fn(),
        $disconnect: jest.fn(),
        $on: jest.fn(),
      })
      .compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  }, 30_000);
});
