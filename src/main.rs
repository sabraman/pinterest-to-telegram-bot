mod config;
mod publisher;
mod rss;
mod scraper;
mod status;
mod storage;
mod telegram;
mod types;

use config::Config;
use frankenstein::client_ureq::Bot;
use publisher::publish_next_pin;
use rss::fetch_and_store_pins;
use status::format_rss_parsed_message;
use storage::Storage;
use telegram::{notify_admin, run_telegram_poller, WorkerSignal};

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Arc;
use std::thread::Builder;
use std::time::{Duration, Instant};

fn main() {
    println!("Pinterest-to-Telegram Rust Bot starting...");

    let config = match Config::from_env() {
        Ok(cfg) => Arc::new(cfg),
        Err(err) => {
            eprintln!("Configuration error: {}", err);
            std::process::exit(1);
        }
    };

    let storage = match Storage::open(Arc::clone(&config)) {
        Ok(st) => st,
        Err(err) => {
            eprintln!("Failed to open storage database: {}", err);
            std::process::exit(1);
        }
    };

    let api = Arc::new(Bot::new(&config.telegram_bot_token));

    let (tx_worker, rx_worker) = channel::<WorkerSignal>();
    let running = Arc::new(AtomicBool::new(true));

    // Handle signals for graceful shutdown
    let r_sig = Arc::clone(&running);
    let tx_sig = tx_worker.clone();
    if let Err(e) = ctrlc::set_handler(move || {
        println!("\nShutdown signal received. Exiting gracefully...");
        r_sig.store(false, Ordering::SeqCst);
        let _ = tx_sig.send(WorkerSignal::ForcePublish); // Wake worker
    }) {
        eprintln!("Error setting Ctrl-C handler: {}", e);
    }

    // 1. Spawn Telegram Poller Thread (512 KB Stack)
    let api_poller = Arc::clone(&api);
    let config_poller = Arc::clone(&config);
    let storage_poller = storage.clone();
    let running_poller = Arc::clone(&running);

    let poller_handle = Builder::new()
        .name("telegram_poller".to_string())
        .stack_size(512 * 1024)
        .spawn(move || {
            run_telegram_poller(
                api_poller,
                config_poller,
                storage_poller,
                tx_worker,
                running_poller,
            );
        })
        .expect("Failed to spawn telegram poller thread");

    // 2. Spawn Background Scheduler Thread (512 KB Stack)
    let api_worker = Arc::clone(&api);
    let config_worker = Arc::clone(&config);
    let storage_worker = storage.clone();
    let running_worker = Arc::clone(&running);

    let worker_handle = Builder::new()
        .name("background_scheduler".to_string())
        .stack_size(512 * 1024)
        .spawn(move || {
            let mut last_rss = Instant::now() - Duration::from_secs(config_worker.rss_poll_seconds);
            let mut last_publish = Instant::now();

            let rss_interval = Duration::from_secs(config_worker.rss_poll_seconds);
            let pub_interval = Duration::from_secs(config_worker.publish_poll_seconds);

            while running_worker.load(Ordering::SeqCst) {
                let now = Instant::now();

                // Run RSS poller tick
                if now.duration_since(last_rss) >= rss_interval {
                    last_rss = Instant::now();
                    match fetch_and_store_pins(&config_worker, &storage_worker) {
                        Ok(saved) => {
                            if saved > 0 {
                                if let Ok(stats) = storage_worker.get_stats() {
                                    let msg = format_rss_parsed_message(
                                        saved,
                                        stats.pending,
                                        config_worker.publish_poll_seconds as i64,
                                    );
                                    notify_admin(&api_worker, config_worker.admin_id, &msg);
                                }
                            }
                        }
                        Err(e) => eprintln!("RSS worker error: {}", e),
                    }
                }

                // Run publish worker tick
                if now.duration_since(last_publish) >= pub_interval {
                    last_publish = Instant::now();
                    let _ = publish_next_pin(&api_worker, &config_worker, &storage_worker);
                }

                // Sleep up to 1 second or respond to instant signal
                match rx_worker.recv_timeout(Duration::from_secs(1)) {
                    Ok(WorkerSignal::ForcePublish) => {
                        if running_worker.load(Ordering::SeqCst) {
                            println!("Immediate publish triggered via /force_publish");
                            last_publish = Instant::now();
                            let _ = publish_next_pin(&api_worker, &config_worker, &storage_worker);
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }

            println!("Background worker stopped cleanly.");
        })
        .expect("Failed to spawn worker scheduler thread");

    let _ = poller_handle.join();
    let _ = worker_handle.join();
    println!("Bot shutdown complete.");
}
