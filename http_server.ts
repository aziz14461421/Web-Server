// build-your-own.org
// Node.js + TypeScript – No external HTTP libraries

import * as net from "net";

/* ==================== TYPES ==================== */

type TCPConn = {
  socket: net.Socket;
  reader: null | { resolve: (v: Buffer) => void; reject: (e: Error) => void };
};

type DynBuf = { data: Buffer; length: number };

type HTTPReq = { method: string; uri: Buffer; version: string; headers: Buffer[] };
type HTTPRes = { code: number; headers: Buffer[]; body: BodyReader };

type BodyReader = { length: number; read: () => Promise<Buffer> };

class HTTPError extends Error {
  readonly name = "HTTPError" as const;
  constructor(public code: number, message: string) {
    super(message);
  }
}

/* ==================== TCP WRAPPER ==================== */

function soInit(socket: net.Socket): TCPConn {
  const conn: TCPConn = { socket, reader: null };

  socket.on("data", data => {
    console.assert(conn.reader);
    conn.socket.pause();
    conn.reader!.resolve(data);
    conn.reader = null;
  });

  socket.on("end", () => {
    if (conn.reader) {
      conn.reader.resolve(Buffer.alloc(0));
      conn.reader = null;
    }
  });

  socket.on("error", err => {
    if (conn.reader) {
      conn.reader.reject(err);
      conn.reader = null;
    }
  });

  return conn;
}

function soRead(conn: TCPConn): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    conn.reader = { resolve, reject };
    conn.socket.resume();
  });
}

function soWrite(conn: TCPConn, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.socket.write(data, err => (err ? reject(err) : resolve()));
  });
}

/* ==================== DYNAMIC BUFFER ==================== */

function bufPush(buf: DynBuf, data: Buffer): void {
  const newLen = buf.length + data.length;
  if (buf.data.length < newLen) {
    let cap = Math.max(buf.data.length || 32, 32);
    while (cap < newLen) cap *= 2;
    const grown = Buffer.alloc(cap);
    buf.data.copy(grown, 0, 0, buf.length);
    buf.data = grown;
  }
  data.copy(buf.data, buf.length);
  buf.length = newLen;
}

function bufPop(buf: DynBuf, len: number): void {
  buf.data.copy(buf.data, 0, len, buf.length);
  buf.length -= len;
}

/* ==================== HEADER PARSING ==================== */

const kMaxHeaderLen = 8 * 1024; // 8 KB
function cutMessage(buf: DynBuf): HTTPReq | null {
  const view = buf.data.subarray(0, buf.length);
  const idx = view.indexOf("\r\n\r\n");
  if (idx < 0) {
    if (buf.length >= kMaxHeaderLen) throw new HTTPError(413, "header too large");
    return null;
  }
  const msg = parseHTTPReq(view.subarray(0, idx + 4));
  bufPop(buf, idx + 4);
  return msg;
}

function splitLines(data: Buffer): Buffer[] {
  return data
    .toString()
    .split("\r\n")
    .map(s => Buffer.from(s));
}

function parseRequestLine(line: Buffer): [string, Buffer, string] {
  const parts = line.toString().trim().split(" ");
  if (parts.length !== 3) throw new HTTPError(400, "bad request line");
  const [method, uriStr, version] = parts;
  if (!version.startsWith("HTTP/")) throw new HTTPError(400, "bad version");
  return [method, Buffer.from(uriStr), version.slice(5)];
}

function validateHeader(line: Buffer): boolean {
  const str = line.toString();
  const idx = str.indexOf(":");
  if (idx <= 0 || idx === str.length - 1) return false;
  const name = str.slice(0, idx);
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
}

function parseHTTPReq(data: Buffer): HTTPReq {
  const lines = splitLines(data);
  const [method, uri, version] = parseRequestLine(lines[0]);
  const headers: Buffer[] = [];
  for (let i = 1; i < lines.length - 1; i++) {
    const h = Buffer.from(lines[i]);
    if (!validateHeader(h)) throw new HTTPError(400, "bad field");
    headers.push(h);
  }
  console.assert(lines[lines.length - 1].length === 0);
  return { method, uri, version, headers };
}

/* ==================== HEADER LOOKUP ==================== */

function fieldGet(headers: Buffer[], key: string): Buffer | null {
  const lower = key.toLowerCase();
  for (const h of headers) {
    const str = h.toString("latin1");
    const colon = str.indexOf(":");
    if (colon <= 0) continue;
    const name = str.slice(0, colon).trim().toLowerCase();
    if (name === lower) return Buffer.from(str.slice(colon + 1).trim());
  }
  return null;
}

function parseDec(str: string): number {
  return parseInt(str, 10);
}

/* ==================== BODY READER (Content-Length) ==================== */

