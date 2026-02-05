class UldaSign {
    constructor(cfg = {}) {
        const g = (this.globalConfig = {
            version: cfg.version ? ? "1",
            fmt: { export: cfg ? .fmt ? .export ? ? "hex" },
            sign: {
                N: cfg ? .sign ? .N ? ? 5,
                mode: cfg ? .sign ? .mode ? ? "S",
                hash: cfg ? .sign ? .hash ? ? "SHA-256",
                originSize: cfg ? .sign ? .originSize ? ? 256,
                pack: cfg ? .sign ? .pack ? ? "simpleSig"
            },
            externalHashers: cfg.externalHashers ? ? {}
        });
        const self = this;
        this.externalHashers = g.externalHashers;
        const s = cfg.sign ? ? {};
        if (typeof s.func === "function") {
            const id = s.hash ? ? "custom";
            g.externalHashers[id] = {
                fn: s.func,
                output: s.output ? ? "bytes",
                size: s.originSize ? ? null,
                cdn: s.cdn ? ? null,
                ready: true
            };
            this.encoder = this.encoder ? ? { algorithm: {} };
            this.decoder = this.decoder ? ? { algorithm: {} };
            this.encoder.algorithm[id] = 0xff;
            this.decoder.algorithm[0xff] = id;
        }

        this.encoder = {
            mode: { S: 1, X: 2 },
            algorithm: {
                "SHA-1": 1,
                "SHA-256": 2,
                "SHA-384": 3,
                "SHA-512": 4,
                "SHA3-256": 5,
                "SHA3-512": 6,
                BLAKE3: 7,
                WHIRLPOOL: 8,
                CUSTOM: 0xff
            }
        };
        this.decoder = {
            mode: { 1: "S", 2: "X" },
            algorithm: Object.fromEntries(
                Object.entries(this.encoder.algorithm).map(([n, c]) => [c, n])
            )
        };

        const cv = (this.convert = {
            bytesToHex: u8 => [...u8].map(b => b.toString(16).padStart(2, "0")).join(""),
            hexToBytes: str => Uint8Array.from(str.match(/../g).map(h => parseInt(h, 16))),
            bytesToBase64: u8 => btoa(String.fromCharCode(...u8)),
            base64ToBytes: str => Uint8Array.from(atob(str), c => c.charCodeAt(0)),
            guessToBytes: str =>
                /^[0-9a-f]+$/i.test(str) && str.length % 2 === 0 ?
                cv.hexToBytes(str) :
                cv.base64ToBytes(str),
            indexToBytes: idx => {
                let b = typeof idx === "bigint" ? idx : BigInt(idx);
                if (b === 0 n) return Uint8Array.of(0);
                const r = [];
                while (b > 0 n) {
                    r.unshift(Number(b & 0xff n));
                    b >>= 8 n;
                }
                return Uint8Array.from(r);
            },
            concatBytes: (...arrs) => {
                const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0));
                let off = 0;
                arrs.forEach(a => (out.set(a, off), (off += a.length)));
                return out;
            },
            equalBytes: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
            export: bytes =>
                ({ base64: cv.bytesToBase64, bytes: x => x, hex: cv.bytesToHex }[
                    g.fmt.export
                ] ? ? cv.bytesToHex)(bytes),
            importToBytes: d =>
                d instanceof Uint8Array ?
                d :
                ({ hex: cv.hexToBytes, base64: cv.base64ToBytes }[g.fmt.export] ? ?
                    cv.guessToBytes)(d),
            splitSig: p =>
                p.blocks ? ?
                (() => {
                    const { originLen, blkLen, sigBytes, N } = p,
                    a = [sigBytes.slice(0, originLen)];
                    for (let i = 0; i < N - 1; i++)
                        a.push(sigBytes.slice(originLen + i * blkLen, originLen + (i + 1) * blkLen));
                    return a;
                })()
        });

        const enc = (this.enc = {
            hash: async(u8, alg = "SHA-256") => {
                if (["SHA-1", "SHA-256", "SHA-384", "SHA-512"].includes(alg))
                    return new Uint8Array(await crypto.subtle.digest(alg, u8));
                const ext = g.externalHashers[alg];
                if (!ext) throw `Hasher <${alg}> not registered`;
                if (ext.cdn && !ext.ready) {
                    await UldaSign.loadScriptOnce(ext.cdn);
                    ext.ready = true;
                }
                const raw = await ext.fn(u8),
                    fmt = ext.output ? ? "bytes",
                    bytes =
                    fmt === "bytes" ?
                    raw :
                    fmt === "hex" ?
                    cv.hexToBytes(raw) :
                    fmt === "base64" ?
                    cv.base64ToBytes(raw) :
                    (() => {
                        throw `Unsupported output ${fmt}`;
                    })();
                if (ext.size && bytes.length * 8 !== ext.size)
                    throw `Hasher <${alg}> size mismatch`;
                return bytes;
            },
            hashIter: async(u8, t, alg = "SHA-256") => {
                let h = u8;
                for (let i = 0; i < t; i++) h = await enc.hash(h, alg);
                return h;
            },
            ladder: async(blocks, mode = "S", alg = "SHA-256") =>
                mode === "X" ? enc._ladderX(blocks, alg) : enc._ladderS(blocks, alg),
            _ladderS: async(blocks, alg) => {
                const sig = [];
                for (let i = 0; i < blocks.length; i++)
                    sig.push(await enc.hashIter(blocks[i], i, alg));
                return { sigBlocks: sig, final: sig.at(-1) };
            },
            _ladderX: async(blocks, alg = "SHA-256") => {
                if (!blocks ? .length) throw "_ladderX: empty blocks";
                const cat = cv.concatBytes,
                    sig = [blocks[0]];
                let prev = blocks;
                for (let d = 1; d < blocks.length; d++) {
                    const cur = [];
                    for (let i = 0; i < prev.length - 1; i++)
                        cur.push(await enc.hash(cat(prev[i], prev[i + 1]), alg));
                    sig.push(cur[0]);
                    prev = cur;
                }
                return { sigBlocks: sig, final: sig.at(-1) };
            }
        });

        let a;
        this.actions = a = {
            Sign: async pkg => {
                const p = a.import.origin(pkg),
                    { origin, mode, alg, index, N } = p,
                    { sigBlocks } = await enc.ladder(origin, mode, alg);
                return a.PackSignature(cv.concatBytes(...sigBlocks), { index, N, mode, alg });
            },
            VerifyS: async(o, n) => {
                const older = o.index < n.index ? o : n,
                    newer = o.index < n.index ? n : o,
                    g = Number(newer.index - older.index);
                if (g <= 0 || g >= older.N) return false;
                if (older.originLen !== newer.originLen || older.blkLen !== newer.blkLen)
                    return false;
                const ob = cv.splitSig(older),
                    nb = cv.splitSig(newer);
                for (let i = 0; i < older.N - g; i++)
                    if (!cv.equalBytes(await enc.hashIter(nb[i], g, older.alg), ob[i + g]))
                        return false;
                return true;
            },
            VerifyX: async(sa, sb) => {
                const older = sa.index < sb.index ? sa : sb,
                    newer = sa.index < sb.index ? sb : sa;
                if (Number(newer.index - older.index) !== 1) return false;
                const { N } = older;
                if (
                    older.sigBytes.length !== newer.sigBytes.length ||
                    older.sigBytes.length % N
                )
                    return false;
                const A = cv.splitSig(older),
                    B = cv.splitSig(newer),
                    cat = cv.concatBytes;
                for (let d = 1; d < N; d++)
                    if (!cv.equalBytes(
                            await enc.hash(cat(A[d - 1], B[d - 1]), older.alg),
                            A[d]
                        ))
                        return false;
                return true;
            },
            Verify: async(aSig, bSig) => {
                const A = a.import.signature(aSig),
                    B = a.import.signature(bSig);
                if (A.N !== B.N || A.mode !== B.mode || A.alg !== B.alg) return false;
                return A.mode === "S" ?
                    a.VerifyS(A, B) :
                    A.mode === "X" ?
                    a.VerifyX(A, B) :
                    false;
            },
            import: {
                signature: pkg => {
                    const bytes =
                        pkg instanceof Uint8Array ? pkg : cv.importToBytes(pkg),
                        hdr = bytes[1],
                        N = bytes[2],
                        mode = self.decoder.mode[bytes[3]] ? ? "U",
                        alg = self.decoder.algorithm[bytes[4]] ? ? "UNK";
                    let idx = 0 n;
                    for (let i = 5; i < hdr - 1; i++) idx = (idx << 8 n) | BigInt(bytes[i]);
                    const sigBytes = bytes.slice(hdr),
                        originLen = (g.sign.originSize ? ? 256) >>> 3,
                        rest = sigBytes.length - originLen,
                        blkLen = rest / (N - 1);
                    if (rest < 0 || !Number.isInteger(blkLen)) throw "SigImporter sizes";
                    const blocks = [sigBytes.slice(0, originLen)];
                    for (let i = 0; i < N - 1; i++)
                        blocks.push(sigBytes.slice(originLen + i * blkLen, originLen + (i + 1) * blkLen));
                    return { bytes, N, mode, alg, index: idx, sigBytes, originLen, blkLen, blocks };
                },
                origin: pkg => {
                    const bytes =
                        pkg instanceof Uint8Array ? pkg : cv.importToBytes(pkg),
                        hdr = bytes[1];
                    if (bytes[0] || bytes[hdr - 1]) throw "sentinel";
                    const N = bytes[2],
                        mode = self.decoder.mode[bytes[3]] ? ? "U",
                        alg = self.decoder.algorithm[bytes[4]] ? ? "UNK";
                    let idx = 0 n;
                    for (let i = 5; i < hdr - 1; i++) idx = (idx << 8 n) | BigInt(bytes[i]);
                    const body = bytes.slice(hdr),
                        blkLen = body.length / N;
                    if (!Number.isInteger(blkLen)) throw "div";
                    const origin = [];
                    for (let i = 0; i < N; i++)
                        origin.push(body.slice(i * blkLen, (i + 1) * blkLen));
                    return { bytes, N, mode, alg, index: idx, blockLen: blkLen, origin };
                }
            },
            OriginGenerator: () => {
                const len = g.sign.originSize >>> 3;
                return {
                    origin: Array.from({ length: g.sign.N }, () => a.RandomBlock(len))
                };
            },
            RandomBlock: len => crypto.getRandomValues(new Uint8Array(len)),
            _hdr: (N, mode, alg, idxBytes) => {
                const h = new Uint8Array(5 + idxBytes.length + 1);
                h.set([0, h.length, N, self.encoder.mode[mode] ? ? 255, self.encoder.algorithm[alg] ? ? 255]);
                h.set(idxBytes, 5);
                h[h.length - 1] = 0;
                return h;
            },
            NewExporter: (originObj, index = 0 n) => {
                const { N, mode, hash } = g.sign,
                    hdr = a._hdr(N, mode, hash, cv.indexToBytes(index));
                return cv.export(cv.concatBytes(hdr, ...originObj.origin));
            },
            SignExporter: (sigBytes, index, N, mode, hash) => {
                const hdr = a._hdr(N, mode, hash, cv.indexToBytes(index));
                return cv.export(cv.concatBytes(hdr, sigBytes));
            },
            PackSignature: (sigBytes, m) =>
                a.SignExporter(sigBytes, m.index, m.N, m.mode, m.alg),
            StepUp: pkg => {
                const { origin, blockLen, index } = a.import.origin(pkg),
                    next = origin.slice(1);
                next.push(a.RandomBlock(blockLen));
                return a.NewExporter({ origin: next }, index + 1 n);
            }
        };
    }

    static loadScriptOnce(src) {
        return new Promise((res, rej) => {
            if (document.querySelector(`script[src="${src}"]`)) return res();
            const s = document.createElement("script");
            s.src = src;
            s.onload = res;
            s.onerror = rej;
            document.head.appendChild(s);
        });
    }

    New(i = 0 n) {
        return this.actions.NewExporter(this.actions.OriginGenerator(), i);
    }
    stepUp(pkg) {
        return this.actions.StepUp(pkg);
    }
    sign(pkg) {
        return this.actions.Sign(pkg);
    }
    verify(a, b) {
        return this.actions.Verify(a, b);
    }
}

export default UldaSign;