export type MediaType = "photo" | "video" | "animation";

export interface MediaItem {
  type: MediaType;
  url: string;
}

export interface Pin {
  guid: string;
  imageUrl: string;
  mediaType: MediaType;
  mediaItems: MediaItem[];
  sourceUrl?: string;
  published: boolean;
  pubDate: string;
}

export interface RssEntry {
  id?: string;
  guid?: string | { "#text"?: string; text?: string };
  link?: string;
  description?: string | { value?: string };
  pubDate?: string;
  published?: string;
}

export type PinStatus = "pending" | "processing" | "done" | "failed" | "skipped";

export interface PinRecord extends Pin {
  status: PinStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  publishedAt: string | null;
  lockToken: string | null;
}

export interface QueueStats {
  total: number;
  pending: number;
  processing: number;
  done: number;
  failed: number;
  skipped: number;
}
