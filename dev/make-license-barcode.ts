/**
 * Writes a PDF417 barcode PNG containing a SYNTHETIC AAMVA driver's-license record
 * (fictional person) for testing the in-browser license autofill. Never use real data here.
 *   npx tsx dev/make-license-barcode.ts <out.png>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prepareZXingModule, writeBarcode } from 'zxing-wasm/writer';

// Load the writer's WebAssembly from node_modules instead of a CDN.
const wasm = readFileSync(resolve(process.cwd(), 'node_modules/zxing-wasm/dist/writer/zxing_writer.wasm'));
prepareZXingModule({ overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer } });

const LF = '\n', RS = '\x1e', CR = '\r';
const dl = [
  'DAQD12345678', 'DCSDOE', 'DDEN', 'DACJANE', 'DDFN', 'DADQUINCY', 'DDGN', 'DCAD', 'DCBNONE', 'DCDNONE',
  'DBD08242021', 'DBB01141990', 'DBA01142028', 'DBC2', 'DAU065 in', 'DAYBRO',
  'DAG8655 BAY PKWY', 'DAHAPT F3', 'DAIBROOKLYN', 'DAJNY', 'DAK112140000  ', 'DCF1234567890', 'DCGUSA', 'DAW135', 'DAZBRO', 'DCK123456789012',
].join(LF) + LF;
const subfile = 'DL' + dl;
const header = `@${LF}${RS}${CR}ANSI 636001090002DL00410${String(subfile.length).padStart(4, '0')}${RS}`;
const record = header + subfile + CR;

const out = process.argv[2] ?? 'license-test.png';
const res = await writeBarcode(record, { format: 'PDF417', scale: 3, ecLevel: '4' });
writeFileSync(out, Buffer.from(await res.image!.arrayBuffer()));
console.log(`wrote ${out} (${record.length} chars encoded; fictional data)`);
