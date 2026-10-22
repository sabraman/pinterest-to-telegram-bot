use crate::config::Config;
use crate::scraper::is_content_media_url;
use crate::storage::Storage;
use crate::types::{MediaItem, MediaType};
use frankenstein::client_ureq::Bot;
use frankenstein::input_file::FileUpload;
use frankenstein::input_media::{InputMediaPhoto, InputMediaVideo, MediaGroupInputMedia};
use frankenstein::methods::{
    SendAnimationParams, SendMediaGroupParams, SendPhotoParams, SendVideoParams,
};
use frankenstein::TelegramApi;
use std::thread::sleep;
use std::time::Duration;

#[derive(Debug)]
pub enum MediaCheckError {
    Permanent(String),
    Transient(String),
}

pub fn assert_media_available(url: &str, timeout_secs: u64) -> Result<(), MediaCheckError> {
    let timeout = Duration::from_secs(timeout_secs);
    let head_res = ureq::head(url)
        .timeout(timeout)
        .set("User-Agent", "pinterest-to-telegram-bot/1.0")
        .call();

    match head_res {
        Ok(res) => {
            if res.status() < 400 {
                return Ok(());
            } else if res.status() == 404 || res.status() == 403 || res.status() == 410 {
                return Err(MediaCheckError::Permanent(format!("Media returned HTTP {}", res.status())));
            }
        }
        Err(ureq::Error::Status(code, _)) if code == 404 || code == 403 || code == 410 => {
            return Err(MediaCheckError::Permanent(format!("Media returned HTTP {}", code)));
        }
        Err(_) => {
            // Head might not be supported or timed out, attempt byte range GET
        }
    }

    let range_res = ureq::get(url)
        .timeout(timeout)
        .set("User-Agent", "pinterest-to-telegram-bot/1.0")
        .set("Range", "bytes=0-0")
        .call();

    match range_res {
        Ok(res) => {
            if res.status() < 400 {
                Ok(())
            } else if res.status() == 404 || res.status() == 403 || res.status() == 410 {
                Err(MediaCheckError::Permanent(format!("Media returned HTTP {}", res.status())))
            } else {
                Err(MediaCheckError::Transient(format!("Media returned HTTP {}", res.status())))
            }
        }
        Err(ureq::Error::Status(code, _)) => {
            if code == 404 || code == 403 || code == 410 {
                Err(MediaCheckError::Permanent(format!("Media returned HTTP {}", code)))
            } else {
                Err(MediaCheckError::Transient(format!("Media returned HTTP {}", code)))
            }
        }
        Err(ureq::Error::Transport(e)) => {
            Err(MediaCheckError::Transient(format!("Network transport error: {}", e)))
        }
    }
}

pub fn send_media(api: &Bot, channel_id: &str, media_items: &[MediaItem]) -> Result<(), frankenstein::Error> {
    if media_items.len() > 1 && media_items.iter().all(|i| i.media_type == MediaType::Photo || i.media_type == MediaType::Video) {
        let group = media_items
            .iter()
            .take(10)
            .map(|item| {
                if item.media_type == MediaType::Video {
                    MediaGroupInputMedia::Video(InputMediaVideo::builder().media(FileUpload::String(item.url.clone())).build())
                } else {
                    MediaGroupInputMedia::Photo(InputMediaPhoto::builder().media(FileUpload::String(item.url.clone())).build())
                }
            })
            .collect::<Vec<_>>();

        let params = SendMediaGroupParams::builder()
            .chat_id(channel_id.to_string())
            .media(group)
            .build();

        api.send_media_group(&params)?;
        return Ok(());
    }

    if let Some(item) = media_items.first() {
        match item.media_type {
            MediaType::Video => {
                let params = SendVideoParams::builder()
                    .chat_id(channel_id.to_string())
                    .video(FileUpload::String(item.url.clone()))
                    .build();
                api.send_video(&params)?;
            }
            MediaType::Animation => {
                let params = SendAnimationParams::builder()
                    .chat_id(channel_id.to_string())
                    .animation(FileUpload::String(item.url.clone()))
                    .build();
                api.send_animation(&params)?;
            }
            MediaType::Photo => {
                let params = SendPhotoParams::builder()
                    .chat_id(channel_id.to_string())
                    .photo(FileUpload::String(item.url.clone()))
                    .build();
                api.send_photo(&params)?;
            }
        }
    }

    Ok(())
}

pub fn publish_next_pin(api: &Bot, config: &Config, storage: &Storage) -> Result<bool, String> {
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

    if media_to_publish.is_empty() {
        let err = "Pin has no media items".to_string();
        let _ = storage.mark_skipped(&pin.guid, &lock_token, &err);
        return Ok(false);
    }

    for item in &media_to_publish {
        if !is_content_media_url(&item.url) {
            let err = format!("Invalid Pinterest media URL: {}", item.url);
            let _ = storage.mark_skipped(&pin.guid, &lock_token, &err);
            return Ok(false);
        }

        if let Err(check_err) = assert_media_available(&item.url, config.fetch_timeout_seconds) {
            match check_err {
                MediaCheckError::Permanent(e) => {
                    let _ = storage.mark_skipped(&pin.guid, &lock_token, &e);
                }
                MediaCheckError::Transient(e) => {
                    let _ = storage.mark_failed(&pin.guid, &lock_token, &e);
                }
            }
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
            let is_permanent = match &e {
                frankenstein::Error::Api(api_err) => {
                    api_err.error_code == 400 || api_err.error_code == 404
                }
                _ => false,
            };
            let err_msg = format!("{:?}", e);
            if is_permanent {
                let _ = storage.mark_skipped(&pin.guid, &lock_token, &err_msg);
            } else {
                let _ = storage.mark_failed(&pin.guid, &lock_token, &err_msg);
            }
            Err(err_msg)
        }
    }
}
