import pino from 'pino';
import { config } from './config';

export const logger = pino({
  name: 'worker',
  level: config().LOG_LEVEL,
  redact: {
    paths: ['*.token', '*.tokenHash', '*.secret', '*.password', '*.privateKey'],
    censor: '[redacted]',
  },
  transport:
    config().NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});
