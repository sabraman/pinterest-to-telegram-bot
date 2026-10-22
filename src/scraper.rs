use crate::types::{MediaItem, MediaType};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

static URL_MEDIA_RE: OnceLock<Regex> = OnceLock::new();
static BLOCKED_IDS: OnceLock<HashSet<&'static str>> = OnceLock::new();

fn get_url_media_re() -> &'static Regex {
    URL_MEDIA_RE.get_or_init(|| {
        Regex::new(r#"(?i)https?://[^"'\\<>\s]+?\.(?:jpe?g|png|webp|gif|mp4|mov|webm)(?:\?[^"'\\<>\s]*)?"#).unwrap()
    })
}

fn get_blocked_ids() -> &'static HashSet<&'static str> {
    BLOCKED_IDS.get_or_init(|| {
        let mut set = HashSet::new();
        set.insert("d53b014d86a6b6761bf649a0ed813c2b");
        set
    })
}

pub fn media_type_from_url(url: &str) -> MediaType {
    let clean = url.split('?').next().unwrap_or(url).to_lowercase();
    if clean.ends_with(".gif") {
        MediaType::Animation
    } else if clean.ends_with(".mp4") || clean.ends_with(".mov") || clean.ends_with(".webm") {
        MediaType::Video
    } else {
        MediaType::Photo
    }
}

pub fn media_identity(url: &str) -> String {
    let clean = url.split('?').next().unwrap_or(url);
    if let Some(filename) = clean.split('/').last() {
        if let Some(pos) = filename.rfind('.') {
            return filename[..pos].to_string();
        }
        return filename.to_string();
    }
    url.to_string()
}

pub fn normalize_pinterest_image(url: &str) -> String {
    let no_spaces: String = url.chars().filter(|c| !c.is_whitespace()).collect();
    static REGEX: OnceLock<Regex> = OnceLock::new();
    let re = REGEX.get_or_init(|| Regex::new(r"/\d+x\d*/").unwrap());
    re.replace(&no_spaces, "/originals/").to_string()
}

pub fn is_content_media_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    if !lower.contains("i.pinimg.com") && !lower.contains("v.pinimg.com") {
        return false;
    }

    if lower.contains("/webapp/")
        || lower.contains("/upload/")
        || lower.contains("/_/_/")
        || lower.contains("_rs/")
        || lower.contains("favicon")
        || lower.contains("logo")
    {
        return false;
    }

    let id = media_identity(&lower);
    if get_blocked_ids().contains(id.as_str()) {
        return false;
    }

    true
}

fn media_rank(media_type: MediaType) -> u8 {
    match media_type {
        MediaType::Video => 3,
        MediaType::Animation => 2,
        MediaType::Photo => 1,
    }
}

pub fn unique_media_items(items: Vec<MediaItem>) -> Vec<MediaItem> {
    let mut map: HashMap<String, MediaItem> = HashMap::new();
    for item in items {
        if item.url.is_empty() {
            continue;
        }
        let identity = media_identity(&item.url);
        if let Some(existing) = map.get(&identity) {
            if media_rank(item.media_type) > media_rank(existing.media_type) {
                map.insert(identity, item);
            }
        } else {
            map.insert(identity, item);
        }
    }
    map.into_values().collect()
}

pub fn decode_html(val: &str) -> String {
    val.replace("&quot;", "\"")
        .replace("&#34;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("\\u002F", "/")
        .replace("\\/", "/")
}

pub fn extract_media_from_html(html: &str) -> Vec<MediaItem> {
    let decoded = decode_html(html);
    let re = get_url_media_re();

    let items: Vec<MediaItem> = re
        .find_iter(&decoded)
        .map(|m| m.as_str())
        .filter(|url| is_content_media_url(url))
        .map(|url| {
            let mtype = media_type_from_url(url);
            MediaItem {
                media_type: mtype,
                url: if mtype == MediaType::Photo {
                    normalize_pinterest_image(url)
                } else {
                    url.to_string()
                },
            }
        })
        .collect();

    unique_media_items(items)
}

pub fn resolve_pin_page_media(pin_url: &str, timeout_secs: u64) -> Result<Vec<MediaItem>, String> {
    let response = ureq::get(pin_url)
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .set("User-Agent", "pinterest-to-telegram-bot/1.0")
        .set("Accept", "text/html")
        .call()
        .map_err(|e| format!("Pinterest pin page fetch error: {}", e))?;

    let html = response
        .into_string()
        .map_err(|e| format!("Failed to read pin page body: {}", e))?;

    Ok(extract_media_from_html(&html))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_blocked_placeholder_is_rejected() {
        let blocked = "https://i.pinimg.com/originals/d5/3b/01/d53b014d86a6b6761bf649a0ed813c2b.jpg";
        assert!(!is_content_media_url(blocked));
    }

    #[test]
    fn test_valid_image_url_normalization() {
        let raw = "https://i.pinimg.com/236x/ab/cd/ef/abcdef12345.jpg";
        assert!(is_content_media_url(raw));
        assert_eq!(
            normalize_pinterest_image(raw),
            "https://i.pinimg.com/originals/ab/cd/ef/abcdef12345.jpg"
        );
    }
}
