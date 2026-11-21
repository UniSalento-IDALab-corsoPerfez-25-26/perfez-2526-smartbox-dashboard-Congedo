"""Serve la dashboard e la demo su http://localhost:8000 senza cache, per provare la demo mentre si modifica il codice.

Uso:  python tools/serve_demo.py   poi aprire http://localhost:8000/demo.html
      python tools/serve_demo.py --port 8001   (porta diversa da quella della dashboard; la usa la procedura guidata)
Ascolta solo su 127.0.0.1: la pagina non è raggiungibile da altri dispositivi della rete.
"""
import functools
import sys
import http.server
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # cartella principale del repository


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    handler = functools.partial(NoCache, directory=ROOT)
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8000
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as srv:
        print(f"Demo su http://localhost:{port}/demo.html (Ctrl+C per fermare)")
        srv.serve_forever()
