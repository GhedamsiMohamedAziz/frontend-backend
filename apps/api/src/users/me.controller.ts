import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { eq } from 'drizzle-orm';
import { SystemDb } from '@eyesonbug/db';
import { schema } from '@eyesonbug/db';
import { type Me, updateMeSchema, type UpdateMeInput } from '@eyesonbug/shared';
import { AccessService } from '../access/access.service';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { zodPipe } from '../common/zod-validation.pipe';
import { SYSTEM_DB } from '../database/database.module';

@ApiTags('identity')
@Controller('v1/me')
export class MeController {
  constructor(
    private readonly access: AccessService,
    @Inject(SYSTEM_DB) private readonly system: SystemDb,
  ) {}

  /**
   * The whole authorization picture in one request.
   *
   * The UI needs the user, their organizations and their role in every visible
   * project before it can render a shell — deciding which nav items exist, which
   * buttons to show. Splitting this into three calls would put a waterfall in
   * front of every first paint.
   */
  @Get()
  @ApiOperation({ summary: 'The current user, their organizations and project roles' })
  async me(@CurrentUser() user: SessionUser): Promise<Me> {
    const [organizations, projects] = await Promise.all([
      this.access.organizationsFor(user.id),
      this.access.visibleProjects(user.id),
    ]);

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatarUrl: user.avatarUrl,
        locale: user.locale,
        theme: user.theme,
      },
      organizations,
      projects,
    };
  }

  @Patch()
  @ApiOperation({ summary: 'Update display preferences' })
  async update(
    @CurrentUser() user: SessionUser,
    @Body(zodPipe(updateMeSchema)) body: UpdateMeInput,
  ): Promise<{ ok: true }> {
    if (Object.keys(body).length > 0) {
      await this.system.db.update(schema.users).set(body).where(eq(schema.users.id, user.id));
    }
    return { ok: true };
  }
}
