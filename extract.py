#!/usr/bin/env python3
"""raw/ 의 ZIP 을 raw_x/ 로 푼다. 파일명 인코딩(cp949) 복구, 경로 탈출 차단. ZIP 아닌 파일은 링크만 건다."""
import json, zipfile
from pathlib import Path

ROOT = Path(__file__).parent
RAW, OUT = ROOT / "raw", ROOT / "raw_x"


def fix_name(info):
    if info.flag_bits & 0x800:
        return info.filename
    try:
        return info.filename.encode("cp437").decode("cp949")
    except UnicodeError:
        return info.filename


for item in json.loads((RAW / "manifest.json").read_text(encoding="utf8")):
    src = RAW / item["file"]
    dest = OUT / Path(item["file"]).parent
    dest.mkdir(parents=True, exist_ok=True)
    if src.suffix.lower() != ".zip":
        (dest / src.name).write_bytes(src.read_bytes())
        continue
    with zipfile.ZipFile(src) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            name = Path(fix_name(info)).name  # 폴더 구조 버림: 경로 탈출 차단 겸 평탄화
            (dest / name).write_bytes(z.read(info))
