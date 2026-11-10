//! 디자인 비교 게이트의 판정(ADR-191 3ae): 실제 화면과 디자인 기준 PNG를 읽어 너비를 확인하고, 겹치는 높이만 잘라, 가림 영역을 칠하고,
//! pixelmatch 7.2.0과 같은 알고리즘으로 다른 픽셀 수를 센다(옛 TS: `packages/agent/src/visual-compare-legacy.ts`).
//!
//! 읽는 쪽은 pngjs 7.0.0과 같은 RGBA8을 내야 한다. `png` 크레이트는 IDENTITY 변환으로 원본 표본(깊이 그대로, 팔레트 인덱스 그대로)만 받고,
//! 팔레트·tRNS·깊이 확대(`floor(v*255/max+0.5)`)는 pngjs와 같은 식으로 여기서 한다. 감마(gAMA)는 pngjs도 값만 읽고 픽셀에 쓰지 않는다.
//!
//! 게이트는 비율이 허용치를 **넘으면** 실패시킨다(여는 쪽 = 비율이 작아지는 쪽). 그래서 판정이 끝까지 가지 못한 입력은 모두 던진다:
//! 읽지 못한 PNG, 너비 불일치, 한 쪽이 너무 큼, 비교한 픽셀 0, 범위 밖 threshold(NaN이면 옛 코드는 "차이 0"을 낸다).
//!
//! pngjs가 받아 주고 여기서 거절하는 꼴(닫는 쪽 차이): 규격에 없는 깊이·색 조합, 둘째 IHDR, 떨어져 놓인 IDAT, 팔레트가 깊이보다 큰 PNG 등
//! `png` 크레이트가 거절하는 모든 입력. 반대로(pngjs가 거절하는데 여기서 받는) 꼴이 없게 하려고 pngjs의 청크 규칙(`scan`)을 먼저 그대로 돌린다.

use std::io::Cursor;
use std::sync::LazyLock;

/// 한 이미지의 최대 픽셀 수. 이보다 크면 읽기 전에(IHDR의 너비·높이로) 던진다. RGBA8 한 장이 200MB다
pub const MAX_PIXELS: u64 = 50_000_000;

#[derive(Debug, PartialEq)]
pub enum Error {
    /// 비교가 성립하지 않는다(옛 TS의 `VisualCompareError`)
    Compare(String),
    /// PNG를 읽지 못했다(옛 TS에서는 pngjs가 던지는 일반 `Error`)
    Decode(String),
}

pub struct Mask {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub struct Compared {
    pub diff_pixels: u64,
    pub compared_pixels: u64,
    pub width: u32,
    pub height: u32,
    pub diff: Vec<u8>,
}

struct Image {
    width: u32,
    height: u32,
    /// RGBA8, `width*height*4`바이트
    data: Vec<u8>,
}

// ── PNG 청크 규칙(pngjs 7.0.0 parser.js·sync-reader.js와 같게)

const SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

struct Scan {
    width: u32,
    height: u32,
    depth: u8,
    color_type: u8,
    palette: Vec<[u8; 4]>,
    /// tRNS가 정한 투명 색(회색조 1개, RGB 3개; 16비트 표본 값)
    trans_color: Option<Vec<u32>>,
    /// 이어 붙인 IDAT 본문(zlib 스트림)
    idat: Vec<u8>,
    interlaced: bool,
}

/// CRC-32(IEEE). `png`가 쓰는 crc32fast를 직접 의존으로 늘리지 않으려고 표로 쓴다(청크는 한 번씩만 읽으므로 속도는 문제가 아니다)
fn crc32(parts: &[&[u8]]) -> u32 {
    static TABLE: LazyLock<[u32; 256]> = LazyLock::new(|| {
        let mut table = [0u32; 256];
        for (i, slot) in table.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 == 1 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *slot = c;
        }
        table
    });
    let mut crc = 0xffff_ffffu32;
    for part in parts {
        for &byte in *part {
            crc = TABLE[((crc ^ u32::from(byte)) & 0xff) as usize] ^ (crc >> 8);
        }
    }
    crc ^ 0xffff_ffff
}

