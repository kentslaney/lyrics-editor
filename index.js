"use strict"

const isNode = typeof window === "undefined"

const retrieve = !isNode ? fetch : async function(uri) {
    const fs = require('fs')
    const fp = (f, ...encoding) => () => new Promise((resolve, reject) => {
        fs.readFile(uri, ...encoding, (err, data) => {
            if (err) return reject(err)
            else return resolve(f(data))
        })
    })
    return {
        "ok": fs.existsSync(uri),
        "body": {"getReader": () => Object({"read": fp(
            data => Object({"done": true, "value": data.buffer}))})},
        "json": fp(JSON.parse, 'utf8'),
        "text": fp(x => x, 'utf8')
    }
}

class Dictionary {
    version = 2
    url = (
        "https://raw.githubusercontent.com/kentslaney/cmudict/" +
        "7479086/cmudict.dict")
    local = "cmudict/cmudict.dict"
    lexicon = 126052

    constructor() {
        this.loaded = new Promise((resolve, reject) => this.status = s => {
            this.status = s => {}
            resolve(s)
        })
    }

    seq(query) {
        return new Promise((resolve, reject) => {
            const words = query.split(" ")
            this.lookup(words).then(result => {
                if (result.some(x => x === undefined)) {
                    const missing = result.map((x, i) => x ? undefined : i)
                        .filter(x => x !== undefined).map(x => words[x])
                    reject(new Error(
                        `Missing pronunciation` +
                        `${missing.length > 1 ? 's' : ''} ` +
                        `for "${missing.join('", "')}"`))
                } else {
                    resolve(result.map(x => x[0]))
                }
            })
        })
    }

    parse(callback, progress=() => {}, persist=() => []) {
        return async function(reader) {
            let prefix = "", existing = [], prev = "", total = 0
            const pump = async () => {
                const { done, value } = await reader.read();
                const args = persist()
                const textChunk = new TextDecoder().decode(value);
                const text = prefix + textChunk
                let line = undefined;
                for (const next of text.split("\n")) {
                    if (line === undefined || line.startsWith(";;;")) {
                        line = next;
                        continue;
                    }
                    const [pre] = line.split(" ", 1)
                    const post = line.slice(pre.length)
                    const [word, version] = (pre.endsWith(")") ?
                        pre.slice(0, -1).split("(") : [pre, "0"])
                    if (word !== prev) {
                        if (prev) {
                            callback(prev, existing, ...args)
                            existing = []
                            total++
                        }
                        prev = word
                    }
                    existing.push(post.trim())
                    line = next
                }
                prefix = line
                if (!done) {
                    if (!isNode) {
                        console.info("downloaded", total, "of", this.lexicon,
                            "rows; % complete:",
                            Math.round(total / this.lexicon * 1000) / 10)
                    }
                    progress(total, this.lexicon)
                    return pump()
                }
                callback(prev, existing, ...args)
                console.assert(++total === this.lexicon)
                if (!isNode) console.info("pronunciation db downloaded")
            };
            return pump();
        }.bind(this)
    }

    async lookup(query) {
        const single = typeof query === "string"
        if (single ? query === "" : !query.filter(x => x).length)
            return single ? undefined :
                [...new Array(query.length).keys()].map(x => undefined)
        if (await this.loaded) {
            if (single) {
                return this.localLookup(query)
            } else {
                const queries = query.map(
                    x => x === "" ? undefined : this.localLookup(x))
                let res = []
                for await (const i of queries) {
                    res.push(i)
                }
                return res
            }
        } else {
            const res = await this.remoteLookup(query)
            if (single) return this.reformatRemote(res)
            else return res.map(this.reformatRemote)
        }
    }
}

class Cursor extends Dictionary {
    #db;
    constructor() {
        super()
        this.create()
    }

    create() {
        const request = indexedDB.open("words", this.version);
        let done;
        this.loading = new Promise((resolve, reject) => done = resolve)

        request.onupgradeneeded = (event) => {
            const db = event.target.result
            for (let obj of db.objectStoreNames)
                db.deleteObjectStore(obj)

            db.createObjectStore("pronunciations", { keyPath: 'word' });
            const store = db.createObjectStore("status", { keyPath: 'id' });
            store.add({ id: "loaded", value: false })
            store.add({ id: "url", value: this.url })
        };

        request.onsuccess = (event) => {
            this.#db = event.target.result
            const tx = this.#db.transaction("status", "readonly")
            const store = tx.objectStore("status")
            store.get("loaded").onsuccess = (async function(event) {
                const res = event.target.result.value
                const ws = await this.remoteAvailable
                if (res || ws) this.status(res)
                done(res)
                // TODO: this.validate for user-initiated db refresh
            }).bind(this)
        }
    }

    validate() {
        const { promise, resolve, reject } = Promise.withResolvers();
        const request = indexedDB.open("words", this.version);
        request.onsuccess = (event) => {
            const db = event.target.result
            const tx = db.transaction("pronunciations", 'readonly');
            const store = tx.objectStore("pronunciations");
            const query = store.count()
            query.onsuccess = event => {
                if (event.target.result === this.lexicon) resolve()
                else reject(new Error(
                    `The stored db has ${event.target.result} entries ` +
                    `instead of the expected ${this.lexicon}`))
            }
        }
        return promise
    }

    async clear() {
        return new Promise((resolve, reject) => {
            this.#db.close()
            const tx = indexedDB.deleteDatabase("words")
            tx.onsuccess = () => {
                this.create()
                resolve()
            }
            tx.onblocked = tx.onerror = e => {
                reject(e.target.error)
            }
        })
    }

    async load(progress=() => {}, storing=() => {}) {
        const commits = [];
        console.info("populating pronunciation db")
        return fetch((await this.remoteAvailable) ? this.local : this.url)
            .then((response, reject) => {
                if (!response.ok) {
                    reject(response)
                }
                return response.body.getReader();
            })
            .then(this.parse((prev, existing, store) => {
                commits.push(new Promise((resolve, reject) => {
                    const op = store.add({
                        word: prev,
                        pronunciation: existing
                    });
                    op.onsuccess = resolve
                    op.onerror = reject
                }))
            }, progress, () => {
                const tx = this.#db.transaction("pronunciations", 'readwrite')
                return [tx.objectStore("pronunciations")]
            }))
            .then(storing)
            .then(() => Promise.allSettled(commits))
            .then((() => {
                console.info("pronunciation db populated")
                const tx = this.#db.transaction("status", 'readwrite');
                const store = tx.objectStore("status");
                store.put({ id: "loaded", value: true });
                this.loaded = new Promise((resolve, reject) => resolve(true))
                this.status(true)
            }).bind(this))
    }

    localLookup(query) {
        const tx = this.#db.transaction("pronunciations", 'readonly');
        const store = tx.objectStore("pronunciations");
        const request = store.get(query.toLowerCase())
        return new Promise((resolve, reject) => {
            request.onsuccess = event =>
                resolve(event.target.result?.pronunciation)
            request.onerror = reject
        })
    }

    #encodeURI(query) {
        return typeof query === "string" ? query : JSON.stringify(query)
    }

    async remoteLookup(query) {
        const socket = new WebSocket("ws://localhost:8080/ws");
        let requests = []
        socket.addEventListener("message", e => {
            requests.pop(0)(JSON.parse(e.data))
        })
        let opener, open = new Promise((resolve, reject) => opener = resolve)
        socket.addEventListener("open", opener)
        this.remoteLookup = async function(query) {
            await open
            let res = new Promise((resolve, reject) => requests.push(resolve))
            socket.send(this.#encodeURI(query))
            return res
        }
        return this.remoteLookup(query)
    }

    reformatRemote(response) {
        return response.length === 0 ? undefined : response.map(x => x[2])
    }

    get remoteAvailable() {
        return new Promise((resolve, reject) => {
            const f = () => resolve("ws_available" in window)
            if (document.readyState !== "loading") f()
            else document.addEventListener("load", f)
        })
    }
}

class Transient extends Dictionary {
    constructor() {
        super()
        this.load()
    }

    #kv
    async load() {
        this.#kv = {}
        return retrieve(this.local)
            .then((response) => {
                if (!response.ok) {
                    return new Promise((resolve, reject) => {
                        fetch(this.url).then(res => {
                                console.info("pronunciation db downloaded")
                                return res.arrayBuffer()
                            }).then(bytes => require('fs').writeFileSync(
                                this.local, new Uint8Array(bytes)))
                            .then(() => retrieve(this.local))
                            .then(response => resolve(
                                response.body.getReader()))
                    })
                }
                return response.body.getReader();
            })
            .then(this.parse((prev, existing) => {
                this.#kv[prev] = existing
            }))
            .then((() => {
                this.loaded = new Promise((resolve, reject) => resolve(true))
                this.status(true)
            }).bind(this))
    }

    async localLookup(query) {
        return this.#kv[query.toLowerCase()]
    }
}

class Overlaid extends Cursor {
    constructor() {
        super()
        this.model = new G2p()
    }

    async localLookup(query) {
        const stored = await super.localLookup(query)
        if (stored !== undefined) return stored
        await this.model.loading
        const inference = await this.model.enqueue(query)
        return inference.filter(x => x.length > 0)
    }
}

const dict = isNode ? new Transient() : new Overlaid()

function cumsum(arr) {
    let total = 0
    return arr.map(x => total += x)
}

