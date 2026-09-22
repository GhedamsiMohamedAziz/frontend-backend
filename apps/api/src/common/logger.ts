import pino from 'pino';
import { env } from '../config/env';

/**
 * Structured logs with redaction configured at the logger, not at call sites.
 *
 * "No secrets in logs" only holds if it is impossible to get it wrong, and a
 * rule that every developer must remember at every `log.info` is not a rule.
 */
export const logger = pino({
  level: env().LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.token',
      '*.tokenHash',
      '*.password',
      '*.secret',
      '*.clientSecret',
      '*.privateKey',
      'body.token',
      'body.secret',
    ],
    censor: '[redacted]',
  },
  transport:
    env().NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});
