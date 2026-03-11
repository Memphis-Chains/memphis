// Security: Request size limits to prevent DoS attacks

import { IncomingMessage } from 'http';

export interface SizeLimits {
  maxBodySize: number; // Max request body size (bytes)
  maxHeaderSize: number; // Max header size (bytes)
  maxUrlLength: number; // Max URL length (bytes)
  maxQueryLength: number; // Max query string length (bytes)
  maxFieldName: number; // Max field name length (bytes)
  maxFieldValue: number; // Max field value length (bytes)
}

/**
 * Default size limits (reasonable for most use cases)
 */
export const DEFAULT_SIZE_LIMITS: SizeLimits = {
  maxBodySize: 10 * 1024 * 1024, // 10MB
  maxHeaderSize: 16 * 1024, // 16KB
  maxUrlLength: 2048, // 2KB
  maxQueryLength: 1024, // 1KB
  maxFieldName: 256, // 256 bytes
  maxFieldValue: 10 * 1024, // 10KB
};

/**
 * Validate request size limits
 */
export class RequestSizeValidator {
  constructor(private limits: SizeLimits = DEFAULT_SIZE_LIMITS) {}

  /**
   * Validate HTTP request size
   */
  validateRequest(req: IncomingMessage): { valid: boolean; reason?: string } {
    // Check URL length
    if (req.url && req.url.length > this.limits.maxUrlLength) {
      return {
        valid: false,
        reason: `URL too long: ${req.url.length} > ${this.limits.maxUrlLength}`,
      };
    }

    // Check query string length
    if (req.url) {
      const queryStart = req.url.indexOf('?');
      if (queryStart !== -1) {
        const queryLength = req.url.length - queryStart;
        if (queryLength > this.limits.maxQueryLength) {
          return {
            valid: false,
            reason: `Query string too long: ${queryLength} > ${this.limits.maxQueryLength}`,
          };
        }
      }
    }

    // Check Content-Length header
    const contentLength = req.headers['content-length'];
    if (contentLength) {
      const length = parseInt(contentLength, 10);
      if (!isNaN(length) && length > this.limits.maxBodySize) {
        return {
          valid: false,
          reason: `Request body too large: ${length} > ${this.limits.maxBodySize}`,
        };
      }
    }

    // Check header size
    const headerSize = this.calculateHeaderSize(req);
    if (headerSize > this.limits.maxHeaderSize) {
      return {
        valid: false,
        reason: `Headers too large: ${headerSize} > ${this.limits.maxHeaderSize}`,
      };
    }

    return { valid: true };
  }

  /**
   * Validate field (form field, JSON key, etc.)
   */
  validateField(name: string, value: unknown): { valid: boolean; reason?: string } {
    // Check field name length
    if (name.length > this.limits.maxFieldName) {
      return {
        valid: false,
        reason: `Field name too long: ${name.length} > ${this.limits.maxFieldName}`,
      };
    }

    // Check field value length (if string)
    if (typeof value === 'string' && value.length > this.limits.maxFieldValue) {
      return {
        valid: false,
        reason: `Field value too long: ${value.length} > ${this.limits.maxFieldValue}`,
      };
    }

    return { valid: true };
  }

  /**
   * Calculate approximate header size
   */
  private calculateHeaderSize(req: IncomingMessage): number {
    let size = 0;

    for (const [name, value] of Object.entries(req.headers)) {
      size += name.length;
      if (Array.isArray(value)) {
        size += value.join('').length;
      } else if (value) {
        size += value.length;
      }
    }

    return size;
  }
}

/**
 * Create request size validator middleware
 */
export function createSizeValidator(limits?: Partial<SizeLimits>) {
  const validator = new RequestSizeValidator({ ...DEFAULT_SIZE_LIMITS, ...limits });

  return (
    req: IncomingMessage,
    res: { statusCode: number; end: (body?: string) => void },
    next: () => void,
  ) => {
    const result = validator.validateRequest(req);

    if (!result.valid) {
      res.statusCode = 413; // Payload Too Large
      res.end(JSON.stringify({ error: result.reason }));
      return;
    }

    next();
  };
}
