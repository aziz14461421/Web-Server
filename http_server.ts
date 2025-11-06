// build-your-own.org
// Node.js + TypeScript – No external HTTP libraries

import * as net from "net";
import * as fs from "fs/promises";

/* ==================== TYPES ==================== */

type TCPConn = {
  socket: net.Socket;
  reader: null | { resolve: (v: Buffer) => void; reject: (e: Error) => void };
};

type DynBuf = { data: Buffer; length: number };

type HTTPReq = { method: string; uri: Buffer; version: string; headers: Buffer[] };
type HTTPRes = { code: number; headers: Buffer[]; body: BodyReader };

type BodyReader = { length: number; read: () => Promise<Buffer>; close?: () => Promise<void> };

class HTTPError extends Error {
  readonly name = "HTTPError" as const;
  constructor(
    public code: number,
    message: string
  ) {
    super(message);
  }
}

type BufferedWriter = {
  write: (data: Buffer) => Promise<void>;
  flush: () => Promise<void>;
  buffer: Buffer;
  length: number;
  conn: TCPConn;
};

type BufferGenerator = AsyncGenerator<Buffer, void, void>;

type HTTPRange = [number, number | null] | number;
/* ==================== INTERFACES ==================== */
interface FileReadResult {
  bytesRead: number;
  buffer: Buffer;
}
interface FileReadOptions {
  buffer?: Buffer;
  offset?: number | null;
  length?: number | null;
  position?: number | null;
}
interface Stats {
  isFile(): boolean;
  isDir(): boolean;
  size: number;
}
interface FileHandle {
  read(options?: FileReadOptions): Promise<FileReadResult>;
  close(): Promise<void>;
  stat(): Promise<Stats>;
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

/* ==================== DYNAMIC WRITE-BUFFER ==================== */
function createBufferedWriter(conn: TCPConn): BufferedWriter {
  const writer: BufferedWriter = {
    conn,
    buffer: Buffer.alloc(4096),
    length: 0,
    async write(data: Buffer): Promise<void> {
      while (data.length !== 0) {
        const free: number = this.buffer.length - this.length;
        // flush and write data if it's larger than the buffer
        if (data.length > this.buffer.length) {
          await this.flush();
          conn.socket.write(data);
          break;
        }
        if (data.length > free) {
          // buffer full empty then push data
          data.copy(this.buffer, this.length, 0, free);
          this.length += free;
          await this.flush();
          data = data.subarray(free);
          continue;
        }
        // buffer can still contain -> push data
        data.copy(this.buffer, this.length);
        this.length += data.length;
        break;
      }
    },
    async flush(): Promise<void> {
      if (this.length > 0) {
        await soWrite(this.conn, this.buffer.subarray(0, this.length));
        this.length = 0;
      }
    }
  };
  return writer;
}
/* ==================== DYNAMIC READ-BUFFER ==================== */

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
  if (idx <= 0 || idx === str.length - 1) {
    return false;
  }
  const name = str.slice(0, idx).trim();
  const valid = /^[!#$%&'*+\-.^_`|~0-9A-Za-z/*]+$/.test(name);
  return valid;
}

function parseHTTPReq(data: Buffer): HTTPReq {
  const lines = splitLines(data);
  const [method, uri, version] = parseRequestLine(lines[0]);
  const headers: Buffer[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].length === 0) break;
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
        await bufExpectMore(conn, buf, "fixed-length body");
      }
      const consume = Math.min(buf.length, remain);
      remain -= consume;
      const chunk = Buffer.from(buf.data.subarray(0, consume));
      bufPop(buf, consume);
      return chunk;
    }
  };
}
/* ==================== HELPER FOR BODY READER ==================== */
async function bufExpectMore(conn: TCPConn, buf: DynBuf, context: string): Promise<void> {
  const data = await soRead(conn);

  // When the client closes the socket (FIN)
  if (data.length === 0) {
    throw new Error(`Unexpected EOF while reading ${context}`);
  }

  bufPush(buf, data);
}

