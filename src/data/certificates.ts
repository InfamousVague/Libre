/// Certificate awards for completed courses.
///
/// Earned when a learner completes every lesson in a course (the
/// same trigger as `SectionCompleteSummary` with `kind === "book"`).
/// Stored as a single JSON array under one localStorage key — small
/// N, simple list operations, atomic write. localStorage works
/// uniformly on the web build AND inside the Tauri WebView, which
/// matches the per-device "earned here" semantics (the meta-store
/// helpers in `lib/storage` are no-ops on desktop, so they don't
/// fit). Cloud sync is a deliberate follow-up so the issue date +
/// recipient name on a cert remain anchored to the device that
/// earned it.
///
/// The certificate captures user identity AT THE MOMENT OF ISSUE so
/// a later display-name change doesn't retroactively rewrite earlier
/// certificates — the printed PNG always reflects who the learner
/// was at the time they crossed the finish line.

import { profileKey } from "../lib/profileStore";

// Profile-scoped: certificates are earned per profile/account.
const STORAGE_KEY = profileKey("libre:certificates:v1");

export interface Certificate {
  /// Stable random id for this certificate. Used in the verify URL
  /// the QR code points at and as the React key on the listing
  /// page. crypto.randomUUID() under the hood.
  id: string;
  /// Pack id of the course the learner completed.
  courseId: string;
  /// Snapshot of the course title at issue time. We capture this
  /// (rather than looking it up at render time) so a future
  /// retitling of the course doesn't rewrite the printed cert.
  courseTitle: string;
  /// Course language (matches the BookCover language token).
  /// Drives the per-language accent colour on the printed cert.
  courseLanguage?: string;
  /// Recipient name, captured from `cloud.user.display_name` at
  /// issue time. Falls back to the email local-part or "Libre learner"
  /// when no identity is available (offline / signed-out finish).
  recipientName: string;
  /// Email, when available. Not printed on the cert face — used for
  /// the verify-URL payload so a scanned cert can be matched back
  /// to the issuing account if/when a verification endpoint ships.
  recipientEmail?: string;
  /// ISO timestamp the cert was minted — i.e. the moment the book
  /// flipped fully-complete.
  issuedAt: string;
  /// ISO timestamp of the FIRST lesson completion in this course.
  /// Captured at mint time by walking the completion history for the
  /// courseId and taking the minimum `completed_at`. Optional because
  /// older cert records (issued before this field shipped) won't
  /// have it; the ticket UI hides the start row when missing.
  startedAt?: string;
  /// Snapshot stats so the printed face can render without
  /// re-walking the course at print time.
  lessonCount: number;
  /// XP earned ACROSS the whole course at issue time. Pulled from
  /// the lesson-XP accumulator the mint trigger has in hand.
  xpEarned: number;
}

/// Read every certificate the user has earned, oldest-first. Returns
/// an empty list when the storage row is missing or malformed.
export async function listCertificates(): Promise<Certificate[]> {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Certificate[];
  } catch {
    return [];
  }
}

/// Persist a new certificate. Idempotent on `courseId` — if the user
/// already has a cert for the course, the existing one is returned
/// unchanged (replays of the same book-complete event don't mint
/// duplicates). Returns the resulting Certificate either way.
export async function mintCertificate(
  draft: Omit<Certificate, "id" | "issuedAt">,
): Promise<Certificate> {
  const existing = await listCertificates();
  const already = existing.find((c) => c.courseId === draft.courseId);
  if (already) return already;
  const cert: Certificate = {
    ...draft,
    id: makeCertId(),
    issuedAt: new Date().toISOString(),
  };
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...existing, cert]));
    } catch {
      // Quota exceeded / private mode — return the unwritten cert
      // anyway so the immediate UI flash works; the next mint pass
      // attempts the write again. Not worth surfacing to the user.
    }
  }
  return cert;
}

/// Drop every certificate from local storage. Wired into the
/// "Start fresh" account-reset path so a learner who wipes their
/// progress doesn't keep stale certs around for courses they no
/// longer have completed.
export async function clearCertificates(): Promise<void> {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* no-op */
  }
}

/// Convenience: short, URL-safe id. `crypto.randomUUID()` is
/// available in every shell we ship in (Tauri WebView's WebCrypto,
/// modern browsers). The dashes get stripped because the id ends up
/// in a verify URL query param and a hyphen-free string is easier
/// to eyeball in logs.
function makeCertId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  // Fallback for environments without crypto.randomUUID — extremely
  // rare on our deployed surfaces but worth handling for tests.
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/// Build the verification URL embedded in the cert's QR code. Points
/// at a (future) page on libre.academy that re-renders the cert
/// from the payload. Even before that page exists, the URL is
/// self-describing — a scan reveals the recipient + course + date
/// directly in the query params. Encoded as base64url so the whole
/// payload survives the QR's character set without escape weirdness.
export function buildVerifyUrl(cert: Certificate): string {
  const payload = {
    id: cert.id,
    user: cert.recipientName,
    course: cert.courseId,
    title: cert.courseTitle,
    started: cert.startedAt,
    date: cert.issuedAt,
    lessons: cert.lessonCount,
    xp: cert.xpEarned,
  };
  const json = JSON.stringify(payload);
  // btoa needs Latin-1; the payload is all ASCII-ish from the
  // controlled fields above (no user-supplied unicode in the schema),
  // but encodeURIComponent → unescape is the canonical "unicode-
  // safe base64" idiom in case a name field carries a non-ASCII
  // character down the line.
  const b64 = btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `https://libre.academy/verify?cert=${b64}`;
}
