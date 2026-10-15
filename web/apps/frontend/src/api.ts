import type { AuthResponse } from '@classpulse/shared-types';
let accessToken: string | null = null;
let refreshing: Promise<AuthResponse | null> | null = null;
export const getToken = () => accessToken;
export const setToken = (value: string | null) => { accessToken = value; };
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function refreshAuth(): Promise<AuthResponse | null> {
  if (!refreshing) refreshing = fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' }).then(async response => {
    if (!response.ok) { accessToken = null; return null; }
    const result: AuthResponse = await response.json(); accessToken = result.accessToken; return result;
  }).catch(() => null).finally(() => { refreshing = null; });
  return refreshing;
}
export async function api<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const response = await fetch(`/api${path}`, { ...options, credentials: 'include', headers: {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...options.headers,
  } });
  if (response.status === 401 && retry && !path.startsWith('/auth/')) {
    if (await refreshAuth()) return api<T>(path, options, false);
    window.dispatchEvent(new Event('auth:expired'));
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError(Array.isArray(error.message) ? error.message.join('. ') : error.message || 'Không thể kết nối máy chủ. Vui lòng thử lại.', response.status);
  }
  if (response.status === 204) return undefined as T;
  const body = await response.text();
  return body ? JSON.parse(body) as T : undefined as T;
}
export async function downloadApiFile(path: string, fallbackFilename: string, retry = true): Promise<string> {
  const response = await fetch(`/api${path}`, { credentials: 'include', headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} });
  if (response.status === 401 && retry) {
    if (await refreshAuth()) return downloadApiFile(path, fallbackFilename, false);
    window.dispatchEvent(new Event('auth:expired'));
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError(Array.isArray(error.message) ? error.message.join('. ') : error.message || 'Không thể tải file. Vui lòng thử lại.', response.status);
  }
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] || fallbackFilename;
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return filename;
}
export const json = (method: string, value?: unknown): RequestInit => ({ method, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
/** Multipart upload of one file as field "file"; the browser sets the boundary header itself. */
export async function upload<T>(path: string, file: File, retry = true): Promise<T> {
  const body = new FormData();
  body.append('file', file);
  const response = await fetch(`/api${path}`, { method: 'POST', body, credentials: 'include', headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} });
  if (response.status === 401 && retry) {
    if (await refreshAuth()) return upload<T>(path, file, false);
    window.dispatchEvent(new Event('auth:expired'));
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const message = response.status === 413 ? 'File quá lớn (tối đa 20 MB).' : Array.isArray(error.message) ? error.message.join('. ') : error.message || 'Không thể tải file lên. Vui lòng thử lại.';
    throw new ApiError(message, response.status);
  }
  return response.json() as Promise<T>;
}
