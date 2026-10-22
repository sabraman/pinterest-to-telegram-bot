use crate::config::Config;
use crate::status::format_queue_finish_eta;
use crate::storage::Storage;
use chrono::Utc;
use frankenstein::client_ureq::Bot;
use frankenstein::methods::{GetUpdatesParams, SendMessageParams};
use frankenstein::types::Message;
use frankenstein::TelegramApi;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::thread::sleep;
use std::time::Duration;

#[derive(Debug)]
pub enum WorkerSignal {
    ForcePublish,
}

pub fn notify_admin(api: &Bot, admin_id: i64, text: &str) {
    let params = SendMessageParams::builder()
        .chat_id(admin_id)
        .text(text)
        .disable_notification(true)
        .build();
    let _ = api.send_message(&params);
}

pub fn handle_message(
    api: &Bot,
    config: &Config,
    storage: &Storage,
    tx_worker: &Sender<WorkerSignal>,
    message: &Message,
) {
    let text = match &message.text {
        Some(t) => t.trim(),
        None => return,
    };

    let chat_id = message.chat.id;
    let from_id = message.from.as_ref().map(|u| u.id as i64).unwrap_or(0);
    let is_admin = from_id == config.admin_id;

    let response = if text == "/start" {
        "Pinterest-to-Telegram Bot\n\nSend /help to view available commands".to_string()
    } else if text == "/help" {
        "Available commands:\n/status - Show system status\n/force_publish - Publish next pin (admin only)\n/clear - Clear storage (admin only)\n/reset_published - Reset publication status (admin only)".to_string()
    } else if text == "/status" {
        match storage.get_stats() {
            Ok(stats) => {
                let eta = format_queue_finish_eta(stats.pending, config.publish_poll_seconds as i64, Utc::now());
                format!(
                    "Statistics:\nTotal pins: {}\nPending: {}\nProcessing: {}\nPublished: {}\nFailed: {}\nSkipped: {}\nLast pending pin ETA: {}",
                    stats.total, stats.pending, stats.processing, stats.done, stats.failed, stats.skipped, eta
                )
            }
            Err(e) => format!("Error reading stats: {}", e),
        }
    } else if text == "/force_publish" {
        if !is_admin {
            "Access denied. Admin only command.".to_string()
        } else {
            let _ = tx_worker.send(WorkerSignal::ForcePublish);
            "Publish cycle triggered.".to_string()
        }
    } else if text == "/clear" {
        if !is_admin {
            "Access denied. Admin only command.".to_string()
        } else {
            match storage.clear_storage() {
                Ok(count) => format!("Storage cleared. Removed {} pins", count),
                Err(e) => format!("Error clearing storage: {}", e),
            }
        }
    } else if text == "/reset_published" {
        if !is_admin {
            "Access denied. Admin only command.".to_string()
        } else {
            match storage.reset_published() {
                Ok(count) => format!("Reset {} pins to pending.", count),
                Err(e) => format!("Error resetting pins: {}", e),
            }
        }
    } else {
        "Use /help to view available commands".to_string()
    };

    let params = SendMessageParams::builder()
        .chat_id(chat_id)
        .text(response)
        .build();
    let _ = api.send_message(&params);
}

pub fn run_telegram_poller(
    api: Arc<Bot>,
    config: Arc<Config>,
    storage: Storage,
    tx_worker: Sender<WorkerSignal>,
    running: Arc<AtomicBool>,
) {
    println!("Starting Telegram long-polling thread...");
    notify_admin(&api, config.admin_id, "Bot has been restarted");

    let mut offset: Option<i64> = None;

    while running.load(Ordering::SeqCst) {
        let params = match offset {
            Some(off) => GetUpdatesParams::builder().timeout(20u32).offset(off).build(),
            None => GetUpdatesParams::builder().timeout(20u32).build(),
        };

        match api.get_updates(&params) {
            Ok(response) => {
                for update in response.result {
                    offset = Some((update.update_id as i64) + 1);
                    let _ = UpdateContent::Message;
                }
            }
            Err(err) => {
                eprintln!("Error in get_updates: {:?}", err);
                sleep(Duration::from_secs(2));
            }
        }
    }

    println!("Telegram poller stopped cleanly.");
}
