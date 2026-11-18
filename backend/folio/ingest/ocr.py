"""Read a scanned PDF with the language model (OCR).

Pages that already carry a text layer keep it; every other page is rendered
to a JPEG and transcribed by the reading model, a few pages at a time. Each
page's text is cached next to the book (per reading model), so a retry or
reprocess after a failure resumes instead of reading the whole book again.
Chapters come from the PDF outline, else fixed page chunks, like text PDFs.
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from io import BytesIO
from pathlib import Path

import pymupdf  # type: ignore[import-untyped]
from PIL import Image

from folio.ingest import ExtractedBook
from folio.ingest.pdf import _chapters, _cover, _drop_repeated_lines, _metadata
from folio.integrations import LanguageModel
from folio.llm import LlmError, read_page

logger = logging.getLogger(__name__)

OCR_DPI = 150
MAX_EDGE_PX = 2000  # vision models downscale anyway; keeps requests small
OCR_WORKERS = 4
TEXT_PAGE_MIN_CHARS = 200  # a page with this much text layer is not re-read
ATTEMPTS = 2

Progress = Callable[[int, int], None]


def page_jpeg(page: pymupdf.Page) -> bytes:
    """Render one page as a JPEG for the reading model."""
    pix = page.get_pixmap(dpi=OCR_DPI)
    image = Image.frombytes("RGB" if pix.n < 4 else "RGBA", (pix.width, pix.height), pix.samples)
    image = image.convert("RGB")
    image.thumbnail((MAX_EDGE_PX, MAX_EDGE_PX))
    out = BytesIO()
    image.save(out, format="JPEG", quality=85)
    return out.getvalue()


def first_page_jpeg(pdf: bytes) -> bytes:
    """The first page of an uploaded PDF (the admin OCR test)."""
    with pymupdf.open(stream=pdf, filetype="pdf") as doc:
        if doc.page_count == 0:
            raise LlmError("The PDF has no pages.")
        return page_jpeg(doc[0])


def _cache_dir(root: Path, cfg: LanguageModel) -> Path:
    model = hashlib.sha256(f"{cfg.base_url}|{cfg.reader}".encode()).hexdigest()[:16]
    return root / "ocr" / model


def _read(cfg: LanguageModel, image: bytes, language: str | None, number: int) -> str:
    error: LlmError | None = None
    for _ in range(ATTEMPTS):
        try:
            return read_page(cfg, image, "image/jpeg", language).text
        except LlmError as exc:
            error = exc
    raise LlmError(f"Reading page {number} failed: {error}")


def ocr_pdf(
    path: Path,
    cfg: LanguageModel,
    cache_root: Path,
    language: str | None = None,
    on_progress: Progress | None = None,
) -> ExtractedBook:
    cache = _cache_dir(cache_root, cfg)
    cache.mkdir(parents=True, exist_ok=True)
    with pymupdf.open(path) as doc:
        texts = [page.get_text() for page in doc]
        todo = [i for i, text in enumerate(texts) if len(text.strip()) < TEXT_PAGE_MIN_CHARS]
        for i in list(todo):
            cached = cache / f"{i:05d}.txt"
            if cached.is_file():
                texts[i] = cached.read_text(encoding="utf-8")
                todo.remove(i)
        total = len(texts)
        done = total - len(todo)
        if on_progress:
            on_progress(done, total)
        logger.info("OCR: %d of %d pages to read with %s", len(todo), total, cfg.reader)
        # The document is not thread-safe: pages render here, a few at a time,
        # and only the model calls run in the pool.
        with ThreadPoolExecutor(max_workers=OCR_WORKERS) as pool:
            pending: dict[Future[str], int] = {}
            queue = iter(todo)

            def submit_next() -> None:
                index = next(queue, None)
                if index is not None:
                    image = page_jpeg(doc[index])
                    pending[pool.submit(_read, cfg, image, language, index + 1)] = index

            for _ in range(OCR_WORKERS * 2):
                submit_next()
            failed: LlmError | None = None
            while pending:
                future = next(iter(_first_done(pending)))
                index = pending.pop(future)
                try:
                    text = future.result()
                except LlmError as exc:
                    # Stop asking for more, but keep what is still in flight:
                    # the retry then reads only what is missing.
                    failed = failed or exc
                    continue
                (cache / f"{index:05d}.txt").write_text(text, encoding="utf-8")
                texts[index] = text
                done += 1
                if on_progress:
                    on_progress(done, total)
                if failed is None:
                    submit_next()
            if failed is not None:
                raise failed
        page_lines = [
            [line.strip() for line in text.splitlines() if line.strip()] for text in texts
        ]
        if not any(page_lines):
            raise LlmError("The language model found no text in this PDF.")
        page_lines = _drop_repeated_lines(page_lines)
        return ExtractedBook(
            chapters=_chapters(doc, page_lines),
            metadata=_metadata(doc),
            cover=_cover(doc),
        )


def _first_done(pending: dict[Future[str], int]) -> set[Future[str]]:
    finished, _ = wait(pending, return_when=FIRST_COMPLETED)
    return finished