// https://ismir2009.ismir.net/proceedings/OS8-1.pdf
// CAM16 JCh -> sRGB under sRGB-ish viewing conditions (D65, L_A from a
// mid-gray L* 50 background, average surround), inverse only
const cam16 = (() => {
    const white = [95.047, 100, 108.883]
    const M16 = [
        [0.401288, 0.650173, -0.051461],
        [-0.250268, 1.204414, 0.045854],
        [-0.002079, 0.048952, 0.953127]]
    const M16inv = [
        [1.86206786, -1.01125463, 0.14918677],
        [0.38752654, 0.62144744, -0.00897398],
        [-0.0158415, -0.03412294, 1.04996444]]
    const mul = (M, v) => M.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2])
    const yb = 100 * ((50 + 16) / 116) ** 3, la = 200 / Math.PI * yb / 100
    const f = 1, c = 0.69, nc = 1
    const rgbW = mul(M16, white)
    const d = Math.min(1, Math.max(0,
        f * (1 - 1 / 3.6 * Math.exp((-la - 42) / 92))))
    const rgbD = rgbW.map(x => d * 100 / x + 1 - d)
    const k = 1 / (5 * la + 1), k4 = k ** 4
    const fl = k4 * la + 0.1 * (1 - k4) ** 2 * Math.cbrt(5 * la)
    const n = yb / white[1], z = 1.48 + Math.sqrt(n), nbb = 0.725 / n ** 0.2
    const rgbA = rgbW.map((x, i) => {
        const p = (fl * rgbD[i] * x / 100) ** 0.42
        return 400 * p / (p + 27.13)
    })
    const aw = (2 * rgbA[0] + rgbA[1] + 0.05 * rgbA[2]) * nbb
    const toXyz = (J, C, h) => {
        const alpha = J === 0 ? 0 : C / Math.sqrt(J / 100)
        const t = (alpha / (1.64 - 0.29 ** n) ** 0.73) ** (1 / 0.9)
        const hr = h * Math.PI / 180, sin = Math.sin(hr), cos = Math.cos(hr)
        const eHue = 0.25 * (Math.cos(hr + 2) + 3.8)
        const p1 = eHue * 50000 / 13 * nc * nbb
        const p2 = aw * (J / 100) ** (1 / c / z) / nbb
        const g = 23 * (p2 + 0.305) * t / (23 * p1 + 11 * t * cos + 108 * t * sin)
        const a = g * cos, b = g * sin
        const rgb = [
            460 * p2 + 451 * a + 288 * b,
            460 * p2 - 891 * a - 261 * b,
            460 * p2 - 220 * a - 6300 * b].map((x, i) => {
                x /= 1403
                const base = Math.max(0, 27.13 * Math.abs(x) / (400 - Math.abs(x)))
                return Math.sign(x) * 100 / fl * base ** (1 / 0.42) / rgbD[i]
            })
        return mul(M16inv, rgb)
    }
    const toSrgb = xyz => mul([
        [3.2404542, -1.5371385, -0.4985314],
        [-0.969266, 1.8760108, 0.041556],
        [0.0556434, -0.2040259, 1.0572252]], xyz.map(x => x / 100))
    const encode = x => x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055
    // largest chroma up to C that stays in the sRGB gamut
    return (J, C, h) => {
        const inGamut = C => toSrgb(toXyz(J, C, h)).every(
            x => x >= -1e-4 && x <= 1 + 1e-4)
        let lo = 0, hi = C
        if (!inGamut(hi)) for (let i = 0; i < 20; i++) {
            const mid = (lo + hi) / 2
            if (inGamut(mid)) lo = mid; else hi = mid
        } else lo = hi
        return toSrgb(toXyz(J, lo, h)).map(x =>
            Math.round(255 * Math.min(1, Math.max(0, encode(x)))))
    }
})()

class Similarities {
    constructor() {
        this.load = retrieve("OS8-1.json").then(r => r.json()).then((res => {
            for (const key of Object.keys(res)) {
                this[key] = res[key]
            }
            this.axes = {}
            this.group = {}
            for (const [symbol, value] of this.symbols) {
                const mapped = this.mapping[value]
                this.group[symbol] = [mapped, null]
                if (!mapped) continue
                if (mapped in this.axes) this.axes[mapped].push(symbol)
                else this.axes[mapped] = [symbol]
                this.group[symbol][1] = this.axes[mapped].length - 1
            }
            for (const key of ["vowels", "consonants"]) {
                let transposed = []
                for (let i = 0; i < this[key][0].length; i++) {
                    let row = []
                    for (let j = 0; j <= i && j < this[key].length; j++) {
                        row.push(this[key][j][i - j])
                    }
                    transposed.push(row)
                }
                this[key] = transposed
            }
        }).bind(this))
    }

    validate() {
        const done = {}
        return Promise.race([this.load, done]).then(async (first) => {
            console.assert(first !== done, "Similarities used before load")
        })
    }

    get(type, index0, index1) {
        const [lo, hi] = [index0, index1].toSorted((a, b) => a - b)
        return this[type][hi][lo]
    }

    // vowels placed on the color wheel by a 2D embedding of their
    // similarities (kernel PCA) so near rhymes get neighboring hues
    get vowelHues() {
        if (this._vowelHues) return this._vowelHues
        this.validate()
        const names = this.axes.vowels, n = names.length
        const S = names.map((_, i) => names.map((_, j) => this.get("vowels", i, j)))
        const mean = S.map(r => r.reduce((a, b) => a + b) / n)
        const all = mean.reduce((a, b) => a + b) / n
        const B = S.map((r, i) => r.map((x, j) => x - mean[i] - mean[j] + all))
        const dot = (u, v) => u.reduce((a, x, i) => a + x * v[i], 0)
        const axes = []
        for (let k = 0; k < 2; k++) {
            let v = B.map((_, i) => Math.cos(i * (k + 1)))
            for (let it = 0; it < 500; it++) {
                let w = B.map(r => dot(r, v))
                for (const u of axes) w = w.map((x, i) => x - dot(w, u) * u[i])
                const norm = Math.hypot(...w)
                v = w.map(x => x / norm)
            }
            axes.push(v)
        }
        const angle = names.map((_, i) => Math.atan2(axes[1][i], axes[0][i]))
        const rank = [...names.keys()].sort((a, b) => angle[a] - angle[b])
        return this._vowelHues = Object.fromEntries(
            rank.map((i, r) => [names[i], r * 360 / n]))
    }

    // CAM16 hue from the embedding at constant chroma; lightness alternates
    // so that neighbors on the wheel stay distinguishable
    palette = {
        light: { J: [76, 62, 86], C: 60 },
        dark: { J: [52, 40, 64], C: 50 },
    }
    get vowelColors() {
        if (this._vowelColors) return this._vowelColors
        const hues = this.vowelHues, names = Object.keys(hues)
        return this._vowelColors = Object.fromEntries(names.map((v, r) => [v,
            Object.fromEntries(Object.entries(this.palette).map(
                ([mode, { J, C }]) => [mode,
                    cam16(J[r % J.length], C, hues[v]).join(" ")]))]))
    }

    lookup(term0, term1) {
        this.validate()
        const [type0, index0] = this.group[term0]
        if (term1 === undefined) {
            const res = this[type0][index0].concat(
                this[type0].slice(index0 + 1).map((x, i) => x[index0]))
            return Object.fromEntries(
                this.axes[type0].map((a, b) => [a, res[b]]))
        } else {
            const [type1, index1] = this.group[term1]
            if (type0 === null || type0 !== type1) return null
            return this.get(type0, index0, index1)
        }
    }

    order(type, indices0, indices1, lu=true, diag=true) {
        indices0 = indices0 === undefined ?
            [...Array(this[type].length).keys()] : indices0
        indices1 = indices1 === undefined ? indices0 : indices1
        return indices0.map(i =>
                (lu ? indices1.filter(j => j <= i - !diag) : indices1)
                .map(j => [i, j, this[type][Math.max(i, j)][Math.min(i, j)]]))
            .flat().toSorted(([,,a], [,,b]) => b - a)
    }

    align(seq) {
        // TODO: stress informs matching
        let words = seq.map(x => x
            .split(/ ?([A-Z]+)[0-2] ?/g)
            .map((x, i) => i & 1 ? x : x ? x.split(" ") : []))
        let syllables = [[]]
        for (const word of words) {
            syllables.slice(-1)[0].push(word[0])
            syllables = syllables.concat(
                word.slice(1, -1).map((x, i) => i & 1 ? [x] : x))
            syllables.push([word.slice(-1)[0]])
        }
        return syllables
    }

    // ignores aspirates and semivowels
    skips(coda, rev=false) {
        this.validate()
        const half = coda.length / 2
        // TODO: the paper mentions half as delimiting codas separate from
        //       specifying the start/end of them
        return coda.map((x, i) => {
            const side = rev ? i <= half : i >= half
            return this.consonants.slice(-2)[+side][this.group[x][1]] || 0
        })
    }

