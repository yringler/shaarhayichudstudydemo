/** Time formatting and `listen:` link parsing, shared by the loader and the client script. */

/** 252 → "4:12"; 3725 → "1:02:05". */
export function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export interface ListenRef {
  /** Source.key, e.g. "021". */
  source: string;
  seconds: number;
}

const LISTEN_RE = /^listen:(\d{3})#(\d+(?:\.\d+)?)$/;

/** "listen:021#252" → { source: "021", seconds: 252 }; anything else → null. */
export function parseListenHref(href: string): ListenRef | null {
  const m = LISTEN_RE.exec(href.trim());
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return { source: m[1], seconds: Number(m[2]) };
}

/** "021" → "21": how a class is named in print ("class 21, 4:12"). */
export function classNumber(key: string): string {
  return String(Number.parseInt(key, 10));
}

/** "§4" or "§2–3". */
export function segmentLabel(from: number, to: number): string {
  return from === to ? `§${from}` : `§${from}–${to}`;
}
