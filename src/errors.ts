export const MESSAGES: Record<string, string> = {
  unauthorized: 'Access denied. The connection info may be out of date; get it again from the server.',
  method_not_allowed: 'This endpoint only accepts POST.',
  too_large: 'The upload is larger than the server allows.',
  bad_request: "The server couldn't read the request.",
  missing_size: "The request didn't say how big the file is.",
  bad_hash_header: 'The X-Content-Hash header is missing or is not a SHA-256 checksum.',
  missing_upload_id: 'The upload address is missing its upload ID.',
  upload_id_not_found_or_used: 'This upload ID is unknown or was already used. Ask for a new upload address.',
  upload_id_expired: 'This upload address has expired. Ask for a new one.',
  size_mismatch: "The number of bytes received didn't match the declared size. Try again.",
  checksum_mismatch: "The bytes received don't match the declared checksum. Try again.",
  upload_not_found: "The uploaded file isn't on the server. Upload it again.",
  hash_mismatch: "The checksum in the commit doesn't match the uploaded file.",
  paired_upload_not_found: "The Live Photo's video isn't on the server. Upload it again.",
  paired_hash_mismatch: "The checksum of the Live Photo's video doesn't match the uploaded file.",
  not_found: "There's nothing at this address.",
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  internal_error: 'Something went wrong on the server. Try again later.',
};

export const errorBody = (code: string): string => (MESSAGES[code] ? `${code}: ${MESSAGES[code]}` : code);

export const fail = (status: number, code: string, headers: Record<string, string> = {}): Response =>
  new Response(errorBody(code), {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  });
