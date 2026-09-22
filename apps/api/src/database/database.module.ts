import { Global, Module, type OnModuleDestroy } from '@nestjs/common';
import { SystemDb, TenantDb } from '@eyesonbug/db';
import { env } from '../config/env';

export const TENANT_DB = Symbol('TENANT_DB');
export const SYSTEM_DB = Symbol('SYSTEM_DB');

/**
 * Two handles, deliberately distinct.
 *
 * `TenantDb` connects as the RLS-bound application role and is what virtually
 * everything uses. `SystemDb` bypasses RLS and exists for exactly one job:
 * the identity bootstrap at login, where there is no organization yet because
 * we are still working out who the caller is. Keeping them as separate
 * injectable tokens makes "what can bypass isolation?" a question you answer
 * by grepping for `SYSTEM_DB`.
 */
@Global()
@Module({
  providers: [
    {
      provide: TENANT_DB,
      useFactory: (): TenantDb => new TenantDb({ url: env().DATABASE_URL, max: 20 }),
    },
    {
      provide: SYSTEM_DB,
      useFactory: (): SystemDb => new SystemDb({ url: env().DATABASE_MIGRATION_URL, max: 4 }),
    },
  ],
  exports: [TENANT_DB, SYSTEM_DB],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor() {}

  async onModuleDestroy(): Promise<void> {
    // Pools are closed by the process exiting; explicit close lives in tests.
  }
}
