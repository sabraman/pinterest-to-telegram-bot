use chrono::{DateTime, Duration, Utc};
use chrono_tz::Europe::Moscow;

pub fn format_duration(total_seconds: i64) -> String {
    let days = total_seconds / 86_400;
    let hours = (total_seconds % 86_400) / 3_600;
    let minutes = ((total_seconds % 3_600) + 59) / 60;

    let mut parts = Vec::new();
    if days > 0 {
        parts.push(format!("{}d", days));
    }
    if hours > 0 {
        parts.push(format!("{}h", hours));
    }
    if minutes > 0 || parts.is_empty() {
        parts.push(format!("{}m", minutes));
    }

    parts.into_iter().take(2).collect::<Vec<_>>().join(" ")
}

pub fn format_queue_finish_eta(pending_pins: i64, publish_poll_seconds: i64, now: DateTime<Utc>) -> String {
    if pending_pins <= 0 {
        return "No pending pins".to_string();
    }

    let seconds_until_last_pin = pending_pins * publish_poll_seconds;
    let finish_at = now + Duration::seconds(seconds_until_last_pin);
    let msk_finish = finish_at.with_timezone(&Moscow);

    format!(
        "{}, {:02}:{:02} MSK ({} from now)",
        msk_finish.format("%Y-%m-%d"),
        msk_finish.format("%H"),
        msk_finish.format("%M"),
        format_duration(seconds_until_last_pin)
    )
}

pub fn format_rss_parsed_message(saved_pins: usize, pending_pins: i64, publish_poll_seconds: i64) -> String {
    format!(
        "RSS parsed. Saved {} new pins.\nLast pending pin ETA: {}",
        saved_pins,
        format_queue_finish_eta(pending_pins, publish_poll_seconds, Utc::now())
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn test_format_queue_finish_eta() {
        let base_time = Utc.with_ymd_and_hms(2026, 5, 10, 0, 0, 0).unwrap();
        // 3 pins * 900s = 2700s (45m). Moscow is UTC+3 => 03:45 MSK
        let eta = format_queue_finish_eta(3, 900, base_time);
        assert_eq!(eta, "2026-05-10, 03:45 MSK (45m from now)");
    }

    #[test]
    fn test_format_queue_finish_eta_empty() {
        let base_time = Utc.with_ymd_and_hms(2026, 5, 10, 0, 0, 0).unwrap();
        let eta = format_queue_finish_eta(0, 900, base_time);
        assert_eq!(eta, "No pending pins");
    }
}
