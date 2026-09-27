/**
 * Water `image.rembg` fold — probe + admission when Generate is given an imageUrl.
 * Class still comes from the compile contract, never from the filename or prompt keywords.
 *
 * PNG: full local admission (alpha / border estimate). JPEG: SOF size floor only
 * (this decoder is PNG-only; a missing mask is recorded, not guessed). Other
 * formats fail closed.
 */

import { admitReference, type AdmissionReport } from "../../create/admission.js";
import { ADMISSION } from "../../create/quality/thresholds.js";

const FETCH_MS = 12_000;
const MIN_BYTES = 2_048;

export type WaterImageIntake =
  | { ok: true; report: AdmissionReport; contentType: string; byteLength: number }
  | { ok: false; message: string; report?: AdmissionReport };

function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1]!;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    if (i + 3 >= buf.length) break;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) break;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function looksPng(buf: Buffer, contentType: string): boolean {
  return (
    contentType.includes("png") ||
    (buf.length >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47)
  );
}

function looksJpeg(buf: Buffer, contentType: string): boolean {
  return contentType.includes("jpeg") || contentType.includes("jpg") || (buf[0] === 0xff && buf[1] === 0xd8);
}

/**
 * Fetch and admit a reference. Fail closed on dead URLs, tiny files, unreadable
 * dimensions, or PNG gate fails. JPEG must parse SOF dimensions. WebP/other
 * without a local decoder is not admitted (guessing a mask would defeat the gate).
 */
export async function admitWaterImageUrl(imageUrl: string): Promise<WaterImageIntake> {
  const url = imageUrl.trim();
  if (!url) return { ok: false, message: "Reference image URL is empty." };

  let bytes: Buffer;
  let contentType = "application/octet-stream";
  try {
    if (url.startsWith("data:image/")) {
      const comma = url.indexOf(",");
      if (comma < 0) return { ok: false, message: "Malformed data URL." };
      const header = url.slice(5, comma);
      contentType = header.split(";")[0] || "image/png";
      bytes = Buffer.from(url.slice(comma + 1), "base64");
    } else {
      const ctrl = AbortSignal.timeout(FETCH_MS);
      const res = await fetch(url, { signal: ctrl, redirect: "follow" });
      if (!res.ok) {
        return { ok: false, message: `Could not fetch the reference image (${res.status}).` };
      }
      contentType = (res.headers.get("content-type") || "application/octet-stream").split(";")[0]!.trim();
      bytes = Buffer.from(await res.arrayBuffer());
    }
  } catch (err: any) {
    return { ok: false, message: `Could not fetch the reference image (${err?.message || "network"}).` };
  }

  if (bytes.length < MIN_BYTES) {
    return { ok: false, message: "Reference image is too small to admit." };
  }

  if (looksPng(bytes, contentType)) {
    const report = await admitReference({ bytes, contentType: "image/png" });
    if (!report.admitted) {
      return {
        ok: false,
        message: report.reasons[0] || "Reference image failed admission.",
        report,
      };
    }
    return { ok: true, report, contentType: "image/png", byteLength: bytes.length };
  }

  if (looksJpeg(bytes, contentType)) {
    const dim = jpegDimensions(bytes);
    if (!dim) {
      return {
        ok: false,
        message: "JPEG reference could not be measured (no SOF dimensions). Supply an 8-bit PNG.",
        report: {
          admitted: false,
          maskSource: "none",
          width: 0,
          height: 0,
          foregroundRatio: null,
          largestBlobRatio: null,
          shortSidePx: null,
          failCodes: ["BAD_SILHOUETTE"],
          reasons: ["JPEG SOF dimensions were unreadable; admission fails closed."],
          mask: null,
        },
      };
    }
    const width = dim.width;
    const height = dim.height;
    const shortSidePx = Math.min(width, height);
    const failSize = shortSidePx < ADMISSION.minShortSidePx;
    const report: AdmissionReport = {
      admitted: !failSize,
      maskSource: "none",
      width,
      height,
      foregroundRatio: null,
      largestBlobRatio: null,
      shortSidePx,
      failCodes: failSize ? ["ADMISSION_SIZE"] : [],
      reasons: failSize
        ? [`Short side ${shortSidePx}px is below the ${ADMISSION.minShortSidePx}px floor.`]
        : ["JPEG reference admitted on size only; local mask is PNG-only so IoU is skipped."],
      mask: null,
    };
    if (!report.admitted) {
      return { ok: false, message: report.reasons[0] || "Reference image is too small.", report };
    }
    return { ok: true, report, contentType: "image/jpeg", byteLength: bytes.length };
  }

  return {
    ok: false,
    message: `Reference type ${contentType || "unknown"} cannot be measured locally. Supply an 8-bit PNG.`,
    report: {
      admitted: false,
      maskSource: "none",
      width: 0,
      height: 0,
      foregroundRatio: null,
      largestBlobRatio: null,
      shortSidePx: null,
      failCodes: ["BAD_SILHOUETTE"],
      reasons: [`No local decoder for ${contentType || "this format"}; admission fails closed.`],
      mask: null,
    },
  };
}