/// pngjs가 청크를 읽는 순서와 거절 조건을 그대로 따라간다. 거절하는 입력은 모두 `Err`
fn scan(bytes: &[u8]) -> Result<Scan, String> {
    if bytes.len() < 8 || bytes[..8] != SIGNATURE {
        return Err("PNG 서명이 아닙니다".to_owned());
    }
    let mut pos = 8usize;
    let mut scan: Option<Scan> = None;
    loop {
        if bytes.len() - pos < 8 {
            return Err("PNG가 중간에 끝났습니다(IEND가 없습니다)".to_owned());
        }
        let length = u32::from_be_bytes([bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]]) as usize;
        let kind: [u8; 4] = [bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]];
        pos += 8;
        if scan.is_none() && &kind != b"IHDR" {
            return Err("PNG의 첫 청크가 IHDR이 아닙니다".to_owned());
        }
        let known = matches!(&kind, b"IHDR" | b"IEND" | b"IDAT" | b"PLTE" | b"tRNS" | b"gAMA");
        if !known {
            // 알려지지 않은 청크: 보조(앞 글자 5번째 비트)면 CRC도 보지 않고 건너뛴다. 필수면 pngjs도 던진다
            if kind[0] & 0x20 == 0 {
                return Err(format!("지원하지 않는 필수 청크 {}", String::from_utf8_lossy(&kind)));
            }
            if bytes.len() - pos < length || bytes.len() - pos - length < 4 {
                return Err("PNG가 중간에 끝났습니다".to_owned());
            }
            pos += length + 4;
            continue;
        }
        if bytes.len() - pos < length || bytes.len() - pos - length < 4 {
            return Err("PNG가 중간에 끝났습니다".to_owned());
        }
        let data = &bytes[pos..pos + length];
        let file_crc = u32::from_be_bytes([bytes[pos + length], bytes[pos + length + 1], bytes[pos + length + 2], bytes[pos + length + 3]]);
        if crc32(&[&kind, data]) != file_crc {
            return Err("PNG 청크의 CRC가 맞지 않습니다".to_owned());
        }
        pos += length + 4;
        match &kind {
            b"IHDR" => {
                if scan.is_some() {
                    return Err("IHDR가 둘 이상입니다".to_owned());
                }
                if data.len() < 13 {
                    return Err("IHDR가 너무 짧습니다".to_owned());
                }
                let width = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
                let height = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
                let (depth, color_type, compression, filter, interlace) = (data[8], data[9], data[10], data[11], data[12]);
                if !matches!(depth, 1 | 2 | 4 | 8 | 16) {
                    return Err(format!("지원하지 않는 비트 깊이 {depth}"));
                }
                if !matches!(color_type, 0 | 2 | 3 | 4 | 6) {
                    return Err("지원하지 않는 색 종류입니다".to_owned());
                }
                if compression != 0 || filter != 0 || interlace > 1 {
                    return Err("지원하지 않는 압축·필터·인터레이스 방식입니다".to_owned());
                }
                scan = Some(Scan { width, height, depth, color_type, palette: Vec::new(), trans_color: None, idat: Vec::new(), interlaced: interlace == 1 });
            }
            b"PLTE" => {
                let scan = scan.as_mut().expect("IHDR 뒤");
                for entry in data.chunks_exact(3) {
                    scan.palette.push([entry[0], entry[1], entry[2], 0xff]);
                }
            }
            b"tRNS" => {
                let scan = scan.as_mut().expect("IHDR 뒤");
                match scan.color_type {
                    3 => {
                        if scan.palette.is_empty() {
                            return Err("tRNS가 PLTE보다 앞입니다".to_owned());
                        }
                        if data.len() > scan.palette.len() {
                            return Err("팔레트보다 투명 색이 많습니다".to_owned());
                        }
                        for (slot, alpha) in scan.palette.iter_mut().zip(data) {
                            slot[3] = *alpha;
                        }
                    }
                    0 => {
                        if data.len() < 2 {
                            return Err("tRNS가 너무 짧습니다".to_owned());
                        }
                        scan.trans_color = Some(vec![u32::from(u16::from_be_bytes([data[0], data[1]]))]);
                    }
                    2 => {
                        if data.len() < 6 {
                            return Err("tRNS가 너무 짧습니다".to_owned());
                        }
                        scan.trans_color = Some((0..3).map(|i| u32::from(u16::from_be_bytes([data[i * 2], data[i * 2 + 1]]))).collect());
                    }
                    _ => {}
                }
            }
            b"gAMA" => {
                if data.len() < 4 {
                    return Err("gAMA가 너무 짧습니다".to_owned());
                }
            }
            b"IDAT" => {
                let scan = scan.as_mut().expect("IHDR 뒤");
                if scan.color_type == 3 && scan.palette.is_empty() {
                    return Err("팔레트가 없습니다".to_owned());
                }
                scan.idat.extend_from_slice(data);
            }
            b"IEND" => {
                // pngjs는 IEND 뒤에 바이트가 남으면 던진다("unrecognised content at end of stream")
                if pos != bytes.len() {
                    return Err("IEND 뒤에 남은 바이트가 있습니다".to_owned());
                }
                return Ok(scan.expect("IHDR 뒤"));
            }
            _ => unreachable!(),
        }
    }
}


// ── zlib 스트림이 정확히 끝나는지(크기·끝 위치) 확인한다.
// pngjs는 압축을 푼 데이터가 이미지 크기와 다르거나(남거나 모자라거나) 압축 스트림 뒤에 바이트가 남으면 대체로 던진다. `png` 크레이트는 libpng처럼
// 남는 데이터를 조용히 버린다. 판정이 끝까지 가지 못한 입력을 통과시키지 않으려고, 압축을 푼 바이트 수와 스트림의 끝 위치만 세는 작은 inflate를 먼저 돌린다
// (실제로 풀면서 32KB 창만 들고 adler32를 확인한다. 풀린 바이트는 모으지 않는다. `png` 크레이트는 이미지를 다 채우면 adler32를 읽기 전에 멈춘다).

struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
    bit: u32,
}

impl Bits<'_> {
    fn one(&mut self) -> Result<u32, String> {
        let byte = *self.data.get(self.pos).ok_or("zlib 스트림이 중간에 끝났습니다")?;
        let value = u32::from(byte >> self.bit) & 1;
        self.bit += 1;
        if self.bit == 8 {
            self.bit = 0;
            self.pos += 1;
        }
        Ok(value)
    }
    fn many(&mut self, count: u32) -> Result<u32, String> {
        let mut value = 0;
        for shift in 0..count {
            value |= self.one()? << shift;
        }
        Ok(value)
    }
    fn align(&mut self) {
        if self.bit != 0 {
            self.bit = 0;
            self.pos += 1;
        }
    }
}

