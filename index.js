"use strict"

class Cursor {
    url = "https://raw.githubusercontent.com/Alexir/CMUdict/master/cmudict-0.7b"
    local = "cmudict-0.7b"
    lexicon = 125770

    #db;
    constructor() {
        this.create()
    }

    create() {
        const request = indexedDB.open("words", 1);
        let done;
        this.loading = new Promise((resolve, reject) => done = resolve)
        this.loaded = new Promise((resolve, reject) => this.status = s => {
            this.status = s => {}
            resolve(s)
        })

        request.onupgradeneeded = (event) => {
            const db = event.target.result
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
            }).bind(this)
        }
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

    async load(progress = () => {}, storing = () => {}) {
        const db = this.#db, lexicon = this.lexicon, commits = [];
        console.info("populating pronunciation db")
        return fetch((await this.remoteAvailable) ? this.local : this.url)
            .then((response) => {
                if (!response.ok) {
                    reject(response)
                }
                return response.body.getReader();
            })
            .then(async function(reader) {
                let prefix = "", existing = [], prev = "", total = 0
                const pump = async () => {
                    const { done, value } = await reader.read();

                    const tx = db.transaction("pronunciations", 'readwrite');
                    const store = tx.objectStore("pronunciations");

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
                                commits.push(new Promise((resolve, reject) => {
                                    const op = store.add({
                                        word: prev,
                                        pronunciation: existing
                                    });
                                    op.onsuccess = resolve
                                    op.onerror = reject
                                }))
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
                        console.info("downloaded", total, "of", lexicon,
                            "rows; % complete:",
                            Math.round(total / lexicon * 1000) / 10)
                        progress(total, lexicon)
                        return pump()
                    }
                    commits.push(new Promise((resolve, reject) => {
                        const op = store.add({
                            word: prev,
                            pronunciation: existing
                        });
                        op.onsuccess = resolve
                        op.onerror = reject
                    }))
                    console.assert(++total === lexicon)
                    console.info("pronunciation db downloaded")
                };
                return pump();
            })
            .then(storing)
            .then(() => Promise.allSettled(commits))
            .then((() => {
                console.info("pronunciation db populated")
                const tx = db.transaction("status", 'readwrite');
                const store = tx.objectStore("status");
                store.put({ id: "loaded", value: true });
                this.loaded = new Promise((resolve, reject) => resolve(true))
                this.status(true)
            }).bind(this))
    }

    localLookup(query) {
        const tx = this.#db.transaction("pronunciations", 'readonly');
        const store = tx.objectStore("pronunciations");
        const request = store.get(query.toUpperCase())
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

    async seq(query) {
        return (await this.lookup(query.split(" "))).map(x => x[0])
    }
}

const dict = new Cursor()

function cumsum(arr) {
    let total = 0
    return arr.map(x => total += x)
}

