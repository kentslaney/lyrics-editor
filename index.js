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
                    for (let next of text.split("\n")) {
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
                    console.assert(++total === lexicon) // TODO
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
}

const dict = new Cursor()

// https://ismir2009.ismir.net/proceedings/OS8-1.pdf
// https://roa.rutgers.edu/files/377-0200/377-0200-YIP-0-0.PDF
class Similarities {
    constructor() {
        fetch("/OS8-1.json").then(res => res.json()).then((res => {
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
        }).bind(this))
    }

    lookup(term0, term1) {
        const [type0, index0] = this.group[term0]
        if (term1 === undefined) {
            const res = this[type0].slice(0, index0).map(x => x[index0]).concat(
                this[type0][index0])
            return Object.fromEntries(
                this.axes[type0].map((a, b) => [a, res[b]]))
        } else {
            const [type1, index1] = this.group[term1]
            if (type0 === null || type0 !== type1) return null
            const [lo, hi] = [index0, index1].toSorted((a, b) => a - b)
            return this[type0][lo][hi - lo]
        }
    }
}

class Edit {
    constructor(iter0, iter1, n = undefined, m = undefined) {
        this.iter0 = iter0
        this.iter1 = iter1
        this.n = n === undefined ? iter0.length : n
        this.m = m === undefined ? iter1.length : m
        this.dp = [...Array(this.n + 1).keys()].map(x => {
            return [...Array(this.m + 1).keys()].map(y => null)
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
    pronunciations = []
    constructor(cursor) {
        this.cursor = cursor
    }

    strip = /[^a-zA-Z']/g
    split = /[\s\-_]/g
    version = /\(([0-9]+)\)[^a-zA-Z']*$/
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
        for (let i of removing) {
            this.pronunciations.splice(i, 1)
        }
        res.forEach((i, j) => {
            let [next, rewrite] = idx[j]
            this.pronunciations.splice(next, rewrite ? 1 : 0, i)
        })
        console.assert(this.pronunciations.length === words.length)
    }

    get separators() {
        const res = this.value.match(this.split)
        return res === null ? [] : res
    }

    get raw() {
        return this.value.split(this.split)
    }
}

function debounce(ms, f) {
    request_controller = null
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
        this.fgCase = this.wrapper.getElementsByClassName("foreground-case")[0]
        this.background = this.wrapper.getElementsByClassName("background")[0]
        this.fold = this.wrapper.getElementsByClassName("fold")[0]
        this.container = this.wrapper.insertBefore(
            document.createElement("div"), this.fgCase)
        this.container.classList.add("container")
        this.reference = this.container.appendChild(
            document.createElement("div"))
        this.reference.classList.add("reference")
        this.foreground.addEventListener("input", this.update.bind(this))
        this.foreground.addEventListener("input", this.save.bind(this))
        this.reflow = debounce(this.resize_debounce_ms, this.unfold.bind(this))
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
        this.reference.innerText = "\u200B" + this.foreground.value
    }

    resize(e) {
        if (this.wrapper.classList.contains("selecting")) return
        const res = Math.max(
            this.background.getBoundingClientRect().height,
            this.reference.getBoundingClientRect().height)
        this.wrapper.style.setProperty("--input-height", res + "px")
        if (this.wrapper.classList.contains("split")) this.reflow()
    }

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
            this.background.setAttribute("data-meter", this.parser(limits)
                .map((x, i) => {
                    // "w" breaks this
                    // console.assert(x.length <= limits[i])
                    return x.padStart(limits[i]) + sep[i]
                }).join(""))
            this.resize()
        })
    }

