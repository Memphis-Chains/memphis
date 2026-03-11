import type { FastifyReply, FastifyRequest } from 'fastify';

import { toAppError } from '../../core/errors.js';

export function handleHttpError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  const appError = toAppError(error);

  request.log.error(
    {
      event: 'http.request.failed',
      code: appError.code,
      details: appError.details,
      statusCode: appError.statusCode,
    },
    appError.message,
  );

  return reply.status(appError.statusCode).send({
    error: {
      code: appError.code,
      message: appError.message,
      suggestion: appError.suggestion,
      details: appError.details ?? {},
      requestId: request.id,
    },
  });
}
