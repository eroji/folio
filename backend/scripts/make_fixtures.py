"""Generate the seven fixture books into backend/tests/fixtures/ (gitignored).

Run from backend/: ``python -m scripts.make_fixtures`` (``make fixtures``).
All content is original filler text written here — no network access.
"""

from __future__ import annotations

import shutil
import struct
import subprocess
import zipfile
from pathlib import Path

import pymupdf
from ebooklib import epub

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures"

ENCRYPTION_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"
            xmlns:enc="http://www.w3.org/2001/04/xmlenc#"
            xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.idpf.org/2017/enc/epub"/>
  </enc:EncryptedData>
</encryption>
"""

_SENTENCES = [
    "The harbour light swept twice across the water before the fog closed again.",
    "She counted the crates on the manifest and found one more than the ledger allowed.",
    "Rain moved along the rooftops like a crowd that had somewhere better to be.",
    "Bread rose in the warm corner of the kitchen while the argument cooled by the door.",
    "Every map of the valley was wrong in the same direction, which told him something.",
    "The ferryman kept his own hour, an hour measured in loads and not in minutes.",
    "Ink dried on the page and with it the last easy version of the story.",
    "They left the lamp burning on the sill for whoever came after them.",
    "A field is only a promise that the fence will hold.",
    "The archive smelled of paper and rain and of decisions nobody had undone.",
    "He learned the names of the buoys the way other children learned hymns.",
    "Nothing moved in the street except the shadow of the wheel turning above it.",
]


def _paragraph(seed: int, sentences: int = 7) -> str:
    import random

    rng = random.Random(seed)
    return " ".join(rng.choice(_SENTENCES) for _ in range(sentences))


def _chapters(prefix: str, count: int, seed: int) -> list[tuple[str, str]]:
    return [
        (
            f"{prefix} {i}",
            "".join(f"<p>{_paragraph(seed * 100 + i * 10 + p)}</p>" for p in range(4)),
        )
        for i in range(1, count + 1)
    ]


def _page_text(page_no: int, header: str | None) -> str:
    lines = [f"Page {page_no}", ""]
    for p in range(6):
        lines.append(_paragraph(page_no * 10 + p))
        lines.append("")
    if header:
        lines.insert(1, header)
    return "\n".join(lines)


def _build_epub(
    path: Path, *, epub3: bool, title: str, author: str, chapters: list[tuple[str, str]]
) -> None:
    book = epub.EpubBook()
    book.set_identifier(f"folio-fixture-{path.stem}")
    book.set_title(title)
    book.set_language("en")
    book.add_author(author)
    book.add_metadata("DC", "publisher", "Folio Press")
    book.add_metadata("DC", "date", "1911")
    book.add_metadata("DC", "description", f"Fixture book: {title}.")
    items = []
    for i, (name, body) in enumerate(chapters, start=1):
        item = epub.EpubHtml(title=name, file_name=f"c{i}.xhtml", lang="en")
        item.content = f"<html><body><h1>{name}</h1>{body}</body></html>"
        book.add_item(item)
        items.append(item)
    book.toc = items
    if epub3:
        book.add_item(epub.EpubNav())
        book.spine = ["nav", *items]
        epub.write_epub(path, book)
    else:
        book.add_item(epub.EpubNcx())
        book.spine = ["ncx", *items]
        epub.write_epub(path, book)
        # ebooklib 0.20 always stamps OPF version="3.0"; downgrade for a real EPUB 2.
        _rewrite_zip(path, opf_replace={b'version="3.0"': b'version="2.0"'})


def _rewrite_zip(
    path: Path,
    *,
    opf_replace: dict[bytes, bytes] | None = None,
    add: dict[str, bytes] | None = None,
) -> None:
    """Rewrite a zip preserving mimetype-first + stored, applying byte edits / new entries."""
    with zipfile.ZipFile(path) as src:
        entries = [(info.filename, src.read(info.filename)) for info in src.infolist()]
    with zipfile.ZipFile(path, "w") as dst:
        for name, data in entries:
            opf = name.endswith(".opf") and opf_replace
            for old, new in (opf_replace or {}).items() if opf else ():
                data = data.replace(old, new)
            compress = zipfile.ZIP_STORED if name == "mimetype" else zipfile.ZIP_DEFLATED
            dst.writestr(name, data, compress)
        for name, data in (add or {}).items():
            dst.writestr(name, data, zipfile.ZIP_DEFLATED)


def _build_pdf(
    path: Path, *, pages: int, toc: list[list[object]] | None, header: str | None = None
) -> None:
    doc = pymupdf.open()
    for n in range(1, pages + 1):
        page = doc.new_page()
        page.insert_textbox(pymupdf.Rect(72, 72, 540, 720), _page_text(n, header), fontsize=10)
        if header:
            page.draw_line((72, 52), (540, 52))
    if toc:
        doc.set_toc(toc)
    doc.save(path)
    doc.close()


def _mobi_stub(path: Path) -> None:
    """PalmDB/MOBI skeleton: valid BOOKMOBI magic at offset 60, no readable text.

    ponytail: detection-only stub. Real AZW3 needs Calibre's ebook-convert;
    extraction tests skip when Calibre is absent (docs/DECISIONS.md).
    """
    rec0 = struct.pack(">HHIIHHII", 1, 0, 0, 1, 32, 0, 0, 0)  # PalmDOC header
    rec0 += b"MOBI" + struct.pack(">IIIIII", 232, 2, 65001, 0xF0110, 4, 0)
    rec0 += b"\x00" * (256 - len(rec0))
    # 78-byte PalmDB header: name(32) + fields, type+creator give "BOOKMOBI" at offset 60.
    out = bytearray(b"folio stub".ljust(32, b"\x00"))
    out += struct.pack(">HHIIIIII4s4sIIH", 0, 0, 0, 0, 0, 0, 0, 0, b"BOOK", b"MOBI", 0, 0, 1)
    out += struct.pack(">IHH", 80, 0, 0) + b"\x00\x00"  # record info list + trailing gap
    out += b"\x00" * (80 - len(out))
    out += rec0
    path.write_bytes(bytes(out))


def main() -> None:
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)

    _build_epub(
        FIXTURES_DIR / "epub3.epub",
        epub3=True,
        title="The Lighthouse at Low Tide",
        author="E. R. Tolliver",
        chapters=_chapters("Chapter", 6, 1),
    )
    _build_epub(
        FIXTURES_DIR / "epub2.epub",
        epub3=False,
        title="Notes on the Making of Bread",
        author="H. W. Peck",
        chapters=_chapters("Section", 4, 2),
    )
    _build_pdf(
        FIXTURES_DIR / "pdf_outline.pdf",
        pages=24,
        toc=[[1, f"Part {i}", (i - 1) * 6 + 1] for i in range(1, 5)],
    )
    _build_pdf(
        FIXTURES_DIR / "pdf_flat.pdf", pages=26, toc=None, header="Folio Press — Sample Text"
    )
    # scanned_pdf: rasterize a text PDF so pages hold images only.
    text_doc = pymupdf.open()
    for n in range(1, 9):
        page = text_doc.new_page()
        page.insert_textbox(pymupdf.Rect(72, 72, 540, 720), _page_text(n, None), fontsize=10)
    scanned = pymupdf.open()
    for page in text_doc:
        target = scanned.new_page(width=page.rect.width, height=page.rect.height)
        target.insert_image(
            target.rect, stream=page.get_pixmap(dpi=150).tobytes("jpg", jpg_quality=60)
        )
    scanned.save(FIXTURES_DIR / "scanned_pdf.pdf")
    scanned.close()
    text_doc.close()

    _build_epub(
        FIXTURES_DIR / "drm_epub.epub",
        epub3=True,
        title="The Locked Stacks",
        author="Anonymous",
        chapters=_chapters("Chapter", 2, 3),
    )
    _rewrite_zip(FIXTURES_DIR / "drm_epub.epub", add={"META-INF/encryption.xml": ENCRYPTION_XML})

    azw3 = FIXTURES_DIR / "azw3.azw3"
    convert = shutil.which("ebook-convert")
    if convert:
        subprocess.run(
            [convert, str(FIXTURES_DIR / "epub3.epub"), str(azw3)], check=True, timeout=300
        )
    else:
        print(
            "note: Calibre (ebook-convert) not found — writing a detection-only MOBI stub for azw3"
        )
        _mobi_stub(azw3)

    for path in sorted(FIXTURES_DIR.glob("*")):
        if path.suffix in {".epub", ".pdf", ".azw3"}:
            print(f"{path.name:20s} {path.stat().st_size:>10,d} bytes")


if __name__ == "__main__":
    main()