struct Huffman {
    count: [u16; 16],
    symbol: Vec<u16>,
}

impl Huffman {
    fn new(lengths: &[u8]) -> Result<Huffman, String> {
        let mut count = [0u16; 16];
        for &length in lengths {
            count[usize::from(length)] += 1;
        }
        let mut left: i32 = 1;
        for length in 1..16 {
            left <<= 1;
            left -= i32::from(count[length]);
            if left < 0 {
                return Err("허프만 부호가 넘칩니다".to_owned());
            }
        }
        let mut offsets = [0u16; 16];
        for length in 1..15 {
            offsets[length + 1] = offsets[length] + count[length];
        }
        let mut symbol = vec![0u16; lengths.len()];
        for (index, &length) in lengths.iter().enumerate() {
            if length != 0 {
                symbol[usize::from(offsets[usize::from(length)])] = index as u16;
                offsets[usize::from(length)] += 1;
            }
        }
        Ok(Huffman { count, symbol })
    }
    fn decode(&self, bits: &mut Bits) -> Result<u16, String> {
        let (mut code, mut first, mut index) = (0i32, 0i32, 0i32);
        for length in 1..16 {
            code |= bits.one()? as i32;
            let count = i32::from(self.count[length]);
            if code - count < first {
                return Ok(self.symbol[(index + (code - first)) as usize]);
            }
            index += count;
            first += count;
            first <<= 1;
            code <<= 1;
        }
        Err("허프만 부호를 읽지 못했습니다".to_owned())
    }
}

const LENGTH_BASE: [u32; 29] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA: [u32; 29] = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE: [u32; 30] = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA: [u32; 30] = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

const OVER_LIMIT: &str = "압축을 푼 데이터가 이미지 크기보다 깁니다";

/// zlib 스트림 `data`가 정확히 `data.len()`바이트에서 끝나는지(adler32 포함), 풀면 몇 바이트인지. 끝나지 않거나 뒤에 바이트가 남으면 `Err`.
/// 풀린 바이트가 `limit`을 넘으면 그 자리에서 `Err`다(어차피 이미지 크기와 같을 수 없다. 끝까지 세면 압축이 잘 되는 IDAT 하나로 파일 크기의 약 1000배를 돈다)
fn zlib_output_len(data: &[u8], limit: u64) -> Result<u64, String> {
    if data.len() < 2 || data[0] & 0x0f != 8 || (u32::from(data[0]) * 256 + u32::from(data[1])) % 31 != 0 || data[1] & 0x20 != 0 {
        return Err("zlib 머리가 올바르지 않습니다".to_owned());
    }
    let mut bits = Bits { data, pos: 2, bit: 0 };
    let mut out = 0u64;
    let mut window = vec![0u8; 32768];
    let (mut a, mut b) = (1u32, 0u32);
    let mut emit = |byte: u8, out: &mut u64, window: &mut [u8]| {
        window[(*out & 32767) as usize] = byte;
        *out += 1;
        a = (a + u32::from(byte)) % 65521;
        b = (b + a) % 65521;
    };
    loop {
        let last = bits.one()?;
        match bits.many(2)? {
            0 => {
                bits.align();
                let p = bits.pos;
                if p + 4 > data.len() {
                    return Err("zlib 스트림이 중간에 끝났습니다".to_owned());
                }
                let len = u16::from_le_bytes([data[p], data[p + 1]]);
                if u16::from_le_bytes([data[p + 2], data[p + 3]]) != !len {
                    return Err("저장 블록의 길이가 맞지 않습니다".to_owned());
                }
                if p + 4 + usize::from(len) > data.len() {
                    return Err("zlib 스트림이 중간에 끝났습니다".to_owned());
                }
                for &byte in &data[p + 4..p + 4 + usize::from(len)] {
                    emit(byte, &mut out, &mut window);
                }
                bits.pos = p + 4 + usize::from(len);
                if out > limit {
                    return Err(OVER_LIMIT.to_owned());
                }
            }
            kind @ (1 | 2) => {
                let (lit, dist) = if kind == 1 {
                    let mut lengths = [8u8; 288];
                    lengths[144..256].fill(9);
                    lengths[256..280].fill(7);
                    (Huffman::new(&lengths)?, Huffman::new(&[5u8; 30])?)
                } else {
                    let nlen = bits.many(5)? as usize + 257;
                    let ndist = bits.many(5)? as usize + 1;
                    let ncode = bits.many(4)? as usize + 4;
                    if nlen > 286 || ndist > 30 {
                        return Err("동적 블록의 부호 수가 너무 많습니다".to_owned());
                    }
                    const ORDER: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
                    let mut lengths = [0u8; 19];
                    for &slot in ORDER.iter().take(ncode) {
                        lengths[slot] = bits.many(3)? as u8;
                    }
                    let code_lengths = Huffman::new(&lengths)?;
                    let mut all = vec![0u8; nlen + ndist];
                    let mut at = 0;
                    while at < nlen + ndist {
                        let symbol = code_lengths.decode(&mut bits)?;
                        if symbol < 16 {
                            all[at] = symbol as u8;
                            at += 1;
                        } else {
                            let (value, repeat) = match symbol {
                                16 => {
                                    if at == 0 {
                                        return Err("반복할 길이가 없습니다".to_owned());
                                    }
                                    (all[at - 1], 3 + bits.many(2)? as usize)
                                }
                                17 => (0, 3 + bits.many(3)? as usize),
                                _ => (0, 11 + bits.many(7)? as usize),
                            };
                            if at + repeat > nlen + ndist {
                                return Err("길이 반복이 넘칩니다".to_owned());
                            }
                            all[at..at + repeat].fill(value);
                            at += repeat;
                        }
                    }
                    if all[256] == 0 {
                        return Err("블록 끝 부호가 없습니다".to_owned());
                    }
                    (Huffman::new(&all[..nlen])?, Huffman::new(&all[nlen..])?)
                };
                loop {
                    let symbol = usize::from(lit.decode(&mut bits)?);
                    if symbol < 256 {
                        emit(symbol as u8, &mut out, &mut window);
                        if out > limit {
                            return Err(OVER_LIMIT.to_owned());
                        }
                    } else if symbol == 256 {
                        break;
                    } else {
                        let index = symbol - 257;
                        if index >= 29 {
                            return Err("길이 부호가 올바르지 않습니다".to_owned());
                        }
                        let length = LENGTH_BASE[index] + bits.many(LENGTH_EXTRA[index])?;
                        let distance = usize::from(dist.decode(&mut bits)?);
                        if distance >= 30 {
                            return Err("거리 부호가 올바르지 않습니다".to_owned());
                        }
                        let back = u64::from(DIST_BASE[distance] + bits.many(DIST_EXTRA[distance])?);
                        if back > out {
                            return Err("압축 스트림이 이미 풀린 앞쪽보다 더 앞을 가리킵니다".to_owned());
                        }
                        for _ in 0..length {
                            let byte = window[((out - back) & 32767) as usize];
                            emit(byte, &mut out, &mut window);
                        }
                        if out > limit {
                            return Err(OVER_LIMIT.to_owned());
                        }
                    }
                }
            }
            _ => return Err("블록 종류가 올바르지 않습니다".to_owned()),
        }
        if last == 1 {
            break;
        }
    }
    bits.align();
    // 끝에 adler32 4바이트가 붙고, 그 뒤에는 아무것도 없어야 한다
    if bits.pos + 4 != data.len() {
        return Err(if bits.pos + 4 > data.len() { "zlib 스트림이 중간에 끝났습니다" } else { "zlib 스트림 뒤에 바이트가 남았습니다" }.to_owned());
    }
    if u32::from_be_bytes([data[bits.pos], data[bits.pos + 1], data[bits.pos + 2], data[bits.pos + 3]]) != (b << 16 | a) {
        return Err("zlib의 adler32가 맞지 않습니다".to_owned());
    }
    Ok(out)
}

