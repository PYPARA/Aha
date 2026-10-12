import http from "node:http";
import sharp from "sharp";
const requests = [];
const escape = (s) => s.replace(/[<>&"']/g, "");
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/status") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(requests));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            { id: "gpt-image-mock", owned_by: "local-mock" },
            { id: "gpt-image-second" },
            { id: "text-mock" },
          ],
        }),
      );
      return;
    }
    const parts = [];
    for await (const part of req) parts.push(part);
    const bytes = Buffer.concat(parts);
    const text = bytes.toString();
    const isEdit = req.url === "/v1/images/edits";
    const contentType = req.headers["content-type"] ?? "";
    if (
      req.method !== "POST" ||
      !["/v1/images/generations", "/v1/images/edits"].includes(req.url)
    ) {
      res.writeHead(404);
      res.end('{"error":{"message":"Path not found"}}');
      return;
    }
    const body = contentType.includes("application/json") ? JSON.parse(text) : {};
    const getField = (name) =>
      new RegExp('name="' + name + '"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--').exec(text)?.[1];
    const prompt = body.prompt ?? getField("prompt") ?? "Mock illustration",
      n = Number(body.n ?? getField("n") ?? 1);
    const entry = {
      path: req.url,
      type: contentType,
      n,
      model: body.model ?? getField("model"),
      prompt,
      parameters: Object.fromEntries(
        ["size", "quality", "output_format", "background"].flatMap((key) => {
          const value = body[key] ?? getField(key);
          return value === undefined ? [] : [[key, value]];
        }),
      ),
      hasMask: text.includes('name="mask"'),
      referenceCount: (text.match(/name="image\[\]"/g) ?? []).length,
    };
    requests.push(entry);
    if (prompt.includes("MOCK_FAIL")) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end('{"error":{"message":"Mock rate limit — no automatic retry"}}');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, prompt.includes("MOCK_SLOW") ? 15000 : 300));
    const data = [];
    for (let i = 0; i < n; i++) {
      const color = isEdit ? "#bc7a48" : "#247e88";
      const svg = `<svg width="768" height="768" xmlns="http://www.w3.org/2000/svg"><rect width="768" height="768" fill="#f4eee4"/><circle cx="384" cy="315" r="225" fill="${color}"/><path d="M0 615L270 380L490 585L768 345V768H0Z" fill="#193f46"/><circle cx="514" cy="177" r="63" fill="#f6d599"/><text x="42" y="700" font-size="26" font-family="Arial" fill="white">${escape(prompt).slice(0, 40)}</text><text x="42" y="740" font-size="17" font-family="Arial" fill="#b5c9c6">LOCAL MOCK · ${isEdit ? "EDIT" : "GENERATE"} · ${i + 1}</text></svg>`;
      const png = await sharp(Buffer.from(svg)).png().toBuffer();
      data.push({ b64_json: png.toString("base64"), revised_prompt: prompt });
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "x-request-id": "mock-" + requests.length,
    });
    res.end(JSON.stringify({ data, size: "768x768", usage: { total_tokens: 0 } }));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(error) } }));
  }
});
server.listen(Number(process.env.AHA_DRAWING_MOCK_PORT ?? 5798), "127.0.0.1", () =>
  console.log("Drawing mock http://127.0.0.1:5798/v1"),
);
