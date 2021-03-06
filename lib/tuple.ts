// This file implements the tuple layer. More details are here:
// https://apple.github.io/foundationdb/data-modeling.html#tuples
//
// And the typecodes are here:
// https://github.com/apple/foundationdb/blob/master/design/tuple.md
// 
// This code supports:
// - null, true, false
// - integers
// - byte string
// - unicode string
// - float, double
// - uuid
// 
// It does not support:
// - arbitrary-precision decimals
// - 64 bit IDs
// - versionstamps
// - user type codes
// - int values outside the safe zone of 53 bits
//
// Note that this library canonicalizes some values by default. All numbers
// are encoded to / from javascript double precision numbers. If you want to
// encode a single precision float, wrap it as {type: 'float, value: 123}. If
// you want to preserve exact byte encodings of inputs, pass `true` as the
// final argument to decode.

import assert = require('assert')

const numByteLen = (num: number) => {
  let max = 1
  for (let i = 0; i <= 8; i++) {
    if (num < max) return i
    max *= 256
  }
  throw Error('Number too big for encoding')
}

enum Code {
  Null = 0,
  Bytes = 1,
  String = 2,
  Nested = 0x5,
  IntZero = 0x14,
  PosIntEnd = 0x1c,
  NegIntStart = 0x0c,
  Float = 0x20,
  Double = 0x21,
  False = 0x26,
  True = 0x27,
  UUID = 0x30,
}

// Supported tuple item types.
// This awkwardness brougth to you by:
// https://github.com/unional/typescript-guidelines/blob/master/pages/advance-types/recursive-types.md
export type TupleItem = null | Buffer | string | TupleArr | number | boolean | {
  type: 'uuid', value: Buffer
} | {
  // This is flattened into a double during decoding if noCanonicalize is
  // true. NaN has multiple binary encodings and node normalizes NaN to a
  // single binary layout. To preserve the binary representation of NaNs
  // across encoding / decoding, we'll store the original NaN encoding on the
  // object. This is needed for the binding tester to pass.
  type: 'float', value: number, rawEncoding?: Buffer, // Encoding used for NaN
} | {
  // As above, although this is only used for noCanonicalize + NaN value.
  type: 'double', value: number, rawEncoding?: Buffer,
}

export interface TupleArr extends Array<TupleItem> {}


const nullByte = Buffer.from('00', 'hex')
const falseByte = Buffer.from('26', 'hex')
const trueByte = Buffer.from('27', 'hex')

const findNullBytes = (buf: Buffer, pos: number, searchForTerminators: boolean = false) => {
  var nullBytes = [];

  var found;
  for (pos; pos < buf.length; ++pos) {
    if (searchForTerminators && found && buf[pos] !== 255) {
      break;
    }

    found = false
    if (buf[pos] === 0) {
      found = true
      nullBytes.push(pos)
    }
  }

  if (!found && searchForTerminators) {
    nullBytes.push(buf.length)
  }

  return nullBytes
}

class BufferBuilder {
  storage: Buffer
  used: number = 0

  constructor(capacity: number = 64) {
    this.storage = Buffer.alloc(capacity)
  }

  make() {
    const result = Buffer.alloc(this.used)
    this.storage.copy(result, 0, 0, this.used)
    return result
  }

  need(numBytes: number) {
    if (this.storage.length < this.used + numBytes) {
      let newAmt = this.storage.length
      while (newAmt < this.used + numBytes) newAmt *= 2
      const newStorage = Buffer.alloc(newAmt)
      this.storage.copy(newStorage)
      this.storage = newStorage
    }
  }

  appendByte(val: number) { this.need(1); this.storage[this.used++] = val }

  appendString(val: string) {
    const len = Buffer.byteLength(val)
    this.need(len)
    this.storage.write(val, this.used)
    this.used += len
  }

  appendBuffer(val: Buffer) {
    this.need(val.length)
    val.copy(this.storage, this.used)
    this.used += val.length
  }
}