/// 이미지 한 장이 압축 전에 가져야 하는 바이트 수(줄마다 필터 1바이트 포함, 인터레이스면 일곱 패스의 합)
fn raw_len(scan: &Scan) -> u64 {
    let channels: u64 = match scan.color_type {
        0 | 3 => 1,
        4 => 2,
        2 => 3,
        _ => 4,
    };
    let bits = channels * u64::from(scan.depth);
    let row = |width: u64| (width * bits).div_ceil(8) + 1;
    let (w, h) = (u64::from(scan.width), u64::from(scan.height));
    if !scan.interlaced {
        return row(w) * h;
    }
    const PASSES: [(u64, u64, u64, u64); 7] = [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)];
    PASSES
        .iter()
        .map(|&(x0, y0, dx, dy)| {
            let (pw, ph) = ((w + dx - 1).saturating_sub(x0) / dx, (h + dy - 1).saturating_sub(y0) / dy);
            if pw == 0 || ph == 0 {
                0
            } else {
                row(pw) * ph
            }
        })
        .sum()
}

/// 깊이 d 표본(0..=2^d-1)을 8비트로: pngjs `scaleDepth`의 `Math.floor(v * 255 / max + 0.5)`와 같은 식
fn scale_table(depth: u8) -> Vec<u8> {
    let max = f64::from((1u32 << depth) - 1);
    (0..=(1u32 << depth) - 1).map(|v| ((f64::from(v) * 255.0) / max + 0.5).floor() as u8).collect()
}

/// 읽기 전에 IHDR의 너비×높이로 본다
fn too_large(pixels: u64) -> bool {
    pixels > MAX_PIXELS
}

fn decode(bytes: &[u8]) -> Result<Image, Error> {
    decode_inner(bytes).map_err(|error| match error {
        Error::Decode(message) => Error::Decode(format!("PNG를 읽지 못했습니다: {message}")),
        other => other,
    })
}

