import * as http from "node:http";

export function modelHostCall<T>(
  method: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const socketPath = process.env.AHA_MODEL3D_HOST_PIPE,
    token = process.env.AHA_MODEL3D_HOST_TOKEN;
  if (!socketPath || !token)
    return Promise.reject(new Error("Local 3D execution requires the Aha desktop host."));
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
          if (text.length > 1024 * 1024) request.destroy(new Error("Invalid model host response."));
        });
        response.on("end", () => {
          try {
            const data = JSON.parse(text);
            if (response.statusCode !== 200 || data.error)
              throw new Error(data.error || "Model host request failed.");
            resolve(data as T);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.setTimeout(180_000, () => request.destroy(new Error("Model host timed out.")));
    request.end(JSON.stringify(params));
  });
}
