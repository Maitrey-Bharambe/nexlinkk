'use strict';

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (code, message, details) => new AppError(400, code, message, details);
const unauthorized = (code = 'UNAUTHENTICATED', message = 'Authentication required') =>
  new AppError(401, code, message);
const forbidden = (code = 'FORBIDDEN', message = 'You are not allowed to perform this operation') =>
  new AppError(403, code, message);
const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
const conflict = (code, message, details) => new AppError(409, code, message, details);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict };
