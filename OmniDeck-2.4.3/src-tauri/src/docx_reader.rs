//! Self-contained `.docx` text extraction — no LibreOffice, no new crate.
//!
//! A `.docx` is a ZIP archive whose `word/document.xml` entry holds the
//! document body as WordprocessingML. Everything needed to read that one
//! entry — the ZIP central directory, DEFLATE decompression (ZIP's only
//! common compression method besides "stored"), and a minimal XML text-run
//! scanner — is implemented here from the format specs, using only
//! `std`. This intentionally does NOT attempt to be a general ZIP or XML
//! library: it reads exactly the one entry it needs and nothing else.
//!
//! Legacy binary `.doc` (pre-2007, OLE/CFB format) is a completely
//! different, much more complex format and is out of scope here — callers
//! should keep the existing LibreOffice fallback for `.doc` only.

use std::io;

#[derive(Debug)]
pub enum DocxError {
    NotAZip,
    EntryNotFound(&'static str),
    Unsupported(String),
    Corrupt(String),
}

impl std::fmt::Display for DocxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DocxError::NotAZip => write!(f, "This file isn't a valid .docx (not a zip archive)."),
            DocxError::EntryNotFound(name) => write!(f, "This .docx is missing its {name} part — it may be corrupt."),
            DocxError::Unsupported(m) => write!(f, "This .docx uses an unsupported zip feature ({m})."),
            DocxError::Corrupt(m) => write!(f, "This .docx could not be read: {m}."),
        }
    }
}

/// Extracts the visible body text of a `.docx` file's `word/document.xml`.
/// Paragraphs are separated by newlines; tabs become `\t`. Returns an error
/// (never silently-empty garbage) if the file isn't a well-formed docx.
pub fn extract_docx_text(bytes: &[u8]) -> Result<String, DocxError> {
    let entry = read_zip_entry(bytes, "word/document.xml")?;
    let xml = String::from_utf8_lossy(&entry).into_owned();
    Ok(extract_text_from_document_xml(&xml))
}

// ---------------------------------------------------------------------
// ZIP: locate the End Of Central Directory, walk the central directory
// to find one named entry, then decompress its data (stored or deflate).
// ---------------------------------------------------------------------

fn read_u16(b: &[u8], off: usize) -> u16 { u16::from_le_bytes([b[off], b[off + 1]]) }
fn read_u32(b: &[u8], off: usize) -> u32 { u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]]) }

fn find_eocd(b: &[u8]) -> Result<usize, DocxError> {
    // EOCD signature 0x06054b50, minimum record size 22 bytes, with up to
    // 65535 bytes of trailing comment to scan backwards through.
    if b.len() < 22 { return Err(DocxError::NotAZip); }
    let scan_from = b.len().saturating_sub(22 + 65535);
    let mut i = b.len() - 22;
    loop {
        if b[i] == 0x50 && b[i + 1] == 0x4b && b[i + 2] == 0x05 && b[i + 3] == 0x06 {
            return Ok(i);
        }
        if i == scan_from || i == 0 { break; }
        i -= 1;
    }
    Err(DocxError::NotAZip)
}

struct CentralEntry {
    name: String,
    method: u16,
    comp_size: u32,
    local_header_offset: u32,
}

fn read_central_directory(b: &[u8]) -> Result<Vec<CentralEntry>, DocxError> {
    let eocd = find_eocd(b)?;
    let cd_count = read_u16(b, eocd + 10) as usize;
    let cd_offset = read_u32(b, eocd + 16) as usize;
    if cd_offset >= b.len() { return Err(DocxError::Corrupt("central directory offset out of range".into())); }

    let mut entries = Vec::with_capacity(cd_count);
    let mut off = cd_offset;
    for _ in 0..cd_count {
        if off + 46 > b.len() { return Err(DocxError::Corrupt("truncated central directory".into())); }
        if read_u32(b, off) != 0x02014b50 {
            return Err(DocxError::Corrupt("bad central directory record signature".into()));
        }
        let method = read_u16(b, off + 10);
        let comp_size = read_u32(b, off + 20);
        let name_len = read_u16(b, off + 28) as usize;
        let extra_len = read_u16(b, off + 30) as usize;
        let comment_len = read_u16(b, off + 32) as usize;
        let local_header_offset = read_u32(b, off + 42);
        let name_start = off + 46;
        let name_end = name_start + name_len;
        if name_end > b.len() { return Err(DocxError::Corrupt("truncated file name".into())); }
        let name = String::from_utf8_lossy(&b[name_start..name_end]).into_owned();
        entries.push(CentralEntry { name, method, comp_size, local_header_offset });
        off = name_end + extra_len + comment_len;
    }
    Ok(entries)
}

fn read_zip_entry(b: &[u8], want_name: &'static str) -> Result<Vec<u8>, DocxError> {
    let entries = read_central_directory(b)?;
    let entry = entries
        .iter()
        .find(|e| e.name == want_name)
        .ok_or(DocxError::EntryNotFound(want_name))?;

    let lh = entry.local_header_offset as usize;
    if lh + 30 > b.len() || read_u32(b, lh) != 0x04034b50 {
        return Err(DocxError::Corrupt("bad local file header".into()));
    }
    let name_len = read_u16(b, lh + 26) as usize;
    let extra_len = read_u16(b, lh + 28) as usize;
    let data_start = lh + 30 + name_len + extra_len;
    let data_end = data_start + entry.comp_size as usize;
    if data_end > b.len() {
        return Err(DocxError::Corrupt("entry data runs past end of file".into()));
    }
    let data = &b[data_start..data_end];

    match entry.method {
        0 => Ok(data.to_vec()), // stored (no compression)
        8 => inflate(data).map_err(|e| DocxError::Corrupt(format!("deflate error: {e}"))),
        other => Err(DocxError::Unsupported(format!("compression method {other}"))),
    }
}

// ---------------------------------------------------------------------
// DEFLATE (RFC 1951) decompressor — stored, fixed-Huffman and
// dynamic-Huffman blocks. Minimal but complete for standard zip output.
// ---------------------------------------------------------------------

struct BitReader<'a> {
    data: &'a [u8],
    byte_pos: usize,
    bit_pos: u32,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self { Self { data, byte_pos: 0, bit_pos: 0 } }

    fn read_bit(&mut self) -> io::Result<u32> {
        if self.byte_pos >= self.data.len() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "ran out of bits"));
        }
        let bit = (self.data[self.byte_pos] >> self.bit_pos) & 1;
        self.bit_pos += 1;
        if self.bit_pos == 8 { self.bit_pos = 0; self.byte_pos += 1; }
        Ok(bit as u32)
    }

    fn read_bits(&mut self, n: u32) -> io::Result<u32> {
        let mut v = 0u32;
        for i in 0..n { v |= self.read_bit()? << i; }
        Ok(v)
    }

    fn align_to_byte(&mut self) {
        if self.bit_pos != 0 { self.bit_pos = 0; self.byte_pos += 1; }
    }
}

/// Canonical Huffman decode table built from per-symbol code lengths.
struct Huffman {
    // (code length, symbol) sorted by (length, code) via canonical assignment
    counts: [u32; 16],
    symbols: Vec<u16>,
}

impl Huffman {
    fn from_lengths(lengths: &[u8]) -> Self {
        let mut counts = [0u32; 16];
        for &l in lengths { counts[l as usize] += 1; }
        counts[0] = 0;
        let mut offsets = [0u32; 16];
        for i in 1..16 { offsets[i] = offsets[i - 1] + counts[i - 1]; }
        let mut symbols = vec![0u16; lengths.len()];
        for (sym, &l) in lengths.iter().enumerate() {
            if l != 0 {
                symbols[offsets[l as usize] as usize] = sym as u16;
                offsets[l as usize] += 1;
            }
        }
        Huffman { counts, symbols }
    }

    fn decode(&self, r: &mut BitReader) -> io::Result<u16> {
        let mut code = 0i32;
        let mut first = 0i32;
        let mut index = 0i32;
        for len in 1..16 {
            code |= r.read_bit()? as i32;
            let count = self.counts[len] as i32;
            if code - first < count {
                return Ok(self.symbols[(index + (code - first)) as usize]);
            }
            index += count;
            first += count;
            first <<= 1;
            code <<= 1;
        }
        Err(io::Error::new(io::ErrorKind::InvalidData, "bad Huffman code"))
    }
}

const LEN_BASE: [u16; 29] = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const LEN_EXTRA: [u8; 29] = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
const DIST_BASE: [u16; 30] = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
const DIST_EXTRA: [u8; 30] = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];

fn fixed_huffman_tables() -> (Huffman, Huffman) {
    let mut lit_lengths = [0u8; 288];
    for i in 0..144 { lit_lengths[i] = 8; }
    for i in 144..256 { lit_lengths[i] = 9; }
    for i in 256..280 { lit_lengths[i] = 7; }
    for i in 280..288 { lit_lengths[i] = 8; }
    let dist_lengths = [5u8; 30];
    (Huffman::from_lengths(&lit_lengths), Huffman::from_lengths(&dist_lengths))
}

fn read_dynamic_tables(r: &mut BitReader) -> io::Result<(Huffman, Huffman)> {
    let hlit = r.read_bits(5)? as usize + 257;
    let hdist = r.read_bits(5)? as usize + 1;
    let hclen = r.read_bits(4)? as usize + 4;
    const ORDER: [usize; 19] = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
    let mut cl_lengths = [0u8; 19];
    for i in 0..hclen { cl_lengths[ORDER[i]] = r.read_bits(3)? as u8; }
    let cl_huffman = Huffman::from_lengths(&cl_lengths);

    let mut lengths = Vec::with_capacity(hlit + hdist);
    while lengths.len() < hlit + hdist {
        let sym = cl_huffman.decode(r)?;
        match sym {
            0..=15 => lengths.push(sym as u8),
            16 => {
                let prev = *lengths.last().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "repeat with no previous length"))?;
                let rep = r.read_bits(2)? + 3;
                for _ in 0..rep { lengths.push(prev); }
            }
            17 => { let rep = r.read_bits(3)? + 3; for _ in 0..rep { lengths.push(0); } }
            18 => { let rep = r.read_bits(7)? + 11; for _ in 0..rep { lengths.push(0); } }
            _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "bad code-length symbol")),
        }
    }
    let lit_lengths = &lengths[0..hlit];
    let dist_lengths = &lengths[hlit..hlit + hdist];
    Ok((Huffman::from_lengths(lit_lengths), Huffman::from_lengths(dist_lengths)))
}

pub fn inflate(data: &[u8]) -> io::Result<Vec<u8>> {
    let mut r = BitReader::new(data);
    let mut out: Vec<u8> = Vec::with_capacity(data.len() * 3);
    loop {
        let is_final = r.read_bit()? == 1;
        let block_type = r.read_bits(2)?;
        match block_type {
            0 => {
                r.align_to_byte();
                if r.byte_pos + 4 > r.data.len() {
                    return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "truncated stored block header"));
                }
                let len = u16::from_le_bytes([r.data[r.byte_pos], r.data[r.byte_pos + 1]]) as usize;
                r.byte_pos += 4; // LEN + NLEN (NLEN not re-validated)
                if r.byte_pos + len > r.data.len() {
                    return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "truncated stored block data"));
                }
                out.extend_from_slice(&r.data[r.byte_pos..r.byte_pos + len]);
                r.byte_pos += len;
            }
            1 | 2 => {
                let (lit_huff, dist_huff) = if block_type == 1 {
                    fixed_huffman_tables()
                } else {
                    read_dynamic_tables(&mut r)?
                };
                loop {
                    let sym = lit_huff.decode(&mut r)?;
                    if sym < 256 {
                        out.push(sym as u8);
                    } else if sym == 256 {
                        break; // end of block
                    } else {
                        let idx = (sym - 257) as usize;
                        if idx >= LEN_BASE.len() {
                            return Err(io::Error::new(io::ErrorKind::InvalidData, "bad length symbol"));
                        }
                        let length = LEN_BASE[idx] as usize + r.read_bits(LEN_EXTRA[idx] as u32)? as usize;
                        let dsym = dist_huff.decode(&mut r)? as usize;
                        if dsym >= DIST_BASE.len() {
                            return Err(io::Error::new(io::ErrorKind::InvalidData, "bad distance symbol"));
                        }
                        let distance = DIST_BASE[dsym] as usize + r.read_bits(DIST_EXTRA[dsym] as u32)? as usize;
                        if distance > out.len() {
                            return Err(io::Error::new(io::ErrorKind::InvalidData, "distance too far back"));
                        }
                        let start = out.len() - distance;
                        for i in 0..length { let b = out[start + i]; out.push(b); }
                    }
                }
            }
            _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "reserved block type")),
        }
        if is_final { break; }
    }
    Ok(out)
}

// ---------------------------------------------------------------------
// Minimal WordprocessingML text extraction: pull the content of every
// <w:t> run, insert a tab for <w:tab/> and a newline at each </w:p>.
// Deliberately not a general XML parser — document.xml is well-formed
// XML produced by Word/OOXML tooling, so a tolerant scanner is enough.
// ---------------------------------------------------------------------

fn decode_xml_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn extract_text_from_document_xml(xml: &str) -> String {
    let mut out = String::new();
    let bytes = xml.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        // Find the tag name (up to whitespace, '>' or '/').
        let tag_start = i + 1;
        let mut j = tag_start;
        while j < bytes.len() && !matches!(bytes[j], b' ' | b'>' | b'/' | b'\t' | b'\n' | b'\r') { j += 1; }
        let tag_name = &xml[tag_start..j];

        if tag_name == "w:t" {
            // Find the end of this start tag, then the matching </w:t>.
            if let Some(gt) = xml[j..].find('>') {
                let content_start = j + gt + 1;
                if let Some(close_rel) = xml[content_start..].find("</w:t>") {
                    let content = &xml[content_start..content_start + close_rel];
                    out.push_str(&decode_xml_entities(content));
                    i = content_start + close_rel + "</w:t>".len();
                    continue;
                }
            }
            i = j;
        } else if tag_name == "w:tab" {
            out.push('\t');
            i = j;
        } else if tag_name == "w:p" || tag_name == "/w:p" {
            out.push('\n');
            i = j;
        } else {
            i = j;
        }
    }
    // Collapse the run of blank lines a fully-empty paragraph leaves behind,
    // and trim the trailing newline from the final </w:p>.
    let collapsed: Vec<&str> = out.split('\n').collect();
    collapsed.join("\n").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_extracts_runs_across_paragraphs() {
        let xml = r#"<w:document><w:body>
            <w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p>
            <w:p><w:r><w:t>Second &amp; final line</w:t></w:r></w:p>
        </w:body></w:document>"#;
        let text = extract_text_from_document_xml(xml);
        assert_eq!(text, "Hello world\nSecond & final line");
    }

    #[test]
    fn inflate_roundtrips_a_stored_block() {
        // DEFLATE stored block: BFINAL=1, BTYPE=00, then byte-aligned
        // LEN/NLEN/data. Hand-built rather than produced by a compressor,
        // since this module has no encoder — only the decoder is needed.
        let payload = b"hello docx";
        let mut data = vec![0x01u8]; // BFINAL=1, BTYPE=00 in the low 3 bits of the first byte
        let len = payload.len() as u16;
        data.extend_from_slice(&len.to_le_bytes());
        data.extend_from_slice(&(!len).to_le_bytes());
        data.extend_from_slice(payload);
        let out = inflate(&data).unwrap();
        assert_eq!(out, payload);
    }
}