const adjustFloat = (data: Buffer, isEncode: boolean) => {
  if((isEncode && (data[0] & 0x80) === 0x80) || (!isEncode && (data[0] & 0x80) === 0x00)) {
    for(var i = 0; i < data.length; i++) {
      data[i] = ~data[i]
    }
  } else data[0] ^= 0x80
  return data
}

const encode = (into: BufferBuilder, item: TupleItem) => {
  if (item === undefined) throw new TypeError('Packed element cannot be undefined')
  else if (item === null) into.appendByte(Code.Null)
  else if (item === false) into.appendByte(Code.False)
  else if (item === true) into.appendByte(Code.True)
  else if (Buffer.isBuffer(item) || typeof item === 'string') {
    let isString: boolean
    let itemBuf: Buffer

    if (typeof item === 'string') {
      itemBuf = Buffer.from(item, 'utf8')
      into.appendByte(Code.String)
    } else {
      itemBuf = item
      into.appendByte(Code.Bytes)
    }

    for (let i = 0; i < itemBuf.length; i++) {
      const val = itemBuf.readUInt8(i)
      into.appendByte(val)
      if (val === 0) into.appendByte(0xff)
    }
    into.appendByte(0)

  } else if (Array.isArray(item)) {
    into.appendByte(Code.Nested)
    for (let i = 0; i < item.length; i++) {
      encode(into, item[i])
      if (item[i] == null) into.appendByte(0xff)
    }
    into.appendByte(0)

  } else if (typeof item === 'number' && Number.isSafeInteger(item) && !Object.is(item, -0)) {
    const isNegative = item < 0
    let absItem = Math.abs(item)
    let byteLen = numByteLen(absItem)
    into.need(1 + byteLen)

    into.appendByte(Code.IntZero + (item < 0 ? -byteLen : byteLen))

    let lowBits = (absItem & 0xffffffff) >>> 0
    let highBits = ((absItem - lowBits) / 0x100000000) >>> 0
    if (item < 0) {
      lowBits = (~lowBits)>>>0
      highBits = (~highBits)>>>0
    }

    for (; byteLen > 4; --byteLen) into.appendByte(highBits >>> (8*(byteLen-5)))
    for (; byteLen > 0; --byteLen) into.appendByte(lowBits >>> (8*(byteLen-1)))

  } else if (typeof item === 'number') {
    // Double precision float.
    into.appendByte(Code.Double)

    // We need to look at the representation bytes - which needs a temporary buffer.
    const bytes = Buffer.allocUnsafe(8)
    bytes.writeDoubleBE(item, 0)
    adjustFloat(bytes, true)
    into.appendBuffer(bytes)

  } else if (typeof item === 'object' && (item.type === 'float' || item.type === 'double')) {
    const isFloat = item.type === 'float'
    into.appendByte(isFloat ? Code.Float : Code.Double)
    let bytes
    if (item.rawEncoding) bytes = Buffer.from(item.rawEncoding)
    else {
      bytes = Buffer.allocUnsafe(isFloat ? 4 : 8)
      if (isFloat) bytes.writeFloatBE(item.value, 0)
      else bytes.writeDoubleBE(item.value, 0)
    }
    adjustFloat(bytes, true)
    into.appendBuffer(bytes)
  } else if (typeof item === 'object' && item.type === 'uuid') {
    into.appendByte(Code.UUID)
    assert(item.value.length === 16, 'Invalid UUID: Should be 16 bytes exactly')
    into.appendBuffer(item.value)

  } else throw new TypeError('Packed items must be basic types or lists')
}

export function pack(arr: TupleItem[]) {
  if (!Array.isArray(arr))
    throw new TypeError('fdb.tuple.pack must be called with an array');

  const builder = new BufferBuilder()
  for (let i = 0; i < arr.length; i++) {
    encode(builder, arr[i])
  }
  return builder.make()
}


// *** Decode