    paths(coda0, coda1, rev=false) {
        if (coda0.length == 0 && coda1.length == 0) return [[0]]
        let skip0 = this.skips(coda0, rev), skip1 = this.skips(coda1, rev);
        let dp = [...Array(coda0.length + 1)]
            .map(_ => [...Array(coda1.length + 1)])
        dp[0][0] = 0
        for (let i = 0; i <= coda0.length; i++) {
            for (let j = 0; j <= coda1.length; j++) {
                if (i == 0 && j == 0) continue
                dp[i][j] = Math.max(
                    i == 0 ? -Infinity : dp[i - 1][j] + skip0[i - 1],
                    j == 0 ? -Infinity : dp[i][j - 1] + skip1[j - 1],
                    i == 0 || j == 0 ? -Infinity : dp[i - 1][j - 1] +
                        (this.lookup(coda0[i - 1], coda1[j - 1])))
            }
        }
        return dp
    }

    match(dp, breaks0, breaks1) {
        breaks0 = breaks0 === undefined ? [dp.length - 1] : breaks0
        breaks1 = breaks1 === undefined ? [dp[0].length - 1] : breaks1
        const breaks = breaks0.map(
            row => breaks1.map(col => dp[row][col] / Math.max(row, col, 1)))
        const [val, arg] = breaks.flat().reduce(([prev, argmax], cur, idx) =>
            cur > prev ? [cur, idx] : [prev, argmax], [-Infinity, NaN])
        const row = Math.trunc(arg / breaks1.length), col = arg % breaks1.length
        return dp[breaks0[row]][breaks1[col]]
    }

    max(dp) {
        return this.match(
            dp, [...Array(dp.length).keys()], [...Array(dp[0].length).keys()])
    }

    spaced(codas0, codas1, rev=false) {
        const dir = rev ? x => x.reverse() : x => x
        const dp = this.paths(dir(codas0.flat()), dir(codas1.flat()), rev)
        return this.match(dp,
            cumsum(dir(codas0.map(x => x.length))),
            cumsum(dir(codas1.map(x => x.length))))
    }

    rhyme(seq0, seq1) {
        const aligned0 = this.align(seq0).reverse(),
            aligned1 = this.align(seq1).reverse();
        const common = Math.min(aligned0.length, aligned1.length)
        return [...Array(common).keys()].reduce(([max, total], i) => {
            if (i & 1) {
                total += this.lookup(aligned0[i], aligned1[i])
                return [Math.max(max, total), total]
            } else {
                const dp = this.paths(
                    aligned0[i].flat().reverse(),
                    aligned1[i].flat().reverse(),
                    true)
                return [
                    Math.max(max, total + this.max(dp)), total + this.match(dp)]
            }
        }, [0, 0])[0]
    }
}

let phonemes = new Similarities();

async function rhyme(query0, query1) {
    const seq0 = await dict.seq(query0), seq1 = await dict.seq(query1)
    await phonemes.load
    return phonemes.rhyme(seq0, seq1)
}

function compare(query0, query1) {
    rhyme(query0, query1).then(x => {
        console.log(JSON.stringify(query0), JSON.stringify(query1), x)
    })
}

class MaxHeap {
    constructor() {
        this.arr = []
    }

    swap(i, j) {
        [this.arr[i], this.arr[j]] = [this.arr[j], this.arr[i]]
    }

    push(x) {
        this.arr.push(x)
        let i = this.arr.length - 1, p
        while (i > 0 && this.arr[p = Math.trunc((i - 1) / 2)] < this.arr[i]) {
            this.swap(i, p)
            i = p
        }
    }

    pop() {
        if (this.arr.length <= 1) return this.arr.pop()
        const res = this.arr[0]
        this.replace(this.arr.pop())
        return res
    }

    replace(x) {
        this.arr[0] = x
        for (let i = 0, max = 0;; i = max) {
            const l = 2 * i + 1, r = 2 * i + 2
            if (l < this.arr.length && this.arr[l] > this.arr[max]) max = l
            if (r < this.arr.length && this.arr[r] > this.arr[max]) max = r
            if (max === i) return
            else this.swap(i, max)
        }
    }

    get empty() {
        return this.arr.length === 0
    }

    [Symbol.iterator]() {
        return {
            next: () => ({ done: this.empty, value: this.pop() })
        }
    }
}

class MaxHeapKV extends MaxHeap {
    constructor() {
        super()
        this.val = []
    }

    swap(i, j) {
        [this.val[i], this.val[j]] = [this.val[j], this.val[i]]
        super.swap(i, j)
    }

    push(k, v) {
        this.val.push(v)
        super.push(k)
    }

    pop() {
        if (this.arr.length <= 1) return [this.arr.pop(), this.val.pop()]
        const res = this.val[0]
        this.val[0] = this.val.pop()
        return [super.pop(), res]
    }
}

class MaxHeapPeek extends MaxHeapKV {
    constructor() {
        super()
        this.prev = null
        this.held = false
    }

    release() {
        if (this.held) {
            super.push(...this.prev)
            this.held = false
        }
    }

    push(...args) {
        this.release()
        super.push(...args)
        this.prev = null
    }

    pop() {
        if (this.held) {
            this.held = false
            return this.prev
        }
        this.prev = super.pop()
        return this.prev
    }

    hold() {
        console.assert(this.prev !== null && this.held === false)
        this.held = true
        return this
    }

    peek() {
        if (this.held) return this.prev
        else return [this.arr[0], this.val[0]]
    }

    replace(x) {
        this.release()
        super.replace(x)
    }

    get empty() {
        return this.held === false && super.empty
    }
}

// This isn't true of the consonants matrix, but, for vowels, each symbol
// matches the most with itself. That means the vowel's nodes should be matched
// with themselves before compared with others, which can be done in a container
// class. Further, all the diagonal entries of the vowels matrix are greater
// than all the off-diagonal entires, so the cross-comparisons can be split out.
// This is convenient, especially because the suffix tree isn't currently set up
// for fuzzy matching.
// This is called n-gram even though it's currently a 1-gram bag of phonemes
//     since that's how it would be applied to DNA sequences.
class Ngram extends MaxHeapPeek {
    constructor(sim) {
        super()
        this.sim = sim
        this.bags = []
        this.mapping = null
    }

    // factorize M into QΛQ^T for XMX^T with X as row-major counts
    _push(consonants) { // ordered indices
        const idx = this.bags.length
        consonants = consonants.length ?
            consonants.map(x => this.sim.eigenvectors.consonants[x])
                .reduce((x, y) => x.map((z, i) => z + y[i]))
            : [...Array(this.sim.eigenvectors.consonants.length)].map(x => 0)
        for (let i = 0; i < this.bags.length; i++) {
            const dist = consonants.map((x, j) =>
                x * this.bags[i][j] * this.sim.eigenvalues.consonants[j])
                    .reduce((a, b) => a + b)
            super.push(dist, [i, idx])
        }
        this.bags.push(consonants)
        return idx
    }

    push(...consonants) {
        return consonants.map(x => this._push(x))
    }

    remap(k, v) {
        if (this.mapping === null || v === undefined) return [k, v]
        const [v0, v1] = v
        return [k, [this.mapping[v0], this.mapping[v1]].sort()]
    }

    pop()  { return this.remap(...super.pop())  }
    peek() { return this.remap(...super.peek()) }
}

class OverlayKV extends Ngram {
    constructor(sim, offset) {
        super(sim)
        this.offset = offset
    }

    remap(k, v) {
        return [k + this.offset, super.remap(k, v)[1]]
    }
}

class MaxMergedKV {
    constructor(sources) {
        this.sources = sources
        this.heap = new MaxHeapPeek()
        for (let [source, heap] of Object.entries(sources)) {
            this.heap.push(heap.peek()[0], source)
        }
    }

    pop() {
        if (this.heap.empty) return this.heap.pop()
        const source = this.heap.peek()[1]
        const kv = this.sources[source].pop()
        console.assert(kv.length === 2)
        if (this.sources[source].empty) this.heap.pop()
        else this.heap.replace(this.sources[source].peek()[0])
        return [source, ...kv]
    }

    peek() {
        const source = this.heap.peek()[1]
        if (source === undefined) return [undefined, undefined, undefined]
        const kv = this.sources[source].peek()
        console.assert(kv.length === 2)
        return [source, ...kv]
    }

    hold() {
        this.heap.hold()
        this.sources[this.heap.peek()[1]].hold()
        return this
    }

    get empty() {
        return this.heap.empty
    }

    push(source, heap) {
        if (heap.empty) return
        this.sources[source] = heap
        this.heap.push(heap.peek()[0], source)
    }

    // debugging method
    chain(n) {
        for (let i of Array(n)) this.pop()
        return this
    }
}

class MaxMergedMapped extends MaxMergedKV {
    remap(...res) { return res }
    pop()  { return this.remap(...super.pop())  }
    peek() { return this.remap(...super.peek()) }
}

class SumPends {
    apply(score, store) {
        if (this.parent in store.sums[this.node.uniq]) {
            store.pop()
            return score + store.sums[this.node.uniq][this.parent]
        } else {
            const kv = store.heap.pop()
            if (!(this.node.uniq in store.pending))
                store.pending[this.node.uniq] = {}
            store.pending[this.node.uniq][this.parent] = kv
            return
        }
    }

    get rooted() {
        return this.ref.map(x => this.node.prefixes[x])
    }

    comparing() {
        const [lo, hi] = this.rooted.map(x => x + 2 * !this.node.parentless)
        const syllables = this.node.path.length * 2 - this.node.offset
        return [
            [lo - syllables, lo + this.offset],
            [hi - syllables, hi + this.offset]]
    }

