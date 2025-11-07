# HTTP Server from Scratch

A lightweight HTTP/1.1 server implementation built in Node.js with TypeScript, using only the standard library (no external HTTP frameworks).

## Acknowledgments

Built as an educational project following the book **"Build Your Own Web Server From Scratch"** by James Smith (build-your-own.org).

## Features

- **Pure Node.js Implementation** - Built using only `net`, `fs`, `stream`, and `zlib` modules
- **HTTP/1.1 Support** - Full request/response cycle with persistent connections
- **Static File Serving** - Serve files from the `/files/` route
- **Range Requests** - Partial content delivery (HTTP 206) for resumable downloads
- **Gzip Compression** - Automatic response compression when supported by client
- **Conditional Requests** - `If-Modified-Since` and `If-Range` header support
- **Streaming Responses** - Efficient handling of large files and generated content
- **Connection Management** - Request timeouts and connection pooling

## Getting Started

### Prerequisites

- Node.js (v14 or higher recommended)
- TypeScript

### Installation

```bash
npm install typescript @types/node
```

### Running the Server

```bash
# Compile TypeScript
npx tsc server.ts

# Run the server
node server.js
```

The server will start on `http://127.0.0.1:1234`

## API Endpoints

### `GET /`
Returns a simple "Hello World" message.

```bash
curl http://127.0.0.1:1234/
# Hello World.
```

### `POST /echo`
Echoes back the request body.

```bash
curl -X POST -d "test data" http://127.0.0.1:1234/echo
# test data
```

### `GET /sheep`
Streams a counting response (0-9) with 1 second delays between each number.

```bash
curl http://127.0.0.1:1234/sheep
# 0
# 1
# 2
# ...
```

### `GET /files/<path>`
Serves static files from the filesystem. Supports range requests and conditional headers.

```bash
# Serve a file
curl http://127.0.0.1:1234/files/example.txt

# Range request
curl -H "Range: bytes=0-99" http://127.0.0.1:1234/files/example.txt

# Conditional request
curl -H "If-Modified-Since: Mon, 01 Jan 2024 00:00:00 GMT" http://127.0.0.1:1234/files/example.txt
```

## Technical Details

### Request Processing

1. TCP connection established with pause-on-connect
2. Headers parsed with 8KB limit
3. Request body read based on `Content-Length`
4. Handler processes request and generates response
5. Response written with optional gzip compression
6. Connection kept alive unless `Connection: close` header present

### Range Request Support

The server supports:
- Single range requests: `Range: bytes=0-999`
- Suffix ranges: `Range: bytes=-500` (last 500 bytes)
- Open-ended ranges: `Range: bytes=1000-` (from byte 1000 to end)

Multiple ranges in a single request fall back to full content delivery.

### Compression

Responses are automatically gzip-compressed when:
- Client sends `Accept-Encoding: gzip`
- No range request is present
- Response body is streamable

### Error Handling

The server handles common HTTP errors:
- `400 Bad Request` - Malformed requests
- `404 Not Found` - Missing resources
- `413 Payload Too Large` - Excessive header/body size
- `416 Range Not Satisfiable` - Invalid byte ranges

## Configuration

Key parameters (modify in source):
- `kMaxHeaderLen`: 8KB - Maximum header size
- `kMaxBodyBuffer`: 10MB - Maximum buffered body size
- `requestTimeout`: 60s - Request timeout duration
- `server.maxConnections`: 100 - Maximum concurrent connections

## Architecture

```
TCP Socket → Request Parser → Body Reader → Handler → Response Writer → TCP Socket
                ↓                                          ↓
            DynBuf                                   Compression Filter
```

- **DynBuf**: Dynamic buffer that grows as needed for request parsing
- **BodyReader**: Stream abstraction for request/response bodies
- **Pipeline**: Node.js streams for efficient data transfer

## Development

The codebase is organized into logical sections:
- TCP wrapper functions for socket management
- Dynamic buffer operations for parsing
- HTTP request/response encoding/decoding
- Body reader factories for different content sources
- Static file serving with range support
- Main server loop with error handling
