import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { ImageGenerationParameters, ImageModel } from "@synara/contracts";

export class ImageApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly upstreamStatus?: number,
    readonly requestId?: string,
  ) {
    super(message);
  }
}
const upstreamErrorCode = (status: number) =>
  status === 401 || status === 403
    ? "authentication_failed"
    : status === 404
      ? "endpoint_not_found"
      : status === 429
        ? "rate_limited"
        : "upstream_error";
export function normalizeImageBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ImageApiError("invalid_base_url", "Base URL is invalid.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ImageApiError(
      "invalid_base_url",
      "Base URL must use HTTP or HTTPS without credentials, query parameters or fragments.",
    );
  return url.toString().replace(/\/+$/u, "");
}
export const imageEndpoint = (base: string, endpoint: string) =>
  `${normalizeImageBaseUrl(base)}/${endpoint}`;
export function imageRequestParameters(
  p: ImageGenerationParameters,
): Record<string, string | number> {
  if (!Number.isInteger(p.n) || p.n < 1 || p.n > 10)
    throw new ImageApiError("invalid_parameters", "Image count must be between 1 and 10.");
  if (p.size && p.size !== "auto" && !/^[1-9]\d{0,4}x[1-9]\d{0,4}$/u.test(p.size))
    throw new ImageApiError("invalid_parameters", "Image dimensions must be positive integers.");
  if (p.background === "transparent" && p.outputFormat !== "png" && p.outputFormat !== "webp")
    throw new ImageApiError("invalid_parameters", "Transparent backgrounds require PNG or WebP.");
  return {
    n: p.n,
    ...(p.size ? { size: p.size } : {}),
    ...(p.quality ? { quality: p.quality } : {}),
    ...(p.outputFormat ? { output_format: p.outputFormat } : {}),
    ...(p.background ? { background: p.background } : {}),
  };
}
export function redactImageError(message: string, key: string): string {
  return (key ? message.replaceAll(key, "[redacted]") : message)
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/gu, "[redacted]")
    .slice(0, 1000);
}
export async function readBoundedBody(response: Response, max: number): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel();
    throw new ImageApiError("response_too_large", "Image response exceeds the size limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > max)
        throw new ImageApiError("response_too_large", "Image response exceeds the size limit.");
      parts.push(next.value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}
async function jsonResponse(
  response: Response,
  key: string,
  max = 192 * 1024 * 1024,
): Promise<Record<string, unknown>> {
  const bytes = await readBoundedBody(response, response.ok ? max : 64 * 1024);
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ImageApiError(
      response.ok ? "invalid_response" : upstreamErrorCode(response.status),
      `Image provider returned invalid JSON (${response.status}).`,
      response.status,
    );
  }
  const body =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  if (!response.ok) {
    const error = body.error as { message?: unknown } | undefined;
    throw new ImageApiError(
      upstreamErrorCode(response.status),
      redactImageError(
        typeof error?.message === "string"
          ? error.message
          : `Image request failed (${response.status}).`,
        key,
      ),
      response.status,
      response.headers.get("x-request-id") ?? undefined,
    );
  }
  return body;
}
const headers = (key: string) => (key ? { Authorization: `Bearer ${key}` } : {});
export async function discoverImageModels(base: string, key: string): Promise<ImageModel[]> {
  const endpoint = imageEndpoint(base, "models");
  const signal = AbortSignal.timeout(15000);
  let body: Record<string, unknown>;
  try {
    const response = await fetch(endpoint, {
      headers: headers(key),
      signal,
      redirect: "error",
    });
    body = await jsonResponse(response, key, 4 * 1024 * 1024);
  } catch (error) {
    if (error instanceof ImageApiError) throw error;
    const timeout = signal.aborted || (error instanceof Error && error.name === "TimeoutError");
    throw new ImageApiError(
      timeout ? "timeout" : "request_failed",
      timeout
        ? "Model discovery timed out after 15 seconds."
        : "Could not connect to image provider for model discovery.",
    );
  }
  if (!Array.isArray(body.data))
    throw new ImageApiError("invalid_response", "Model discovery returned no model list.");
  const seen = new Set<string>();
  const models: ImageModel[] = [];
  for (const value of body.data) {
    if (!value || typeof value !== "object") continue;
    const m = value as Record<string, unknown>;
    if (typeof m.id !== "string" || !m.id.trim() || m.id.length > 256 || seen.has(m.id)) continue;
    seen.add(m.id);
    models.push({
      id: m.id,
      created: typeof m.created === "number" ? m.created : null,
      ownedBy: typeof m.owned_by === "string" ? m.owned_by : null,
      imageHint: /image|dall|flux|diffusion|sdxl|ideogram|imagen/iu.test(m.id),
    });
  }
  return models.toSorted(
    (a, b) => Number(b.imageHint) - Number(a.imageHint) || a.id.localeCompare(b.id),
  );
}
export async function requestImages(input: {
  baseUrl: string;
  key: string;
  model: string;
  prompt: string;
  parameters: ImageGenerationParameters;
  images: readonly Uint8Array[];
  mask?: Uint8Array;
  signal: AbortSignal;
}) {
  const params = imageRequestParameters(input.parameters);
  let body: string | FormData;
  let requestHeaders: Record<string, string> = headers(input.key);
  const edit = input.images.length > 0;
  if (edit) {
    const form = new FormData();
    form.set("model", input.model);
    form.set("prompt", input.prompt);
    for (const [i, bytes] of input.images.entries())
      form.append(
        "image[]",
        new Blob([Uint8Array.from(bytes)], { type: "image/png" }),
        `reference-${i + 1}.png`,
      );
    if (input.mask)
      form.set("mask", new Blob([Uint8Array.from(input.mask)], { type: "image/png" }), "mask.png");
    for (const [k, v] of Object.entries(params)) form.set(k, String(v));
    body = form;
  } else {
    body = JSON.stringify({ model: input.model, prompt: input.prompt, ...params });
    requestHeaders = { ...requestHeaders, "Content-Type": "application/json" };
  }
  const response = await fetch(
    imageEndpoint(input.baseUrl, edit ? "images/edits" : "images/generations"),
    { method: "POST", headers: requestHeaders, body, signal: input.signal, redirect: "error" },
  );
  const payload = await jsonResponse(response, input.key);
  if (!Array.isArray(payload.data) || !payload.data.length)
    throw new ImageApiError("empty_response", "Image provider returned no images.");
  return { payload, requestId: response.headers.get("x-request-id") };
}
// Only explicit provider configuration can address local APIs. Returned image URLs
// never inherit the API credentials and must resolve to public addresses.
export function isPublicImageAddress(address: string): boolean {
  const a = address.toLowerCase();
  if (isIP(a) === 4) {
    const parts = a.split(".").map(Number);
    const x = parts[0]!,
      y = parts[1]!;
    return !(
      x === 0 ||
      x === 10 ||
      x === 127 ||
      x >= 224 ||
      (x === 169 && y === 254) ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && y === 168) ||
      (x === 100 && y >= 64 && y <= 127) ||
      (x === 198 && (y === 18 || y === 19 || y === 51)) ||
      (x === 192 && (y === 0 || y === 2)) ||
      (x === 203 && y === 0)
    );
  }
  return isIP(a) === 6 && /^[23]/u.test(a) && !/^(2001:(0:|db8:)|2002:)/u.test(a);
}
export async function downloadImage(urlValue: string, signal: AbortSignal): Promise<Uint8Array> {
  let url = new URL(urlValue);
  for (let redirect = 0; redirect <= 3; redirect++) {
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new ImageApiError("unsafe_image_url", "Provider returned an unsupported image URL.");
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (!addresses.length || addresses.some((a) => !isPublicImageAddress(a.address)))
      throw new ImageApiError(
        "unsafe_image_url",
        "Provider returned a local or private image URL.",
      );
    // Pin the validated address for this connection; a second DNS lookup could
    // otherwise resolve a public hostname to a private address (DNS rebinding).
    const address = addresses[0]!;
    const response = await new Promise<{
      status: number;
      location?: string | undefined;
      bytes: Uint8Array;
    }>((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          signal,
          agent: false,
          family: isIP(address.address),
          lookup: (_host, _options, callback) =>
            callback(null, address.address, isIP(address.address)),
        },
        (incoming) => {
          const status = incoming.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            incoming.destroy();
            resolve({ status, location: incoming.headers.location, bytes: new Uint8Array() });
            return;
          }
          if (status !== 200) {
            incoming.destroy();
            reject(
              new ImageApiError(
                "image_download_failed",
                `Could not download generated image (${status}).`,
              ),
            );
            return;
          }
          const max = 64 * 1024 * 1024;
          if (Number(incoming.headers["content-length"]) > max) {
            incoming.destroy();
            reject(
              new ImageApiError("response_too_large", "Generated image exceeds the size limit."),
            );
            return;
          }
          const parts: Buffer[] = [];
          let count = 0;
          incoming.on("data", (part: Buffer) => {
            count += part.length;
            if (count > max) {
              incoming.destroy(
                new ImageApiError("response_too_large", "Generated image exceeds the size limit."),
              );
              return;
            }
            parts.push(part);
          });
          incoming.on("end", () => resolve({ status, bytes: Buffer.concat(parts) }));
          incoming.on("error", reject);
        },
      );
      request.on("error", reject);
      request.end();
    });
    if (response.status >= 300 && response.status < 400) {
      if (!response.location) break;
      url = new URL(response.location, url);
      continue;
    }
    return response.bytes;
  }
  throw new ImageApiError("image_download_failed", "Too many image download redirects.");
}
