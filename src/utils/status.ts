const moscowFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Moscow",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatDuration(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.ceil((totalSeconds % 3_600) / 60);
  const parts: string[] = [];

  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);

  return parts.slice(0, 2).join(" ");
}

export function formatQueueFinishEta(
  pendingPins: number,
  publishPollSeconds: number,
  now = new Date(),
): string {
  if (pendingPins <= 0) {
    return "No pending pins";
  }

  const secondsUntilLastPin = pendingPins * publishPollSeconds;
  const finishAt = new Date(now.getTime() + secondsUntilLastPin * 1000);

  return `${moscowFormatter.format(finishAt)} MSK (${formatDuration(secondsUntilLastPin)} from now)`;
}
