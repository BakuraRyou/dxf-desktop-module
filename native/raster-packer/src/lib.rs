use std::convert::TryInto;

const INPUT_MAGIC: u32 = u32::from_le_bytes(*b"DXFP");
const OUTPUT_MAGIC: u32 = u32::from_le_bytes(*b"DXFR");
const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug)]
pub enum PackError {
    InvalidInput(&'static str),
    Impossible,
}

#[derive(Clone)]
struct Variant {
    mask_width: usize,
    mask_height: usize,
    width: f64,
    rows: Vec<u32>,
    row_words: usize,
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take<const N: usize>(&mut self) -> Result<[u8; N], PackError> {
        let end = self
            .offset
            .checked_add(N)
            .ok_or(PackError::InvalidInput("input offset overflow"))?;
        let slice = self
            .bytes
            .get(self.offset..end)
            .ok_or(PackError::InvalidInput("truncated input"))?;
        self.offset = end;
        Ok(slice
            .try_into()
            .map_err(|_| PackError::InvalidInput("invalid input field"))?)
    }

    fn u32(&mut self) -> Result<u32, PackError> {
        Ok(u32::from_le_bytes(self.take()?))
    }

    fn f64(&mut self) -> Result<f64, PackError> {
        Ok(f64::from_le_bytes(self.take()?))
    }
}

fn push_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn mask_fits(
    occupancy: &[u32],
    occupancy_words: usize,
    variant: &Variant,
    cell_x: usize,
    cell_y: usize,
) -> bool {
    let word_offset = cell_x >> 5;
    let bit_offset = cell_x & 31;

    for y in 0..variant.mask_height {
        let target_row = (cell_y + y) * occupancy_words;
        let source_row = y * variant.row_words;
        for word in 0..variant.row_words {
            let value = variant.rows[source_row + word];
            if value == 0 {
                continue;
            }
            let target_word = word_offset + word;
            if (value << bit_offset) & occupancy[target_row + target_word] != 0 {
                return false;
            }
            if bit_offset > 0
                && target_word + 1 < occupancy_words
                && (value >> (32 - bit_offset))
                    & occupancy[target_row + target_word + 1]
                    != 0
            {
                return false;
            }
        }
    }
    true
}

fn place_mask(
    occupancy: &mut [u32],
    occupancy_words: usize,
    variant: &Variant,
    cell_x: usize,
    cell_y: usize,
) {
    let word_offset = cell_x >> 5;
    let bit_offset = cell_x & 31;

    for y in 0..variant.mask_height {
        let target_row = (cell_y + y) * occupancy_words;
        let source_row = y * variant.row_words;
        for word in 0..variant.row_words {
            let value = variant.rows[source_row + word];
            if value == 0 {
                continue;
            }
            let target_word = word_offset + word;
            occupancy[target_row + target_word] |= value << bit_offset;
            if bit_offset > 0 && target_word + 1 < occupancy_words {
                occupancy[target_row + target_word + 1] |= value >> (32 - bit_offset);
            }
        }
    }
}

pub fn pack_binary(input: &[u8]) -> Result<Vec<u8>, PackError> {
    let mut reader = Reader::new(input);
    if reader.u32()? != INPUT_MAGIC {
        return Err(PackError::InvalidInput("invalid protocol magic"));
    }
    if reader.u32()? != PROTOCOL_VERSION {
        return Err(PackError::InvalidInput("unsupported protocol version"));
    }

    let fabric_cells = reader.u32()? as usize;
    let fabric_width = reader.f64()?;
    let cell = reader.f64()?;
    let item_count = reader.u32()? as usize;
    if fabric_cells == 0 || !fabric_width.is_finite() || !cell.is_finite() || cell <= 0.0 {
        return Err(PackError::InvalidInput("invalid fabric dimensions"));
    }

    let mut items = Vec::with_capacity(item_count);
    for _ in 0..item_count {
        let variant_count = reader.u32()? as usize;
        if variant_count == 0 {
            return Err(PackError::Impossible);
        }
        let mut variants = Vec::with_capacity(variant_count);
        for _ in 0..variant_count {
            let mask_width = reader.u32()? as usize;
            let mask_height = reader.u32()? as usize;
            let row_words = reader.u32()? as usize;
            let width = reader.f64()?;
            let expected_words = mask_height
                .checked_mul(row_words)
                .ok_or(PackError::InvalidInput("mask size overflow"))?;
            if mask_width == 0
                || mask_height == 0
                || row_words != mask_width.div_ceil(32)
                || !width.is_finite()
            {
                return Err(PackError::InvalidInput("invalid variant"));
            }
            let mut rows = Vec::with_capacity(expected_words);
            for _ in 0..expected_words {
                rows.push(reader.u32()?);
            }
            variants.push(Variant {
                mask_width,
                mask_height,
                width,
                rows,
                row_words,
            });
        }
        variants.sort_by(|left, right| {
            left.mask_height
                .cmp(&right.mask_height)
                .then_with(|| right.mask_width.cmp(&left.mask_width))
        });
        items.push(variants);
    }

    if reader.offset != input.len() {
        return Err(PackError::InvalidInput("unexpected trailing input"));
    }

    let occupancy_words = fabric_cells.div_ceil(32).max(1);
    let mut occupancy: Vec<u32> = Vec::new();
    let mut occupied_height = 0usize;
    let mut choices: Vec<(usize, usize, usize, usize)> = Vec::with_capacity(item_count);

    for variants in &items {
        let mut best: Option<(usize, usize, usize, usize)> = None;

        for (variant_index, variant) in variants.iter().enumerate() {
            let required_rows = occupied_height + variant.mask_height;
            let required_words = required_rows
                .checked_mul(occupancy_words)
                .ok_or(PackError::InvalidInput("occupancy size overflow"))?;
            if occupancy.len() < required_words {
                occupancy.resize(required_words, 0);
            }

            let max_x = match fabric_cells.checked_sub(variant.mask_width) {
                Some(value) => value,
                None => continue,
            };
            let mut found = false;
            for y in 0..=occupied_height {
                for x in 0..=max_x {
                    let physical_left = x as f64 * cell;
                    if physical_left < -1e-6
                        || physical_left + variant.width > fabric_width + 1e-6
                        || !mask_fits(&occupancy, occupancy_words, variant, x, y)
                    {
                        continue;
                    }
                    let top = occupied_height.max(y + variant.mask_height);
                    let is_better = match best {
                        None => true,
                        Some((current_variant, current_x, current_y, current_top)) => {
                            let current = &variants[current_variant];
                            top < current_top
                                || (top == current_top && y < current_y)
                                || (top == current_top
                                    && y == current_y
                                    && variant.mask_height < current.mask_height)
                                || (top == current_top
                                    && y == current_y
                                    && variant.mask_height == current.mask_height
                                    && variant.mask_width > current.mask_width)
                                || (top == current_top
                                    && y == current_y
                                    && variant.mask_height == current.mask_height
                                    && variant.mask_width == current.mask_width
                                    && x < current_x)
                        }
                    };
                    if is_better {
                        best = Some((variant_index, x, y, top));
                    }
                    found = true;
                    break;
                }
                if found {
                    break;
                }
            }
        }

        let (variant_index, x, y, top) = best.ok_or(PackError::Impossible)?;
        let variant = &variants[variant_index];
        place_mask(
            &mut occupancy,
            occupancy_words,
            variant,
            x,
            y,
        );
        choices.push((variant_index, x, y, top));
        occupied_height = top;
    }

    let mut output = Vec::with_capacity(12 + choices.len() * 16);
    push_u32(&mut output, OUTPUT_MAGIC);
    push_u32(&mut output, PROTOCOL_VERSION);
    push_u32(&mut output, choices.len() as u32);
    for (variant_index, x, y, top) in choices {
        push_u32(&mut output, variant_index as u32);
        push_u32(&mut output, x as u32);
        push_u32(&mut output, y as u32);
        push_u32(&mut output, top as u32);
    }
    Ok(output)
}

static mut LAST_RESULT_LEN: usize = 0;

#[no_mangle]
pub extern "C" fn dxf_alloc(length: usize) -> *mut u8 {
    let mut bytes = Vec::<u8>::with_capacity(length);
    let pointer = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    pointer
}

#[no_mangle]
pub unsafe extern "C" fn dxf_dealloc(pointer: *mut u8, length: usize) {
    if !pointer.is_null() && length > 0 {
        drop(Vec::from_raw_parts(pointer, length, length));
    }
}

#[no_mangle]
pub unsafe extern "C" fn dxf_pack(pointer: *const u8, length: usize) -> *mut u8 {
    let input = std::slice::from_raw_parts(pointer, length);
    match pack_binary(input) {
        Ok(mut output) => {
            LAST_RESULT_LEN = output.len();
            let result_pointer = output.as_mut_ptr();
            std::mem::forget(output);
            result_pointer
        }
        Err(_) => {
            LAST_RESULT_LEN = 0;
            std::ptr::null_mut()
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn dxf_result_len() -> usize {
    LAST_RESULT_LEN
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request_for_two_rectangles() -> Vec<u8> {
        let mut input = Vec::new();
        push_u32(&mut input, INPUT_MAGIC);
        push_u32(&mut input, PROTOCOL_VERSION);
        push_u32(&mut input, 68);
        input.extend_from_slice(&204f64.to_le_bytes());
        input.extend_from_slice(&3f64.to_le_bytes());
        push_u32(&mut input, 2);
        for _ in 0..2 {
            push_u32(&mut input, 1);
            push_u32(&mut input, 34);
            push_u32(&mut input, 34);
            push_u32(&mut input, 2);
            input.extend_from_slice(&102f64.to_le_bytes());
            for _ in 0..34 {
                push_u32(&mut input, u32::MAX);
                push_u32(&mut input, 0b11);
            }
        }
        input
    }

    #[test]
    fn places_two_exact_width_rectangles_side_by_side() {
        let output = pack_binary(&request_for_two_rectangles()).unwrap();
        assert_eq!(u32::from_le_bytes(output[8..12].try_into().unwrap()), 2);
        assert_eq!(u32::from_le_bytes(output[20..24].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(output[32..36].try_into().unwrap()), 34);
        assert_eq!(u32::from_le_bytes(output[36..40].try_into().unwrap()), 0);
    }
}
