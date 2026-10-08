'use strict';
// Wire format shared with Swift (Packages/NodeCore/Sources/NodeCore/Frame.swift).
// Every frame: u32 BE payload length | u8 type | u32 BE channel | payload.
// Channel 0 is the control channel; sessions use channels >= 1 chosen by Swift.

const HEADER = 9;
const MAX_PAYLOAD = 64 * 1024 * 1024;

const T = Object.freeze({
  HELLO: 0x01,    // node -> swift, ch 0, JSON {node, jitless, platform, timings}
  OPEN: 0x02,     // swift -> node, JSON session spec
  DATA: 0x03,     // both ways, raw bytes
  RESIZE: 0x04,   // swift -> node, u16 cols | u16 rows
  SIGNAL: 0x05,   // swift -> node, u8 signal number
  CLOSE: 0x06,    // swift -> node, terminate the session
  EXIT: 0x07,     // node -> swift, JSON {code, signal, error}
  REQUEST: 0x08,  // swift -> node, ch 0, JSON {id, op, ...}
  RESPONSE: 0x09, // node -> swift, ch 0, JSON {id, ok, result | error}
  EVENT: 0x0a,    // node -> swift, JSON {event, ...}
  LOG: 0x0b,      // node -> swift, utf-8 text
});

function encode(type, channel, payload) {
  let body;
  if (payload === undefined || payload === null) body = Buffer.alloc(0);
  else if (Buffer.isBuffer(payload)) body = payload;
  else if (payload instanceof Uint8Array) body = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  else if (typeof payload === 'string') body = Buffer.from(payload, 'utf8');
  else body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (body.length > MAX_PAYLOAD) throw new RangeError(`frame payload ${body.length} exceeds ${MAX_PAYLOAD}`);
  const head = Buffer.allocUnsafe(HEADER);
  head.writeUInt32BE(body.length, 0);
  head.writeUInt8(type, 4);
  head.writeUInt32BE(channel >>> 0, 5);
  return body.length ? Buffer.concat([head, body], HEADER + body.length) : head;
}

// Incremental decoder: push() arbitrary chunks, get back complete frames.
class Decoder {
  constructor() {
    this.chunks = [];
    this.size = 0;
  }

  push(chunk) {
    if (chunk.length) {
      this.chunks.push(chunk);
      this.size += chunk.length;
    }
    const frames = [];
    while (this.size >= HEADER) {
      const head = this._peek(HEADER);
      const len = head.readUInt32BE(0);
      if (len > MAX_PAYLOAD) throw new RangeError(`frame payload ${len} exceeds ${MAX_PAYLOAD}`);
      if (this.size < HEADER + len) break;
      const all = this._take(HEADER + len);
      frames.push({ type: all.readUInt8(4), channel: all.readUInt32BE(5), payload: all.subarray(HEADER) });
    }
    return frames;
  }

  _peek(n) {
    if (this.chunks[0].length >= n) return this.chunks[0];
    const joined = Buffer.concat(this.chunks, this.size);
    this.chunks = [joined];
    return joined;
  }

  _take(n) {
    const first = this._peek(n);
    const out = first.subarray(0, n);
    const rest = first.subarray(n);
    if (rest.length) this.chunks[0] = rest;
    else this.chunks.shift();
    this.size -= n;
    return out;
  }
}

function json(payload) {
  return JSON.parse(payload.toString('utf8'));
}

module.exports = { T, HEADER, MAX_PAYLOAD, encode, Decoder, json };
