import { NextResponse } from 'next/server';

export function jsonOk<T>(body: T, init?: ResponseInit) {
  return NextResponse.json(body, init);
}

export function jsonError(message: string, status = 500, extra?: Record<string, unknown>) {
  return NextResponse.json(
    { error: message, ...(extra ?? {}) },
    { status },
  );
}

export function jsonUnauthorized(message = 'Unauthorized') {
  return jsonError(message, 401);
}

export function jsonBadRequest(message: string, extra?: Record<string, unknown>) {
  return jsonError(message, 400, extra);
}

export function jsonNotFound(message: string, extra?: Record<string, unknown>) {
  return jsonError(message, 404, extra);
}

export async function parseJsonBody<T>(req: Request): Promise<
  | { ok: true; data: T }
  | { ok: false; response: ReturnType<typeof jsonBadRequest> }
> {
  try {
    return { ok: true, data: await req.json() as T };
  } catch {
    return { ok: false, response: jsonBadRequest('Invalid JSON body') };
  }
}

export async function parseFormBody(req: Request): Promise<
  | { ok: true; data: FormData }
  | { ok: false; response: ReturnType<typeof jsonBadRequest> }
> {
  try {
    return { ok: true, data: await req.formData() };
  } catch {
    return { ok: false, response: jsonBadRequest('Invalid form data') };
  }
}