    debug() {
        const [[ll, lh], [hl, hh]] = this.comparing(), res = ["", ""]
        for (let i = ll, j = hl; i < lh; i++, j++) {
            if ((i & 1) === 0) {
                const lo = this.node.prefix(i), hi = this.node.prefix(j)
                const width = Math.max(lo.length, hi.length)
                res[0] += lo + " ".repeat(width - lo.length + 1)
                res[1] += hi + " ".repeat(width - hi.length + 1)
            } else {
                res[0] += this.node.aligned[i] + " "
                res[1] += this.node.aligned[j] + " "
            }
        }
        const width = (Math.max(ll, lh, hl, hh) + "").length
        return "" +
            `\t[${" ".repeat(width - (ll + "").length)}${ll} ` +
                `${res[0]}${" ".repeat(width - (lh + "").length)}${lh})\n` +
            `\t[${" ".repeat(width - (hl + "").length)}${hl} ` +
                `${res[1]}${" ".repeat(width - (hh + "").length)}${hh})`
    }

    refine() {
        const [[ll, lh], [hl, hh]] = this.comparing()
        const lo = ll & 1 ^ 1, hi = hh & 1
        const aligned = this.node.aligned
        const cutoff = [
            aligned.slice(ll + lo, lh - hi),
            aligned.slice(hl + lo, hh - hi)]
        const central = cutoff.map(x => x.map((y, i) =>
            i & 1 ? y.flat() : [y.replace(/[012]/, "")]).flat())
        let res = this.node.sim.match(this.node.sim.paths(...central))
        if (lo) res += this.node.sim.spaced(aligned[ll], aligned[hl], true)
        if (hi) res += this.node.sim.spaced(
            aligned[lh - 1], aligned[hh - 1], false)
        return res
    }
}

class PrefixPair extends SumPends {
    offset = 2

    constructor(node, source, pair, parent) {
        super()
        this.node = node
        this.vowel = source
        this.ref = parent
        this.pair = JSON.stringify(pair)
        this.parent = JSON.stringify(parent)
    }

    apply(score, store) {
        const child = this.node.children[this.vowel]
        if (this.node.parentless) {
            store.pop()
        } else {
            score = super.apply(score, store)
            if (score === undefined) return
        }
        if (!(child.uniq in store.sums)) store.sums[child.uniq] = {}
        store.sums[child.uniq][this.pair] = score
        store.push(child)
        if (this.pair in (store.pending[child.uniq] ?? {})) {
            const kv = store.pending[child.uniq][this.pair]
            delete store.pending[child.uniq][this.pair]
            store.heap.push(...kv)
        }
        return [score, this]
    }

    toString() {
        return `vowel ${this.vowel} ${this.node.comments}\n` +
            `prefixes ${this.pair} == `+
                `parents' ${this.parent} == `+
                `${JSON.stringify(this.rooted)} aligned (evens)\n` +
            `uniq ${this.node.uniq}\n${this.debug()}`
    }
}

class RootTrimmed {
    offset = 1

    constructor(node) {
        this.node = node
        console.assert(!node.parentless)
    }

    static de(node) { // Spanish "of" for namespace reasons
        return new Proxy(new RootTrimmed(node), {
            get(obj, prop, receiver) {
                return Reflect.get(prop in obj ? obj : obj.node, prop, receiver)
            }
        })
    }

    get uniq() {
        const res = this.node.uniq
        console.assert(res[0] === "[" && res[1] !== "]")
        return "[-1," + res.slice(1)
    }

    get children() {
        return new Proxy(this.node.children, {
            get: (target, prop) => target[prop] && RootTrimmed.de(target[prop])
        })
    }

    outgoing() {
        const res = this.node.outgoing()
        res.node = RootTrimmed.de(res.node)
        return res
    }
}

class VowelStart {
    constructor(node, child) {
        this.node = RootTrimmed.de(node.children[child])
    }

    apply(score, store) {
        store.pop()
        store.sums[this.node.uniq] = new Proxy({}, {
            has: (target, prop) => true,
            get: (target, prop) => score
        })
        store.push(this.node)
    }
}

class NonVowelEnd extends SumPends {
    offset = 1

    constructor(node, parent) {
        super()
        this.node = node
        this.ref = parent
        this.parent = JSON.stringify(parent)
    }

    apply(score, store) {
        score = super.apply(score, store)
        if (score === undefined) return
        return [score, this]
    }

    toString() {
        return `prefixes ${this.parent} == `+
                `${JSON.stringify(this.rooted)} aligned (evens)\n` +
            `uniq ${this.node.uniq}\n${this.debug()}`
    }
}

class NodeHeap extends MaxMergedMapped {
    constructor(node, sources, exceptions=undefined) {
        super(sources)
        this.node = node
        this.exceptions = exceptions === undefined ? {} : exceptions
    }

    remap(source, score, deref) {
        if (source === undefined) return [undefined, undefined]
        if (source in this.exceptions)
            return [score, this.exceptions[source](this.node, deref)]
        console.assert(deref.length === 2)
        const [v0, v1] = deref
        const refs = this.node.children[source].refs
        const res = [refs[v0], refs[v1]]
        return [score, new PrefixPair(this.node, source, deref, res)]
    }
}

class SuffixWalk extends MaxMergedKV {
    constructor(tree) {
        super({})
        this.push(tree)
        this.sums = {}
        this.pending = {}
    }

    next() {
        while (!this.heap.empty) {
            const kv = this.peek()
            console.assert(kv.length === 3)
            const [uniq, score, value] = kv
            const res = value.apply(score, this)
            if (res !== undefined) return { done: false, value: res }
        }
        return { done: true, value: undefined }
    }

    push(x) {
        const k = x.uniq
        if (!(k in this.sources)) super.push(k, x.outgoing())
    }
}

// Having a max heap for each vowel’s deltas independent of its parent’s score
//     isn’t the most efficient since the distance is fast to compute.
// It maybe scales better to KNN for bio applications but really it's just being
//     done this way for convenience's sake.
class Suffixes {
    offset = 0

    constructor(sim) {
        this.sim = sim
        this.children = [...Array(sim.vowels.length + 1)]
        this.prefixes = []
        this.refs = []
        this.cache = null
        this.path = []
    }

    init(parent, ref) {
        this.aligned = parent.aligned
        this.path = [...parent.path, ref]
        return this
    }

    get parentless() {
        return this.path.length === 0
    }

    get uniq() {
        return JSON.stringify(this.path)
    }

    debug(info) {
        this.comments = info
        return this
    }

    step(i) {
        return this.sim.group[this.aligned[i]][1]
    }

    get(i) {
        if (i === this.aligned.length) {
            return this.children[this.sim.vowels.length] ||=
                new Suffixes(this.sim).init(this, i).debug("$")
        }
        const vowel = this.step(i)
        if (this.children[vowel] === undefined) {
            this.children[vowel] = new Suffixes(this.sim)
                .init(this, vowel).debug(this.aligned[i])
        }
        return this.children[vowel]
    }

    build(seq) {
        this.aligned = this.sim.align(seq)
        this.debug(JSON.stringify(this.aligned))
        this.prefixes = [...Array(Math.trunc(this.aligned.length / 2))]
            .map((_, i) => i * 2)
        this.prefixes.forEach((i, j) => this.get(i + 1).resolve(i, j))
        return this
    }

    resolve(i, ref=null, word=null) {
        this.prefixes.push(i)
        this.refs.push(ref)
        const boundary = this.aligned[i].length > 1, leaf = this.childless
        word &&= word.concat(this.aligned[i].slice(0, 1))
        if (i >= this.aligned.length - 1) return
        if (!leaf || this.prefixes.length > 1 && !(boundary &&
                this.cache && JSON.stringify(word) == this.cache)) {
            this.cache = null
            const it = leaf ? this.prefixes.map((x, j) => [j, x]) :
                [[this.prefixes.length - 1, i]]
            for (const [j, k] of it) {
                this.get(k + 3).resolve(k + 2, j, boundary ?
                    this.aligned[i].slice(-1) : word)
            }
        } else if (boundary && word) {
            this.cache ||= JSON.stringify(word)
        }
    }

    get occupied() {
        return this.children.map((x, i) => x === undefined ? x : i)
            .filter(x => x !== undefined)
    }

    get branching() {
        return this.occupied.filter(x => !this.children[x].childless)
    }

    get childless() {
        return this.occupied.length === 0
    }

    prefix(rooted) {
        return this.aligned[rooted].map(x => x.join("-")).join("_")
    }

    indices() {
        console.assert(this.parentless)
        const last = this.aligned.length - 1
        const postfix = this.prefix(last)
        const digits = (last + "").length
        const prefixWidth = Math.max(
            ...this.prefixes.map((x => this.prefix(x).length).bind(this)))
        return this.prefixes.map(x => {
            const prefix = this.prefix(x)
            return " ".repeat(digits - (x + "").length) + x + "\t" +
                " ".repeat(prefixWidth - prefix.length) + prefix + "\t" +
                this.aligned[x + 1]
        }).join("\n") + "\n" + last + "\t" +
            " ".repeat(prefixWidth - postfix.length) + postfix
    }

    flat() {
        return this.childless ? this.prefixes : this.occupied
            .map(x => this.children[x].flat()).flat().map(x => x - 2)
    }

