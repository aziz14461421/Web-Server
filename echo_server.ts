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
    console.assert(conn.reader);         // must be waiting for read
    conn.socket.pause();                 // pause more 'data' events
    conn.reader!.resolve(data);          // fulfill current read
    conn.reader = null;                  // clear reader
  });

  // Fired when the client closes connection (EOF)
  socket.on("end", () => {
    if (conn.reader) {
      conn.reader.resolve(Buffer.alloc(0)); // empty buffer = EOF
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
  console.assert(!conn.reader); // prevent concurrent reads
  return new Promise((resolve, reject) => {
    conn.reader = { resolve, reject };  // store the callbacks
    conn.socket.resume();               // resume 'data' events
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
// Handle one client connection asynchronously
// ----------------------------------------------------
async function newConn(conn: TCPConn): Promise<void> {
  console.log("new connection", conn.socket.remoteAddress, conn.socket.remotePort);
  try {
    while (true) {
      const data = await soRead(conn);     // wait for incoming data
      if (data.length === 0) break;        // EOF → client closed
      console.log("data:", data.toString());
      await soWrite(conn, data);           // echo back
      if (data.includes("q")) {            // if 'q' received, close
        console.log("closing");
        break;
      }
    }
  } catch (err) {
    console.error("connection error:", err);
  } finally {
    conn.socket.end();                     // gracefully close socket
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

server.on("listening", () => console.log("Server listening on 0.0.0.0:1234"));
server.on("error", (err) => console.error("Server error:", err));

// ----------------------------------------------------
// Start listening
// ----------------------------------------------------
server.listen({ host: "0.0.0.0", port: 1234 });