fn decode_inner(bytes: &[u8]) -> Result<Image, Error> {
    let scan = scan(bytes).map_err(Error::Decode)?;
    let pixels = u64::from(scan.width) * u64::from(scan.height);
    if scan.width == 0 || scan.height == 0 {
        // 옛 코드는 너비가 0인 PNG 두 장을 비교한 픽셀 0개로 "차이 0"(통과)을 냈다
        return Err(Error::Compare(format!("이미지 크기가 0입니다 ({}x{}px)", scan.width, scan.height)));
    }
    if too_large(pixels) {
        return Err(Error::Compare(format!("이미지가 너무 큽니다 ({}x{}px, 최대 {MAX_PIXELS}픽셀)", scan.width, scan.height)));
    }
    // 압축을 푼 크기가 이미지 크기와 정확히 같고 스트림이 정확히 끝나야 한다(위 설명)
    let expected = raw_len(&scan);
    let produced = zlib_output_len(&scan.idat, expected).map_err(Error::Decode)?;
    if produced != expected {
        return Err(Error::Decode(format!("압축을 푼 데이터가 이미지 크기와 다릅니다 ({produced}바이트, 필요 {expected})")));
    }
    let width = scan.width as usize;
    let height = scan.height as usize;
    // 화면에 쓰지 않는 보조 청크(텍스트·ICC)는 pngjs처럼 아예 읽지 않는다. 한도는 픽셀 버퍼 + 기본 한도(64MiB)다
    let limits = png::Limits { bytes: (pixels as usize).saturating_mul(8).saturating_add(64 << 20) };
    let mut decoder = png::Decoder::new_with_limits(Cursor::new(bytes), limits);
    decoder.set_transformations(png::Transformations::IDENTITY);
    decoder.set_ignore_text_chunk(true);
    decoder.set_ignore_iccp_chunk(true);
    // adler32도 본다. pngjs는 zlib가 adler32가 틀린 스트림을 거절한다
    decoder.ignore_checksums(false);
    let mut reader = decoder.read_info().map_err(|e| Error::Decode(e.to_string()))?;
    let size = reader.output_buffer_size().ok_or_else(|| Error::Decode("출력 크기를 셀 수 없습니다".to_owned()))?;
    let mut raw = vec![0u8; size];
    let info = reader.next_frame(&mut raw).map_err(|e| Error::Decode(e.to_string()))?;
    reader.finish().map_err(|e| Error::Decode(e.to_string()))?;
    let (color, bit_depth) = (info.color_type, info.bit_depth as u8);
    let color_code = match color {
        png::ColorType::Grayscale => 0,
        png::ColorType::Rgb => 2,
        png::ColorType::Indexed => 3,
        png::ColorType::GrayscaleAlpha => 4,
        png::ColorType::Rgba => 6,
    };
    if info.width as usize != width || info.height as usize != height || color_code != scan.color_type || bit_depth != scan.depth {
        return Err(Error::Decode("첫 장의 크기·형식이 IHDR와 다릅니다".to_owned()));
    }
    let line = info.line_size;
    let channels = match color_code {
        0 | 3 => 1usize,
        4 => 2,
        2 => 3,
        _ => 4,
    };
    let depth = u32::from(scan.depth);
    let max = (1u32 << depth) - 1;
    let table = if depth == 8 { Vec::new() } else { scale_table(scan.depth) };
    let scale = |v: u32| -> u8 {
        if depth == 8 {
            v as u8
        } else {
            table[v as usize]
        }
    };
    let mut data = vec![0u8; width * height * 4];
    let mut samples = [0u32; 4];
    for y in 0..height {
        let row = &raw[y * line..(y + 1) * line];
        for x in 0..width {
            for (c, slot) in samples.iter_mut().enumerate().take(channels) {
                let index = x * channels + c;
                *slot = match depth {
                    16 => u32::from(u16::from_be_bytes([row[index * 2], row[index * 2 + 1]])),
                    8 => u32::from(row[index]),
                    d => {
                        let bit = index * d as usize;
                        (u32::from(row[bit / 8]) >> (8 - d as usize - bit % 8)) & max
                    }
                };
            }
            let out = &mut data[(y * width + x) * 4..(y * width + x) * 4 + 4];
            if color_code == 3 {
                let Some(color) = scan.palette.get(samples[0] as usize) else {
                    return Err(Error::Decode(format!("index {} not in palette", samples[0])));
                };
                out.copy_from_slice(color);
                continue;
            }
            let rgba: [u32; 4] = match color_code {
                0 => [samples[0], samples[0], samples[0], max],
                4 => [samples[0], samples[0], samples[0], samples[1]],
                2 => [samples[0], samples[1], samples[2], max],
                _ => [samples[0], samples[1], samples[2], samples[3]],
            };
            let transparent = match &scan.trans_color {
                Some(t) if t.len() == 1 => t[0] == rgba[0],
                Some(t) => t[0] == rgba[0] && t[1] == rgba[1] && t[2] == rgba[2],
                None => false,
            };
            if transparent {
                out.copy_from_slice(&[0, 0, 0, 0]);
            } else {
                for (slot, value) in out.iter_mut().zip(rgba) {
                    *slot = scale(value);
                }
            }
        }
    }
    Ok(Image { width: scan.width, height: scan.height, data })
}

// ── 가림 영역 칠하기(옛 `paintMask`와 같게: JS 숫자 의미 그대로)

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b || (a == b && b == 0.0 && a.is_sign_positive()) {
        a
    } else {
        b
    }
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else {
        b
    }
}

/// JS `ToInt32`
fn to_int32(value: f64) -> i32 {
    if !value.is_finite() {
        return 0;
    }
    (value.trunc() as i128).rem_euclid(1i128 << 32) as u32 as i32
}

fn paint_mask(image: &mut Image, mask: &Mask) {
    let width = f64::from(image.width);
    let left = js_max(0.0, mask.x);
    let top = js_max(0.0, mask.y);
    let right = js_min(width, mask.x + mask.width);
    let bottom = js_min(f64::from(image.height), mask.y + mask.height);
    let len = image.data.len() as i64;
    // JS 반복문은 소수 좌표도 `y++`로 1씩 올린다(`top`이 0.5면 0.5, 1.5, ...). NaN이면 비교가 거짓이라 돌지 않는다
    let mut y = top;
    while y < bottom {
        let mut x = left;
        while x < right {
            // `(png.width * y + x) << 2`: 소수 합은 int32로 버리고 4배(int32로 감긴다). 범위 밖 쓰기는 JS 형식 배열처럼 버린다
            let index = i64::from(to_int32(width * y + x).wrapping_shl(2));
            for (offset, value) in [0u8, 0, 0, 255].into_iter().enumerate() {
                let at = index + offset as i64;
                if (0..len).contains(&at) {
                    image.data[at as usize] = value;
                }
            }
            x += 1.0;
        }
        y += 1.0;
    }
}

