import * as net from "net";

// ----------------------------------------------------
// Type that wraps a socket and stores Promise callbacks
// ----------------------------------------------------
type TCPConn = {
  socket: net.Socket;
  reader: null | {
    resolve: (value: Buffer) => void;
    reject: (reason: Error) => void;
  };
};
// ----------------------------------------------------
// Dynamic Buffer Type
// ----------------------------------------------------
type DynBuf = {
  data: Buffer;
  length: number;
};
// ----------------------------------------------------
// HTTP Request Type
// ----------------------------------------------------
type HTTPReq = {
  method: string,
  uri: Buffer,
  version: string,
  headers: Buffer[]
};
// ----------------------------------------------------
// HTTP Response Type
// ----------------------------------------------------
type HTTPRes = {
  code: number,
  headers: Buffer[],
  body: BodyReader
}
// ----------------------------------------------------
// an interface for reading/writing data from/to the HTTP body
// ----------------------------------------------------
type BodyReader = {
  length: number,
  read: () => Promise<Buffer>
};
// ----------------------------------------------------
// HTTPError type + factory function
// ----------------------------------------------------
type HTTPError = {
  name: "HTTPError";
  code: number;
  message: string;
};

// Factory function to create one
function HTTPError(code: number, message: string): HTTPError {
  return { name: "HTTPError", code, message };
}

// ----------------------------------------------------
// Initialize the TCPConn wrapper and event handlers
// ----------------------------------------------------
function soInit(socket: net.Socket): TCPConn {
  const conn: TCPConn = {
    socket,
    reader: null,
  };

  // Fired when data arrives
  socket.on("data", (data: Buffer) => {
    console.assert(conn.reader);         // Ensure read is pending
    conn.socket.pause();                 // Pause more 'data' events
    conn.reader!.resolve(data);          // Fulfill current read
    conn.reader = null;                  // Clear reader
  });

  // Fired when the client closes connection (EOF)
  socket.on("end", () => {
    if (conn.reader) {
      conn.reader.resolve(Buffer.alloc(0)); // Empty buffer = EOF
      conn.reader = null;
    }
  });

  // Fired on network errors
  socket.on("error", (err: Error) => {
    if (conn.reader) {
      conn.reader.reject(err);
      conn.reader = null;
    }
  });

  return conn;
}

// ----------------------------------------------------
// Read data from the connection as a Promise
// ----------------------------------------------------
function soRead(conn: TCPConn): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    conn.reader = { resolve, reject };  // Store the callbacks
    conn.socket.resume();               // Resume 'data' events
  });
}

