"""A minimal DevTools (CDP) client for Steam's local developer port (127.0.0.1:8080), stdlib only.
For working on the theme: read a Steam page's state, try CSS in it, take a screenshot.

    python cdp.py TITLE "js expression"        evaluate (promises awaited), print the value as JSON
    python cdp.py TITLE @file.js               the same with a file's text
    python cdp.py TITLE --shot out.png         Page.captureScreenshot (only while the page is on screen)

TITLE matches a page's title exactly, or else as a substring; "@web" is the store/community page
Steam is showing. Hidden pages throttle their timers: don't await setTimeout loops in them.
"""
import base64
import json
import os
import socket
import struct
import sys
import urllib.request


def targets():
    return json.load(urllib.request.urlopen("http://127.0.0.1:8080/json", timeout=5))


def find(title):
    pages = [t for t in targets() if t.get("type") == "page"]
    if title == "@web":
        pages = [t for t in pages if t["url"].startswith("http") and "steamloopback" not in t["url"]]
        if pages:
            return pages[0]
        raise SystemExit("no web page open in Steam")
    for t in pages:
        if t["title"] == title:
            return t
    for t in pages:
        if title in t["title"]:
            return t
    raise SystemExit(f"no page titled {title!r}")


class WS:
    def __init__(self, url, timeout=30):
        host_port, path = url[len("ws://"):].split("/", 1)
        host, port = host_port.split(":")
        self.s = socket.create_connection((host, int(port)), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f"GET /{path} HTTP/1.1\r\nHost: {host_port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            resp += self.s.recv(4096)
        self.buf = resp.split(b"\r\n\r\n", 1)[1]
        self.n = 0

    def send(self, obj):
        data = json.dumps(obj).encode()
        mask = os.urandom(4)
        hdr = bytearray([0x81])
        if len(data) < 126:
            hdr.append(0x80 | len(data))
        elif len(data) < 65536:
            hdr.append(0x80 | 126)
            hdr += struct.pack(">H", len(data))
        else:
            hdr.append(0x80 | 127)
            hdr += struct.pack(">Q", len(data))
        keys = (mask * (len(data) // 4 + 1))[:len(data)]
        self.s.sendall(bytes(hdr) + mask + (int.from_bytes(data, "little") ^ int.from_bytes(keys, "little")).to_bytes(len(data), "little"))

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(1 << 20)
            if not chunk:
                raise EOFError
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        msg = b""
        while True:
            b0, b1 = self._read(2)
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            if b1 & 0x80:
                self._read(4)
            payload, op = self._read(n), b0 & 0x0F
            if op == 8:
                raise EOFError
            if op in (0, 1, 2):
                msg += payload
                if b0 & 0x80:
                    return json.loads(msg)

    def call(self, method, **params):
        self.n += 1
        self.send({"id": self.n, "method": method, "params": params})
        while True:
            m = self.recv()
            if m.get("id") == self.n:
                return m


def evaluate(title, expr, timeout=60):
    ws = WS(find(title)["webSocketDebuggerUrl"], timeout)
    r = ws.call("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True)
    res = r.get("result", {})
    if "exceptionDetails" in res:
        return {"error": res["exceptionDetails"].get("exception", {}).get("description") or res["exceptionDetails"].get("text")}
    return res.get("result", {}).get("value")


def shot(title, out, timeout=15):
    ws = WS(find(title)["webSocketDebuggerUrl"], timeout)
    r = ws.call("Page.captureScreenshot", format="png")
    with open(out, "wb") as f:
        f.write(base64.b64decode(r["result"]["data"]))
    return out


if __name__ == "__main__":
    title, arg = sys.argv[1], sys.argv[2]
    if arg == "--shot":
        print(shot(title, sys.argv[3]))
    else:
        expr = open(arg[1:], encoding="utf-8").read() if arg.startswith("@") else arg
        value = evaluate(title, expr)
        print(value if isinstance(value, str) else json.dumps(value, indent=1)[:60000])
