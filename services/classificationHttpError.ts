import type { Response } from 'express';
export type ClassificationHttpErrorCode = 'invalid_request' | 'reauth_required' | 'invalid_review' | 'forbidden_origin'
  | 'operation_not_found' | 'stale_review' | 'revision_conflict' | 'request_id_conflict' | 'revision_overflow' | 'blocked_decision'
  | 'review_expired' | 'reconciliation_window_expired' | 'review_too_large' | 'request_too_large' | 'unsupported_media_type'
  | 'unavailable' | 'internal_failure' | 'persistence_unknown';
export const sendClassificationHttpError = (res: Response, status: number, code: ClassificationHttpErrorCode,
  persistence: 'not_applied' | 'unknown' = 'not_applied'): void => {
  res.status(status).json({ version: 'classification-http-error-v1', error: { code }, persistence });
};