/* ==================== BODY READER (chunked encoding) ==================== */
async function* readChunks(conn: TCPConn, buf: DynBuf): BufferGenerator {
  for (let last = false; !last; ) {
    const idx = buf.data.subarray(0, buf.length).indexOf("\r\n");
    if (idx < 0) {
      await bufExpectMore(conn, buf, "chunk-size line");
      continue;
    }
    const sizeline = buf.data.subarray(0, idx).toString("latin1");
    let remain = parseInt(sizeline, 16);
    bufPop(buf, idx + 2);
    last = remain === 0;
    while (remain > 0) {
      if (buf.length === 0) {
        await bufExpectMore(conn, buf, "chunk-size line");
      }
      const consume = Math.min(remain, buf.length);
      const data = Buffer.from(buf.data.subarray(0, consume));
      bufPop(buf, consume);
      remain -= consume;
      yield data;
    }
    bufPop(buf, 2);
  }
}
/* ==================== RANGE REQUESTS ==================== */
function parseBytesRanges(r: null | Buffer): HTTPRange[] {
  if (!r) return [];
  const str = r.toString("latin1").trim();
  if (!str.startsWith("bytes=")) return [];
  const list = str.slice("bytes=".length).split(",");
  const ranges: HTTPRange[] = [];
  for (const part of list) {
    const [a, b] = part.trim().split("-");
    if (a === "" && b) {
      const suffixLen = parseInt(b, 10);
      if (!isNaN(suffixLen)) ranges.push(-suffixLen);
    } else if (a && b) {
      const start = parseInt(a, 10);
      const end = parseInt(b, 10);
      if (!isNaN(start)) ranges.push([start, isNaN(end) ? null : end]);
    } else if (a && !b) {
      const start = parseInt(a, 10);
      ranges.push([start, null]);
    }
  }
  return ranges;
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
    return readerFromGenerator(readChunks(conn, buf));
  } else {
    throw new HTTPError(501, "unknown body type");
  }
}
/* ==================== RESPONSE HANDLER =============== */
async function handleReq(req: HTTPReq, body: BodyReader): Promise<HTTPRes> {
  let resp: BodyReader;
  const uri = req.uri.toString("latin1");
  if (uri.startsWith("/files/")) {
    return await serveStaticFile(req, uri.substring("/files/".length));
  }
  switch (uri) {
    case "/echo":
      resp = body;
      break;
    case "/sheep":
      resp = readerFromGenerator(countSheep());
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
async function serveStaticFile(req: HTTPReq, path: string): Promise<HTTPRes> {
  let fp: null | fs.FileHandle = null;
  try {
    fp = await fs.open(path, "r");
    const stat = await fp.stat();
    if (!stat.isFile()) {
      return resp404();
    }
    const size = stat.size;
    const res = await staticFileResp(req, fp, size);
    fp = null;
    return res;
  } catch (e) {
    console.info("error serving file ", e);
    return resp404();
  } finally {
    await fp?.close();
  }
}
function resp404(): HTTPRes {
  return {
    code: 404,
    headers: [Buffer.from("Content-Type: text/plain"), Buffer.from("Server: my_first_http_server")],
    body: readerFromMemory(Buffer.from("404 Not Found\n"))
  };
}

function readerFromStaticFile(fp: fs.FileHandle, start: number, end: number): BodyReader {
  const buf = Buffer.allocUnsafe(65536);
  let offset = start;
  return {
    length: end - start,
    read: async (): Promise<Buffer> => {
      const maxread = Math.min(buf.length, end - offset);
      if (maxread <= 0) return Buffer.alloc(0);
      const r = await fp.read({ buffer: buf, position: offset, length: maxread });
      offset += r.bytesRead;
      if (offset > end || (offset < end && r.bytesRead === 0)) {
        throw new Error("filesize changed, abandon it!");
      }
      return r.buffer.subarray(0, r.bytesRead);
    },
    close: async () => await fp.close()
  };
}
function readerFromGenerator(gen: BufferGenerator): BodyReader {
  return {
    length: -1,
    read: async (): Promise<Buffer> => {
      const r = await gen.next();
      if (r.done) {
        return Buffer.from(""); // EOF
      } else {
        console.assert(r.value.length > 0);
        return r.value;
      }
    },
    close: async (): Promise<void> => {
      await gen.return();
    }
  };
}
async function* countSheep(): BufferGenerator {
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    yield Buffer.from(`${i}\n`);
  }
}
function readerFromMemory(data: Buffer): BodyReader {
  let done = false;
  return {
    length: data.length,
    read: async (): Promise<Buffer> => {
      if (done) return Buffer.from("");
      done = true;
      return data;
    }
  };
}
/* ==================== RESPONSE ENCODER/WRITER ==================== */
async function writeHTTPResp(conn: TCPConn, resp: HTTPRes): Promise<void> {
  if (resp.body.length < 0) {
    resp.headers.push(Buffer.from("Transfer-Encoding: chunked"));
  } else {
    resp.headers.push(Buffer.from(`Content-Length: ${resp.body.length}`));
  }
  // write the header
  await soWrite(conn, encodeHTTPResp(resp));
  // write the body 4\r\ndata\r\n
  const crlf = Buffer.from("\r\n");
  for (let last = false; !last; ) {
    let data = await resp.body.read();
    last = data.length === 0;
    // chunked?
    if (resp.body.length < 0) {
      data = Buffer.concat([Buffer.from(data.length.toString(16)), crlf, data, crlf]);
    }
    if (data.length) {
      await soWrite(conn, data);
    }
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

async function staticFileResp(req: HTTPReq, fp: fs.FileHandle, size: number): Promise<HTTPRes> {
  // 1. Parse Range header
  const ranges = parseBytesRanges(fieldGet(req.headers, "Range"));
  if (ranges.length === 0) {
    // No Range → full file
    const reader = readerFromStaticFile(fp, 0, size);
    return {
      code: 200,
      headers: [],
      body: reader
    };
  }

  // 2. Only handle single range
  const r = ranges[0];
  let start = 0,
    end = size;

  if (typeof r === "number") {
    // Suffix range: "-N"
    const suffixLen = -r;
    if (suffixLen <= 0) return resp416(size);
    start = Math.max(size - suffixLen, 0);
  } else {
    // Normal range: "A-B" or "A-"
    start = r[0];
    end = r[1] !== null ? r[1] + 1 : size;
  }

  // 3. Validate range
  if (start >= size || start < 0 || end <= start) {
    return resp416(size);
  }

  // 4. Effective range
  end = Math.min(end, size);
  const length = end - start;

  const reader = readerFromStaticFile(fp, start, end);
  return {
    code: 206,
    headers: [
      Buffer.from("Accept-Ranges: bytes"),
      Buffer.from(`Content-Range: bytes ${start}-${end - 1}/${size}`)
    ],
    body: reader
  };
}
function resp416(size: number): HTTPRes {
  return {
    code: 416,
    headers: [
      Buffer.from(`Content-Range: bytes */${size}`),
      Buffer.from("Content-Type: text/plain")
    ],
    body: readerFromMemory(Buffer.from("Range Not Satisfiable\n"))
  };
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
    const res: HTTPRes = await handleReq(msg, reqBody);
    try {
      await writeHTTPResp(conn, res);
    } finally {
      await res.body.close?.();
    }
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
          body: readerFromMemory(Buffer.from(e.message + "\n"))
        });
      } catch (e) {
        /* Ignore*/
      }
    }
  } finally {
    socket.destroy();
  }
}

/* ==================== SERVER STARTUP ==================== */

const server = net.createServer({ pauseOnConnect: true, noDelay: true });

server.on("connection", socket => {
  newConn(socket).catch(console.error);
});

server.on("listening", () => console.log("Server listening on 127.0.0.1:1234"));
server.on("error", err => console.error("Server error:", err));

server.listen({ host: "127.0.0.1", port: 1234 });
