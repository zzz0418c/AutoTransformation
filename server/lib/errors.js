/**
 * Errors that are safe to surface to the browser.
 * Anything else is reported as a generic 500.
 */
export class HttpError extends Error {
  constructor(status, message, code = 'bad_request') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export class LlmError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.code = 'llm_error';
  }
}