    toString() {
        let pre = ""
        if (!this.parentless) {
            pre = this.childless ? "\u2500" : "\u252C"
            pre += this.comments + " \u2190 "
            pre += this.flat().map(x => this.aligned[x].map(x =>
                x.join("-")).join("_")).join(" ")
        }
        const children = this.occupied.map(x => this.children[x].toString())
        return pre + (children.length > 1 ? "\n" : "") + children.slice(0, -1)
            .map(x => "\u251C" + x.replace(/\n/g, "\n\u2502")).join("\n") +
            (children.length ? "\n\u2514" + children
                .slice(-1)[0].replace(/\n/g, "\n ") : "")
    }

    consonants() {
        return this.prefixes.map(x =>
            this.aligned[x].flat().map(x => this.sim.group[x][1])
                .filter(x => x !== null))
    }

    incoming(offset=null) {
        const res = offset === null ? new Ngram(this.sim) :
            new OverlayKV(this.sim, offset)
        res.push(...this.consonants())
        return res
    }

    partials() {
        const res = new Ngram(this.sim), postfixes = []
        this.occupied.forEach(x => {
            postfixes.push(...this.children[x].refs)
            res.push(...this.children[x].consonants())
        })
        res.mapping = postfixes
        return res
    }

    outgoing() {
        const res = Object.fromEntries(
            this.occupied
                .map(x => [x, this.children[x].incoming(
                    this.sim.vowels[x]?.[x])])
                .filter(([k, v]) => k !== this.sim.vowels.length && !v.empty))
        if (this.parentless) {
            if (this.branching.length) res[-1] = new MaxHeapPeek()
            this.branching.forEach(x => res[-1].push(this.sim.vowels[x][x], x))
            return new NodeHeap(this, res, {
                "-1": (...x) => new VowelStart(...x)})
        } else if (this.prefixes.length > 1) {
            if (this.occupied.length) res[-1] = this.partials()
            return new NodeHeap(this, res, {
                "-1": (...x) => new NonVowelEnd(...x)})
        }
    }

    [Symbol.iterator]() {
        console.assert(this.parentless)
        return new SuffixWalk(this)
    }

    sorted() {
        return [...this].toSorted((a, b) => b[0] - a[0])
    }
}

async function lcs(seq) {
    const bar = await dict.seq(seq)
    await phonemes.load
    return new Suffixes(phonemes).build(bar)
}

// pairs of multi-syllable spans that sound alike, flattened per syllable
class Rhymes {
    // dictionary stress on monosyllables is citation form; in a lyric these
    // are usually unstressed so they only count as part of a longer match
    static unstressed = new Set((
        "a an the to of in on at by for with from up as and or but nor so " +
        "if than then that this these those is am are was were be been it " +
        "it's its i i'm i'd i'll me my you you're your he he's him his she " +
        "her we we're us our they them their what who do does did have has " +
        "had not no can will would should could just there here").split(" "))

    constructor(pronunciations, words=[]) {
        this.pronunciations = pronunciations
        this.owner = []  // vowel index -> [word, syllable in word]
        this.stressed = []
        const seq = []
        pronunciations.forEach((p, i) => {
            const stress = p?.match(/[012]/g)
            if (!stress) return
            seq.push(p)
            const weak = stress.length === 1 &&
                Rhymes.unstressed.has(words[i]?.toLowerCase())
            stress.forEach((d, j) => {
                this.owner.push([i, j])
                this.stressed.push(d !== "0" && !weak)
            })
        })
        this.matches = seq.length < 2 ? [] :
            new Suffixes(phonemes).build(seq).sorted()
        this.vowels = seq.map(x => x.match(/[A-Z]+(?=[012])/g)).flat()
    }

    spans(match) {
        return match.comparing().map(([lo, hi]) => {
            const res = []
            for (let i = lo | 1; i < hi; i += 2) {
                const k = (i - 1) / 2
                if (k >= 0 && k < this.owner.length) res.push(k)
            }
            return res
        })
    }

    // a stressed vowel on both sides lines up, and every stressed vowel
    // lines up with one that's closer than chance
    assonant(v0, v1) {
        if (v0.length !== v1.length) return false
        let anchored = false
        for (let i = 0; i < v0.length; i++) {
            const s0 = this.stressed[v0[i]], s1 = this.stressed[v1[i]]
            if (!s0 && !s1) continue
            anchored ||= s0 && s1
            if (phonemes.lookup(this.vowels[v0[i]], this.vowels[v1[i]]) <= 0)
                return false
        }
        return anchored
    }

    // lineOf: word index -> line number
    // returns {word: {syllable: [hue, strength, [partner vowel indices]]}}
    paint(lineOf, threshold, gap) {
        const best = new Map(), partners = new Map()
        const colors = phonemes.vowelColors
        for (const [score, match] of this.matches) {
            if (score < threshold) break
            const spans = this.spans(match)
            if (!this.assonant(...spans)) continue
            const [a, b] = spans.map(v => [v[0], v.at(-1)].map(
                k => lineOf[this.owner[k][0]]))
            if (Math.max(0, b[0] - a[1], a[0] - b[1]) > gap) continue
            spans.forEach((v, side) => v.forEach(k => {
                if (!best.has(k)) best.set(k, score)
                if (!partners.has(k)) partners.set(k, new Set())
                for (const j of spans[side ^ 1]) partners.get(k).add(j)
            }))
        }
        const res = {}
        for (const [k, score] of best) {
            const [word, syl] = this.owner[k]
            const strength = Math.min(1, 0.6 + 0.4 * (score - threshold) /
                (2 * threshold))
            ;(res[word] ??= { pronunciation: this.pronunciations[word] })[syl] =
                [colors[this.vowels[k]], +strength.toFixed(2),
                 [...partners.get(k)].map(j => this.owner[j])]
        }
        return res
    }
}

class Edit {
    constructor(iter0, iter1, n=undefined, m=undefined) {
        this.iter0 = iter0
        this.iter1 = iter1
        this.n = n === undefined ? iter0.length : n
        this.m = m === undefined ? iter1.length : m
        this.dp = [...Array(this.n + 1)].map(x => {
            return [...Array(this.m + 1)].map(y => null)
        })
    }

    toString() {
        const directions = this.dp.slice(1).map(x => x.slice(1).map(y => {
            switch (y && y[1]) {
                case null: return " ";
                case 1: return "\u2191"
                case 2: return "\u2190"
                case 0: case 3: return "\u2196"
            }
        }).join("")).join("\n")
        if (typeof this.iter0 !== "string") return directions
        const rows = directions.split("\n").map((x, i) => {
            return this.iter0[i] + x + this.iter0[i]
        }).join("\n")
        return " " + this.iter1 + "\n" + rows + "\n " + this.iter1
    }

    _path = null
    get path() {
        if (this._path === null) {
            this.loader(this.n, this.m)
            this._path = []
            let n = this.n, m = this.m, step
            while (n > 0 && m > 0) {
                step = this.dp[n][m][1]
                this._path.push(step)
                n -= ((step || 3) & 1)
                m -= ((step || 3) & 2) >> 1
            }
            const [base, i] = n === 0 ? [m, 2] : [n, 1];
            this._path = this._path.concat([...Array(base).keys()].map(x => i))
            this._path.reverse()
        }
        return this._path
    }

    // n shift is lowest bit, m shift is next
    loader(n, m) {
        if (n === 0) return [m, 2];
        if (m === 0) return [n, 1];
        if (this.dp[n][m] !== null) return this.dp[n][m];
        if (this.iter0[n - 1] === this.iter1[m - 1]) {
            let prev = this.dp[n - 1][m - 1]
            if (prev === null) prev = this.loader(n - 1, m - 1)
            return this.dp[n][m] = [prev[0], 0]
        }
        let options = []
        for (let i = 1; i < 4; i++) {
            const j = n - (i & 1), k = m - ((i & 2) >> 1)
            let prev = this.dp[j][k]
            if (prev === null) prev = this.loader(j, k)
            options.push(prev[0] + 1)
        }

        // min options
        if (options[0] <= options[1] && options[0] <= options[2])
            return this.dp[n][m] = [options[0], 1];
        if (options[1] <= options[0] && options[1] <= options[2])
            return this.dp[n][m] = [options[1], 2];
        else
            return this.dp[n][m] = [options[2], 3];
    }

    walk(f, arr, bit) { // f(element, rewritten, index)
        for (let i = 0, d = 0; i < arr.length; i++) {
            const x = this.path[i]
            if ((x & bit) === bit) f(arr[i - d], x === 3, i - d)
            d += (x === (bit ^ 3))
        }
    }

    removed(f) {
        return this.walk(f, this.iter0, 1)
    }

    added(f) {
        return this.walk(f, this.iter1, 2)
    }
}

class Editing {
    value = ""
    words = []
    _pronunciations = []
    constructor(cursor) {
        this.cursor = cursor
        this._separators = this.memoize(this._separators)
        this._raw = this.memoize(this._raw)
        this._pronounce = this.memoize(this._pronounce)
        this._meter = this.memoize(this._meter)
    }

