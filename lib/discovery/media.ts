import { DiscoveryError } from './errors';
import { lookup } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as mediaFetch } from 'undici';
import { detectImageMimeType, getMaxUploadBytes } from '@/lib/media/storage';
import { allowedImageUrl } from './model';
const blocked = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(network, prefix, 'ipv4');
const publicV6 = new BlockList(); publicV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blockedV6.addSubnet(network, prefix, 'ipv6');
export const isPublicMediaAddress = (address: string) => isIP(address) === 4 ? !blocked.check(address, 'ipv4') : isIP(address) === 6 && publicV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
const safeLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    if (!addresses.length || addresses.some(({ address }) => !isPublicMediaAddress(address))) return callback(new DiscoveryError('Media host resolved to a nonpublic address.'), '');
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};
export async function downloadSelectedImage(storedUrl: string): Promise<File> {
  let url = allowedImageUrl(storedUrl);
  const dispatcher = new Agent({ connect: { lookup: safeLookup }, autoSelectFamily: true });
  const signal = AbortSignal.timeout(20000), max = getMaxUploadBytes();
  try {
    for (let redirect = 0; redirect <= 3; redirect++) {
      const response = await mediaFetch(url, { dispatcher, redirect: 'manual', signal, headers: { Accept: 'image/png,image/jpeg,image/webp' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel(); const location = response.headers.get('location');
        if (!location || redirect === 3) throw new DiscoveryError('Image redirected too many times or has no destination.');
        url = allowedImageUrl(new URL(location, url).toString()); continue;
      }
      const declaredType = response.headers.get('content-type')?.split(';')[0].trim();
      if (!response.ok || !['image/png', 'image/jpeg', 'image/webp'].includes(declaredType ?? '') || Number(response.headers.get('content-length')) > max) {
        await response.body?.cancel(); throw new DiscoveryError('Image unavailable, unsupported, or too large. Upload the image manually.');
      }
      const chunks: Uint8Array[] = []; let size = 0;
      if (!response.body) throw new DiscoveryError('Image response was empty.');
      for await (const chunk of response.body) { size += chunk.length; if (size > max) { await response.body.cancel().catch(() => {}); throw new DiscoveryError('Image exceeds the upload limit.'); } chunks.push(chunk); }
      const bytes = Buffer.concat(chunks), mime = detectImageMimeType(bytes);
      if (!bytes.length || !mime || mime !== declaredType) throw new DiscoveryError('Image contents do not match a supported image type.');
      return new File([new Uint8Array(bytes)], `discovered-reference.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]}`, { type: mime });
    }
    throw new DiscoveryError('Image could not be downloaded.');
  } finally { await dispatcher.close(); }
}