// ── pixelmatch 7.2.0(node_modules/pixelmatch/index.js)를 그대로 옮긴다. 옵션은 threshold만 쓰고 나머지는 기본값이다

const ALPHA: f64 = 0.1;

fn px(img: &[u8], i: usize) -> u32 {
    u32::from_ne_bytes([img[i * 4], img[i * 4 + 1], img[i * 4 + 2], img[i * 4 + 3]])
}

/// JS `(k / divisor | 0) % 2`. k는 4의 배수 바이트 위치
fn blend_background(k: usize) -> (i64, i64, i64) {
    let g = ((k as f64 / 1.618033988749895).trunc() as i64) % 2;
    let b = ((k as f64 / 2.618033988749895).trunc() as i64) % 2;
    (48 + 159 * (k as i64 % 2), 48 + 159 * g, 48 + 159 * b)
}

fn color_delta(img1: &[u8], img2: &[u8], k: usize) -> f64 {
    let (r1, g1, b1, a1) = (i64::from(img1[k]), i64::from(img1[k + 1]), i64::from(img1[k + 2]), i64::from(img1[k + 3]));
    let (r2, g2, b2, a2) = (i64::from(img2[k]), i64::from(img2[k + 1]), i64::from(img2[k + 2]), i64::from(img2[k + 3]));
    let mut dr = (r1 - r2) as f64;
    let mut dg = (g1 - g2) as f64;
    let mut db = (b1 - b2) as f64;
    let da = a1 - a2;
    if a1 < 255 || a2 < 255 {
        let (rb, gb, bb) = blend_background(k);
        dr = ((r1 * a1 - r2 * a2 - rb * da) as f64) / 255.0;
        dg = ((g1 * a1 - g2 * a2 - gb * da) as f64) / 255.0;
        db = ((b1 * a1 - b2 * a2 - bb * da) as f64) / 255.0;
    }
    let y = dr * 0.29889531 + dg * 0.58662247 + db * 0.11448223;
    let i = dr * 0.59597799 - dg * 0.27417610 - db * 0.32180189;
    let q = dr * 0.21147017 - dg * 0.52261711 + db * 0.31114694;
    let delta = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
    if y > 0.0 {
        -delta
    } else {
        delta
    }
}

fn brightness_delta(img: &[u8], k: usize, m: usize, c: [i64; 4]) -> f64 {
    let [r1, g1, b1, a1] = c;
    let (r2, g2, b2, a2) = (i64::from(img[m]), i64::from(img[m + 1]), i64::from(img[m + 2]), i64::from(img[m + 3]));
    let mut dr = (r1 - r2) as f64;
    let mut dg = (g1 - g2) as f64;
    let mut db = (b1 - b2) as f64;
    let da = a1 - a2;
    if r1 == r2 && g1 == g2 && b1 == b2 && da == 0 {
        return 0.0;
    }
    if a1 < 255 || a2 < 255 {
        let (rb, gb, bb) = blend_background(k);
        dr = ((r1 * a1 - r2 * a2 - rb * da) as f64) / 255.0;
        dg = ((g1 * a1 - g2 * a2 - gb * da) as f64) / 255.0;
        db = ((b1 * a1 - b2 * a2 - bb * da) as f64) / 255.0;
    }
    dr * 0.29889531 + dg * 0.58662247 + db * 0.11448223
}

fn has_many_siblings(img: &[u8], x1: usize, y1: usize, width: usize, height: usize) -> bool {
    let x0 = x1.saturating_sub(1);
    let y0 = y1.saturating_sub(1);
    let x2 = (x1 + 1).min(width - 1);
    let y2 = (y1 + 1).min(height - 1);
    let val = px(img, y1 * width + x1);
    let mut zeroes = u32::from(x1 == x0 || x1 == x2 || y1 == y0 || y1 == y2);
    for x in x0..=x2 {
        for y in y0..=y2 {
            if x == x1 && y == y1 {
                continue;
            }
            zeroes += u32::from(val == px(img, y * width + x));
            if zeroes > 2 {
                return true;
            }
        }
    }
    false
}