    strip = /[^a-zA-Z']/g
    split = /[\s\-_]/g
    version = /\{([0-9]+)\}[^a-zA-Z']*$/
    manual = /\{([/\*]*)\}[^a-zA-Z']*$/

    async update(value) {
        const words = value.split(this.split).map(
            x => x.replace(this.strip, ""))
        const edit = new Edit(this.words, words)
        this.words = words
        this.value = value
        let added = [], idx = []
        edit.added((x, rewrite, i) => {
            added.push(x)
            idx.push([i, rewrite])
        })
        let res = await this.cursor.lookup(added)
        let removing = []
        edit.removed((x, rewrite, i) => {
            if (!rewrite) removing.splice(0, 0, i)
        })
        for (const i of removing) {
            this._pronunciations.splice(i, 1)
        }
        res.forEach((i, j) => {
            let [next, rewrite] = idx[j]
            this._pronunciations.splice(next, rewrite ? 1 : 0, i)
        })
        // console.assert(this._pronunciations.length === words.length)
        this.clearCache()
    }

    cache = []
    memoize(f) {
        const idx = this.cache.push(undefined)
        return () => {
            if (this.cache[idx] === undefined)
                this.cache[idx] = Object.freeze(f.call(this))
            return this.cache[idx]
        }
    }

    clearCache() {
        this.cache = this.cache.map(x => undefined)
    }

    _separators() {
        const res = this.value.match(this.split)
        return res === null ? [] : res
    }

    _raw() {
        return this.value.split(this.split)
    }

    _pronounce() {
        return this._pronunciations.map((x, i) => {
            if (!x) return x
            const pronunciation = this.raw[i].match(this.version)
            if (pronunciation) {
                const version = parseInt(pronunciation[1])
                return version < x.length ? [x[version]] : undefined
            }
            return x
        })
    }

    _meter() {
        const options = this.pronunciations.map(x => x?.map(y =>
            y.replace(/[^012]/g, "").replace(/[12]/g, "/").replace(/0/g, "X")))
        const raws = this.raw
        return options.map((x, i) => {
            const raw = raws[i]
            const curly = raw.match(this.manual)
            if (curly) return curly[1].replace(/\*/g, "X")
            if (!x) return raw ? "?" : ""
            return x[0]
        })
    }

    get separators() { return this._separators() }
    get raw() { return this._raw() }
    get meter() { return this._meter() }
    get pronunciations() { return this._pronounce() }
}

function debounce(ms, f) {
    let request_controller = null
    return (...args) => {
        if (request_controller !== null) {
            request_controller.abort();
        }
        request_controller = new AbortController();
        const signal = request_controller.signal;
        setTimeout(() => {
            if (signal.aborted) return;
            f(...args)
        }, ms);
    }
}

class DoubleSpaced {
    resize_debounce_ms = 100
    constructor(cursor, wrapper, load=true) {
        this.editor = new Editing(cursor)
        this.wrapper = wrapper
        this.foreground = this.wrapper.getElementsByClassName("foreground")[0]
        this.background = this.wrapper.getElementsByClassName("background")[0]
        this.fold = this.wrapper.getElementsByClassName("fold")[0]
        this.gutter = this.wrapper.getElementsByClassName("gutter")[0]
        const fgCase = this.wrapper.getElementsByClassName("foreground-case")[0]
        this.container = this.wrapper.insertBefore(
            document.createElement("div"), fgCase)
        this.container.classList.add("container")
        this.reference = this.container.appendChild(
            document.createElement("div"))
        this.reference.classList.add("reference")
        this.foreground.addEventListener("input", this.update.bind(this))
        this.foreground.addEventListener("input", this.save.bind(this))
        new ResizeObserver(this.resize.bind(this)).observe(this.reference)
        this.bindFold()
        if (load) this.load()
        this.update()
        this.parse()
    }

    save() {
        window.localStorage["saved"] = this.foreground.value
    }

    loaded = false
    load() {
        if ("saved" in window.localStorage) {
            this.foreground.value = window.localStorage["saved"]
            this.loaded = true
        }
    }

    update() {
        const changed = this.foreground.value
        const eof = changed.slice(-1) === "\n" ? "\u200B" : ""
        this.reference.innerText = "\u200B" + changed + eof
    }

    resize(e) {
        if (this.wrapper.classList.contains("selecting")) return
        const res = Math.max(
            this.background.getBoundingClientRect().height,
            this.reference.getBoundingClientRect().height)
        this.wrapper.style.setProperty("--input-height", res + "px")
        this.reflow()
    }

    _reflow
    reflow() {
        if (this._reflow === undefined)
            this._reflow = debounce(this.resize_debounce_ms, () => {
                const height = parseInt(this.props.lineHeight);
                let hi = this.reference.getBoundingClientRect().top
                let ele = this.gutter.firstChild, el = this.reference.firstChild
                const breaks = Array.prototype.filter.call(
                    this.editor.value, x => x === "\n").length
                let lim = 0
                for (let i = 0, j = 0; i <= breaks; i++, el = el?.nextSibling) {
                    let lo
                    while (el && (el.nodeType !== 1 || el.tagName !== "BR")) {
                        if (el.classList?.contains("below-fold")) {
                            const bbox = el.getBoundingClientRect()
                            hi = bbox.top - parseInt(
                                el.style.getPropertyValue("--fold-hides"))
                            lo = bbox.bottom
                            break
                        }
                        el = el.nextSibling
                    }
                    lo = lo !== undefined ? lo : el ?
                        el.getBoundingClientRect().bottom :
                        this.reference.getBoundingClientRect().bottom
                    const size = Math.round((lo - hi) / height);
                    hi = lo
                    if (ele === null) {
                        ele = document.createElement("div")
                        this.gutter.appendChild(ele)
                        ele.setAttribute("data-line", i)
                    }
                    let total = 0
                    do {
                        total += this.editor.meter[j]?.length || 0
                    } while (j++ < this.editor.separators.length &&
                        this.editor.separators[j - 1] !== "\n")
                    lim = Math.max(lim, total)
                    ele.setAttribute("data-count", total)
                    let k = 0
                    do {
                        k++
                        ele = ele && ele.nextSibling
                    } while (ele && !ele.getAttribute("data-line"))
                    for (; k > size; k--) this.gutter.removeChild(
                        ele?.previousSibling ||
                        this.gutter.lastElementChild)
                    for (; k < size; k++) this.gutter.insertBefore(
                        document.createElement("div"), ele)
                    while (el && (el.nodeType !== 1 || el.tagName !== "BR")) {
                        el = el.nextSibling
                    }
                }
                for (let prev; prev = ele;) {
                    ele = ele.nextSibling
                    this.gutter.removeChild(prev)
                }
                this.wrapper.style.setProperty(
                    "--gutter-chars", lim.toString().length)
                if (this.wrapper.classList.contains("split")) this.unfold()
            })
        this._reflow()
    }

    fill = "\xa0"
    async parse() {
        this.editor.update(this.foreground.value).then(() => {
            const limits = this.editor.raw.map(x => x.length)
            const padded = this.editor.raw.concat([""])
            const sep = this.editor.separators.map((x, i) => {
                if (x === " ") return " "
                if (x === "\n") return "\x0a"
                const next = padded[i + 1].slice(0, 1)
                const wordish = next.length && !next.match(this.editor.strip)
                return wordish ? "\xA0\u200B" : "\xA0"
            }).concat([""])
            this.meterWords = this.editor.meter.map(
                (x, i) => [this.meterWord(x, limits[i]), sep[i]])
            this.renderMeter(this.meterWords, this.rhymeColors())
            this.resize()
            this.scheduleRhymes()
        })
    }

    rhymeOptions = { threshold: 4, gap: 4 }
    rhymeDebounceMs = 300
    #rhymes = null
    #rhymeKey
    #rhymeTimer
    #painted = null
    get rhymed() {
        return this.wrapper.classList.contains("rhymed")
    }

    scheduleRhymes(force=false) {
        if (!this.rhymed) return
        const prons = this.editor.pronunciations.map(x => x?.[0])
        const words = this.editor.words
        const key = JSON.stringify([prons, words])
        if (key === this.#rhymeKey && !force) return
        this.#rhymeKey = key
        let line = 0
        const lineOf = prons.map((_, i) =>
            line += i > 0 && this.editor.separators[i - 1] === "\n")
        window.clearTimeout(this.#rhymeTimer)
        this.#rhymeTimer = window.setTimeout(async () => {
            await phonemes.load
            if (key !== this.#rhymeKey) return
            this.#rhymes = new Rhymes(prons, words)
            this.#rhymes.lineOf = lineOf
            this.repaint()
        }, this.rhymeDebounceMs)
    }

    repaint() {
        if (this.#rhymes === null || this.meterWords === undefined) return
        const { threshold, gap } = this.rhymeOptions
        this.#painted = this.#rhymes.paint(this.#rhymes.lineOf, threshold, gap)
        this.renderMeter(this.meterWords, this.rhymeColors())
    }

    // drops stale entries where the word or its meter changed since painting
    rhymeColors() {
        if (this.#painted === null || !this.rhymed) return null
        const prons = this.editor.pronunciations, meter = this.editor.meter
        const res = {}
        for (const [i, { pronunciation, ...syls }] of
                Object.entries(this.#painted)) {
            if (prons[i]?.[0] !== pronunciation) continue
            if (meter[i]?.length !== pronunciation.match(/[012]/g).length)
                continue
            res[i] = Object.fromEntries(Object.entries(syls).map(
                ([j, [tint, strength]]) => [j, [tint, strength]]))
        }
        return res
    }

    // [[text, syllable index | null]...] with the whitespace between two
    // stress marks split evenly so each syllable's span covers its share of
    // the word's width
    meterWord(x, limit) {
        const whitespace = limit - x.length
        const lo = Math.trunc(whitespace / (x.length + 1))
        const wide = whitespace % (x.length + 1)
        const owners = [], chars = []
        const gap = (n, before, after) => {
            for (let k = 0; k < n; k++) {
                chars.push(this.fill)
                owners.push(k < (before === null ? 0 :
                    after === null ? n : Math.floor(n / 2)) ? before : after)
            }
        }
        const n = x.length
        gap(lo, null, n ? 0 : null)
        x.split('').forEach((y, j) => {
            chars.push(y)
            owners.push(j)
            gap(lo + (j < wide), j, j + 1 < n ? j + 1 : null)
        })
        // "w" breaks this
        // console.assert(x.length <= limit)
        chars.splice(limit)
        owners.splice(limit)
        const res = []
        chars.forEach((c, k) => {
            if (k && owners[k] === owners[k - 1]) res[res.length - 1][0] += c
            else res.push([c, owners[k]])
        })
        return res
    }

    #meterKey
    renderMeter(words, colors=null) {
        if (words === undefined) return
        const key = JSON.stringify([words, colors])
        if (key === this.#meterKey) return
        this.#meterKey = key
        const frag = document.createDocumentFragment()
        words.forEach(([segs, sep], i) => {
            for (const [text, syl] of segs) {
                if (syl === null) {
                    frag.appendChild(document.createTextNode(text))
                    continue
                }
                const el = frag.appendChild(document.createElement("span"))
                el.textContent = text
                el.className = "syl"
                el.dataset.word = i
                el.dataset.syl = syl
                const color = colors?.[i]?.[syl]
                if (color) {
                    el.classList.add("rhyme")
                    el.style.setProperty("--rhyme", color[0].light)
                    el.style.setProperty("--rhyme-dark", color[0].dark)
                    el.style.setProperty("--strength", color[1])
                }
            }
            if (sep) frag.appendChild(document.createTextNode(sep))
        })
        const [pre, post] = this.meters
        pre.replaceChildren(frag)
        post.replaceChildren(...pre.cloneNode(true).childNodes)
    }

    get meters() {
        if (this.background.children.length < 2) {
            for (const cls of ["meter-pre", "meter-post"])
                this.background.appendChild(document.createElement("div"))
                    .classList.add("meter", cls)
        }
        return this.background.getElementsByClassName("meter")
    }

    firstFocus() {
        const size = this.editor.value.length
        if (!this.loaded) this.foreground.setSelectionRange(0, size);
    }

    get props() {
        return window.getComputedStyle(this.foreground)
    }

    bindFold() {
        const unscroll = e => {
            if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                this.foreground.scrollTop = 0;
                window.setTimeout(() => { this.foreground.scrollTop = 0 }, 0)
            }
        }
        document.addEventListener("keydown", unscroll)
        document.addEventListener("keypress", unscroll)
        this.caretMove(this.foreground, () => {
            this.parse()
            this.unfold()
        })
        // this.foreground.addEventListener("blur", this.join.bind(this))
        this.reference.addEventListener("keypress", e => e.preventDefault())
        this.reference.addEventListener("input", e => {
            this.foreground.value = this.reference.innerText
            this.forward(e)
            this.wrapper.classList.remove("selecting")
            this.parse()
            this.unfold()
        })
        this.foreground.addEventListener(
            "mousedown", e => window.setTimeout(() => this.join(e), 0),
            { passive: true })
        this.foreground.addEventListener("touchstart", this.join.bind(this), {
            passive: true })
        let selectionEndOOB = false
        this.reference.addEventListener("selectstart", e => {
            selectionEndOOB = true
            this.wrapper.classList.add("selecting")
            this.wrapper.style.setProperty("--fold-height",
                this.fold.getBoundingClientRect().height + "px")
        })
        window.addEventListener("mouseup", e => {
            if (selectionEndOOB ||
                    e.target.closest(".reference") === this.reference)
                this.forward(e)
            this.wrapper.classList.remove("selecting")
            selectionEndOOB = false
        })
    }

    #selectionEnd = -1
    caretMove(el, f) {
        // https://stackoverflow.com/a/53999418
        const check = (e => {
            check12(e)
            window.setTimeout(() => check12(e), 0)
        })
        const check12 = (e => {
            const next = el.selectionEnd;
            if (next !== this.#selectionEnd) {
                f(e, next, this.#selectionEnd)
                this.#selectionEnd = next
            }
        }).bind(this)
        el.addEventListener('blur', () => { this.#selectionEnd = -1 });
        el.addEventListener('keydown', check);
        el.addEventListener('keypress', check);
        el.addEventListener('keyup', check);
        el.addEventListener('mouseup', check);
        el.addEventListener('touchend', check);
        el.addEventListener('input', check);
        el.addEventListener('select', check);
        el.addEventListener('selectstart', check);
        el.addEventListener('selectend', check);
    }

    lineRef = null
    unfold() {
        this.hoistBelow()
        Array.prototype.map.call(this.wrapper.getElementsByClassName(
            "long-break"), x => { x.parentElement.removeChild(x) })
        const offset = this.foreground.selectionEnd
        const substr = this.foreground.value.slice(0, offset)
        const breaks = (substr.match(/\n/g)||[]).length
        let el = this.reference.firstChild
        while(el === this.lineRef) el = el.nextSibling
        for (let i = 0; el !== null && i < breaks; i += el?.nodeType === 1) {
            while((el = el.nextSibling) === this.lineRef){}
        }
        const baseline = el?.nodeType === 1 ? el.getBoundingClientRect() : null
        let parent = this.wrapper.getBoundingClientRect().y
        if (this.wrapper.classList.contains("split"))
            parent += this.fold.getBoundingClientRect().height
        const start = baseline ? baseline.y + baseline.height - parent : 0
        const div = this.container.appendChild(document.createElement("div"))
        div.classList.add("line-ref")
        const last = substr.match(/(?<=^|\n)[^\n]*$/)[0]
        const end = this.foreground.value.slice(offset - last.length)
            .match(/^[^\n]*(?=\n|$)/)[0]
        const extra = end.slice(last.length).search(this.editor.split)
        const broken = last.slice(-1).match(this.editor.split)
        const wrap = end.slice(0, broken ? last.length :
            extra === -1 ? end.length : last.length + extra)
        const rewrite = div.appendChild(document.createTextNode(wrap))
        const bbox = div.getBoundingClientRect()

        const eol = div.appendChild(document.createElement("span"))
        eol.innerText = " "
        const char = eol.getBoundingClientRect()

        rewrite.textContent = end
        const pad = parseFloat(this.props.paddingLeft)

        let ref = eol.getBoundingClientRect(), wrapped
        while(ref.bottom !== char.bottom && rewrite.textContent !== "") {
            const clientX = ref.left - bbox.left - pad
            wrapped = Math.round(clientX / char.width)
            rewrite.textContent = rewrite.textContent.slice(0, -wrapped)
            ref = eol.getBoundingClientRect()
        }

        const clientX = ref.left - bbox.left - pad
        const above = Math.round(clientX / char.width)
        const headline = rewrite.textContent.length

        div.removeChild(eol)
        if (this.lineRef !== null)
            this.lineRef.parentElement?.removeChild(this.lineRef)
        this.lineRef = div

        const long = end.length - wrapped > last.length
        const br = long ? el : el?.nextElementSibling;
        let ele = br?.nodeType === 1 ? br?.nextSibling : br
        if (long) {
            this.reference.insertBefore(this.container.removeChild(div), ele)
            const belowCase = document.createElement("div")
            belowCase.classList.add("below-fold")
            this.reference.insertBefore(belowCase, ele)
            const cutoff = belowCase.appendChild(document.createElement("div"))
            cutoff.classList.add("below-cutoff")
            cutoff.innerText = end.slice(headline)
            const below = document.createElement("div")
            below.appendChild(this.reference.removeChild(ele))
            below.classList.add("below-init")
            belowCase.appendChild(below)
            ele = belowCase
            belowCase.style.setProperty("--fold-hides", bbox.height + "px")
        }
        this.reference.insertBefore(document.createElement("div"),
            ele).classList.add("long-break")

        this.split(undefined, start + bbox.height)
        this.foreground.scrollTop = 0

        const caret = offset === this.foreground.selectionStart
        this.expand(breaks, caret ? last.length : -1,
            ...(above === 0 ? [] : [headline - above, headline]))

        this.wrapper.style.setProperty("--fold-height",
            this.fold.getBoundingClientRect().height + "px")
        // window.setTimeout(() => {
        //     this.wrapper.classList.add("selecting")
        //     this.reference.style.setProperty("--fold-height",
        //         this.fold.getBoundingClientRect().height + "px")
        // }, 1000)
    }

    expand(breaks, cursor, start, end) {
        while (this.fold.firstChild) this.fold.removeChild(this.fold.firstChild)
        const el = document.createElement("div")
        el.classList.add("word-ref")
        this.container.appendChild(el)
        const container = el.getBoundingClientRect().left
        const sep = this.editor.separators
        const raw = this.editor.raw
        let i = 0, j = 0, char = 0, pos = 0, active = null
        for (let seen = 0; i < sep.length && seen < breaks;)
            seen += (sep[i++] === "\n")
        while (start !== undefined && char < start && i < raw.length)
            char += raw[i++].length + 1
        for (j = i; (end === undefined || char < end) && j < raw.length &&
                (j === i || sep[j - 1] !== "\n"); char += raw[j++].length + 1) {
            const ele = el.appendChild(document.createElement("span"))
            ele.innerText = raw[j]
            if (j < sep.length) el.appendChild(document.createTextNode(sep[j]))
            const bbox = ele.getBoundingClientRect()
            const clientX = bbox.left - container
            const center = clientX + bbox.width / 2
            const cur = cursor >= char && cursor <= char + raw[j].length
            const pad = center - pos
            this.annotate(j, clientX, bbox.width, pad, cur)
            if (cur) active = [j, clientX, bbox.width, pad]
            pos = center
        }
        this.container.removeChild(el)
        // this.fold.appendChild(document.createElement("div"))
        //     .classList.add("close")
        if (active !== null) this.suggest(...active)
        else this.fold.style.removeProperty("--word-width")
    }

    suggest(idx, left, width, pad) {
        const wrapper = this.fold.appendChild(document.createElement("div"))
        wrapper.classList.add("suggestions")
        const el = wrapper.appendChild(document.createElement("div"))
        const f = eles => eles.forEach((x, i) => {
            if (i > 0) el.appendChild(document.createElement("span"))
                .classList.add("sep")
            const ele = el.appendChild(document.createElement("span"))
            ele.innerText = x
            ele.classList.add("opt")
        })
        const options = this.editor.pronunciations[idx];
        if (options?.length > 1) {
            f(options)
        } else if (options) { }
    }

    annotate(idx, left, width, pad, cur) {
        const el = this.fold.appendChild(document.createElement("span"))
        el.style.setProperty("--left-pad", pad + "px") // haha left pad
        let child = el
        for (let i = 0; i < 2; i++)
            child = child.appendChild(document.createElement("span"))
        if (cur) {
            el.classList.add("active")
            this.fold.style.setProperty("--word-width", width + "px")
            this.fold.style.setProperty("--word-offset", left + "px")
        }
        const options = this.editor.pronunciations[idx]
        if (options?.length > 1) {
            el.classList.add("unclear")
            el.style.setProperty("--versions", `'${options.length}'`)
        } else if (options) {
            child.innerText = options[0]
        }
    }

    hoistBelow() {
        let folded = this.wrapper.getElementsByClassName("below-fold")
        for (const el of folded) {
            const ele = el.getElementsByClassName("below-init")[0]
            el.parentElement.insertBefore(ele.removeChild(ele.firstChild), el)
            el.parentElement.removeChild(el)
        }
    }

    split(line, clientY) {
        this.wrapper.classList.add("split")
        const props = this.props
        const height = parseInt(props.lineHeight)
        const size = parseInt(props.fontSize)
        if (line === null || line === undefined)
            line = Math.round(clientY / height)
        // 0.5em to cut off in unoccupied space
        const off = line * height + 0.5 * size;
        this.wrapper.style.setProperty("--offset", off + "px")
        this.reference.setAttribute("contenteditable", "true")
        Array.prototype.map.call(this.wrapper.getElementsByClassName(
            "fold-spacer"), x => { x.classList.remove("fold-spacer") })
        this.gutter.children[line]?.classList.add("fold-spacer")
    }

    lineCount(el, offset) {
        if (el.parentElement?.parentElement?.classList.contains("below-fold"))
            el = el.parentElement.parentElement
        let sliding = 0
        if (el?.parentElement === this.lineRef) {
            el = this.lineRef.previousSibling
            offset += (el === null ? 0 : el.textContent.length) + 1
        }
        if (el === this.reference) {
            el = this.reference.childNodes[offset]
            offset = 0
            const prev = el.previousSibling
            sliding = prev.nodeType === 1 && prev.tagName === "BR"
        }
        while (el = el?.previousSibling) {
            if (el.nodeType === 3) offset += el.textContent.length
            else if (el.nodeType === 1) {
                if (el.tagName === "BR") offset++
                else if (el.classList.contains("below-fold")) {
                    const ele = el.getElementsByClassName("below-cutoff")[0]
                    offset += ele.innerText.length - sliding
                } else if (el.classList.contains("line-ref"))
                    offset += el.textContent.length + (
                        el.previousSibling === null);
            }
        }
        return offset - 1
    }

    forward(e) {
        const sel = window.getSelection()
        if (sel.type === "none") return
        const range = sel.getRangeAt(0)
        const start = this.lineCount(range.startContainer, range.startOffset)
        const end = this.lineCount(range.endContainer, range.endOffset)
        if (this.lineRef?.parentElement === this.reference) {
            this.reference.removeChild(this.lineRef)
        }
        this.wrapper.classList.remove("split")
        this.resize()
        window.setTimeout(() => {
            this.foreground.setSelectionRange(start, end)
            this.foreground.focus()
        }, 0)
    }

    join(e) {
        if (e?.relatedTarget === this.reference) return
        this.#selectionEnd = -1
        this.wrapper.classList.remove("split")
        this.foreground.scrollTop = 0
        this.wrapper.style.setProperty("--fold-height", "0")
    }
}

let ed

const [ firstFocus, focusCallback ] = (() => {
    let callback, waiter = new Promise((resolve, reject) => callback = resolve)
    let first = async function() {
        first = async function() {}
        if (ed !== undefined) return ed.firstFocus()
        await waiter
        ed.firstFocus()
    }
    return [() => first(), callback]
})()

function storedBool(id, stateful, cls, init) {
    const el = document.getElementById(id)
    if (!(id in window.localStorage))
        window.localStorage[id] = init
    const f = () => {
        window.localStorage[id] = el.checked
        if (el.checked) stateful.classList.add(cls)
        else stateful.classList.remove(cls)
    }
    el.checked = JSON.parse(window.localStorage[id])
    f()
    el.addEventListener("change", f)
}

const phonePhrase = "New York City gritty committee pity the fool"
lcs(phonePhrase).then(tree => {
    console.log("" + phonePhrase + tree)
    console.log(tree.indices())
    const ordered = tree.sorted()
    // for (const i of [24, 10, 66]) {
    for (let i = 0; i < ordered.length; i++) {
        const [score, summable] = ordered[i]
        console.log(score.toFixed(1), summable + "\n", summable)
        console.log(ordered[i][1].refine())
    }
})

if (isNode) {
    compare("battery", "battle me")
    compare("orange", "door hinge")

    /*
    retrieve("index.html").then(res => res.text()).then(res => {
        res = res.match(/<textarea[^>]*>\s*(.*)<\/textarea>/s)[1]
        res = res.replace(/\s\S+{[\/\*]+}/g, "").replace(/{[0-9]+}/g, "")
        res = res.replace(/[-_]/g, " ").replace(/[,\?]/g, "")
        return res.replace(/\n/g, " ")
    }).then(lcs).then(tree => {
        console.log(tree.toString()())
    })
    */
} else {
    window.addEventListener("load", async function() {
        const pre = document.getElementsByClassName("double-spaced")[0]
        ed = new DoubleSpaced(dict, pre)
        focusCallback()
        const status = document.getElementById("load-status")
        const button = document.getElementById("load-dict")
        const download = () => {
            button.style.display = "none"
            status.innerText = "being downloaded"
            dict.load((portion, total) => {
                status.innerText = `being downloaded (${portion} of ${total})`
            }, () => status.innerText = "being stored").then(() => {
                status.innerText = "local"
            }).catch(e => {
                status.innerText = "remote (download failed)"
                button.style.display = "initial"
                button.innerText = "retry"
                console.error(e)
            })
        }
        if (await dict.loading) status.innerText = "local"
        else if (!(await dict.remoteAvailable)) download()
        else {
            status.innerText = "remote"
            button.style.display = "initial"
            button.addEventListener("click", download)
        }
        const clear = document.getElementById("clear-state")
        const clearStatus = document.getElementById("clear-status")
        clear.addEventListener("click", () => {
            delete window.localStorage["saved"]
            clearStatus.innerText = "clearing..."
            dict.clear().then(() => {
                clearStatus.innerText = ""
                status.innerText = "remote"
                button.style.display = "initial"
            }).catch(e => {
                clearStatus.innerText = "clear operation failed"
                throw e
            })
        })
        storedBool("pronunciations", pre, "splittable", true)
        storedBool("syllable-counts", pre, "counted", false)
        storedBool("meter", pre, "metered", true)
        storedBool("rhymes", pre, "rhymed", true)
        document.getElementById("rhymes").addEventListener("change", () => {
            ed.scheduleRhymes(true)
            ed.renderMeter(ed.meterWords, ed.rhymeColors())
        })
        for (const [id, key] of [
                ["rhyme-threshold", "threshold"], ["rhyme-gap", "gap"]]) {
            const el = document.getElementById(id)
            if (id in window.localStorage) el.value = window.localStorage[id]
            const f = () => {
                window.localStorage[id] = el.value
                ed.rhymeOptions[key] = parseFloat(el.value)
                el.title = el.value
            }
            f()
            el.addEventListener("input", () => { f(); ed.repaint() })
        }
    })
}
