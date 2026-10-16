use std::io::{self, BufRead, Read, Write};
use std::time::{Duration, Instant};
use anyhow::{Result, ensure};
use jagua_rs::io::import::Importer;
use jagua_rs::probs::spp::entities::{SPProblem, SPSolution};
use jagua_rs::probs::spp::io::{self as spp_io, ext_repr::{ExtSPInstance, ExtSPSolution}};
use rand::{SeedableRng, rngs::Xoshiro256PlusPlus};
use serde::Deserialize;
use sparrow::config::DEFAULT_SPARROW_CONFIG;
use sparrow::util::listener::{ReportType, SolutionListener};
use sparrow::util::terminator::{Terminator, BasicTerminator};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    instance: ExtSPInstance,
    solution: ExtSPSolution,
    warm_solution: Option<ExtSPSolution>,
    #[serde(default = "default_seed")] rng_seed: u64,
    time_budget_ms: u64,
    target_length_mm: Option<f32>,
    #[serde(default)] stop_at_target: bool,
}
fn default_seed() -> u64 { 42 }
struct Listener { best: f32, last: Instant, target: Option<f32>, reached: std::sync::Arc<std::sync::atomic::AtomicBool> }
impl SolutionListener for Listener {
    fn report(&mut self, kind: ReportType, solution: &SPSolution) {
        if !matches!(kind, ReportType::ExplFeas | ReportType::CmprFeas | ReportType::Final) { return; }
        let width = solution.strip_width();
        let better = width < self.best;
        let reached = self.target.is_some_and(|target| width < target);
        if reached { self.reached.store(true, std::sync::atomic::Ordering::Relaxed); }
        if kind == ReportType::Final || reached || (better && self.last.elapsed() >= Duration::from_millis(300)) {
            self.best = self.best.min(width); self.last = Instant::now();
            let message = serde_json::json!({"type":"solution", "solution": spp_io::export(solution, *sparrow::EPOCH)});
            println!("{}", message); let _ = io::stdout().flush();
        }
    }
}
struct Deadline { inner: BasicTerminator, global: Instant, reached: std::sync::Arc<std::sync::atomic::AtomicBool> }
impl Terminator for Deadline {
    fn kill(&self) -> bool { self.inner.kill() || Instant::now() >= self.global || self.reached.load(std::sync::atomic::Ordering::Relaxed) }
    fn new_timeout(&mut self, timeout: Duration) { self.inner.new_timeout(timeout); }
    fn timeout_at(&self) -> Option<jagua_rs::Instant> { self.inner.timeout_at() }
}
fn run() -> Result<()> {
    let mut text = String::new(); io::stdin().lock().take(64 * 1024 * 1024).read_line(&mut text)?;
    ensure!(text.ends_with('\n'), "request line missing or too large");
    let request: Request = serde_json::from_str(&text)?;
    // The worker keeps this pipe open and sends heartbeats. EOF handles normal
    // teardown; the watchdog also handles a killed JS thread whose parent process
    // still holds a pipe descriptor open.
    let heartbeat_clock = Instant::now();
    let last_heartbeat = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let received = last_heartbeat.clone();
    std::thread::spawn(move || { let mut bytes = [0u8; 64]; loop {
        match io::stdin().read(&mut bytes) {
            Ok(0) | Err(_) => std::process::exit(0),
            _ => received.store(heartbeat_clock.elapsed().as_millis() as u64, std::sync::atomic::Ordering::Relaxed),
        }
    }});
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(250));
        if heartbeat_clock.elapsed().as_millis() as u64 > last_heartbeat.load(std::sync::atomic::Ordering::Relaxed) + 3000 {
            std::process::exit(0);
        }
    });
    ensure!((100..=86_400_000).contains(&request.time_budget_ms), "invalid time budget");
    ensure!(!request.instance.items.is_empty() && request.instance.items.len() <= 2000, "invalid item count");
    let start = Instant::now();
    let mut config = DEFAULT_SPARROW_CONFIG;
    // Preserve the cut contours. Native collision tests and JS validation remain independent.
    config.poly_simpl_tolerance = None;
    config.narrow_concavity_cutoff_ratio = None;
    config.expl_cfg.separator_config.n_workers = 1;
    config.cmpr_cfg.separator_config.n_workers = 1;
    let importer = Importer::new(config.cde_config, config.poly_simpl_tolerance, config.narrow_concavity_cutoff_ratio);
    let instance = spp_io::import_instance(&importer, &request.instance)?;
    let mut initial = spp_io::import_solution(&instance, &request.solution)?;
    let feasible = |solution: &SPSolution| -> Result<bool> {
        let mut problem = SPProblem::new(instance.clone())?;
        problem.restore(solution);
        Ok(problem.layout().is_collision_free())
    };
    ensure!(feasible(&initial)?, "fallback start is not feasible");
    let mut warm_started = false;
    if let Some(warm) = request.warm_solution {
        if let Ok(candidate) = spp_io::import_solution(&instance, &warm) {
            if candidate.strip_width() < initial.strip_width() && feasible(&candidate)? {
                initial = candidate; warm_started = true;
            }
        }
    }
    println!("{}", serde_json::json!({"type":"start", "warmStarted":warm_started, "rngSeed":request.rng_seed}));
    let _ = io::stdout().flush();
    let remaining = Duration::from_millis(request.time_budget_ms).saturating_sub(start.elapsed());
    config.expl_cfg.time_limit = remaining.mul_f32(0.7);
    config.cmpr_cfg.time_limit = remaining.mul_f32(0.3);
    let reached = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut listener = Listener { best: f32::INFINITY, last: start - Duration::from_secs(1),
        target: if request.stop_at_target { request.target_length_mm } else { None }, reached: reached.clone() };
    let mut terminator = Deadline { inner: BasicTerminator::new(), global: start + Duration::from_millis(request.time_budget_ms), reached };
    let _ = sparrow::optimizer::optimize(instance, Xoshiro256PlusPlus::seed_from_u64(request.rng_seed), &mut listener,
        &mut terminator, &config.expl_cfg, &config.cmpr_cfg, Some(&initial))?;
    println!("{{\"type\":\"done\"}}");
    Ok(())
}
fn main() { if let Err(error) = run() { eprintln!("{error:#}"); std::process::exit(1); } }
