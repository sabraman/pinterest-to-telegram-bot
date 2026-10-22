use crate::config::Config;
use crate::scraper::is_content_media_url;
use crate::storage::Storage;
use crate::types::{MediaItem, MediaType};
use frankenstein::{
    Api, InputMedia, InputMediaPhoto, InputMediaVideo, SendAnimationParams, SendMediaGroupParams,
    SendPhotoParams, SendVideoParams, TelegramApi,
};
use std::thread::sleep;
use std::time::Duration;

pub fn assert_media_available(url: &str, timeout_secs: u64) -> Result<(), String> {
    let timeout = Duration::from_secs(timeout_secs);
    let head_res = ureq::head(url)
        .timeout(timeout)
        .set("User-Agent", "pinterest-to-telegram-bot/1.0")
        .call();

    if let Ok(res) = head_res {
        if res.status() < 400 {
            return Ok(());
        }
    }

    let range_res = ureq::get(url)
        .timeout(timeout)
        .set("User-Agent", "pinterest-to-telegram-bot/1.0")
        .set("Range", "bytes=0-0")
        .call()
        .map_err(|e| format!("Media returned HTTP error: {}", e))?;

    if range_res.status() < 400 {
        Ok(())
    } else {
        Err(format!("Media returned HTTP {}", range_res.status()))
    }
}

pub fn send_media(api: &Api, channel_id: &str, media_items: &[MediaItem]) -> Result<(), String> {
    if media_items.is_empty() {
        return Err("Pin has no media items".to_string());
    }

    if media_items.len() > 1 && media_items.iter().all(|i| i.media_type == MediaType::Photo || i.media_type == MediaType::Video) {
        let group: Vec<InputMedia> = media_items
            .iter()
            .take(10)
            .map(|item| {
                if item.media_type == MediaType::Video {
                    InputMedia::Video(InputMediaVideo::builder().media(item.url.clone()).build())
                } else {
                    InputMedia::Photo(InputMediaPhoto::builder().media(item.url.clone()).build())
                }
            })
            .collect();

        let params = SendMediaGroupParams::builder()
            .chat_id(channel_id.to_string())
            .media(group)
            .build();

        api.send_media_group(&params)
            .map_err(|e| format!("Failed to send media group: {:?}", e))?;
        return Ok(());
    }

    let item = &media_items[0];
    match item.media_type {
        MediaType::Video => {
            let params = SendVideoParams::builder()
                .chat_id(channel_id.to_string())
                .video(item.url.clone())
                .build();
            api.send_video(&params)
                .map_err(|e| format!("Failed to send video: {:?}", e))?;
        }
        MediaType::Animation => {
            let params = SendAnimationParams::builder()
                .chat_id(channel_id.to_string())
                .animation(item.url.clone())
                .build();
            api.send_animation(&params)
                .map_err(|e| format!("Failed to send animation: {:?}", e))?;
        }
        MediaType::Photo => {
            let params = SendPhotoParams::builder()
                .chat_id(channel_id.to_string())
                .photo(item.url.clone())
                .build();
            api.send_photo(&params)
                .map_err(|e| format!("Failed to send photo: {:?}", e))?;
        }
    }

    Ok(())
}

pub fn publish_next_pin(api: &Api, config: &Config, storage: &Storage) -> Result<bool, String> {
    let pin_record = match storage.claim_next_pin() {
        Ok(Some(record)) => record,
        Ok(None) => {
            println!("Publish queue is empty");
            return Ok(false);
        }
        Err(e) => return Err(format!("Storage error claiming pin: {}", e)),
    };

    let pin = pin_record.pin;
    let lock_token = pin_record.lock_token.unwrap_or_default();
    println!("Publishing pin {} (attempt {})", pin.guid, pin_record.attempts);

    let media_to_publish = if pin.media_items.iter().all(|i| i.media_type == MediaType::Photo || i.media_type == MediaType::Video) {
        pin.media_items.into_iter().take(10).collect::<Vec<_>>()
    } else {
        pin.media_items.into_iter().take(1).collect::<Vec<_>>()
    };

    for item in &media_to_publish {
        if !is_content_media_url(&item.url) {
            let err = format!("Invalid Pinterest media URL: {}", item.url);
            let _ = storage.mark_skipped(&pin.guid, &lock_token, &err);
            return Ok(false);
        }

        if let Err(e) = assert_media_available(&item.url, config.fetch_timeout_seconds) {
            let _ = storage.mark_skipped(&pin.guid, &lock_token, &e);
            return Ok(false);
        }
    }

    match send_media(api, &config.telegram_channel_id, &media_to_publish) {
        Ok(_) => {
            let _ = storage.mark_published(&pin.guid, &lock_token);
            println!("Published pin {}", pin.guid);
            sleep(Duration::from_millis(config.publish_send_delay_ms));
            Ok(true)
        }
        Err(e) => {
            if e.contains("400") || e.contains("404") {
                let _ = storage.mark_skipped(&pin.guid, &lock_token, &e);
            } else {
                let _ = storage.mark_failed(&pin.guid, &lock_token, &e);
            }
            Err(e)
        }
    }
}
