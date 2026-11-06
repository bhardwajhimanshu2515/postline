// A tiny fake LinkedIn for end-to-end tests. Records every request it gets.
import http from "node:http";

// 1x1 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export function startMock(port = 9999) {
  const log = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, `http://localhost:${port}`);
    const entry = { method: req.method, path: url.pathname, query: url.search, headers: req.headers, body: raw.toString() };
    log.push(entry);
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const needsAuth = () => req.headers.authorization === "Bearer li-token";

    if (req.method === "POST" && url.pathname === "/oauth/v2/accessToken") {
      const form = new URLSearchParams(raw.toString());
      if (form.get("client_secret") !== "test-secret" || form.get("code") !== "good-code")
        return json(400, { error: "invalid_request", error_description: "bad code" });
      return json(200, { access_token: "li-token", expires_in: 5184000, scope: "email,openid,profile,w_member_social" });
    }
    if (req.method === "GET" && url.pathname === "/v2/userinfo") {
      if (!needsAuth()) return json(401, { message: "Invalid access token" });
      return json(200, { sub: "abc123", name: "Test Member", picture: "https://example.com/p.jpg" });
    }
    if (req.method === "POST" && url.pathname === "/rest/posts") {
      if (!needsAuth()) return json(401, { message: "Invalid access token" });
      if (!req.headers["linkedin-version"] || req.headers["x-restli-protocol-version"] !== "2.0.0")
        return json(400, { message: "missing headers" });
      if (raw.toString().includes("FAIL500")) return json(500, { message: "Internal error" });
      const n = log.filter((e) => e.path === "/rest/posts" && e.method === "POST").length;
      res.writeHead(201, { "x-restli-id": `urn:li:share:70000${n}` });
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/rest/images" && url.searchParams.get("action") === "initializeUpload") {
      return json(200, { value: { uploadUrl: `http://localhost:${port}/upload/1`, image: "urn:li:image:C4E1" } });
    }
    if (req.method === "PUT" && url.pathname === "/upload/1") {
      res.writeHead(201);
      return res.end();
    }
    if (req.method === "GET" && url.pathname.startsWith("/rest/images/")) {
      return json(200, { status: "AVAILABLE" });
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/rest/posts/")) {
      if (decodeURIComponent(url.pathname.slice("/rest/posts/".length)) === "urn:li:share:404") return json(404, { message: "not found" });
      res.writeHead(204);
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/rest/documents" && url.searchParams.get("action") === "initializeUpload") {
      return json(200, { value: { uploadUrl: `http://localhost:${port}/upload/doc`, document: "urn:li:document:D5E1" } });
    }
    if (req.method === "PUT" && url.pathname === "/upload/doc") {
      res.writeHead(201);
      return res.end();
    }
    if (req.method === "GET" && url.pathname.startsWith("/rest/documents/")) {
      return json(200, { status: "AVAILABLE" });
    }
    if (req.method === "GET" && url.pathname === "/deck.pdf") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end("%PDF-1.4\n% fake\n");
    }
    if (req.method === "GET" && url.pathname === "/img.png") {
      res.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
      return res.end(PNG);
    }
    if (req.method === "GET" && url.pathname === "/page.html") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<p>not an image</p>");
    }
    json(404, { message: "mock: no route" });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, log })));
}
