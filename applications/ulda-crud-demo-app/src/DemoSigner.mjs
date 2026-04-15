import { Buffer } from 'node:buffer';

export default class DemoSigner {
  async verify(older, newer) {
    const a = Buffer.from(older ?? []);
    const b = Buffer.from(newer ?? []);
    return a.length > 0 && b.length > 0 && !a.equals(b);
  }
}