    fill = "\xa0"
    parser(limits) {
        const options = this.editor.pronunciations.map(x => x?.map(y =>
            y.replace(/[^012]/g, "").replace(/[12]/g, "/").replace(/0/g, "X")))
        return options.map((x, i) => {
            const raw = this.editor.raw[i]
            const curly = raw.match(this.editor.manual)
            if (curly) return curly[1].replace(/\*/g, "X")
            if (!x) return raw ? "?" : ""
            const round = raw.match(this.editor.version)
            if (round) {
                const version = parseInt(round[1])
                return version < x.length ? x[version] : "?"
            }
            return x.reduce((a, b) => {
                return a.split('').map((y, j) => y === b[j] ? y : "\\").join('')
            })
        }).map((x, i) => {
            const whitespace = limits[i] - x.length
            const lo = Math.trunc(whitespace / (x.length + 1))
            const wide = whitespace % (x.length + 1)
            const res = x.split('').map((y, j) => {
                return y + this.fill.repeat(lo + (j < wide))
            }).join('')
            return this.fill.repeat(lo) + res
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
                this.fgCase.scrollTop = 0;
                window.setTimeout(() => { this.fgCase.scrollTop = 0 }, 0)
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
        this.foreground.addEventListener("mousedown", this.join.bind(this))
        this.foreground.addEventListener("touchstart", this.join.bind(this))
        let selectionEndOOB = false
        this.reference.addEventListener("selectstart", e => {
            selectionEndOOB = true
            this.wrapper.classList.add("selecting")
            this.reference.style.setProperty("--fold-height",
                this.fold.getBoundingClientRect().height + "px")
        })
        window.addEventListener("mouseup", e => {
            if (selectionEndOOB || e.target === this.reference) this.forward(e)
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
        const wrap = end.slice(0, broken ? 0 :
            extra === -1 ? end.length : last.length + extra)
        const rewrite = div.appendChild(document.createTextNode(wrap))
        const bbox = div.getBoundingClientRect()

        const eol = div.appendChild(document.createElement("span"))
        eol.innerText = " "
        const char = eol.getBoundingClientRect()

        rewrite.textContent = end
        const size = parseInt(this.props.fontSize)

        let ref = eol.getBoundingClientRect(), wrapped
        while(ref.bottom !== char.bottom && rewrite.textContent !== "") {
            const clientX = ref.left - bbox.left - size / 2
            wrapped = Math.round(clientX / char.width)
            rewrite.textContent = rewrite.textContent.slice(0, -wrapped)
            ref = eol.getBoundingClientRect()
        }

        const clientX = ref.left - bbox.left - size / 2
        const above = Math.round(clientX / char.width)
        const headline = rewrite.textContent.length

        div.removeChild(eol)
        if (this.lineRef !== null)
            this.lineRef.parentElement?.removeChild(this.lineRef)
        this.lineRef = div

        const long = end.length - wrapped > last.length
        const br = long ? el : el?.nextElementSibling;
        let ele = el.nodeType === 1 ? br?.nextSibling : el
        if (long) {
            this.reference.insertBefore(this.container.removeChild(div), ele)
            const belowCase = document.createElement("div")
            belowCase.classList.add("below-fold")
            this.reference.insertBefore(belowCase, ele)
            const below = document.createElement("div")
            below.appendChild(this.reference.removeChild(ele))
            belowCase.appendChild(below)
            ele = belowCase
            belowCase.style.setProperty("--fold-hides", bbox.height + "px")
        }
        this.reference.insertBefore(document.createElement("div"),
            ele).classList.add("long-break")

        this.split(undefined, start + bbox.height)
        this.fgCase.scrollTop = 0

        const caret = offset === this.foreground.selectionStart
        this.expand(breaks, caret ? last.length : -1,
            ...(above === 0 ? [] : [headline - above, headline]))

        this.reference.style.setProperty("--fold-height",
            this.fold.getBoundingClientRect().height + "px")
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
            const center = bbox.left - container + bbox.width / 2
            const cur = cursor >= char && cursor <= char + raw[j].length
            const pad = center - pos
            const which = this.annotate(j, bbox.left, bbox.width, pad, cur)
            if (cur) active = [j, bbox.left, bbox.width, pad, which]
            pos = center
        }
        this.container.removeChild(el)
        // this.fold.appendChild(document.createElement("div"))
        //     .classList.add("close")
        if (active !== null) this.suggest(...active)
        else this.fold.style.removeProperty("--word-width")
    }

    suggest(idx, left, width, pad, which) {
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
        if (which === undefined) {
            f(this.editor.pronunciations[idx])
        } else if (which !== null) { }
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
        const note = this.note(idx)
        const options = this.editor.pronunciations[idx]
        if (note === undefined) {
            el.classList.add("unclear")
            el.style.setProperty("--versions", `'${options.length}'`)
        } else if (note !== null) {
            child.innerText = options[note]
        }
        return note
    }

    note(idx) {
        const options = this.editor.pronunciations[idx]
        if (options === undefined) return null
        const round = this.editor.raw[idx].match(this.editor.version)
        if (round) { // round brackets
            const version = parseInt(round[1])
            if (version >= options.length) return null
            return version
        }
        if (options.length === 1) return 0
        return undefined
    }

    hoistBelow() {
        let folded = this.wrapper.getElementsByClassName("below-fold")
        for (const el of folded) {
            const ele = el.firstElementChild
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
    }

    lineCount(el, offset) {
        if (el.parentElement?.parentElement?.classList.contains("below-fold"))
            el = el.parentElement.parentElement
        let sliding = 0
        if (el === this.reference) {
            el = this.reference.childNodes[offset]
            offset = 0
            const prev = el.previousSibling
            sliding = prev.nodeType === 1 && prev.tagName === "BR"
        }
        while ((el = el.previousSibling) !== null) {
            if (el.nodeType === 3) offset += el.textContent.length
            else if (el.nodeType === 1) {
                if (el.tagName === "BR") offset++
                else if (el.classList.contains("below-fold"))
                    offset += el.innerText.length - sliding
            }
        }
        return offset - 1
    }

    forward(e) {
        const sel = window.getSelection()
        if (sel.type === "none") return
        const range = sel.getRangeAt(0)
        let hi = range.startContainer
        const lo = range.endContainer
        let off = [range.startOffset, range.endOffset]
        if (this.lineRef?.parentElement === this.reference) {
            if (hi?.parentElement === this.lineRef) {
                hi = this.lineRef.previousSibling
                off[0] += hi === null ? 0 : hi.textContent.length + 1
            }
            this.lineRef.parentElement?.removeChild(this.lineRef)
        }
        const start = hi === null ? off[0] : this.lineCount(hi, off[0])
        const end = this.lineCount(lo, off[1])
        window.setTimeout(() => {
            this.foreground.focus()
            this.foreground.setSelectionRange(start, end)
        }, 0)
    }


    join(e) {
        if (e?.relatedTarget === this.reference) return
        this.wrapper.classList.remove("split")
        this.fgCase.scrollTop = 0
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
    document.getElementById("pronunciations").addEventListener("change", e => {
        if (e.target.checked) pre.classList.add("splittable")
        else pre.classList.remove("splittable")
    })
})
