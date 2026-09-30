import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

/**
 * Server-side decoding of the PDF417 barcode on the back of a U.S. driver's license.
 * The image is decoded in memory and never written anywhere. Only the fields the
 * application form needs are returned; the rest of the AAMVA record is discarded
 * inside parseAamva and never logged.
 */
export interface LicenseFields { firstName: string; lastName: string; dateOfBirth: string; address1: string; city: string; state: string; zip: string }
export const LICENSE_FIELDS: (keyof LicenseFields)[] = ['firstName', 'lastName', 'dateOfBirth', 'address1', 'city', 'state', 'zip'];

let prepared = false;
function prepare(): void {
  if (prepared) return;
  const wasm = readFileSync(resolve(process.cwd(), 'node_modules/zxing-wasm/dist/reader/zxing_reader.wasm'));
  prepareZXingModule({ overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer } });
  prepared = true;
}

/**
 * Decode the barcode text from an image (PNG/JPEG bytes). Returns null when no PDF417 is
 * found. Whole-card phone photos leave the barcode small and unevenly lit, so several
 * binarizers are tried in turn; each attempt takes tens to a few hundred milliseconds.
 */
export async function decodePdf417(image: Buffer): Promise<string | null> {
  prepare();
  const blob = new Blob([new Uint8Array(image)]);
  for (const binarizer of ['LocalAverage', 'GlobalHistogram', 'FixedThreshold', 'BoolCast'] as const) {
    const results = await readBarcodes(blob, { formats: ['PDF417'], tryHarder: true, tryRotate: true, tryDownscale: true, maxNumberOfSymbols: 1, textMode: 'Plain', binarizer });
    const hit = results.find((r) => r.isValid && r.text);
    if (hit) return hit.text;
  }
  return null;
}

const title = (s: string) => s.toLowerCase().replace(/(^|[\s\-'])([a-z])/g, (_m, p, c) => p + c.toUpperCase());

/** Extract only the needed fields from an AAMVA record; everything else is dropped here. */
export function parseAamva(input: string): LicenseFields | null {
  if (!input) return null;
  // Some decoders render control characters as visible tokens; normalise them back.
  const raw = input.replace(/<LF>/g, '\n').replace(/<CR>/g, '\r').replace(/<RS>/g, '\x1e').replace(/<GS>/g, '\x1d');
  if (!/ANSI |AAMVA/.test(raw)) return null;
  const get = (code: string) => { const m = new RegExp('(?:^|[\\n\\r\\x1e])' + code + '([^\\n\\r]*)').exec(raw); return m ? m[1].trim() : ''; };
  let last = get('DCS');
  let first = get('DAC') || get('DCT').split(/[,\s]+/)[0] || '';
  if (!last && !first) { const full = get('DAA'); if (full) { const parts = full.split(/[,\s]+/).filter(Boolean); last = parts[0] ?? ''; first = parts[1] ?? ''; } }
  const dobRaw = get('DBB').replace(/\D/g, '');
  let dob = '';
  if (dobRaw.length === 8) dob = /^(19|20)\d\d/.test(dobRaw) ? `${dobRaw.slice(4, 6)}/${dobRaw.slice(6, 8)}/${dobRaw.slice(0, 4)}` : `${dobRaw.slice(0, 2)}/${dobRaw.slice(2, 4)}/${dobRaw.slice(4, 8)}`;
  const zipRaw = get('DAK').replace(/\D/g, '');
  const out: LicenseFields = {
    firstName: title(first.replace(/[^A-Za-z\-' ]/g, '').trim()),
    lastName: title(last.replace(/[^A-Za-z\-' ]/g, '').trim()),
    dateOfBirth: /^\d{2}\/\d{2}\/\d{4}$/.test(dob) ? dob : '',
    address1: title([get('DAG'), get('DAH')].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()),
    city: title(get('DAI').replace(/\s+/g, ' ').trim()),
    state: /^[A-Z]{2}$/.test(get('DAJ').toUpperCase()) ? get('DAJ').toUpperCase() : '',
    zip: /^\d{5}/.test(zipRaw) ? zipRaw.slice(0, 5) : '',
  };
  return out;
}

export async function scanLicense(image: Buffer): Promise<{ ok: true; fields: LicenseFields; missing: string[] } | { ok: false; error: 'NO_BARCODE' | 'NOT_A_LICENSE' }> {
  const text = await decodePdf417(image);
  if (!text) return { ok: false, error: 'NO_BARCODE' };
  const fields = parseAamva(text);
  if (!fields) return { ok: false, error: 'NOT_A_LICENSE' };
  const missing = LICENSE_FIELDS.filter((k) => !fields[k]);
  return { ok: true, fields, missing };
}
