import type { Pin } from "../types/index.ts";

const kv = await Deno.openKv();

export async function clearStorage(): Promise<number> {
  let count = 0;
  for await (const entry of kv.list({ prefix: ["pins"] })) {
    await kv.delete(entry.key);
    count++;
  }
  return count;
}

export async function countPins(): Promise<number> {
  let count = 0;
  for await (const _ of kv.list({ prefix: ["pins"] })) count++;
  return count;
}

export async function countUnpublishedPins(): Promise<number> {
  let count = 0;
  for await (const entry of kv.list<Pin>({ prefix: ["pins"] })) {
    if (!entry.value.published) count++;
  }
  return count;
}

export async function savePin(pin: Pin): Promise<void> {
  await kv.set(["pins", pin.guid], pin);
}

export async function updatePinStatus(guid: string, published: boolean): Promise<void> {
  const entry = await kv.get<Pin>(["pins", guid]);
  if (entry.value) {
    await kv.set(["pins", guid], { ...entry.value, published });
  }
}

export async function getUnpublishedPins(): Promise<Pin[]> {
  const pins: Pin[] = [];
  for await (const entry of kv.list<Pin>({ prefix: ["pins"] })) {
    if (!entry.value.published) {
      pins.push(entry.value);
    }
  }
  return pins;
}

export async function getPinByGuid(guid: string): Promise<Pin | null> {
  const entry = await kv.get<Pin>(["pins", guid]);
  return entry.value || null;
} 