export interface Pin {
  guid: string;
  imageUrl: string;
  published: boolean;
  pubDate: Date;
}

export interface RssEntry {
  id: string;
  description?: { value?: string };
  published?: string | Date;
} 