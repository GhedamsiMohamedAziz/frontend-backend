import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { logger } from './common/logger';
import { env } from './config/env';

export async function createApp(): Promise<NestFastifyApplication> {
  const config = env();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ genReqId: () => crypto.randomUUID(), trustProxy: true }),
    // Not `logger: false`: Nest reports framework-level startup problems
    // through this logger, and silencing it turns a missing optional peer
    // dependency into a process that exits 1 with no output at all.
    { logger: ['error', 'warn'] },
  );

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(cors, {
    // The browser sends the session cookie, so the origin must be explicit:
    // `credentials: true` is incompatible with a wildcard origin.
    origin: [config.WEB_URL],
    credentials: true,
  });
  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    // Ingestion will need its own, far higher, budget in M1.
    keyGenerator: (request) => request.ip,
  });

  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();

  const openapi = new DocumentBuilder()
    .setTitle('EyesOnBug API')
    .setDescription('Acceptance test orchestration and reporting')
    .setVersion('0.1.0')
    .addCookieAuth(config.SESSION_COOKIE_NAME)
    .build();
  SwaggerModule.setup('v1/docs', app, SwaggerModule.createDocument(app, openapi), {
    jsonDocumentUrl: 'v1/openapi.json',
  });

  return app;
}

async function bootstrap(): Promise<void> {
  const config = env();
  const app = await createApp();
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info(
    { port: config.PORT, env: config.NODE_ENV },
    `EyesOnBug API listening on ${config.API_URL} (docs at /v1/docs)`,
  );
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    // Written with console.error, not the logger: pino's pretty transport is a
    // worker thread, so a `logger.fatal` followed immediately by `process.exit`
    // loses the message — and a startup failure that prints nothing is the
    // worst possible failure to debug. Setting `exitCode` rather than calling
    // `exit` also lets any in-flight log output flush first.
    console.error('EyesOnBug API failed to start:');
    console.error(error);
    logger.fatal({ err: error }, 'failed to start');
    process.exitCode = 1;
  });
}