fn antialiased(img: &[u8], x1: usize, y1: usize, width: usize, height: usize, a32: &[u8], b32: &[u8]) -> bool {
    let x0 = x1.saturating_sub(1);
    let y0 = y1.saturating_sub(1);
    let x2 = (x1 + 1).min(width - 1);
    let y2 = (y1 + 1).min(height - 1);
    let pos4 = (y1 * width + x1) * 4;
    let center = [i64::from(img[pos4]), i64::from(img[pos4 + 1]), i64::from(img[pos4 + 2]), i64::from(img[pos4 + 3])];
    let mut zeroes = u32::from(x1 == x0 || x1 == x2 || y1 == y0 || y1 == y2);
    let (mut min, mut max) = (0.0f64, 0.0f64);
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (0usize, 0usize, 0usize, 0usize);
    for x in x0..=x2 {
        for y in y0..=y2 {
            if x == x1 && y == y1 {
                continue;
            }
            let delta = brightness_delta(img, pos4, (y * width + x) * 4, center);
            if delta == 0.0 {
                zeroes += 1;
                if zeroes > 2 {
                    return false;
                }
            } else if delta < min {
                min = delta;
                min_x = x;
                min_y = y;
            } else if delta > max {
                max = delta;
                max_x = x;
                max_y = y;
            }
        }
    }
    if min == 0.0 || max == 0.0 {
        return false;
    }
    (has_many_siblings(a32, min_x, min_y, width, height) && has_many_siblings(b32, min_x, min_y, width, height))
        || (has_many_siblings(a32, max_x, max_y, width, height) && has_many_siblings(b32, max_x, max_y, width, height))
}

fn draw_pixel(output: &mut [u8], pos: usize, r: u8, g: u8, b: u8) {
    output[pos] = r;
    output[pos + 1] = g;
    output[pos + 2] = b;
    output[pos + 3] = 255;
}

/// 출력은 Uint8 배열이라 실수는 0 쪽으로 버려 8비트로 감긴다(JS `ToUint8`)
fn draw_gray_pixel(img: &[u8], i: usize, output: &mut [u8]) {
    let val = 255.0 + (f64::from(img[i]) * 0.29889531 + f64::from(img[i + 1]) * 0.58662247 + f64::from(img[i + 2]) * 0.11448223 - 255.0) * ALPHA * f64::from(img[i + 3]) / 255.0;
    let gray = (val.trunc() as i64) as u8;
    draw_pixel(output, i, gray, gray, gray);
}

/// 다른 픽셀 수. `output`에는 차이 이미지를 그린다(RGBA8)
fn pixelmatch(img1: &[u8], img2: &[u8], output: &mut [u8], width: usize, height: usize, threshold: f64) -> u64 {
    let len = width * height;
    if (0..len).all(|i| px(img1, i) == px(img2, i)) {
        for i in 0..len {
            draw_gray_pixel(img1, i * 4, output);
        }
        return 0;
    }
    let max_delta = 35215.0 * threshold * threshold;
    let mut diff = 0u64;
    for i in 0..len {
        let pos = i * 4;
        let delta = if px(img1, i) == px(img2, i) { 0.0 } else { color_delta(img1, img2, pos) };
        if delta.abs() > max_delta {
            let x = i % width;
            let y = i / width;
            let excluded = antialiased(img1, x, y, width, height, img1, img2) || antialiased(img2, x, y, width, height, img2, img1);
            if excluded {
                draw_pixel(output, pos, 255, 255, 0);
            } else {
                // diffColorAlt 기본값이 diffColor라 어두워짐·밝아짐 모두 같은 빨강이다
                draw_pixel(output, pos, 255, 0, 0);
                diff += 1;
            }
        } else {
            draw_gray_pixel(img1, pos, output);
        }
    }
    diff
}

fn encode_png(width: u32, height: u32, data: &[u8]) -> Result<Vec<u8>, Error> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(|e| Error::Decode(format!("차이 PNG를 쓰지 못했습니다: {e}")))?;
        writer.write_image_data(data).map_err(|e| Error::Decode(format!("차이 PNG를 쓰지 못했습니다: {e}")))?;
    }
    Ok(out)
}