function readerFromConLength(conn: TCPConn, buf: DynBuf, remain: number): BodyReader {
  return {
    length: remain,
    read: async (): Promise<Buffer> => {
      if (remain === 0) return Buffer.from("");
      if (buf.length === 0) {
        const data = await soRead(conn);
        bufPush(buf, data);
        if (data.length === 0) throw new Error("Unexpected EOF in body");
      }
      const consume = Math.min(buf.length, remain);
      remain -= consume;
      const chunk = Buffer.from(buf.data.subarray(0, consume));
      bufPop(buf, consume);
      return chunk;
    }
  };
}

/* ==================== BODY READER FACTORY ==================== */

function readerFromReq(conn: TCPConn, buf: DynBuf, req: HTTPReq): BodyReader {
  let bodyLen = -1;
  const cl = fieldGet(req.headers, "Content-Length");
  if (cl) {
    bodyLen = parseDec(cl.toString("latin1"));
    if (isNaN(bodyLen)) throw new HTTPError(400, "bad Content-Length");
  }

  const bodyAllowed = !(req.method === "GET" || req.method === "HEAD");
  const chunked =
    fieldGet(req.headers, "Transfer-Encoding")?.equals(Buffer.from("chunked")) ?? false;

  if (!bodyAllowed && (bodyLen > 0 || chunked)) {
    throw new HTTPError(400, "HTTP body not allowed");
  }
  if (!bodyAllowed) bodyLen = 0;

  if (bodyLen >= 0) {
    return readerFromConLength(conn, buf, bodyLen);
  } else if (chunked) {
    throw new HTTPError(501, "chunked not implemented");
  } else {
    throw new HTTPError(501, "unknown body type");
  }
}
/* ==================== RESPONSE HANDLER =============== */
async function HandleReq(req: HTTPReq, body: BodyReader): Promise<HTTPRes> {
  let resp: BodyReader; // body
  switch (req.uri.toString("latin1")) {
    case "/echo":
      resp = body;
      break;
    default:
      resp = readerFromMemory(Buffer.from("Hello World.\n"));
      break;
  }
  return {
    code: 200,
    headers: [Buffer.from("Server:my_first_http_server")],
    body: resp
  };
}

function readerFromMemory(data: Buffer): BodyReader {
  let done = false;
  return {
    length: data.length,
    read: async (): Promise<Buffer> => {
      if (done) Buffer.from("");
      done = true;
      return data;
    }
  };
}
/* ==================== RESPONSE ENCODER/WRITER ==================== */
async function writeHTTPResp(conn: TCPConn, resp: HTTPRes): Promise<void> {
  if (resp.body.length < 0) throw new Error("TODO: chunked encoding");
  resp.headers.push(Buffer.from(`Content-Length: ${resp.body.length}`));
  // write the header
  await soWrite(conn, encodeHTTPResp(resp));
  // write the body
  while (true) {
    const data: Buffer = await resp.body.read();
    if (data.length === 0) break;
    await soWrite(conn, data);
  }
}
function encodeHTTPResp(res: HTTPRes): Buffer {
  const statusLine = `HTTP/1.1 ${res.code} OK\r\n`;
  const parts: string[] = [statusLine];

  for (const h of res.headers) {
    parts.push(h.toString("latin1") + "\r\n");
  }

  parts.push("\r\n");
  return Buffer.from(parts.join(""));
}
/* ==================== SERVER LOOP ==================== */

async function serveClient(conn: TCPConn): Promise<void> {
  const buf: DynBuf = { data: Buffer.alloc(0), length: 0 };
  while (true) {
    const msg = cutMessage(buf);
    if (!msg) {
      const data = await soRead(conn);
      bufPush(buf, data);
      if (data.length === 0 && buf.length === 0) return;
      if (data.length === 0) throw new HTTPError(400, "Unexpected EOF");
      continue;
    }
    const reqBody: BodyReader = readerFromReq(conn, buf, msg);
    const res: HTTPRes = await HandleReq(msg, reqBody);
  }
}

async function newConn(socket: net.Socket): Promise<void> {
  const conn = soInit(socket);
  try {
    await serveClient(conn);
  } catch (e: unknown) {
    console.error("exception:", e);
    if (e instanceof HTTPError) {
      try {
        await writeHTTPResp(conn, {
          code: e.code,
          headers: [],
          body: readerFromMemory(Buffer.from(e.message + "\n")),
        });
      } catch (e) {/* Ignore*/}
    }
  } finally {
    socket.destroy();
  }
}

/* ==================== SERVER STARTUP ==================== */

const server = net.createServer({ pauseOnConnect: true });

server.on("connection", socket => {
  newConn(socket).catch(console.error);
});

server.on("listening", () => console.log("Server listening on 127.0.0.1:1234"));
server.on("error", err => console.error("Server error:", err));

server.listen({ host: "127.0.0.1", port: 1234 });
