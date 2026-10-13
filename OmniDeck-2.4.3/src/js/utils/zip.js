// Minimal, dependency-free ZIP codec used ONLY for OmniDeck lesson packages.
//
// Why hand-rolled: the app ships no zip library and the package format must be
// readable on Windows/macOS/Linux with nothing but the WebView. Why safe: the
// reader never touches the filesystem. It only returns bytes for an entry NAME
// that the caller looks up, so there is no "extraction path" to traverse; names
// are nevertheless validated hard so a malicious archive is rejected up front.
//
// Supported: STORE (0) and DEFLATE (8), UTF-8 names, central-directory driven.
// Rejected: zip64, encryption, multi-disk, unknown methods, unsafe names,
// duplicate names, size/count limit violations, CRC or size mismatches.

export class ZipFormatError extends Error {
  constructor(message) { super(message); this.name = "ZipFormatError"; }
}

export const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 5000,
  maxEntryBytes: 1024 * 1024 * 1024,        // 1 GiB per entry
  maxTotalBytes: 2 * 1024 * 1024 * 1024 - 1, // < 2 GiB: stays inside JS typed-array limits
  maxNameBytes: 255,
});

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const U32_MAX = 0xffffffff;
const textEncoder = new TextEncoder();

let CRC_TABLE = null;
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Returns a reason string if the entry name is unsafe, else null. */
export function unsafeNameReason(name, maxNameBytes = DEFAULT_LIMITS.maxNameBytes) {
  if (typeof name !== "string" || !name) return "empty name";
  if (textEncoder.encode(name).length > maxNameBytes) return "name too long";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "control characters in name";
  if (name.includes("\\")) return "backslash in name";
  if (name.startsWith("/")) return "absolute path";
  const segs = name.split("/");
  if (segs[segs.length - 1] === "") segs.pop(); // directory entry
  for (const s of segs) {
    if (s === "" ) return "empty path segment";
    if (s === "." || s === "..") return "path traversal segment";
  }
  if (/^[A-Za-z]:/.test(segs[0] || "")) return "drive-letter path";
  if (/[<>:"|?*]/.test(name)) return "characters not portable to Windows";
  return null;
}

async function pump(stream, inputBytes, maxOut) {
  const writer = stream.writable.getWriter();
  const writeP = writer.write(inputBytes).then(() => writer.close());
  const reader = stream.readable.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (maxOut != null && total > maxOut) {
        await reader.cancel();
        throw new ZipFormatError("compressed entry expands beyond its declared size (corrupt or malicious archive)");
      }
      chunks.push(value);
    }
    await writeP;
  } catch (err) {
    writeP.catch(() => {});
    if (err instanceof ZipFormatError) throw err;
    throw new ZipFormatError(`compressed data is corrupt: ${err?.message || err}`);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream === "undefined") return null;
  return pump(new CompressionStream("deflate-raw"), bytes, null);
}
async function inflateRaw(bytes, expectedSize) {
  if (typeof DecompressionStream === "undefined") throw new ZipFormatError("this system cannot decompress the package (no DecompressionStream)");
  return pump(new DecompressionStream("deflate-raw"), bytes, expectedSize);
}

/**
 * entries: [{ name, data: Uint8Array, compress?: boolean }]. Returns Uint8Array.
 * Names are validated with the same rules the reader enforces.
 */
export async function createZip(entries) {
  const parts = [];
  const central = [];
  const seen = new Set();
  let offset = 0;
  for (const e of entries) {
    const bad = unsafeNameReason(e.name);
    if (bad) throw new ZipFormatError(`refusing to write entry "${e.name}": ${bad}`);
    const key = e.name.toLowerCase();
    if (seen.has(key)) throw new ZipFormatError(`duplicate entry name "${e.name}"`);
    seen.add(key);
    const data = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data);
    if (data.length > U32_MAX) throw new ZipFormatError(`"${e.name}" is too large for this package format (4 GiB limit)`);
    let method = 0, body = data;
    if (e.compress) {
      const d = await deflateRaw(data);
      if (d && d.length < data.length) { method = 8; body = d; }
    }
    const nameBytes = textEncoder.encode(e.name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, SIG_LOCAL, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, method, true); local.setUint16(10, 0, true); local.setUint16(12, 0x0021, true); // 1980-01-01
    local.setUint32(14, crc, true); local.setUint32(18, body.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, body);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, SIG_CENTRAL, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, method, true); cd.setUint16(12, 0, true); cd.setUint16(14, 0x0021, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, body.length, true); cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBytes.length, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);
    offset += 30 + nameBytes.length + body.length;
    if (offset > U32_MAX) throw new ZipFormatError("package is too large for this format (4 GiB limit)");
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, SIG_EOCD, true); eocd.setUint16(8, entries.length, true); eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true); eocd.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Parses and validates the archive structure (no entry data is decompressed
 * yet). Returns { entries: Map<name, meta>, read(name): Promise<Uint8Array> }.
 */
