import * as http from "node:http";

export class Gen3DHostTimeoutError extends Error {
  constructor() {
    super("3D generation host timed out.");
  }
}

export function gen3dHostCall<T>(
  method: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
  timeoutMs = 180_000,
): Promise<T> {
  const socketPath = process.env.AHA_GEN3D_HOST_PIPE,
    token = process.env.AHA_GEN3D_HOST_TOKEN;
  if (!socketPath || !token)
    return Promise.reject(new Error("Local 3D generation requires the Aha desktop host."));
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        path: "/" + method,
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        signal,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
          if (text.length > 1024 * 1024) request.destroy(new Error("Invalid 3D host response."));
        });
        response.on("end", () => {
          try {
            const data = JSON.parse(text);
            if (response.statusCode !== 200 || data.error)
              throw new Error(data.error || "3D generation host request failed.");
            resolve(data as T);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.setTimeout(timeoutMs, () => request.destroy(new Gen3DHostTimeoutError()));
    request.end(JSON.stringify(params));
  });
}
