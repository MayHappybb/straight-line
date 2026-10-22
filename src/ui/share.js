// Share links: code + car live in the URL fragment (never sent to a server).

const b64url = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const unb64url = (str) => {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

export async function encodeState({ code, carSeed, runSeed, trackLength, noise }) {
  const params = new URLSearchParams();
  params.set('car', String(carSeed));
  if (runSeed) params.set('on', String(runSeed));
  params.set('L', String(trackLength));
  params.set('noise', String(noise));
  const raw = new TextEncoder().encode(code);
  if (typeof CompressionStream !== 'undefined') {
    params.set('z', b64url(await pipe(raw, new CompressionStream('deflate-raw'))));
  } else {
    params.set('c', b64url(raw));
  }
  return `#${params.toString()}`;
}

export async function decodeState(hash) {
  if (!hash || hash.length < 2) return null;
  const params = new URLSearchParams(hash.slice(1));
  const out = {};
  if (params.has('car')) out.carSeed = Number(params.get('car')) || 1;
  if (params.has('on')) out.runSeed = Number(params.get('on')) || 0;
  if (params.has('L')) out.trackLength = Number(params.get('L'));
  if (params.has('noise')) {
    const n = Number(params.get('noise'));
    if (Number.isFinite(n) && n >= 0 && n <= 3) out.noise = n;
  }
  try {
    if (params.has('z')) {
      out.code = new TextDecoder().decode(await pipe(unb64url(params.get('z')), new DecompressionStream('deflate-raw')));
    } else if (params.has('c')) {
      out.code = new TextDecoder().decode(unb64url(params.get('c')));
    }
  } catch {
    out.error = 'The shared code in this link could not be decoded.';
  }
  return out;
}