function decodeNumber(buf: Buffer, offset: number, numBytes: number) {
  const negative = numBytes < 0
  numBytes = Math.abs(numBytes)

  let num = 0
  let mult = 1
  let odd
  for (let i = numBytes-1; i >= 0; --i) {
    let b = buf[offset+i]
    if (negative) b = -(~b & 0xff)

    if (i == numBytes-1) odd = b & 0x01

    num += b * mult
    mult *= 0x100
  }

  if (!Number.isSafeInteger(num)) {
    throw new RangeError('Cannot unpack signed integers larger than 54 bits')
  }

  return num
}

function decode(buf: Buffer, pos: {p: number}, noCanonicalize: boolean): TupleItem {
  const code = buf.readUInt8(pos.p++) as Code
  let p = pos.p

  switch (code) {
    case Code.Null: return null
    case Code.False: return false
    case Code.True: return true
    case Code.Bytes: case Code.String: {
      const builder = new BufferBuilder()
      for (; p < buf.length; p++) {
        const byte = buf[p]
        if (byte === 0) {
          if (p+1 >= buf.length || buf[p+1] !== 0xff) break
          else p++ // skip 0xff.
        }
        builder.appendByte(byte)
      }
      pos.p = p + 1 // eat trailing 0
      return code === Code.Bytes ? builder.make() : builder.make().toString()
    }
    case Code.Nested: {
      const result: TupleItem[] = []
      while (true) {
        if (buf[pos.p] === 0) {
          if (pos.p+1 >= buf.length || buf[pos.p+1] !== 0xff) break
          else {
            pos.p += 2
            result.push(null)
          }
        } else result.push(decode(buf, pos, noCanonicalize))
      }
      pos.p++ // Eat trailing 0.
      return result
    }
    case Code.Double: {
      const numBuf = Buffer.alloc(8)
      buf.copy(numBuf, 0, p, p+8)
      adjustFloat(numBuf, false)
      pos.p += 8

      // There's a couple things going on here:
      // - buffer.readDoubleBE canonicalizes all NaNs to the same NaN value.
      // This is usually fine, but it means unpack(pack(val)) is sometimes not
      // bit-identical. Amongst other things, this makes the binding tester fail.
      // DataView#getFloat64 doesn't have this behaviour.
      // 
      // - In canonical mode we also wrap all doubles so that when you re-encode
      // them they don't get confused with ints (or floats, or anything else).
      return noCanonicalize
        ? {type: 'double', value: new DataView(numBuf.buffer).getFloat64(0, false)}
        : numBuf.readDoubleBE(0)
    }
    case Code.Float: {
      const numBuf = Buffer.alloc(4)
      buf.copy(numBuf, 0, p, p+4)
      adjustFloat(numBuf, false)
      pos.p += 4

      // Surprisingly, this seems to preserve any weird NaN encoding in the float.
      return noCanonicalize
        ? {type: 'float', value: new DataView(numBuf.buffer).getFloat32(0, false)}
        : numBuf.readFloatBE(0)
    }
    case Code.UUID: {
      const value = Buffer.alloc(16)
      buf.copy(value, 0, p, p+16)
      pos.p += 16
      return {type: 'uuid', value}
    }
    default: {
      const byteLen = code-20 // negative if number is negative.
      const absByteLen = Math.abs(byteLen)
      if (absByteLen <= 7) {
        pos.p += absByteLen
        return code === Code.IntZero ? 0 : decodeNumber(buf, p, byteLen)
      } else if (absByteLen <= 8) {
        throw new RangeError('Cannot unpack signed integers larger than 54 bits');
      } else throw new TypeError(`Unknown data type in DB: ${buf} at ${pos} code ${code}`);
    }
  }
}

export function unpack(key: Buffer, noCanonicalize: boolean = false) {
  const pos = {p: 0}
  const arr = []

  while(pos.p < key.length) {
    arr.push(decode(key, pos, noCanonicalize))
  }

  return arr
}

export function range(arr: TupleItem[]) {
  var packed = pack(arr)
  return {
    begin: Buffer.concat([packed, nullByte]),
    end: Buffer.concat([packed, Buffer.from('ff', 'hex')])
  }
}
