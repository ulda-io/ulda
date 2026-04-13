/**
 * Minimal demo signer.
 * This is only for smoke-testing server mechanics without wiring a real ULDA chain.
 * Rule:
 * - older and newer must be non-empty byte arrays
 * - newer must differ from older
 */
export default class DemoSigner {
  async verify(older, newer) {
    const a = Buffer.from(older ?? []);
    const b = Buffer.from(newer ?? []);
    return a.length > 0 && b.length > 0 && Buffer.compare(a, b) !== 0;
  }
}
