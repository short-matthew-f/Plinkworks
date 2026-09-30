// Share a machine as a compressed URL fragment: JSON → deflate-raw → base64url.
// Lossless, so a shared machine replays exactly the song its maker heard.
import { normalizeMachine, type Machine } from './machine';

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export async function encodeMachine(m: Machine): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(m));
  return toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
}

export async function decodeMachine(code: string): Promise<Machine> {
  const bytes = await pipe(fromBase64Url(code), new DecompressionStream('deflate-raw'));
  return normalizeMachine(JSON.parse(new TextDecoder().decode(bytes)));
}
