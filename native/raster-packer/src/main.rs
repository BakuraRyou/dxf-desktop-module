use std::io::{Read, Write};

fn main() {
    let mut input = Vec::new();
    if std::io::stdin().read_to_end(&mut input).is_err() {
        std::process::exit(2);
    }
    match dxf_raster_core::pack_binary(&input) {
        Ok(output) => {
            if std::io::stdout().write_all(&output).is_err() {
                std::process::exit(3);
            }
        }
        Err(_) => std::process::exit(4),
    }
}