// ----------------------------------------------------
// Write data to the connection as a Promise
// ----------------------------------------------------
function soWrite(conn: TCPConn, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.socket.write(data, (err?: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ----------------------------------------------------
// Push data into dynamic buffer and increase its size if needed
// ----------------------------------------------------
function bufPush(buf: DynBuf, data: Buffer): void {
  const newLen = buf.length + data.length;

  if (buf.data.length < newLen) {
    let cap = Math.max(buf.data.length || 32, 32);
    while (cap < newLen) cap *= 2;
    const grown = Buffer.alloc(cap);
    buf.data.copy(grown, 0, 0, buf.length);
    buf.data = grown;
  }

  data.copy(buf.data, buf.length, 0);
  buf.length = newLen;
}

// ----------------------------------------------------
// Cut message from dynamic buffer
// ----------------------------------------------------
// the maximum length of an HTTP header
const kMaxHeaderLen = 1024 * 8;
//parse & remove a header from the beginning of the buffer if possible
function cutMessage(buf: DynBuf): HTTPReq | null {
  const idx = buf.data.subarray(0, buf.length).indexOf('\r\n\r\n');
  if (idx < 0) {
    if (buf.length >= kMaxHeaderLen) {
      throw new HTTPError(413, 'headeristoolarge');
    }
    return null
  };
  const msg = parseHTTPReq(buf.data.subarray(0, idx + 4));
  bufPop(buf, idx + 4);
  return msg;
}

// ----------------------------------------------------
// Pop data from dynamic buffer
// ----------------------------------------------------
function bufPop(buf: DynBuf, len: number): void {
  buf.data.copy(buf.data, 0, len, buf.length);
  buf.length -= len;
}
// ----------------------------------------------------
//parse anHTTPrequestheader
// ----------------------------------------------------
//Split the header data (up to \r\n\r\n) into an array of lines.
function splitLines(data: Buffer): Buffer[] {
  // Split by CRLF, the HTTP standard line ending
  const parts = data.toString().split("\r\n");
  return parts.map((line) => Buffer.from(line));
}
//Extract the three parts of the HTTP request line
function parseRequestLine(line: Buffer): [string, Buffer, string] {
  const parts = line.toString().trim().split(" ");
  if (parts.length !== 3) {
    throw new HTTPError(400, "bad request line");
  }

  const [method, uriStr, version] = parts;

  if (!version.startsWith("HTTP/")) {
    throw new HTTPError(400, "bad version");
  }

  // Leave URI as Buffer (book’s reason: may not be ASCII/UTF-8)
  const uri = Buffer.from(uriStr);

  return [method, uri, version.replace("HTTP/", "")];
}
//basic sanity checks to ensure headers are syntactically valid.
function validateHeader(line: Buffer): boolean {
  const str = line.toString();
  const idx = str.indexOf(":");

  // Must contain a colon not at the start or end
  if (idx <= 0 || idx === str.length - 1) return false;

  // Header name must be printable ASCII (no control chars or spaces)
  const name = str.slice(0, idx);
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) return false;

  return true;
}

function parseHTTPReq(data: Buffer): HTTPReq {
  //split header into lines
  const lines = splitLines(data);
  // first line is Method URI Version
  const [method, uri, version] = parseRequestLine(lines[0]);
  //followed by header fields in key: value format
  const headers: Buffer[] = [];
  for (let i = 1; i < lines.length - 1; i++) {
    const h = Buffer.from(lines[i]);
    if (!validateHeader(h)) {
      throw new HTTPError(400, 'badfield');
    }
    headers.push(h);
  }
  console.assert(lines[lines.length - 1].length === 0);
  return {
    method: method, uri: uri, version: version, headers: headers
  };
}
// ----------------------------------------------------
// Body Reader from an HTTP request
// ----------------------------------------------------
function readerFromReq(conn: TCPConn, buf: DynBuf, req: HTTPReq): BodyReader {
  let bodyLen = -1;
  const contentLen = fieldGet(req.headers, 'Content-length');
  if(contentLen) {
    bodyLen = parseDec(contentLen.toString('latin1'));
    if(isNaN(bodyLen)){
      throw new HTTPError(400, 'badContent-Length.');
    }
  }
  const bodyAllowed = !(req.method == 'GET' || req.method == 'HEAD');
  const chunked = fieldGet(req.headers, 'Transfer-Encoding') ?.equals(Buffer.from('chunked'))|| false;
  if (!bodyAllowed && (bodyLen > 0 || chunked)) {
  throw new HTTPError(400, 'HTTP body not allowed.');
  }
  if (!bodyAllowed) {
    bodyLen =0;
  }
  if (bodyLen >= 0) {
    // "Content-Length" is present
    readerFromConnLength(conn, buf, bodyLen);
  }else if(chunked){
    // chunked encoding we don't handle yet
    throw new HTTPError(501, 'TODO');
  }else{
     //readtherestoftheconnection
     throw new HTTPError(501, 'TODO');
  }
}
function parseDec(str: string): number {
  return parseInt(str, 10);
}
function fieldGet(headers: Buffer[], key: string): Buffer | null {
  const lowerKey = key.toLowerCase();
  for (const h of headers) {
    const str = h.toString('latin1');
    const colon = str.indexOf(':');
    if (colon <= 0) continue;
    const name = str.slice(0, colon).trim().toLowerCase();
    if (name === lowerKey) {
      return Buffer.from(str.slice(colon + 1).trim());
    }
  }
  return null;
}

function readerFromConnLength(conn: TCPConn, buf: DynBuf, remain: number): BodyReader {
  return {
    length: remain,
    read: async (): Promise<Buffer> =>{
      if (remain == 0){
        return Buffer.from(''); //done
      }
      if (buf.length == 0){
        const data = await soRead(conn)
        bufPush(buf, data);
        if (data.length ==0){
          throw new Error('Unexpected EOF from HTTP body');
        }
      }
      //consume data from thhe buffer
      const consume = Math.min(buf.length, remain);
      remain -= consume;
      const data = Buffer.from(buf.data.subarray(0, consume))
      bufPop(buf,consume);
      return data;
    }
  }
}
// ----------------------------------------------------
// Handle one client connection asynchronously
// ----------------------------------------------------
async function serveClient(conn: TCPConn): Promise<void> {
  const buf: DynBuf = { data: Buffer.alloc(0), length: 0 };
  while (true) {
    // try to get 1 request header from the buffer
    let msg: null | HTTPReq = cutMessage(buf);
    if (!msg) {
      // need more data
      const data: Buffer = await soRead(conn);
      bufPush(buf, data);
      // EOF?
      if (data.length == 0 && buf.length == 0) {
        return; // no more requests
      };
      if (data.length == 0) {
        throw new HTTPError(400, "Unexpected EOF."); // generate error and close connection
      }
      // got some data try again
      continue;
    }
  }
}
async function newConn(socket: net.Socket): Promise<void> {
  const conn = soInit(socket);
  try {
    await serveClient(conn)
  }
  catch (exc) {
    console.error('exception: ', exc)
    if (exc instanceof HTTPError) {
      const res: HTTPRes = {
        code: exc.code,
        headers: [],
        body: readerFromMemory(Buffer.from(exc.message + '\n')),
      };
      try {
        await writeHTTPRes(conn, res)
      } catch (exc) { }
    }
  } finally {
    socket.destroy();
  }
}
// ----------------------------------------------------
// Create the TCP server
// ----------------------------------------------------
const server = net.createServer({ pauseOnConnect: true });
server.on("connection", (socket) => {
  const conn = soInit(socket);
  serveClient(conn).catch(console.error);
});

server.on("listening", () => console.log("Server listening on 127.0.0.1:1234"));
server.on("error", (err) => console.error("Server error:", err));

// ----------------------------------------------------
// Start listening
// ----------------------------------------------------
server.listen({ host: "127.0.0.1", port: 1234 });