/// 실제 화면과 디자인 기준 이미지를 비교한다. 너비가 다르면 던진다. 높이는 짧은 쪽에 맞춘다.
/// `threshold`는 0~1의 유한한 수여야 한다(그 밖은 던진다. NaN이면 옛 코드는 어떤 차이도 세지 않고 통과시켰다)
pub fn compare(actual: &[u8], reference: &[u8], masks: &[Mask], threshold: f64) -> Result<Compared, Error> {
    if !(0.0..=1.0).contains(&threshold) {
        return Err(Error::Compare(format!("threshold는 0~1의 수여야 합니다 ({threshold})")));
    }
    let mut actual = decode(actual)?;
    let mut reference = decode(reference)?;
    if actual.width != reference.width {
        return Err(Error::Compare(format!(
            "이미지 너비가 다릅니다 (실제 {}px, 디자인 {}px). 뷰포트를 디자인 프레임 너비에 맞추세요",
            actual.width, reference.width
        )));
    }
    let width = actual.width;
    let height = actual.height.min(reference.height);
    for mask in masks {
        paint_mask(&mut actual, mask);
        paint_mask(&mut reference, mask);
    }
    let compared_pixels = u64::from(width) * u64::from(height);
    if compared_pixels == 0 {
        return Err(Error::Compare("비교한 픽셀이 없습니다".to_owned()));
    }
    let rows = width as usize * height as usize * 4;
    let mut output = vec![0u8; rows];
    let diff_pixels = pixelmatch(&actual.data[..rows], &reference.data[..rows], &mut output, width as usize, height as usize, threshold);
    Ok(Compared { diff_pixels, compared_pixels, width, height, diff: encode_png(width, height, &output)? })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(width: u32, height: u32, color: png::ColorType, depth: png::BitDepth, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(color);
        encoder.set_depth(depth);
        encoder.write_header().unwrap().write_image_data(data).unwrap();
        out
    }

    fn rgba(width: u32, height: u32, paint: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
        let mut data = Vec::new();
        for y in 0..height {
            for x in 0..width {
                data.extend(paint(x, y));
            }
        }
        encode(width, height, png::ColorType::Rgba, png::BitDepth::Eight, &data)
    }

    const WHITE: [u8; 4] = [255, 255, 255, 255];

    #[test]
    fn identical_images_have_no_difference() {
        let result = compare(&rgba(10, 10, |_, _| WHITE), &rgba(10, 10, |_, _| WHITE), &[], 0.1).unwrap();
        assert_eq!((result.diff_pixels, result.compared_pixels), (0, 100));
        assert_eq!(&result.diff[..8], &SIGNATURE);
    }

    #[test]
    fn a_square_counts_as_difference() {
        let actual = rgba(100, 100, |x, y| if x < 10 && y < 10 { [0, 0, 0, 255] } else { WHITE });
        let result = compare(&actual, &rgba(100, 100, |_, _| WHITE), &[], 0.1).unwrap();
        assert_eq!(result.diff_pixels, 100);
    }

    #[test]
    fn mask_hides_the_square() {
        let actual = rgba(100, 100, |x, y| if x < 10 && y < 10 { [0, 0, 0, 255] } else { WHITE });
        let mask = Mask { x: 0.0, y: 0.0, width: 10.0, height: 10.0 };
        assert_eq!(compare(&actual, &rgba(100, 100, |_, _| WHITE), &[mask], 0.1).unwrap().diff_pixels, 0);
    }

    #[test]
    fn width_mismatch_and_bad_threshold_throw() {
        let a = rgba(12, 10, |_, _| WHITE);
        let b = rgba(10, 10, |_, _| WHITE);
        assert!(matches!(compare(&a, &b, &[], 0.1), Err(Error::Compare(m)) if m.contains("실제 12px, 디자인 10px")));
        for bad in [f64::NAN, -0.1, 1.5, f64::INFINITY] {
            assert!(matches!(compare(&b, &b, &[], bad), Err(Error::Compare(_))));
        }
    }

    #[test]
    fn garbage_and_trailing_bytes_throw() {
        let ok = rgba(4, 4, |_, _| WHITE);
        assert!(matches!(compare(b"nope", &ok, &[], 0.1), Err(Error::Decode(_))));
        let mut trailing = ok.clone();
        trailing.push(0);
        assert!(matches!(compare(&trailing, &ok, &[], 0.1), Err(Error::Decode(_))));
        assert!(matches!(compare(&ok[..ok.len() - 5], &ok, &[], 0.1), Err(Error::Decode(_))));
    }

    #[test]
    fn huge_header_is_refused_before_decoding() {
        let mut png = Vec::new();
        png.extend(SIGNATURE);
        let mut ihdr = Vec::new();
        ihdr.extend(100_000u32.to_be_bytes());
        ihdr.extend(100_000u32.to_be_bytes());
        ihdr.extend([8, 6, 0, 0, 0]);
        png.extend(13u32.to_be_bytes());
        png.extend(b"IHDR");
        png.extend(&ihdr);
        png.extend(crc32(&[b"IHDR", &ihdr]).to_be_bytes());
        png.extend(0u32.to_be_bytes());
        png.extend(b"IEND");
        png.extend(crc32(&[b"IEND"]).to_be_bytes());
        assert!(matches!(compare(&png, &png, &[], 0.1), Err(Error::Compare(m)) if m.contains("너무 큽니다")));
    }

    #[test]
    fn pixel_cap_is_exact() {
        assert!(!too_large(MAX_PIXELS));
        assert!(too_large(MAX_PIXELS + 1));
        assert!(!too_large(0));
    }

    #[test]
    fn depth_scaling_matches_pngjs_rounding() {
        // 1비트·2비트·4비트·16비트 확대: floor(v*255/max+0.5)
        assert_eq!(scale_table(1), vec![0, 255]);
        assert_eq!(scale_table(2), vec![0, 85, 170, 255]);
        assert_eq!(scale_table(4)[7], 119);
        assert_eq!(scale_table(16)[128], 0);
        assert_eq!(scale_table(16)[129], 1);
    }

    #[test]
    fn js_number_semantics() {
        assert_eq!(to_int32(4294967296.0 + 5.0), 5);
        assert_eq!(to_int32(-1.9), -1);
        assert_eq!(to_int32(2147483648.0), i32::MIN);
        assert!(js_max(0.0, f64::NAN).is_nan());
        assert!(js_min(1.0, f64::NAN).is_nan());
    }

    /// 저장 블록 하나로 `payload`를 내는 zlib 스트림
    fn stored_zlib(payload: &[u8]) -> Vec<u8> {
        let len = payload.len() as u16;
        let mut out = vec![0x78, 0x01, 0x01];
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(payload);
        let (mut a, mut b) = (1u32, 0u32);
        for &byte in payload {
            a = (a + u32::from(byte)) % 65521;
            b = (b + a) % 65521;
        }
        out.extend_from_slice(&(b << 16 | a).to_be_bytes());
        out
    }

    #[test]
    fn 풀린_바이트가_상한을_넘으면_끝까지_세지_않고_거절한다() {
        let stream = stored_zlib(&[7u8; 100]);
        assert_eq!(zlib_output_len(&stream, 100), Ok(100));
        assert_eq!(zlib_output_len(&stream, 99), Err(OVER_LIMIT.to_owned()));
        assert_eq!(zlib_output_len(&stream, 10), Err(OVER_LIMIT.to_owned()));
    }
}
