"""Phase 2 verification helper: download a small SD1.5 GGUF model into models/.

Used only to satisfy the PLAN.md §15 Phase 2 live acceptance test ("generate a
cat with SD1.5"). Not part of the shipped app (the real HF downloader is Phase 3).
Run: python tests/_download_sd15.py
"""

import os
import shutil
from pathlib import Path

from huggingface_hub import hf_hub_download

REPO = "second-state/stable-diffusion-v1-5-GGUF"
FILENAME = "stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf"
DEST_NAME = "sd-v1-5-pruned-Q4_0.gguf"


def main() -> None:
    models_dir = (Path(__file__).resolve().parents[1] / "models").resolve()
    models_dir.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {FILENAME} from {REPO} into {models_dir} ...")
    downloaded = hf_hub_download(REPO, FILENAME, local_dir=str(models_dir))
    src = Path(downloaded)
    dst = models_dir / DEST_NAME
    if src.resolve() != dst.resolve():
        if dst.exists():
            dst.unlink()
        src.rename(dst)
    # hf_hub_download may leave a .cache dir; clean it.
    cache = models_dir / ".cache"
    if cache.exists():
        shutil.rmtree(cache, ignore_errors=True)
    size_mb = os.path.getsize(dst) / 1048576
    print(f"DONE {dst} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
