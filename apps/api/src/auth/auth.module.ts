import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GithubOauthService } from './github-oauth.service';
import { SessionService } from './session.service';
import { AuthGuard } from './auth.guard';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, GithubOauthService, SessionService, AuthGuard],
  exports: [SessionService, AuthGuard, AuthService],
})
export class AuthModule {}