// https://ismir2009.ismir.net/proceedings/OS8-1.pdf
class Similarities {
    constructor() {
        this.load = fetch("OS8-1.json").then(res => res.json()).then((res => {
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

    order(type, indices0, indices1, lu=true) {
        indices0 = indices0 === undefined ?
            [...Array(this[type].length).keys()] : indices0
        indices1 = indices1 === undefined ? indices0 : indices1
        return indices0.map(i => (lu ? indices1.filter(j => j <= i) : indices1)
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
        return val
    }

    max(dp) {
        return this.match(
            dp, [...Array(dp.length).keys()], [...Array(dp[0].length).keys()])
    }

    spaced(codas0, codas1, rev=false) {
        const dir = rev ? x => x.reverse() : x => x
        const dp = this.paths(dir(codas0.flat()), dir(codas1.flat()), rev)
        return [this.match(dp), this.match(
            dp,
            cumsum(dir(codas0.map(x => x.length))),
            cumsum(dir(codas1.map(x => x.length))))]
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

/*
compare("battery", "battle me")
compare("orange", "door hinge")
*/

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
        this.arr[0] = this.arr.pop()
        for (let i = 0, max = 0;; i = max) {
            const l = 2 * i + 1, r = 2 * i + 2
            if (l < this.arr.length && this.arr[l] > this.arr[max]) max = l
            if (r < this.arr.length && this.arr[r] > this.arr[max]) max = r
            if (max === i) return res
            else this.swap(i, max)
        }
    }

    [Symbol.iterator]() {
        return {
            next: () => ({ done: this.arr.length === 0, value: this.pop() })
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

class Ngram extends MaxHeapKV {
    constructor(sim) {
        super()
        this.sim = sim
        this.bag = []
    }

    _push(consonants) { // ordered indices
        const idx = this.bag.length
        consonants = consonants.map(x => this.sim.eigenvectors.consonants[x])
            .reduce((x, y) => x.map((z, i) => z + y[i]))
        for (let i = 0; i < this.bag.length; i++) {
            const dist = consonants.map((x, j) =>
                x * this.bag[i][j] * this.sim.eigenvalues.consonants[j])
                    .reduce((a, b) => a + b)
            super.push(dist, [i, idx])
        }
        this.bag.push(consonants)
        return idx
    }

    push(...consonants) {
        return consonants.map(x => this._push(x))
    }
}

class Suffixes {
    constructor(sim) {
        this.sim = sim
        this.children = [...Array(sim.vowels.length)]
        this.prefixes = []
        this.refs = []
        this.postfix = null
        this.cache = null
        this.root = this
        this.depth = 0
    }

    init(parent) {
        this.aligned = parent.aligned
        this.root = parent.root
        this.depth = parent.depth + 1
        return this
    }

    get parentless() {
        return this.root === this
    }

    debug(info) {
        this.comments = info
        return this
    }

    step(i) {
        return this.sim.group[this.aligned[i]][1]
    }

    get(i) {
        const vowel = this.step(i)
        if (this.children[vowel] === undefined) {
            this.children[vowel] = new Suffixes(this.sim)
                .init(this).debug(this.aligned[i])
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
        const ending = i >= this.aligned.length - 3
        if (ending) {
            this.postfix = this.aligned.length - 1
            if (!leaf) return
        }
        if (!leaf || this.refs.length > 1 && (ending || !(boundary &&
                this.cache && JSON.stringify(word) == this.cache))) {
            this.cache = null
            const it = leaf ? this.prefixes.slice(0, ending ? -1 : undefined)
                .map((x, j) => [j, x]) : [[this.refs.length - 1, i]]
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

    get childless() {
        return this.occupied.length === 0
    }

    flat() {
        return this.childless ? this.prefixes : this.occupied
            .map(x => this.children[x].flat()).flat()
            .concat(this.postfix === null ? [] : [this.postfix]).map(x => x - 2)
    }

    repr() {
        let pre = ""
        if (!this.parentless) {
            pre = this.childless ? "\u2500" : "\u252C"
            pre += this.comments + " "
            pre += this.flat().map(x => this.aligned[x].map(x =>
                x.join("-")).join("_") + (x === this.aligned.length - 3 ? ";" +
                this.aligned.slice(-1)[0][0].join("-") : "")).join(" ")
        }
        const children = this.occupied.map(x => this.children[x].repr())
        return pre + (children.length > 1 ? "\n" : "") + children.slice(0, -1)
            .map(x => "\u251C" + x.replace(/\n/g, "\n\u2502")).join("\n") +
            (children.length ? "\n\u2514" + children
                .slice(-1)[0].replace(/\n/g, "\n ") : "")
    }

    consonants() {
        return this.prefixes.map(x =>
            this.aligned[x].flat().map(x => this.sim.group[x][1]))
    }
}

async function lcs(seq) {
    const bar = await dict.seq(seq)
    await phonemes.load
    return new Suffixes(phonemes).build(bar)
}

/*
fetch("").then(res => res.text()).then(res => {
    res = res.match(/<textarea[^>]*>\s*(.*)<\/textarea>/s)[1]
    res = res.replace(/\s\S+{[\/\*]+}/g, "").replace(/{[0-9]+}/g, "")
    return res.replace(/[-_]/g, " ").replace(/[,\?]/g, "").replace(/\n/g, " ")
}).then(lcs).then(tree => {
    console.log(tree.repr())
})
*/

lcs("New York City gritty committee pity the fool").then(tree => {
    console.log(tree.repr())
    let bag = new Ngram(phonemes)
    bag.push(...tree.children[9].consonants())
    console.log(bag.pop())
    console.log(bag)
})

class Edit {
    constructor(iter0, iter1, n = undefined, m = undefined) {
        this.iter0 = iter0
        this.iter1 = iter1
        this.n = n === undefined ? iter0.length : n
        this.m = m === undefined ? iter1.length : m
        this.dp = [...Array(this.n + 1)].map(x => {
            return [...Array(this.m + 1)].map(y => null)
        })
    }

    get repr() {
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
            return x.reduce((a, b) =>
                [...new Array(Math.max(a.length, b.length)).keys()].map(j =>
                    a[j] === b[j] ? a[j] : "\\").join(""))
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
    constructor(cursor, wrapper, load = true) {
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
                for (let i = 0, j = 0; i <= breaks; [i++, el = el?.nextSibling]) {
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
            this.background.setAttribute("data-meter", this.editor.meter.map(
                    (x, i) => {
                const whitespace = limits[i] - x.length
                const lo = Math.trunc(whitespace / (x.length + 1))
                const wide = whitespace % (x.length + 1)
                const res = x.split('').map((y, j) => {
                    return y + this.fill.repeat(lo + (j < wide))
                }).join('')
                const word = this.fill.repeat(lo) + res
                // "w" breaks this
                // console.assert(x.length <= limits[i])
                const cutoff = word.slice(0, limits[i])
                return cutoff.padStart(limits[i]) + sep[i]
            }).join(""))
            this.resize()
        })
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

    caretMove(el, f) {
        // https://stackoverflow.com/a/53999418
        let prev = -1;
        const check = (e => {
            check12(e)
            window.setTimeout(() => check12(e), 0)
        })
        const check12 = (e => {
            const next = el.selectionEnd;
            if (next !== prev) {
                f(e, next, prev)
                prev = next
            }
        }).bind(this)
        el.addEventListener('blur', () => { prev = -1 });
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
})
