"""Cover storage: validate by magic bytes, store the original, render 600/200 WebP.

Paths are built only from book UUIDs (``folio.storage.cover_dir``); no
user-supplied string ever reaches the filesystem. The returned sha256 hex is
what ``books.cover_key`` stores; it doubles as the ETag and ``?v=`` buster.
"""

import hashlib
import io
import shutil
from pathlib import Path
from typing import Literal
from uuid import UUID

import httpx
from PIL import Image, UnidentifiedImageError

from folio.config import Settings
from folio.errors import ApiError
from folio.storage import cover_dir, ensure_dirs

MAX_COVER_BYTES = 10 * 1024 * 1024
DOWNLOAD_TIMEOUT_S = 10.0
MAX_REDIRECTS = 5
WEBP_QUALITY = 82
_SIZES = (600, 200)


def detect_image_type(data: bytes) -> str | None:
    """``jpeg | png | webp`` from magic bytes only, else None."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def _invalid(message: str) -> ApiError:
    return ApiError("cover_invalid", message, 422)


def _crop_to_2_3(image: Image.Image) -> Image.Image:
    """Centre-crop to the 2:3 aspect the spec pins (same rule as the PDF cover)."""
    width, height = image.size
    if width * 3 > height * 2:  # too wide
        crop = round(height * 2 / 3)
        left = (width - crop) // 2
        return image.crop((left, 0, left + crop, height))
    if width * 3 < height * 2:  # too tall
        crop = round(width * 3 / 2)
        top = (height - crop) // 2
        return image.crop((0, top, width, top + crop))
    return image


def store_cover(settings: Settings, book_id: UUID, data: bytes) -> str:
    """Validate, write ``covers/<id>/original.<ext>`` + WebP variants; return sha256 hex.

    Raises ``ApiError("cover_invalid", ...)`` and leaves any existing cover
    files untouched; nothing is written until the bytes decode cleanly.
    """
    if len(data) > MAX_COVER_BYTES:
        raise _invalid(f"The cover image is larger than the {MAX_COVER_BYTES // 1048576} MB limit.")
    image_type = detect_image_type(data)
    if image_type is None:
        raise _invalid("The cover must be a JPEG, PNG or WebP image.")
    try:
        with Image.open(io.BytesIO(data)) as source:
            rgb = source.convert("RGB")
            cropped = _crop_to_2_3(rgb)
            variants = {
                width: _render(cropped, width) for width in _SIZES
            }  # render before touching the store
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise _invalid("The cover image could not be decoded.") from exc
    key = hashlib.sha256(data).hexdigest()
    directory = ensure_dirs(cover_dir(settings, book_id))
    original = directory / f"original.{image_type}"
    original.write_bytes(data)
    for width, variant in variants.items():
        variant.save(directory / f"cover-{width}.webp", "WEBP", quality=WEBP_QUALITY)
    for stale in directory.glob("original.*"):
        if stale != original:
            stale.unlink()
    return key


def _render(cropped: Image.Image, width: int) -> Image.Image:
    return cropped.resize((width, width * 3 // 2), Image.Resampling.LANCZOS)


def cover_path(settings: Settings, book_id: UUID, size: Literal[200, 600] | None) -> Path | None:
    """The sized WebP, or the original when ``size`` is None; None if absent."""
    directory = cover_dir(settings, book_id)
    if size is not None:
        path = directory / f"cover-{size}.webp"
        return path if path.is_file() else None
    originals = sorted(directory.glob("original.*"))
    return originals[0] if originals and originals[0].is_file() else None


def delete_covers(settings: Settings, book_id: UUID) -> None:
    shutil.rmtree(cover_dir(settings, book_id), ignore_errors=True)


def download_cover(url: str, client: httpx.Client) -> bytes:
    """Fetch a cover URL: 10 s timeout, streamed 10 MB cap, magic-byte check.

    Only http(s) URLs are fetched and redirects are capped by the caller's
    client — the residual SSRF risk (internal hosts are reachable on a
    homelab network) is recorded in docs/DECISIONS.md.
    """
    try:
        scheme = httpx.URL(url).scheme
    except ValueError as exc:
        raise _invalid("The cover URL is not valid.") from exc
    if scheme not in ("http", "https"):
        raise _invalid("The cover URL must be an http(s) URL.")
    try:
        with client.stream("GET", url) as response:
            if response.status_code >= 400:
                raise _invalid(f"The cover URL returned HTTP {response.status_code}.")
            data = bytearray()
            for chunk in response.iter_raw():
                data += chunk
                if len(data) > MAX_COVER_BYTES:
                    raise _invalid(
                        f"The cover image is larger than the {MAX_COVER_BYTES // 1048576} MB limit."
                    )
    except httpx.TimeoutException:
        raise _invalid(f"The cover URL did not respond within {DOWNLOAD_TIMEOUT_S:.0f} seconds.")
    except httpx.TooManyRedirects:
        raise _invalid("The cover URL redirected too many times.")
    except httpx.HTTPError:
        raise _invalid("The cover URL could not be fetched.")
    if detect_image_type(bytes(data)) is None:
        raise _invalid("The cover URL did not return a JPEG, PNG or WebP image.")
    return bytes(data)