export function openZip(bytes, limits = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  if (!(bytes instanceof Uint8Array)) throw new ZipFormatError("not a byte array");
  if (bytes.length < 22) throw new ZipFormatError("file is too small to be a package");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipFormatError("not a valid package (end-of-archive record not found; the file may be truncated)");
  const disk = dv.getUint16(eocd + 4, true), cdDisk = dv.getUint16(eocd + 6, true);
  const countHere = dv.getUint16(eocd + 8, true), count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true), cdOffset = dv.getUint32(eocd + 16, true);
  if (disk !== 0 || cdDisk !== 0 || countHere !== count) throw new ZipFormatError("multi-disk archives are not supported");
  if (count === 0xffff || cdSize === U32_MAX || cdOffset === U32_MAX) throw new ZipFormatError("zip64 archives are not supported");
  if (count > L.maxEntries) throw new ZipFormatError(`package has too many files (${count} > ${L.maxEntries})`);
  if (cdOffset + cdSize > eocd) throw new ZipFormatError("package directory is out of range (corrupt archive)");

  const entries = new Map();
  const seen = new Set();
  let p = cdOffset, total = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let i = 0; i < count; i++) {
    if (p + 46 > cdOffset + cdSize || dv.getUint32(p, true) !== SIG_CENTRAL) throw new ZipFormatError("package directory is corrupt");
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const diskStart = dv.getUint16(p + 34, true), localOff = dv.getUint32(p + 42, true);
    if (p + 46 + nlen + xlen + clen > cdOffset + cdSize) throw new ZipFormatError("package directory is corrupt");
    if (flags & 0x1) throw new ZipFormatError("encrypted packages are not supported");
    if (method !== 0 && method !== 8) throw new ZipFormatError(`unsupported compression method ${method}`);
    if (diskStart !== 0) throw new ZipFormatError("multi-disk archives are not supported");
    if (csize === U32_MAX || usize === U32_MAX || localOff === U32_MAX) throw new ZipFormatError("zip64 archives are not supported");
    let name;
    try { name = decoder.decode(bytes.subarray(p + 46, p + 46 + nlen)); } catch { throw new ZipFormatError("entry name is not valid UTF-8"); }
    const bad = unsafeNameReason(name, L.maxNameBytes);
    if (bad) throw new ZipFormatError(`unsafe entry name "${name.slice(0, 80)}": ${bad}`);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new ZipFormatError(`duplicate entry "${name}"`);
    seen.add(key);
    if (usize > L.maxEntryBytes) throw new ZipFormatError(`"${name}" is larger than the allowed ${L.maxEntryBytes} bytes`);
    total += usize;
    if (total > L.maxTotalBytes) throw new ZipFormatError("package contents are larger than the allowed total size");
    if (method === 0 && csize !== usize) throw new ZipFormatError(`"${name}" has inconsistent sizes`);
    if (localOff + 30 > cdOffset) throw new ZipFormatError(`"${name}" points outside the archive`);
    if (!name.endsWith("/")) entries.set(name, { name, method, crc, csize, usize, localOff, nameBytes: bytes.subarray(p + 46, p + 46 + nlen) });
    p += 46 + nlen + xlen + clen;
  }

  async function read(name) {
    const m = entries.get(name);
    if (!m) throw new ZipFormatError(`"${name}" is not in the package`);
    const o = m.localOff;
    if (dv.getUint32(o, true) !== SIG_LOCAL) throw new ZipFormatError(`"${name}" has a corrupt header`);
    // The local header must agree with the central directory (name, sizes):
    // a mismatch means a damaged or deliberately inconsistent archive.
    const lnlen = dv.getUint16(o + 26, true);
    if (lnlen !== m.nameBytes.length || o + 30 + lnlen > cdOffset || !m.nameBytes.every((b, i) => bytes[o + 30 + i] === b)) {
      throw new ZipFormatError(`"${name}" has a damaged header (name mismatch)`);
    }
    if (dv.getUint32(o + 22, true) !== m.usize && (dv.getUint16(o + 6, true) & 0x8) === 0) throw new ZipFormatError(`"${name}" has a damaged header (size mismatch)`);
    const start = o + 30 + lnlen + dv.getUint16(o + 28, true);
    const end = start + m.csize;
    if (end > cdOffset) throw new ZipFormatError(`"${name}" extends past the end of the archive (truncated or corrupt)`);
    const raw = bytes.subarray(start, end);
    const data = m.method === 0 ? raw.slice() : await inflateRaw(raw, m.usize);
    if (data.length !== m.usize) throw new ZipFormatError(`"${name}" has the wrong size after reading (corrupt archive)`);
    if (crc32(data) !== m.crc) throw new ZipFormatError(`"${name}" failed its integrity check (corrupt archive)`);
    return data;
  }
  return { entries, read };
}
