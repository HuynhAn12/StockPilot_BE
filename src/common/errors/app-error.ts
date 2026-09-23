export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INSUFFICIENT_STOCK'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details?: any;

  constructor(message: string, statusCode = 500, code: ErrorCode = 'INTERNAL_ERROR', details?: any) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Dữ liệu không hợp lệ', details?: any) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Chưa xác thực hoặc token không hợp lệ') {
    super(message, 401, 'UNAUTHENTICATED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Bạn không có quyền thực hiện hành động này') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Không tìm thấy tài nguyên yêu cầu') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Xung đột dữ liệu hoặc trạng thái không hợp lệ', details?: any) {
    super(message, 409, 'CONFLICT', details);
  }
}

export class InsufficientStockError extends AppError {
  constructor(message = 'Số lượng tồn kho không đủ để thực hiện yêu cầu', details?: any) {
    super(message, 409, 'INSUFFICIENT_STOCK', details);
  }
}
