import express from 'express';
import { getHeapStatistics } from 'node:v8';
import { requestContext } from './diagnostics.js';

// Operational admission estimates, not a physical limit or a total file cap.
// Wire strings measured ~9x retained-copy RSS; dense objects need additional
// pre-parse structural accounting. These estimates are not an OOM guarantee.
// Keep half of observed available memory for GC, response work and other tasks.
export const MEMORY_AMPLIFICATION = 32;
export const HEADROOM_FRACTION = 0.5;
// Count JSON structure without creating parsed object graphs. UTF-8 punctuation
// cannot occur inside multibyte code points. Other JSON Unicode encodings are
// decoded only after the wire-byte reservation has been acquired.
export function structuralMemory(buffer, encoding = 'utf-8') {
  const input = /^(utf-8|utf8)$/i.test(encoding) ? buffer : new TextDecoder(encoding).decode(buffer);
  let quoted = false, escaped = false, bytes = 0;
  for (let i = 0; i < input.length; i++) {
    const c = typeof input === 'string' ? input.charCodeAt(i) : input[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === 92) escaped = true;
      else if (c === 34) quoted = false;
    } else if (c === 34) quoted = true;
    else if (c === 123 || c === 91) bytes += 256;
    else if (c === 44) bytes += 32;
  }
  return bytes;
}
export function availableTransportMemory() {
  const available = process.availableMemory();
  return Math.max(0, Math.min(available, getHeapStatistics().total_available_size));
}
export function transportPolicy(requestBytes = defaultAdmission.budget()) {
  return {
    mode: 'resource-admitted-json', requestBytes,
    recommendedChunkBytes: Math.floor(requestBytes / 8),
    totalFileBytes: null, advisory: true,
    memoryAmplification: MEMORY_AMPLIFICATION, headroomFraction: HEADROOM_FRACTION,
    structuralBytesPerContainer: 256, structuralBytesPerComma: 32,
    guidance: 'Request bytes count UTF-8 serialized JSON, not source characters. This budget fluctuates with available memory and concurrency; reduce chunks after 413/503. Chunked file uploads have no application total-size cap. Upstream client limits are unknown.'
  };
}
export function createAdmission({ availableMemory = availableTransportMemory,
  amplification = MEMORY_AMPLIFICATION, headroomFraction = HEADROOM_FRACTION } = {}) {
  if (!(amplification >= 1) || !(headroomFraction > 0 && headroomFraction < 1)) throw new TypeError('Invalid transport admission policy');
  let reserved = 0;
  const budget = () => Math.max(0, Math.floor((Math.max(0, availableMemory()) * headroomFraction - reserved) / amplification));
  const middleware = (req, res, next) => {
    const available = budget();
    res.set('X-Praxis-Request-Budget-Bytes', String(available));
    const policy = transportPolicy(available);
    const context = requestContext.getStore();
    if (context) context.transportPolicy = policy;
    const fail = (status, code, message) => {
      res.set('Retry-After', '1');
      // Do not drain arbitrarily large rejected bodies into memory, or reuse a
      // connection whose request body was not consumed.
      res.set('Connection', 'close');
      res.status(status).json({ ok: false, ...(context?.requestId ? {requestId: context.requestId} : {}), error: { code, message }, transport: policy });
    };
    const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] || 0) > 0;
    if (!hasBody) return next();
    if (!req.is('application/json')) return fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.');
    if (req.headers['content-encoding'] && req.headers['content-encoding'].toLowerCase() !== 'identity')
      return fail(415, 'UNSUPPORTED_CONTENT_ENCODING', 'Compressed JSON is not accepted; send resumable uncompressed chunks.');
    const header = req.headers['content-length'];
    const declared = header === undefined ? undefined : Number(header);
    if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0))
      return fail(400, 'INVALID_ARGUMENT', 'Invalid Content-Length.');
    if (!available) return fail(503, 'TRANSPORT_BUSY', 'Memory headroom is currently reserved. Retry with smaller chunks.');
    if (declared !== undefined && declared > available)
      return fail(413, 'REQUEST_TOO_LARGE', 'Serialized request exceeds current memory admission budget. Use resumable chunks.');
    const limit = declared === undefined ? available : declared;
    let reservation = limit * amplification;
    reserved += reservation;
    let released = false;
    const release = () => {
      if (released) return;
      released = true; reserved -= reservation;
      req.off('aborted', release); res.off('finish', release); res.off('close', release);
    };
    req.once('aborted', release); res.once('finish', release); res.once('close', release);
    express.json({ limit, inflate: false, verify: (_req, _res, buffer, encoding) => {
      // Unknown-length bodies reserved the full parser ceiling while streaming.
      // Once complete, release unused wire capacity before structural admission.
      const actualWireReservation = buffer.length * amplification;
      reserved -= reservation - actualWireReservation;
      reservation = actualWireReservation;
      const extra = structuralMemory(buffer, encoding);
      if (extra > budget() * amplification)
        throw Object.assign(new Error('Insufficient memory headroom for JSON structure'), { status: 413, code: 'RESOURCE_BUDGET' });
      reserved += extra; reservation += extra;
    } })(req, res, error => {
      if (!error) return next();
      if (req.aborted || res.destroyed) { release(); return; }
      if (error.type === 'entity.parse.failed') return next(error);
      if (error.code === 'RESOURCE_BUDGET') return fail(413, 'RESOURCE_BUDGET', 'JSON structure exceeds current memory headroom. Reduce request complexity or use smaller file chunks.');
      fail(error.status || 400, error.type === 'entity.too.large' ? 'REQUEST_TOO_LARGE' : 'INVALID_ARGUMENT',
        error.type === 'entity.too.large' ? 'Serialized request exceeds its admitted budget. Use resumable chunks.' : 'Malformed or unsupported JSON request.');
    });
  };
  return { middleware, budget, get reservedBytes() { return reserved; } };
}
export const defaultAdmission = createAdmission();
export const resourceJson = defaultAdmission.middleware;
export function annotateTransport(data, front = requestContext.getStore()?.transportPolicy) {
  if (!front || !data || typeof data !== 'object') return data;
  const backend = data.transport || data.limits?.transport;
  const bytes = Math.min(front.requestBytes, backend?.requestBytes ?? front.requestBytes);
  const policy = transportPolicy(bytes);
  if (data.limits) return { ...data, limits: { ...data.limits, requestBytes: bytes, transport: policy } };
  return { ...data, transport: policy,
    recommendedChunkBytes: Math.min(data.recommendedChunkBytes ?? policy.recommendedChunkBytes, policy.recommendedChunkBytes) };
}
