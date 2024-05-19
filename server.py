import pathlib, sqlite3, aiohttp, json
from urllib.request import urlretrieve
from aiohttp import web

src = "https://github.com/Alexir/CMUdict/raw/master/cmudict-0.7b"

dir = pathlib.Path(__file__).resolve().parent
fname = src.rsplit("/", 1)[-1]

if not len(tuple(dir.glob("cmudict-*"))):
    urlretrieve(src, dir / fname)

db_file = dir / "words.db"
init = db_file.exists()
db = sqlite3.connect(str(db_file))
if not init:
    cur = db.cursor()
    cur.execute(
            "CREATE TABLE words("
                "word TEXT,"
                "version INT DEFAULT 0,"
                "pronunciation TEXT"
            ")")
    with open(dir / fname, errors="ignore") as fp:
        for line in fp:
            if line.startswith(";;;"):
                continue
            pre, post = line.strip().split(" ", 1)
            pre, version = pre[:-1].split("(") if pre.endswith(")") else \
                    (pre, 0)
            cur.execute(
                    "INSERT INTO words(word, version, pronunciation) "
                    "VALUES (?, ?, ?)", (pre, version, post.strip()))
    db.commit()
    cur.close()

def lookup(word):
    cur = db.cursor()
    cur.execute(
            "SELECT word, version, pronunciation FROM words WHERE word=?",
            (word.upper(),))
    res = cur.fetchall()
    cur.close()
    return res

routes = web.RouteTableDef()

@routes.get("/ws")
async def websocket_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    async for msg in ws:
        if msg.type == aiohttp.WSMsgType.TEXT:
            multi = msg.data.startswith("[")#]
            req = json.loads(msg.data) if multi else [msg.data]
            res = [lookup(i) for i in req][slice(None) if multi else 0]
            await ws.send_str(json.dumps(res))

    return ws

static_files = {
    "/": "index.html",
    "/cmudict-0.7b": "cmudict-0.7b",
    "/OS8-1.json": "OS8-1.json"
}

for i, (route, path) in enumerate(static_files.items()):
    def closure(path):
        async def handler(request):
            return web.FileResponse(dir / path)
        handler.__name__ += str(i)
        handler.__qualname__ += str(i)
        return handler
    routes.get(route)(closure(path))

app = web.Application()
app.add_routes(routes)

if __name__ == "__main__":
    web.run_app(app)

