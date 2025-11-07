// build-your-own.org
// Node.js + TypeScript – No external HTTP libraries

import * as net from "net";
import * as fs from "fs/promises";
import * as stream from "stream";
import { pipeline } from "stream/promises";
import * as zlib from "zlib";

/* ==================== TYPES ==================== */

type TCPConn = {
  socket: net.Socket;
  reader: null | { resolve: (v: Buffer) => void; reject: (e: Error) => void };
};

type DynBuf = { data: Buffer; length: number };

type HTTPReq = { method: string; uri: Buffer; version: string; headers: Buffer[] };
type HTTPRes = { code: number; headers: Buffer[]; body: BodyReader };

type BodyReader = { length: number; reader: stream.Readable };

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
  mtime: Date;
}
interface FileHandle {
  read(options?: FileReadOptions): Promise<FileReadResult>;
  close(): Promise<void>;
  stat(): Promise<Stats>;
  createReadStream?(options?: { start: number; end: number }): stream.Readable;
}

/* ==================== TCP WRAPPER ==================== */

function soInit(socket: net.Socket): TCPConn {
  const conn: TCPConn = { socket, reader: null };
  socket.on("error", err => {
    if (conn.reader) {
      conn.reader.reject(err);
      conn.reader = null;
    }
  });

  socket.on("end", () => {
    if (conn.reader) {
      conn.reader.resolve(Buffer.alloc(0));
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

const kMaxHeaderLen = 8 * 1024;
const kMaxBodyBuffer = 10 * 1024 * 1024;

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

function fieldGetList(headers: Buffer[], key: string): string[] {
  const v = fieldGet(headers, key);
  if (!v) return [];
  return v
    .toString("latin1")
    .split(",")
    .map(s => s.split(";")[0].trim().toLowerCase())
    .filter(s => s.length > 0);
}

/* ==================== BODY READERS  ==================== */
async function readBodyWithLength(conn: TCPConn, buf: DynBuf, length: number): Promise<Buffer> {
  if (false) {
    throw new HTTPError(413, "body too large");
  }

  while (buf.length < length) {
    const chunk = await soRead(conn);
    if (chunk.length === 0) {
      throw new HTTPError(400, "unexpected EOF reading body");
    }
    bufPush(buf, chunk);
  }

  const body = buf.data.subarray(0, length);
  bufPop(buf, length);
  return Buffer.from(body);
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
  const bodyAllowed = !(req.method === "GET" || req.method === "HEAD");
  if (!bodyAllowed) {
    return { length: 0, reader: stream.Readable.from([]) };
  }
  const contentLengthHeader = fieldGet(req.headers, "Content-Length");
  if (contentLengthHeader) {
    const length = parseDec(contentLengthHeader.toString());
    if (isNaN(length) || length < 0) {
      throw new HTTPError(400, "invalid Content-Length");
    }
    const bodyPromise = readBodyWithLength(conn, buf, length);
    const readable = stream.Readable.from(
      (async function* () {
        const body = await bodyPromise;
        yield body;
      })()
    );
    return { length, reader: readable };
  }

  return { length: 0, reader: stream.Readable.from([]) };
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
    if (fp) await fp.close();
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
  if (typeof (fp as any).createReadStream === "function") {
    const reader = (fp as any).createReadStream({ start, end: end - 1 });
    return {
      length: end - start,
      reader
    };
  }

  const chunkSize = 64 * 1024;
  let position = start;

  const readable = new stream.Readable({
    async read() {
      try {
        if (position >= end) {
          this.push(null);
          return;
        }

        const toRead = Math.min(chunkSize, end - position);
        const buffer = Buffer.alloc(toRead);
        const result = await fp.read({
          buffer,
          offset: 0,
          length: toRead,
          position
        });

        position += result.bytesRead;

        if (result.bytesRead === 0) {
          this.push(null);
        } else {
          this.push(result.buffer.subarray(0, result.bytesRead));
        }
      } catch (err) {
        this.destroy(err as Error);
      }
    }
  });

  return {
    length: end - start,
    reader: readable
  };
}

function readerFromGenerator(gen: BufferGenerator): BodyReader {
  return {
    length: -1,
    reader: stream.Readable.from(gen)
  };
}

async function* countSheep(): BufferGenerator {
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    yield Buffer.from(`${i}\n`);
  }
}

function readerFromMemory(data: Buffer): BodyReader {
  return {
    length: data.length,
    reader: streamFromBuffer(data)
  };
}

function streamFromBuffer(data: Buffer): stream.Readable {
  return stream.Readable.from([data]);
}

function gzipFilter(reader: BodyReader): BodyReader {
  const gz = zlib.createGzip();
  pipeline(reader.reader, gz).catch(err => {
    console.error("Gzip pipeline error:", err);
    gz.destroy(err);
  });
  return {
    length: -1,
    reader: gz
  };
}

/* ==================== RESPONSE ENCODER/WRITER ==================== */
async function writeHTTPResp(conn: TCPConn, resp: HTTPRes): Promise<void> {
  if (resp.body.length >= 0) {
    resp.headers.push(Buffer.from(`Content-Length: ${resp.body.length}`));
  }

  await soWrite(conn, encodeHTTPResp(resp));

  try {
    await pipeline(resp.body.reader, conn.socket, { end: false });
  } catch (err) {
    console.error("Response pipeline error:", err);
    throw err;
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
  const stat = await fp.stat();
  const ts = Math.floor(stat.mtime.getTime() / 1000);
  const lastModStr = stat.mtime.toUTCString();
  const baseHeaders: Buffer[] = [
    Buffer.from("Accept-Ranges: bytes"),
    Buffer.from(`Last-Modified: ${lastModStr}`)
  ];

  const ifm = fieldGet(req.headers, "If-Modified-Since");
  if (ifm) {
    const ifmTime = Date.parse(ifm.toString("latin1")) / 1000;
    if (!isNaN(ifmTime) && ifmTime === ts) {
      const empty = readerFromMemory(Buffer.from(""));
      return { code: 304, headers: baseHeaders, body: empty };
    }
  }

  let hrange = fieldGet(req.headers, "Range");
  const ifr = fieldGet(req.headers, "If-Range");
  if (ifr) {
    const ifrTime = Date.parse(ifr.toString("latin1")) / 1000;
    if (isNaN(ifrTime) || ifrTime !== ts) {
      hrange = null;
    }
  }

  const ranges = parseBytesRanges(hrange);

  if (ranges.length === 0) {
    const reader = readerFromStaticFile(fp, 0, size);
    return {
      code: 200,
      headers: baseHeaders,
      body: reader
    };
  }

  if (ranges.length > 1) {
    const reader = readerFromStaticFile(fp, 0, size);
    return {
      code: 200,
      headers: baseHeaders,
      body: reader
    };
  }

  const r = ranges[0];
  let start = 0,
    end = size;
  if (typeof r === "number") {
    const suffixLen = -r;
    if (suffixLen <= 0) return resp416(size);
    start = Math.max(size - suffixLen, 0);
  } else {
    start = r[0];
    end = r[1] !== null ? r[1] + 1 : size;
  }

  if (start >= size || start < 0 || end <= start) {
    return resp416(size);
  }

  end = Math.min(end, size);
  const reader = readerFromStaticFile(fp, start, end);
  const headers = [...baseHeaders, Buffer.from(`Content-Range: bytes ${start}-${end - 1}/${size}`)];
  return {
    code: 206,
    headers,
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

function enableCompression(req: HTTPReq, res: HTTPRes): void {
  res.headers.push(Buffer.from("Vary: Accept-Encoding"));
  if (fieldGet(req.headers, "Range")) {
    return;
  }

  const codecs = fieldGetList(req.headers, "Accept-Encoding");
  if (!codecs.includes("gzip")) {
    return;
  }

  res.headers.push(Buffer.from("Content-Encoding: gzip"));
  res.body = gzipFilter(res.body);
}

/* ==================== SERVER LOOP ==================== */

async function serveClient(conn: TCPConn): Promise<void> {
  const buf: DynBuf = { data: Buffer.alloc(0), length: 0 };


  const requestTimeout = 60000;

  while (true) {
    let msg: HTTPReq | null = null;
    try {
      msg = cutMessage(buf);
    } catch (e) {
      if (e instanceof HTTPError) throw e;
      throw new HTTPError(400, "Invalid request");
    }

    while (!msg) {
      const chunk = await Promise.race([
        new Promise<Buffer>((resolve, reject) => {
          conn.socket.once("data", resolve);
          conn.socket.once("error", reject);
          conn.socket.resume();
        }),
        new Promise<Buffer>((_, reject) =>
          setTimeout(() => reject(new Error("Request timeout")), requestTimeout)
        )
      ]);

      if (chunk.length === 0) return;

      bufPush(buf, chunk);
      if (buf.length > kMaxHeaderLen + kMaxBodyBuffer) {
        throw new HTTPError(413, "request too large");
      }

      msg = cutMessage(buf);
    }

    const reqBody: BodyReader = readerFromReq(conn, buf, msg);
    const res: HTTPRes = await handleReq(msg, reqBody);

    try {
      enableCompression(msg, res);
      await writeHTTPResp(conn, res);
    } catch (err) {
      console.error("Error writing response:", err);
      throw err;
    } finally {
      if (res.body.reader.destroy) {
        res.body.reader.destroy();
      }
    }

    const connection = fieldGet(msg.headers, "Connection");
    if (connection && connection.toString().toLowerCase() === "close") {
      return;
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
      } catch (writeErr) {
        console.error("Failed to write error response:", writeErr);
      }
    }
  } finally {
    socket.destroy();
  }
}

/* ==================== SERVER STARTUP ==================== */

const server = net.createServer({ pauseOnConnect: true, noDelay: true });

server.maxConnections = 100;
server.on("connection", socket => {
  socket.setMaxListeners(20);
  newConn(socket).catch(console.error);
});

server.on("listening", () => console.log("Server listening on 127.0.0.1:1234"));
server.on("error", err => console.error("Server error:", err));

server.listen({ host: "127.0.0.1", port: 1234 });
