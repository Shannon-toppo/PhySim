use lua_runtime_core::screen_raster::ScreenRaster;
use lua_runtime_core::{LuaUnit, LuaUnitConfig};
use lua_runtime_core::types::CompositeSignal;
use std::collections::HashMap;
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = &args[1];
    let pages: u32 = args[2].parse().unwrap();
    let w: u32 = 96;
    let h: u32 = 96;
    let script = std::fs::read_to_string(path).unwrap();

    for page in 1..=pages {
        let mut unit = LuaUnit::new(LuaUnitConfig {
            script: script.clone(),
            properties: HashMap::new(),
            time_limit: Duration::from_millis(2000),
            modules: HashMap::new(),
            prelude: String::new(),
        });
        // Tap the right half (page - 1) times to advance; each tap needs a
        // released tick in between for the edge detector.
        for _ in 1..page {
            let mut on = CompositeSignal::default();
            on.booleans[0] = true;
            on.numbers[0] = w as f32;
            on.numbers[2] = (w - 4) as f32;
            unit.on_tick(&on);
            unit.on_tick(&CompositeSignal::default());
        }
        let mut r = ScreenRaster::new(w, h);
        unit.on_draw(w, h, &mut r);
        if unit.crashed() {
            println!("PAGE {page}: CRASH {:?}", unit.error_message());
            continue;
        }
        let logs = unit.drain_logs();
        if !logs.is_empty() { println!("PAGE {page} logs: {logs:?}"); }
        // PPM out
        let mut buf = format!("P6\n{w} {h}\n255\n").into_bytes();
        for px in r.rgba.chunks_exact(4) {
            buf.extend_from_slice(&px[0..3]);
        }
        let out = format!("{}_p{}.ppm", args[3], page);
        std::fs::write(&out, buf).unwrap();
        println!("PAGE {page}: ok -> {out}");
    }
}
