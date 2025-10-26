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
// Dynamic Buffer Type
// ----------------------------------------------------
type DynBuf = {
  data: Buffer;
  length: number;
};

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
function cutMessage(buf: DynBuf): Buffer | null {
  const idx = buf.data.subarray(0, buf.length).indexOf('\n');
  if (idx < 0) return null;
  const msg = buf.data.subarray(0, idx + 1);
  bufPop(buf, idx + 1);
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
// Handle one client connection asynchronously
// ----------------------------------------------------
async function newConn(conn: TCPConn): Promise<void> {
  console.log("new connection", conn.socket.remoteAddress, conn.socket.remotePort);
  const buf: DynBuf = { data: Buffer.alloc(0), length: 0 };
  try {
    while (true) {
      let msg: null | Buffer = cutMessage(buf);
      if (!msg) {
        const data: Buffer = await soRead(conn);
        console.log("data:", data.toString()); // Log raw data
        if (data.length == 0) break;
        bufPush(buf, data);
        msg = cutMessage(buf);
        if (!msg) continue;
      }
      const str = msg.toString().trim();
      if (str.includes("q")) {
        await soWrite(conn, Buffer.from("Bye.\n"));
        break;  // Exit loop after sending "Bye"
      }
      await soWrite(conn, Buffer.from(`Echo: ${str}\n`));
    }
  } catch (err) {
    console.error("connection error:", err);
  } finally {
    conn.socket.end();                     // Gracefully close socket
    console.log("FIN.");
  }
}

// ----------------------------------------------------
// Create the TCP server
// ----------------------------------------------------
const server = net.createServer({ pauseOnConnect: true });
server.on("connection", (socket) => {
  const conn = soInit(socket);
  newConn(conn).catch(console.error);
});

server.on("listening", () => console.log("Server listening on 127.0.0.1:1234"));
server.on("error", (err) => console.error("Server error:", err));

// ----------------------------------------------------
// Start listening
// ----------------------------------------------------
server.listen({ host: "127.0.0.1", port: 1234 });
