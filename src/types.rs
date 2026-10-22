use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaType {
    Photo,
    Video,
    Animation,
}

impl Default for MediaType {
    fn default() -> Self {
        MediaType::Photo
    }
}

impl std::fmt::Display for MediaType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MediaType::Photo => write!(f, "photo"),
            MediaType::Video => write!(f, "video"),
            MediaType::Animation => write!(f, "animation"),
        }
    }
}

impl std::str::FromStr for MediaType {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "video" => Ok(MediaType::Video),
            "animation" => Ok(MediaType::Animation),
            _ => Ok(MediaType::Photo),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MediaItem {
    #[serde(rename = "type")]
    pub media_type: MediaType,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pin {
    pub guid: String,
    pub image_url: String,
    pub media_type: MediaType,
    pub media_items: Vec<MediaItem>,
    pub source_url: Option<String>,
    pub published: bool,
    pub pub_date: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PinStatus {
    Pending,
    Processing,
    Done,
    Failed,
    Skipped,
}

impl std::fmt::Display for PinStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PinStatus::Pending => write!(f, "pending"),
            PinStatus::Processing => write!(f, "processing"),
            PinStatus::Done => write!(f, "done"),
            PinStatus::Failed => write!(f, "failed"),
            PinStatus::Skipped => write!(f, "skipped"),
        }
    }
}

impl std::str::FromStr for PinStatus {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "processing" => Ok(PinStatus::Processing),
            "done" => Ok(PinStatus::Done),
            "failed" => Ok(PinStatus::Failed),
            "skipped" => Ok(PinStatus::Skipped),
            _ => Ok(PinStatus::Pending),
        }
    }
}

#[derive(Debug, Clone)]
pub struct PinRecord {
    pub pin: Pin,
    pub status: PinStatus,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub created_at: String,
    pub published_at: Option<String>,
    pub locked_until: Option<i64>,
    pub lock_token: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct QueueStats {
    pub total: i64,
    pub pending: i64,
    pub processing: i64,
    pub done: i64,
    pub failed: i64,
    pub skipped: i64,
}
