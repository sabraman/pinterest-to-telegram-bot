use crate::config::Config;
use crate::scraper::{
    decode_html, extract_media_from_html, media_identity, normalize_pinterest_image,
    resolve_pin_page_media, unique_media_items,
};
use crate::storage::Storage;
use crate::types::{MediaItem, MediaType, Pin};
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use regex::Regex;
use std::collections::HashSet;
use std::sync::OnceLock;

pub fn parse_rss_xml(xml: &str) -> Vec<Pin> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut pins = Vec::new();
    let mut in_item = false;
    let mut current_tag = String::new();

    let mut guid = String::new();
    let mut link = String::new();
    let mut description = String::new();
    let mut pub_date = String::new();

    let mut buf = Vec::new();

    while let Ok(event) = reader.read_event_into(&mut buf) {
        match event {
            Event::Start(e) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name.eq_ignore_ascii_case("item") || name.eq_ignore_ascii_case("entry") {
                    in_item = true;
                    guid.clear();
                    link.clear();
                    description.clear();
                    pub_date.clear();
                } else if in_item {
                    current_tag = name;
                }
            }
            Event::Text(e) => {
                if in_item {
                    let text = e.unescape().unwrap_or_default().to_string();
                    match current_tag.to_lowercase().as_str() {
                        "guid" | "id" => guid.push_str(&text),
                        "link" => link.push_str(&text),
                        "description" | "content" | "summary" => description.push_str(&text),
                        "pubdate" | "published" | "updated" => pub_date.push_str(&text),
                        _ => {}
                    }
                }
            }
            Event::End(ref e) => {
                let qname = e.name();
                let name = String::from_utf8_lossy(qname.as_ref());
                if name.eq_ignore_ascii_case("item") || name.eq_ignore_ascii_case("entry") {
                    in_item = false;
                    let decoded_desc = decode_html(&description);
                    let mut media_items = extract_media_from_html(&decoded_desc);

                    // Additional regex check for src attributes
                    static SRC_RE: OnceLock<Regex> = OnceLock::new();
                    let src_re = SRC_RE.get_or_init(|| Regex::new(r#"src=["']([^"']+)["']"#).unwrap());
                    for cap in src_re.captures_iter(&decoded_desc) {
                        if let Some(src) = cap.get(1) {
                            let url = src.as_str().replace(char::is_whitespace, "");
                            if crate::scraper::is_content_media_url(&url) {
                                let mtype = crate::scraper::media_type_from_url(&url);
                                media_items.push(MediaItem {
                                    media_type: mtype,
                                    url: if mtype == MediaType::Photo {
                                        normalize_pinterest_image(&url)
                                    } else {
                                        url
                                    },
                                });
                            }
                        }
                    }

                    let unique_items = unique_media_items(media_items);
                    let primary_media = unique_items.first();

                    let effective_guid = if !guid.is_empty() {
                        guid.clone()
                    } else if !link.is_empty() {
                        link.clone()
                    } else if let Some(m) = primary_media {
                        m.url.clone()
                    } else {
                        String::new()
                    };

                    let image_url = primary_media.map(|m| m.url.clone()).unwrap_or_default();
                    let media_type = primary_media.map(|m| m.media_type).unwrap_or(MediaType::Photo);

                    pins.push(Pin {
                        guid: effective_guid,
                        image_url,
                        media_type,
                        media_items: unique_items,
                        source_url: if link.is_empty() { None } else { Some(link.clone()) },
                        published: false,
                        pub_date: pub_date.clone(),
                    });
                }
                current_tag.clear();
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    pins
}

pub fn fetch_and_store_pins(config: &Config, storage: &Storage) -> Result<usize, String> {
    println!("Downloading Pinterest RSS feed...");
    let response = ureq::get(&config.pinterest_rss_feed)
        .timeout(std::time::Duration::from_secs(config.fetch_timeout_seconds))
        .set("User-Agent", "pinterest-to-telegram-bot/1.0")
        .call()
        .map_err(|e| format!("Pinterest RSS returned error: {}", e))?;

    let xml = response
        .into_string()
        .map_err(|e| format!("Failed to read RSS body: {}", e))?;

    let entries = parse_rss_xml(&xml);
    let mut saved = 0;
    let mut skipped = 0;

    for mut pin in entries {
        if pin.guid.is_empty() {
            skipped += 1;
            continue;
        }

        let existing_pin = storage.get_pin(&pin.guid).unwrap_or(None);
        let should_enrich = match &existing_pin {
            None => true,
            Some(p) => {
                (p.status == crate::types::PinStatus::Pending || p.status == crate::types::PinStatus::Failed)
                    && p.pin.media_type == MediaType::Photo
            }
        };

        if should_enrich {
            if let Some(source_url) = &pin.source_url {
                if let Ok(resolved_media) = resolve_pin_page_media(source_url, config.fetch_timeout_seconds) {
                    let rss_identities: HashSet<String> = pin.media_items.iter().map(|i| media_identity(&i.url)).collect();
                    let matching_resolved: Vec<MediaItem> = resolved_media
                        .into_iter()
                        .filter(|item| rss_identities.contains(&media_identity(&item.url)))
                        .collect();

                    let mut combined = matching_resolved;
                    combined.extend(pin.media_items.clone());
                    let enriched = unique_media_items(combined);
                    if let Some(primary) = enriched.first() {
                        pin.media_type = primary.media_type;
                        pin.image_url = primary.url.clone();
                        pin.media_items = enriched;
                    }
                }
            }
        }

        if pin.media_items.is_empty() || pin.image_url.is_empty() {
            skipped += 1;
            continue;
        }

        if existing_pin.is_some() {
            let _ = storage.update_queued_pin_media(&pin);
            continue;
        }

        if storage.has_media_url(&pin.image_url, &pin.guid).unwrap_or(false) {
            skipped += 1;
            continue;
        }

        if storage.save_pin(&pin).unwrap_or(false) {
            saved += 1;
        }
    }

    println!("RSS parsed: {} saved, {} skipped", saved, skipped);
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_rss_sample() {
        let sample_xml = r#"
        <rss version="2.0">
            <channel>
                <item>
                    <guid>https://www.pinterest.com/pin/12345/</guid>
                    <link>https://www.pinterest.com/pin/12345/</link>
                    <description>&lt;img src="https://i.pinimg.com/originals/12/34/56/123456789.jpg" /&gt;</description>
                    <pubDate>Mon, 01 Jan 2026 00:00:00 +0000</pubDate>
                </item>
            </channel>
        </rss>"#;

        let pins = parse_rss_xml(sample_xml);
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].guid, "https://www.pinterest.com/pin/12345/");
        assert_eq!(pins[0].image_url, "https://i.pinimg.com/originals/12/34/56/123456789.jpg");
    }
}
